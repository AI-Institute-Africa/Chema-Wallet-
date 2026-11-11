// Governance (docs/08): cases with owner/SLA/escalation/reason-coded outcome,
// and proportionate, source-aware holds. Placing a hold is protective (one
// person, written reason, review date); releasing one is maker-checker.
// A community dispute never freezes the Fidelity benefit (or vice versa)
// unless a staff member records a documented fraud/legal/material risk.
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  consumeApproval,
  createApproval,
  type Actor,
  type Command,
  type CommandTx,
} from '@chema/core';
import { listWalletAccounts, placeHold, releaseHold, type HoldInput } from '@chema/ledger';
import { caseSlaHours, exceptionSlaHours } from '@chema/payments';
import { money, parseMinor, type Currency, type Queryable } from '@chema/shared';
import { loadWallet } from '@chema/wallet';
import { emit, isUuid, loadPayout, writeCaseEvent, type PayoutDeps } from './store';
import {
  CASE_OUTCOMES,
  HOLD_REASONS,
  OPENABLE_CASE_TYPES,
  PAYOUT_SOURCES,
  RISK_REASONS,
  SEVERITIES,
  includes,
  type CaseOutcome,
  type CaseType,
  type CaseView,
  type HoldReason,
  type OpenableCaseType,
  type PayoutSource,
  type Severity,
} from './types';

const DAY = 86_400_000;
/** Longest review interval for a hold: none is indefinite (docs/04 §7). */
export const MAX_HOLD_REVIEW_DAYS = 30;
export const DEFAULT_HOLD_REVIEW_DAYS = 7;

interface CaseRow {
  id: string;
  case_type: CaseType;
  wallet_id: string | null;
  status: CaseView['status'];
  severity: Severity;
  summary: string;
  assignee_id: string | null;
  sla_due_at: Date;
  escalation_level: number;
  source_kind: PayoutSource | null;
  amount_minor: string | null;
  currency: Currency | null;
  payout_request_id: string | null;
  outcome: CaseOutcome | null;
  opened_by: string;
  opened_at: Date;
  closed_at: Date | null;
}

const CASE_COLS = `id, case_type, wallet_id, status, severity, summary, assignee_id, sla_due_at, escalation_level, source_kind,
  amount_minor::text AS amount_minor, currency, payout_request_id, outcome, opened_by, opened_at, closed_at`;

export async function loadCase(q: Queryable, id: string, lock = false): Promise<CaseRow> {
  if (!isUuid(id)) throw new NotFoundError('case', String(id));
  const { rows } = await q.query<CaseRow>(`SELECT ${CASE_COLS} FROM case_record WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('case', id);
  return rows[0];
}

async function caseView(q: Queryable, c: CaseRow): Promise<CaseView> {
  const { rows: holds } = await q.query<{ id: string; scope: string; source_kind: string | null; reason_code: string; released_at: Date | null }>(
    'SELECT id, scope, source_kind, reason_code, released_at FROM hold WHERE case_id = $1 ORDER BY created_at',
    [c.id],
  );
  return {
    id: c.id,
    type: c.case_type,
    walletId: c.wallet_id,
    status: c.status,
    severity: c.severity,
    summary: c.summary,
    assigneeId: c.assignee_id,
    slaDueAt: new Date(c.sla_due_at).toISOString(),
    escalationLevel: c.escalation_level,
    source: c.source_kind,
    amount: c.amount_minor && c.currency ? money(parseMinor(c.amount_minor), c.currency) : null,
    payoutRequestId: c.payout_request_id,
    holds: holds.map((h) => ({ id: h.id, scope: h.scope, source: h.source_kind, reasonCode: h.reason_code, released: h.released_at !== null })),
    outcome: c.outcome,
    openedAt: new Date(c.opened_at).toISOString(),
    closedAt: c.closed_at ? new Date(c.closed_at).toISOString() : null,
  };
}

function note(v: string | undefined, min = 10): string {
  const n = (v ?? '').trim();
  if (n.length < min || n.length > 2000) throw new ValidationError(`note must be ${min}–2000 characters`);
  return n;
}

const caseSubject = (c: CaseRow) => ({
  type: 'case',
  id: c.id,
  ...(c.wallet_id ? { walletId: c.wallet_id } : {}),
  createdByPersonId: c.opened_by,
});

export interface PlaceHoldArgs {
  walletId: string;
  scope: 'SOURCE' | 'WALLET';
  source?: { kind: PayoutSource; groupId?: string };
  reasonCode: HoldReason;
  note: string;
  caseId?: string;
  reviewAt: Date;
}

/** Place + link a hold (caller has authorised). Returns the hold id. */
export async function placeCaseHold(tx: CommandTx, actor: Actor, args: PlaceHoldArgs, now: Date): Promise<string> {
  if (args.scope === 'WALLET' && !RISK_REASONS.includes(args.reasonCode)) {
    // Wallet-wide holds ONLY for documented fraud/legal/material risk (docs/04 §7).
    throw new ConflictError('WALLET_HOLD_NEEDS_RISK_REASON');
  }
  const input: HoldInput =
    args.scope === 'WALLET'
      ? { scope: 'WALLET', walletId: args.walletId, reasonCode: args.reasonCode, ownerId: actor.personId, reviewAt: args.reviewAt }
      : {
          scope: 'SOURCE',
          walletId: args.walletId,
          source: { kind: args.source?.kind ?? 'COMMUNITY', ...(args.source?.groupId ? { groupId: args.source.groupId } : {}) },
          reasonCode: args.reasonCode,
          ownerId: actor.personId,
          reviewAt: args.reviewAt,
        };
  const id = await placeHold(tx, actor, input);
  await tx.query('UPDATE hold SET case_id = $2::uuid, note = $3, updated_at = now() WHERE id = $1', [id, args.caseId ?? null, args.note]);
  if (args.caseId) await writeCaseEvent(tx, actor, args.caseId, 'HOLD_PLACED', { reasonCode: args.reasonCode, note: args.note, refId: id, now });
  await emit(tx, 'hold.placed', { holdId: id, walletId: args.walletId, scope: args.scope, source: args.source?.kind ?? null });
  return id;
}

export interface OpenCaseInput {
  walletId: string;
  type: OpenableCaseType;
  summary: string;
  severity?: Severity;
  /** The source in dispute; COMMUNITY when unstated. */
  source?: { kind: PayoutSource; groupId?: string };
  amount?: { minor: bigint; ccy: Currency };
  /** A disputed payout: only that payout is blocked (proportionate). */
  payoutRequestId?: string;
  evidenceDocs?: string[];
  /**
   * Staff only, with a documented risk: also hold the OTHER source(s)
   * (e.g. the Fidelity benefit during a community dispute).
   */
  alsoHoldOtherSources?: { reasonCode: HoldReason; note: string };
}

export function governanceCommands(deps: PayoutDeps) {
  const open: Command<OpenCaseInput, CaseView> = {
    name: 'case.open',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'case.open', subject: { type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      if (!includes(OPENABLE_CASE_TYPES, input.type)) throw new ValidationError('case type cannot be opened by hand');
      const summary = note(input.summary);
      const severity = input.severity ?? (input.type === 'FRAUD' ? 'HIGH' : 'MEDIUM');
      if (!includes(SEVERITIES, severity)) throw new ValidationError('bad severity');
      const source = input.source ?? { kind: 'COMMUNITY' as const };
      if (!includes(PAYOUT_SOURCES, source.kind)) throw new ValidationError('bad source');
      if (input.alsoHoldOtherSources && ctx.actor.kind !== 'STAFF') throw new ForbiddenError('STAFF_ONLY_RISK_HOLD');
      if (input.alsoHoldOtherSources && !RISK_REASONS.includes(input.alsoHoldOtherSources.reasonCode)) {
        throw new ConflictError('CROSS_SOURCE_HOLD_NEEDS_RISK_REASON');
      }
      const w = await loadWallet(tx, input.walletId);
      if (input.payoutRequestId !== undefined) {
        const p = await loadPayout(tx, input.payoutRequestId);
        if (p.wallet_id !== w.id) throw new NotFoundError('payout_request', input.payoutRequestId);
      }
      for (const d of input.evidenceDocs ?? []) {
        const { rows } = await tx.query('SELECT 1 FROM document WHERE id = $1 AND linked_wallet = $2', [d, w.id]);
        if (!isUuid(d) || rows.length === 0) throw new NotFoundError('document', d);
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO case_record (case_type, wallet_id, summary, opened_by, opened_at, severity, source_kind, source_qualifier,
                                  amount_minor, currency, payout_request_id, evidence_docs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11::uuid, $12::uuid[]) RETURNING id`,
        [
          input.type, w.id, summary, ctx.actor.personId, now.toISOString(), severity, source.kind, source.groupId ?? null,
          input.amount?.minor.toString() ?? null, input.amount?.ccy ?? null, input.payoutRequestId ?? null, input.evidenceDocs ?? [],
        ],
      );
      const caseId = rows[0]?.id as string;
      await writeCaseEvent(tx, ctx.actor, caseId, 'OPENED', { reasonCode: input.type, now });
      const c = await loadCase(tx, caseId);
      const reviewAt = new Date(Math.min(new Date(c.sla_due_at).getTime(), now.getTime() + MAX_HOLD_REVIEW_DAYS * DAY));

      // Authority dispute ⇒ hold the family-controlled money (community + groups),
      // unless a single payout is named (then only that payout is blocked).
      if (input.type === 'AUTHORITY_DISPUTE' && input.payoutRequestId === undefined) {
        const accounts = await listWalletAccounts(tx, w.id);
        await placeCaseHold(tx, ctx.actor, { walletId: w.id, scope: 'SOURCE', source: { kind: 'COMMUNITY' }, reasonCode: 'AUTHORITY_DISPUTE', note: summary, caseId, reviewAt }, now);
        for (const g of accounts.filter((a) => a.kind === 'GROUP' && a.qualifier)) {
          await placeCaseHold(tx, ctx.actor, { walletId: w.id, scope: 'SOURCE', source: { kind: 'GROUP', groupId: g.qualifier as string }, reasonCode: 'AUTHORITY_DISPUTE', note: summary, caseId, reviewAt }, now);
        }
      }
      if (input.alsoHoldOtherSources) {
        const other: PayoutSource = source.kind === 'FIDELITY_BENEFIT' ? 'COMMUNITY' : 'FIDELITY_BENEFIT';
        await placeCaseHold(
          tx,
          ctx.actor,
          { walletId: w.id, scope: 'SOURCE', source: { kind: other }, reasonCode: input.alsoHoldOtherSources.reasonCode, note: note(input.alsoHoldOtherSources.note), caseId, reviewAt },
          now,
        );
      }
      await emit(tx, 'case.opened', { caseId, walletId: w.id, type: input.type });
      return { result: await caseView(tx, c), audit: { subjectId: caseId, reasonCode: input.type } };
    },
  };

  const assign: Command<{ caseId: string; assigneePersonId: string }, CaseView> = {
    name: 'case.assign',
    async resolve(q, input) {
      return { action: 'case.assign', subject: caseSubject(await loadCase(q, input.caseId)) };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const c = await loadCase(tx, input.caseId, true);
      if (c.closed_at) throw new ConflictError('CASE_CLOSED');
      if (!isUuid(input.assigneePersonId)) throw new ValidationError('bad assignee');
      const { rows } = await tx.query<{ staff_role: string }>(
        `SELECT staff_role FROM staff_account WHERE person_id = $1 AND disabled_at IS NULL AND staff_role IN ('CLAIMS_OFFICER', 'OPS_FINANCE', 'FIDELITY_ADMIN')`,
        [input.assigneePersonId],
      );
      const role = rows[0]?.staff_role;
      if (!role) throw new ConflictError('ASSIGNEE_NOT_CASE_STAFF');
      if (role === 'CLAIMS_OFFICER' && c.wallet_id) {
        // Claims officers see assigned wallets only: the assignment travels with the case.
        await tx.query(
          `INSERT INTO staff_assignment (staff_person_id, wallet_id, assigned_by) SELECT $1, $2, $3
            WHERE NOT EXISTS (SELECT 1 FROM staff_assignment WHERE staff_person_id = $1 AND wallet_id = $2 AND revoked_at IS NULL)`,
          [input.assigneePersonId, c.wallet_id, ctx.actor.personId],
        );
      }
      await tx.query(`UPDATE case_record SET status = 'ASSIGNED', assignee_id = $2, updated_at = now() WHERE id = $1`, [c.id, input.assigneePersonId]);
      await writeCaseEvent(tx, ctx.actor, c.id, 'ASSIGNED', { refId: input.assigneePersonId, now });
      return { result: await caseView(tx, await loadCase(tx, c.id)), audit: { after: { assignee: input.assigneePersonId } } };
    },
  };

  /** Ops/fidelity admin may act on any case; a claims officer only on cases assigned to them. */
  async function ownerGuard(q: Queryable, caseId: string, actor: Actor): Promise<string | null> {
    if (actor.kind !== 'STAFF') return 'STAFF_ONLY';
    if (actor.staffRole !== 'CLAIMS_OFFICER') return null;
    const c = await loadCase(q, caseId);
    return c.assignee_id === actor.personId ? null : 'NOT_CASE_OWNER';
  }

  const update: Command<{ caseId: string; note?: string; evidenceDocs?: string[]; escalate?: boolean }, CaseView> = {
    name: 'case.update',
    async resolve(q, input) {
      return { action: 'case.update', subject: caseSubject(await loadCase(q, input.caseId)) };
    },
    guard: (q, input, actor) => ownerGuard(q, input.caseId, actor),
    async run(tx, input, ctx) {
      const now = deps.clock();
      const c = await loadCase(tx, input.caseId, true);
      if (c.closed_at) throw new ConflictError('CASE_CLOSED');
      if (input.note !== undefined) await writeCaseEvent(tx, ctx.actor, c.id, 'NOTE', { note: note(input.note, 3), now });
      if (input.evidenceDocs?.length) {
        for (const d of input.evidenceDocs) {
          const { rows } = await tx.query('SELECT 1 FROM document WHERE id = $1 AND linked_wallet IS NOT DISTINCT FROM $2', [d, c.wallet_id]);
          if (!isUuid(d) || rows.length === 0) throw new NotFoundError('document', d);
        }
        await tx.query('UPDATE case_record SET evidence_docs = evidence_docs || $2::uuid[], updated_at = now() WHERE id = $1', [c.id, input.evidenceDocs]);
        await writeCaseEvent(tx, ctx.actor, c.id, 'EVIDENCE', { refId: input.evidenceDocs.join(','), now });
      }
      if (input.escalate) await escalateCase(tx, ctx.actor, c, 'MANUAL', now, (await caseSlaHours(tx, deps.flags))[c.case_type as keyof Awaited<ReturnType<typeof caseSlaHours>>] ?? 168);
      return { result: await caseView(tx, await loadCase(tx, c.id)) };
    },
  };

  const resolve: Command<{ caseId: string; outcome: CaseOutcome; note: string }, CaseView> = {
    name: 'case.resolve',
    async resolve(q, input) {
      return { action: 'case.resolve', subject: caseSubject(await loadCase(q, input.caseId)) };
    },
    guard: (q, input, actor) => ownerGuard(q, input.caseId, actor),
    async run(tx, input, ctx) {
      const now = deps.clock();
      if (!includes(CASE_OUTCOMES, input.outcome)) throw new ValidationError('reason-coded outcome required');
      const n = note(input.note);
      const c = await loadCase(tx, input.caseId, true);
      if (c.closed_at) throw new ConflictError('CASE_CLOSED');
      // Disputed release is dual (docs/02): holds go through hold.release first.
      const { rows } = await tx.query('SELECT 1 FROM hold WHERE case_id = $1 AND released_at IS NULL', [c.id]);
      if (rows.length) throw new ConflictError('CASE_HAS_ACTIVE_HOLDS');
      await tx.query(
        `UPDATE case_record SET closed_at = $2, closed_by = $3, close_reason = $4, outcome = $4, outcome_note = $5, updated_at = now() WHERE id = $1`,
        [c.id, now.toISOString(), ctx.actor.personId, input.outcome, n],
      );
      await writeCaseEvent(tx, ctx.actor, c.id, 'RESOLVED', { reasonCode: input.outcome, note: n, now });
      await emit(tx, 'case.resolved', { caseId: c.id, walletId: c.wallet_id, outcome: input.outcome });
      return { result: await caseView(tx, await loadCase(tx, c.id)), audit: { reasonCode: input.outcome } };
    },
  };

  const view: Command<{ caseId: string }, CaseView> = {
    name: 'case.view',
    async resolve(q, input) {
      return { action: 'case.view', subject: caseSubject(await loadCase(q, input.caseId)) };
    },
    async run(tx, input) {
      return { result: await caseView(tx, await loadCase(tx, input.caseId)) };
    },
  };

  const listForWallet: Command<{ walletId: string }, CaseView[]> = {
    name: 'case.list',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'case.view', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      const { rows } = await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM case_record WHERE wallet_id = $1 ORDER BY opened_at DESC`, [input.walletId]);
      const out: CaseView[] = [];
      for (const r of rows) out.push(await caseView(tx, r));
      return { result: out };
    },
  };

  /** Ops queue: open cases, oldest SLA first (ops/finance + fidelity admin). */
  const queue: Command<Record<string, never>, CaseView[]> = {
    name: 'case.queue',
    async resolve() {
      return { action: 'case.assign', subject: { type: 'case_queue', id: 'open' } };
    },
    async run(tx) {
      const { rows } = await tx.query<CaseRow>(`SELECT ${CASE_COLS} FROM case_record WHERE closed_at IS NULL ORDER BY sla_due_at LIMIT 200`);
      const out: CaseView[] = [];
      for (const r of rows) out.push(await caseView(tx, r));
      return { result: out };
    },
  };

  // ── Holds ──────────────────────────────────────────────────────────────────

  const holdPlace: Command<PlaceHoldArgs & { reviewInDays?: number }, { holdId: string }> = {
    name: 'hold.place',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'hold.place', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      if (!includes(HOLD_REASONS, input.reasonCode)) throw new ValidationError('bad reason code');
      if (input.scope !== 'SOURCE' && input.scope !== 'WALLET') throw new ValidationError('scope must be SOURCE or WALLET');
      const days = input.reviewInDays ?? DEFAULT_HOLD_REVIEW_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > MAX_HOLD_REVIEW_DAYS) throw new ValidationError(`review within 1–${MAX_HOLD_REVIEW_DAYS} days`);
      if (input.caseId !== undefined) {
        const c = await loadCase(tx, input.caseId);
        if (c.wallet_id !== input.walletId || c.closed_at) throw new ConflictError('CASE_NOT_OPEN_ON_WALLET');
        // Source-aware: holding another source than the one in dispute needs a documented risk.
        const target = input.scope === 'SOURCE' ? (input.source?.kind ?? 'COMMUNITY') : null;
        if (c.source_kind && target !== c.source_kind && !RISK_REASONS.includes(input.reasonCode)) {
          throw new ConflictError('CROSS_SOURCE_HOLD_NEEDS_RISK_REASON');
        }
      }
      const holdId = await placeCaseHold(
        tx,
        ctx.actor,
        { ...input, note: note(input.note), reviewAt: new Date(now.getTime() + days * DAY) },
        now,
      );
      return { result: { holdId }, audit: { subjectId: holdId, reasonCode: input.reasonCode } };
    },
  };

  /** Maker (no approvalId) ⇒ approval; a different person checks; maker (approvalId) ⇒ released. */
  const holdRelease: Command<{ holdId: string; reason: string; approvalId?: string }, { status: 'PENDING_APPROVAL' | 'RELEASED'; approvalId: string }> = {
    name: 'hold.release',
    async resolve(q, input) {
      if (!isUuid(input.holdId)) throw new NotFoundError('hold', String(input.holdId));
      const { rows } = await q.query<{ wallet_id: string; placed_by: string }>('SELECT wallet_id, placed_by FROM hold WHERE id = $1', [input.holdId]);
      if (!rows[0]) throw new NotFoundError('hold', input.holdId);
      return { action: 'hold.release', subject: { type: 'hold', id: input.holdId, walletId: rows[0].wallet_id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const reason = note(input.reason);
      const { rows } = await tx.query<{ wallet_id: string; released_at: Date | null; case_id: string | null }>(
        'SELECT wallet_id, released_at, case_id FROM hold WHERE id = $1 FOR UPDATE',
        [input.holdId],
      );
      const h = rows[0];
      if (!h) throw new NotFoundError('hold', input.holdId);
      if (h.released_at) throw new ConflictError('ALREADY_RELEASED');
      const payload = { holdId: input.holdId, reason };
      if (input.approvalId === undefined) {
        const approvalId = await createApproval(tx, ctx.actor, {
        createdAt: deps.clock(), action: 'hold.release', subjectType: 'hold', subjectId: input.holdId, walletId: h.wallet_id, payload });
        return { result: { status: 'PENDING_APPROVAL', approvalId }, audit: { approvalRef: approvalId, reasonCode: 'RELEASE_REQUESTED' } };
      }
      await consumeApproval(tx, ctx.actor, input.approvalId, { action: 'hold.release', subjectType: 'hold', subjectId: input.holdId, payload });
      await releaseHold(tx, ctx.actor, input.holdId, reason);
      await tx.query('UPDATE hold SET release_approval_id = $2, updated_at = now() WHERE id = $1', [input.holdId, input.approvalId]);
      if (h.case_id) await writeCaseEvent(tx, ctx.actor, h.case_id, 'HOLD_RELEASED', { note: reason, refId: input.holdId, now });
      await emit(tx, 'hold.released', { holdId: input.holdId, walletId: h.wallet_id });
      return { result: { status: 'RELEASED', approvalId: input.approvalId }, audit: { approvalRef: input.approvalId, reasonCode: 'RELEASED' } };
    },
  };

  /**
   * SYSTEM sweep: ageing + escalation. Open cases and recon exceptions past
   * their SLA move up one escalation level with a new SLA window; holds past
   * their review date are reported (they never lapse by themselves).
   */
  const sweep: Command<Record<string, never>, { casesEscalated: number; exceptionsEscalated: number; holdsDueForReview: number }> = {
    name: 'governance.sweep',
    async resolve() {
      return { action: 'case.process', subject: { type: 'governance', id: 'sweep' } };
    },
    async run(tx, _input, ctx) {
      const now = deps.clock();
      // D09 thresholds from config (unset => built-in hours). Cases not yet escalated are re-based on
      // the configured SLA; recon exceptions (whose stored SLA moves only with an escalation) age by
      // opened_at + configured hours until their first escalation, then by the stored window.
      const caseHours = await caseSlaHours(tx, deps.flags);
      const exHours = await exceptionSlaHours(tx, deps.flags);
      for (const [type, hours] of Object.entries(caseHours)) {
        await tx.query(
          `UPDATE case_record SET sla_due_at = opened_at + make_interval(hours => $2::int), updated_at = now()
            WHERE closed_at IS NULL AND escalation_level = 0 AND case_type = $1
              AND sla_due_at IS DISTINCT FROM opened_at + make_interval(hours => $2::int)`,
          [type, hours],
        );
      }
      const { rows: cases } = await tx.query<CaseRow>(
        `SELECT ${CASE_COLS} FROM case_record WHERE closed_at IS NULL AND sla_due_at <= $1 ORDER BY sla_due_at FOR UPDATE`,
        [now.toISOString()],
      );
      for (const c of cases) await escalateCase(tx, ctx.actor, c, 'SLA_BREACHED', now, caseHours[c.case_type as keyof typeof caseHours] ?? 168);
      const { rows: ex } = await tx.query<{ id: string; severity: Severity }>(
        `SELECT id, severity FROM recon_exception
          WHERE resolved_at IS NULL
            AND CASE WHEN escalation_level = 0
                     THEN opened_at + make_interval(hours => CASE severity WHEN 'HIGH' THEN $2::int WHEN 'MEDIUM' THEN $3::int ELSE $4::int END)
                     ELSE sla_due_at END <= $1::timestamptz
          ORDER BY sla_due_at FOR UPDATE`,
        [now.toISOString(), exHours.HIGH, exHours.MEDIUM, exHours.LOW],
      );
      for (const e of ex) {
        await tx.query(
          `UPDATE recon_exception SET escalation_level = escalation_level + 1, sla_due_at = $2, updated_at = now() WHERE id = $1`,
          [e.id, new Date(now.getTime() + exHours[e.severity] * 3_600_000).toISOString()],
        );
      }
      const { rows: holds } = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM hold WHERE released_at IS NULL AND review_at <= $1',
        [now.toISOString()],
      );
      return {
        result: { casesEscalated: cases.length, exceptionsEscalated: ex.length, holdsDueForReview: holds[0]?.n ?? 0 },
        audit: { reasonCode: `ESCALATED:${cases.length}/${ex.length}` },
      };
    },
  };

  return { open, assign, update, resolve, view, listForWallet, queue, holdPlace, holdRelease, sweep };
}

async function escalateCase(tx: CommandTx, actor: Actor, c: CaseRow, reason: string, now: Date, slaHours: number): Promise<void> {
  await tx.query(
    `UPDATE case_record SET status = 'ESCALATED', escalation_level = escalation_level + 1,
            sla_due_at = $2::timestamptz + make_interval(hours => $3::int), updated_at = now()
      WHERE id = $1`,
    [c.id, now.toISOString(), slaHours],
  );
  await writeCaseEvent(tx, actor, c.id, 'ESCALATED', { reasonCode: reason, now });
}

export type GovernanceCommands = ReturnType<typeof governanceCommands>;
