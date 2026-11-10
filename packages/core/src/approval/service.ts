// Maker-checker approvals (docs/02 Dual approval).
// - maker ≠ checker (service + DB CHECK), checker must hold the checker cell
//   of the matrix for this subject (agents hold none ⇒ never checkers).
// - payload_hash pins exactly what was approved; approvals are single-use.
// - Threshold: approvals.payout_high_value_minor; unset ⇒ every payout is dual.
// - Unavailable approver ⇒ escalation (P07), never a bypass.
import type { Currency, Queryable } from '@chema/shared';
import type { Command, CommandTx } from '../command/bus';
import { CHECKER_ACTION, type Action } from '../authz/matrix';
import type { Actor, Subject } from '../authz/types';
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
}

const SELECT = `SELECT id, action, subject_type, subject_id, wallet_id, payload_hash, amount_minor::text AS amount_minor,
                       currency, maker_id, checker_id, decision, consumed_at FROM approval`;

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
}

/** Called from inside a maker command handler (so it is authorised + audited by the bus). */
export async function createApproval(tx: CommandTx, maker: Actor, req: ApprovalRequest): Promise<string> {
  if (!CHECKER_ACTION[req.action]) throw new ConflictError('NOT_AN_APPROVABLE_ACTION');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO approval (action, subject_type, subject_id, wallet_id, payload_hash, amount_minor, currency, maker_id, maker_role)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9) RETURNING id`,
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
