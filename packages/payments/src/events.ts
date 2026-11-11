// Provider callbacks (docs/04 §4): verify → store raw (append) → queue →
// idempotent processing. Verification happens in the adapter before
// `receive` runs; the unique (rail, provider_event_id) is the replay cache, and
// the outcome row (one per event, processed under a row lock) makes a second
// delivery a no-op.
import { enqueueOutbox, NotFoundError, sha256Hex, type Command, type CommandTx } from '@chema/core';
import { ensureSystemAccount, getBalances, lockWallet, placeHold, post, releaseHold, reverse, type EntryInput } from '@chema/ledger';
import type { ProviderEvent } from '@chema/providers';
import { money, parseMinor, type Money } from '@chema/shared';
import { applyConfirmation, applyFailure, type ApplyCtx } from './confirm';
import type { PaymentDeps } from './collect';
import { closeCase, EXCEPTION_OWNER_ROLE, openCase, raiseException, slaDue } from './exceptions';
import { isUuid, loadPayment, loadPaymentByProviderRef, transition } from './store';
import type { PaymentRow } from './types';

/** Outbox topic the payouts worker consumes: `{ rail, providerRef, reference? }`. */
export const PAYOUT_EVENT_TOPIC = 'payout.event';

export interface ReceiveInput {
  rail: string;
  event: ProviderEvent;
  rawBody: string;
  signature: string;
}

interface StoredEvent {
  id: string;
  rail: string;
  event: ProviderEvent & { amount?: { minor: string; ccy: Money['ccy'] }; fee?: { minor: string; ccy: Money['ccy'] } };
}

function reviveMoney(v: { minor: string | bigint; ccy: Money['ccy'] } | undefined): Money | undefined {
  return v ? money(BigInt(v.minor), v.ccy) : undefined;
}

/** JSON-safe copy of a verified event (bigints as strings). */
function storable(e: ProviderEvent): Record<string, unknown> {
  const m = (x: Money | undefined) => (x ? { minor: x.minor.toString(), ccy: x.ccy } : undefined);
  return { ...e, amount: m(e.amount), fee: m(e.fee) };
}

/** Sum of what has left the wallet for this payment through refunds (not failed) and chargebacks. */
async function compensated(tx: CommandTx, paymentId: string): Promise<bigint> {
  const { rows } = await tx.query<{ total: string }>(
    `SELECT (COALESCE((SELECT sum(amount_minor) FROM refund WHERE payment_id = $1 AND failed_at IS NULL), 0)
           + COALESCE((SELECT sum(recovered_minor) FROM payment_dispute WHERE payment_id = $1 AND outcome = 'CHARGED_BACK'), 0))::text AS total`,
    [paymentId],
  );
  return parseMinor(rows[0]?.total ?? '0');
}

/** What the wallet received for this payment (net credit). */
async function creditedNet(tx: CommandTx, p: PaymentRow): Promise<bigint> {
  if (!p.credit_journal_id) return 0n;
  const { rows } = await tx.query<{ net: string }>(
    `SELECT COALESCE(sum(amount_minor), 0)::text AS net FROM ledger_entry
      WHERE journal_id = $1 AND account_id = $2 AND side = 'C'`,
    [p.credit_journal_id, p.credit_account_id],
  );
  return parseMinor(rows[0]?.net ?? '0');
}

export { compensated, creditedNet };

export function eventCommands(deps: PaymentDeps) {
  const receive: Command<ReceiveInput, { eventRowId: string; duplicate: boolean }> = {
    name: 'payment.receive_event',
    async resolve(_q, input) {
      return { action: 'payment.process', subject: { type: 'provider_event', id: `${input.rail}:${input.event.eventId}` } };
    },
    async run(tx, input) {
      const now = deps.clock();
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO provider_event (rail, provider_event_id, event_type, provider_ref, event, raw_body, signature_hash, received_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         ON CONFLICT (rail, provider_event_id) DO NOTHING RETURNING id`,
        [
          input.rail,
          input.event.eventId,
          input.event.type,
          input.event.providerRef,
          JSON.stringify(storable(input.event)),
          input.rawBody,
          sha256Hex(input.signature),
          now.toISOString(),
        ],
      );
      const inserted = rows[0]?.id;
      if (!inserted) {
        const { rows: ex } = await tx.query<{ id: string }>(
          'SELECT id FROM provider_event WHERE rail = $1 AND provider_event_id = $2',
          [input.rail, input.event.eventId],
        );
        return { result: { eventRowId: ex[0]?.id ?? '', duplicate: true }, audit: { reasonCode: 'REPLAY' } };
      }
      await enqueueOutbox(tx, 'payment.event', { eventRowId: inserted });
      return { result: { eventRowId: inserted, duplicate: false }, audit: { subjectId: inserted, reasonCode: input.event.type } };
    },
  };

  const process: Command<{ eventRowId: string }, { outcome: string; paymentId: string | null }> = {
    name: 'payment.process_event',
    async resolve(q, input) {
      if (!isUuid(input.eventRowId)) throw new NotFoundError('provider_event', String(input.eventRowId));
      const { rows } = await q.query<{ id: string }>('SELECT id FROM provider_event WHERE id = $1', [input.eventRowId]);
      if (!rows[0]) throw new NotFoundError('provider_event', input.eventRowId);
      return { action: 'payment.process', subject: { type: 'provider_event', id: input.eventRowId } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      // Row lock serialises concurrent deliveries of the same event.
      const { rows } = await tx.query<StoredEvent>('SELECT id, rail, event FROM provider_event WHERE id = $1 FOR UPDATE', [input.eventRowId]);
      const stored = rows[0];
      if (!stored) throw new NotFoundError('provider_event', input.eventRowId);
      const done = await tx.query<{ outcome: string; payment_id: string | null }>(
        'SELECT outcome, payment_id FROM provider_event_outcome WHERE event_id = $1',
        [stored.id],
      );
      if (done.rows[0]) {
        return { result: { outcome: done.rows[0].outcome, paymentId: done.rows[0].payment_id }, audit: { reasonCode: 'ALREADY_PROCESSED' } };
      }
      const amount = reviveMoney(stored.event.amount);
      const fee = reviveMoney(stored.event.fee);
      const e: ProviderEvent = { ...stored.event, ...(amount ? { amount } : {}), ...(fee ? { fee } : {}) } as ProviderEvent;
      const actx: ApplyCtx = { actor: ctx.actor, now, rails: deps.rails };
      const { outcome, paymentId } = await handle(tx, actx, stored.rail, stored.id, e);
      await tx.query('INSERT INTO provider_event_outcome (event_id, outcome, payment_id, processed_at) VALUES ($1, $2, $3::uuid, $4)', [
        stored.id,
        outcome,
        paymentId,
        now.toISOString(),
      ]);
      return {
        result: { outcome, paymentId },
        audit: { reasonCode: `${e.type}:${outcome}`, ...(paymentId ? { txnRef: `payment:${paymentId}` } : {}) },
      };
    },
  };

  return { receive, process };
}

async function findPayment(tx: CommandTx, rail: string, e: ProviderEvent): Promise<PaymentRow | undefined> {
  const byRef = await loadPaymentByProviderRef(tx, rail, e.providerRef, { lock: true });
  if (byRef) return byRef;
  // The callback can beat our own record of the provider's answer; fall back to our reference.
  if (e.reference && isUuid(e.reference)) {
    const p = await loadPayment(tx, e.reference, { lock: true });
    if (p && p.rail === rail && p.provider_ref === null) return p;
  }
  return undefined;
}

type Handled = { outcome: string; paymentId: string | null };

async function handle(tx: CommandTx, ctx: ApplyCtx, rail: string, eventRowId: string, e: ProviderEvent): Promise<Handled> {
  const adapter = ctx.rails.adapter(rail);
  if (!adapter) return { outcome: 'UNKNOWN_RAIL', paymentId: null };

  if (e.type === 'REFUND_SUCCEEDED' || e.type === 'REFUND_FAILED') return refundOutcome(tx, ctx, rail, e);
  // Payout callbacks are triggers only (P07): the payouts worker re-reads the
  // payout from the provider before it changes anything.
  if (e.type === 'PAYOUT_SUCCEEDED' || e.type === 'PAYOUT_FAILED' || e.type === 'PAYOUT_REVERSED') {
    if (e.merchantRef !== adapter.merchantRef) return { outcome: 'WRONG_MERCHANT', paymentId: null };
    await enqueueOutbox(tx, PAYOUT_EVENT_TOPIC, { rail, providerRef: e.providerRef, ...(e.reference ? { reference: e.reference } : {}) });
    return { outcome: 'PAYOUT_TRIGGER', paymentId: null };
  }

  const p = await findPayment(tx, rail, e);
  if (!p) {
    if (e.type === 'PAYMENT_SUCCEEDED') {
      // Money confirmed for nothing we know: reconciliation books it to suspense when it settles.
      await raiseException(
        tx,
        {
          dedupKey: `unmatched-callback:${rail}:${e.providerRef}`,
          kind: 'UNMATCHED_INCOMING',
          severity: 'HIGH',
          rail,
          providerRef: e.providerRef,
          ...(e.amount ? { currency: e.amount.ccy, varianceMinor: e.amount.minor } : {}),
          detail: 'success callback for an unknown payment; not credited',
        },
        ctx.now,
      );
    }
    return { outcome: 'UNKNOWN_PAYMENT', paymentId: null };
  }

  switch (e.type) {
    case 'PAYMENT_SUCCEEDED': {
      if (!e.amount) return { outcome: 'NO_AMOUNT', paymentId: p.id };
      const outcome = await applyConfirmation(tx, ctx, p, {
        amount: e.amount,
        ...(e.fee ? { fee: e.fee } : {}),
        merchantRef: e.merchantRef,
        providerRef: e.providerRef,
        source: 'WEBHOOK',
        eventId: eventRowId,
      });
      return { outcome, paymentId: p.id };
    }
    case 'PAYMENT_FAILED':
    case 'PAYMENT_EXPIRED': {
      if (e.merchantRef !== adapter.merchantRef) return { outcome: 'WRONG_DESTINATION', paymentId: p.id };
      const to = e.type === 'PAYMENT_FAILED' ? 'FAILED' : 'EXPIRED';
      const outcome = await applyFailure(tx, ctx.now, p, to, e.reason ?? to.toLowerCase(), 'WEBHOOK', eventRowId);
      return { outcome, paymentId: p.id };
    }
    case 'DISPUTE_OPENED':
      return { outcome: await disputeOpened(tx, ctx, rail, p, e), paymentId: p.id };
    case 'CHARGEBACK':
      return { outcome: await chargeback(tx, ctx, rail, p, e), paymentId: p.id };
    case 'DISPUTE_WON':
      return { outcome: await disputeWon(tx, ctx, rail, e), paymentId: p.id };
    default:
      return { outcome: 'IGNORED', paymentId: p.id };
  }
}

// ── Disputes / chargebacks (docs/04 §8) ─────────────────────────────────────

interface DisputeRow {
  id: string;
  case_id: string;
  amount_minor: string;
  hold_id: string | null;
  outcome: string | null;
}

async function loadDispute(tx: CommandTx, rail: string, disputeRef: string): Promise<DisputeRow | undefined> {
  const { rows } = await tx.query<DisputeRow>(
    `SELECT id, case_id, amount_minor::text AS amount_minor, hold_id, outcome FROM payment_dispute
      WHERE rail = $1 AND dispute_ref = $2 FOR UPDATE`,
    [rail, disputeRef],
  );
  return rows[0];
}

async function createDispute(tx: CommandTx, ctx: ApplyCtx, rail: string, p: PaymentRow, disputeRef: string, amount: bigint, holdId: string | null): Promise<DisputeRow> {
  const caseId = await openCase(
    tx,
    { type: 'CHARGEBACK', walletId: p.wallet_id, paymentId: p.id, externalRef: `${rail}:${disputeRef}`, summary: 'card/provider dispute', openedBy: ctx.actor.personId },
    ctx.now,
  );
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payment_dispute (payment_id, rail, dispute_ref, case_id, amount_minor, hold_id, opened_at)
     VALUES ($1, $2, $3, $4, $5::bigint, $6::uuid, $7) RETURNING id`,
    [p.id, rail, disputeRef, caseId, amount.toString(), holdId, ctx.now.toISOString()],
  );
  return { id: rows[0]?.id ?? '', case_id: caseId, amount_minor: amount.toString(), hold_id: holdId, outcome: null };
}

/** Source-aware hold: only this payment's credit, only the disputed amount. */
async function disputeOpened(tx: CommandTx, ctx: ApplyCtx, rail: string, p: PaymentRow, e: ProviderEvent): Promise<string> {
  if (!e.disputeRef || !e.amount) return 'MALFORMED';
  if (!p.credit_journal_id) return 'NOT_CREDITED';
  if (await loadDispute(tx, rail, e.disputeRef)) return 'DUPLICATE';
  const net = await creditedNet(tx, p);
  const amount = e.amount.minor < net ? e.amount.minor : net;
  const holdId = await placeHold(tx, ctx.actor, {
    scope: 'TXN',
    walletId: p.wallet_id,
    journalId: p.credit_journal_id,
    accountId: p.credit_account_id,
    amount: money(amount, p.currency),
    reasonCode: 'CHARGEBACK_DISPUTE',
    ownerId: EXCEPTION_OWNER_ROLE,
    reviewAt: slaDue('MEDIUM', ctx.now),
  });
  await createDispute(tx, ctx, rail, p, e.disputeRef, e.amount.minor, holdId);
  return 'HOLD_PLACED';
}

/**
 * The provider has taken the money back. Recover what the wallet still has for
 * this payment; any shortfall (money already paid out) is parked in suspense
 * and raised — the ledger never goes negative and no loss-bearer is invented.
 */
async function chargeback(tx: CommandTx, ctx: ApplyCtx, rail: string, p: PaymentRow, e: ProviderEvent): Promise<string> {
  if (!e.disputeRef || !e.amount || e.amount.ccy !== p.currency) return 'MALFORMED';
  if (!p.credit_journal_id) return 'NOT_CREDITED';
  let d = await loadDispute(tx, rail, e.disputeRef);
  if (d?.outcome) return 'DUPLICATE';
  if (!d) d = await createDispute(tx, ctx, rail, p, e.disputeRef, e.amount.minor, null);

  await lockWallet(tx, p.wallet_id);
  if (d.hold_id) await releaseHold(tx, ctx.actor, d.hold_id, 'chargeback posted');

  const ccy = p.currency;
  const amount = e.amount.minor;
  const balances = await getBalances(tx, p.wallet_id);
  const available = balances.find((b) => b.account.id === p.credit_account_id)?.available.minor ?? 0n;
  const remaining = (await creditedNet(tx, p)) - (await compensated(tx, p.id));
  let recover = amount;
  if (recover > available) recover = available;
  if (recover > remaining) recover = remaining;
  if (recover < 0n) recover = 0n;
  const shortfall = amount - recover;

  const refundClearing = await ensureSystemAccount(tx, 'REFUND_CLEARING', ccy);
  const providerClearing = await ensureSystemAccount(tx, 'PROVIDER_CLEARING', ccy, rail);
  const refs = { txnRef: `payment:${p.id}`, providerRef: e.providerRef };
  if (recover > 0n) {
    await post(tx, ctx.actor, {
      idempotencyKey: `chargeback:${d.id}:wallet`,
      kind: 'CHARGEBACK',
      entries: [
        { accountId: p.credit_account_id, side: 'D', amount: money(recover, ccy), ...refs },
        { accountId: refundClearing.id, side: 'C', amount: money(recover, ccy), ...refs },
      ],
    });
  }
  const clearingEntries: EntryInput[] = [{ accountId: providerClearing.id, side: 'C', amount: money(amount, ccy), ...refs }];
  if (recover > 0n) clearingEntries.push({ accountId: refundClearing.id, side: 'D', amount: money(recover, ccy), ...refs });
  let suspenseJournal: string | undefined;
  if (shortfall > 0n) {
    const suspense = await ensureSystemAccount(tx, 'SUSPENSE_UNMATCHED', ccy);
    clearingEntries.push({ accountId: suspense.id, side: 'D', amount: money(shortfall, ccy), ...refs });
  }
  const cj = await post(tx, ctx.actor, { idempotencyKey: `chargeback:${d.id}:clearing`, kind: 'CHARGEBACK', entries: clearingEntries });
  if (shortfall > 0n) suspenseJournal = cj.journalId;

  await tx.query(
    `UPDATE payment_dispute SET outcome = 'CHARGED_BACK', recovered_minor = $2::bigint, shortfall_minor = $3::bigint,
            decided_at = $4, updated_at = now() WHERE id = $1`,
    [d.id, recover.toString(), shortfall.toString(), ctx.now.toISOString()],
  );
  if (shortfall > 0n) {
    await raiseException(
      tx,
      {
        dedupKey: `chargeback-shortfall:${d.id}`,
        kind: 'CHARGEBACK_SHORTFALL',
        severity: 'HIGH',
        rail,
        paymentId: p.id,
        walletId: p.wallet_id,
        providerRef: e.providerRef,
        currency: ccy,
        varianceMinor: shortfall,
        ...(suspenseJournal ? { journalId: suspenseJournal } : {}),
        detail: 'chargeback exceeds what the wallet still holds for this payment; shortfall parked in suspense',
      },
      ctx.now,
    );
  }
  if ((await compensated(tx, p.id)) >= (await creditedNet(tx, p)) && p.state === 'SUCCEEDED') {
    await transition(tx, p, 'CHARGED_BACK', 'CHARGEBACK', ctx.now);
  }
  return shortfall > 0n ? 'CHARGED_BACK_SHORTFALL' : 'CHARGED_BACK';
}

async function disputeWon(tx: CommandTx, ctx: ApplyCtx, rail: string, e: ProviderEvent): Promise<string> {
  if (!e.disputeRef) return 'MALFORMED';
  const d = await loadDispute(tx, rail, e.disputeRef);
  if (!d) return 'UNKNOWN_DISPUTE';
  if (d.outcome) return 'DUPLICATE';
  if (d.hold_id) await releaseHold(tx, ctx.actor, d.hold_id, 'dispute won');
  await tx.query(`UPDATE payment_dispute SET outcome = 'WON', decided_at = $2, updated_at = now() WHERE id = $1`, [d.id, ctx.now.toISOString()]);
  await closeCase(tx, d.case_id, ctx.actor.personId, 'dispute won');
  return 'DISPUTE_WON';
}

// ── Refund completion (docs/04 §8): COMPLETED only on provider confirmation ─

interface RefundRow {
  id: string;
  payment_id: string;
  case_id: string;
  amount_minor: string;
  currency: Money['ccy'];
  debit_journal_id: string;
  completed_at: Date | null;
  failed_at: Date | null;
}

async function refundOutcome(tx: CommandTx, ctx: ApplyCtx, rail: string, e: ProviderEvent): Promise<Handled> {
  if (!e.refundRef) return { outcome: 'MALFORMED', paymentId: null };
  const { rows } = await tx.query<RefundRow>(
    `SELECT r.id, r.payment_id, r.case_id, r.amount_minor::text AS amount_minor, r.currency, r.debit_journal_id, r.completed_at, r.failed_at
       FROM refund r JOIN payment p ON p.id = r.payment_id
      WHERE p.rail = $1 AND r.provider_ref = $2 FOR UPDATE OF r`,
    [rail, e.refundRef],
  );
  const r = rows[0];
  if (!r) return { outcome: 'UNKNOWN_REFUND', paymentId: null };
  if (r.completed_at || r.failed_at) return { outcome: 'DUPLICATE', paymentId: r.payment_id };
  const outcome = e.type === 'REFUND_SUCCEEDED' ? await completeRefund(tx, ctx, rail, r) : await failRefund(tx, ctx, r, e.reason ?? 'provider refused');
  return { outcome, paymentId: r.payment_id };
}

async function completeRefund(tx: CommandTx, ctx: ApplyCtx, rail: string, r: RefundRow): Promise<string> {
  const amount = money(parseMinor(r.amount_minor), r.currency);
  const refundClearing = await ensureSystemAccount(tx, 'REFUND_CLEARING', r.currency);
  const providerClearing = await ensureSystemAccount(tx, 'PROVIDER_CLEARING', r.currency, rail);
  const j = await post(tx, ctx.actor, {
    idempotencyKey: `refund:${r.id}:complete`,
    kind: 'REFUND',
    entries: [
      { accountId: refundClearing.id, side: 'D', amount, txnRef: `refund:${r.id}` },
      { accountId: providerClearing.id, side: 'C', amount, txnRef: `refund:${r.id}` },
    ],
  });
  await tx.query('UPDATE refund SET completed_at = $2, completion_journal_id = $3, updated_at = now() WHERE id = $1', [
    r.id,
    ctx.now.toISOString(),
    j.journalId,
  ]);
  await closeCase(tx, r.case_id, ctx.actor.personId, 'refund completed');
  const p = await loadPayment(tx, r.payment_id, { lock: true });
  if (p && p.state === 'SUCCEEDED' && (await compensated(tx, p.id)) >= (await creditedNet(tx, p))) {
    // Fully refunded only when every refund has been confirmed.
    const { rows } = await tx.query('SELECT 1 FROM refund WHERE payment_id = $1 AND completed_at IS NULL AND failed_at IS NULL', [p.id]);
    if (rows.length === 0) await transition(tx, p, 'REFUNDED', 'REFUND', ctx.now);
  }
  return 'REFUND_COMPLETED';
}

/** The money goes back to the wallet with a linked reversal of the refund debit. */
export async function failRefund(tx: CommandTx, ctx: Pick<ApplyCtx, 'actor' | 'now'>, r: Pick<RefundRow, 'id' | 'debit_journal_id'>, reason: string): Promise<string> {
  const rev = await reverse(tx, ctx.actor, r.debit_journal_id, `refund failed: ${reason}`.slice(0, 200));
  await tx.query(
    `UPDATE refund SET failed_at = $2, failure_reason = $3, reversal_journal_id = $4, updated_at = now()
      WHERE id = $1 AND completed_at IS NULL AND failed_at IS NULL`,
    [r.id, ctx.now.toISOString(), reason.slice(0, 200), rev.journalId],
  );
  return 'REFUND_FAILED';
}
