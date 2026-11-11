// Payees (docs/08): manual entry of a mobile-money number by the wallet
// admin/approver (step-up), provider name check, dual approval of the
// destination. A change of destination is a NEW payee that retires the old one
// when it activates; a payee is never edited.
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  ValidationError,
  consumeApprovalFor,
  createApproval,
  grantWalletRole,
  loadApproval,
  sealString,
  type Command,
} from '@chema/core';
import { loadWallet, normaliseName } from '@chema/wallet';
import { cancelUnsubmitted } from './payouts';
import {
  destinationAad,
  destinationHash,
  isUuid,
  listPayees,
  loadPayee,
  maskDestination,
  payeeView,
  type PayoutDeps,
} from './store';
import { PAYOUT_RAILS, includes, type PayeeView, type PayoutRail } from './types';

const E164 = /^\+[1-9][0-9]{6,14}$/;

export interface AddPayeeInput {
  walletId: string;
  label: string;
  holderName: string;
  rail: PayoutRail;
  /** Mobile-money number, E.164. */
  destination: string;
  /** The person this payee is (e.g. the approved benefit recipient). Optional. */
  personId?: string;
  /** Destination change: the ACTIVE payee this one replaces on activation. */
  replacesPayeeId?: string;
}

/** What the checker approves: pinned in the approval's payload hash. */
export function payeePayload(p: { id: string; rail: string; holderName: string; destinationHash: string; personId: string | null; replaces: string | null }) {
  return { payeeId: p.id, rail: p.rail, holderName: p.holderName, destination: p.destinationHash, personId: p.personId, replaces: p.replaces };
}

/** Provider name ≈ holder name: same name words, any order, titles ignored. */
export function namesMatch(holder: string, registered: string): boolean {
  const a = normaliseName(holder);
  return a.length > 0 && a === normaliseName(registered);
}

export function payeeCommands(deps: PayoutDeps) {
  const add: Command<AddPayeeInput, { payee: PayeeView; approvalId: string }> = {
    name: 'payee.add',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.change_payout_destination', subject: { type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by } };
    },
    async run(tx, input, ctx) {
      const label = input.label?.trim() ?? '';
      const holder = input.holderName?.trim() ?? '';
      if (label.length < 1 || label.length > 80) throw new ValidationError('label must be 1–80 characters');
      if (holder.length < 1 || holder.length > 120) throw new ValidationError('holderName must be 1–120 characters');
      if (!includes(PAYOUT_RAILS, input.rail)) throw new ValidationError('rail cannot pay out');
      if (!E164.test(input.destination ?? '')) throw new ValidationError('destination must be E.164');
      const w = await loadWallet(tx, input.walletId, true);
      if (w.status !== 'ACTIVE' && w.status !== 'CLOSING') throw new ConflictError('WALLET_NOT_ACTIVE');
      if (input.personId !== undefined) {
        if (!isUuid(input.personId)) throw new ValidationError('personId must be a uuid');
        const { rows } = await tx.query(
          `SELECT 1 FROM wallet_role WHERE wallet_id = $1 AND person_id = $2 AND role <> 'AGENT' AND revoked_at IS NULL
           UNION SELECT 1 FROM fidelity_link WHERE wallet_id = $1 AND approved_recipient = $2`,
          [w.id, input.personId],
        );
        // A payee is tied to a person only when that person is on the case: never inferred.
        if (rows.length === 0) throw new ConflictError('PERSON_NOT_ON_WALLET');
      }
      if (input.replacesPayeeId !== undefined) {
        const old = await loadPayee(tx, input.replacesPayeeId, true);
        if (old.wallet_id !== w.id || old.status !== 'ACTIVE') throw new ConflictError('REPLACED_PAYEE_NOT_ACTIVE');
      }
      const id = randomUUID();
      const hash = destinationHash(deps.keys, input.destination);
      const { rows: dup } = await tx.query(
        `SELECT 1 FROM payee WHERE wallet_id = $1 AND destination_hash = $2 AND status IN ('PENDING', 'ACTIVE')`,
        [w.id, hash],
      );
      if (dup.length) throw new ConflictError('DESTINATION_ALREADY_REGISTERED');
      const approvalId = await createApproval(tx, ctx.actor, {
        createdAt: deps.clock(),
        action: 'wallet.change_payout_destination',
        subjectType: 'payee',
        subjectId: id,
        walletId: w.id,
        payload: payeePayload({ id, rail: input.rail, holderName: holder, destinationHash: hash, personId: input.personId ?? null, replaces: input.replacesPayeeId ?? null }),
      });
      const now = deps.clock();
      await tx.query(
        `INSERT INTO payee (id, wallet_id, label, holder_name, person_id, rail, destination_sealed, destination_hash, destination_masked,
                            approval_id, replaces_payee, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11::uuid, $12, $13)`,
        [
          id,
          w.id,
          label,
          holder,
          input.personId ?? null,
          input.rail,
          sealString(deps.keys.destination, input.destination, destinationAad(id)),
          hash,
          maskDestination(input.destination),
          approvalId,
          input.replacesPayeeId ?? null,
          ctx.actor.personId,
          now.toISOString(),
        ],
      );
      const payee = payeeView(await loadPayee(tx, id));
      return { result: { payee, approvalId }, audit: { subjectId: id, approvalRef: approvalId, after: { rail: input.rail, destination: payee.destination } } };
    },
  };

  /** SYSTEM: store the provider's name check (outside any tx the service called lookupAccountName). */
  const recordVerification: Command<{ payeeId: string; registeredName: string | null; unavailable?: boolean }, { verification: string }> = {
    name: 'payee.record_verification',
    async resolve(q, input) {
      const p = await loadPayee(q, input.payeeId);
      return { action: 'payout.process', subject: { type: 'payee', id: p.id, walletId: p.wallet_id } };
    },
    async run(tx, input) {
      const p = await loadPayee(tx, input.payeeId, true);
      if (p.status !== 'PENDING') return { result: { verification: p.verification ?? 'NONE' }, audit: { reasonCode: 'NOT_PENDING' } };
      const v = input.unavailable ? 'UNAVAILABLE' : input.registeredName && namesMatch(p.holder_name, input.registeredName) ? 'MATCH' : 'MISMATCH';
      await tx.query('UPDATE payee SET verification = $2, verified_at = $3, updated_at = now() WHERE id = $1', [p.id, v, deps.clock().toISOString()]);
      return { result: { verification: v }, audit: { reasonCode: v } };
    },
  };

  /**
   * SYSTEM: move a PENDING payee on once both facts are in: a name MATCH and an
   * APPROVED destination approval ⇒ ACTIVE (and the replaced payee RETIRED);
   * a MISMATCH or a REJECTED approval ⇒ REJECTED. Idempotent.
   */
  const advance: Command<{ payeeId: string }, { status: PayeeView['status'] }> = {
    name: 'payee.advance',
    async resolve(q, input) {
      const p = await loadPayee(q, input.payeeId);
      return { action: 'payout.process', subject: { type: 'payee', id: p.id, walletId: p.wallet_id } };
    },
    async run(tx, input, ctx) {
      const p = await loadPayee(tx, input.payeeId, true);
      if (p.status !== 'PENDING') return { result: { status: p.status }, audit: { reasonCode: 'NOT_PENDING' } };
      const a = await loadApproval(tx, p.approval_id);
      const now = deps.clock().toISOString();
      const reject = async (reason: string) => {
        await tx.query(`UPDATE payee SET status = 'REJECTED', closed_at = $2, close_reason = $3, updated_at = now() WHERE id = $1`, [p.id, now, reason]);
        return { result: { status: 'REJECTED' as const }, audit: { reasonCode: reason } };
      };
      if (p.verification === 'MISMATCH') return reject('NAME_MISMATCH');
      if (a?.decision === 'REJECTED') return reject('APPROVAL_REJECTED');
      if (a?.decision !== 'APPROVED' || p.verification !== 'MATCH') return { result: { status: 'PENDING' }, audit: { reasonCode: 'WAITING' } };
      const { rows: hashRow } = await tx.query<{ destination_hash: string }>('SELECT destination_hash FROM payee WHERE id = $1', [p.id]);
      await consumeApprovalFor(tx, p.created_by, p.approval_id, {
        action: 'wallet.change_payout_destination',
        subjectType: 'payee',
        subjectId: p.id,
        payload: payeePayload({ id: p.id, rail: p.rail, holderName: p.holder_name, destinationHash: hashRow[0]?.destination_hash ?? '', personId: p.person_id, replaces: p.replaces_payee }),
      });
      if (p.replaces_payee) {
        await tx.query(
          `UPDATE payee SET status = 'RETIRED', closed_at = $2, close_reason = 'REPLACED', updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`,
          [p.replaces_payee, now],
        );
        // Unsubmitted payouts to the old destination must not go out: cancelled, reservations released.
        await cancelUnsubmitted(tx, ctx.actor, { walletId: p.wallet_id, payeeId: p.replaces_payee }, 'PAYEE_REPLACED', deps.clock());
      }
      await tx.query(`UPDATE payee SET status = 'ACTIVE', activated_at = $2, updated_at = now() WHERE id = $1`, [p.id, now]);
      // A payee bound to a family member makes them a payout recipient (own role row, never inferred).
      if (p.person_id) {
        await grantWalletRole(tx, { walletId: p.wallet_id, personId: p.person_id, role: 'PAYOUT_RECIPIENT', source: 'PAYEE_ACTIVE', grantedBy: p.created_by });
      }
      return { result: { status: 'ACTIVE' }, audit: { approvalRef: p.approval_id, reasonCode: 'ACTIVATED' } };
    },
  };

  const list: Command<{ walletId: string }, PayeeView[]> = {
    name: 'payee.list',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'payee.view', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      return { result: (await listPayees(tx, input.walletId)).map(payeeView) };
    },
  };

  return { add, recordVerification, advance, list };
}
