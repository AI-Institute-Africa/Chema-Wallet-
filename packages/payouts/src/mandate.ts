// Mandate changes (docs/02, docs/08): administrator replacement and the
// approver list. Each needs (1) the requester's step-up, (2) a family checker
// (or, when none is available, an escalated FIDELITY_ADMIN checker) and (3) an
// assigned community verifier's re-check of the authority evidence. Only then
// may the requester execute it. The wallet_guard trigger refuses any
// admin_person change outside the transaction that executes such a change.
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  consumeApproval,
  createApproval,
  loadApproval,
  type Action,
  type Command,
} from '@chema/core';
import type { Queryable } from '@chema/shared';
import { loadWallet } from '@chema/wallet';
import { cancelUnsubmitted } from './payouts';
import { isUuid, type PayoutDeps } from './store';
import { MANDATE_CHANGE_KINDS, MANDATE_VERIFY_REASONS, includes, type MandateChangeKind, type MandateVerifyReason } from './types';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export interface MandateChangeInput {
  walletId: string;
  kind: MandateChangeKind;
  /** REPLACE_ADMIN: the new administrator's phone (E.164). */
  newAdminPhone?: string;
  /** ADD_APPROVER: the approver's phone; REMOVE_APPROVER: their person id. */
  approverPhone?: string;
  approverPersonId?: string;
  reason: string;
  /** Authority evidence (scanned CLEAN, linked to the wallet). */
  evidenceDocs: string[];
}

export interface MandateChangeView {
  id: string;
  walletId: string;
  kind: MandateChangeKind;
  status: 'PENDING' | 'EXECUTED' | 'REJECTED' | 'CANCELLED';
  approvalId: string;
  approval: 'PENDING' | 'APPROVED' | 'REJECTED';
  verifier: 'PENDING' | 'APPROVED' | 'REJECTED';
  newAdminPerson: string | null;
  approverPerson: string | null;
  requestedBy: string;
}

interface ChangeRow {
  id: string;
  wallet_id: string;
  kind: MandateChangeKind;
  old_admin_person: string | null;
  new_admin_person: string | null;
  approver_person: string | null;
  evidence_docs: string[];
  requested_by: string;
  approval_id: string;
  status: MandateChangeView['status'];
  verifier_id: string | null;
  verifier_outcome: 'APPROVED' | 'REJECTED' | null;
}

const COLS = `id, wallet_id, kind, old_admin_person, new_admin_person, approver_person, evidence_docs, requested_by, approval_id,
  status, verifier_id, verifier_outcome`;

async function loadChange(q: Queryable, id: string, lock = false): Promise<ChangeRow> {
  if (!isUuid(id)) throw new NotFoundError('mandate_change', String(id));
  const { rows } = await q.query<ChangeRow>(`SELECT ${COLS} FROM mandate_change WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('mandate_change', id);
  return rows[0];
}

const actionFor = (kind: MandateChangeKind): Action => (kind === 'REPLACE_ADMIN' ? 'wallet.replace_admin' : 'mandate.change');

function payload(c: Pick<ChangeRow, 'id' | 'kind' | 'old_admin_person' | 'new_admin_person' | 'approver_person' | 'evidence_docs'>) {
  return { changeId: c.id, kind: c.kind, oldAdmin: c.old_admin_person, newAdmin: c.new_admin_person, approver: c.approver_person, evidence: [...c.evidence_docs].sort() };
}

async function view(q: Queryable, c: ChangeRow): Promise<MandateChangeView> {
  const a = await loadApproval(q, c.approval_id);
  return {
    id: c.id,
    walletId: c.wallet_id,
    kind: c.kind,
    status: c.status,
    approvalId: c.approval_id,
    approval: a?.decision ?? 'PENDING',
    verifier: c.verifier_outcome ?? 'PENDING',
    newAdminPerson: c.new_admin_person,
    approverPerson: c.approver_person,
    requestedBy: c.requested_by,
  };
}

async function personByPhone(q: Queryable, phone: string): Promise<string> {
  await q.query('INSERT INTO person (phone_e164) VALUES ($1) ON CONFLICT (phone_e164) DO NOTHING', [phone]);
  const { rows } = await q.query<{ id: string }>('SELECT id FROM person WHERE phone_e164 = $1', [phone]);
  if (!rows[0]) throw new Error('person not written');
  return rows[0].id;
}

export function mandateCommands(deps: PayoutDeps) {
  const request: Command<MandateChangeInput, MandateChangeView> = {
    name: 'mandate.request_change',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      if (!includes(MANDATE_CHANGE_KINDS, input.kind)) throw new NotFoundError('mandate_change_kind', String(input.kind));
      return { action: actionFor(input.kind), subject: { type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const reason = (input.reason ?? '').trim();
      if (reason.length < 10 || reason.length > 2000) throw new ValidationError('reason must be 10–2000 characters');
      if (!Array.isArray(input.evidenceDocs) || input.evidenceDocs.length < 1 || input.evidenceDocs.length > 10) {
        throw new ValidationError('1–10 evidence documents');
      }
      const w = await loadWallet(tx, input.walletId, true);
      if (!['ACTIVE', 'SUSPENDED', 'CLOSING'].includes(w.status)) throw new ConflictError('WALLET_NOT_ACTIVE');
      for (const d of input.evidenceDocs) {
        const { rows } = isUuid(d)
          ? await tx.query<{ malware_scan: string | null }>('SELECT malware_scan FROM document WHERE id = $1 AND linked_wallet = $2', [d, w.id])
          : { rows: [] };
        if (rows[0]?.malware_scan !== 'CLEAN') throw new ConflictError('EVIDENCE_NOT_CLEAN');
      }
      let oldAdmin: string | null = null;
      let newAdmin: string | null = null;
      let approver: string | null = null;
      const roleOf = async (person: string) => {
        const { rows } = await tx.query<{ role: string }>(
          `SELECT role FROM wallet_role WHERE wallet_id = $1 AND person_id = $2 AND revoked_at IS NULL AND role IN ('ADMIN', 'APPROVER')`,
          [w.id, person],
        );
        return rows.map((r) => r.role);
      };
      if (input.kind === 'REPLACE_ADMIN') {
        if (!E164.test(input.newAdminPhone ?? '')) throw new ValidationError('newAdminPhone must be E.164');
        oldAdmin = w.admin_person;
        newAdmin = await personByPhone(tx, input.newAdminPhone as string);
        if (newAdmin === oldAdmin) throw new ConflictError('SAME_ADMIN');
      } else if (input.kind === 'ADD_APPROVER') {
        if (!E164.test(input.approverPhone ?? '')) throw new ValidationError('approverPhone must be E.164');
        approver = await personByPhone(tx, input.approverPhone as string);
        if ((await roleOf(approver)).length) throw new ConflictError('ALREADY_HOLDS_AUTHORITY');
      } else {
        if (!isUuid(input.approverPersonId)) throw new ValidationError('approverPersonId required');
        approver = input.approverPersonId;
        if (!(await roleOf(approver)).includes('APPROVER')) throw new ConflictError('NOT_AN_APPROVER');
      }
      const id = randomUUID();
      const shaped = { id, kind: input.kind, old_admin_person: oldAdmin, new_admin_person: newAdmin, approver_person: approver, evidence_docs: input.evidenceDocs };
      const approvalId = await createApproval(tx, ctx.actor, {
        createdAt: deps.clock(), action: actionFor(input.kind), subjectType: 'mandate_change', subjectId: id, walletId: w.id, payload: payload(shaped) });
      try {
        await tx.query(
          `INSERT INTO mandate_change (id, wallet_id, kind, old_admin_person, new_admin_person, approver_person, reason, evidence_docs,
                                       requested_by, requested_at, approval_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10, $11)`,
          [id, w.id, input.kind, oldAdmin, newAdmin, approver, reason, input.evidenceDocs, ctx.actor.personId, now.toISOString(), approvalId],
        );
      } catch (err) {
        if (String((err as Error).message).includes('mandate_change_open')) throw new ConflictError('CHANGE_ALREADY_OPEN');
        throw err;
      }
      return { result: await view(tx, await loadChange(tx, id)), audit: { subjectId: id, approvalRef: approvalId, reasonCode: input.kind } };
    },
  };

  /** Assigned community verifier, not a party, re-checks the authority evidence. */
  const verify: Command<{ changeId: string; outcome: 'APPROVED' | 'REJECTED'; reasonCode: MandateVerifyReason; note?: string }, MandateChangeView> = {
    name: 'mandate.verify',
    async resolve(q, input) {
      const c = await loadChange(q, input.changeId);
      return { action: 'mandate.verify', subject: { type: 'mandate_change', id: c.id, walletId: c.wallet_id, createdByPersonId: c.requested_by } };
    },
    async guard(q, input, actor) {
      const c = await loadChange(q, input.changeId);
      const parties = [c.requested_by, c.old_admin_person, c.new_admin_person, c.approver_person];
      return parties.includes(actor.personId) ? 'VERIFIER_IS_PARTY' : null;
    },
    async run(tx, input, ctx) {
      if (input.outcome !== 'APPROVED' && input.outcome !== 'REJECTED') throw new ValidationError('bad outcome');
      if (!includes(MANDATE_VERIFY_REASONS, input.reasonCode)) throw new ValidationError('bad reason code');
      if ((input.outcome === 'APPROVED') !== (input.reasonCode === 'AUTHORITY_SHOWN')) throw new ValidationError('reason code does not fit outcome');
      if (input.outcome === 'REJECTED' && (input.note ?? '').trim().length < 10) throw new ValidationError('note required on rejection');
      const c = await loadChange(tx, input.changeId, true);
      if (c.status !== 'PENDING' || c.verifier_outcome) throw new ConflictError('ALREADY_VERIFIED');
      const now = deps.clock().toISOString();
      await tx.query(
        `UPDATE mandate_change SET verifier_id = $2, verifier_outcome = $3, verifier_reason_code = $4, verifier_note = $5, verified_at = $6,
                status = CASE WHEN $3 = 'REJECTED' THEN 'REJECTED' ELSE status END,
                closed_at = CASE WHEN $3 = 'REJECTED' THEN $6::timestamptz END,
                close_reason = CASE WHEN $3 = 'REJECTED' THEN 'VERIFIER_REJECTED' END,
                updated_at = now()
          WHERE id = $1`,
        [c.id, ctx.actor.personId, input.outcome, input.reasonCode, input.note?.trim() || null, now],
      );
      return { result: await view(tx, await loadChange(tx, c.id)), audit: { reasonCode: input.reasonCode } };
    },
  };

  /** The requester runs the change once the checker AND the verifier approved it. */
  const execute: Command<{ changeId: string }, MandateChangeView> = {
    name: 'mandate.execute',
    async resolve(q, input) {
      const c = await loadChange(q, input.changeId);
      return { action: 'mandate.execute', subject: { type: 'mandate_change', id: c.id, walletId: c.wallet_id } };
    },
    async guard(q, input, actor) {
      const c = await loadChange(q, input.changeId);
      return c.requested_by === actor.personId ? null : 'NOT_REQUESTER';
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const c = await loadChange(tx, input.changeId, true);
      if (c.status !== 'PENDING') throw new ConflictError(`CHANGE_${c.status}`);
      const a = await loadApproval(tx, c.approval_id);
      if (a?.decision === 'REJECTED') {
        await tx.query(`UPDATE mandate_change SET status = 'REJECTED', closed_at = $2, close_reason = 'CHECKER_REJECTED', updated_at = now() WHERE id = $1`, [c.id, now.toISOString()]);
        return { result: await view(tx, await loadChange(tx, c.id)), audit: { reasonCode: 'CHECKER_REJECTED' } };
      }
      if (a?.decision !== 'APPROVED') throw new ConflictError('AWAITING_CHECKER');
      if (c.verifier_outcome !== 'APPROVED') throw new ConflictError('AWAITING_VERIFIER');
      await consumeApproval(tx, ctx.actor, c.approval_id, { action: actionFor(c.kind), subjectType: 'mandate_change', subjectId: c.id, payload: payload(c) });
      const w = await loadWallet(tx, c.wallet_id, true);
      const revoke = (person: string, role: string) =>
        tx.query(
          `UPDATE wallet_role SET revoked_at = $4, revoked_by = $5, updated_at = now()
            WHERE wallet_id = $1 AND person_id = $2 AND role = $3 AND revoked_at IS NULL`,
          [c.wallet_id, person, role, now.toISOString(), ctx.actor.personId],
        );
      const grant = (person: string, role: string) =>
        tx.query(`INSERT INTO wallet_role (wallet_id, person_id, role, granted_by) VALUES ($1, $2, $3, $4)`, [c.wallet_id, person, role, ctx.actor.personId]);

      let newMandate: string | null = null;
      if (c.kind === 'REPLACE_ADMIN') {
        if (w.admin_person !== c.old_admin_person) throw new ConflictError('ADMIN_CHANGED_SINCE_REQUEST');
        const { rows: bound } = await tx.query(
          'SELECT 1 FROM identity_binding WHERE person_id = $1 AND verified_at IS NOT NULL AND revoked_at IS NULL',
          [c.new_admin_person],
        );
        // Phone number alone is never proof (docs/02): the new admin must have confirmed it by OTP.
        if (bound.length === 0) throw new ConflictError('NEW_ADMIN_NOT_CONFIRMED');
        // One live mandate per wallet: supersede the old one, then record the new admin's.
        await tx.query(`UPDATE mandate SET superseded_at = $2, updated_at = now() WHERE wallet_id = $1 AND superseded_at IS NULL`, [
          c.wallet_id,
          now.toISOString(),
        ]);
        const { rows: m } = await tx.query<{ id: string }>(
          `INSERT INTO mandate (wallet_id, admin_person, evidence_docs, approved_by, approved_at, created_at)
           SELECT $1, $2, $3::uuid[], verifier_id, $4, $4 FROM mandate_change WHERE id = $5 RETURNING id`,
          [c.wallet_id, c.new_admin_person, c.evidence_docs, now.toISOString(), c.id],
        );
        newMandate = m[0]?.id ?? null;
      }
      // Executed first: the wallet_guard accepts the admin change only inside this transaction.
      await tx.query(
        `UPDATE mandate_change SET status = 'EXECUTED', closed_at = $2, close_reason = 'EXECUTED', executed_txid = txid_current(),
                new_mandate_id = $3::uuid, updated_at = now() WHERE id = $1`,
        [c.id, now.toISOString(), newMandate],
      );
      if (c.kind === 'REPLACE_ADMIN') {
        await tx.query('UPDATE wallet SET admin_person = $2, updated_at = now() WHERE id = $1', [c.wallet_id, c.new_admin_person]);
        await revoke(c.old_admin_person as string, 'ADMIN');
        await grant(c.new_admin_person as string, 'ADMIN');
        // The old admin's unsubmitted requests lose their authority.
        await cancelUnsubmitted(tx, ctx.actor, { walletId: c.wallet_id, requestedBy: c.old_admin_person as string }, 'ADMIN_REPLACED', now);
      } else if (c.kind === 'ADD_APPROVER') {
        await grant(c.approver_person as string, 'APPROVER');
      } else {
        await revoke(c.approver_person as string, 'APPROVER');
      }
      return { result: await view(tx, await loadChange(tx, c.id)), audit: { approvalRef: c.approval_id, reasonCode: c.kind, after: { kind: c.kind } } };
    },
  };

  const get: Command<{ changeId: string }, MandateChangeView> = {
    name: 'mandate.view_change',
    async resolve(q, input) {
      const c = await loadChange(q, input.changeId);
      return { action: 'wallet.view', subject: { type: 'mandate_change', id: c.id, walletId: c.wallet_id } };
    },
    async run(tx, input) {
      return { result: await view(tx, await loadChange(tx, input.changeId)) };
    },
  };

  return { request, verify, execute, get };
}
