// Collection commands: initiate, record the provider's answer, poll status,
// view a payment or receipt. Every one runs through the CommandBus (authorised
// + audited in the same transaction). Provider calls happen BETWEEN commands,
// never inside a database transaction.
import {
  canonicalJson,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  sha256Hex,
  ValidationError,
  type Actor,
  type Command,
  type CommandTx,
  type FlagService,
} from '@chema/core';
import { bootstrapWalletAccounts, ensureGroupAccount, ensureSystemAccount, type PendingSource } from '@chema/ledger';
import type { NextAction, ProviderStatus } from '@chema/providers';
import { isCurrency, parseMinor, type Money, type Queryable } from '@chema/shared';
import { applyConfirmation, applyFailure } from './confirm';
import { raiseException } from './exceptions';
import { quoteFees } from './fees';
import type { ContributionGate } from './gate';
import type { RailRegistry } from './rails';
import { isUuid, loadPayment, logState, toView, transition } from './store';
import { OPEN_STATES, type PaymentRow, type PaymentView } from './types';

export interface PaymentDeps {
  flags: FlagService;
  rails: RailRegistry;
  gate: ContributionGate;
  clock: () => Date;
}

/** Status-query backoff (docs/04 §4): 1 min doubling, capped at 6 h, for 72 h. */
export const POLL = {
  firstDelayMs: 60_000,
  maxDelayMs: 6 * 3_600_000,
  windowMs: 72 * 3_600_000,
} as const;

export function nextPollDelay(attempts: number): number {
  const d = POLL.firstDelayMs * 2 ** Math.min(attempts, 20);
  return d > POLL.maxDelayMs ? POLL.maxDelayMs : d;
}

const KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;
const MSISDN_RE = /^\+[1-9][0-9]{6,14}$/;

export interface InitiateInput {
  walletId: string;
  rail: string;
  amount: Money;
  idempotencyKey: string;
  payerMsisdn?: string;
  /** Credit a GROUP sub-ledger instead of COMMUNITY (feature.group_contributions). */
  groupId?: string;
}

export interface InitiateResult {
  payment: PaymentView;
  /** Same key + same request ⇒ the original payment, nothing new created. */
  replayed: boolean;
  /** True when the provider still has to be asked (new, or never reached it). */
  needsSubmission: boolean;
}

export type SubmissionOutcome =
  | { kind: 'ACCEPTED'; providerRef: string; next: NextAction }
  | { kind: 'TIMEOUT' }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'UNAVAILABLE'; reason: string };

export type PollObservation = ProviderStatus | { state: 'ERROR'; reason: string };

/** Pending incoming money per wallet account: INITIATED/PENDING_UNKNOWN payments. Never spendable. */
export const paymentPendingSource: PendingSource = async (q: Queryable, walletId: string) => {
  const { rows } = await q.query<{ credit_account_id: string; pending: string }>(
    `SELECT credit_account_id, sum(net_minor)::text AS pending FROM payment
      WHERE wallet_id = $1 AND state IN ('INITIATED', 'PENDING_UNKNOWN') GROUP BY credit_account_id`,
    [walletId],
  );
  return new Map(rows.map((r) => [r.credit_account_id, parseMinor(r.pending)]));
};

function needsSubmission(p: PaymentRow): boolean {
  return p.state === 'INITIATED' && p.provider_ref === null && p.failure_reason === null;
}

/**
 * Create (or replay) a payment inside the CALLER'S command transaction. The
 * caller's command has already been authorised and audited by the bus; this is
 * how a contribution (P05) creates its payment atomically with itself. It never
 * calls the provider: submit afterwards with PaymentService.submit.
 */
export async function createPayment(tx: CommandTx, deps: PaymentDeps, actor: Actor, input: InitiateInput): Promise<InitiateResult> {
  const now = deps.clock();
  if (!isUuid(input.walletId)) throw new NotFoundError('wallet', String(input.walletId));
  if (!KEY_RE.test(input.idempotencyKey)) throw new ValidationError('bad idempotency key');
  if (typeof input.amount.minor !== 'bigint' || input.amount.minor <= 0n || !isCurrency(input.amount.ccy)) {
    throw new ValidationError('bad amount');
  }
  if (input.payerMsisdn !== undefined && !MSISDN_RE.test(input.payerMsisdn)) throw new ValidationError('bad msisdn');
  if (input.groupId !== undefined && !isUuid(input.groupId)) throw new ValidationError('bad group');

  const requestHash = sha256Hex(
    canonicalJson({
      walletId: input.walletId,
      rail: input.rail,
      minor: input.amount.minor,
      ccy: input.amount.ccy,
      payer: actor.personId,
      msisdn: input.payerMsisdn ?? null,
      ...(input.groupId ? { group: input.groupId } : {}),
    }),
  );
  const { rows: prior } = await tx.query<{ id: string; request_hash: string }>(
    'SELECT id, request_hash FROM payment WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  if (prior[0]) {
    if (prior[0].request_hash !== requestHash) throw new ConflictError('IDEMPOTENCY_KEY_REUSED');
    const p = await loadPayment(tx, prior[0].id);
    if (!p) throw new NotFoundError('payment', prior[0].id);
    return { payment: toView(p), replayed: true, needsSubmission: needsSubmission(p) };
  }

  if (!(await deps.flags.getIn(tx, 'contributions.enabled'))) throw new ForbiddenError('CONTRIBUTIONS_DISABLED');
  // A disabled rail does not exist for callers.
  if (!(await deps.rails.collectable(tx, input.rail))) throw new NotFoundError('rail', input.rail);
  if (!(await deps.gate.canAccept(tx, input.walletId))) throw new ForbiddenError('WALLET_NOT_ACCEPTING_CONTRIBUTIONS');

  const quote = await quoteFees(tx, deps.flags, input.rail, input.amount, now);
  const { community } = await bootstrapWalletAccounts(tx, input.walletId, input.amount.ccy);
  // Group money is its own sub-ledger (docs/06 Group contribution), never COMMUNITY.
  const creditAccount = input.groupId ? await ensureGroupAccount(tx, input.walletId, input.groupId, input.amount.ccy) : community;
  await ensureSystemAccount(tx, 'PROVIDER_CLEARING', input.amount.ccy, input.rail);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payment (wallet_id, credit_account_id, rail, idempotency_key, request_hash, payer_person_id, currency,
                          gross_minor, fee_minor, fee_payer, net_minor, fx_rate, settlement_currency, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8::bigint, $9::bigint, $10, $11::bigint, $12, $13, $14, $14)
     RETURNING id`,
    [
      input.walletId,
      creditAccount.id,
      input.rail,
      input.idempotencyKey,
      requestHash,
      actor.kind === 'CUSTOMER' ? actor.personId : null,
      input.amount.ccy,
      quote.gross.minor.toString(),
      quote.fee.minor.toString(),
      quote.feePayer,
      quote.net.minor.toString(),
      quote.fxRate,
      quote.settlementCurrency,
      now.toISOString(),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('payment not written');
  await logState(tx, { id, from: null, to: 'INITIATED', source: 'INITIATE' }, now);
  const p = await loadPayment(tx, id);
  if (!p) throw new Error('payment vanished');
  return { payment: toView(p), replayed: false, needsSubmission: true };
}

export function collectCommands(deps: PaymentDeps) {
  const initiate: Command<InitiateInput, InitiateResult> = {
    name: 'payment.initiate',
    async resolve(_q, input) {
      if (!isUuid(input.walletId)) throw new NotFoundError('wallet', String(input.walletId));
      return { action: 'payment.initiate', subject: { type: 'wallet', id: input.walletId, walletId: input.walletId } };
    },
    async run(tx, input, ctx) {
      const r = await createPayment(tx, deps, ctx.actor, input);
      return r.replayed
        ? { result: r, audit: { subjectId: r.payment.id, reasonCode: 'REPLAY' } }
        : { result: r, audit: { subjectId: r.payment.id, txnRef: `payment:${r.payment.id}`, after: { state: 'INITIATED', rail: input.rail } } };
    },
  };

  /** Record what the provider said to collect(). SYSTEM only. */
  const recordSubmission: Command<{ paymentId: string; outcome: SubmissionOutcome }, PaymentView> = {
    name: 'payment.record_submission',
    async resolve(q, input) {
      const p = await loadPayment(q, input.paymentId);
      if (!p) throw new NotFoundError('payment', input.paymentId);
      return { action: 'payment.process', subject: { type: 'payment', id: p.id } };
    },
    async run(tx, input) {
      const now = deps.clock();
      const p = await loadPayment(tx, input.paymentId, { lock: true });
      if (!p) throw new NotFoundError('payment', input.paymentId);
      const o = input.outcome;
      // A callback may already have settled it: only an untouched INITIATED payment is updated.
      if (p.state === 'INITIATED' && p.provider_ref === null) {
        const nextPoll = new Date(now.getTime() + nextPollDelay(0)).toISOString();
        switch (o.kind) {
          case 'ACCEPTED':
            await transition(tx, p, 'INITIATED', 'PROVIDER_SYNC', now, {
              provider_ref: o.providerRef,
              next_action: JSON.stringify(o.next),
              next_poll_at: nextPoll,
            });
            break;
          case 'TIMEOUT':
            // The provider may have the request: not FAILED, keep asking.
            await transition(tx, p, 'PENDING_UNKNOWN', 'PROVIDER_SYNC', now, { next_poll_at: nextPoll }, { detail: 'collect timeout' });
            break;
          case 'REJECTED':
          case 'UNAVAILABLE':
            await applyFailure(tx, now, p, 'FAILED', `${o.kind}: ${o.reason}`, 'PROVIDER_SYNC');
            break;
        }
      }
      const after = await loadPayment(tx, p.id);
      if (!after) throw new Error('payment vanished');
      return { result: toView(after), audit: { txnRef: `payment:${p.id}`, reasonCode: o.kind, after: { state: after.state } } };
    },
  };

  /** Apply one status-query answer to an open payment. SYSTEM only. */
  const applyPoll: Command<{ paymentId: string; observation: PollObservation }, { state: string; outcome: string }> = {
    name: 'payment.poll',
    async resolve(q, input) {
      const p = await loadPayment(q, input.paymentId);
      if (!p) throw new NotFoundError('payment', input.paymentId);
      return { action: 'payment.process', subject: { type: 'payment', id: p.id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const p = await loadPayment(tx, input.paymentId, { lock: true });
      if (!p) throw new NotFoundError('payment', input.paymentId);
      if (!OPEN_STATES.has(p.state)) return { result: { state: p.state, outcome: 'ALREADY_FINAL' } };
      const o = input.observation;
      let outcome: string;
      if (o.state === 'SUCCEEDED') {
        outcome = await applyConfirmation(tx, { actor: ctx.actor, now, rails: deps.rails }, p, {
          amount: o.amount,
          fee: o.fee,
          merchantRef: o.merchantRef,
          providerRef: o.providerRef,
          source: 'POLL',
        });
        if (outcome === 'CREDITED') return { result: { state: 'SUCCEEDED', outcome }, audit: { txnRef: `payment:${p.id}`, reasonCode: outcome } };
      } else if (o.state === 'FAILED' || o.state === 'EXPIRED') {
        outcome = await applyFailure(tx, now, p, o.state, o.state === 'FAILED' ? o.reason : 'expired', 'POLL');
        return { result: { state: o.state, outcome }, audit: { txnRef: `payment:${p.id}`, reasonCode: o.state } };
      } else {
        outcome = o.state;
      }

      // Still unknown (or refused above): back off, until the window closes.
      const age = now.getTime() - new Date(p.created_at).getTime();
      if (age >= POLL.windowMs) {
        // Never assume failure: money may have moved. Hand it to reconciliation.
        await transition(tx, p, 'PENDING_UNKNOWN', 'POLL', now, { next_poll_at: null, poll_attempts: p.poll_attempts + 1 }, { detail: 'poll window closed' });
        await raiseException(
          tx,
          {
            dedupKey: `poll-window:${p.id}`,
            kind: 'POLL_WINDOW_EXPIRED',
            severity: 'HIGH',
            rail: p.rail,
            paymentId: p.id,
            walletId: p.wallet_id,
            ...(p.provider_ref ? { providerRef: p.provider_ref } : {}),
            detail: `status still ${outcome} after 72h; left PENDING_UNKNOWN for reconciliation`,
          },
          now,
        );
        return { result: { state: 'PENDING_UNKNOWN', outcome: 'WINDOW_EXPIRED' }, audit: { txnRef: `payment:${p.id}`, reasonCode: 'POLL_WINDOW_EXPIRED' } };
      }
      const attempts = p.poll_attempts + 1;
      const next = new Date(now.getTime() + nextPollDelay(attempts));
      // A payment the provider cannot find yet / errors on is "unknown", not "initiated".
      const to = p.state === 'INITIATED' && o.state === 'PENDING' ? 'INITIATED' : 'PENDING_UNKNOWN';
      await transition(tx, p, to, 'POLL', now, { next_poll_at: next.toISOString(), poll_attempts: attempts });
      return { result: { state: to, outcome }, audit: { txnRef: `payment:${p.id}`, reasonCode: `POLL_${outcome}` } };
    },
  };

  const view: Command<{ paymentId: string }, PaymentView> = {
    name: 'payment.view',
    async resolve(q, input) {
      const p = await loadPayment(q, input.paymentId);
      if (!p) throw new NotFoundError('payment', input.paymentId);
      return {
        action: 'payment.view',
        subject: { type: 'payment', id: p.id, ...(p.payer_person_id ? { ownerPersonId: p.payer_person_id } : {}) },
      };
    },
    async run(tx, input) {
      const p = await loadPayment(tx, input.paymentId);
      if (!p) throw new NotFoundError('payment', input.paymentId);
      return { result: toView(p) };
    },
  };

  return { initiate, recordSubmission, applyPoll, view };
}

export interface ReceiptView {
  id: string;
  receiptNo: string;
  paymentId: string;
  walletId: string;
  rail: string;
  gross: Money;
  fee: Money;
  net: Money;
  providerRef: string;
  issuedAt: string;
}

interface ReceiptRow {
  id: string;
  receipt_no: string;
  payment_id: string;
  payer_person_id: string | null;
  wallet_id: string;
  rail: string;
  currency: Money['ccy'];
  gross_minor: string;
  fee_minor: string;
  net_minor: string;
  provider_ref: string;
  issued_at: Date;
}

async function loadReceipt(q: Queryable, id: string): Promise<ReceiptRow | undefined> {
  if (!isUuid(id)) return undefined;
  const { rows } = await q.query<ReceiptRow>(
    `SELECT id, receipt_no, payment_id, payer_person_id, wallet_id, rail, currency, gross_minor::text AS gross_minor,
            fee_minor::text AS fee_minor, net_minor::text AS net_minor, provider_ref, issued_at
       FROM receipt WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Receipts exist only for credited payments and are retrievable whatever happened to the notification. */
export const viewReceipt: Command<{ receiptId: string }, ReceiptView> = {
  name: 'receipt.view',
  async resolve(q, input) {
    const r = await loadReceipt(q, input.receiptId);
    if (!r) throw new NotFoundError('receipt', input.receiptId);
    return { action: 'receipt.view_own', subject: { type: 'receipt', id: r.id, ...(r.payer_person_id ? { ownerPersonId: r.payer_person_id } : {}) } };
  },
  async run(tx, input) {
    const r = await loadReceipt(tx, input.receiptId);
    if (!r) throw new NotFoundError('receipt', input.receiptId);
    const m = (v: string): Money => ({ minor: parseMinor(v), ccy: r.currency });
    return {
      result: {
        id: r.id,
        receiptNo: r.receipt_no,
        paymentId: r.payment_id,
        walletId: r.wallet_id,
        rail: r.rail,
        gross: m(r.gross_minor),
        fee: m(r.fee_minor),
        net: m(r.net_minor),
        providerRef: r.provider_ref,
        issuedAt: new Date(r.issued_at).toISOString(),
      },
    };
  },
};
