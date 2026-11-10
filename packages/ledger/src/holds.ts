// Holds: restrict spending without moving money (the `held` bucket, docs/04 §2).
//   TXN    – an amount of one journal's credit to one account (proportionate)
//   SOURCE – one whole sub-ledger of the wallet (community ≠ Fidelity benefit)
//   WALLET – every sub-ledger of the wallet
// Placing a hold always succeeds, even if the money has already left: the
// shortfall shows up as `uncoveredHold` in the balances. Holds block new
// reservations and wallet debits; who may place or release one, and what
// happens to payouts already in flight, is decided by the caller (P07).
import type { Actor, CommandTx } from '@chema/core';
import { parseMinor, type Currency, type Money } from '@chema/shared';
import { isUuid, lockWallet } from './accounts';
import { LedgerError, LedgerValidationError, UnknownAccountError, UnknownHoldError, UnknownJournalError } from './errors';
import { WALLET_ACCOUNT_KINDS, type WalletAccountKind } from './types';

interface HoldCommon {
  walletId: string;
  reasonCode: string;
  /** Person responsible for reviewing the hold. */
  ownerId: string;
  /** When the hold must be looked at again: no open-ended freezes. */
  reviewAt: Date;
}

export type HoldInput =
  | (HoldCommon & { scope: 'WALLET' })
  | (HoldCommon & { scope: 'SOURCE'; source: { kind: WalletAccountKind; groupId?: string } })
  | (HoldCommon & {
      scope: 'TXN';
      journalId: string;
      /** Needed only if the journal credited more than one account of the wallet. */
      accountId?: string;
      /** Defaults to everything the journal credited to the account. */
      amount?: Money;
    });

interface Target {
  sourceKind: WalletAccountKind | null;
  sourceQualifier: string | null;
  accountId: string | null;
  currency: Currency | null;
  journalId: string | null;
  amountMinor: bigint | null;
}

const NO_TARGET: Target = {
  sourceKind: null,
  sourceQualifier: null,
  accountId: null,
  currency: null,
  journalId: null,
  amountMinor: null,
};

async function txnTarget(tx: CommandTx, input: Extract<HoldInput, { scope: 'TXN' }>): Promise<Target> {
  if (!isUuid(input.journalId)) throw new UnknownJournalError(String(input.journalId));
  const { rows } = await tx.query<{ account_id: string; currency: Currency; credited: string }>(
    `SELECT e.account_id, a.currency,
            sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END)::text AS credited
       FROM ledger_entry e
       JOIN ledger_account a ON a.id = e.account_id
      WHERE e.journal_id = $1 AND a.wallet_id = $2
      GROUP BY e.account_id, a.currency
     HAVING sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END) > 0`,
    [input.journalId, input.walletId],
  );
  if (rows.length === 0) throw new UnknownJournalError(input.journalId);
  const row = input.accountId === undefined ? (rows.length === 1 ? rows[0] : undefined) : rows.find((r) => r.account_id === input.accountId);
  if (!row) {
    if (input.accountId === undefined) throw new LedgerValidationError('ACCOUNT_REQUIRED');
    throw new UnknownAccountError(input.accountId);
  }
  const credited = parseMinor(row.credited);
  if (input.amount !== undefined) {
    if (input.amount.ccy !== row.currency) throw new LedgerValidationError('CURRENCY_MISMATCH', row.currency);
    if (input.amount.minor <= 0n) throw new LedgerValidationError('AMOUNT_NOT_POSITIVE');
    if (input.amount.minor > credited) throw new LedgerValidationError('HOLD_EXCEEDS_TXN');
  }
  return {
    ...NO_TARGET,
    accountId: row.account_id,
    currency: row.currency,
    journalId: input.journalId,
    amountMinor: input.amount?.minor ?? credited,
  };
}

/** Place a hold. Returns its id. */
export async function placeHold(tx: CommandTx, actor: Actor, input: HoldInput): Promise<string> {
  if (!input.reasonCode.trim()) throw new LedgerValidationError('REASON_REQUIRED');
  if (!input.ownerId.trim()) throw new LedgerValidationError('OWNER_REQUIRED');
  if (!(input.reviewAt instanceof Date) || Number.isNaN(input.reviewAt.getTime())) {
    throw new LedgerValidationError('REVIEW_DATE_REQUIRED');
  }

  // Serialise with reservations and debits: afterwards either they saw this
  // hold, or this hold was placed knowing about them.
  await lockWallet(tx, input.walletId);

  let target = NO_TARGET;
  if (input.scope === 'SOURCE') {
    const { kind, groupId } = input.source;
    if (!(WALLET_ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new LedgerValidationError('BAD_ACCOUNT_KIND');
    if ((kind === 'GROUP') !== (groupId !== undefined)) throw new LedgerValidationError('BAD_GROUP_ID');
    target = { ...NO_TARGET, sourceKind: kind, sourceQualifier: groupId ?? null };
  } else if (input.scope === 'TXN') {
    target = await txnTarget(tx, input);
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO hold
       (wallet_id, scope, source_kind, source_qualifier, account_id, currency, journal_id, amount_minor,
        reason_code, owner_id, review_at, placed_by)
     VALUES ($1, $2, $3, $4, $5::uuid, $6, $7::uuid, $8::bigint, $9, $10, $11::timestamptz, $12)
     RETURNING id`,
    [
      input.walletId,
      input.scope,
      target.sourceKind,
      target.sourceQualifier,
      target.accountId,
      target.currency,
      target.journalId,
      target.amountMinor === null ? null : target.amountMinor.toString(),
      input.reasonCode.trim(),
      input.ownerId.trim(),
      input.reviewAt.toISOString(),
      actor.personId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new LedgerError('HOLD_NOT_WRITTEN', 'hold could not be written');
  return id;
}

/** Release a hold. Releasing twice is a no-op (returns false). */
export async function releaseHold(tx: CommandTx, actor: Actor, holdId: string, reason: string): Promise<boolean> {
  if (!isUuid(holdId)) throw new UnknownHoldError(String(holdId));
  if (!reason.trim()) throw new LedgerValidationError('REASON_REQUIRED');
  const { rows } = await tx.query<{ released_at: Date | null }>(
    'SELECT released_at FROM hold WHERE id = $1 FOR UPDATE',
    [holdId],
  );
  const h = rows[0];
  if (!h) throw new UnknownHoldError(holdId);
  if (h.released_at) return false;
  await tx.query(
    `UPDATE hold SET released_at = now(), released_by = $2, release_reason = $3, updated_at = now() WHERE id = $1`,
    [holdId, actor.personId, reason.trim()],
  );
  return true;
}
