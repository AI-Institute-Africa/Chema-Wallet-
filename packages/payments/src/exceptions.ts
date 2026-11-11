// Recon exceptions and case stubs (docs/04 §7, §8). Raising is idempotent
// (dedup_key), so redelivered events and re-run recon never duplicate work.
import { CASE_SLA_DEFAULT_HOURS, EXCEPTION_SLA_DEFAULT_HOURS, type FlagService } from '@chema/core';
import type { Currency, Queryable } from '@chema/shared';

export type ExceptionKind =
  | 'UNMATCHED_INCOMING'
  | 'MISSING_SETTLEMENT'
  | 'AMOUNT_VARIANCE'
  | 'FEE_VARIANCE'
  | 'WRONG_DESTINATION'
  | 'CHARGEBACK_SHORTFALL'
  | 'POLL_WINDOW_EXPIRED'
  | 'CURRENCY_MISMATCH'
  // P06: benefit credits vs the Fidelity record (rail 'FIDELITY').
  | 'BENEFIT_UNCREDITED'
  | 'BENEFIT_AMOUNT_VARIANCE'
  | 'BENEFIT_NOT_IN_RECORD'
  | 'BENEFIT_CURRENCY_MISMATCH'
  | 'BENEFIT_STATE_CONFLICT';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

/** ASSUMPTION (D09 unresolved): built-in SLA per severity, used at creation; flags `recon.exception_sla_hours.*` override it for ageing. */
export const SLA_HOURS: Readonly<Record<Severity, number>> = {
  HIGH: EXCEPTION_SLA_DEFAULT_HOURS.high,
  MEDIUM: EXCEPTION_SLA_DEFAULT_HOURS.medium,
  LOW: EXCEPTION_SLA_DEFAULT_HOURS.low,
};

const atLeastOne = (v: number | null, dflt: number) => (v === null ? dflt : Math.max(1, v));

/** Effective exception SLA hours per severity (flag, else built-in). Read through the caller's tx. */
export async function exceptionSlaHours(q: Queryable, flags: FlagService): Promise<Record<Severity, number>> {
  return {
    HIGH: atLeastOne(await flags.getIn(q, 'recon.exception_sla_hours.high'), SLA_HOURS.HIGH),
    MEDIUM: atLeastOne(await flags.getIn(q, 'recon.exception_sla_hours.medium'), SLA_HOURS.MEDIUM),
    LOW: atLeastOne(await flags.getIn(q, 'recon.exception_sla_hours.low'), SLA_HOURS.LOW),
  };
}

/** Effective case SLA hours per case type (flag `case.sla_hours.<type>`, else built-in = SQL case_sla_hours()). */
export async function caseSlaHours(q: Queryable, flags: FlagService): Promise<Record<CaseType, number>> {
  const out = {} as Record<CaseType, number>;
  for (const [type, dflt] of Object.entries(CASE_SLA_DEFAULT_HOURS) as [keyof typeof CASE_SLA_DEFAULT_HOURS, number][]) {
    out[type.toUpperCase() as CaseType] = atLeastOne(await flags.getIn(q, `case.sla_hours.${type}`), dflt);
  }
  return out;
}
/** ASSUMPTION: exceptions land in the ops/finance queue until P09 assigns a named owner. */
export const EXCEPTION_OWNER_ROLE = 'OPS_FINANCE';

export function slaDue(severity: Severity, now: Date): Date {
  return new Date(now.getTime() + SLA_HOURS[severity] * 3_600_000);
}

export interface RaiseInput {
  dedupKey: string;
  kind: ExceptionKind;
  severity: Severity;
  rail: string;
  detail: string;
  paymentId?: string;
  walletId?: string;
  providerRef?: string;
  currency?: Currency;
  varianceMinor?: bigint;
  holdId?: string;
  journalId?: string;
  reconRunId?: string;
}

/** Returns the exception id and whether this call created it. */
export async function raiseException(q: Queryable, input: RaiseInput, now: Date): Promise<{ id: string; created: boolean }> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO recon_exception
       (dedup_key, kind, severity, rail, payment_id, wallet_id, provider_ref, currency, variance_minor, detail,
        hold_id, journal_id, recon_run_id, owner_role, opened_at, sla_due_at)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7, $8, $9::bigint, $10, $11::uuid, $12::uuid, $13::uuid, $14, $15, $16)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [
      input.dedupKey,
      input.kind,
      input.severity,
      input.rail,
      input.paymentId ?? null,
      input.walletId ?? null,
      input.providerRef ?? null,
      input.currency ?? null,
      input.varianceMinor === undefined ? null : input.varianceMinor.toString(),
      input.detail,
      input.holdId ?? null,
      input.journalId ?? null,
      input.reconRunId ?? null,
      EXCEPTION_OWNER_ROLE,
      now.toISOString(),
      slaDue(input.severity, now).toISOString(),
    ],
  );
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await q.query<{ id: string }>('SELECT id FROM recon_exception WHERE dedup_key = $1', [input.dedupKey]);
  return { id: existing.rows[0]?.id ?? '', created: false };
}

export type CaseType =
  | 'CHARGEBACK'
  | 'REFUND'
  | 'RECON'
  | 'FRAUD'
  | 'BENEFICIARY_MISMATCH'
  | 'AUTHORITY_DISPUTE'
  | 'PAYMENT_DISPUTE'
  | 'PROVIDER_DISPUTE';

export async function openCase(
  q: Queryable,
  input: { type: CaseType; summary: string; openedBy: string; walletId?: string; paymentId?: string; externalRef?: string },
  now: Date,
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO case_record (case_type, wallet_id, payment_id, external_ref, summary, opened_by, opened_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7)
     ON CONFLICT (case_type, external_ref) DO NOTHING RETURNING id`,
    [input.type, input.walletId ?? null, input.paymentId ?? null, input.externalRef ?? null, input.summary, input.openedBy, now.toISOString()],
  );
  if (rows[0]) return rows[0].id;
  const existing = await q.query<{ id: string }>('SELECT id FROM case_record WHERE case_type = $1 AND external_ref = $2', [
    input.type,
    input.externalRef ?? null,
  ]);
  const id = existing.rows[0]?.id;
  if (!id) throw new Error('case could not be opened');
  return id;
}

export async function closeCase(q: Queryable, caseId: string, by: string, reason: string): Promise<void> {
  await q.query(
    `UPDATE case_record SET closed_at = now(), closed_by = $2, close_reason = $3, updated_at = now()
      WHERE id = $1 AND closed_at IS NULL`,
    [caseId, by, reason],
  );
}
