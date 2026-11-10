// Posting and reversing journals (docs/04 §1).
//
// Callers are command handlers: they pass the CommandTx the bus gave them, so
// authorisation and the audit row are the bus's job and the journal lands in
// the same transaction. The ledger itself decides only whether the books
// allow the movement.
//
// Order inside a post: validate (pure) → lock the wallet if it loses value →
// replay check → funds check → write. Every typed error is thrown before the
// first write.
import { actorRoleLabel, canonicalJson, sha256Hex, type Actor, type CommandTx } from '@chema/core';
import { money, parseMinor, type Currency, type Queryable } from '@chema/shared';
import { getAccounts, isUuid, lockWallet } from './accounts';
import { getBalances } from './balances';
import {
  AlreadyReversedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerError,
  LedgerValidationError,
  ReservationStateError,
  UnknownJournalError,
} from './errors';
import { validateBenefitRules, validateJournal } from './guards';
import { JOURNAL_KINDS, type EntryInput, type JournalInput, type JournalKind, type PostResult, type Side } from './types';

const REVERSAL_KEY_PREFIX = 'reverse:';

function journalHash(input: JournalInput, reversesJournalId: string | null): string {
  return sha256Hex(
    canonicalJson({
      kind: input.kind,
      reverses: reversesJournalId,
      reason: input.reason?.trim() || null,
      approvalRef: input.approvalRef ?? null,
      reservationId: input.reservationId ?? null,
      entries: input.entries.map((e) => ({
        account: e.accountId,
        side: e.side,
        minor: e.amount.minor,
        ccy: e.amount.ccy,
        txnRef: e.txnRef ?? null,
        providerRef: e.providerRef ?? null,
      })),
    }),
  );
}

async function findByKey(q: Queryable, key: string): Promise<{ id: string; payload_hash: string } | undefined> {
  const { rows } = await q.query<{ id: string; payload_hash: string }>(
    'SELECT id, payload_hash FROM ledger_journal WHERE idempotency_key = $1',
    [key],
  );
  return rows[0];
}

function replay(existing: { id: string; payload_hash: string }, hash: string, key: string): PostResult {
  if (existing.payload_hash !== hash) throw new IdempotencyConflictError(key);
  return { journalId: existing.id, replayed: true };
}

/** The reservation a payout pays: locked, active, same account and amount. */
async function checkReservation(tx: Queryable, reservationId: string, accountId: string, debit: bigint): Promise<void> {
  if (!isUuid(reservationId)) throw new ReservationStateError(String(reservationId), 'NOT_FOUND');
  const { rows } = await tx.query<{
    account_id: string;
    amount_minor: string;
    released_at: Date | null;
    consumed_at: Date | null;
  }>(
    `SELECT account_id, amount_minor::text AS amount_minor, released_at, consumed_at
       FROM ledger_reservation WHERE id = $1 FOR UPDATE`,
    [reservationId],
  );
  const r = rows[0];
  if (!r) throw new ReservationStateError(reservationId, 'NOT_FOUND');
  if (r.released_at) throw new ReservationStateError(reservationId, 'RELEASED');
  if (r.consumed_at) throw new ReservationStateError(reservationId, 'CONSUMED');
  if (r.account_id !== accountId || parseMinor(r.amount_minor) !== debit) {
    throw new ReservationStateError(reservationId, 'MISMATCH');
  }
}

/** Active TXN holds on one journal's credit to one account (minor units). */
async function txnHeldFor(tx: Queryable, journalId: string, accountId: string): Promise<bigint> {
  const { rows } = await tx.query<{ held: string }>(
    `SELECT COALESCE(sum(amount_minor), 0)::text AS held FROM hold
      WHERE scope = 'TXN' AND released_at IS NULL AND journal_id = $1 AND account_id = $2`,
    [journalId, accountId],
  );
  return parseMinor(rows[0]?.held ?? '0');
}

async function write(
  tx: CommandTx,
  actor: Actor,
  input: JournalInput,
  reversesJournalId: string | null,
): Promise<PostResult> {
  const reversal = reversesJournalId !== null;
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) throw new LedgerValidationError('BAD_IDEMPOTENCY_KEY');
  if (!(JOURNAL_KINDS as readonly string[]).includes(input.kind)) throw new LedgerValidationError('BAD_KIND');
  const reason = input.reason?.trim();
  if ((reversal || input.kind === 'ADJUSTMENT') && !reason) throw new LedgerValidationError('REASON_REQUIRED');

  const isPayout = input.kind === 'PAYOUT' && !reversal;
  if (isPayout && input.reservationId === undefined) throw new LedgerValidationError('PAYOUT_NEEDS_RESERVATION');
  if (!isPayout && input.reservationId !== undefined) throw new LedgerValidationError('RESERVATION_ONLY_FOR_PAYOUT');

  const accounts = await getAccounts(
    tx,
    input.entries.map((e) => e.accountId),
  );
  const shape = validateJournal(input.entries, accounts, { reversal });
  validateBenefitRules(input.kind, input.entries, accounts, { reversal });
  const hash = journalHash(input, reversesJournalId);
  const debits = [...shape.walletDebits];
  if (isPayout && debits.length !== 1) throw new LedgerValidationError('PAYOUT_DEBITS_ONE_ACCOUNT');

  // Lock first: whatever is read below must still be true when we write.
  if (shape.walletId !== null && debits.length > 0) await lockWallet(tx, shape.walletId);

  const existing = await findByKey(tx, key);
  if (existing) return replay(existing, hash, key);

  if (shape.walletId !== null && debits.length > 0) {
    if (isPayout) {
      const [accountId, debit] = debits[0] as [string, bigint];
      await checkReservation(tx, input.reservationId as string, accountId, debit);
    } else {
      const balances = await getBalances(tx, shape.walletId);
      for (const [accountId, debit] of debits) {
        const b = balances.find((x) => x.account.id === accountId);
        let spendable = b?.available.minor ?? 0n;
        // Reversing a held transaction may use the money held for it: that
        // is what a TXN hold protects (refund / chargeback of that payment).
        if (reversesJournalId !== null && b) {
          const ownHold = await txnHeldFor(tx, reversesJournalId, accountId);
          spendable += ownHold < b.held.minor ? ownHold : b.held.minor;
        }
        if (debit > spendable) throw new InsufficientFundsError(accountId, debit, spendable);
      }
    }
  }

  const header = await tx.query<{ id: string }>(
    `INSERT INTO ledger_journal
       (idempotency_key, payload_hash, kind, wallet_id, reverses_journal_id, reason, actor_id, actor_role, approval_ref)
     VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      key,
      hash,
      input.kind,
      shape.walletId,
      reversesJournalId,
      reason ?? null,
      actor.personId,
      actorRoleLabel(actor),
      input.approvalRef ?? null,
    ],
  );
  const journalId = header.rows[0]?.id;
  if (journalId === undefined) {
    // A concurrent transaction committed this key (or this reversal) first.
    const winner = await findByKey(tx, key);
    if (winner) return replay(winner, hash, key);
    if (reversal) throw new AlreadyReversedError(reversesJournalId);
    throw new LedgerError('JOURNAL_NOT_WRITTEN', 'journal could not be written');
  }

  if (isPayout) {
    await tx.query(
      `UPDATE ledger_reservation SET consumed_at = now(), consumed_journal_id = $2, updated_at = now()
        WHERE id = $1 AND released_at IS NULL AND consumed_at IS NULL`,
      [input.reservationId, journalId],
    );
  }

  // One statement for all entries: the database checks the journal as a whole.
  const COLS = 8;
  const values: string[] = [];
  const params: unknown[] = [];
  input.entries.forEach((e, i) => {
    const p = i * COLS;
    values.push(
      `($${p + 1}::uuid, $${p + 2}::int, $${p + 3}::uuid, $${p + 4}, $${p + 5}, $${p + 6}::bigint, $${p + 7}, $${p + 8})`,
    );
    params.push(
      journalId,
      i + 1,
      e.accountId,
      e.amount.ccy,
      e.side,
      e.amount.minor.toString(),
      e.txnRef ?? null,
      e.providerRef ?? null,
    );
  });
  await tx.query(
    `INSERT INTO ledger_entry (journal_id, line_no, account_id, currency, side, amount_minor, txn_ref, provider_ref)
     VALUES ${values.join(', ')}`,
    params,
  );
  return { journalId, replayed: false };
}

/**
 * Post one balanced journal. Idempotent on `idempotencyKey`.
 *
 * - touches at most one wallet sub-ledger (no cross-wallet, no mixing of
 *   community / benefit / group money);
 * - value leaving a wallet may only go to FEES, REFUND_CLEARING or PAYOUT_CLEARING;
 * - a wallet debit must fit the available balance; a PAYOUT must pay exactly
 *   one active reservation, which it consumes.
 */
export async function post(tx: CommandTx, actor: Actor, input: JournalInput): Promise<PostResult> {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.startsWith(REVERSAL_KEY_PREFIX)) {
    throw new LedgerValidationError('RESERVED_IDEMPOTENCY_KEY');
  }
  return write(tx, actor, input, null);
}

interface OriginalEntryRow {
  account_id: string;
  side: Side;
  amount_minor: string;
  currency: Currency;
  txn_ref: string | null;
  provider_ref: string | null;
}

/**
 * Undo a journal with a linked, exactly mirrored journal (never an edit).
 * A journal can be reversed once; asking again with the same reason returns
 * the existing reversal. A reversal that takes money back out of a wallet
 * needs that money to be available.
 */
export async function reverse(
  tx: CommandTx,
  actor: Actor,
  journalId: string,
  reason: string,
  opts: { approvalRef?: string } = {},
): Promise<PostResult> {
  if (!isUuid(journalId)) throw new UnknownJournalError(String(journalId));
  const { rows: found } = await tx.query<{ kind: JournalKind; reverses_journal_id: string | null }>(
    'SELECT kind, reverses_journal_id FROM ledger_journal WHERE id = $1',
    [journalId],
  );
  const original = found[0];
  if (!original) throw new UnknownJournalError(journalId);
  if (original.reverses_journal_id !== null) throw new LedgerValidationError('CANNOT_REVERSE_A_REVERSAL');

  const { rows } = await tx.query<OriginalEntryRow>(
    `SELECT account_id, side, amount_minor::text AS amount_minor, currency, txn_ref, provider_ref
       FROM ledger_entry WHERE journal_id = $1 ORDER BY line_no`,
    [journalId],
  );
  const entries: EntryInput[] = rows.map((r) => ({
    accountId: r.account_id,
    side: r.side === 'D' ? 'C' : 'D',
    amount: money(parseMinor(r.amount_minor), r.currency),
    ...(r.txn_ref !== null ? { txnRef: r.txn_ref } : {}),
    ...(r.provider_ref !== null ? { providerRef: r.provider_ref } : {}),
  }));

  try {
    return await write(
      tx,
      actor,
      {
        idempotencyKey: `${REVERSAL_KEY_PREFIX}${journalId}`,
        kind: original.kind,
        entries,
        reason,
        ...(opts.approvalRef !== undefined ? { approvalRef: opts.approvalRef } : {}),
      },
      journalId,
    );
  } catch (err) {
    if (err instanceof IdempotencyConflictError) throw new AlreadyReversedError(journalId);
    throw err;
  }
}
