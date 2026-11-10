// Reservations: funds set aside for one payout request (docs/04 §2,
// "reserved(pending payouts)"). A reservation lowers `available` at once, so
// two requests can never spend the same money; it ends by being released
// (request rejected / failed) or consumed by the PAYOUT journal that pays it.
import { canonicalJson, sha256Hex, type Actor, type CommandTx } from '@chema/core';
import type { Money } from '@chema/shared';
import { getAccount, isUuid, lockWallet } from './accounts';
import { getBalances } from './balances';
import {
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerError,
  LedgerValidationError,
  ReservationStateError,
  UnknownAccountError,
} from './errors';

export interface ReserveInput {
  /** The wallet sub-ledger account to reserve from. */
  accountId: string;
  amount: Money;
  /** What the money is reserved for, e.g. `{ type: 'payout_request', id }`. */
  ref: { type: string; id: string };
  idempotencyKey: string;
}

export interface ReserveResult {
  reservationId: string;
  /** True when the key had already been used: nothing was reserved this time. */
  replayed: boolean;
}

/** Reserve `amount` from a wallet sub-ledger. Fails unless it is available now. */
export async function reserve(tx: CommandTx, actor: Actor, input: ReserveInput): Promise<ReserveResult> {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) throw new LedgerValidationError('BAD_IDEMPOTENCY_KEY');
  if (typeof input.amount.minor !== 'bigint' || input.amount.minor <= 0n) throw new LedgerValidationError('AMOUNT_NOT_POSITIVE');
  if (!input.ref.type || !input.ref.id) throw new LedgerValidationError('BAD_REF');

  const account = await getAccount(tx, input.accountId);
  if (account.walletId === null) throw new UnknownAccountError(input.accountId);
  if (account.currency !== input.amount.ccy) throw new LedgerValidationError('CURRENCY_MISMATCH', account.currency);

  const hash = sha256Hex(
    canonicalJson({ account: account.id, minor: input.amount.minor, ccy: input.amount.ccy, ref: input.ref }),
  );

  await lockWallet(tx, account.walletId);

  const { rows: prior } = await tx.query<{ id: string; payload_hash: string }>(
    'SELECT id, payload_hash FROM ledger_reservation WHERE idempotency_key = $1',
    [key],
  );
  const existing = prior[0];
  if (existing) {
    if (existing.payload_hash !== hash) throw new IdempotencyConflictError(key);
    return { reservationId: existing.id, replayed: true };
  }

  const balances = await getBalances(tx, account.walletId);
  const available = balances.find((b) => b.account.id === account.id)?.available.minor ?? 0n;
  if (input.amount.minor > available) throw new InsufficientFundsError(account.id, input.amount.minor, available);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ledger_reservation
       (wallet_id, account_id, currency, amount_minor, ref_type, ref_id, idempotency_key, payload_hash, created_by)
     VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9) RETURNING id`,
    [
      account.walletId,
      account.id,
      account.currency,
      input.amount.minor.toString(),
      input.ref.type,
      input.ref.id,
      key,
      hash,
      actor.personId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new LedgerError('RESERVATION_NOT_WRITTEN', 'reservation could not be written');
  return { reservationId: id, replayed: false };
}

/**
 * Give reserved funds back to `available`. Releasing twice is a no-op
 * (returns false); a consumed reservation cannot be released.
 */
export async function release(tx: CommandTx, actor: Actor, reservationId: string, reason: string): Promise<boolean> {
  if (!isUuid(reservationId)) throw new ReservationStateError(String(reservationId), 'NOT_FOUND');
  if (!reason.trim()) throw new LedgerValidationError('REASON_REQUIRED');
  const { rows } = await tx.query<{ released_at: Date | null; consumed_at: Date | null }>(
    'SELECT released_at, consumed_at FROM ledger_reservation WHERE id = $1 FOR UPDATE',
    [reservationId],
  );
  const r = rows[0];
  if (!r) throw new ReservationStateError(reservationId, 'NOT_FOUND');
  if (r.consumed_at) throw new ReservationStateError(reservationId, 'CONSUMED');
  if (r.released_at) return false;
  await tx.query(
    `UPDATE ledger_reservation
        SET released_at = now(), released_by = $2, release_reason = $3, updated_at = now()
      WHERE id = $1`,
    [reservationId, actor.personId, reason.trim()],
  );
  return true;
}
