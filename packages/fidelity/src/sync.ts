// SYSTEM side of the claim path: claim a queued call, record its outcome,
// ingest signed Fidelity callbacks, and apply Fidelity's record to the
// mirror. The ONLY code that changes `claim_status_mirror` or posts a BENEFIT
// journal is in this file (applySnapshot / creditBenefit); its inputs come
// from the Fidelity adapter only — never from AI/OCR output or a person.
import { ConflictError, NotFoundError, enqueueOutbox, sha256Hex, type Actor, type Command, type CommandTx } from '@chema/core';
import { ensureSystemAccount, listWalletAccounts, placeHold, post } from '@chema/ledger';
import { openCase, raiseException } from '@chema/payments';
import { money, type Currency } from '@chema/shared';
import type { BenefitPayment, ClaimRequest, ClaimStatus, ClaimStatusReport, FidelityEvent, RecipientRoute } from './adapter';
import { FIDELITY_RETRY, SYNC_INTERVAL_MS, emit, enqueueSync, type RequestKind } from './requests';
import { effectivePolicyNo, isUuid, linkByClaimRef, linkById, loadWallet, recipientHash, type ClaimsDeps, type LinkRow } from './store';

export type CallPlan =
  | { kind: 'SKIP' }
  | { kind: 'LINK_CLAIM'; requestId: string; linkId: string; request: ClaimRequest }
  | { kind: 'SUBMIT_EVIDENCE'; requestId: string; linkId: string; claimRef: string; documentIds: string[] }
  | { kind: 'SYNC'; requestId: string; linkId: string; claimRef: string };

export interface Snapshot {
  status: ClaimStatusReport;
  route: RecipientRoute | null;
  payment: BenefitPayment | null;
}

export type CallResult =
  | { ok: true; kind: 'LINK_CLAIM'; claimRef: string }
  | { ok: true; kind: 'SUBMIT_EVIDENCE' }
  | { ok: true; kind: 'SYNC'; snapshot: Snapshot }
  | { ok: false; final: 'DUPLICATE_CLAIM' | 'REJECTED'; code: string }
  | { ok: false; error: string };

interface RequestRow {
  id: string;
  link_id: string;
  wallet_id: string;
  kind: RequestKind;
  payload: Record<string, unknown>;
  status: 'QUEUED' | 'RETRY' | 'DONE' | 'DEAD';
  attempts: number;
  next_attempt_at: Date | null;
}

async function loadRequest(q: CommandTx | Parameters<Command<unknown, unknown>['resolve']>[0], id: string, lock = false): Promise<RequestRow> {
  if (!isUuid(id)) throw new NotFoundError('fidelity_request', String(id));
  const { rows } = await q.query<RequestRow>(
    `SELECT id, link_id, wallet_id, kind, payload, status, attempts, next_attempt_at FROM fidelity_request WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError('fidelity_request', id);
  return r;
}

/** Outbox topic: a stored Fidelity callback waiting to be processed by the worker. */
export const FIDELITY_EVENT_TOPIC = 'fidelity.event';

const processSubject = (type: string, id: string) => ({ action: 'claim.process' as const, subject: { type, id } });

/** Days before a credit missing from Fidelity's benefit ledger is raised (same lag as P03 settlement). */
export const BENEFIT_RECORD_LAG_DAYS = 1;
/** Review date of a beneficiary-mismatch hold: no open-ended freezes (docs/04 §2). */
const MISMATCH_REVIEW_MS = 7 * 86_400_000;

export function syncCommands(deps: ClaimsDeps) {
  /** Lease a due request and say what to call. Bumps `attempts`, so two workers never make the same attempt. */
  const claim: Command<{ requestId: string }, CallPlan> = {
    name: 'fidelity.request_claim',
    async resolve(q, input) {
      const r = await loadRequest(q, input.requestId);
      return processSubject('fidelity_request', r.id);
    },
    async run(tx, input) {
      const now = deps.clock();
      const r = await loadRequest(tx, input.requestId, true);
      if (r.status !== 'QUEUED' && r.status !== 'RETRY') return { result: { kind: 'SKIP' } };
      if (r.next_attempt_at && new Date(r.next_attempt_at).getTime() > now.getTime()) return { result: { kind: 'SKIP' } };
      const link = await linkById(tx, r.link_id);
      await tx.query('UPDATE fidelity_request SET attempts = attempts + 1, next_attempt_at = $2, updated_at = $3 WHERE id = $1', [
        r.id,
        new Date(now.getTime() + FIDELITY_RETRY.leaseMs).toISOString(),
        now.toISOString(),
      ]);
      const audit = { audit: { reasonCode: `CLAIMED_${r.kind}` } };
      if (r.kind === 'LINK_CLAIM') {
        const wallet = await loadWallet(tx, link.wallet_id);
        const policyNo = effectivePolicyNo(link);
        if (!link.claim_key || !policyNo) throw new ConflictError('LINK_NOT_PREPARED');
        return {
          result: {
            kind: 'LINK_CLAIM',
            requestId: r.id,
            linkId: link.id,
            request: {
              idempotencyKey: link.claim_key,
              walletRef: wallet.id,
              policyNo,
              deceased: { name: wallet.deceased_name, dateOfDeath: wallet.date_of_death, ...(link.national_id ? { nationalId: link.national_id } : {}) },
              evidenceRefs: [],
            },
          },
          ...audit,
        };
      }
      if (!link.claim_ref) throw new ConflictError('CLAIM_NOT_LINKED');
      if (r.kind === 'SUBMIT_EVIDENCE') {
        const ids = Array.isArray(r.payload['documentIds']) ? (r.payload['documentIds'] as string[]) : [];
        return { result: { kind: 'SUBMIT_EVIDENCE', requestId: r.id, linkId: link.id, claimRef: link.claim_ref, documentIds: ids }, ...audit };
      }
      return { result: { kind: 'SYNC', requestId: r.id, linkId: link.id, claimRef: link.claim_ref }, ...audit };
    },
  };

  /** Record what Fidelity answered and apply it. A transport failure schedules a retry (or DEAD). */
  const record: Command<{ requestId: string; result: CallResult }, { status: RequestRow['status'] }> = {
    name: 'fidelity.request_record',
    async resolve(q, input) {
      const r = await loadRequest(q, input.requestId);
      return processSubject('fidelity_request', r.id);
    },
    async run(tx, input, ctx) {
      const now = deps.clock();
      const r = await loadRequest(tx, input.requestId, true);
      if (r.status !== 'QUEUED' && r.status !== 'RETRY') return { result: { status: r.status }, audit: { reasonCode: 'ALREADY_FINAL' } };
      const res = input.result;
      const link = await linkById(tx, r.link_id, true);

      if (!res.ok && 'error' in res) {
        const err = res.error.slice(0, 200);
        if (r.attempts >= FIDELITY_RETRY.maxAttempts) {
          await tx.query("UPDATE fidelity_request SET status = 'DEAD', next_attempt_at = NULL, last_error = $2, updated_at = $3 WHERE id = $1", [r.id, err, now.toISOString()]);
          if (r.kind === 'LINK_CLAIM') await tx.query("UPDATE fidelity_link SET link_error = 'FIDELITY_UNREACHABLE' WHERE id = $1", [link.id]);
          return { result: { status: 'DEAD' }, audit: { reasonCode: 'DEAD' } };
        }
        const delay = FIDELITY_RETRY.firstDelayMs * 2 ** Math.min(r.attempts - 1, 10);
        await tx.query("UPDATE fidelity_request SET status = 'RETRY', next_attempt_at = $2, last_error = $3, updated_at = $4 WHERE id = $1", [
          r.id,
          new Date(now.getTime() + delay).toISOString(),
          err,
          now.toISOString(),
        ]);
        return { result: { status: 'RETRY' }, audit: { reasonCode: 'RETRY' } };
      }

      await tx.query("UPDATE fidelity_request SET status = 'DONE', done_at = $2, next_attempt_at = NULL, last_error = NULL, updated_at = $2 WHERE id = $1", [r.id, now.toISOString()]);

      if (!res.ok) {
        // Fidelity's own refusal: surfaced to the family, never overridden.
        const state = res.final;
        await tx.query('UPDATE fidelity_link SET link_state = $2, link_error = $3 WHERE id = $1', [link.id, state, res.code]);
        return { result: { status: 'DONE' }, audit: { subjectId: link.id, reasonCode: state } };
      }
      if (res.kind === 'LINK_CLAIM') {
        await tx.query(
          `UPDATE fidelity_link SET claim_ref = $2, link_state = 'LINKED', link_error = NULL,
                  route_status = CASE WHEN route_status = 'UNSET' THEN 'PENDING_APPROVAL' ELSE route_status END
            WHERE id = $1`,
          [link.id, res.claimRef],
        );
        await setStatus(tx, await linkById(tx, link.id, true), { status: 'SUBMITTED' }, now);
        await emit(tx, 'claim.linked', { walletId: link.wallet_id, linkId: link.id });
        return { result: { status: 'DONE' }, audit: { subjectId: link.id, reasonCode: 'LINKED', txnRef: `claim:${res.claimRef}` } };
      }
      if (res.kind === 'SUBMIT_EVIDENCE') {
        await emit(tx, 'claim.evidence_submitted', { walletId: link.wallet_id, linkId: link.id });
        return { result: { status: 'DONE' }, audit: { subjectId: link.id, reasonCode: 'EVIDENCE_SUBMITTED' } };
      }
      const outcome = await applySnapshot(tx, ctx.actor, deps, link, res.snapshot, now);
      return { result: { status: 'DONE' }, audit: { subjectId: link.id, reasonCode: outcome } };
    },
  };

  /** Store a verified callback (raw, append-only) and queue its processing. Replays are no-ops. */
  const receive: Command<{ event: FidelityEvent; rawBody: string; signature: string }, { eventRowId: string; duplicate: boolean }> = {
    name: 'fidelity.receive_event',
    async resolve(_q, input) {
      return processSubject('fidelity_event', input.event.eventId);
    },
    async run(tx, input) {
      const now = deps.clock();
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO fidelity_event (event_id, event_type, claim_ref, raw_body, signature_hash, received_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING RETURNING id`,
        [input.event.eventId, input.event.type, input.event.claimRef, input.rawBody, sha256Hex(input.signature), now.toISOString()],
      );
      if (!rows[0]) {
        const { rows: ex } = await tx.query<{ id: string }>('SELECT id FROM fidelity_event WHERE event_id = $1', [input.event.eventId]);
        return { result: { eventRowId: ex[0]?.id ?? '', duplicate: true }, audit: { reasonCode: 'REPLAY' } };
      }
      await enqueueOutbox(tx, FIDELITY_EVENT_TOPIC, { eventRowId: rows[0].id });
      return { result: { eventRowId: rows[0].id, duplicate: false }, audit: { subjectId: rows[0].id, reasonCode: input.event.type } };
    },
  };

  /** A callback only says "something changed": queue a SYNC that re-reads Fidelity's record. */
  const processEvent: Command<{ eventRowId: string }, { outcome: string; requestId: string | null }> = {
    name: 'fidelity.process_event',
    async resolve(q, input) {
      if (!isUuid(input.eventRowId)) throw new NotFoundError('fidelity_event', String(input.eventRowId));
      const { rows } = await q.query('SELECT 1 FROM fidelity_event WHERE id = $1', [input.eventRowId]);
      if (!rows[0]) throw new NotFoundError('fidelity_event', input.eventRowId);
      return processSubject('fidelity_event', input.eventRowId);
    },
    async run(tx, input) {
      const now = deps.clock();
      const { rows } = await tx.query<{ claim_ref: string | null; outcome: string | null }>(
        'SELECT claim_ref, outcome FROM fidelity_event WHERE id = $1 FOR UPDATE',
        [input.eventRowId],
      );
      const e = rows[0];
      if (!e) throw new NotFoundError('fidelity_event', input.eventRowId);
      if (e.outcome) return { result: { outcome: e.outcome, requestId: null }, audit: { reasonCode: 'ALREADY_PROCESSED' } };
      const link = e.claim_ref ? await linkByClaimRef(tx, e.claim_ref) : undefined;
      let outcome = 'UNKNOWN_CLAIM';
      let requestId: string | null = null;
      if (link) {
        requestId = await enqueueSync(tx, link, now);
        outcome = 'SYNC_QUEUED';
      }
      await tx.query('UPDATE fidelity_event SET processed_at = $2, outcome = $3 WHERE id = $1', [input.eventRowId, now.toISOString(), outcome]);
      return { result: { outcome, requestId }, audit: { reasonCode: outcome } };
    },
  };

  /** Poller: queue a SYNC for every open claim not read within SYNC_INTERVAL_MS (lost callbacks, outages). */
  const scheduleSyncs: Command<Record<string, never>, { queued: number }> = {
    name: 'fidelity.schedule_sync',
    async resolve() {
      return processSubject('fidelity', 'sync');
    },
    async run(tx) {
      const now = deps.clock();
      const { rows } = await tx.query<{ id: string; wallet_id: string }>(
        `SELECT l.id, l.wallet_id FROM fidelity_link l
          WHERE l.link_state = 'LINKED' AND l.benefit_journal_id IS NULL AND l.claim_status_mirror <> 'DECLINED'
            AND NOT (l.route_kind = 'DIRECT' AND l.route_status = 'APPROVED' AND l.benefit_payment_status = 'SETTLED')
            AND (l.last_synced_at IS NULL OR l.last_synced_at < $1)
            AND NOT EXISTS (SELECT 1 FROM fidelity_request r WHERE r.link_id = l.id AND r.kind = 'SYNC' AND r.status IN ('QUEUED', 'RETRY'))`,
        [new Date(now.getTime() - SYNC_INTERVAL_MS).toISOString()],
      );
      for (const l of rows) await enqueueSync(tx, l, now);
      return { result: { queued: rows.length } };
    },
  };

  return { claim, record, receive, processEvent, scheduleSyncs };
}

export type SyncCommands = ReturnType<typeof syncCommands>;

/** Mirror a claim status reported by Fidelity (append-only event first). */
async function setStatus(tx: CommandTx, link: LinkRow, report: ClaimStatusReport, now: Date): Promise<boolean> {
  const reason = report.reasonCode && /^[A-Z][A-Z0-9_]{1,63}$/.test(report.reasonCode) ? report.reasonCode : report.reasonCode ? 'OTHER' : null;
  if (report.status === link.claim_status_mirror && reason === link.claim_reason) return false;
  await tx.query(
    `INSERT INTO claim_status_event (link_id, wallet_id, from_status, to_status, reason_code, source, ts)
     VALUES ($1, $2, $3, $4, $5, 'FIDELITY', $6)`,
    [link.id, link.wallet_id, link.claim_status_mirror, report.status, reason, now.toISOString()],
  );
  await tx.query('UPDATE fidelity_link SET claim_status_mirror = $2, claim_reason = $3 WHERE id = $1', [link.id, report.status, reason]);
  await emit(tx, 'claim.status_changed', { walletId: link.wallet_id, linkId: link.id, status: report.status as ClaimStatus });
  return true;
}

/**
 * Apply Fidelity's record. Order: claim status → route → payment → credit.
 * Credit needs all of: claim APPROVED, route APPROVED to the WALLET, payment
 * SETTLED per Fidelity, same currency as the wallet (docs/07 §4).
 */
async function applySnapshot(tx: CommandTx, actor: Actor, deps: ClaimsDeps, start: LinkRow, snap: Snapshot, now: Date): Promise<string> {
  await setStatus(tx, start, snap.status, now);
  let link = await linkById(tx, start.id, true);
  const wallet = await loadWallet(tx, link.wallet_id);
  const outcomes: string[] = [];

  const route = snap.route;
  if (route && route.approvedBy.length > 0) {
    if (link.route_status === 'PENDING_APPROVAL' || link.route_status === 'UNSET') {
      const base = [link.id, route.route, route.routeRef, [...route.approvedBy]];
      if (route.route === 'DIRECT') {
        // Fidelity pays its beneficiary itself: nothing will enter this wallet.
        await tx.query(
          `UPDATE fidelity_link SET route_kind = $2, route_ref = $3, route_approved_by = $4,
                  route_status = CASE WHEN route_status = 'UNSET' THEN 'PENDING_APPROVAL' ELSE route_status END WHERE id = $1`,
          base,
        );
        await tx.query("UPDATE fidelity_link SET route_status = 'APPROVED' WHERE id = $1", [link.id]);
        outcomes.push('ROUTE_DIRECT');
      } else if (link.proposed_recipient && link.proposed_recipient_id_hash === recipientHash(deps, route.recipient.idNumber)) {
        await tx.query(
          `UPDATE fidelity_link SET route_kind = $2, route_ref = $3, route_approved_by = $4, approved_recipient = $5,
                  route_status = CASE WHEN route_status = 'UNSET' THEN 'PENDING_APPROVAL' ELSE route_status END WHERE id = $1`,
          [...base, link.proposed_recipient],
        );
        await tx.query("UPDATE fidelity_link SET route_status = 'APPROVED' WHERE id = $1", [link.id]);
        outcomes.push('ROUTE_APPROVED');
      } else {
        // Proposed recipient ≠ policy beneficiary: case + hold on the benefit source only (docs/07 §5).
        const caseId = await openCase(
          tx,
          { type: 'BENEFICIARY_MISMATCH', summary: 'Proposed benefit recipient differs from the approved policy beneficiary', openedBy: 'system', walletId: wallet.id, externalRef: `link:${link.id}` },
          now,
        );
        const holdId = await placeHold(tx, actor, {
          walletId: wallet.id,
          scope: 'SOURCE',
          source: { kind: 'FIDELITY_BENEFIT' },
          reasonCode: 'BENEFICIARY_MISMATCH',
          ownerId: 'CLAIMS_OFFICER',
          reviewAt: new Date(now.getTime() + MISMATCH_REVIEW_MS),
        });
        await tx.query(
          `UPDATE fidelity_link SET route_kind = $2, route_ref = $3, route_approved_by = $4, mismatch_case_id = $5, mismatch_hold_id = $6,
                  route_status = CASE WHEN route_status = 'UNSET' THEN 'PENDING_APPROVAL' ELSE route_status END WHERE id = $1`,
          [...base, caseId, holdId],
        );
        await tx.query("UPDATE fidelity_link SET route_status = 'BLOCKED_MISMATCH' WHERE id = $1", [link.id]);
        await emit(tx, 'benefit.route_blocked', { walletId: wallet.id, linkId: link.id, caseId });
        outcomes.push('ROUTE_BLOCKED');
      }
    } else if (link.route_ref && route.routeRef !== link.route_ref) {
      await conflict(tx, link, now, 'Fidelity reports a different recipient route than the one recorded');
    }
    link = await linkById(tx, link.id, true);
  }

  const pay = snap.payment;
  if (pay) {
    if (link.benefit_journal_id && link.benefit_payment_ref !== pay.paymentRef) {
      await conflict(tx, link, now, 'Fidelity reports a different benefit payment after the benefit was credited');
    } else if (!link.benefit_journal_id) {
      await tx.query(
        `UPDATE fidelity_link SET benefit_payment_ref = $2, benefit_minor = $3::bigint, benefit_currency = $4,
                benefit_payment_status = $5, benefit_settled_on = $6::date WHERE id = $1`,
        [link.id, pay.paymentRef, pay.amount.minor.toString(), pay.amount.ccy, pay.status, pay.settledOn ?? null],
      );
      link = await linkById(tx, link.id, true);
    }
  }

  if (link.benefit_journal_id && link.claim_status_mirror !== 'APPROVED') {
    await conflict(tx, link, now, 'claim no longer APPROVED after the benefit was credited');
  }
  if (await creditBenefit(tx, actor, link, wallet.currency, now)) outcomes.push('BENEFIT_CREDITED');

  await tx.query('UPDATE fidelity_link SET last_synced_at = $2 WHERE id = $1', [link.id, now.toISOString()]);
  return outcomes.length ? outcomes.join('+') : 'SYNCED';
}

/** The only place a BENEFIT journal is posted. DR SYS:BENEFIT_CLEARING / CR W:FIDELITY_BENEFIT. No fee leg exists. */
async function creditBenefit(tx: CommandTx, actor: Actor, link: LinkRow, walletCurrency: Currency, now: Date): Promise<boolean> {
  const { benefit_payment_ref: paymentRef, benefit_minor: minor, benefit_currency: ccy } = link;
  const ready =
    link.benefit_journal_id === null &&
    link.claim_status_mirror === 'APPROVED' &&
    link.route_status === 'APPROVED' &&
    link.route_kind === 'WALLET' &&
    link.benefit_payment_status === 'SETTLED';
  if (!ready || paymentRef === null || minor === null || ccy === null) return false;
  const account = (await listWalletAccounts(tx, link.wallet_id)).find((a) => a.kind === 'FIDELITY_BENEFIT' && a.currency === ccy);
  if (ccy !== walletCurrency || !account) {
    await raiseException(
      tx,
      {
        dedupKey: `benefit-currency:${link.benefit_payment_ref}`,
        kind: 'BENEFIT_CURRENCY_MISMATCH',
        severity: 'HIGH',
        rail: 'FIDELITY',
        walletId: link.wallet_id,
        providerRef: paymentRef,
        currency: ccy,
        varianceMinor: BigInt(minor),
        detail: 'benefit currency differs from the wallet currency; not credited (no FX source)',
      },
      now,
    );
    return false;
  }
  const amount = money(BigInt(minor), ccy);
  const clearing = await ensureSystemAccount(tx, 'BENEFIT_CLEARING', ccy);
  const refs = { providerRef: paymentRef, txnRef: `claim:${link.claim_ref}` };
  const j = await post(tx, actor, {
    idempotencyKey: `benefit:${link.id}:${link.benefit_payment_ref}`,
    kind: 'BENEFIT',
    entries: [
      { accountId: clearing.id, side: 'D', amount, ...refs },
      { accountId: account.id, side: 'C', amount, ...refs },
    ],
  });
  await tx.query('UPDATE fidelity_link SET benefit_journal_id = $2 WHERE id = $1', [link.id, j.journalId]);
  await emit(tx, 'benefit.credited', { walletId: link.wallet_id, linkId: link.id, journalId: j.journalId });
  return true;
}

async function conflict(tx: CommandTx, link: LinkRow, now: Date, detail: string): Promise<void> {
  await raiseException(
    tx,
    {
      dedupKey: `benefit-conflict:${link.id}:${sha256Hex(detail).slice(0, 12)}`,
      kind: 'BENEFIT_STATE_CONFLICT',
      severity: 'HIGH',
      rail: 'FIDELITY',
      walletId: link.wallet_id,
      ...(link.benefit_payment_ref ? { providerRef: link.benefit_payment_ref } : {}),
      detail,
    },
    now,
  );
}
