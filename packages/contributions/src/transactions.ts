// Family statement: every money movement on a wallet, what it was and where it
// went (Transactions, 2026-11-25). A bus READ under `wallet.view_ledger` (admin,
// approver, assigned/oversight staff), audited, because it shows contributors'
// real names to the family (product decision: anonymity is public-only).
//
// Built from the ledger (`getStatement`), filtered to the wallet's own legs, so
// the running balances replay exactly to `getBalances().settled`. Each journal
// is labelled from its txn ref: `payment:<id>` (contribution / refund /
// chargeback), `payout:<id>`, `claim:<ref>` (Fidelity benefit), adjustments.
import { unseal, type Command } from '@chema/core';
import { accountCode, getBalances, getStatement, listWalletAccounts, type JournalKind, type LedgerAccount } from '@chema/ledger';
import { format, money, parseMinor, t, type Currency, type Money, type Queryable } from '@chema/shared';
import { loadWallet } from '@chema/wallet';
import type { ContributionKeys } from './keys';

export type TxSource = 'COMMUNITY' | 'GROUP' | 'FIDELITY_BENEFIT';

export interface TxContribution {
  contributionId: string;
  /** The payer's real name (KYC), or the group name for a group gift. */
  name: string;
  /** What the public page shows instead, if different. */
  publicName: string | null;
  anonymousPublicly: boolean;
  groupName: string | null;
  rail: string;
  receiptNo: string | null;
  hasMessage: boolean;
}

export interface TxPayout {
  payoutId: string;
  purpose: string;
  note: string | null;
  payeeLabel: string | null;
  payeeMasked: string | null;
  rail: string;
  providerRef: string | null;
  confirmedAt: string | null;
}

export interface TxLine {
  /** Journal id (one line per journal per wallet sub-ledger). */
  id: string;
  seq: string;
  at: string;
  kind: JournalKind;
  /** True when this journal reverses an earlier one (e.g. a payout returned by the provider). */
  reversal: boolean;
  reversesId: string | null;
  /** Set on a line that a later journal reversed. */
  reversedById: string | null;
  direction: 'IN' | 'OUT';
  source: TxSource;
  groupName: string | null;
  amount: Money;
  balanceAfter: Money;
  approvalRef: string | null;
  contribution: TxContribution | null;
  payout: TxPayout | null;
  /** Fidelity claim reference for a benefit credit. */
  claimRef: string | null;
  /** Staff reason on an adjustment. */
  note: string | null;
}

export interface TxPending {
  type: 'PAYOUT' | 'CONTRIBUTION';
  id: string;
  at: string;
  status: string;
  direction: 'IN' | 'OUT';
  source: TxSource;
  amount: Money;
  payout: TxPayout | null;
  contribution: TxContribution | null;
}

export interface TxSummary {
  source: TxSource;
  groupName: string | null;
  currency: Currency;
  moneyIn: Money;
  moneyOut: Money;
  balance: Money;
  pending: Money;
  available: Money;
  reserved: Money;
}

export interface WalletTransactions {
  walletId: string;
  summary: TxSummary[];
  pending: TxPending[];
  /** Newest first. */
  lines: TxLine[];
  nextCursor: string | null;
}

const WALLET_SOURCES: ReadonlySet<string> = new Set(['COMMUNITY', 'GROUP', 'FIDELITY_BENEFIT']);
const PENDING_PAYOUTS = ['AWAITING_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'RETRY', 'RAIL_DOWN', 'OVERRIDE_PENDING'];
const PENDING_PAYMENTS = ['INITIATED', 'PENDING_UNKNOWN'];

const refId = (ref: string | null, prefix: string) => (ref && ref.startsWith(`${prefix}:`) ? ref.slice(prefix.length + 1) : null);

interface ContributionJoin {
  payment_id: string;
  contribution_id: string;
  anonymous: boolean;
  display_name: string | null;
  kyc_sealed: string;
  group_name: string | null;
  rail: string;
  receipt_no: string | null;
  has_message: boolean;
}

interface PayoutJoin {
  id: string;
  purpose: string;
  purpose_note: string | null;
  payee_label: string | null;
  payee_masked: string | null;
  rail: string;
  provider_ref: string | null;
  confirmed_at: Date | null;
}

export function transactionCommands(keys: ContributionKeys) {
  function realName(kycSealed: string, contributionId: string): string | null {
    try {
      const kyc = JSON.parse(unseal(keys.data, Buffer.from(kycSealed, 'base64'), `contribution:kyc:${contributionId}`).toString('utf8')) as { name?: unknown };
      return typeof kyc.name === 'string' && kyc.name.trim() ? kyc.name.trim() : null;
    } catch {
      return null; // never surface a decryption problem as a name
    }
  }

  function toContribution(c: ContributionJoin): TxContribution {
    const real = realName(c.kyc_sealed, c.contribution_id);
    const shownPublicly = c.group_name ?? (c.anonymous || !c.display_name ? t('contribution.anonymous_name') : c.display_name);
    const name = c.group_name ? `${c.group_name}${real ? ` (${real})` : ''}` : real ?? c.display_name ?? t('contribution.anonymous_name');
    return {
      contributionId: c.contribution_id,
      name,
      publicName: shownPublicly === name ? null : shownPublicly,
      anonymousPublicly: c.anonymous,
      groupName: c.group_name,
      rail: c.rail,
      receiptNo: c.receipt_no,
      hasMessage: c.has_message,
    };
  }

  function toPayout(p: PayoutJoin): TxPayout {
    return {
      payoutId: p.id,
      purpose: p.purpose,
      note: p.purpose_note,
      payeeLabel: p.payee_label,
      payeeMasked: p.payee_masked,
      rail: p.rail,
      providerRef: p.provider_ref,
      confirmedAt: p.confirmed_at ? new Date(p.confirmed_at).toISOString() : null,
    };
  }

  async function contributionsByPayment(q: Queryable, walletId: string, paymentIds: string[]): Promise<Map<string, ContributionJoin>> {
    if (paymentIds.length === 0) return new Map();
    const { rows } = await q.query<ContributionJoin>(
      `SELECT c.payment_id, c.id AS contribution_id, c.anonymous, c.display_name, c.kyc_sealed, g.name AS group_name,
              p.rail, r.receipt_no,
              EXISTS (SELECT 1 FROM tribute tr WHERE tr.contribution_id = c.id AND tr.message IS NOT NULL) AS has_message
         FROM contribution c
         JOIN payment p ON p.id = c.payment_id
         LEFT JOIN receipt r ON r.payment_id = c.payment_id
         LEFT JOIN contribution_group g ON g.id = c.group_id
        WHERE c.wallet_id = $1 AND c.payment_id = ANY($2::uuid[])`,
      [walletId, paymentIds],
    );
    return new Map(rows.map((r) => [r.payment_id, r]));
  }

  async function payoutsById(q: Queryable, walletId: string, ids: string[]): Promise<Map<string, PayoutJoin>> {
    if (ids.length === 0) return new Map();
    const { rows } = await q.query<PayoutJoin>(
      `SELECT r.id, r.purpose, r.purpose_note, p.label AS payee_label, p.destination_masked AS payee_masked,
              r.rail, r.provider_ref, r.confirmed_at
         FROM payout_request r LEFT JOIN payee p ON p.id = r.payee_id
        WHERE r.wallet_id = $1 AND r.id = ANY($2::uuid[])`,
      [walletId, ids],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** The whole statement (oldest → newest, all pages) plus pending and summary. */
  async function build(q: Queryable, walletId: string): Promise<Omit<WalletTransactions, 'nextCursor'>> {
    const accounts = new Map<string, LedgerAccount>();
    for (const a of await listWalletAccounts(q, walletId)) if (WALLET_SOURCES.has(a.kind)) accounts.set(a.id, a);
    const { rows: groups } = await q.query<{ id: string; name: string }>('SELECT id::text AS id, name FROM contribution_group WHERE wallet_id = $1', [walletId]);
    const groupName = new Map(groups.map((g) => [g.id, g.name]));
    const groupOf = (a: LedgerAccount) => (a.kind === 'GROUP' && a.qualifier ? groupName.get(a.qualifier) ?? null : null);

    const statement = await getStatement(q, walletId);
    const paymentIds = new Set<string>();
    const payoutIds = new Set<string>();
    for (const j of statement) {
      for (const e of j.entries) {
        if (!accounts.has(e.accountId)) continue;
        const pay = refId(e.txnRef, 'payment');
        const po = refId(e.txnRef, 'payout');
        if (pay) paymentIds.add(pay);
        if (po) payoutIds.add(po);
      }
    }
    const contribs = await contributionsByPayment(q, walletId, [...paymentIds]);
    const payouts = await payoutsById(q, walletId, [...payoutIds]);

    const running = new Map<string, bigint>();
    const totals = new Map<string, { in: bigint; out: bigint }>();
    const lines: TxLine[] = [];
    for (const j of statement) {
      // Net per wallet account in this journal (credit = in).
      const net = new Map<string, { amount: bigint; txnRef: string | null; providerRef: string | null }>();
      for (const e of j.entries) {
        if (!accounts.has(e.accountId)) continue;
        const cur = net.get(e.accountId) ?? { amount: 0n, txnRef: e.txnRef, providerRef: e.providerRef };
        cur.amount += e.side === 'C' ? e.amount.minor : -e.amount.minor;
        cur.txnRef = cur.txnRef ?? e.txnRef;
        net.set(e.accountId, cur);
      }
      for (const [accountId, n] of net) {
        if (n.amount === 0n) continue;
        const a = accounts.get(accountId) as LedgerAccount;
        const bal = (running.get(accountId) ?? 0n) + n.amount;
        running.set(accountId, bal);
        const tot = totals.get(accountId) ?? { in: 0n, out: 0n };
        if (n.amount > 0n) tot.in += n.amount;
        else tot.out -= n.amount;
        totals.set(accountId, tot);
        const pay = refId(n.txnRef, 'payment');
        const po = refId(n.txnRef, 'payout');
        const c = pay ? contribs.get(pay) : undefined;
        const p = po ? payouts.get(po) : undefined;
        lines.push({
          id: j.journalId,
          seq: j.seq.toString(),
          at: j.createdAt.toISOString(),
          kind: j.kind,
          reversal: j.reversesJournalId !== null,
          reversesId: j.reversesJournalId,
          reversedById: null,
          direction: n.amount > 0n ? 'IN' : 'OUT',
          source: a.kind as TxSource,
          groupName: groupOf(a),
          amount: money(n.amount > 0n ? n.amount : -n.amount, a.currency),
          balanceAfter: money(bal, a.currency),
          approvalRef: j.approvalRef,
          contribution: c ? toContribution(c) : null,
          payout: p ? toPayout(p) : null,
          claimRef: refId(n.txnRef, 'claim'),
          note: j.kind === 'ADJUSTMENT' ? j.reason : null,
        });
      }
    }
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const l of lines) {
      const original = l.reversesId ? byId.get(l.reversesId) : undefined;
      if (original) original.reversedById = l.id;
    }

    const summary: TxSummary[] = [];
    for (const b of await getBalances(q, walletId)) {
      const a = [...accounts.values()].find((x) => accountCode(x) === b.code && x.currency === b.settled.ccy);
      if (!a) continue;
      const tot = totals.get(a.id) ?? { in: 0n, out: 0n };
      summary.push({
        source: a.kind as TxSource,
        groupName: groupOf(a),
        currency: a.currency,
        moneyIn: money(tot.in, a.currency),
        moneyOut: money(tot.out, a.currency),
        balance: b.settled,
        pending: b.pending,
        available: b.available,
        reserved: b.reserved,
      });
    }

    const pending: TxPending[] = [];
    const { rows: openPayouts } = await q.query<PayoutJoin & { status: string; amount_minor: string; currency: Currency; source_kind: string; requested_at: Date }>(
      `SELECT r.id, r.purpose, r.purpose_note, p.label AS payee_label, p.destination_masked AS payee_masked, r.rail,
              r.provider_ref, r.confirmed_at, r.status, r.amount_minor::text AS amount_minor, r.currency, r.source_kind, r.requested_at
         FROM payout_request r LEFT JOIN payee p ON p.id = r.payee_id
        WHERE r.wallet_id = $1 AND r.status = ANY($2::text[])
        ORDER BY r.requested_at DESC`,
      [walletId, PENDING_PAYOUTS],
    );
    for (const r of openPayouts) {
      pending.push({
        type: 'PAYOUT',
        id: r.id,
        at: new Date(r.requested_at).toISOString(),
        status: r.status,
        direction: 'OUT',
        source: (r.source_kind === 'FIDELITY_BENEFIT' ? 'FIDELITY_BENEFIT' : r.source_kind === 'GROUP' ? 'GROUP' : 'COMMUNITY') as TxSource,
        amount: money(parseMinor(r.amount_minor), r.currency),
        payout: toPayout(r),
        contribution: null,
      });
    }
    const { rows: openPays } = await q.query<{ id: string; state: string; gross_minor: string; currency: Currency; created_at: Date; group_id: string | null }>(
      `SELECT p.id, p.state, p.gross_minor::text AS gross_minor, p.currency, p.created_at, c.group_id::text AS group_id
         FROM payment p JOIN contribution c ON c.payment_id = p.id
        WHERE p.wallet_id = $1 AND p.state = ANY($2::text[])
        ORDER BY p.created_at DESC`,
      [walletId, PENDING_PAYMENTS],
    );
    const openContribs = await contributionsByPayment(q, walletId, openPays.map((p) => p.id));
    for (const p of openPays) {
      const c = openContribs.get(p.id);
      pending.push({
        type: 'CONTRIBUTION',
        id: p.id,
        at: new Date(p.created_at).toISOString(),
        status: p.state,
        direction: 'IN',
        source: p.group_id ? 'GROUP' : 'COMMUNITY',
        amount: money(parseMinor(p.gross_minor), p.currency),
        payout: null,
        contribution: c ? toContribution(c) : null,
      });
    }

    return { walletId, summary, pending, lines: lines.reverse() };
  }

  const list: Command<{ walletId: string; cursor?: string; limit?: number }, WalletTransactions> = {
    name: 'wallet.transactions',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.view_ledger', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      const all = await build(tx, input.walletId);
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const cursor = input.cursor && /^\d{1,19}$/.test(input.cursor) ? BigInt(input.cursor) : null;
      const from = cursor === null ? all.lines : all.lines.filter((l) => BigInt(l.seq) < cursor);
      const page = from.slice(0, limit);
      const more = from.length > limit;
      return {
        result: { ...all, lines: page, nextCursor: more ? (page[page.length - 1]?.seq ?? null) : null },
        // The family reads contributors' real names: recorded as a sensitive read.
        audit: { reasonCode: 'CONTRIBUTOR_NAMES_READ' },
      };
    },
  };

  const exportCsv: Command<{ walletId: string }, { filename: string; csv: string }> = {
    name: 'wallet.transactions.export',
    resolve: list.resolve,
    async run(tx, input) {
      const all = await build(tx, input.walletId);
      const { rows } = await tx.query<{ deceased_name: string }>('SELECT deceased_name FROM wallet WHERE id = $1', [input.walletId]);
      const header = ['date', 'status', 'direction', 'source', 'type', 'description', 'purpose', 'note', 'reference', 'amount', 'balance_after', 'currency'];
      const out: string[][] = [header];
      for (const p of all.pending) out.push(csvRow(p.at, 'PENDING', p.direction, p.source, p.type, describePending(p), p.payout?.purpose ?? '', p.payout?.note ?? '', p.payout?.providerRef ?? '', p.amount, null));
      for (const l of all.lines) out.push(csvRow(l.at, l.reversedById ? 'REVERSED' : 'POSTED', l.direction, l.groupName ? `GROUP:${l.groupName}` : l.source, l.reversal ? `${l.kind}_REVERSAL` : l.kind, describeLine(l), l.payout?.purpose ?? '', l.payout?.note ?? l.note ?? '', l.contribution?.receiptNo ?? l.payout?.providerRef ?? l.claimRef ?? '', l.amount, l.balanceAfter));
      const slug = (rows[0]?.deceased_name ?? 'wallet').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'wallet';
      return {
        result: { filename: `chema-${slug}-transactions.csv`, csv: `${out.map((r, i) => r.map((v, col) => csvCell(v, i > 0 && (col === 9 || col === 10))).join(',')).join('\r\n')}\r\n` },
        audit: { reasonCode: 'CONTRIBUTOR_NAMES_EXPORTED' },
      };
    },
  };

  return { list, exportCsv };
}

/** Decimal string from minor units ("12.50"); no float on the way. */
export function minorDecimal(m: Money): string {
  return format(m).replace(/ [A-Z]{3}$/, '');
}

function csvRow(at: string, status: string, direction: string, source: string, type: string, description: string, purpose: string, note: string, reference: string, amount: Money, balance: Money | null): string[] {
  const signed = direction === 'OUT' ? `-${minorDecimal(amount)}` : minorDecimal(amount);
  return [at, status, direction, source, type, description, purpose, note, reference, signed, balance ? minorDecimal(balance) : '', amount.ccy];
}

/**
 * RFC 4180 quoting + spreadsheet formula neutralising for text cells (names and
 * notes are user text). Amount cells we built ourselves pass `numeric`.
 */
export function csvCell(v: string, numeric = false): string {
  const safe = !numeric && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function payeeText(p: TxPayout | null): string {
  if (!p) return '';
  return [p.payeeLabel, p.payeeMasked ? `(${p.payeeMasked})` : null].filter(Boolean).join(' ');
}

function describeLine(l: TxLine): string {
  if (l.contribution) {
    const verb = l.kind === 'REFUND' ? 'Refund to' : l.kind === 'CHARGEBACK' ? 'Chargeback by' : 'Contribution from';
    return `${verb} ${l.contribution.name}${l.contribution.anonymousPublicly ? ' (anonymous on public page)' : ''}${l.reversal ? ' - reversed' : ''}`;
  }
  if (l.payout) return l.reversal ? `Returned by provider: ${payeeText(l.payout)}` : `Paid ${payeeText(l.payout)}`;
  if (l.kind === 'BENEFIT') return `Fidelity benefit${l.claimRef ? ` (claim ${l.claimRef})` : ''}`;
  if (l.kind === 'ADJUSTMENT') return 'Correction by Chema operations';
  return l.kind;
}

function describePending(p: TxPending): string {
  if (p.payout) return `Payout to ${payeeText(p.payout)} (${p.status})`;
  if (p.contribution) return `Contribution from ${p.contribution.name} (awaiting provider)`;
  return p.type;
}
