// Maker-checker approvals (docs/02 Dual approval).
// - maker ≠ checker (service + DB CHECK), checker must hold the checker cell
//   of the matrix for this subject (agents hold none ⇒ never checkers).
// - payload_hash pins exactly what was approved; approvals are single-use.
// - Threshold: approvals.payout_high_value_minor; unset ⇒ every payout is dual.
// - Unavailable approver ⇒ escalation (P07), never a bypass.
import type { Currency, Queryable } from '@chema/shared';
import type { Command, CommandTx } from '../command/bus';
import { CHECKER_ACTION, ESCALATION_ROLE, type Action } from '../authz/matrix';
import type { Actor, StaffRole, Subject } from '../authz/types';
import { actorRoleLabel } from '../authz/types';
import { canonicalJson, sha256Hex } from '../crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors';
import { one } from '../db';

/** Always dual regardless of amount (docs/02). */
export const ALWAYS_DUAL: ReadonlySet<Action> = new Set<Action>([
  'wallet.change_payout_destination',
  'wallet.replace_admin',
  'ledger.adjust',
  'config.change',
  'mandate.change',
  'hold.release',
  'payout.override',
]);

export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** Does this maker action need a checker? Unknown/unset ⇒ yes (safest). */
export function requiresDual(action: Action, amountMinor: bigint | null, threshold: bigint | null): boolean {
  if (ALWAYS_DUAL.has(action)) return true;
  if (action === 'payout.request') {
    if (threshold === null || amountMinor === null) return true;
    return amountMinor > threshold;
  }
  return true;
}

export interface ApprovalRow {
  id: string;
  action: Action;
  subject_type: string;
  subject_id: string;
  wallet_id: string | null;
  payload_hash: string;
  amount_minor: string | null;
  currency: Currency | null;
  maker_id: string;
  checker_id: string | null;
  decision: 'APPROVED' | 'REJECTED' | null;
  consumed_at: Date | null;
  created_at: Date;
  escalated_at: Date | null;
  escalated_to: StaffRole | null;
}

const SELECT = `SELECT id, action, subject_type, subject_id, wallet_id, payload_hash, amount_minor::text AS amount_minor,
                       currency, maker_id, checker_id, decision, consumed_at, created_at, escalated_at, escalated_to FROM approval`;

export async function loadApproval(q: Queryable, id: string): Promise<ApprovalRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const { rows } = await q.query<ApprovalRow>(`${SELECT} WHERE id = $1`, [id]);
  return rows[0];
}

export interface ApprovalRequest {
  action: Action;
  subjectType: string;
  subjectId: string;
  walletId?: string;
  payload: unknown;
  amount?: { minor: bigint; ccy: Currency };
  /** The maker's clock (escalation timing); defaults to the database's now(). */
  createdAt?: Date;
}

/** Called from inside a maker command handler (so it is authorised + audited by the bus). */
export async function createApproval(tx: CommandTx, maker: Actor, req: ApprovalRequest): Promise<string> {
  if (!CHECKER_ACTION[req.action]) throw new ConflictError('NOT_AN_APPROVABLE_ACTION');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO approval (action, subject_type, subject_id, wallet_id, payload_hash, amount_minor, currency, maker_id, maker_role, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, COALESCE($10::timestamptz, now())) RETURNING id`,
    [
      req.action,
      req.subjectType,
      req.subjectId,
      req.walletId ?? null,
      payloadHash(req.payload),
      req.amount ? req.amount.minor.toString() : null,
      req.amount?.ccy ?? null,
      maker.personId,
      actorRoleLabel(maker),
      req.createdAt?.toISOString() ?? null,
    ],
  );
  return one(rows, 'approval insert').id;
}

export interface ApprovalExpectation {
  action: Action;
  subjectType: string;
  subjectId: string;
  payload: unknown;
}

/**
 * Consume an APPROVED approval for exactly this action/subject/payload, once.
 * The caller must be the maker (the checker never executes their own check).
 */
export async function consumeApproval(
  tx: CommandTx,
  actor: Actor,
  approvalId: string,
  expect: ApprovalExpectation,
): Promise<void> {
  await consumeApprovalFor(tx, actor.personId, approvalId, expect);
}

/** Same as consumeApproval for callers outside the bus that audit themselves (FlagService). */
export async function consumeApprovalFor(
  tx: Queryable,
  makerId: string,
  approvalId: string,
  expect: ApprovalExpectation,
): Promise<void> {
  const row = await loadApproval(tx, approvalId);
  if (!row) throw new NotFoundError('approval', approvalId);
  if (row.action !== expect.action || row.subject_type !== expect.subjectType || row.subject_id !== expect.subjectId) {
    throw new ForbiddenError('APPROVAL_MISMATCH');
  }
  if (row.payload_hash !== payloadHash(expect.payload)) throw new ForbiddenError('APPROVAL_PAYLOAD_MISMATCH');
  if (row.decision !== 'APPROVED') throw new ForbiddenError('NOT_APPROVED');
  if (row.maker_id !== makerId) throw new ForbiddenError('NOT_MAKER');
  const { rows } = await tx.query(
    'UPDATE approval SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
    [approvalId],
  );
  if (rows.length !== 1) throw new ConflictError('APPROVAL_ALREADY_USED');
}

export interface DecideInput {
  approvalId: string;
  decision: 'APPROVED' | 'REJECTED';
  reasonCode?: string;
}

/** Checker decision. Authorised against the checker cell (e.g. payout.approve) for this subject. */
export const decideApproval: Command<DecideInput, { approvalId: string; decision: 'APPROVED' | 'REJECTED' }> = {
  name: 'approval.decide',
  async resolve(q, input) {
    const row = await loadApproval(q, input.approvalId);
    if (!row) throw new NotFoundError('approval', input.approvalId);
    const action = CHECKER_ACTION[row.action];
    if (!action) throw new NotFoundError('approval', input.approvalId);
    const subject: Subject = {
      type: 'approval',
      id: row.id,
      makerPersonId: row.maker_id,
      ...(row.wallet_id ? { walletId: row.wallet_id } : {}),
      ...(row.amount_minor !== null ? { amountMinor: BigInt(row.amount_minor) } : {}),
      ...(row.escalated_to ? { escalatedTo: row.escalated_to } : {}),
    };
    return { action, subject };
  },
  async run(tx, input, ctx) {
    const { rows } = await tx.query(
      `UPDATE approval SET checker_id = $2, checker_role = $3, decision = $4, reason_code = $5, decided_at = now()
        WHERE id = $1 AND decision IS NULL AND maker_id <> $2 RETURNING id`,
      [input.approvalId, ctx.actor.personId, actorRoleLabel(ctx.actor), input.decision, input.reasonCode ?? null],
    );
    if (rows.length !== 1) throw new ConflictError('ALREADY_DECIDED');
    return {
      result: { approvalId: input.approvalId, decision: input.decision },
      audit: { approvalRef: input.approvalId, after: { decision: input.decision }, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}) },
    };
  },
};

/** Hours an approval waits for the family checker before its maker may escalate it. */
export const ESCALATE_AFTER_HOURS = 24;

export interface EscalateInput {
  approvalId: string;
  reason: string;
}

/**
 * Unavailable approver => escalation path, never a bypass (docs/02). The maker
 * hands an undecided approval to a distinct staff role (ESCALATION_ROLE); the
 * family checker may still decide it until someone does. Allowed after
 * ESCALATE_AFTER_HOURS, or at once when the wallet has no other live ADMIN /
 * APPROVER who could check it (looked up here, never trusted from the client).
 */
export function escalateApproval(
  clock: () => Date = () => new Date(),
): Command<EscalateInput, { approvalId: string; escalatedTo: StaffRole }> {
  return {
    name: 'approval.escalate',
    async resolve(q, input) {
      const row = await loadApproval(q, input.approvalId);
      if (!row) throw new NotFoundError('approval', input.approvalId);
      return {
        action: 'approval.escalate',
        subject: { type: 'approval', id: row.id, ownerPersonId: row.maker_id, ...(row.wallet_id ? { walletId: row.wallet_id } : {}) },
      };
    },
    async guard(q, input) {
      const row = await loadApproval(q, input.approvalId);
      return row && ESCALATION_ROLE[row.action] ? null : 'NOT_ESCALATABLE';
    },
    async run(tx, input, ctx) {
      const reason = (input.reason ?? '').trim();
      if (reason.length < 10 || reason.length > 500) throw new ConflictError('REASON_REQUIRED');
      const row = await loadApproval(tx, input.approvalId);
      if (!row) throw new NotFoundError('approval', input.approvalId);
      const to = ESCALATION_ROLE[row.action];
      if (!to) throw new ConflictError('NOT_ESCALATABLE');
      if (row.decision !== null) throw new ConflictError('ALREADY_DECIDED');
      if (row.escalated_at !== null) throw new ConflictError('ALREADY_ESCALATED');
      const now = clock();
      const waited = now.getTime() - new Date(row.created_at).getTime() >= ESCALATE_AFTER_HOURS * 3_600_000;
      let noChecker = false;
      if (!waited && row.wallet_id) {
        const { rows } = await tx.query(
          `SELECT 1 FROM wallet_role WHERE wallet_id = $1 AND role IN ('ADMIN', 'APPROVER') AND person_id <> $2
              AND revoked_at IS NULL LIMIT 1`,
          [row.wallet_id, row.maker_id],
        );
        noChecker = rows.length === 0;
      }
      if (!waited && !noChecker) throw new ConflictError('TOO_EARLY_TO_ESCALATE');
      const { rows: done } = await tx.query(
        `UPDATE approval SET escalated_at = $2, escalated_by = $3, escalated_to = $4, escalation_reason = $5
          WHERE id = $1 AND decision IS NULL AND escalated_at IS NULL RETURNING id`,
        [row.id, now.toISOString(), ctx.actor.personId, to, reason],
      );
      if (done.length !== 1) throw new ConflictError('ALREADY_DECIDED');
      return {
        result: { approvalId: row.id, escalatedTo: to },
        audit: { approvalRef: row.id, reasonCode: noChecker ? 'NO_ELIGIBLE_CHECKER' : 'APPROVER_UNAVAILABLE', after: { escalatedTo: to } },
      };
    },
  };
}
