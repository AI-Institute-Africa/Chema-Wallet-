// P09 state-changing portal commands (docs/12). Every one runs through the
// bus (authorised + audited); the high-risk ones are maker-checker:
//   maker calls without approvalId ⇒ approval created (PENDING_APPROVAL);
//   a different person decides it (approval.decide, checker cell);
//   the maker calls again with approvalId ⇒ executed, approval consumed.
// The payload hash pins exactly what was approved.
import {
  actorRoleLabel,
  ConflictError,
  consumeApproval,
  createApproval,
  DualApprovalRequiredError,
  FlagValueError,
  isFlagKey,
  LockedFlagError,
  NotFoundError,
  randomToken,
  RefusedError,
  STAFF_ROLES,
  ValidationError,
  type Command,
  type FlagKey,
  type FlagService,
  type StaffAuthService,
  type StaffRole,
} from '@chema/core';
import { getAccounts, post, validateBenefitRules, validateJournal, type EntryInput } from '@chema/ledger';
import { money, type Currency, type Queryable } from '@chema/shared';
import { accessReviewExport } from './queues';
import { isUuid, note, requireUuid, walletExists } from './util';

export interface OpsDeps {
  flags: FlagService;
  staffAuth: StaffAuthService;
  clock: () => Date;
}

type Pending = { status: 'PENDING_APPROVAL'; approvalId: string };

// ── Ledger adjustment (docs/04 §1, docs/02: ops/finance maker + checker) ──────

export interface AdjustEntryInput {
  accountId: string;
  side: 'D' | 'C';
  /** Positive integer minor units, as a string on the wire. */
  minor: string;
  ccy: Currency;
}

export interface AdjustInput {
  entries: AdjustEntryInput[];
  reason: string;
  approvalId?: string;
}

const MINOR = /^[1-9][0-9]{0,15}$/;

function canonicalEntries(raw: unknown): AdjustEntryInput[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 10) throw new ValidationError('2-10 entries');
  return raw.map((e: Partial<AdjustEntryInput>) => {
    if (!e || !isUuid(e.accountId)) throw new ValidationError('bad account');
    if (e.side !== 'D' && e.side !== 'C') throw new ValidationError('bad side');
    if (typeof e.minor !== 'string' || !MINOR.test(e.minor)) throw new ValidationError('bad amount');
    if (e.ccy !== 'USD' && e.ccy !== 'ZWG') throw new ValidationError('bad currency');
    return { accountId: e.accountId.toLowerCase(), side: e.side, minor: e.minor, ccy: e.ccy };
  });
}

const toLedger = (entries: AdjustEntryInput[]): EntryInput[] =>
  entries.map((e) => ({ accountId: e.accountId, side: e.side, amount: money(BigInt(e.minor), e.ccy), txnRef: 'adjustment' }));

async function adjustmentScope(q: Queryable, entries: AdjustEntryInput[]): Promise<string | null> {
  const accounts = await getAccounts(q, entries.map((e) => e.accountId));
  const wallets = new Set<string>();
  for (const e of entries) {
    const a = accounts.get(e.accountId);
    if (!a) throw new NotFoundError('ledger_account', e.accountId);
    if (a.walletId) wallets.add(a.walletId);
  }
  if (wallets.size > 1) throw new ConflictError('CROSS_WALLET');
  return [...wallets][0] ?? null;
}

export function ledgerAdjust(): Command<AdjustInput, Pending | { status: 'POSTED'; approvalId: string; journalId: string }> {
  return {
    name: 'ledger.adjust',
    async resolve(q, input) {
      const walletId = await adjustmentScope(q, canonicalEntries(input.entries));
      return {
        action: 'ledger.adjust',
        subject: { type: 'ledger_adjustment', id: walletId ?? 'system', ...(walletId ? { walletId } : {}) },
      };
    },
    async run(tx, input, ctx) {
      const entries = canonicalEntries(input.entries);
      const reason = note(input.reason);
      const ledgerEntries = toLedger(entries);
      const subjectId = ctx.subject.id;
      const payload = { entries, reason };
      if (input.approvalId === undefined) {
        // Dry-run the ledger's own rules now, so a checker never approves a journal the books would refuse.
        const accounts = await getAccounts(tx, entries.map((e) => e.accountId));
        validateJournal(ledgerEntries, accounts);
        validateBenefitRules('ADJUSTMENT', ledgerEntries, accounts);
        const ccy = entries[0]?.ccy ?? 'USD';
        const debit = entries.filter((e) => e.side === 'D' && e.ccy === ccy).reduce((s, e) => s + BigInt(e.minor), 0n);
        const approvalId = await createApproval(tx, ctx.actor, {
          action: 'ledger.adjust',
          subjectType: 'ledger_adjustment',
          subjectId,
          ...(ctx.subject.walletId ? { walletId: ctx.subject.walletId } : {}),
          payload,
          amount: { minor: debit, ccy },
        });
        return { result: { status: 'PENDING_APPROVAL', approvalId }, audit: { approvalRef: approvalId, reasonCode: 'ADJUSTMENT_REQUESTED', after: payload } };
      }
      await consumeApproval(tx, ctx.actor, input.approvalId, { action: 'ledger.adjust', subjectType: 'ledger_adjustment', subjectId, payload });
      const r = await post(tx, ctx.actor, {
        idempotencyKey: `adjust:${input.approvalId}`,
        kind: 'ADJUSTMENT',
        entries: ledgerEntries,
        reason,
        approvalRef: input.approvalId,
      });
      return {
        result: { status: 'POSTED', approvalId: input.approvalId, journalId: r.journalId },
        audit: { approvalRef: input.approvalId, txnRef: `journal:${r.journalId}`, reasonCode: 'ADJUSTMENT_POSTED' },
      };
    },
  };
}

// ── Reconciliation exceptions (docs/04 §7) ───────────────────────────────────

async function exceptionSubject(q: Queryable, id: unknown) {
  const exceptionId = requireUuid(id, 'recon_exception');
  const { rows } = await q.query<{ wallet_id: string | null }>('SELECT wallet_id FROM recon_exception WHERE id = $1', [exceptionId]);
  if (!rows[0]) throw new NotFoundError('recon_exception', exceptionId);
  return { type: 'recon_exception', id: exceptionId, ...(rows[0].wallet_id ? { walletId: rows[0].wallet_id } : {}) };
}

/** Take ownership of an exception (set once). */
export const reconAssign: Command<{ exceptionId: string }, { exceptionId: string; ownerId: string }> = {
  name: 'recon.exception.assign',
  async resolve(q, input) {
    return { action: 'recon.exception.assign', subject: await exceptionSubject(q, input.exceptionId) };
  },
  async run(tx, input, ctx) {
    const { rows } = await tx.query(
      `UPDATE recon_exception SET owner_person_id = $2, updated_at = now()
        WHERE id = $1 AND owner_person_id IS NULL AND resolved_at IS NULL RETURNING id`,
      [input.exceptionId, ctx.actor.personId],
    );
    if (rows.length !== 1) throw new ConflictError('ALREADY_OWNED_OR_RESOLVED');
    return { result: { exceptionId: input.exceptionId, ownerId: ctx.actor.personId } };
  },
};

/**
 * Close an exception with a written resolution. Only its owner may, and a
 * held exception only after its hold was released through hold.release
 * (dual approval): resolving never frees money by itself. Money corrections
 * are a separate ledger.adjust.
 */
export function reconResolve(deps: OpsDeps): Command<{ exceptionId: string; resolution: string }, { exceptionId: string }> {
  return {
    name: 'recon.exception.resolve',
    async resolve(q, input) {
      return { action: 'recon.exception.resolve', subject: await exceptionSubject(q, input.exceptionId) };
    },
    async run(tx, input, ctx) {
      const resolution = note(input.resolution);
      const { rows } = await tx.query<{ owner_person_id: string | null; resolved_at: Date | null; hold_id: string | null; released_at: Date | null }>(
        `SELECT e.owner_person_id, e.resolved_at, e.hold_id, h.released_at
           FROM recon_exception e LEFT JOIN hold h ON h.id = e.hold_id WHERE e.id = $1 FOR UPDATE OF e`,
        [input.exceptionId],
      );
      const e = rows[0];
      if (!e) throw new NotFoundError('recon_exception', input.exceptionId);
      if (e.resolved_at) throw new ConflictError('ALREADY_RESOLVED');
      if (e.owner_person_id !== ctx.actor.personId) throw new ConflictError('NOT_OWNER');
      if (e.hold_id && !e.released_at) throw new ConflictError('HOLD_ACTIVE');
      await tx.query(
        'UPDATE recon_exception SET resolved_at = $2, resolved_by = $3, resolution = $4, updated_at = now() WHERE id = $1',
        [input.exceptionId, deps.clock().toISOString(), ctx.actor.personId, resolution],
      );
      return { result: { exceptionId: input.exceptionId }, audit: { reasonCode: 'RESOLVED' } };
    },
  };
}

// ── Staff and role admin (docs/02 Staff, docs/12 queue 10) ───────────────────

/** Roles whose grant is privileged access ⇒ dual approval (docs/12). */
export const PRIVILEGED_ROLES: ReadonlySet<StaffRole> = new Set<StaffRole>(['FIDELITY_ADMIN', 'OPS_FINANCE', 'AUDITOR']);

export interface EnrollInput {
  login: string;
  role: StaffRole;
  name?: string;
  approvalId?: string;
}

export interface Enrolled {
  status: 'ENROLLED';
  staffId: string;
  personId: string;
  login: string;
  /** Shown ONCE to the enrolling admin; handed to the person out of band. */
  initialPassword: string;
  totpSecret: string;
  otpauth: string;
}

export function staffEnroll(deps: OpsDeps): Command<EnrollInput, Pending | Enrolled> {
  return {
    name: 'staff.enroll',
    async resolve(_q, input) {
      if (typeof input.login !== 'string' || !/^[a-z0-9._@-]{3,64}$/.test(input.login)) throw new ValidationError('invalid login');
      if (!(STAFF_ROLES as readonly string[]).includes(input.role)) throw new ValidationError('invalid role');
      return { action: 'role.admin', subject: { type: 'staff_enrolment', id: input.login } };
    },
    async run(tx, input, ctx) {
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : null;
      const payload = { login: input.login, role: input.role, name };
      if (PRIVILEGED_ROLES.has(input.role)) {
        if (input.approvalId === undefined) {
          const { rows } = await tx.query('SELECT 1 FROM staff_account WHERE login = $1', [input.login]);
          if (rows.length > 0) throw new ConflictError('LOGIN_TAKEN');
          const approvalId = await createApproval(tx, ctx.actor, { action: 'role.admin', subjectType: 'staff_enrolment', subjectId: input.login, payload });
          return { result: { status: 'PENDING_APPROVAL', approvalId }, audit: { approvalRef: approvalId, reasonCode: 'PRIVILEGED_GRANT_REQUESTED', after: payload } };
        }
        await consumeApproval(tx, ctx.actor, input.approvalId, { action: 'role.admin', subjectType: 'staff_enrolment', subjectId: input.login, payload });
      }
      const initialPassword = randomToken(15);
      const out = await deps.staffAuth.enrollIn(tx, { login: input.login, role: input.role, password: initialPassword, ...(name ? { name } : {}) });
      return {
        result: { status: 'ENROLLED', ...out, login: input.login, initialPassword },
        audit: { subjectId: out.staffId, after: payload, ...(input.approvalId ? { approvalRef: input.approvalId } : {}) },
      };
    },
  };
}

async function staffRow(q: Queryable, staffId: unknown) {
  const id = requireUuid(staffId, 'staff_account');
  const { rows } = await q.query<{ id: string; person_id: string; staff_role: StaffRole; disabled_at: Date | null }>(
    'SELECT id, person_id, staff_role, disabled_at FROM staff_account WHERE id = $1',
    [id],
  );
  if (!rows[0]) throw new NotFoundError('staff_account', id);
  return rows[0];
}

/**
 * Disable (protective, one person) or re-enable (privileged roles: dual) a
 * staff account. Nobody disables their own account.
 */
export function staffSetDisabled(deps: OpsDeps): Command<{ staffId: string; disabled: boolean; reason: string; approvalId?: string }, Pending | { status: 'DONE'; changed: boolean }> {
  return {
    name: 'staff.set_disabled',
    async resolve(q, input) {
      const s = await staffRow(q, input.staffId);
      return { action: 'role.admin', subject: { type: 'staff_account', id: s.id, ownerPersonId: s.person_id } };
    },
    async run(tx, input, ctx) {
      const reason = note(input.reason);
      const s = await staffRow(tx, input.staffId);
      if (s.person_id === ctx.actor.personId) throw new ConflictError('CANNOT_CHANGE_OWN_ACCOUNT');
      const disabled = input.disabled === true;
      if ((s.disabled_at !== null) === disabled) return { result: { status: 'DONE', changed: false }, audit: { reasonCode: 'UNCHANGED' } };
      if (!disabled && PRIVILEGED_ROLES.has(s.staff_role)) {
        const payload = { staffId: s.id, enable: true };
        if (input.approvalId === undefined) {
          const approvalId = await createApproval(tx, ctx.actor, { action: 'role.admin', subjectType: 'staff_account', subjectId: s.id, payload });
          return { result: { status: 'PENDING_APPROVAL', approvalId }, audit: { approvalRef: approvalId, reasonCode: 'PRIVILEGED_ENABLE_REQUESTED' } };
        }
        await consumeApproval(tx, ctx.actor, input.approvalId, { action: 'role.admin', subjectType: 'staff_account', subjectId: s.id, payload });
      }
      const r = await deps.staffAuth.setDisabledIn(tx, s.id, disabled);
      return {
        result: { status: 'DONE', changed: r.changed },
        audit: { reasonCode: disabled ? 'DISABLED' : 'ENABLED', after: { disabled, reason }, ...(input.approvalId ? { approvalRef: input.approvalId } : {}) },
      };
    },
  };
}

/** Case scoping: assign a staff member to a wallet (docs/02: staff see assigned cases only). */
export const staffAssign: Command<{ staffPersonId: string; walletId: string }, { assignmentId: string }> = {
  name: 'staff.assign',
  async resolve(q, input) {
    const walletId = await walletExists(q, input.walletId);
    return { action: 'role.admin', subject: { type: 'staff_assignment', id: walletId, walletId } };
  },
  async run(tx, input, ctx) {
    const personId = requireUuid(input.staffPersonId, 'person');
    const { rows: st } = await tx.query<{ disabled_at: Date | null }>('SELECT disabled_at FROM staff_account WHERE person_id = $1', [personId]);
    if (!st[0]) throw new NotFoundError('staff_account', personId);
    if (st[0].disabled_at) throw new ConflictError('STAFF_DISABLED');
    // A staff member who is family on this case may not work it (conflict of interest).
    const { rows: fam } = await tx.query(
      `SELECT 1 FROM wallet_role WHERE wallet_id = $1 AND person_id = $2 AND role <> 'AGENT' AND revoked_at IS NULL`,
      [input.walletId, personId],
    );
    if (fam.length > 0) throw new ConflictError('FAMILY_ROLE_CONFLICT');
    const { rows: dup } = await tx.query(
      'SELECT 1 FROM staff_assignment WHERE wallet_id = $1 AND staff_person_id = $2 AND revoked_at IS NULL',
      [input.walletId, personId],
    );
    if (dup.length > 0) throw new ConflictError('ALREADY_ASSIGNED');
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO staff_assignment (staff_person_id, wallet_id, assigned_by) VALUES ($1, $2, $3) RETURNING id',
      [personId, input.walletId, ctx.actor.personId],
    );
    const assignmentId = rows[0]?.id ?? '';
    return { result: { assignmentId }, audit: { subjectId: assignmentId, after: { staffPersonId: personId, walletId: input.walletId } } };
  },
};

export const staffUnassign: Command<{ assignmentId: string }, { assignmentId: string }> = {
  name: 'staff.unassign',
  async resolve(q, input) {
    const id = requireUuid(input.assignmentId, 'staff_assignment');
    const { rows } = await q.query<{ wallet_id: string }>('SELECT wallet_id FROM staff_assignment WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundError('staff_assignment', id);
    return { action: 'role.admin', subject: { type: 'staff_assignment', id, walletId: rows[0].wallet_id } };
  },
  async run(tx, input, ctx) {
    const { rows } = await tx.query(
      'UPDATE staff_assignment SET revoked_at = now(), revoked_by = $2, updated_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
      [input.assignmentId, ctx.actor.personId],
    );
    if (rows.length !== 1) throw new ConflictError('ALREADY_REVOKED');
    return { result: { assignmentId: input.assignmentId } };
  },
};

// ── Config flags (docs/12 queue 9; financial flags dual) ─────────────────────

export interface FlagApplyInput {
  key: string;
  /** The value in its stored JSON form (null clears an optional value). */
  value: unknown;
  reason: string;
  /** Required for financial flags: an APPROVED config.change approval made by this actor. */
  approvalId?: string;
}

export function flagApply(deps: OpsDeps): Command<FlagApplyInput, { key: string; before: unknown; after: unknown }> {
  return {
    name: 'config.apply',
    async resolve(_q, input) {
      if (typeof input.key !== 'string' || !isFlagKey(input.key)) throw new ValidationError('unknown flag');
      return { action: 'config.change', subject: { type: 'config_flag', id: input.key } };
    },
    async run(tx, input, ctx) {
      const key = input.key as FlagKey;
      const reason = note(input.reason);
      try {
        const value = deps.flags.decodeStored(key, input.value);
        const out = await deps.flags.setIn(
          tx,
          key,
          value,
          { id: ctx.actor.personId, role: actorRoleLabel(ctx.actor), channel: ctx.actor.channel },
          reason,
          input.approvalId ? { approvalId: input.approvalId } : {},
        );
        return {
          result: { key, ...out },
          audit: { before: out.before, after: out.after, ...(input.approvalId ? { approvalRef: input.approvalId } : {}) },
        };
      } catch (err) {
        if (err instanceof DualApprovalRequiredError) throw new ConflictError('DUAL_APPROVAL_REQUIRED');
        if (err instanceof LockedFlagError) throw new ConflictError('FLAG_LOCKED');
        if (err instanceof FlagValueError) throw new ValidationError('invalid flag value');
        throw err;
      }
    },
  };
}

// ── Support hand-off (docs/12 Support) ───────────────────────────────────────

export function supportClose(deps: OpsDeps): Command<{ escalationId: string; note: string }, { escalationId: string }> {
  return {
    name: 'support.close',
    async resolve(q, input) {
      const id = requireUuid(input.escalationId, 'wa_escalation');
      const { rows } = await q.query('SELECT 1 FROM wa_escalation WHERE id = $1', [id]);
      if (!rows[0]) throw new NotFoundError('wa_escalation', id);
      return { action: 'support.close', subject: { type: 'wa_escalation', id } };
    },
    async run(tx, input, ctx) {
      const text = note(input.note);
      const { rows } = await tx.query(
        `UPDATE wa_escalation SET status = 'CLOSED', closed_at = $2, closed_by = $3, close_note = $4
          WHERE id = $1 AND status = 'OPEN' RETURNING id`,
        [input.escalationId, deps.clock().toISOString(), ctx.actor.personId, text],
      );
      if (rows.length !== 1) throw new ConflictError('ALREADY_CLOSED');
      return { result: { escalationId: input.escalationId }, audit: { reasonCode: 'CLOSED' } };
    },
  };
}

// ── Access review sign-off (docs/12 queue 10) ────────────────────────────────

export interface AccessReviewSignoffInput {
  /** The review period (ISO date-times), from < to ≤ now. */
  periodFrom: string;
  periodTo: string;
  /** What the reviewer saw: the export's row count and the sha256 of its CSV. */
  rowCount: number;
  csvSha256: string;
  notes: string;
}

/** Audit actions that change staff access (enrolment, disable/enable, case assignment). */
const ACCESS_CHANGE_ACTIONS = ['staff.enroll', 'staff.set_disabled', 'staff.assign', 'staff.unassign'];

/**
 * Record who reviewed the access-review export, for which period, and exactly
 * which export (row count + sha256 of the CSV, re-computed here: a stale or
 * altered export is refused, audited, 409). Reviewer = AUDITOR or
 * FIDELITY_ADMIN (matrix), and never someone who changed staff access or
 * checked a privileged-access approval during the reviewed period (no
 * self-certification; audited denial REVIEWER_CHANGED_ACCESS).
 */
export function accessReviewSignoff(deps: OpsDeps): Command<AccessReviewSignoffInput, { signoffId: string }> {
  const period = (input: AccessReviewSignoffInput) => {
    const from = typeof input.periodFrom === 'string' ? Date.parse(input.periodFrom) : Number.NaN;
    const to = typeof input.periodTo === 'string' ? Date.parse(input.periodTo) : Number.NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new ValidationError('invalid period');
    return { from: new Date(from), to: new Date(to) };
  };
  return {
    name: 'role.review.signoff',
    async resolve(_q, input) {
      period(input);
      if (!Number.isInteger(input.rowCount) || input.rowCount < 0) throw new ValidationError('invalid row count');
      if (typeof input.csvSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.csvSha256)) throw new ValidationError('invalid sha256');
      return { action: 'role.review.signoff', subject: { type: 'access_review', id: 'signoff' } };
    },
    async guard(q, input, actor) {
      const { from, to } = period(input);
      const { rows } = await q.query(
        `SELECT 1 FROM audit_log a
          WHERE a.actor_id = $1 AND a.authz_result = 'ALLOWED' AND a.ts >= $2::timestamptz AND a.ts <= $3::timestamptz
            AND (a.action = ANY($4::text[])
                 OR (a.action = 'approval.decide' AND EXISTS (
                       SELECT 1 FROM approval p WHERE p.id::text = a.subject_id AND p.action = 'role.admin')))
          LIMIT 1`,
        [actor.personId, from.toISOString(), to.toISOString(), ACCESS_CHANGE_ACTIONS],
      );
      return rows.length > 0 ? 'REVIEWER_CHANGED_ACCESS' : null;
    },
    async run(tx, input, ctx) {
      const { from, to } = period(input);
      const now = deps.clock();
      if (to.getTime() > now.getTime()) throw new ValidationError('period ends in the future');
      const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
      if (notes.length < 10 || notes.length > 2000) throw new ConflictError('REASON_REQUIRED');
      const current = await accessReviewExport(tx);
      if (current.rowCount !== input.rowCount || current.csvSha256 !== input.csvSha256) throw new RefusedError('EXPORT_CHANGED');
      const role = ctx.actor.staffRole;
      if (role !== 'AUDITOR' && role !== 'FIDELITY_ADMIN') throw new ConflictError('REVIEWER_ROLE');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO access_review_signoff (reviewer_person, reviewer_role, period_from, period_to, row_count, csv_sha256, notes, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.actor.personId, role, from.toISOString(), to.toISOString(), input.rowCount, input.csvSha256, notes, now.toISOString()],
      );
      const signoffId = rows[0]?.id ?? '';
      return {
        result: { signoffId },
        audit: { subjectId: signoffId, reasonCode: 'ACCESS_REVIEW_SIGNED', after: { periodFrom: from.toISOString(), periodTo: to.toISOString(), rowCount: input.rowCount, csvSha256: input.csvSha256 } },
      };
    },
  };
}
