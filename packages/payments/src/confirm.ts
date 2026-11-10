// The ONLY place a contribution is credited (docs/04 §3, CLAUDE.md invariant):
// on a validated, authoritative provider confirmation, posted once.
//
// "Once" is enforced three times: the payment row is locked and must still be
// open; the journal key `payment:<id>:credit` is unique in the ledger; and the
// payment_guard trigger lets credit_journal_id be set once, only to that
// journal, only together with SUCCEEDED.
import { enqueueOutbox, type Actor, type CommandTx } from '@chema/core';
import { ensureSystemAccount, post, type EntryInput } from '@chema/ledger';
import { money, parseMinor, type Money } from '@chema/shared';
import { raiseException } from './exceptions';
import type { RailRegistry } from './rails';
import { transition } from './store';
import { OPEN_STATES, type PaymentRow, type StateSource } from './types';

export interface ApplyCtx {
  actor: Actor;
  now: Date;
  rails: RailRegistry;
}

export interface Confirmation {
  amount: Money;
  fee?: Money;
  merchantRef: string;
  providerRef: string;
  source: StateSource;
  eventId?: string;
}

export type ConfirmOutcome = 'CREDITED' | 'ALREADY_FINAL' | 'WRONG_DESTINATION' | 'CURRENCY_MISMATCH' | 'UNKNOWN_RAIL';

/** `p` must have been loaded FOR UPDATE in this transaction. */
export async function applyConfirmation(tx: CommandTx, ctx: ApplyCtx, p: PaymentRow, c: Confirmation): Promise<ConfirmOutcome> {
  if (!OPEN_STATES.has(p.state)) return 'ALREADY_FINAL';
  const adapter = ctx.rails.adapter(p.rail);
  if (!adapter) return 'UNKNOWN_RAIL';

  // Money confirmed into someone else's merchant account is not ours to credit.
  if (c.merchantRef !== adapter.merchantRef) {
    await raiseException(
      tx,
      {
        dedupKey: `wrong-destination:${p.rail}:${c.providerRef}`,
        kind: 'WRONG_DESTINATION',
        severity: 'HIGH',
        rail: p.rail,
        paymentId: p.id,
        walletId: p.wallet_id,
        providerRef: c.providerRef,
        detail: 'confirmation names a merchant account that is not ours; not credited',
      },
      ctx.now,
    );
    return 'WRONG_DESTINATION';
  }
  if (c.amount.ccy !== p.currency) {
    await raiseException(
      tx,
      {
        dedupKey: `currency:${p.id}`,
        kind: 'CURRENCY_MISMATCH',
        severity: 'HIGH',
        rail: p.rail,
        paymentId: p.id,
        walletId: p.wallet_id,
        providerRef: c.providerRef,
        detail: `confirmed in ${c.amount.ccy}, requested ${p.currency}; not credited`,
      },
      ctx.now,
    );
    return 'CURRENCY_MISMATCH';
  }

  const gross = parseMinor(p.gross_minor);
  const disclosedFee = parseMinor(p.fee_minor);
  const confirmed = c.amount.minor;
  // Never credit more than was asked for; never less than was confirmed.
  const creditedGross = confirmed < gross ? confirmed : gross;
  const fee = creditedGross === gross ? disclosedFee : (disclosedFee * creditedGross) / gross;
  const net = creditedGross - fee;
  const ccy = p.currency;

  const clearing = await ensureSystemAccount(tx, 'PROVIDER_CLEARING', ccy, p.rail);
  const refs = { txnRef: `payment:${p.id}`, providerRef: c.providerRef };
  const entries: EntryInput[] = [
    { accountId: clearing.id, side: 'D', amount: money(creditedGross, ccy), ...refs },
    { accountId: p.credit_account_id, side: 'C', amount: money(net, ccy), ...refs },
  ];
  if (fee > 0n) {
    const fees = await ensureSystemAccount(tx, 'FEES', ccy);
    entries.push({ accountId: fees.id, side: 'C', amount: money(fee, ccy), ...refs });
  }
  const credit = await post(tx, ctx.actor, { idempotencyKey: `payment:${p.id}:credit`, kind: 'CONTRIBUTION', entries });

  if (confirmed > gross) {
    // Over-payment: real money we must not credit or lose. Park it in suspense.
    const suspense = await ensureSystemAccount(tx, 'SUSPENSE_UNMATCHED', ccy);
    const excess = money(confirmed - gross, ccy);
    const j = await post(tx, ctx.actor, {
      idempotencyKey: `payment:${p.id}:excess`,
      kind: 'SUSPENSE',
      entries: [
        { accountId: clearing.id, side: 'D', amount: excess, ...refs },
        { accountId: suspense.id, side: 'C', amount: excess, ...refs },
      ],
    });
    await raiseException(
      tx,
      {
        dedupKey: `variance:${p.id}:confirm`,
        kind: 'AMOUNT_VARIANCE',
        severity: 'MEDIUM',
        rail: p.rail,
        paymentId: p.id,
        walletId: p.wallet_id,
        providerRef: c.providerRef,
        currency: ccy,
        varianceMinor: confirmed - gross,
        journalId: j.journalId,
        detail: 'provider confirmed more than requested; excess held in suspense',
      },
      ctx.now,
    );
  } else if (confirmed < gross) {
    await raiseException(
      tx,
      {
        dedupKey: `variance:${p.id}:confirm`,
        kind: 'AMOUNT_VARIANCE',
        severity: 'MEDIUM',
        rail: p.rail,
        paymentId: p.id,
        walletId: p.wallet_id,
        providerRef: c.providerRef,
        currency: ccy,
        varianceMinor: confirmed - gross,
        detail: 'provider confirmed less than requested; only the confirmed amount was credited',
      },
      ctx.now,
    );
  }
  if (c.fee !== undefined && (c.fee.ccy !== ccy || c.fee.minor !== fee)) {
    await raiseException(
      tx,
      {
        dedupKey: `fee-variance:${p.id}:confirm`,
        kind: 'FEE_VARIANCE',
        severity: 'MEDIUM',
        rail: p.rail,
        paymentId: p.id,
        walletId: p.wallet_id,
        providerRef: c.providerRef,
        currency: ccy,
        varianceMinor: c.fee.minor - fee,
        detail: 'provider fee differs from the fee disclosed to the payer',
      },
      ctx.now,
    );
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO receipt (receipt_no, payment_id, payer_person_id, wallet_id, rail, currency, gross_minor, fee_minor, net_minor, provider_ref, issued_at)
     VALUES ('CW-' || lpad(nextval('receipt_no_seq')::text, 8, '0'), $1, $2::uuid, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint, $9, $10)
     RETURNING id`,
    [p.id, p.payer_person_id, p.wallet_id, p.rail, ccy, creditedGross.toString(), fee.toString(), net.toString(), c.providerRef, ctx.now.toISOString()],
  );
  const receiptId = rows[0]?.id;
  if (!receiptId) throw new Error('receipt not written');

  await transition(
    tx,
    p,
    'SUCCEEDED',
    c.source,
    ctx.now,
    {
      provider_ref: p.provider_ref ?? c.providerRef,
      confirmed_minor: confirmed.toString(),
      provider_fee_minor: c.fee?.minor.toString() ?? null,
      credited_gross_minor: creditedGross.toString(),
      credit_journal_id: credit.journalId,
      receipt_id: receiptId,
      next_poll_at: null,
      next_action: null,
    },
    { ...(c.eventId ? { eventId: c.eventId } : {}) },
  );
  // Delivery runs after commit and can fail without touching the payment.
  await enqueueOutbox(tx, 'receipt.notify', { receiptId });
  return 'CREDITED';
}

/** Provider says FAILED / EXPIRED. Open payments only; a credited payment is never un-credited this way. */
export async function applyFailure(
  tx: CommandTx,
  now: Date,
  p: PaymentRow,
  to: 'FAILED' | 'EXPIRED',
  reason: string,
  source: StateSource,
  eventId?: string,
): Promise<'APPLIED' | 'ALREADY_FINAL'> {
  if (!OPEN_STATES.has(p.state)) return 'ALREADY_FINAL';
  await transition(tx, p, to, source, now, { failure_reason: reason.slice(0, 200), next_poll_at: null, next_action: null }, {
    ...(eventId ? { eventId } : {}),
    detail: reason.slice(0, 200),
  });
  return 'APPLIED';
}

