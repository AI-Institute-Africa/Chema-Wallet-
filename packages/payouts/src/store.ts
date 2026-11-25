// Row access, keys and the shared checks every payout path re-runs.
import { createHmac } from 'node:crypto';
import { actorRoleLabel, enqueueOutbox, hmacHex, NotFoundError, type Actor, type CommandTx, type FlagService, type Secrets } from '@chema/core';
import type { RailRegistry } from '@chema/payments';
import { money, parseMinor, type Currency, type Queryable } from '@chema/shared';
import type { PayeeView, PayoutPurpose, PayoutSource, PayoutStatus, PayoutTopic, PayoutView } from './types';

export interface PayoutKeys {
  /** Seals payee destinations (AES-256-GCM). */
  destination: Buffer;
  /** Keyed hash of destinations (duplicate detection without plaintext). */
  destinationHash: Buffer;
  /** Seals notification params/addresses (same key as NotificationService). */
  notify: Buffer;
}

const derive = (key: Buffer, label: string) => createHmac('sha256', key).update(`chema:${label}:v1`).digest();

export function payoutKeys(secrets: Secrets): PayoutKeys {
  return {
    destination: derive(secrets.dataKey, 'payee-destination'),
    destinationHash: derive(secrets.authKey, 'payee-destination-hash'),
    notify: secrets.dataKey,
  };
}

export interface PayoutDeps {
  flags: FlagService;
  rails: RailRegistry;
  keys: PayoutKeys;
  clock: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const destinationAad = (payeeId: string) => `payee:destination:${payeeId}`;
export const destinationHash = (keys: PayoutKeys, e164: string) => hmacHex(keys.destinationHash, e164);
export function maskDestination(e164: string): string {
  return `${e164.slice(0, 6)}•••${e164.slice(-4)}`;
}

// ── Payees ──────────────────────────────────────────────────────────────────

export interface PayeeRow {
  id: string;
  wallet_id: string;
  label: string;
  holder_name: string;
  person_id: string | null;
  rail: 'ECOCASH' | 'ONEMONEY';
  destination_sealed: string;
  destination_masked: string;
  status: PayeeView['status'];
  verification: PayeeView['verification'];
  approval_id: string;
  replaces_payee: string | null;
  created_by: string;
  created_at: Date;
}

const PAYEE_COLS = `id, wallet_id, label, holder_name, person_id, rail, destination_sealed, destination_masked, status,
  verification, approval_id, replaces_payee, created_by, created_at`;

export async function loadPayee(q: Queryable, id: string, lock = false): Promise<PayeeRow> {
  if (!isUuid(id)) throw new NotFoundError('payee', String(id));
  const { rows } = await q.query<PayeeRow>(`SELECT ${PAYEE_COLS} FROM payee WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('payee', id);
  return rows[0];
}

export async function listPayees(q: Queryable, walletId: string): Promise<PayeeRow[]> {
  const { rows } = await q.query<PayeeRow>(`SELECT ${PAYEE_COLS} FROM payee WHERE wallet_id = $1 ORDER BY created_at, id`, [walletId]);
  return rows;
}

export function payeeView(r: PayeeRow): PayeeView {
  return {
    id: r.id,
    walletId: r.wallet_id,
    label: r.label,
    holderName: r.holder_name,
    personId: r.person_id,
    rail: r.rail,
    destination: r.destination_masked,
    status: r.status,
    verification: r.verification,
    approvalId: r.approval_id,
    replacesPayee: r.replaces_payee,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

// ── Payout requests ─────────────────────────────────────────────────────────

export interface PayoutRow {
  id: string;
  wallet_id: string;
  plan_id: string;
  part_no: number;
  payee_id: string;
  purpose: PayoutPurpose;
  purpose_note: string | null;
  payee_label: string | null;
  payee_masked: string | null;
  source_kind: PayoutSource;
  source_qualifier: string | null;
  account_id: string;
  currency: Currency;
  amount_minor: string;
  rail: string;
  requested_by: string;
  requested_at: Date;
  reservation_id: string;
  approval_id: string | null;
  status: PayoutStatus;
  attempts: number;
  next_attempt_at: Date | null;
  lease_until: Date | null;
  provider_ref: string | null;
  submitted_at: Date | null;
  last_error: string | null;
  confirmed_at: Date | null;
  payout_journal_id: string | null;
  override_approval_id: string | null;
  override_ref: string | null;
}

export const PAYOUT_COLS = `id, wallet_id, plan_id, part_no, payee_id, purpose, source_kind, source_qualifier, account_id, currency,
  amount_minor::text AS amount_minor, rail, requested_by, requested_at, reservation_id, approval_id, status, attempts,
  next_attempt_at, lease_until, provider_ref, submitted_at, last_error, confirmed_at, payout_journal_id,
  override_approval_id, override_ref, purpose_note,
  (SELECT label FROM payee WHERE payee.id = payout_request.payee_id) AS payee_label,
  (SELECT destination_masked FROM payee WHERE payee.id = payout_request.payee_id) AS payee_masked`;

export async function loadPayout(q: Queryable, id: string, lock = false): Promise<PayoutRow> {
  if (!isUuid(id)) throw new NotFoundError('payout_request', String(id));
  const { rows } = await q.query<PayoutRow>(`SELECT ${PAYOUT_COLS} FROM payout_request WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFoundError('payout_request', id);
  return rows[0];
}

export function payoutView(r: PayoutRow, blockedBy: string | null): PayoutView {
  return {
    id: r.id,
    walletId: r.wallet_id,
    planId: r.plan_id,
    partNo: r.part_no,
    payeeId: r.payee_id,
    purpose: r.purpose,
    purposeNote: r.purpose_note,
    payeeLabel: r.payee_label,
    payeeMasked: r.payee_masked,
    source: r.source_kind,
    amount: money(parseMinor(r.amount_minor), r.currency),
    rail: r.rail,
    status: r.status,
    approvalId: r.approval_id,
    attempts: r.attempts,
    providerRef: r.provider_ref,
    lastError: r.last_error,
    blockedBy,
    requestedBy: r.requested_by,
    requestedAt: new Date(r.requested_at).toISOString(),
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
  };
}

/**
 * Move a payout to `to` (the payout_request guard re-checks the transition)
 * and write the append-only history row.
 */
export async function transitionPayout(
  tx: CommandTx,
  actor: Actor,
  row: PayoutRow,
  to: PayoutStatus,
  set: Record<string, unknown>,
  opts: { reasonCode?: string; detail?: string; now: Date },
): Promise<void> {
  const cols = Object.keys(set);
  const assigns = cols.map((c, i) => `${c} = $${i + 3}`);
  await tx.query(
    `UPDATE payout_request SET status = $2${assigns.length ? ', ' + assigns.join(', ') : ''}, updated_at = now() WHERE id = $1`,
    [row.id, to, ...cols.map((c) => set[c])],
  );
  await tx.query(
    `INSERT INTO payout_event (payout_id, from_status, to_status, actor_id, actor_role, reason_code, detail, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [row.id, row.status, to, actor.personId, actorRoleLabel(actor), opts.reasonCode ?? null, opts.detail?.slice(0, 1000) ?? null, opts.now.toISOString()],
  );
  row.status = to;
}

export async function emit(tx: CommandTx, topic: PayoutTopic, payload: Record<string, unknown>): Promise<void> {
  await enqueueOutbox(tx, topic, payload);
}

// ── Shared checks (docs/08 Payout request, in order) ────────────────────────

export interface SourceRef {
  walletId: string;
  sourceKind: PayoutSource;
  sourceQualifier: string | null;
}

/** Active WALLET or SOURCE hold that applies to this source, if any (reason code). */
export async function applicableHold(q: Queryable, s: SourceRef): Promise<string | null> {
  const { rows } = await q.query<{ reason_code: string }>(
    `SELECT reason_code FROM hold
      WHERE wallet_id = $1 AND released_at IS NULL
        AND (scope = 'WALLET' OR (scope = 'SOURCE' AND source_kind = $2 AND source_qualifier IS NOT DISTINCT FROM $3))
      ORDER BY created_at LIMIT 1`,
    [s.walletId, s.sourceKind, s.sourceQualifier],
  );
  return rows[0]?.reason_code ?? null;
}

/** A live, approved mandate for the wallet's current admin (no mandate ⇒ no payouts). */
export async function mandateValid(q: Queryable, walletId: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM mandate m JOIN wallet w ON w.id = m.wallet_id
      WHERE m.wallet_id = $1 AND m.superseded_at IS NULL AND m.approved_at IS NOT NULL AND m.admin_person = w.admin_person`,
    [walletId],
  );
  return rows.length > 0;
}

/** Benefit money leaves only to the approved recipient on an approved WALLET route (docs/07). */
export async function benefitRouteOpen(q: Queryable, walletId: string, payeePersonId: string | null): Promise<boolean> {
  if (!payeePersonId) return false;
  const { rows } = await q.query(
    `SELECT 1 FROM fidelity_link WHERE wallet_id = $1 AND route_status = 'APPROVED' AND route_kind = 'WALLET'
        AND approved_recipient = $2`,
    [walletId, payeePersonId],
  );
  return rows.length > 0;
}

/**
 * Why this payout may not go to the provider right now (null = it may).
 * Re-run immediately before every submission: a hold, a case or a flag that
 * appeared after approval stops an unsubmitted payout.
 */
export async function submitBlocker(
  q: Queryable,
  deps: PayoutDeps,
  row: PayoutRow,
  opts: { ignoreRail?: boolean } = {},
): Promise<string | null> {
  const { rows: w } = await q.query<{ status: string }>('SELECT status FROM wallet WHERE id = $1', [row.wallet_id]);
  const status = w[0]?.status;
  if (status !== 'ACTIVE' && status !== 'CLOSING') return 'WALLET_NOT_ACTIVE';
  if (!(await mandateValid(q, row.wallet_id))) return 'NO_MANDATE';
  const hold = await applicableHold(q, { walletId: row.wallet_id, sourceKind: row.source_kind, sourceQualifier: row.source_qualifier });
  if (hold) return `HOLD:${hold}`;
  const { rows: cases } = await q.query('SELECT 1 FROM case_record WHERE payout_request_id = $1 AND closed_at IS NULL', [row.id]);
  if (cases.length) return 'CASE_OPEN';
  const payee = await loadPayee(q, row.payee_id);
  if (payee.status !== 'ACTIVE') return 'PAYEE_NOT_ACTIVE';
  if (row.source_kind === 'FIDELITY_BENEFIT' && !(await benefitRouteOpen(q, row.wallet_id, payee.person_id))) return 'BENEFIT_ROUTE_NOT_APPROVED';
  // A manual override pays outside the rail: the rail and kill-switch checks do not apply to it.
  if (opts.ignoreRail) return null;
  if (!(await deps.flags.getIn(q, 'payouts.enabled'))) return 'PAYOUTS_DISABLED';
  if (!(await deps.rails.collectable(q, row.rail))) return 'RAIL_DISABLED';
  return null;
}

export async function writeCaseEvent(
  q: Queryable,
  actor: Actor,
  caseId: string,
  kind: 'OPENED' | 'ASSIGNED' | 'ESCALATED' | 'NOTE' | 'EVIDENCE' | 'HOLD_PLACED' | 'HOLD_RELEASED' | 'RESOLVED',
  opts: { reasonCode?: string; note?: string; refId?: string; now: Date },
): Promise<void> {
  await q.query(
    `INSERT INTO case_event (case_id, kind, actor_id, actor_role, reason_code, note, ref_id, ts) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [caseId, kind, actor.personId, actorRoleLabel(actor), opts.reasonCode ?? null, opts.note ?? null, opts.refId ?? null, opts.now.toISOString()],
  );
}
