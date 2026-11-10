// Reconciliation core (docs/04 §7): provider settlement rows ↔ credited
// payments. Differences are recorded, never written off silently:
//   exact                     ⇒ MATCHED
//   |diff| ≤ tolerance        ⇒ SETTLEMENT journal to SYS:RECON_DIFF
//   short beyond tolerance    ⇒ exception + proportionate TXN hold on that payment
//   over beyond tolerance     ⇒ excess to SUSPENSE_UNMATCHED + exception
//   row with no credited pay. ⇒ SUSPENSE_UNMATCHED + exception (a report never credits a wallet)
//   credited, never settled   ⇒ MISSING_SETTLEMENT exception
// Tolerance `recon.tolerance.<rail>.<ccy>`; unset ⇒ zero, and still no blanket freeze.
// Re-running a day is idempotent (row + journal + exception keys).
import { randomUUID } from 'node:crypto';
import { isFlagKey, NotFoundError, type Command, type CommandTx } from '@chema/core';
import { ensureSystemAccount, placeHold, post } from '@chema/ledger';
import type { SettlementRow } from '@chema/providers';
import { money, parseMinor } from '@chema/shared';
import type { PaymentDeps } from './collect';
import { creditedNet } from './events';
import { EXCEPTION_OWNER_ROLE, raiseException, slaDue } from './exceptions';
import { loadPaymentByProviderRef } from './store';

/** ASSUMPTION (D09): a credited payment absent from settlement for more than one day is "missing". */
export const SETTLEMENT_LAG_DAYS = 1;

export interface ReconInput {
  rail: string;
  /** YYYY-MM-DD */
  date: string;
  rows: readonly SettlementRow[];
}

export interface ReconSummary {
  runId: string;
  rowsSeen: number;
  matched: number;
  withinTolerance: number;
  exceptions: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function toleranceFor(tx: CommandTx, deps: PaymentDeps, rail: string, ccy: string): Promise<bigint> {
  const key = `recon.tolerance.${rail.toLowerCase()}.${ccy.toLowerCase()}`;
  if (!isFlagKey(key)) return 0n;
  const v = await deps.flags.getIn(tx, key);
  return typeof v === 'bigint' ? v : 0n;
}

export function reconCommands(deps: PaymentDeps) {
  const run: Command<ReconInput, ReconSummary> = {
    name: 'recon.run',
    async resolve(_q, input) {
      if (!DATE_RE.test(input.date) || !deps.rails.adapter(input.rail)) throw new NotFoundError('recon', `${input.rail}:${input.date}`);
      return { action: 'recon.run', subject: { type: 'recon', id: `${input.rail}:${input.date}` } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const adapter = deps.rails.adapter(input.rail);
      if (!adapter) throw new NotFoundError('rail', input.rail);
      const runId = randomUUID();
      const s = { rowsSeen: 0, matched: 0, withinTolerance: 0, exceptions: 0 };
      const rail = input.rail;

      const exception = async (x: Parameters<typeof raiseException>[1]) => {
        const r = await raiseException(tx, { ...x, reconRunId: runId }, now);
        if (r.created) s.exceptions += 1;
        return r;
      };

      for (const row of input.rows) {
        s.rowsSeen += 1;
        const ccy = row.gross.ccy;
        await tx.query(
          `INSERT INTO provider_settlement_row (rail, settlement_date, provider_ref, currency, gross_minor, fee_minor, merchant_ref, first_run_id)
           VALUES ($1, $2::date, $3, $4, $5::bigint, $6::bigint, $7, $8) ON CONFLICT (rail, provider_ref) DO NOTHING`,
          [rail, input.date, row.providerRef, ccy, row.gross.minor.toString(), row.fee.minor.toString(), row.merchantRef, runId],
        );
        const { rows: stored } = await tx.query<{ id: string; match_status: string | null }>(
          'SELECT id, match_status FROM provider_settlement_row WHERE rail = $1 AND provider_ref = $2 FOR UPDATE',
          [rail, row.providerRef],
        );
        const sr = stored[0];
        if (!sr || sr.match_status !== null) continue; // already reconciled in an earlier run

        const mark = async (status: string, paymentId: string | null, journalId: string | null) => {
          await tx.query(
            `UPDATE provider_settlement_row SET match_status = $2, payment_id = $3::uuid, journal_id = $4::uuid, matched_at = $5, updated_at = now()
              WHERE id = $1`,
            [sr.id, status, paymentId, journalId, now.toISOString()],
          );
        };

        if (row.merchantRef !== adapter.merchantRef) {
          await exception({
            dedupKey: `wrong-destination:${rail}:${row.providerRef}`,
            kind: 'WRONG_DESTINATION',
            severity: 'HIGH',
            rail,
            providerRef: row.providerRef,
            currency: ccy,
            varianceMinor: row.gross.minor,
            detail: 'settlement row for a merchant account that is not ours',
          });
          await mark('UNMATCHED', null, null);
          continue;
        }

        const clearing = await ensureSystemAccount(tx, 'PROVIDER_CLEARING', ccy, rail);
        const refs = { providerRef: row.providerRef, txnRef: `recon:${runId}` };
        const p = await loadPaymentByProviderRef(tx, rail, row.providerRef, { lock: true });

        if (!p || p.credited_gross_minor === null || p.currency !== ccy) {
          const suspense = await ensureSystemAccount(tx, 'SUSPENSE_UNMATCHED', ccy);
          const j = await post(tx, ctx.actor, {
            idempotencyKey: `recon:${rail}:${row.providerRef}:unmatched`,
            kind: 'SUSPENSE',
            entries: [
              { accountId: clearing.id, side: 'D', amount: row.gross, ...refs },
              { accountId: suspense.id, side: 'C', amount: row.gross, ...refs },
            ],
          });
          await exception({
            dedupKey: `unmatched:${rail}:${row.providerRef}`,
            kind: 'UNMATCHED_INCOMING',
            severity: 'HIGH',
            rail,
            providerRef: row.providerRef,
            currency: ccy,
            varianceMinor: row.gross.minor,
            journalId: j.journalId,
            ...(p ? { paymentId: p.id, walletId: p.wallet_id } : {}),
            detail: p ? `settled money for a payment in state ${p.state}; held in suspense, not credited` : 'settled money matches no payment; held in suspense',
          });
          await mark('UNMATCHED', p?.id ?? null, j.journalId);
          continue;
        }

        const expected = parseMinor(p.credited_gross_minor);
        const diff = row.gross.minor - expected;
        const abs = diff < 0n ? -diff : diff;
        const tolerance = await toleranceFor(tx, deps, rail, ccy);

        const expectedFee = p.provider_fee_minor !== null ? parseMinor(p.provider_fee_minor) : parseMinor(p.fee_minor);
        if (row.fee.minor !== expectedFee) {
          await exception({
            dedupKey: `fee-variance:${p.id}:settlement`,
            kind: 'FEE_VARIANCE',
            severity: 'MEDIUM',
            rail,
            paymentId: p.id,
            walletId: p.wallet_id,
            providerRef: row.providerRef,
            currency: ccy,
            varianceMinor: row.fee.minor - expectedFee,
            detail: 'settled fee differs from the fee recorded for the payment',
          });
        }

        if (diff === 0n) {
          s.matched += 1;
          await mark('MATCHED', p.id, null);
          continue;
        }
        if (abs <= tolerance) {
          const reconDiff = await ensureSystemAccount(tx, 'RECON_DIFF', ccy);
          const amt = money(abs, ccy);
          const j = await post(tx, ctx.actor, {
            idempotencyKey: `recon:${rail}:${row.providerRef}:diff`,
            kind: 'SETTLEMENT',
            entries:
              diff < 0n
                ? [
                    { accountId: reconDiff.id, side: 'D', amount: amt, ...refs },
                    { accountId: clearing.id, side: 'C', amount: amt, ...refs },
                  ]
                : [
                    { accountId: clearing.id, side: 'D', amount: amt, ...refs },
                    { accountId: reconDiff.id, side: 'C', amount: amt, ...refs },
                  ],
          });
          s.withinTolerance += 1;
          await mark('WITHIN_TOLERANCE', p.id, j.journalId);
          continue;
        }

        if (diff < 0n) {
          // Short settlement: hold only the missing amount of this one payment.
          const net = await creditedNet(tx, p);
          const holdAmount = abs < net ? abs : net;
          let holdId: string | undefined;
          if (holdAmount > 0n && p.credit_journal_id) {
            holdId = await placeHold(tx, ctx.actor, {
              scope: 'TXN',
              walletId: p.wallet_id,
              journalId: p.credit_journal_id,
              accountId: p.credit_account_id,
              amount: money(holdAmount, ccy),
              reasonCode: 'RECON_SHORT_SETTLEMENT',
              ownerId: EXCEPTION_OWNER_ROLE,
              reviewAt: slaDue('MEDIUM', now),
            });
          }
          await exception({
            dedupKey: `variance:${p.id}:settlement`,
            kind: 'AMOUNT_VARIANCE',
            severity: 'MEDIUM',
            rail,
            paymentId: p.id,
            walletId: p.wallet_id,
            providerRef: row.providerRef,
            currency: ccy,
            varianceMinor: diff,
            ...(holdId ? { holdId } : {}),
            detail: 'provider settled less than was credited; proportionate hold on this payment',
          });
          await mark('VARIANCE', p.id, null);
          continue;
        }

        const suspense = await ensureSystemAccount(tx, 'SUSPENSE_UNMATCHED', ccy);
        const j = await post(tx, ctx.actor, {
          idempotencyKey: `recon:${rail}:${row.providerRef}:excess`,
          kind: 'SUSPENSE',
          entries: [
            { accountId: clearing.id, side: 'D', amount: money(abs, ccy), ...refs },
            { accountId: suspense.id, side: 'C', amount: money(abs, ccy), ...refs },
          ],
        });
        await exception({
          dedupKey: `variance:${p.id}:settlement`,
          kind: 'AMOUNT_VARIANCE',
          severity: 'MEDIUM',
          rail,
          paymentId: p.id,
          walletId: p.wallet_id,
          providerRef: row.providerRef,
          currency: ccy,
          varianceMinor: diff,
          journalId: j.journalId,
          detail: 'provider settled more than was credited; excess held in suspense',
        });
        await mark('VARIANCE', p.id, j.journalId);
      }

      // Credited payments that should have settled by now but did not.
      const cutoff = new Date(`${input.date}T00:00:00.000Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() - SETTLEMENT_LAG_DAYS);
      const { rows: missing } = await tx.query<{ id: string; wallet_id: string; provider_ref: string; currency: string; credited: string }>(
        `SELECT p.id, p.wallet_id, p.provider_ref, p.currency, p.credited_gross_minor::text AS credited
           FROM payment p JOIN receipt r ON r.payment_id = p.id
          WHERE p.rail = $1 AND r.issued_at < $2
            AND NOT EXISTS (SELECT 1 FROM provider_settlement_row s WHERE s.rail = p.rail AND s.provider_ref = p.provider_ref)`,
        [rail, cutoff.toISOString()],
      );
      for (const m of missing) {
        await exception({
          dedupKey: `missing:${m.id}`,
          kind: 'MISSING_SETTLEMENT',
          severity: 'HIGH',
          rail,
          paymentId: m.id,
          walletId: m.wallet_id,
          providerRef: m.provider_ref,
          currency: m.currency as 'USD' | 'ZWG',
          varianceMinor: -parseMinor(m.credited),
          detail: `credited but absent from provider settlement more than ${SETTLEMENT_LAG_DAYS} day(s) later`,
        });
      }

      await tx.query(
        `INSERT INTO recon_run (id, rail, settlement_date, started_by, started_at, rows_seen, matched, within_tolerance, exceptions)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9)`,
        [runId, rail, input.date, ctx.actor.personId, now.toISOString(), s.rowsSeen, s.matched, s.withinTolerance, s.exceptions],
      );
      return { result: { runId, ...s }, audit: { subjectId: runId, after: s } };
    },
  };

  return { run };
}
