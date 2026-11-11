// P09 reports (docs/12 Reports + KPI definitions). Rules:
// - Activity and financial outcomes are reported separately; nothing implies
//   cause. No revenue, forecast or attribution figures: where a KPI needs data
//   the platform does not hold (page views, uptime, satisfaction, attribution
//   baselines) it is returned with measured=false and why, never estimated.
// - Money is per currency (USD/ZWG never summed together), minor units as strings.
import { type Command } from '@chema/core';
import { getBalances, getStatement } from '@chema/ledger';
import type { Queryable } from '@chema/shared';
import { walletExists } from './util';

export interface Kpi {
  id: string;
  group: 'activation' | 'engagement' | 'payments' | 'financial_integrity' | 'claims' | 'reliability' | 'trust' | 'fidelity_value' | 'volume';
  label: string;
  definition: string;
  measured: boolean;
  value: number | null;
  unit: 'count' | 'ratio' | 'hours' | 'minutes' | 'minor_by_currency' | 'breakdown';
  breakdown?: Record<string, unknown>;
  note?: string;
}

export interface Period {
  from: string;
  to: string;
}

function period(input: { from?: string; to?: string }, now: Date): Period {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime()) || from >= to) throw new RangeError('bad period');
  return { from: from.toISOString(), to: to.toISOString() };
}

async function num(q: Queryable, sql: string, params: unknown[]): Promise<number | null> {
  const { rows } = await q.query<{ v: string | number | null }>(sql, params);
  const v = rows[0]?.v;
  return v === null || v === undefined ? null : Number(v);
}

async function byCurrency(q: Queryable, sql: string, params: unknown[]): Promise<Record<string, string>> {
  const { rows } = await q.query<{ currency: string; v: string }>(sql, params);
  return Object.fromEntries(rows.map((r) => [r.currency, r.v]));
}

const notMeasured = (id: string, group: Kpi['group'], label: string, definition: string, note: string): Kpi => ({
  id, group, label, definition, measured: false, value: null, unit: 'count', note,
});

// Ratios and durations only (never money): display precision.
const round = (v: number | null, dp = 2) => (v === null ? null : Number(v.toFixed(dp)));

/** Fidelity management dashboard (docs/12). */
export function managementReport(clock: () => Date): Command<{ from?: string; to?: string }, { period: Period; kpis: Kpi[] }> {
  return {
    name: 'report.management',
    async resolve() {
      return { action: 'report.management', subject: { type: 'report', id: 'management' } };
    },
    async run(tx, input) {
      const p = period(input, clock());
      const w = [p.from, p.to];
      const k: Kpi[] = [];

      // Volume
      k.push({
        id: 'funerals_supported', group: 'volume', label: 'Funerals supported',
        definition: 'Wallets verified (community verification approved) in the period.',
        measured: true, unit: 'count',
        value: await num(tx, 'SELECT count(*) AS v FROM wallet WHERE verified_at >= $1 AND verified_at < $2', w),
      });
      k.push({
        id: 'community_raised', group: 'volume', label: 'Community money raised',
        definition: 'Settled contribution credits to community/group sub-ledgers in the period, net of reversals, per currency.',
        measured: true, unit: 'minor_by_currency', value: null,
        breakdown: await byCurrency(tx,
          `SELECT e.currency, (sum(CASE WHEN e.side = 'C' THEN e.amount_minor ELSE -e.amount_minor END))::text AS v
             FROM ledger_entry e JOIN ledger_journal j ON j.id = e.journal_id JOIN ledger_account a ON a.id = e.account_id
            WHERE a.kind IN ('COMMUNITY', 'GROUP') AND j.kind IN ('CONTRIBUTION', 'REFUND', 'CHARGEBACK')
              AND j.created_at >= $1 AND j.created_at < $2 GROUP BY e.currency`, w),
      });
      k.push({
        id: 'fidelity_benefits', group: 'volume', label: 'Fidelity benefits credited',
        definition: 'BENEFIT journals into W:FIDELITY_BENEFIT in the period (from Fidelity-confirmed payments), per currency. Reported separately from community money.',
        measured: true, unit: 'minor_by_currency', value: null,
        breakdown: await byCurrency(tx,
          `SELECT e.currency, sum(e.amount_minor)::text AS v
             FROM ledger_entry e JOIN ledger_journal j ON j.id = e.journal_id JOIN ledger_account a ON a.id = e.account_id
            WHERE a.kind = 'FIDELITY_BENEFIT' AND e.side = 'C' AND j.kind = 'BENEFIT' AND j.reverses_journal_id IS NULL
              AND j.created_at >= $1 AND j.created_at < $2 GROUP BY e.currency`, w),
      });

      // Activation
      k.push({
        id: 'drafts_created', group: 'activation', label: 'Drafts created',
        definition: 'Wallet drafts created in the period (any channel).',
        measured: true, unit: 'count', value: await num(tx, 'SELECT count(*) AS v FROM wallet WHERE created_at >= $1 AND created_at < $2', w),
      });
      k.push({
        id: 'verify_pass_rate', group: 'activation', label: 'Verification pass rate',
        definition: 'Verification decisions in the period that approved, over all APPROVED + REJECTED decisions (MORE_INFO excluded).',
        measured: true, unit: 'ratio',
        value: round(await num(tx,
          `SELECT (count(*) FILTER (WHERE outcome = 'APPROVED'))::float / NULLIF(count(*) FILTER (WHERE outcome IN ('APPROVED', 'REJECTED')), 0) AS v
             FROM verification_case WHERE decided_at >= $1 AND decided_at < $2`, w), 3),
      });
      k.push({
        id: 'median_draft_to_verified_hours', group: 'activation', label: 'Median draft → verified',
        definition: 'Median hours from draft creation to verification, for wallets verified in the period.',
        measured: true, unit: 'hours',
        value: round(await num(tx,
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM verified_at - created_at) / 3600) AS v
             FROM wallet WHERE verified_at >= $1 AND verified_at < $2`, w)),
      });

      // Engagement
      k.push({
        id: 'median_first_contribution_hours', group: 'engagement', label: 'Median activation → first contribution',
        definition: 'For wallets verified in the period: median hours from verification to the first settled contribution.',
        measured: true, unit: 'hours',
        value: round(await num(tx,
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY h) AS v FROM (
             SELECT extract(epoch FROM min(c.settled_at) - w.verified_at) / 3600 AS h
               FROM wallet w JOIN contribution c ON c.wallet_id = w.id AND c.settled_state = 'SUCCEEDED'
              WHERE w.verified_at >= $1 AND w.verified_at < $2 GROUP BY w.id, w.verified_at) x`, w)),
      });
      k.push({
        id: 'contributors_per_funeral', group: 'engagement', label: 'Contributions per funeral',
        definition: 'Mean number of settled contributions per wallet that received at least one, settled in the period.',
        measured: true, unit: 'count',
        value: round(await num(tx,
          `SELECT avg(n) AS v FROM (SELECT count(*) AS n FROM contribution
             WHERE settled_state = 'SUCCEEDED' AND settled_at >= $1 AND settled_at < $2 GROUP BY wallet_id) x`, w)),
      });
      k.push(notMeasured('link_conversion', 'engagement', 'Share-link conversion',
        'Contributions over public-page visits.', 'Page visits are not recorded (privacy by default); needs an approved analytics design.'));

      // Payments
      const { rows: rail } = await tx.query<{ rail: string; state: string; n: number }>(
        `SELECT rail, state, count(*)::int AS n FROM payment WHERE created_at >= $1 AND created_at < $2 GROUP BY rail, state ORDER BY rail, state`, w);
      const breakdown: Record<string, Record<string, number>> = {};
      for (const r of rail) (breakdown[r.rail] ??= {})[r.state] = r.n;
      k.push({
        id: 'payment_states_by_rail', group: 'payments', label: 'Payments by rail and state',
        definition: 'Payments initiated in the period, counted by rail and current state.',
        measured: true, unit: 'breakdown', value: null, breakdown,
      });
      k.push({
        id: 'median_settlement_minutes', group: 'payments', label: 'Median time to confirmation',
        definition: 'Median minutes from payment initiation to the provider-confirmed SUCCEEDED transition, for payments initiated in the period.',
        measured: true, unit: 'minutes',
        value: round(await num(tx,
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM s.at - p.created_at) / 60) AS v
             FROM payment p JOIN LATERAL (SELECT min(at) AS at FROM payment_state_log l WHERE l.payment_id = p.id AND l.to_state = 'SUCCEEDED') s ON s.at IS NOT NULL
            WHERE p.created_at >= $1 AND p.created_at < $2`, w)),
      });

      // Financial integrity
      k.push({
        id: 'recon_match_rate', group: 'financial_integrity', label: 'Reconciliation match rate',
        definition: 'Settlement rows matched exactly or within tolerance, over rows seen, for recon runs started in the period.',
        measured: true, unit: 'ratio',
        value: round(await num(tx,
          `SELECT sum(matched + within_tolerance)::float / NULLIF(sum(rows_seen), 0) AS v FROM recon_run WHERE started_at >= $1 AND started_at < $2`, w), 4),
      });
      k.push({
        id: 'open_recon_exceptions', group: 'financial_integrity', label: 'Open reconciliation exceptions',
        definition: 'Unresolved exceptions now; note gives the oldest age in hours.',
        measured: true, unit: 'count',
        value: await num(tx, 'SELECT count(*) AS v FROM recon_exception WHERE resolved_at IS NULL', []),
        note: `oldest open: ${round(await num(tx, `SELECT extract(epoch FROM $1::timestamptz - min(opened_at)) / 3600 AS v FROM recon_exception WHERE resolved_at IS NULL`, [p.to])) ?? 0} h`,
      });
      k.push({
        id: 'duplicate_postings', group: 'financial_integrity', label: 'Duplicate postings',
        definition: 'Payments credited by more than one live (unreversed) CONTRIBUTION journal. Must be 0.',
        measured: true, unit: 'count',
        value: await num(tx,
          `SELECT count(*) AS v FROM (SELECT e.txn_ref FROM ledger_entry e JOIN ledger_journal j ON j.id = e.journal_id
             WHERE j.kind = 'CONTRIBUTION' AND j.reverses_journal_id IS NULL AND e.txn_ref LIKE 'payment:%'
               AND NOT EXISTS (SELECT 1 FROM ledger_journal r WHERE r.reverses_journal_id = j.id)
             GROUP BY e.txn_ref HAVING count(DISTINCT j.id) > 1) x`, []),
      });
      k.push({
        id: 'payout_accuracy', group: 'financial_integrity', label: 'Payout accuracy',
        definition: 'Payout parts closed in the period that were CONFIRMED and not later reversed, over CONFIRMED + FAILED + REVERSED.',
        measured: true, unit: 'ratio',
        value: round(await num(tx,
          `SELECT (count(*) FILTER (WHERE status = 'CONFIRMED'))::float / NULLIF(count(*) FILTER (WHERE status IN ('CONFIRMED', 'FAILED', 'REVERSED')), 0) AS v
             FROM payout_request WHERE closed_at >= $1 AND closed_at < $2`, w), 4),
      });

      // Claims (kept separate from community money)
      k.push({
        id: 'claims_decided', group: 'claims', label: 'Claims decided by Fidelity',
        definition: 'Claim status mirror moves to APPROVED or DECLINED in the period (Fidelity decides; Chema mirrors).',
        measured: true, unit: 'count',
        value: await num(tx, `SELECT count(*) AS v FROM claim_status_event WHERE to_status IN ('APPROVED', 'DECLINED') AND ts >= $1 AND ts < $2`, w),
      });
      k.push({
        id: 'median_claim_link_to_decision_hours', group: 'claims', label: 'Median claim link → decision',
        definition: 'Median hours from the claim link being created to Fidelity\'s decision, for decisions in the period.',
        measured: true, unit: 'hours',
        value: round(await num(tx,
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.ts - f.created_at) / 3600) AS v
             FROM claim_status_event e JOIN fidelity_link f ON f.id = e.link_id
            WHERE e.to_status IN ('APPROVED', 'DECLINED') AND e.ts >= $1 AND e.ts < $2`, w)),
      });
      k.push(notMeasured('straight_through_rate', 'claims', 'Straight-through claim rate',
        'Claims approved without manual review, over all approved.', 'Only if claims.auto_approve_limit_minor is set (D10); Fidelity decides claims, Chema does not observe its review path.'));

      // Reliability
      k.push(notMeasured('availability', 'reliability', 'Availability / latency',
        'Uptime and p95 latency of API and channels.', 'Comes from infrastructure monitoring, not the application database.'));

      // Trust
      k.push({
        id: 'complaints', group: 'trust', label: 'Complaints (WhatsApp hand-offs)',
        definition: 'WhatsApp human hand-offs with reason COMPLAINT opened in the period.',
        measured: true, unit: 'count',
        value: await num(tx, `SELECT count(*) AS v FROM wa_escalation WHERE reason = 'COMPLAINT' AND created_at >= $1 AND created_at < $2`, w),
      });
      k.push({
        id: 'disputed_payouts', group: 'trust', label: 'Disputes opened',
        definition: 'Payment and authority dispute cases opened in the period.',
        measured: true, unit: 'count',
        value: await num(tx, `SELECT count(*) AS v FROM case_record WHERE case_type IN ('PAYMENT_DISPUTE', 'AUTHORITY_DISPUTE') AND opened_at >= $1 AND opened_at < $2`, w),
      });
      k.push({
        id: 'suspicious_wallet_reports', group: 'trust', label: 'Suspicious-wallet reports',
        definition: 'Public "report this wallet" submissions in the period.',
        measured: true, unit: 'count',
        value: await num(tx, 'SELECT count(*) AS v FROM wallet_report WHERE created_at >= $1 AND created_at < $2', w),
      });
      k.push({
        id: 'median_support_close_hours', group: 'trust', label: 'Median hand-off resolution',
        definition: 'Median hours from a WhatsApp hand-off opening to staff closing it, for hand-offs closed in the period.',
        measured: true, unit: 'hours',
        value: round(await num(tx,
          `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - created_at) / 3600) AS v
             FROM wa_escalation WHERE closed_at >= $1 AND closed_at < $2`, w)),
      });
      k.push(notMeasured('satisfaction', 'trust', 'Satisfaction', 'Family/contributor satisfaction score.', 'No survey instrument exists yet.'));

      // Fidelity value: never estimated.
      k.push(notMeasured('fidelity_value', 'fidelity_value', 'Attributable leads / policies / retention',
        'Business value to Fidelity attributable to Chema.', 'Needs a baseline and an attribution design agreed with Fidelity; no revenue claims are made.'));

      return { result: { period: p, kpis: k } };
    },
  };
}

/** Finance: recon status, exceptions ageing, fees/FX, settlements (docs/12). */
export function financeReport(clock: () => Date): Command<{ from?: string; to?: string }, Record<string, unknown>> {
  return {
    name: 'report.finance',
    async resolve() {
      return { action: 'report.finance', subject: { type: 'report', id: 'finance' } };
    },
    async run(tx, input) {
      const p = period(input, clock());
      const w = [p.from, p.to];
      const { rows: runs } = await tx.query(
        `SELECT id, rail, settlement_date AS "settlementDate", started_at AS "startedAt", rows_seen AS "rowsSeen", matched,
                within_tolerance AS "withinTolerance", exceptions
           FROM recon_run WHERE started_at >= $1 AND started_at < $2 ORDER BY started_at DESC LIMIT 50`, w);
      const { rows: ageing } = await tx.query(
        `SELECT severity,
                count(*) FILTER (WHERE $1::timestamptz - opened_at < interval '24 hours')::int AS "under24h",
                count(*) FILTER (WHERE $1::timestamptz - opened_at >= interval '24 hours' AND $1::timestamptz - opened_at < interval '72 hours')::int AS "h24to72",
                count(*) FILTER (WHERE $1::timestamptz - opened_at >= interval '72 hours')::int AS "over72h",
                count(*) FILTER (WHERE sla_due_at <= $1::timestamptz)::int AS "pastSla",
                count(*) FILTER (WHERE escalation_level > 0)::int AS escalated,
                count(*) FILTER (WHERE owner_person_id IS NULL)::int AS unowned
           FROM recon_exception WHERE resolved_at IS NULL GROUP BY severity ORDER BY severity`, [p.to]);
      const sysBalance = (kind: string) =>
        byCurrency(tx,
          `SELECT a.currency, (sum(CASE WHEN e.side = 'C' THEN e.amount_minor ELSE -e.amount_minor END))::text AS v
             FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE a.kind = $1 GROUP BY a.currency`, [kind]);
      const { rows: settlements } = await tx.query(
        `SELECT e.currency, count(DISTINCT j.id)::int AS journals, sum(e.amount_minor) FILTER (WHERE e.side = 'D')::text AS "amountMinor"
           FROM ledger_journal j JOIN ledger_entry e ON e.journal_id = j.id
          WHERE j.kind = 'SETTLEMENT' AND j.created_at >= $1 AND j.created_at < $2 GROUP BY e.currency`, w);
      const fx = await num(tx, 'SELECT count(*) AS v FROM payment WHERE fx_rate IS NOT NULL AND created_at >= $1 AND created_at < $2', w);
      return {
        result: {
          period: p,
          reconRuns: runs,
          exceptionAgeing: ageing,
          feesCollectedBalance: await sysBalance('FEES'),
          suspenseUnmatchedBalance: await sysBalance('SUSPENSE_UNMATCHED'),
          reconDiffBalance: await sysBalance('RECON_DIFF'),
          settlements,
          fxConvertedPayments: fx,
          note: 'Balances are credit-positive (credits minus debits) for the system account. Fees exist only when fees.enabled is on (D08).',
        },
      };
    },
  };
}

/** Agent: wallets created, claims assisted. Agents see only themselves. */
export const agentReport: Command<Record<string, never>, unknown[]> = {
  name: 'report.agent',
  async resolve() {
    return { action: 'report.agent', subject: { type: 'report', id: 'agent' } };
  },
  async run(tx, _i, ctx) {
    const self = ctx.actor.staffRole === 'AGENT';
    const { rows } = await tx.query(
      `SELECT s.person_id AS "personId", s.login,
              (SELECT count(*)::int FROM wallet w WHERE w.created_by = s.person_id AND w.created_by_kind = 'AGENT') AS "walletsCreated",
              (SELECT count(*)::int FROM wallet w WHERE w.created_by = s.person_id AND w.created_by_kind = 'AGENT' AND w.verified_at IS NOT NULL) AS "walletsVerified",
              (SELECT count(*)::int FROM fidelity_link f WHERE f.created_by = s.person_id) AS "claimsAssisted"
         FROM staff_account s WHERE s.staff_role = 'AGENT' ${self ? 'AND s.person_id = $1' : ''} ORDER BY s.login`,
      self ? [ctx.actor.personId] : [],
    );
    return { result: rows };
  },
};

/** Family statement as staff see it (docs/12 Family report). */
export const familyReport: Command<{ walletId: string }, Record<string, unknown>> = {
  name: 'report.family',
  async resolve(q, input) {
    const walletId = await walletExists(q, input.walletId);
    return { action: 'wallet.statement.view', subject: { type: 'wallet', id: walletId, walletId } };
  },
  async run(tx, input) {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT id, status, deceased_name AS "deceasedName", date_of_death AS "dateOfDeath", currency, target_minor::text AS "targetMinor",
              verified_at AS "verifiedAt", created_at AS "createdAt" FROM wallet WHERE id = $1`, [input.walletId]);
    const balances = (await getBalances(tx, input.walletId)).map((b) => ({
      account: b.code,
      kind: b.account.kind,
      currency: b.account.currency,
      settled: b.settled.minor.toString(),
      available: b.available.minor.toString(),
      reserved: b.reserved.minor.toString(),
      held: b.held.minor.toString(),
      paid: b.paid.minor.toString(),
    }));
    const { rows: contrib } = await tx.query<{ n: number; anon: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE anonymous)::int AS anon FROM contribution WHERE wallet_id = $1 AND settled_state = 'SUCCEEDED'`,
      [input.walletId]);
    const { rows: payouts } = await tx.query(
      `SELECT id, purpose, source_kind AS "source", amount_minor::text AS "amountMinor", currency, status, confirmed_at AS "confirmedAt"
         FROM payout_request WHERE wallet_id = $1 ORDER BY requested_at`, [input.walletId]);
    const statement = (await getStatement(tx, input.walletId)).map((j) => ({
      journalId: j.journalId,
      kind: j.kind,
      at: j.createdAt.toISOString(),
      reason: j.reason,
      reverses: j.reversesJournalId,
      approvalRef: j.approvalRef,
      entries: j.entries.map((e) => ({ account: e.accountId, side: e.side, minor: e.amount.minor.toString(), ccy: e.amount.ccy, txnRef: e.txnRef })),
    }));
    return {
      result: {
        wallet: rows[0],
        balances,
        contributions: { settled: contrib[0]?.n ?? 0, anonymousPublicly: contrib[0]?.anon ?? 0 },
        payouts,
        statement,
      },
    };
  },
};

/** Generic regulator export. The real format is decision D18 (TBD). */
export function regulatorExport(clock: () => Date): Command<{ from?: string; to?: string }, { format: string; period: Period; csv: string; rows: number }> {
  return {
    name: 'report.regulator',
    async resolve() {
      return { action: 'report.regulator', subject: { type: 'report', id: 'regulator' } };
    },
    async run(tx, input) {
      const p = period(input, clock());
      const { rows } = await tx.query<Record<string, string | null>>(
        `SELECT w.id, w.status, w.currency, w.created_at::text AS created_at, w.verified_at::text AS verified_at,
                (SELECT sum(CASE WHEN e.side = 'C' THEN e.amount_minor ELSE -e.amount_minor END)::text
                   FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id JOIN ledger_journal j ON j.id = e.journal_id
                  WHERE a.wallet_id = w.id AND a.kind IN ('COMMUNITY', 'GROUP') AND j.kind IN ('CONTRIBUTION', 'REFUND', 'CHARGEBACK')) AS community_net_minor,
                (SELECT sum(e.amount_minor)::text FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id JOIN ledger_journal j ON j.id = e.journal_id
                  WHERE a.wallet_id = w.id AND a.kind = 'FIDELITY_BENEFIT' AND e.side = 'C' AND j.kind = 'BENEFIT') AS benefit_minor,
                (SELECT sum(amount_minor)::text FROM payout_request r WHERE r.wallet_id = w.id AND r.status = 'CONFIRMED') AS paid_out_minor,
                (SELECT count(*)::text FROM contribution c WHERE c.wallet_id = w.id AND c.settled_state = 'SUCCEEDED') AS contributions
           FROM wallet w WHERE w.created_at >= $1 AND w.created_at < $2 ORDER BY w.created_at`,
        [p.from, p.to],
      );
      const cols = ['id', 'status', 'currency', 'created_at', 'verified_at', 'community_net_minor', 'benefit_minor', 'paid_out_minor', 'contributions'];
      const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n');
      return { result: { format: 'GENERIC_CSV_PENDING_D18', period: p, csv, rows: rows.length }, audit: { reasonCode: 'REGULATOR_EXPORT' } };
    },
  };
}
