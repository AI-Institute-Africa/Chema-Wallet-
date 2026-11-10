// ClaimsService: the one entry point channels use for the Fidelity claim path.
// Like PaymentService it sequences commands and adapter calls so no call to
// Fidelity ever runs inside a database transaction:
//   lookup:   prepare (tx) → lookupPolicy() → record (tx)
//   link / evidence / sync: command queues a fidelity_request (tx)
//             → claim (tx) → adapter call (no tx) → record + apply (tx)
//   webhook:  verify → receive (tx: raw + outbox) → worker → process (tx: queue SYNC) → deliver
//   recon:    benefitSettlements() → run (tx)
import { NotFoundError, SYSTEM_ACTOR, type Actor, type Command, type CommandBus, type FlagService } from '@chema/core';
import type { SqlClient } from '@chema/shared';
import {
  DuplicateClaimError,
  FidelityRejectedError,
  type FidelityAdapter,
  type PolicyIdentifier,
} from './adapter';
import { claimCommands, type ClaimView, type LinkInput, type LookupView, type UnblockInput } from './commands';
import { reconCommands, type BenefitReconSummary } from './recon';
import { syncCommands, type CallPlan, type CallResult } from './sync';
import type { ClaimsDeps } from './store';
import { viewCommands, type FundsView } from './view';

export interface ClaimsServiceDeps {
  db: SqlClient;
  bus: CommandBus;
  flags: FlagService;
  adapter: FidelityAdapter;
  recipientKey: Buffer;
  clock?: () => Date;
}

export class ClaimsService {
  readonly deps: ClaimsDeps;
  readonly commands: ReturnType<typeof claimCommands>;
  readonly sync: ReturnType<typeof syncCommands>;
  readonly recon: ReturnType<typeof reconCommands>;
  readonly views: ReturnType<typeof viewCommands>;
  private readonly db: SqlClient;
  private readonly bus: CommandBus;
  private readonly adapter: FidelityAdapter;

  constructor(d: ClaimsServiceDeps) {
    this.db = d.db;
    this.bus = d.bus;
    this.adapter = d.adapter;
    this.deps = { flags: d.flags, clock: d.clock ?? (() => new Date()), recipientKey: d.recipientKey };
    this.commands = claimCommands(this.deps);
    this.sync = syncCommands(this.deps);
    this.recon = reconCommands(this.deps);
    this.views = viewCommands();
  }

  private system<I, O>(cmd: Command<I, O>, input: I): Promise<O> {
    return this.bus.execute(cmd, input, { actor: SYSTEM_ACTOR });
  }

  /** Approved policy lookup. Fidelity unreachable ⇒ FidelityUnavailableError (nothing stored). */
  async lookupPolicy(actor: Actor, walletId: string, identifier: PolicyIdentifier = {}): Promise<LookupView> {
    const prep = await this.bus.execute(this.commands.lookupPrepare, { walletId, ...identifier }, { actor });
    const record = await this.adapter.lookupPolicy(prep.identifier, prep.requester);
    return this.bus.execute(this.commands.lookupRecord, { walletId, linkId: prep.linkId, record }, { actor });
  }

  /** Lodge/link the claim; tries Fidelity at once, otherwise the queue retries. */
  async linkClaim(actor: Actor, input: LinkInput): Promise<ClaimView> {
    const r = await this.bus.execute(this.commands.link, input, { actor });
    if (r.requestId) await this.deliver(r.requestId);
    return this.view(actor, input.walletId);
  }

  async submitEvidence(actor: Actor, walletId: string, documentIds: readonly string[]): Promise<{ added: number }> {
    const r = await this.bus.execute(this.commands.submitEvidence, { walletId, documentIds }, { actor });
    if (r.requestId) await this.deliver(r.requestId);
    return { added: r.added };
  }

  view(actor: Actor, walletId: string): Promise<ClaimView> {
    return this.bus.execute(this.commands.view, { walletId }, { actor });
  }

  funds(actor: Actor, walletId: string): Promise<FundsView> {
    return this.bus.execute(this.views.funds, { walletId }, { actor });
  }

  /** Maker (no approvalId) / execute (with approvalId) of a beneficiary-mismatch unblock. */
  async unblockRoute(actor: Actor, input: UnblockInput) {
    const r = await this.bus.execute(this.commands.unblockRoute, input, { actor });
    if (r.status === 'UNBLOCKED') await this.deliverDue();
    return r;
  }

  /** Verify + store a Fidelity callback. Off flag ⇒ NotFoundError (404); forged ⇒ WebhookRejectedError. */
  async receiveWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: string) {
    if (!(await this.deps.flags.get('fidelity.claims_link'))) throw new NotFoundError('fidelity_webhook', 'fidelity');
    const event = this.adapter.verifyWebhook(headers, rawBody, this.deps.clock());
    return this.system(this.sync.receive, { event, rawBody, signature: headers['x-chema-signature'] ?? '' });
  }

  /** Worker handler for `fidelity.event`. Idempotent. */
  async processEvent(eventRowId: string): Promise<{ outcome: string }> {
    const r = await this.system(this.sync.processEvent, { eventRowId });
    if (r.requestId) await this.deliver(r.requestId);
    return { outcome: r.outcome };
  }

  /** One attempt of one queued call. Never throws for a Fidelity failure. */
  async deliver(requestId: string): Promise<string> {
    const plan = await this.system(this.sync.claim, { requestId });
    if (plan.kind === 'SKIP') return 'SKIP';
    const result = await this.call(plan);
    const r = await this.system(this.sync.record, { requestId, result });
    return r.status;
  }

  private async call(plan: Exclude<CallPlan, { kind: 'SKIP' }>): Promise<CallResult> {
    try {
      switch (plan.kind) {
        case 'LINK_CLAIM':
          return { ok: true, kind: 'LINK_CLAIM', claimRef: (await this.adapter.createOrLinkClaim(plan.request)).claimRef };
        case 'SUBMIT_EVIDENCE':
          await this.adapter.submitEvidence(plan.claimRef, plan.documentIds);
          return { ok: true, kind: 'SUBMIT_EVIDENCE' };
        case 'SYNC': {
          const status = await this.adapter.getClaimStatus(plan.claimRef);
          const route = await this.adapter.getApprovedRecipientRoute(plan.claimRef);
          const payment = await this.adapter.getBenefitPayment(plan.claimRef);
          return { ok: true, kind: 'SYNC', snapshot: { status, route, payment } };
        }
      }
    } catch (err) {
      if (err instanceof DuplicateClaimError) return { ok: false, final: 'DUPLICATE_CLAIM', code: 'DUPLICATE_CLAIM' };
      if (err instanceof FidelityRejectedError) {
        return { ok: false, final: 'REJECTED', code: /^[A-Z][A-Z0-9_]{1,63}$/.test(err.code) ? err.code : 'REJECTED' };
      }
      return { ok: false, error: err instanceof Error ? err.name : 'error' };
    }
  }

  /** Retry loop: every QUEUED/RETRY call that is due. */
  async deliverDue(limit = 50): Promise<{ attempted: number }> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM fidelity_request WHERE status IN ('QUEUED', 'RETRY') AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`,
      [this.deps.clock().toISOString(), limit],
    );
    for (const r of rows) await this.deliver(r.id);
    return { attempted: rows.length };
  }

  /** Poller: queue syncs for stale open claims, then deliver what is due. */
  async pollDue(): Promise<{ queued: number; attempted: number }> {
    const { queued } = await this.system(this.sync.scheduleSyncs, {});
    const { attempted } = await this.deliverDue();
    return { queued, attempted };
  }

  /** Daily benefit reconciliation of `date` against Fidelity's ledger. */
  async runRecon(actor: Actor, date: string): Promise<BenefitReconSummary> {
    const rows = await this.adapter.benefitSettlements(date);
    return this.bus.execute(this.recon.run, { date, rows }, { actor });
  }
}
