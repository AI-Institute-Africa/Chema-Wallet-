// Payout requests (docs/08). A plan = one or more parts (split payout), each
// its own payout_request with its own reservation, independently checked.
// Money leaves the wallet ONLY when the provider confirms: until then the
// request holds a reservation (unspendable, not paid). Sequence (no provider
// call inside a transaction):
//   request (tx: checks → reserve → approval)            [admin, step-up]
//   advance (tx: approval decided → APPROVED / REJECTED) [SYSTEM]
//   claimSubmit (tx: re-check blockers → SUBMITTING)     [SYSTEM]
//   adapter.payout()                                      (no tx)
//   recordSubmit (tx: SUBMITTED / RETRY / RAIL_DOWN / FAILED)
//   adapter.queryPayout() → applyStatus (tx: CONFIRMED posts the PAYOUT journal)
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  canonicalJson,
  consumeApproval,
  consumeApprovalFor,
  createApproval,
  loadApproval,
  openString,
  requiresDual,
  sha256Hex,
  type Actor,
  type Command,
  type CommandTx,
} from '@chema/core';
import { enqueueNotification } from '@chema/channels';
import {
  ensureSystemAccount,
  getBalances,
  listWalletAccounts,
  lockWallet,
  post,
  release,
  reserve,
  reverse,
  type LedgerAccount,
} from '@chema/ledger';
import { raiseException } from '@chema/payments';
import { money, parseMinor, type Currency, type Money, type Queryable } from '@chema/shared';
import { loadWallet } from '@chema/wallet';
import {
  applicableHold,
  benefitRouteOpen,
  destinationAad,
  emit,
  isUuid,
  loadPayee,
  loadPayout,
  mandateValid,
  PAYOUT_COLS,
  payoutView,
  submitBlocker,
  transitionPayout,
  type PayoutDeps,
  type PayoutRow,
} from './store';
import {
  PAYOUT_PURPOSES,
  PAYOUT_RETRY,
  PAYOUT_SOURCES,
  UNSUBMITTED,
  includes,
  type PayoutPurpose,
  type PayoutSource,
  type PayoutView,
} from './types';

export class PayoutCheckError extends ConflictError {
  constructor(readonly check: string) {
    super(check);
    this.name = 'PayoutCheckError';
  }
}

export interface PlanPart {
  payeeId: string;
  amountMinor: bigint;
  purpose: PayoutPurpose;
  note?: string;
}

export interface RequestPlanInput {
  walletId: string;
  source: { kind: PayoutSource; groupId?: string };
  currency: Currency;
  parts: readonly PlanPart[];
  idempotencyKey: string;
}

export interface PlanResult {
  planId: string;
  approvalId: string | null;
  payouts: PayoutView[];
  replayed: boolean;
}

function planHash(input: RequestPlanInput): string {
  return sha256Hex(
    canonicalJson({
      wallet: input.walletId,
      source: input.source,
      ccy: input.currency,
      parts: input.parts.map((p) => ({ payee: p.payeeId, minor: p.amountMinor, purpose: p.purpose, note: p.note ?? null })),
    }),
  );
}

/** What the checker approves for a plan; recomputed from the rows when it is consumed. */
export function planPayload(planId: string, rows: readonly Pick<PayoutRow, 'id' | 'payee_id' | 'amount_minor' | 'currency' | 'purpose' | 'source_kind' | 'source_qualifier'>[]) {
  return {
    planId,
    parts: rows.map((r) => ({ id: r.id, payee: r.payee_id, minor: r.amount_minor, ccy: r.currency, purpose: r.purpose, source: r.source_kind, group: r.source_qualifier })),
  };
}

async function planRows(q: Queryable, planId: string, lock = false): Promise<PayoutRow[]> {
  const { rows } = await q.query<PayoutRow>(
    `SELECT ${PAYOUT_COLS} FROM payout_request WHERE plan_id = $1 ORDER BY part_no${lock ? ' FOR UPDATE' : ''}`,
    [planId],
  );
  return rows;
}

function sourceAccount(accounts: LedgerAccount[], source: RequestPlanInput['source'], ccy: Currency): LedgerAccount | undefined {
  return accounts.find(
    (a) => a.kind === source.kind && a.currency === ccy && (source.kind === 'GROUP' ? a.qualifier === source.groupId : a.qualifier === null),
  );
}

/** Release the reservation (if still live) and close the request. */
async function closeUnpaid(
  tx: CommandTx,
  actor: Actor,
  row: PayoutRow,
  to: 'FAILED' | 'REJECTED' | 'CANCELLED',
  reason: string,
  now: Date,
): Promise<void> {
  await release(tx, actor, row.reservation_id, `payout ${to.toLowerCase()}: ${reason}`);
  await transitionPayout(tx, actor, row, to, { closed_at: now.toISOString(), close_reason: reason, lease_until: null, next_attempt_at: null }, { reasonCode: reason, now });
}

/**
 * Cancel every not-yet-submitted payout matching the filter (payee retired,
 * admin replaced, wallet cancelled). Submitted ones are left alone: that money
 * may already be moving and only the provider can say.
 */
export async function cancelUnsubmitted(
  tx: CommandTx,
  actor: Actor,
  filter: { walletId: string; payeeId?: string; requestedBy?: string },
  reason: string,
  now: Date,
): Promise<number> {
  const { rows } = await tx.query<PayoutRow>(
    `SELECT ${PAYOUT_COLS} FROM payout_request
      WHERE wallet_id = $1 AND status = ANY($2::text[])
        AND ($3::uuid IS NULL OR payee_id = $3) AND ($4::uuid IS NULL OR requested_by = $4)
      ORDER BY id FOR UPDATE`,
    [filter.walletId, UNSUBMITTED, filter.payeeId ?? null, filter.requestedBy ?? null],
  );
  for (const r of rows) {
    await closeUnpaid(tx, actor, r, 'CANCELLED', reason, now);
    await emit(tx, 'payout.failed', { payoutId: r.id, walletId: r.wallet_id, reason });
  }
  return rows.length;
}

async function notifyAdmin(tx: CommandTx, deps: PayoutDeps, walletId: string, template: 'payout.notice.confirmed' | 'payout.notice.failed', key: string, params: Record<string, string>): Promise<void> {
  const { rows } = await tx.query<{ admin_person: string }>('SELECT admin_person FROM wallet WHERE id = $1', [walletId]);
  const admin = rows[0]?.admin_person;
  if (!admin) return;
  // Delivery failure never affects payout state: the notification row retries on its own.
  await enqueueNotification(tx, deps.keys.notify, { template, channel: 'SMS', to: { personId: admin }, params, dedupeKey: key, walletId }, deps.clock());
}

function fmt(m: Money): string {
  const s = m.minor.toString().padStart(3, '0');
  return `${m.ccy} ${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function payoutCommands(deps: PayoutDeps) {
  const request: Command<RequestPlanInput, PlanResult> = {
    name: 'payout.request',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      let total = 0n;
      for (const p of input.parts ?? []) if (typeof p.amountMinor === 'bigint') total += p.amountMinor;
      return { action: 'payout.request', subject: { type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by, amountMinor: total } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      if (!includes(PAYOUT_SOURCES, input.source?.kind)) throw new ValidationError('bad source');
      if ((input.source.kind === 'GROUP') !== isUuid(input.source.groupId)) throw new ValidationError('groupId needed for GROUP only');
      if (!Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 10) throw new ValidationError('1–10 parts');
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
        throw new ValidationError('idempotencyKey must be 8–200 characters');
      }
      for (const p of input.parts) {
        if (typeof p.amountMinor !== 'bigint' || p.amountMinor <= 0n) throw new ValidationError('part amount must be positive');
        if (!includes(PAYOUT_PURPOSES, p.purpose)) throw new ValidationError('bad purpose');
        if (p.note !== undefined && p.note.length > 500) throw new ValidationError('note too long');
        if (!isUuid(p.payeeId)) throw new ValidationError('bad payeeId');
      }
      const hash = planHash(input);
      const { rows: prior } = await tx.query<{ id: string; request_hash: string }>(
        'SELECT id, request_hash FROM payout_plan WHERE idempotency_key = $1',
        [input.idempotencyKey],
      );
      if (prior[0]) {
        if (prior[0].request_hash !== hash) throw new ConflictError('IDEMPOTENCY_CONFLICT');
        const rows = await planRows(tx, prior[0].id);
        return { result: { planId: prior[0].id, approvalId: rows[0]?.approval_id ?? null, payouts: rows.map((r) => payoutView(r, null)), replayed: true }, audit: { reasonCode: 'REPLAY' } };
      }

      // docs/08 checks, in order. Each failure is a typed 409 naming the check.
      const w = await loadWallet(tx, input.walletId);
      if (w.status !== 'ACTIVE' && w.status !== 'CLOSING') throw new PayoutCheckError('WALLET_NOT_ACTIVE');
      if (!(await mandateValid(tx, w.id))) throw new PayoutCheckError('NO_MANDATE');
      // (step-up was consumed by the bus before this handler ran)
      if (input.currency !== w.currency) throw new PayoutCheckError('CURRENCY_MISMATCH');
      await lockWallet(tx, w.id);
      const account = sourceAccount(await listWalletAccounts(tx, w.id), input.source, input.currency);
      if (!account) throw new PayoutCheckError('NO_SUCH_SOURCE');
      const total = input.parts.reduce((s, p) => s + p.amountMinor, 0n);
      const bal = (await getBalances(tx, w.id)).find((b) => b.account.id === account.id);
      const sourceRef = { walletId: w.id, sourceKind: input.source.kind, sourceQualifier: input.source.groupId ?? null };
      if (!bal || total > bal.available.minor) {
        // Short only because money is held: name the hold, it is the actionable reason.
        if (bal && total <= bal.available.minor + bal.held.minor && (await applicableHold(tx, sourceRef))) throw new PayoutCheckError('HOLD_APPLIES');
        throw new PayoutCheckError('INSUFFICIENT_AVAILABLE');
      }
      const payees = [];
      for (const p of input.parts) {
        const payee = await loadPayee(tx, p.payeeId);
        if (payee.wallet_id !== w.id) throw new NotFoundError('payee', p.payeeId);
        payees.push(payee);
      }
      if (input.source.kind === 'FIDELITY_BENEFIT') {
        for (const payee of payees) {
          if (!(await benefitRouteOpen(tx, w.id, payee.person_id))) throw new PayoutCheckError('BENEFIT_ONLY_TO_APPROVED_RECIPIENT');
        }
      }
      if (await applicableHold(tx, sourceRef)) throw new PayoutCheckError('HOLD_APPLIES');
      for (const payee of payees) if (payee.status !== 'ACTIVE') throw new PayoutCheckError('DESTINATION_NOT_APPROVED');
      if (!(await deps.flags.getIn(tx, 'payouts.enabled'))) throw new PayoutCheckError('PAYOUTS_DISABLED');
      for (const payee of payees) {
        const adapter = await deps.rails.collectable(tx, payee.rail);
        if (!adapter || !adapter.payoutCapable) throw new PayoutCheckError('RAIL_DISABLED');
      }

      // Approvals: threshold on the PLAN total, so splitting cannot dodge dual approval.
      const threshold = await deps.flags.getIn(tx, 'approvals.payout_high_value_minor');
      const dual = requiresDual('payout.request', total, threshold);
      const planId = randomUUID();
      await tx.query(
        `INSERT INTO payout_plan (id, wallet_id, source_kind, source_qualifier, currency, total_minor, parts, idempotency_key, request_hash, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10, $11)`,
        [planId, w.id, input.source.kind, input.source.groupId ?? null, input.currency, total.toString(), input.parts.length, input.idempotencyKey, hash, ctx.actor.personId, now.toISOString()],
      );
      const ids = input.parts.map(() => randomUUID());
      const shaped = input.parts.map((p, i) => ({
        id: ids[i] as string,
        payee_id: p.payeeId,
        amount_minor: p.amountMinor.toString(),
        currency: input.currency,
        purpose: p.purpose,
        source_kind: input.source.kind,
        source_qualifier: input.source.groupId ?? null,
      }));
      const approvalId = dual
        ? await createApproval(tx, ctx.actor, {
        createdAt: deps.clock(),
            action: 'payout.request',
            subjectType: 'payout_plan',
            subjectId: planId,
            walletId: w.id,
            payload: planPayload(planId, shaped),
            amount: { minor: total, ccy: input.currency },
          })
        : null;
      for (const [i, p] of input.parts.entries()) {
        const id = ids[i] as string;
        const payee = payees[i] as (typeof payees)[number];
        const r = await reserve(tx, ctx.actor, {
          accountId: account.id,
          amount: money(p.amountMinor, input.currency),
          ref: { type: 'payout_request', id },
          idempotencyKey: `payout:${id}`,
        });
        await tx.query(
          `INSERT INTO payout_request (id, wallet_id, plan_id, part_no, payee_id, purpose, purpose_note, source_kind, source_qualifier, account_id,
                                       currency, amount_minor, rail, requested_by, requested_at, reservation_id, approval_id, status, next_attempt_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::bigint, $13, $14, $15, $16, $17, $18, $19)`,
          [
            id, w.id, planId, i + 1, payee.id, p.purpose, p.note ?? null, input.source.kind, input.source.groupId ?? null, account.id,
            input.currency, p.amountMinor.toString(), payee.rail, ctx.actor.personId, now.toISOString(), r.reservationId, approvalId,
            dual ? 'AWAITING_APPROVAL' : 'APPROVED', dual ? null : now.toISOString(),
          ],
        );
        await tx.query(
          `INSERT INTO payout_event (payout_id, from_status, to_status, actor_id, actor_role, reason_code, ts) VALUES ($1, NULL, $2, $3, 'ADMIN', $4, $5)`,
          [id, dual ? 'AWAITING_APPROVAL' : 'APPROVED', ctx.actor.personId, dual ? 'DUAL_REQUIRED' : 'SINGLE_APPROVAL', now.toISOString()],
        );
        await emit(tx, 'payout.requested', { payoutId: id, walletId: w.id });
        if (!dual) await emit(tx, 'payout.approved', { payoutId: id, walletId: w.id });
      }
      const rows = await planRows(tx, planId);
      return {
        result: { planId, approvalId, payouts: rows.map((r) => payoutView(r, null)), replayed: false },
        audit: { subjectId: planId, ...(approvalId ? { approvalRef: approvalId } : {}), txnRef: `payout_plan:${planId}`, after: { total: total.toString(), parts: rows.length } },
      };
    },
  };

  /** SYSTEM: apply the checker's decision on a plan's approval. Idempotent. */
  const advance: Command<{ approvalId: string }, { status: string }> = {
    name: 'payout.advance',
    async resolve(q, input) {
      const a = await loadApproval(q, input.approvalId);
      if (!a || a.action !== 'payout.request') throw new NotFoundError('approval', input.approvalId);
      return { action: 'payout.process', subject: { type: 'payout_plan', id: a.subject_id, ...(a.wallet_id ? { walletId: a.wallet_id } : {}) } };
    },
    async run(tx, input, ctx) {
      const a = await loadApproval(tx, input.approvalId);
      if (!a) throw new NotFoundError('approval', input.approvalId);
      const rows = (await planRows(tx, a.subject_id, true)).filter((r) => r.status === 'AWAITING_APPROVAL');
      if (a.decision === null || rows.length === 0) return { result: { status: 'NOTHING_TO_DO' }, audit: { reasonCode: 'WAITING' } };
      const now = deps.clock();
      if (a.decision === 'REJECTED') {
        for (const r of rows) {
          await closeUnpaid(tx, ctx.actor, r, 'REJECTED', 'CHECKER_REJECTED', now);
          await emit(tx, 'payout.failed', { payoutId: r.id, walletId: r.wallet_id, reason: 'REJECTED' });
        }
        return { result: { status: 'REJECTED' }, audit: { approvalRef: a.id, reasonCode: 'REJECTED' } };
      }
      await consumeApprovalFor(tx, a.maker_id, a.id, {
        action: 'payout.request',
        subjectType: 'payout_plan',
        subjectId: a.subject_id,
        payload: planPayload(a.subject_id, await planRows(tx, a.subject_id)),
      });
      for (const r of rows) {
        await transitionPayout(tx, ctx.actor, r, 'APPROVED', { next_attempt_at: now.toISOString() }, { reasonCode: 'CHECKER_APPROVED', now });
        await emit(tx, 'payout.approved', { payoutId: r.id, walletId: r.wallet_id });
      }
      return { result: { status: 'APPROVED' }, audit: { approvalRef: a.id, reasonCode: 'APPROVED' } };
    },
  };

  type SubmitPlan =
    | { kind: 'SKIP'; reason: string }
    | { kind: 'SUBMIT'; rail: string; reference: string; amount: Money; destination: string };

  /** SYSTEM: re-check every blocker, then lease the request for one provider call. */
  const claimSubmit: Command<{ payoutId: string; force?: boolean }, SubmitPlan> = {
    name: 'payout.claim_submit',
    async resolve(q, input) {
      const r = await loadPayout(q, input.payoutId);
      return { action: 'payout.process', subject: { type: 'payout_request', id: r.id, walletId: r.wallet_id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const r = await loadPayout(tx, input.payoutId, true);
      const ok = r.status === 'APPROVED' || r.status === 'RETRY' || (r.status === 'RAIL_DOWN' && input.force === true);
      if (!ok) return { result: { kind: 'SKIP', reason: r.status }, audit: { reasonCode: `SKIP:${r.status}` } };
      if (r.status !== 'RAIL_DOWN' && r.next_attempt_at && new Date(r.next_attempt_at) > now) return { result: { kind: 'SKIP', reason: 'NOT_DUE' }, audit: { reasonCode: 'NOT_DUE' } };
      const blocker = await submitBlocker(tx, deps, r);
      if (blocker) {
        await tx.query('UPDATE payout_request SET last_error = $2, updated_at = now() WHERE id = $1', [r.id, blocker]);
        return { result: { kind: 'SKIP', reason: blocker }, audit: { reasonCode: `BLOCKED:${blocker}` } };
      }
      const payee = await loadPayee(tx, r.payee_id);
      const destination = openString(deps.keys.destination, payee.destination_sealed, destinationAad(payee.id));
      await transitionPayout(
        tx,
        ctx.actor,
        r,
        'SUBMITTING',
        { attempts: r.attempts + 1, lease_until: new Date(now.getTime() + PAYOUT_RETRY.leaseMs).toISOString(), last_error: null },
        { reasonCode: `ATTEMPT_${r.attempts + 1}`, now },
      );
      return {
        result: { kind: 'SUBMIT', rail: r.rail, reference: r.id, amount: money(parseMinor(r.amount_minor), r.currency), destination },
        audit: { txnRef: `payout:${r.id}` },
      };
    },
  };

  type SubmitOutcome =
    | { ok: true; providerRef: string }
    | { ok: false; kind: 'TIMEOUT' | 'UNAVAILABLE' | 'REJECTED'; reason: string };

  /** SYSTEM: record what the provider said to payout(). */
  const recordSubmit: Command<{ payoutId: string; outcome: SubmitOutcome }, { status: string }> = {
    name: 'payout.record_submission',
    async resolve(q, input) {
      const r = await loadPayout(q, input.payoutId);
      return { action: 'payout.process', subject: { type: 'payout_request', id: r.id, walletId: r.wallet_id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const r = await loadPayout(tx, input.payoutId, true);
      if (r.status !== 'SUBMITTING') return { result: { status: r.status }, audit: { reasonCode: 'NOT_SUBMITTING' } };
      const o = input.outcome;
      const poll = new Date(now.getTime() + PAYOUT_RETRY.firstDelayMs).toISOString();
      if (o.ok || o.kind === 'TIMEOUT') {
        // A timeout may still have reached the provider: never resubmit blindly, ask it (by our reference).
        await transitionPayout(
          tx,
          ctx.actor,
          r,
          'SUBMITTED',
          { provider_ref: o.ok ? o.providerRef : null, submitted_at: now.toISOString(), next_attempt_at: poll, lease_until: null, last_error: o.ok ? null : 'TIMEOUT' },
          { reasonCode: o.ok ? 'ACCEPTED' : 'TIMEOUT_UNKNOWN', now },
        );
        await emit(tx, 'payout.submitted', { payoutId: r.id, walletId: r.wallet_id });
        return { result: { status: 'SUBMITTED' }, audit: { reasonCode: o.ok ? 'ACCEPTED' : 'TIMEOUT', txnRef: `payout:${r.id}` } };
      }
      if (o.kind === 'UNAVAILABLE') {
        if (r.attempts >= PAYOUT_RETRY.maxAttempts) {
          await transitionPayout(tx, ctx.actor, r, 'RETRY', { lease_until: null, last_error: o.reason.slice(0, 200) }, { reasonCode: 'UNAVAILABLE', now });
          await transitionPayout(tx, ctx.actor, r, 'RAIL_DOWN', { next_attempt_at: null }, { reasonCode: 'ATTEMPTS_EXHAUSTED', now });
          await notifyAdmin(tx, deps, r.wallet_id, 'payout.notice.failed', `payout:${r.id}:rail_down`, { amount: fmt(money(parseMinor(r.amount_minor), r.currency)) });
          return { result: { status: 'RAIL_DOWN' }, audit: { reasonCode: 'RAIL_DOWN' } };
        }
        const delay = PAYOUT_RETRY.firstDelayMs * 2 ** Math.max(0, r.attempts - 1);
        await transitionPayout(
          tx,
          ctx.actor,
          r,
          'RETRY',
          { lease_until: null, last_error: o.reason.slice(0, 200), next_attempt_at: new Date(now.getTime() + delay).toISOString() },
          { reasonCode: 'UNAVAILABLE', now },
        );
        return { result: { status: 'RETRY' }, audit: { reasonCode: 'RETRY' } };
      }
      await closeUnpaid(tx, ctx.actor, r, 'FAILED', 'PROVIDER_REJECTED', now);
      await emit(tx, 'payout.failed', { payoutId: r.id, walletId: r.wallet_id, reason: 'PROVIDER_REJECTED' });
      await notifyAdmin(tx, deps, r.wallet_id, 'payout.notice.failed', `payout:${r.id}:failed`, { amount: fmt(money(parseMinor(r.amount_minor), r.currency)) });
      return { result: { status: 'FAILED' }, audit: { reasonCode: 'PROVIDER_REJECTED' } };
    },
  };

  /** Post the PAYOUT journal that consumes the reservation, then CONFIRMED. */
  async function confirm(tx: CommandTx, actor: Actor, r: PayoutRow, clearingRail: string, how: string, now: Date, approvalRef?: string) {
    const amount = money(parseMinor(r.amount_minor), r.currency);
    const clearing = await ensureSystemAccount(tx, 'PAYOUT_CLEARING', r.currency, clearingRail);
    const j = await post(tx, actor, {
      idempotencyKey: `payout:${r.id}:confirm`,
      kind: 'PAYOUT',
      reservationId: r.reservation_id,
      ...(approvalRef ? { approvalRef } : {}),
      entries: [
        { accountId: r.account_id, side: 'D', amount, txnRef: `payout:${r.id}`, ...(r.provider_ref ? { providerRef: r.provider_ref } : {}) },
        { accountId: clearing.id, side: 'C', amount, txnRef: `payout:${r.id}`, ...(r.provider_ref ? { providerRef: r.provider_ref } : {}) },
      ],
    });
    await transitionPayout(
      tx,
      actor,
      r,
      'CONFIRMED',
      { payout_journal_id: j.journalId, confirmed_at: now.toISOString(), closed_at: now.toISOString(), close_reason: how, next_attempt_at: null, lease_until: null },
      { reasonCode: how, now },
    );
    await emit(tx, 'payout.confirmed', { payoutId: r.id, walletId: r.wallet_id, journalId: j.journalId });
    await notifyAdmin(tx, deps, r.wallet_id, 'payout.notice.confirmed', `payout:${r.id}:confirmed`, { amount: fmt(amount) });
    return j.journalId;
  }

  type ProviderView =
    | { state: 'PENDING'; providerRef: string }
    | { state: 'SUCCEEDED'; providerRef: string; amount: Money }
    | { state: 'FAILED'; providerRef?: string; reason: string }
    | { state: 'REVERSED'; providerRef: string; reason: string }
    | { state: 'NOT_FOUND' }
    | { state: 'UNREACHABLE' };

  /** SYSTEM: apply an authoritative queryPayout() answer. Idempotent. */
  const applyStatus: Command<{ payoutId: string; status: ProviderView }, { status: string }> = {
    name: 'payout.apply_status',
    async resolve(q, input) {
      const r = await loadPayout(q, input.payoutId);
      return { action: 'payout.process', subject: { type: 'payout_request', id: r.id, walletId: r.wallet_id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const r = await loadPayout(tx, input.payoutId, true);
      const s = input.status;
      const backoff = () => {
        const since = r.submitted_at ? now.getTime() - new Date(r.submitted_at).getTime() : 0;
        const delay = Math.min(Math.max(PAYOUT_RETRY.firstDelayMs, since), 6 * 3_600_000);
        return new Date(now.getTime() + delay).toISOString();
      };
      if (r.status === 'CONFIRMED' && s.state === 'REVERSED') {
        // Paid, then returned: a linked compensating journal gives the money back to the wallet.
        const rev = await reverse(tx, ctx.actor, r.payout_journal_id as string, `payout returned by provider: ${s.reason}`.slice(0, 200));
        await transitionPayout(tx, ctx.actor, r, 'REVERSED', { reversal_journal_id: rev.journalId, last_error: s.reason.slice(0, 200) }, { reasonCode: 'PROVIDER_REVERSED', now });
        await emit(tx, 'payout.failed', { payoutId: r.id, walletId: r.wallet_id, reason: 'REVERSED' });
        await notifyAdmin(tx, deps, r.wallet_id, 'payout.notice.failed', `payout:${r.id}:reversed`, { amount: fmt(money(parseMinor(r.amount_minor), r.currency)) });
        return { result: { status: 'REVERSED' }, audit: { reasonCode: 'REVERSED', txnRef: `journal:${rev.journalId}` } };
      }
      if (r.status !== 'SUBMITTED') return { result: { status: r.status }, audit: { reasonCode: 'NOT_SUBMITTED' } };
      switch (s.state) {
        case 'SUCCEEDED': {
          if (s.amount.ccy !== r.currency || s.amount.minor !== parseMinor(r.amount_minor)) {
            await raiseException(
              tx,
              {
                dedupKey: `payout-amount:${r.id}`,
                kind: 'AMOUNT_VARIANCE',
                severity: 'HIGH',
                rail: r.rail,
                walletId: r.wallet_id,
                providerRef: s.providerRef,
                currency: s.amount.ccy,
                varianceMinor: s.amount.minor - parseMinor(r.amount_minor),
                detail: 'payout confirmed for a different amount; not booked',
              },
              now,
            );
            await tx.query('UPDATE payout_request SET last_error = $2, next_attempt_at = NULL, updated_at = now() WHERE id = $1', [r.id, 'AMOUNT_VARIANCE']);
            return { result: { status: 'SUBMITTED' }, audit: { reasonCode: 'AMOUNT_VARIANCE' } };
          }
          if (!r.provider_ref) {
            await tx.query('UPDATE payout_request SET provider_ref = $2 WHERE id = $1', [r.id, s.providerRef]);
            r.provider_ref = s.providerRef;
          }
          const journalId = await confirm(tx, ctx.actor, r, r.rail, 'PROVIDER_CONFIRMED', now);
          return { result: { status: 'CONFIRMED' }, audit: { reasonCode: 'CONFIRMED', txnRef: `journal:${journalId}` } };
        }
        case 'FAILED':
        case 'REVERSED':
          await closeUnpaid(tx, ctx.actor, r, 'FAILED', 'PROVIDER_FAILED', now);
          await emit(tx, 'payout.failed', { payoutId: r.id, walletId: r.wallet_id, reason: 'PROVIDER_FAILED' });
          await notifyAdmin(tx, deps, r.wallet_id, 'payout.notice.failed', `payout:${r.id}:failed`, { amount: fmt(money(parseMinor(r.amount_minor), r.currency)) });
          return { result: { status: 'FAILED' }, audit: { reasonCode: 'PROVIDER_FAILED' } };
        case 'NOT_FOUND': {
          // The request never arrived (timeout before the provider booked it): resubmit with the same reference.
          const since = r.submitted_at ? now.getTime() - new Date(r.submitted_at).getTime() : Infinity;
          if (!r.provider_ref && since >= 10 * 60_000) {
            await transitionPayout(tx, ctx.actor, r, 'RETRY', { next_attempt_at: now.toISOString(), last_error: 'NOT_FOUND_AT_PROVIDER' }, { reasonCode: 'NOT_FOUND', now });
            return { result: { status: 'RETRY' }, audit: { reasonCode: 'NOT_FOUND' } };
          }
          await tx.query('UPDATE payout_request SET next_attempt_at = $2, updated_at = now() WHERE id = $1', [r.id, backoff()]);
          return { result: { status: 'SUBMITTED' }, audit: { reasonCode: 'NOT_FOUND_YET' } };
        }
        case 'PENDING':
        case 'UNREACHABLE':
          await tx.query('UPDATE payout_request SET next_attempt_at = $2, updated_at = now() WHERE id = $1', [r.id, backoff()]);
          return { result: { status: 'SUBMITTED' }, audit: { reasonCode: s.state } };
      }
    },
  };

  /** Cancel an unsubmitted request: the wallet admin (own request) or ops/finance. */
  const cancel: Command<{ payoutId: string; reason: string }, PayoutView> = {
    name: 'payout.cancel',
    async resolve(q, input) {
      const r = await loadPayout(q, input.payoutId);
      return { action: 'payout.cancel', subject: { type: 'payout_request', id: r.id, walletId: r.wallet_id, ownerPersonId: r.requested_by } };
    },
    async guard(q, input, actor) {
      if (actor.kind !== 'CUSTOMER') return null;
      const r = await loadPayout(q, input.payoutId);
      return r.requested_by === actor.personId ? null : 'NOT_REQUESTER';
    },
    async run(tx, input, ctx) {
      const reason = (input.reason ?? '').trim();
      if (reason.length < 3 || reason.length > 200) throw new ValidationError('reason required');
      const r = await loadPayout(tx, input.payoutId, true);
      if (!UNSUBMITTED.includes(r.status)) throw new ConflictError(`CANNOT_CANCEL_${r.status}`);
      await closeUnpaid(tx, ctx.actor, r, 'CANCELLED', 'CANCELLED_BY_USER', deps.clock());
      await emit(tx, 'payout.failed', { payoutId: r.id, walletId: r.wallet_id, reason: 'CANCELLED' });
      return { result: payoutView(r, null), audit: { reasonCode: 'CANCELLED', after: { note: reason.slice(0, 50) } } };
    },
  };

  /**
   * Rail down (attempts exhausted): ops/finance records a payment made outside
   * the rail. Maker (no approvalId): evidence + external ref ⇒ approval. A
   * different ops/finance person checks. Maker again (approvalId): books it.
   */
  const override: Command<{ payoutId: string; externalRef: string; documentId: string; approvalId?: string }, { status: string; approvalId: string }> = {
    name: 'payout.override',
    async resolve(q, input) {
      const r = await loadPayout(q, input.payoutId);
      return {
        action: 'payout.override',
        subject: { type: 'payout_request', id: r.id, walletId: r.wallet_id, amountMinor: parseMinor(r.amount_minor) },
      };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const ref = (input.externalRef ?? '').trim();
      if (ref.length < 3 || ref.length > 128) throw new ValidationError('externalRef must be 3–128 characters');
      const r = await loadPayout(tx, input.payoutId, true);
      const payload = { payoutId: r.id, externalRef: ref, documentId: input.documentId, minor: r.amount_minor, ccy: r.currency };
      if (input.approvalId === undefined) {
        if (r.status !== 'RAIL_DOWN') throw new ConflictError('OVERRIDE_ONLY_WHEN_RAIL_DOWN');
        if (!isUuid(input.documentId)) throw new ValidationError('documentId required');
        const { rows: doc } = await tx.query<{ malware_scan: string | null; linked_wallet: string | null }>(
          'SELECT malware_scan, linked_wallet FROM document WHERE id = $1',
          [input.documentId],
        );
        if (doc[0]?.malware_scan !== 'CLEAN' || doc[0].linked_wallet !== r.wallet_id) throw new ConflictError('EVIDENCE_NOT_CLEAN');
        const approvalId = await createApproval(tx, ctx.actor, {
        createdAt: deps.clock(),
          action: 'payout.override',
          subjectType: 'payout_request',
          subjectId: r.id,
          walletId: r.wallet_id,
          payload,
          amount: { minor: parseMinor(r.amount_minor), ccy: r.currency },
        });
        await transitionPayout(
          tx,
          ctx.actor,
          r,
          'OVERRIDE_PENDING',
          { override_approval_id: approvalId, override_ref: ref, override_doc: input.documentId },
          { reasonCode: 'OVERRIDE_REQUESTED', now },
        );
        return { result: { status: 'OVERRIDE_PENDING', approvalId }, audit: { approvalRef: approvalId, reasonCode: 'OVERRIDE_REQUESTED' } };
      }
      if (r.status !== 'OVERRIDE_PENDING' || r.override_approval_id !== input.approvalId) throw new ConflictError('NO_SUCH_OVERRIDE');
      const a = await loadApproval(tx, input.approvalId);
      if (a?.decision === 'REJECTED') {
        await transitionPayout(tx, ctx.actor, r, 'RAIL_DOWN', { override_approval_id: null, override_ref: null, override_doc: null }, { reasonCode: 'OVERRIDE_REJECTED', now });
        return { result: { status: 'RAIL_DOWN', approvalId: input.approvalId }, audit: { approvalRef: input.approvalId, reasonCode: 'OVERRIDE_REJECTED' } };
      }
      // Holds, cases and the mandate still apply to money leaving by hand; the rail does not.
      const blocker = await submitBlocker(tx, deps, r, { ignoreRail: true });
      if (blocker) throw new PayoutCheckError(blocker);
      await consumeApproval(tx, ctx.actor, input.approvalId, { action: 'payout.override', subjectType: 'payout_request', subjectId: r.id, payload });
      const journalId = await confirm(tx, ctx.actor, r, 'MANUAL', 'MANUAL_OVERRIDE', now, input.approvalId);
      return { result: { status: 'CONFIRMED', approvalId: input.approvalId }, audit: { approvalRef: input.approvalId, reasonCode: 'MANUAL_OVERRIDE', txnRef: `journal:${journalId}` } };
    },
  };

  const view: Command<{ payoutId: string }, PayoutView> = {
    name: 'payout.view',
    async resolve(q, input) {
      const r = await loadPayout(q, input.payoutId);
      return { action: 'payout.view', subject: { type: 'payout_request', id: r.id, walletId: r.wallet_id } };
    },
    async run(tx, input) {
      const r = await loadPayout(tx, input.payoutId);
      const blocked = r.status === 'APPROVED' || r.status === 'RETRY' ? await submitBlocker(tx, deps, r) : null;
      return { result: payoutView(r, blocked) };
    },
  };

  const list: Command<{ walletId: string }, PayoutView[]> = {
    name: 'payout.list',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'payout.view', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      const { rows } = await tx.query<PayoutRow>(
        `SELECT ${PAYOUT_COLS} FROM payout_request WHERE wallet_id = $1 ORDER BY requested_at DESC, part_no`,
        [input.walletId],
      );
      const out: PayoutView[] = [];
      for (const r of rows) out.push(payoutView(r, r.status === 'APPROVED' || r.status === 'RETRY' ? await submitBlocker(tx, deps, r) : null));
      return { result: out };
    },
  };

  /** SYSTEM: the payout a provider callback names (callbacks are triggers only). */
  const findByProvider: Command<{ rail: string; providerRef: string; reference?: string }, { payoutId: string | null }> = {
    name: 'payout.find_by_provider',
    async resolve(_q, input) {
      return { action: 'payout.process', subject: { type: 'payout_callback', id: `${input.rail}:${input.providerRef}` } };
    },
    async run(tx, input) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payout_request WHERE rail = $1 AND (provider_ref = $2 OR ($3::text IS NOT NULL AND id::text = $3)) LIMIT 1`,
        [input.rail, input.providerRef, input.reference && isUuid(input.reference) ? input.reference : null],
      );
      return { result: { payoutId: rows[0]?.id ?? null } };
    },
  };

  return { request, advance, claimSubmit, recordSubmit, applyStatus, cancel, override, view, list, findByProvider };
}

export type PayoutCommands = ReturnType<typeof payoutCommands>;
