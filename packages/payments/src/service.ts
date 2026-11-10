// PaymentService: the one entry point channels use (API now, WhatsApp in P08).
// It sequences commands and provider calls so that no provider call ever
// runs inside a database transaction:
//   initiate (tx) → collect() → record submission (tx)
//   webhook: verify → receive (tx: raw store + outbox) → worker → process (tx)
//   poll:    queryStatus() → apply (tx)
//   refund:  request/approve/execute (tx) → refund() → record (tx) → webhook completes
//   recon:   settlementReport() → run (tx)
import { SYSTEM_ACTOR, NotFoundError, type Actor, type Command, type CommandBus, type FlagService } from '@chema/core';
import { getBalances, type SubLedgerBalance } from '@chema/ledger';
import {
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  type ProviderAdapter,
} from '@chema/providers';
import { parseMinor, type Currency, type SqlClient } from '@chema/shared';
import {
  collectCommands,
  paymentPendingSource,
  viewReceipt,
  type InitiateInput,
  type PaymentDeps,
  type PollObservation,
  type ReceiptView,
  type SubmissionOutcome,
} from './collect';
import type { ContributionGate } from './gate';
import { eventCommands } from './events';
import type { RailRegistry } from './rails';
import { reconCommands, type ReconSummary } from './recon';
import { refundCommands, type RefundInput, type RefundResultView } from './refunds';
import type { PaymentView } from './types';

export interface PaymentServiceDeps {
  db: SqlClient;
  bus: CommandBus;
  flags: FlagService;
  rails: RailRegistry;
  gate: ContributionGate;
  clock?: () => Date;
}

export interface ReconExceptionView {
  id: string;
  kind: string;
  severity: string;
  rail: string;
  paymentId: string | null;
  walletId: string | null;
  providerRef: string | null;
  varianceMinor: string | null;
  currency: Currency | null;
  detail: string;
  holdId: string | null;
  ownerRole: string;
  openedAt: string;
  slaDueAt: string;
  resolvedAt: string | null;
}

export class PaymentService {
  readonly deps: PaymentDeps;
  readonly collect: ReturnType<typeof collectCommands>;
  readonly events: ReturnType<typeof eventCommands>;
  readonly refunds: ReturnType<typeof refundCommands>;
  readonly recon: ReturnType<typeof reconCommands>;
  private readonly db: SqlClient;
  private readonly bus: CommandBus;

  constructor(d: PaymentServiceDeps) {
    this.db = d.db;
    this.bus = d.bus;
    this.deps = { flags: d.flags, rails: d.rails, gate: d.gate, clock: d.clock ?? (() => new Date()) };
    this.collect = collectCommands(this.deps);
    this.events = eventCommands(this.deps);
    this.refunds = refundCommands(this.deps);
    this.recon = reconCommands(this.deps);
  }

  private system<I, O>(cmd: Command<I, O>, input: I): Promise<O> {
    return this.bus.execute(cmd, input, { actor: SYSTEM_ACTOR });
  }

  private adapter(rail: string): ProviderAdapter {
    const a = this.deps.rails.adapter(rail);
    if (!a) throw new NotFoundError('rail', rail);
    return a;
  }

  /** Rails a payer may choose right now. Disabled rails are simply absent. */
  listRails(): Promise<string[]> {
    return this.deps.rails.listCollectable(this.db);
  }

  async initiate(actor: Actor, input: InitiateInput): Promise<PaymentView & { replayed: boolean }> {
    const r = await this.bus.execute(this.collect.initiate, input, { actor });
    if (!r.needsSubmission) return { ...r.payment, replayed: r.replayed };
    // Same reference on every attempt: re-submitting is safe at the provider.
    let outcome: SubmissionOutcome;
    try {
      const res = await this.adapter(input.rail).collect({
        reference: r.payment.id,
        amount: r.payment.disclosure.totalCharged,
        ...(input.payerMsisdn ? { payerMsisdn: input.payerMsisdn } : {}),
        description: 'Chema Wallet contribution',
      });
      outcome = { kind: 'ACCEPTED', providerRef: res.providerRef, next: res.next };
    } catch (err) {
      outcome = submissionFailure(err);
    }
    const view = await this.system(this.collect.recordSubmission, { paymentId: r.payment.id, outcome });
    return { ...view, replayed: r.replayed };
  }

  view(actor: Actor, paymentId: string): Promise<PaymentView> {
    return this.bus.execute(this.collect.view, { paymentId }, { actor });
  }

  receipt(actor: Actor, receiptId: string): Promise<ReceiptView> {
    return this.bus.execute(viewReceipt, { receiptId }, { actor });
  }

  /**
   * Verify and store a provider callback. Throws NotFoundError for a disabled
   * or unknown rail and WebhookRejectedError for a forged/stale one (nothing
   * is stored in either case).
   */
  async receiveWebhook(rail: string, headers: Readonly<Record<string, string | undefined>>, rawBody: string) {
    const adapter = await this.deps.rails.collectable(this.db, rail);
    if (!adapter) throw new NotFoundError('rail', rail);
    const event = adapter.verifyWebhook(headers, rawBody, this.deps.clock());
    return this.system(this.events.receive, { rail, event, rawBody, signature: headers['x-chema-signature'] ?? '' });
  }

  /** Worker handler for `payment.event`. Idempotent. */
  processEvent(eventRowId: string) {
    return this.system(this.events.process, { eventRowId });
  }

  /** Ask providers about open payments that are due a status query. */
  async pollDue(limit = 50): Promise<{ polled: number }> {
    const { rows } = await this.db.query<{ id: string; rail: string; provider_ref: string | null }>(
      `SELECT id, rail, provider_ref FROM payment
        WHERE state IN ('INITIATED', 'PENDING_UNKNOWN') AND next_poll_at IS NOT NULL AND next_poll_at <= $1
        ORDER BY next_poll_at LIMIT $2`,
      [this.deps.clock().toISOString(), limit],
    );
    for (const p of rows) {
      const adapter = this.deps.rails.adapter(p.rail);
      let observation: PollObservation;
      if (!adapter) {
        observation = { state: 'ERROR', reason: 'no adapter' };
      } else {
        try {
          observation = await adapter.queryStatus({ reference: p.id, ...(p.provider_ref ? { providerRef: p.provider_ref } : {}) });
        } catch (err) {
          observation = { state: 'ERROR', reason: err instanceof Error ? err.name : 'error' };
        }
      }
      await this.system(this.collect.applyPoll, { paymentId: p.id, observation });
    }
    return { polled: rows.length };
  }

  async requestRefund(actor: Actor, input: RefundInput): Promise<RefundResultView & { submission?: string }> {
    const r = await this.bus.execute(this.refunds.request, input, { actor });
    if (r.status !== 'SUBMITTING') return r;
    const { rows } = await this.db.query<{ rail: string; provider_ref: string; amount_minor: string; currency: Currency }>(
      `SELECT p.rail, p.provider_ref, r.amount_minor::text AS amount_minor, r.currency
         FROM refund r JOIN payment p ON p.id = r.payment_id WHERE r.id = $1`,
      [r.refundId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('refund', r.refundId);
    try {
      const res = await this.adapter(row.rail).refund({
        providerRef: row.provider_ref,
        amount: { minor: parseMinor(row.amount_minor), ccy: row.currency },
        reference: r.refundId,
      });
      const s = await this.system(this.refunds.recordSubmission, { refundId: r.refundId, outcome: { kind: 'ACCEPTED', providerRef: res.providerRef } });
      return { ...r, submission: s.state };
    } catch (err) {
      if (err instanceof ProviderRejectedError || err instanceof ProviderUnavailableError) {
        const s = await this.system(this.refunds.recordSubmission, { refundId: r.refundId, outcome: { kind: 'REJECTED', reason: err.reason } });
        return { ...r, submission: s.state };
      }
      // Timeout / unknown: the money stays in refund clearing (not spendable, not lost)
      // and the refund stays open until the provider or an operator settles it.
      return { ...r, submission: 'UNKNOWN' };
    }
  }

  async runRecon(actor: Actor, rail: string, date: string): Promise<ReconSummary> {
    const rows = await this.adapter(rail).settlementReport(date);
    return this.bus.execute(this.recon.run, { rail, date, rows }, { actor });
  }

  listExceptions(actor: Actor, opts: { openOnly?: boolean } = {}): Promise<ReconExceptionView[]> {
    return this.bus.execute(listExceptions, { openOnly: opts.openOnly ?? true }, { actor });
  }

  /** Wallet buckets with `pending` filled from open payments. */
  balances(walletId: string): Promise<SubLedgerBalance[]> {
    return getBalances(this.db, walletId, { pending: paymentPendingSource });
  }
}

function submissionFailure(err: unknown): SubmissionOutcome {
  if (err instanceof ProviderRejectedError) return { kind: 'REJECTED', reason: err.reason };
  if (err instanceof ProviderUnavailableError) return { kind: 'UNAVAILABLE', reason: err.reason };
  if (err instanceof ProviderTimeoutError) return { kind: 'TIMEOUT' };
  // Anything unexpected might have reached the provider: treat as unknown, never as failed.
  return { kind: 'TIMEOUT' };
}

interface ExceptionRow {
  id: string;
  kind: string;
  severity: string;
  rail: string;
  payment_id: string | null;
  wallet_id: string | null;
  provider_ref: string | null;
  variance_minor: string | null;
  currency: Currency | null;
  detail: string;
  hold_id: string | null;
  owner_role: string;
  opened_at: Date;
  sla_due_at: Date;
  resolved_at: Date | null;
}

export const listExceptions: Command<{ openOnly: boolean }, ReconExceptionView[]> = {
  name: 'recon.exception.list',
  async resolve() {
    return { action: 'recon.exception.view', subject: { type: 'recon_exception', id: '*' } };
  },
  async run(tx, input) {
    const { rows } = await tx.query<ExceptionRow>(
      `SELECT id, kind, severity, rail, payment_id, wallet_id, provider_ref, variance_minor::text AS variance_minor, currency,
              detail, hold_id, owner_role, opened_at, sla_due_at, resolved_at
         FROM recon_exception ${input.openOnly ? 'WHERE resolved_at IS NULL' : ''}
        ORDER BY opened_at, id LIMIT 500`,
    );
    return {
      result: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        severity: r.severity,
        rail: r.rail,
        paymentId: r.payment_id,
        walletId: r.wallet_id,
        providerRef: r.provider_ref,
        varianceMinor: r.variance_minor,
        currency: r.currency,
        detail: r.detail,
        holdId: r.hold_id,
        ownerRole: r.owner_role,
        openedAt: new Date(r.opened_at).toISOString(),
        slaDueAt: new Date(r.sla_due_at).toISOString(),
        resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
      })),
    };
  },
};
