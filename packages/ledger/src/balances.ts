// Balance buckets per sub-ledger (docs/04 §2), derived on every read from
// entries + reservations + holds. Nothing here is stored, so it cannot drift.
//
//   settled   = credits − debits posted to the account
//   reserved  = active reservations (payouts in flight)
//   held      = everything not reserved while a WALLET/SOURCE hold applies,
//               otherwise the active TXN holds, capped at what is left. A TXN
//               hold on a journal that has been reversed no longer counts:
//               the money it protected left with the reversal.
//   available = settled − reserved − held          (never negative)
//   paid      = net debits of PAYOUT journals
//   pending   = incoming payments not yet confirmed. Never in the ledger and
//               never spendable; supplied by the caller (payments, P03).
//
// The family-facing "one wallet" total is a view over these rows (P05/P06);
// the sub-ledgers themselves are never merged.
import { money, parseMinor, type Currency, type Money, type Queryable } from '@chema/shared';
import { accountCode, isUuid } from './accounts';
import { LedgerInvariantError } from './errors';
import type { JournalKind, LedgerAccount, Side, WalletAccountKind } from './types';

export interface SubLedgerBalance {
  account: LedgerAccount;
  /** e.g. `W:COMMUNITY`. */
  code: string;
  settled: Money;
  pending: Money;
  reserved: Money;
  held: Money;
  available: Money;
  paid: Money;
  /** TXN holds that the remaining balance no longer covers (funds already left). */
  uncoveredHold: Money;
}

/** Pending incoming amount per ledger account id (minor units). */
export type PendingSource = (q: Queryable, walletId: string) => Promise<ReadonlyMap<string, bigint>>;

interface BalanceRow {
  id: string;
  wallet_id: string;
  kind: WalletAccountKind;
  qualifier: string | null;
  currency: Currency;
  settled: string;
  paid: string;
  reserved: string;
  txn_held: string;
  frozen: boolean;
}

// One statement ⇒ one snapshot: the buckets of a wallet are mutually consistent.
const BALANCES_SQL = `
SELECT a.id, a.wallet_id, a.kind, a.qualifier, a.currency,
       COALESCE((SELECT sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END)
                   FROM ledger_entry e WHERE e.account_id = a.id), 0)::text AS settled,
       COALESCE((SELECT sum(CASE e.side WHEN 'D' THEN e.amount_minor ELSE -e.amount_minor END)
                   FROM ledger_entry e JOIN ledger_journal j ON j.id = e.journal_id
                  WHERE e.account_id = a.id AND j.kind = 'PAYOUT'), 0)::text AS paid,
       COALESCE((SELECT sum(r.amount_minor) FROM ledger_reservation r
                  WHERE r.account_id = a.id AND r.released_at IS NULL AND r.consumed_at IS NULL), 0)::text AS reserved,
       COALESCE((SELECT sum(h.amount_minor) FROM hold h
                  WHERE h.account_id = a.id AND h.scope = 'TXN' AND h.released_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM ledger_journal rj WHERE rj.reverses_journal_id = h.journal_id)
               ), 0)::text AS txn_held,
       EXISTS (SELECT 1 FROM hold h
                WHERE h.wallet_id = a.wallet_id AND h.released_at IS NULL
                  AND (h.scope = 'WALLET'
                       OR (h.scope = 'SOURCE' AND h.source_kind = a.kind
                           AND h.source_qualifier IS NOT DISTINCT FROM a.qualifier))) AS frozen
  FROM ledger_account a
 WHERE a.wallet_id = $1
 ORDER BY a.kind, a.qualifier NULLS FIRST, a.currency`;

/** Buckets for every sub-ledger of a wallet. Unknown wallet ⇒ empty list. */
export async function getBalances(
  q: Queryable,
  walletId: string,
  opts: { pending?: PendingSource } = {},
): Promise<SubLedgerBalance[]> {
  if (!isUuid(walletId)) return [];
  const { rows } = await q.query<BalanceRow>(BALANCES_SQL, [walletId]);
  const pending = opts.pending ? await opts.pending(q, walletId) : new Map<string, bigint>();

  return rows.map((r) => {
    const settled = parseMinor(r.settled);
    const reserved = parseMinor(r.reserved);
    const txnHeld = parseMinor(r.txn_held);
    const spendable = settled - reserved;
    if (spendable < 0n) {
      throw new LedgerInvariantError(`account ${r.id} has reservations beyond its balance`);
    }
    const held = r.frozen || txnHeld > spendable ? spendable : txnHeld;
    const account: LedgerAccount = {
      id: r.id,
      walletId: r.wallet_id,
      kind: r.kind,
      qualifier: r.qualifier,
      currency: r.currency,
    };
    const m = (minor: bigint): Money => money(minor, r.currency);
    return {
      account,
      code: accountCode(account),
      settled: m(settled),
      pending: m(pending.get(r.id) ?? 0n),
      reserved: m(reserved),
      held: m(held),
      available: m(spendable - held),
      paid: m(parseMinor(r.paid)),
      uncoveredHold: m(r.frozen ? 0n : txnHeld - held),
    };
  });
}

export interface StatementEntry {
  lineNo: number;
  accountId: string;
  side: Side;
  amount: Money;
  txnRef: string | null;
  providerRef: string | null;
}

export interface StatementJournal {
  journalId: string;
  seq: bigint;
  kind: JournalKind;
  reversesJournalId: string | null;
  reason: string | null;
  actorId: string;
  actorRole: string;
  approvalRef: string | null;
  createdAt: Date;
  entries: StatementEntry[];
}

interface StatementRow {
  journal_id: string;
  seq: string;
  kind: JournalKind;
  reverses_journal_id: string | null;
  reason: string | null;
  actor_id: string;
  actor_role: string;
  approval_ref: string | null;
  created_at: Date;
  line_no: number;
  account_id: string;
  side: Side;
  amount_minor: string;
  currency: Currency;
  txn_ref: string | null;
  provider_ref: string | null;
}

/**
 * Every journal that touched the wallet, oldest first, with all its entries
 * (system legs included). Replaying it reproduces the settled balances.
 */
export async function getStatement(q: Queryable, walletId: string): Promise<StatementJournal[]> {
  if (!isUuid(walletId)) return [];
  const { rows } = await q.query<StatementRow>(
    `SELECT j.id AS journal_id, j.seq::text AS seq, j.kind, j.reverses_journal_id, j.reason,
            j.actor_id, j.actor_role, j.approval_ref, j.created_at,
            e.line_no, e.account_id, e.side, e.amount_minor::text AS amount_minor, e.currency,
            e.txn_ref, e.provider_ref
       FROM ledger_journal j
       JOIN ledger_entry e ON e.journal_id = j.id
      WHERE j.wallet_id = $1
      ORDER BY j.seq, e.line_no`,
    [walletId],
  );
  const out: StatementJournal[] = [];
  let current: StatementJournal | undefined;
  for (const r of rows) {
    if (!current || current.journalId !== r.journal_id) {
      current = {
        journalId: r.journal_id,
        seq: BigInt(r.seq),
        kind: r.kind,
        reversesJournalId: r.reverses_journal_id,
        reason: r.reason,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        approvalRef: r.approval_ref,
        createdAt: new Date(r.created_at),
        entries: [],
      };
      out.push(current);
    }
    current.entries.push({
      lineNo: r.line_no,
      accountId: r.account_id,
      side: r.side,
      amount: money(parseMinor(r.amount_minor), r.currency),
      txnRef: r.txn_ref,
      providerRef: r.provider_ref,
    });
  }
  return out;
}
