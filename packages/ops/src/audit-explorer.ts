// P09 audit explorer (docs/12, docs/14 "audit reconstruction of a wallet").
// Rebuilds a wallet's history from two independent records, the hash-chained
// audit log and the append-only ledger, and cross-checks them:
//   1. every ledger journal on the wallet is EXPLAINED by an ALLOWED audit row
//      (same txn ref, same approval, or the journal itself as the subject);
//   2. replaying the journal entries reproduces the ledger's settled balances;
//   3. the audit hash chain verifies end to end.
// A journal written straight into the database (no command, no audit) shows
// up as unexplained.
import { verifyChain, type ChainReport, type Command } from '@chema/core';
import { accountCode, getBalances, getStatement, listWalletAccounts } from '@chema/ledger';
import type { Queryable } from '@chema/shared';
import { walletExists } from './util';

/** Tables whose rows belong to one wallet, and the column that says which. */
const WALLET_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['verification_case', 'wallet_id'],
  ['verification_evidence', 'wallet_id'],
  ['fraud_flag', 'wallet_id'],
  ['wallet_report', 'wallet_id'],
  ['payment', 'wallet_id'],
  ['contribution', 'wallet_id'],
  ['tribute', 'wallet_id'],
  ['receipt', 'wallet_id'],
  ['payee', 'wallet_id'],
  ['payout_plan', 'wallet_id'],
  ['payout_request', 'wallet_id'],
  ['case_record', 'wallet_id'],
  ['hold', 'wallet_id'],
  ['approval', 'wallet_id'],
  ['mandate', 'wallet_id'],
  ['mandate_change', 'wallet_id'],
  ['fidelity_link', 'wallet_id'],
  ['wallet_closure', 'wallet_id'],
  ['wallet_statement', 'wallet_id'],
  ['ledger_journal', 'wallet_id'],
  ['ledger_reservation', 'wallet_id'],
  ['consent_record', 'wallet_id'],
  ['document', 'linked_wallet'],
  ['staff_assignment', 'wallet_id'],
  ['recon_exception', 'wallet_id'],
];

export interface TimelineEvent {
  at: string;
  source: 'AUDIT' | 'LEDGER';
  seq: string;
  action: string;
  actorId: string;
  actorRole: string;
  channel: string | null;
  subjectType: string | null;
  subjectId: string | null;
  authz: string | null;
  reasonCode: string | null;
  approvalRef: string | null;
  txnRef: string | null;
  /** LEDGER rows: entries of the journal. */
  entries?: { account: string; side: string; minor: string; ccy: string; txnRef: string | null }[];
  /** LEDGER rows: the audit seq(s) that explain this journal. */
  explainedBy?: string[];
}

export interface Reconstruction {
  walletId: string;
  events: TimelineEvent[];
  checks: {
    journals: number;
    unexplainedJournals: string[];
    balancesReplayed: { account: string; currency: string; replayed: string; ledger: string; ok: boolean }[];
    balancesOk: boolean;
    chain: ChainReport;
  };
  ok: boolean;
}

interface AuditRow {
  seq: string;
  ts: string;
  actor_id: string;
  actor_role: string;
  channel: string;
  action: string;
  subject_type: string;
  subject_id: string;
  authz_result: string;
  reason_code: string | null;
  approval_ref: string | null;
  txn_ref: string | null;
}

async function relatedIds(q: Queryable, walletId: string): Promise<Set<string>> {
  const ids = new Set<string>([walletId]);
  for (const [table, col] of WALLET_TABLES) {
    const { rows } = await q.query<{ id: string }>(`SELECT id::text AS id FROM ${table} WHERE ${col} = $1`, [walletId]);
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

const refId = (ref: string | null) => (ref && ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : null);

export async function reconstructWallet(q: Queryable, walletId: string): Promise<Reconstruction> {
  const ids = await relatedIds(q, walletId);
  const statement = await getStatement(q, walletId);
  const txnRefs = new Set<string>();
  for (const j of statement) for (const e of j.entries) if (e.txnRef) txnRefs.add(e.txnRef);
  for (const id of ids) for (const p of ['payment', 'payout', 'journal']) txnRefs.add(`${p}:${id}`);

  const idList = [...ids];
  const refList = [...txnRefs];
  const { rows: audit } = await q.query<AuditRow>(
    `SELECT seq::text AS seq, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts, actor_id, actor_role, channel, action,
            subject_type, subject_id, authz_result, reason_code, approval_ref, txn_ref
       FROM audit_log
      WHERE subject_id = ANY($1::text[]) OR txn_ref = ANY($2::text[]) OR approval_ref = ANY($1::text[])
      ORDER BY audit_log.seq`,
    [idList, refList],
  );

  const events: TimelineEvent[] = audit.map((a) => ({
    at: a.ts,
    source: 'AUDIT',
    seq: a.seq,
    action: a.action,
    actorId: a.actor_id,
    actorRole: a.actor_role,
    channel: a.channel,
    subjectType: a.subject_type,
    subjectId: a.subject_id,
    authz: a.authz_result,
    reasonCode: a.reason_code,
    approvalRef: a.approval_ref,
    txnRef: a.txn_ref,
  }));

  const allowed = audit.filter((a) => a.authz_result === 'ALLOWED');
  const accounts = new Map((await listWalletAccounts(q, walletId)).map((a) => [a.id, a]));
  const unexplained: string[] = [];
  const replay = new Map<string, bigint>();
  for (const j of statement) {
    const refs = new Set(j.entries.map((e) => e.txnRef).filter((r): r is string => r !== null));
    const refIds = new Set([...refs].map(refId).filter((r): r is string => r !== null));
    const why = allowed.filter(
      (a) =>
        (a.txn_ref !== null && (refs.has(a.txn_ref) || a.txn_ref === `journal:${j.journalId}` || refIds.has(refId(a.txn_ref) ?? ''))) ||
        refIds.has(a.subject_id) ||
        a.subject_id === j.journalId ||
        (j.reversesJournalId !== null && a.subject_id === j.reversesJournalId) ||
        (j.approvalRef !== null && a.approval_ref === j.approvalRef),
    );
    if (why.length === 0) unexplained.push(j.journalId);
    events.push({
      at: j.createdAt.toISOString(),
      source: 'LEDGER',
      seq: j.seq.toString(),
      action: `ledger.${j.kind.toLowerCase()}${j.reversesJournalId ? '.reversal' : ''}`,
      actorId: j.actorId,
      actorRole: j.actorRole,
      channel: null,
      subjectType: 'ledger_journal',
      subjectId: j.journalId,
      authz: null,
      reasonCode: j.reason,
      approvalRef: j.approvalRef,
      txnRef: null,
      entries: j.entries.map((e) => {
        const acc = accounts.get(e.accountId);
        return { account: acc ? accountCode(acc) : e.accountId, side: e.side, minor: e.amount.minor.toString(), ccy: e.amount.ccy, txnRef: e.txnRef };
      }),
      explainedBy: why.map((a) => a.seq),
    });
    for (const e of j.entries) {
      if (!accounts.has(e.accountId)) continue;
      // Wallet sub-ledgers are liabilities: credits raise them.
      const signed = e.side === 'C' ? e.amount.minor : -e.amount.minor;
      replay.set(e.accountId, (replay.get(e.accountId) ?? 0n) + signed);
    }
  }

  const balances = await getBalances(q, walletId);
  const balancesReplayed = balances.map((b) => {
    // settled = everything credited minus everything debited, paid-out legs included.
    const r = replay.get(b.account.id) ?? 0n;
    const ledger = b.settled.minor;
    return { account: b.code, currency: b.account.currency, replayed: r.toString(), ledger: ledger.toString(), ok: r === ledger };
  });
  const balancesOk = balancesReplayed.every((b) => b.ok);
  const chain = await verifyChain(q);

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.source === b.source ? Number(BigInt(a.seq) - BigInt(b.seq)) : a.source === 'AUDIT' ? -1 : 1));
  return {
    walletId,
    events,
    checks: { journals: statement.length, unexplainedJournals: unexplained, balancesReplayed, balancesOk, chain },
    ok: unexplained.length === 0 && balancesOk && chain.ok,
  };
}

export const walletTimeline: Command<{ walletId: string }, Reconstruction> = {
  name: 'audit.wallet_timeline',
  async resolve(q, input) {
    const walletId = await walletExists(q, input.walletId);
    return { action: 'audit.explore', subject: { type: 'wallet', id: walletId, walletId } };
  },
  async run(tx, input) {
    const r = await reconstructWallet(tx, input.walletId);
    return { result: r, audit: { reasonCode: r.ok ? 'RECONSTRUCTED_OK' : 'RECONSTRUCTION_MISMATCH' } };
  },
};

export const verifyAuditChain: Command<Record<string, never>, ChainReport> = {
  name: 'audit.verify_chain',
  async resolve() {
    return { action: 'audit.verify', subject: { type: 'audit_log', id: 'chain' } };
  },
  async run(tx) {
    const r = await verifyChain(tx);
    return { result: r, audit: { reasonCode: r.ok ? `CHAIN_OK:${r.count}` : `CHAIN_BROKEN:${r.seq}` } };
  },
};
