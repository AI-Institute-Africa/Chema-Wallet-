// Row shapes, loaders and pure helpers for the claim path.
import { createHmac } from 'node:crypto';
import { NotFoundError, hmacHex, sha256Hex, type FlagService } from '@chema/core';
import type { Currency, Queryable } from '@chema/shared';
import type { ClaimStatus } from './adapter';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export interface ClaimsDeps {
  flags: FlagService;
  clock: () => Date;
  /** Keyed hash of recipient national IDs (compare without storing them). */
  recipientKey: Buffer;
}

/** Derive the recipient-ID hash key from CHEMA_DATA_KEY (never the raw key). */
export function deriveRecipientKey(dataKey: Buffer): Buffer {
  return createHmac('sha256', dataKey).update('chema:fidelity-recipient:v1').digest();
}

export const LOOKUP_OUTCOMES = ['ELIGIBLE', 'NO_POLICY', 'INACTIVE', 'COVERED_LIFE_MISMATCH', 'ARREARS'] as const;
export type LookupOutcome = (typeof LOOKUP_OUTCOMES)[number];
/**
 * ASSUMPTION (D10 unresolved): Chema never decides a claim, so an inactive or
 * in-arrears policy may still be lodged — Fidelity decides. Only a lookup that
 * found no policy, or no covered life matching the deceased, cannot be linked.
 */
export const LINKABLE_OUTCOMES: ReadonlySet<LookupOutcome> = new Set<LookupOutcome>(['ELIGIBLE', 'ARREARS', 'INACTIVE']);

export type LinkState = 'NONE' | 'QUEUED' | 'LINKED' | 'DUPLICATE_CLAIM' | 'REJECTED';
export type RouteStatus = 'UNSET' | 'PENDING_APPROVAL' | 'APPROVED' | 'BLOCKED_MISMATCH';
export type BenefitPaymentStatus = 'NONE' | 'PENDING' | 'SETTLED' | 'FAILED';

export interface LinkRow {
  id: string;
  wallet_id: string;
  policy_no: string | null;
  national_id: string | null;
  claim_ref: string | null;
  claim_status_mirror: ClaimStatus;
  route_status: RouteStatus;
  lookup_outcome: LookupOutcome | null;
  lookup_policy_no: string | null;
  claim_key: string | null;
  link_state: LinkState;
  link_error: string | null;
  claim_reason: string | null;
  proposed_recipient: string | null;
  proposed_recipient_id_hash: string | null;
  route_kind: 'WALLET' | 'DIRECT' | null;
  route_ref: string | null;
  route_approved_by: string[] | null;
  approved_recipient: string | null;
  mismatch_case_id: string | null;
  mismatch_hold_id: string | null;
  route_approval_ref: string | null;
  benefit_minor: string | null;
  benefit_currency: Currency | null;
  benefit_payment_ref: string | null;
  benefit_payment_status: BenefitPaymentStatus;
  benefit_settled_on: string | null;
  benefit_journal_id: string | null;
  last_synced_at: Date | null;
}

const LINK_COLS = `id, wallet_id, policy_no, national_id, claim_ref, claim_status_mirror, route_status, lookup_outcome,
  lookup_policy_no, claim_key, link_state, link_error, claim_reason, proposed_recipient, proposed_recipient_id_hash,
  route_kind, route_ref, route_approved_by, approved_recipient, mismatch_case_id, mismatch_hold_id, route_approval_ref,
  benefit_minor::text AS benefit_minor, benefit_currency, benefit_payment_ref, benefit_payment_status,
  benefit_settled_on::text AS benefit_settled_on, benefit_journal_id, last_synced_at`;

export async function linkByWallet(q: Queryable, walletId: string, lock = false): Promise<LinkRow | undefined> {
  if (!isUuid(walletId)) return undefined;
  const { rows } = await q.query<LinkRow>(`SELECT ${LINK_COLS} FROM fidelity_link WHERE wallet_id = $1${lock ? ' FOR UPDATE' : ''}`, [walletId]);
  return rows[0];
}

export async function linkById(q: Queryable, linkId: string, lock = false): Promise<LinkRow> {
  if (!isUuid(linkId)) throw new NotFoundError('fidelity_link', String(linkId));
  const { rows } = await q.query<LinkRow>(`SELECT ${LINK_COLS} FROM fidelity_link WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [linkId]);
  const r = rows[0];
  if (!r) throw new NotFoundError('fidelity_link', linkId);
  return r;
}

export async function linkByClaimRef(q: Queryable, claimRef: string): Promise<LinkRow | undefined> {
  const { rows } = await q.query<LinkRow>(`SELECT ${LINK_COLS} FROM fidelity_link WHERE claim_ref = $1`, [claimRef]);
  return rows[0];
}

export interface WalletRow {
  id: string;
  status: string;
  deceased_name: string;
  date_of_death: string;
  currency: Currency;
  admin_person: string;
  created_by: string;
}

export async function loadWallet(q: Queryable, walletId: string): Promise<WalletRow> {
  if (!isUuid(walletId)) throw new NotFoundError('wallet', String(walletId));
  const { rows } = await q.query<WalletRow>(
    `SELECT id, status, deceased_name, date_of_death::text AS date_of_death, currency, admin_person, created_by
       FROM wallet WHERE id = $1`,
    [walletId],
  );
  const w = rows[0];
  if (!w) throw new NotFoundError('wallet', walletId);
  return w;
}

/** Case/name normalisation for matching (diacritics, punctuation and spacing ignored). */
export function normName(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

/** National ID normalisation: upper-case letters and digits only. */
export function normId(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function recipientHash(deps: Pick<ClaimsDeps, 'recipientKey'>, idNumber: string): string {
  return hmacHex(deps.recipientKey, normId(idNumber));
}

/** Idempotency key of a claim: wallet + policy + deceased (docs/07 Resilience). */
export function claimKey(walletId: string, policyNo: string, deceasedName: string, dateOfDeath: string): string {
  return sha256Hex(`claim:v1|${walletId}|${policyNo.trim().toUpperCase()}|${normName(deceasedName)}|${dateOfDeath}`);
}

/** Policy number for display: last 4 characters only. */
export function maskPolicy(p: string | null): string | null {
  if (!p) return null;
  return p.length <= 4 ? '****' : `${'*'.repeat(Math.min(p.length - 4, 8))}${p.slice(-4)}`;
}

export function effectivePolicyNo(l: Pick<LinkRow, 'policy_no' | 'lookup_policy_no'>): string | null {
  return l.lookup_policy_no ?? l.policy_no;
}

/** Is a call to Fidelity for this link queued or retrying? (family: "status updating") */
export async function hasOpenRequest(q: Queryable, linkId: string): Promise<boolean> {
  const { rows } = await q.query("SELECT 1 FROM fidelity_request WHERE link_id = $1 AND status IN ('QUEUED', 'RETRY') LIMIT 1", [linkId]);
  return rows.length > 0;
}

/** Person holds an active, non-agent role on the wallet (a family-side person). */
export async function isFamilyMember(q: Queryable, walletId: string, personId: string): Promise<boolean> {
  if (!isUuid(personId)) return false;
  const { rows } = await q.query(
    "SELECT 1 FROM wallet_role WHERE wallet_id = $1 AND person_id = $2 AND revoked_at IS NULL AND role <> 'AGENT' LIMIT 1",
    [walletId, personId],
  );
  return rows.length > 0;
}

/** Staff member has an active assignment to the wallet (claims officers see assigned cases only). */
export async function isAssignedStaff(q: Queryable, walletId: string, personId: string): Promise<boolean> {
  if (!isUuid(personId)) return false;
  const { rows } = await q.query('SELECT 1 FROM staff_assignment WHERE wallet_id = $1 AND staff_person_id = $2 AND revoked_at IS NULL LIMIT 1', [
    walletId,
    personId,
  ]);
  return rows.length > 0;
}
