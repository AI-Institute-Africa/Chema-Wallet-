// Daily benefit reconciliation against Fidelity's benefit-payment ledger
// (docs/04 §7, docs/07 Resilience). Extends the P03 tables: Fidelity rows are
// stored as provider_settlement_row with rail 'FIDELITY'; differences become
// recon_exception rows, never silent write-offs. Re-running a day is idempotent.
import { randomUUID } from 'node:crypto';
import { NotFoundError, type Command } from '@chema/core';
import { raiseException } from '@chema/payments';
import { parseMinor } from '@chema/shared';
import type { BenefitSettlementRow } from './adapter';
import { BENEFIT_RECORD_LAG_DAYS } from './sync';
import { linkByClaimRef, type ClaimsDeps } from './store';

export const FIDELITY_RAIL = 'FIDELITY';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface BenefitReconSummary {
  runId: string;
  rowsSeen: number;
  matched: number;
  exceptions: number;
}

export function reconCommands(deps: ClaimsDeps) {
  const run: Command<{ date: string; rows: readonly BenefitSettlementRow[] }, BenefitReconSummary> = {
    name: 'fidelity.benefit_recon',
    async resolve(_q, input) {
      if (!DATE_RE.test(input.date)) throw new NotFoundError('recon', `${FIDELITY_RAIL}:${input.date}`);
      return { action: 'recon.run', subject: { type: 'recon', id: `${FIDELITY_RAIL}:${input.date}` } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const runId = randomUUID();
      const s = { rowsSeen: 0, matched: 0, exceptions: 0 };
      const exception = async (x: Omit<Parameters<typeof raiseException>[1], 'rail'>) => {
        const r = await raiseException(tx, { ...x, rail: FIDELITY_RAIL, reconRunId: runId }, now);
        if (r.created) s.exceptions += 1;
      };

      for (const row of input.rows) {
        s.rowsSeen += 1;
        await tx.query(
          `INSERT INTO provider_settlement_row (rail, settlement_date, provider_ref, currency, gross_minor, fee_minor, merchant_ref, first_run_id)
           VALUES ($1, $2::date, $3, $4, $5::bigint, 0, $6, $7) ON CONFLICT (rail, provider_ref) DO NOTHING`,
          [FIDELITY_RAIL, row.settledOn, row.paymentRef, row.amount.ccy, row.amount.minor.toString(), row.claimRef, runId],
        );
        const { rows: stored } = await tx.query<{ id: string; match_status: string | null }>(
          'SELECT id, match_status FROM provider_settlement_row WHERE rail = $1 AND provider_ref = $2 FOR UPDATE',
          [FIDELITY_RAIL, row.paymentRef],
        );
        const sr = stored[0];
        if (!sr || sr.match_status !== null) continue;
        const mark = (status: string, journalId: string | null) =>
          tx.query(
            'UPDATE provider_settlement_row SET match_status = $2, journal_id = $3::uuid, matched_at = $4, updated_at = now() WHERE id = $1',
            [sr.id, status, journalId, now.toISOString()],
          );
        const base = { providerRef: row.paymentRef, currency: row.amount.ccy, severity: 'HIGH' as const };

        const link = await linkByClaimRef(tx, row.claimRef);
        if (!link || !link.benefit_journal_id || link.benefit_payment_ref !== row.paymentRef) {
          // Paid per Fidelity, not credited here (route not approved, mismatch hold, or unknown claim).
          // Left unmatched so a later run matches it once credited.
          await exception({
            ...base,
            dedupKey: `benefit-uncredited:${row.paymentRef}`,
            kind: 'BENEFIT_UNCREDITED',
            ...(link ? { walletId: link.wallet_id } : {}),
            varianceMinor: row.amount.minor,
            detail: link ? 'Fidelity records a settled benefit that is not credited to the wallet' : 'Fidelity benefit for a claim unknown to Chema',
          });
          continue;
        }
        const { rows: cr } = await tx.query<{ credited: string; currency: string }>(
          `SELECT COALESCE(sum(e.amount_minor), 0)::text AS credited, min(a.currency) AS currency
             FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
            WHERE e.journal_id = $1 AND a.kind = 'FIDELITY_BENEFIT' AND e.side = 'C'`,
          [link.benefit_journal_id],
        );
        const credited = parseMinor(cr[0]?.credited ?? '0');
        if (cr[0]?.currency !== row.amount.ccy) {
          await exception({ ...base, dedupKey: `benefit-ccy:${row.paymentRef}`, kind: 'BENEFIT_CURRENCY_MISMATCH', walletId: link.wallet_id, detail: 'credited currency differs from Fidelity record' });
          await mark('VARIANCE', link.benefit_journal_id);
        } else if (credited !== row.amount.minor) {
          await exception({
            ...base,
            dedupKey: `benefit-amount:${row.paymentRef}`,
            kind: 'BENEFIT_AMOUNT_VARIANCE',
            walletId: link.wallet_id,
            varianceMinor: row.amount.minor - credited,
            journalId: link.benefit_journal_id,
            detail: 'credited amount differs from Fidelity record',
          });
          await mark('VARIANCE', link.benefit_journal_id);
        } else {
          s.matched += 1;
          await mark('MATCHED', link.benefit_journal_id);
        }
      }

      // Credited here but absent from Fidelity's ledger past the lag.
      const { rows: missing } = await tx.query<{ wallet_id: string; benefit_payment_ref: string; benefit_minor: string; benefit_currency: 'USD' | 'ZWG'; benefit_journal_id: string }>(
        `SELECT l.wallet_id, l.benefit_payment_ref, l.benefit_minor::text AS benefit_minor, l.benefit_currency, l.benefit_journal_id
           FROM fidelity_link l
          WHERE l.benefit_journal_id IS NOT NULL AND l.benefit_settled_on <= ($1::date - $2::int)
            AND NOT EXISTS (SELECT 1 FROM provider_settlement_row p WHERE p.rail = $3 AND p.provider_ref = l.benefit_payment_ref)`,
        [input.date, BENEFIT_RECORD_LAG_DAYS, FIDELITY_RAIL],
      );
      for (const m of missing) {
        await exception({
          dedupKey: `benefit-not-in-record:${m.benefit_payment_ref}`,
          kind: 'BENEFIT_NOT_IN_RECORD',
          severity: 'HIGH',
          walletId: m.wallet_id,
          providerRef: m.benefit_payment_ref,
          currency: m.benefit_currency,
          varianceMinor: -parseMinor(m.benefit_minor),
          journalId: m.benefit_journal_id,
          detail: `benefit credited but absent from Fidelity's ledger more than ${BENEFIT_RECORD_LAG_DAYS} day(s) after settlement`,
        });
      }

      await tx.query(
        `INSERT INTO recon_run (id, rail, settlement_date, started_by, started_at, rows_seen, matched, within_tolerance, exceptions)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, 0, $8)`,
        [runId, FIDELITY_RAIL, input.date, ctx.actor.personId, now.toISOString(), s.rowsSeen, s.matched, s.exceptions],
      );
      return { result: { runId, ...s }, audit: { subjectId: runId, after: s } };
    },
  };
  return { run };
}
