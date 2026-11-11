// Wallet end of life (docs/08 Refunds & cancellation, Closure).
//   start  (ACTIVE → CLOSING): contributions stop at once (the gate needs ACTIVE)
//          and the public page shows the closed state. CANCEL also cancels
//          unsubmitted payouts and opens a REFUND case: refund.policy is
//          unresolved (D11), so every refund is a manual, dual-approved
//          payment.refund — nothing is refunded automatically.
//   finalise (CLOSING → CLOSED): only when every precondition holds; writes the
//          family statement + audit pack in the same transaction.
//   thank:  one tap, once, to contributors with a live NOTIFY consent.
import { ConflictError, ValidationError, actorRoleLabel, canonicalJson, sha256Hex, type Actor, type Command, type CommandTx } from '@chema/core';
import { enqueueNotification } from '@chema/channels';
import { getBalances, getStatement, lockWallet } from '@chema/ledger';
import { openCase } from '@chema/payments';
import { parseMinor, type Currency, type Queryable } from '@chema/shared';
import { loadWallet } from '@chema/wallet';
import { cancelUnsubmitted } from './payouts';
import { emit, type PayoutDeps } from './store';
import { CLOSURE_REASONS, OPEN_PAYOUT_STATUSES, includes, type ClosureCheck, type ClosureReason } from './types';

export class ClosureBlockedError extends ConflictError {
  constructor(readonly blockers: string[]) {
    super('CLOSURE_BLOCKED');
    this.name = 'ClosureBlockedError';
  }
}

async function count(q: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await q.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) x`, params);
  return rows[0]?.n ?? 0;
}

/** Every docs/08 closure precondition, evaluated from the database (never cached). */
export async function closureCheck(q: Queryable, deps: Pick<PayoutDeps, 'flags'>, walletId: string): Promise<ClosureCheck> {
  const w = await loadWallet(q, walletId);
  const blockers: string[] = [];
  if (w.status !== 'CLOSING') blockers.push('NOT_CLOSING');
  const checks: [string, string][] = [
    ['PENDING_PAYMENTS', `SELECT 1 FROM payment WHERE wallet_id = $1 AND state IN ('INITIATED', 'PENDING_UNKNOWN')`],
    ['OPEN_PAYOUTS', `SELECT 1 FROM payout_request WHERE wallet_id = $1 AND status = ANY('{${OPEN_PAYOUT_STATUSES.join(',')}}'::text[])`],
    ['ACTIVE_RESERVATIONS', `SELECT 1 FROM ledger_reservation WHERE wallet_id = $1 AND released_at IS NULL AND consumed_at IS NULL`],
    ['OPEN_REFUNDS', `SELECT 1 FROM refund r JOIN payment p ON p.id = r.payment_id WHERE p.wallet_id = $1 AND r.completed_at IS NULL AND r.failed_at IS NULL`],
    ['OPEN_DISPUTES', `SELECT 1 FROM payment_dispute d JOIN payment p ON p.id = d.payment_id WHERE p.wallet_id = $1 AND d.outcome IS NULL`],
    ['OPEN_CASES', `SELECT 1 FROM case_record WHERE wallet_id = $1 AND closed_at IS NULL`],
    ['ACTIVE_HOLDS', `SELECT 1 FROM hold WHERE wallet_id = $1 AND released_at IS NULL`],
    ['OPEN_RECON_EXCEPTIONS', `SELECT 1 FROM recon_exception WHERE wallet_id = $1 AND resolved_at IS NULL`],
    // Final reconciliation: every credited payment matched to a provider settlement row.
    [
      'RECON_NOT_FINAL',
      `SELECT 1 FROM payment p WHERE p.wallet_id = $1 AND p.credit_journal_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM provider_settlement_row s WHERE s.payment_id = p.id AND s.match_status IN ('MATCHED', 'WITHIN_TOLERANCE'))`,
    ],
    [
      'CLAIM_IN_PROGRESS',
      `SELECT 1 FROM fidelity_link l WHERE l.wallet_id = $1 AND l.claim_ref IS NOT NULL
          AND (l.claim_status_mirror IN ('SUBMITTED', 'IN_REVIEW', 'MORE_INFO')
               OR (l.claim_status_mirror IN ('APPROVED') AND l.route_kind IS DISTINCT FROM 'DIRECT' AND l.benefit_journal_id IS NULL))`,
    ],
    ['FIDELITY_CALLS_PENDING', `SELECT 1 FROM fidelity_request WHERE wallet_id = $1 AND status IN ('QUEUED', 'RETRY')`],
  ];
  for (const [code, sql] of checks) if ((await count(q, sql, [walletId])) > 0) blockers.push(code);

  const residual: ClosureCheck['residual'] = [];
  for (const b of await getBalances(q, walletId)) {
    if (b.settled.minor !== 0n) residual.push({ source: b.code, currency: b.account.currency, amount: b.settled });
  }
  if (residual.length) {
    const policy = await deps.flags.getIn(q, 'closure.excess_funds_policy');
    // Unset ⇒ closure blocked while anything is left. Set ⇒ still resolved by people
    // (payout / refund per the approved policy) before the wallet can close.
    blockers.push(policy === null ? 'RESIDUAL_POLICY_UNSET' : 'RESIDUAL_BALANCE');
  }
  return { walletId, status: w.status, blockers, residual };
}

async function statusEvent(tx: CommandTx, actor: Actor, walletId: string, from: string, to: string, reason: string, note: string | null, caseId: string | null, now: Date) {
  await tx.query(
    `INSERT INTO wallet_status_event (wallet_id, from_status, to_status, actor_id, actor_role, reason_code, note, case_id, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9)`,
    [walletId, from, to, actor.personId, actorRoleLabel(actor), reason, note, caseId, now.toISOString()],
  );
}

function money2(minor: bigint, ccy: Currency) {
  return { minor: minor.toString(), ccy };
}

/** Family statement: sources, totals, payouts by purpose. No contributor personal data. */
async function familyStatement(q: Queryable, walletId: string) {
  const w = await loadWallet(q, walletId);
  const balances = await getBalances(q, walletId);
  const { rows: received } = await q.query<{ kind: string; journal: string; net: string; currency: Currency }>(
    `SELECT a.kind, j.kind AS journal, a.currency,
            sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END)::text AS net
       FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id JOIN ledger_journal j ON j.id = e.journal_id
      WHERE a.wallet_id = $1 GROUP BY a.kind, j.kind, a.currency ORDER BY a.kind, j.kind`,
    [walletId],
  );
  const { rows: payouts } = await q.query<{ purpose: string; label: string; masked: string; amount: string; currency: Currency; source_kind: string; confirmed_at: Date }>(
    `SELECT r.purpose, p.label, p.destination_masked AS masked, r.amount_minor::text AS amount, r.currency, r.source_kind, r.confirmed_at
       FROM payout_request r JOIN payee p ON p.id = r.payee_id
      WHERE r.wallet_id = $1 AND r.status = 'CONFIRMED' ORDER BY r.confirmed_at`,
    [walletId],
  );
  return {
    walletId,
    deceasedName: w.deceased_name,
    dateOfDeath: w.date_of_death,
    currency: w.currency,
    sources: balances.map((b) => ({ source: b.code, settled: money2(b.settled.minor, b.account.currency), paid: money2(b.paid.minor, b.account.currency) })),
    movements: received.map((r) => ({ source: r.kind, kind: r.journal, net: money2(parseMinor(r.net), r.currency) })),
    payouts: payouts.map((p) => ({
      purpose: p.purpose,
      payee: `${p.label} (${p.masked})`,
      source: p.source_kind,
      amount: money2(parseMinor(p.amount), p.currency),
      at: new Date(p.confirmed_at).toISOString(),
    })),
  };
}

/** Audit pack: every journal + entry, payout history, cases, holds, and the audit-chain head at close. */
async function auditPack(q: Queryable, walletId: string) {
  const journals = await getStatement(q, walletId);
  const { rows: payoutEvents } = await q.query(
    `SELECT e.payout_id, e.from_status, e.to_status, e.actor_id, e.actor_role, e.reason_code, e.ts
       FROM payout_event e JOIN payout_request r ON r.id = e.payout_id WHERE r.wallet_id = $1 ORDER BY e.ts, e.id`,
    [walletId],
  );
  const { rows: cases } = await q.query(
    `SELECT id, case_type, status, outcome, opened_at, closed_at FROM case_record WHERE wallet_id = $1 ORDER BY opened_at`,
    [walletId],
  );
  const { rows: holds } = await q.query(
    `SELECT id, scope, source_kind, reason_code, created_at, released_at, release_approval_id FROM hold WHERE wallet_id = $1 ORDER BY created_at`,
    [walletId],
  );
  const { rows: approvals } = await q.query(
    `SELECT id, action, maker_id, checker_id, decision, decided_at, escalated_to FROM approval WHERE wallet_id = $1 ORDER BY created_at`,
    [walletId],
  );
  const { rows: head } = await q.query<{ seq: string; hash: string }>('SELECT audit_log.seq::text AS seq, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1');
  return {
    walletId,
    journals: journals.map((j) => ({
      id: j.journalId,
      seq: j.seq.toString(),
      kind: j.kind,
      reverses: j.reversesJournalId,
      approvalRef: j.approvalRef,
      at: new Date(j.createdAt).toISOString(),
      entries: j.entries.map((e) => ({ account: e.accountId, side: e.side, amount: money2(e.amount.minor, e.amount.ccy), txnRef: e.txnRef })),
    })),
    payoutEvents,
    cases,
    holds,
    approvals,
    auditChainHead: head[0] ?? null,
  };
}

async function writeStatement(tx: CommandTx, actor: Actor, walletId: string, kind: 'FAMILY' | 'AUDIT_PACK', content: unknown, now: Date): Promise<string> {
  const json = JSON.parse(canonicalJson(content)) as unknown;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO wallet_statement (wallet_id, kind, content, content_hash, generated_by, generated_at) VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
    [walletId, kind, JSON.stringify(json), sha256Hex(canonicalJson(content)), actor.personId, now.toISOString()],
  );
  return rows[0]?.id as string;
}

export function closureCommands(deps: PayoutDeps) {
  const start: Command<{ walletId: string; kind: 'CLOSE' | 'CANCEL'; reasonCode: ClosureReason; note?: string }, { status: 'CLOSING'; refundCaseId: string | null; cancelledRequests: number }> = {
    name: 'wallet.close_start',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.close', subject: { type: 'wallet', id: w.id, walletId: w.id, createdByPersonId: w.created_by } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      if (input.kind !== 'CLOSE' && input.kind !== 'CANCEL') throw new ValidationError('kind must be CLOSE or CANCEL');
      if (!includes(CLOSURE_REASONS, input.reasonCode)) throw new ValidationError('bad reason code');
      const note = input.note?.trim() || null;
      if (input.reasonCode === 'OTHER' && (!note || note.length < 10)) throw new ValidationError('note required for OTHER');
      const w = await loadWallet(tx, input.walletId, true);
      const allowed = input.kind === 'CANCEL' ? ['ACTIVE', 'SUSPENDED'] : ['ACTIVE'];
      if (!allowed.includes(w.status)) throw new ConflictError(`CANNOT_${input.kind}_${w.status}`);
      // A suspended wallet is cancelled by Fidelity, not the family.
      if (w.status === 'SUSPENDED' && ctx.actor.kind !== 'STAFF') throw new ConflictError('SUSPENDED_WALLET_STAFF_ONLY');
      let refundCaseId: string | null = null;
      let cancelled = 0;
      if (input.kind === 'CANCEL') {
        cancelled = await cancelUnsubmitted(tx, ctx.actor, { walletId: w.id }, 'WALLET_CANCELLED', now);
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payment WHERE wallet_id = $1 AND credit_journal_id IS NOT NULL AND state = 'SUCCEEDED'`,
          [w.id],
        );
        const paid = (await getBalances(tx, w.id)).some((b) => b.paid.minor > 0n);
        refundCaseId = await openCase(
          tx,
          {
            type: 'REFUND',
            walletId: w.id,
            externalRef: `cancel:${w.id}`,
            openedBy: ctx.actor.personId,
            summary: `Wallet cancelled (${input.reasonCode}): ${rows[0]?.n ?? 0} credited contribution(s) to refund by hand under refund.policy${paid ? '; wallet partly spent (D11)' : ''}.`,
          },
          now,
        );
        await emit(tx, 'case.opened', { caseId: refundCaseId, walletId: w.id, type: 'REFUND' });
      }
      await tx.query(
        `INSERT INTO wallet_closure (wallet_id, kind, reason_code, note, requested_by, requested_at, refund_case_id) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)`,
        [w.id, input.kind, input.reasonCode, note, ctx.actor.personId, now.toISOString(), refundCaseId],
      );
      await tx.query(`UPDATE wallet SET status = 'CLOSING', updated_at = now() WHERE id = $1`, [w.id]);
      await statusEvent(tx, ctx.actor, w.id, w.status, 'CLOSING', input.reasonCode, note, refundCaseId, now);
      await emit(tx, 'wallet.closing', { walletId: w.id, kind: input.kind });
      return { result: { status: 'CLOSING', refundCaseId, cancelledRequests: cancelled }, audit: { reasonCode: `${input.kind}:${input.reasonCode}` } };
    },
  };

  const check: Command<{ walletId: string }, ClosureCheck> = {
    name: 'wallet.closure_check',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.view_ledger', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input) {
      return { result: await closureCheck(tx, deps, input.walletId) };
    },
  };

  const finalise: Command<{ walletId: string }, { status: 'CLOSED'; statements: { family: string; auditPack: string } }> = {
    name: 'wallet.close_finalise',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.close.finalise', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      await loadWallet(tx, input.walletId, true);
      // Serialise with reservations, debits and holds: nothing can start while we check.
      await lockWallet(tx, input.walletId);
      const c = await closureCheck(tx, deps, input.walletId);
      if (c.blockers.length) throw new ClosureBlockedError(c.blockers);
      const family = await writeStatement(tx, ctx.actor, input.walletId, 'FAMILY', await familyStatement(tx, input.walletId), now);
      const audit = await writeStatement(tx, ctx.actor, input.walletId, 'AUDIT_PACK', await auditPack(tx, input.walletId), now);
      await tx.query('UPDATE wallet_closure SET closed_at = $2, closed_by = $3, updated_at = now() WHERE wallet_id = $1 AND closed_at IS NULL', [
        input.walletId,
        now.toISOString(),
        ctx.actor.personId,
      ]);
      await tx.query(`UPDATE wallet SET status = 'CLOSED', updated_at = now() WHERE id = $1`, [input.walletId]);
      await statusEvent(tx, ctx.actor, input.walletId, 'CLOSING', 'CLOSED', 'PRECONDITIONS_MET', null, null, now);
      await emit(tx, 'wallet.closed', { walletId: input.walletId });
      return { result: { status: 'CLOSED', statements: { family, auditPack: audit } }, audit: { reasonCode: 'CLOSED', txnRef: `statement:${audit}` } };
    },
  };

  /** One tap, once: thank contributors who gave a live NOTIFY consent (never anyone else). */
  const thank: Command<{ walletId: string }, { queued: number }> = {
    name: 'wallet.thank_contributors',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.thank_contributors', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const w = await loadWallet(tx, input.walletId, true);
      if (w.status !== 'CLOSING' && w.status !== 'CLOSED') throw new ConflictError('NOT_CLOSING');
      const { rows: done } = await tx.query(
        'UPDATE wallet_closure SET thanked_at = $2, thanked_by = $3, updated_at = now() WHERE wallet_id = $1 AND thanked_at IS NULL RETURNING id',
        [w.id, now.toISOString(), ctx.actor.personId],
      );
      if (done.length !== 1) throw new ConflictError('ALREADY_THANKED');
      const { rows } = await tx.query<{ person: string }>(
        `SELECT DISTINCT c.contributor_person AS person FROM contribution c
          WHERE c.wallet_id = $1 AND c.settled_state = 'SUCCEEDED' AND c.contributor_person IS NOT NULL
            AND EXISTS (SELECT 1 FROM consent_record k WHERE k.subject_person = c.contributor_person AND k.purpose = 'NOTIFY'
                          AND k.withdrawn_at IS NULL AND (k.wallet_id IS NULL OR k.wallet_id = c.wallet_id))
          ORDER BY 1`,
        [w.id],
      );
      for (const r of rows) {
        await enqueueNotification(
          tx,
          deps.keys.notify,
          { template: 'closure.thank_you', channel: 'SMS', to: { personId: r.person }, params: { name: w.deceased_name }, dedupeKey: `thanks:${w.id}:${r.person}`, walletId: w.id },
          now,
        );
      }
      return { result: { queued: rows.length }, audit: { reasonCode: `THANKED:${rows.length}` } };
    },
  };

  const statements: Command<{ walletId: string }, { kind: string; contentHash: string; generatedAt: string; content: unknown }[]> = {
    name: 'wallet.statements',
    async resolve(q, input) {
      const w = await loadWallet(q, input.walletId);
      return { action: 'wallet.statement.view', subject: { type: 'wallet', id: w.id, walletId: w.id } };
    },
    async run(tx, input, ctx) {
      const { rows } = await tx.query<{ kind: string; content_hash: string; generated_at: Date; content: unknown }>(
        'SELECT kind, content_hash, generated_at, content FROM wallet_statement WHERE wallet_id = $1 ORDER BY kind',
        [input.walletId],
      );
      // The audit pack is for staff/audit only; the family gets their statement.
      const staff = ctx.actor.kind === 'STAFF';
      return {
        result: rows
          .filter((r) => staff || r.kind === 'FAMILY')
          .map((r) => ({ kind: r.kind, contentHash: r.content_hash, generatedAt: new Date(r.generated_at).toISOString(), content: r.content })),
      };
    },
  };

  return { start, check, finalise, thank, statements };
}

