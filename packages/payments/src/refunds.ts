// Refunds (docs/04 §8, D11). `refund.policy` is unset, so every refund is a
// manual case with maker-checker: an ops/finance maker requests, a different
// ops/finance checker approves, the maker executes with the approval.
//
// Executing moves the money out of the wallet into REFUND_CLEARING at once
// (it is no longer spendable), then asks the provider. The refund is
// COMPLETED only when the provider confirms; a refusal reverses the debit.
import {
  consumeApproval,
  ConflictError,
  createApproval,
  NotFoundError,
  ValidationError,
  type Command,
} from '@chema/core';
import { ensureSystemAccount, post } from '@chema/ledger';
import { money, type Money } from '@chema/shared';
import type { PaymentDeps } from './collect';
import { compensated, creditedNet, failRefund } from './events';
import { openCase } from './exceptions';
import { isUuid, loadPayment } from './store';

export interface RefundInput {
  paymentId: string;
  amount: Money;
  reason: string;
  /** Absent ⇒ open the case and ask for approval. Present ⇒ execute that approval. */
  approvalId?: string;
}

export type RefundResultView =
  | { status: 'PENDING_APPROVAL'; approvalId: string; caseId: string }
  | { status: 'SUBMITTING'; refundId: string };

function approvalPayload(input: RefundInput) {
  return { paymentId: input.paymentId, minor: input.amount.minor.toString(), ccy: input.amount.ccy, reason: input.reason.trim() };
}

export function refundCommands(deps: PaymentDeps) {
  const request: Command<RefundInput, RefundResultView> = {
    name: 'payment.refund',
    async resolve(q, input) {
      const p = await loadPayment(q, input.paymentId);
      if (!p) throw new NotFoundError('payment', input.paymentId);
      return {
        action: 'payment.refund',
        subject: { type: 'payment', id: p.id, walletId: p.wallet_id, amountMinor: input.amount.minor },
      };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      if (!input.reason.trim()) throw new ValidationError('reason required');
      if (input.amount.minor <= 0n) throw new ValidationError('bad amount');
      const p = await loadPayment(tx, input.paymentId, { lock: true });
      if (!p) throw new NotFoundError('payment', input.paymentId);
      if (p.state !== 'SUCCEEDED' || !p.credit_journal_id) throw new ConflictError('NOT_REFUNDABLE');
      if (input.amount.ccy !== p.currency) throw new ValidationError('currency mismatch');
      const remaining = (await creditedNet(tx, p)) - (await compensated(tx, p.id));
      if (input.amount.minor > remaining) throw new ConflictError('REFUND_EXCEEDS_REMAINING');

      if (input.approvalId === undefined) {
        const approvalId = await createApproval(tx, ctx.actor, {
          action: 'payment.refund',
          subjectType: 'payment',
          subjectId: p.id,
          walletId: p.wallet_id,
          payload: approvalPayload(input),
          amount: input.amount,
        });
        const caseId = await openCase(
          tx,
          { type: 'REFUND', walletId: p.wallet_id, paymentId: p.id, externalRef: `approval:${approvalId}`, summary: input.reason.trim().slice(0, 500), openedBy: ctx.actor.personId },
          now,
        );
        return { result: { status: 'PENDING_APPROVAL', approvalId, caseId }, audit: { approvalRef: approvalId, txnRef: `payment:${p.id}` } };
      }

      if (!isUuid(input.approvalId)) throw new NotFoundError('approval', input.approvalId);
      await consumeApproval(tx, ctx.actor, input.approvalId, {
        action: 'payment.refund',
        subjectType: 'payment',
        subjectId: p.id,
        payload: approvalPayload(input),
      });
      const { rows: cases } = await tx.query<{ id: string }>(
        "SELECT id FROM case_record WHERE case_type = 'REFUND' AND external_ref = $1",
        [`approval:${input.approvalId}`],
      );
      const caseId = cases[0]?.id;
      if (!caseId) throw new NotFoundError('case', `approval:${input.approvalId}`);

      const refundClearing = await ensureSystemAccount(tx, 'REFUND_CLEARING', p.currency);
      const amount = money(input.amount.minor, p.currency);
      const debit = await post(tx, ctx.actor, {
        idempotencyKey: `refund:${input.approvalId}:debit`,
        kind: 'REFUND',
        approvalRef: input.approvalId,
        entries: [
          { accountId: p.credit_account_id, side: 'D', amount, txnRef: `payment:${p.id}` },
          { accountId: refundClearing.id, side: 'C', amount, txnRef: `payment:${p.id}` },
        ],
      });
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO refund (payment_id, case_id, amount_minor, currency, reason, approval_ref, requested_by, debit_journal_id, created_at)
         VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [p.id, caseId, amount.minor.toString(), p.currency, input.reason.trim(), input.approvalId, ctx.actor.personId, debit.journalId, now.toISOString()],
      );
      const refundId = rows[0]?.id;
      if (!refundId) throw new Error('refund not written');
      return {
        result: { status: 'SUBMITTING', refundId },
        audit: { subjectId: p.id, approvalRef: input.approvalId, txnRef: `refund:${refundId}` },
      };
    },
  };

  /** Record the provider's answer to refund(). SYSTEM only. */
  const recordSubmission: Command<
    { refundId: string; outcome: { kind: 'ACCEPTED'; providerRef: string } | { kind: 'REJECTED'; reason: string } },
    { refundId: string; state: 'PENDING_PROVIDER' | 'FAILED' | 'UNCHANGED' }
  > = {
    name: 'payment.refund_submission',
    async resolve(q, input) {
      if (!isUuid(input.refundId)) throw new NotFoundError('refund', String(input.refundId));
      const { rows } = await q.query<{ id: string }>('SELECT id FROM refund WHERE id = $1', [input.refundId]);
      if (!rows[0]) throw new NotFoundError('refund', input.refundId);
      return { action: 'payment.process', subject: { type: 'refund', id: input.refundId } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const { rows } = await tx.query<{ id: string; debit_journal_id: string; provider_ref: string | null; completed_at: Date | null; failed_at: Date | null }>(
        'SELECT id, debit_journal_id, provider_ref, completed_at, failed_at FROM refund WHERE id = $1 FOR UPDATE',
        [input.refundId],
      );
      const r = rows[0];
      if (!r) throw new NotFoundError('refund', input.refundId);
      if (r.provider_ref !== null || r.completed_at || r.failed_at) {
        return { result: { refundId: r.id, state: 'UNCHANGED' } };
      }
      if (input.outcome.kind === 'ACCEPTED') {
        await tx.query('UPDATE refund SET provider_ref = $2, updated_at = now() WHERE id = $1', [r.id, input.outcome.providerRef]);
        return { result: { refundId: r.id, state: 'PENDING_PROVIDER' }, audit: { txnRef: `refund:${r.id}` } };
      }
      await failRefund(tx, { actor: ctx.actor, now }, r, input.outcome.reason);
      return { result: { refundId: r.id, state: 'FAILED' }, audit: { txnRef: `refund:${r.id}`, reasonCode: 'REFUND_REJECTED' } };
    },
  };

  return { request, recordSubmission };
}
