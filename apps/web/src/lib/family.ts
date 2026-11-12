// Family (signed-in wallet admin / approver) client + display helpers for the
// claim, funds, payees, payouts, cases and closure screens. No rules here:
// the API authorises and validates every call; these helpers only choose
// which catalogue message to show. Money stays `{minor: string, ccy}`.
import { catalogues, t, type MessageKey } from '@chema/shared/i18n';
import { ApiError, bytesToBase64, majorToMinor, type Fetch } from './api';
import type { MoneyJSON } from './public';

export type Source = 'COMMUNITY' | 'GROUP' | 'FIDELITY_BENEFIT';

export interface FundsLine {
  source: Source;
  labelKey: string;
  groupId: string | null;
  settled: MoneyJSON;
  pending: MoneyJSON;
  held: MoneyJSON;
  available: MoneyJSON;
  paid: MoneyJSON;
}

export type BenefitStatus =
  | 'NOT_LINKED'
  | 'LINK_PENDING'
  | 'DUPLICATE_CLAIM'
  | 'LINK_REJECTED'
  | 'CLAIM_SUBMITTED'
  | 'CLAIM_IN_REVIEW'
  | 'CLAIM_MORE_INFO'
  | 'CLAIM_DECLINED'
  | 'ROUTE_PENDING'
  | 'ROUTE_BLOCKED'
  | 'PAYMENT_PENDING'
  | 'CREDITED'
  | 'PAID_DIRECT';

export interface FundsView {
  walletId: string;
  lines: FundsLine[];
  benefit: { status: BenefitStatus; reason: string | null; statusUpdating: boolean };
}

export interface ClaimView {
  walletId: string;
  linked: boolean;
  policyNo: string | null;
  lookupOutcome: LookupOutcome | null;
  linkState: string;
  claimStatus: string;
  routeStatus: string;
  benefit: { paymentStatus: string; amountMinor: string | null; currency: 'USD' | 'ZWG' | null; credited: boolean };
  statusUpdating: boolean;
}

export type LookupOutcome = 'ELIGIBLE' | 'NO_POLICY' | 'INACTIVE' | 'COVERED_LIFE_MISMATCH' | 'ARREARS';

export interface Payee {
  id: string;
  label: string;
  holderName: string;
  rail: 'ECOCASH' | 'ONEMONEY';
  /** Masked by the server; the full number is never returned. */
  destination: string;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'RETIRED';
  verification: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE' | null;
  createdAt: string;
}

export const PAYOUT_PURPOSES = ['PARLOUR', 'TRANSPORT', 'FOOD', 'CHURCH', 'FAMILY_BENEFICIARY', 'OTHER_APPROVED'] as const;
export type Purpose = (typeof PAYOUT_PURPOSES)[number];

export interface Payout {
  id: string;
  planId: string;
  payeeId: string;
  purpose: Purpose;
  source: Source;
  amount: MoneyJSON;
  status: string;
  blockedBy: string | null;
  requestedAt: string;
  confirmedAt: string | null;
}

export interface PlanResult {
  planId: string;
  approvalId: string | null;
  payouts: Payout[];
  replayed: boolean;
}

export const OPENABLE_CASE_TYPES = ['AUTHORITY_DISPUTE', 'PAYMENT_DISPUTE', 'FRAUD', 'PROVIDER_DISPUTE'] as const;

export interface CaseView {
  id: string;
  type: string;
  status: 'OPEN' | 'ASSIGNED' | 'ESCALATED' | 'RESOLVED';
  summary: string;
  holds: { id: string; released: boolean }[];
  outcome: string | null;
  openedAt: string;
  closedAt: string | null;
}

export const FAMILY_CLOSURE_REASONS = ['FUNERAL_COMPLETED', 'FAMILY_REQUEST', 'CREATED_IN_ERROR', 'DUPLICATE', 'OTHER'] as const;
export type ClosureReason = (typeof FAMILY_CLOSURE_REASONS)[number];

export interface ClosureCheck {
  walletId: string;
  status: string;
  blockers: string[];
  residual: { source: string; currency: string; amount: MoneyJSON }[];
}

export interface Statement {
  kind: string;
  contentHash: string;
  generatedAt: string;
  content: {
    deceasedName?: string;
    sources?: { source: string; settled: MoneyJSON; paid: MoneyJSON }[];
    payouts?: { purpose: string; payee: string; source: string; amount: MoneyJSON; at: string }[];
  };
}

// ── Display helpers (pure) ───────────────────────────────────────────────────

const has = (key: string): key is MessageKey => Object.prototype.hasOwnProperty.call(catalogues.en, key);
const slug = (code: string) => code.toLowerCase();

/** Catalogue message for `${prefix}.${code}` or the fallback key. */
export function msgFor(prefix: string, code: string, fallback: MessageKey, params: Record<string, string> = {}): string {
  const key = `${prefix}.${slug(code)}`;
  return has(key) ? t(key, params) : t(fallback, params);
}

/** Server label keys (e.g. `funds.source.community`) are shown only if they are ours. */
export function labelFor(labelKey: string, source: Source): string {
  if (has(labelKey)) return t(labelKey);
  return t(sourceKey(source));
}

export function sourceKey(source: string): MessageKey {
  if (source.includes('FIDELITY_BENEFIT')) return 'funds.source.fidelity_benefit';
  if (source.includes('GROUP')) return 'funds.source.group';
  return 'funds.source.community';
}

/** The family view keeps the benefit apart: community + group lines first, benefit lines alone. */
export function splitFunds(lines: readonly FundsLine[]): { community: FundsLine[]; benefit: FundsLine[] } {
  return {
    community: lines.filter((l) => l.source !== 'FIDELITY_BENEFIT'),
    benefit: lines.filter((l) => l.source === 'FIDELITY_BENEFIT'),
  };
}

export function benefitMessage(status: BenefitStatus): string {
  switch (status) {
    case 'NOT_LINKED':
      return t('funds.benefit.not_linked');
    case 'CLAIM_DECLINED':
      return t('funds.benefit.declined');
    case 'ROUTE_BLOCKED':
      return t('funds.benefit.route_blocked');
    case 'PAYMENT_PENDING':
      return t('funds.benefit.payment_pending');
    default:
      return msgFor('fam.benefit', status, 'funds.benefit.status_updating');
  }
}

export const purposeLabel = (p: string) => msgFor('payout.purpose', p, 'payout.purpose.other_approved');
export const payoutStatusLabel = (s: string) => msgFor('fam.payout.status', s, 'fam.payouts.waiting');
export const closureBlockerLabel = (b: string) => msgFor('fam.closure.blocker', b, 'fam.closure.blocker.other');

/** A cancel is offered only while nothing was handed to a provider (the server re-checks). */
export function cancellable(status: string): boolean {
  return status === 'AWAITING_APPROVAL' || status === 'APPROVED' || status === 'RETRY';
}

/** Error → one calm sentence. Never shows raw server text beyond a short code. */
export function explainError(e: unknown): string {
  if (!(e instanceof ApiError)) return t('error.internal');
  if (e.status === 401) return t('fam.error.signin');
  if (e.status === 403) return t('fam.error.denied');
  if (e.status === 404) return t('fam.error.not_found');
  if (e.status === 400) return t('fam.error.invalid');
  if (e.status === 429) return t('fam.error.rate_limited');
  if (e.status === 503) return t('fam.error.fidelity_down');
  if (e.status === 409 && e.code === 'insufficient_funds') return t('fam.error.insufficient');
  if (e.status === 409) return t('fam.error.refused', { reason: e.code.replace(/_/g, ' ') });
  return t('error.internal');
}

/** Payout request body; the amount is typed in major units and converted without floats. */
export function payoutBody(input: { source: Source; currency: 'USD' | 'ZWG'; payeeId: string; amount: string; purpose: Purpose; note?: string; idempotencyKey: string }) {
  const minor = majorToMinor(input.amount);
  if (minor <= 0n) throw new RangeError('amount must be positive');
  const note = input.note?.trim();
  return {
    source: { kind: input.source },
    currency: input.currency,
    parts: [{ payeeId: input.payeeId, amountMinor: minor.toString(), purpose: input.purpose, ...(note ? { note } : {}) }],
    idempotencyKey: input.idempotencyKey,
  };
}

export function newIdempotencyKey(): string {
  return `web:${crypto.randomUUID()}`;
}

export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface StepUpTarget {
  action: 'payout.request' | 'wallet.change_payout_destination';
  subjectType: 'wallet';
  subjectId: string;
}

export function createFamilyClient(opts: { baseUrl: string; token?: () => string | null; fetch?: Fetch }) {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const s = encodeURIComponent;

  async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { ...extra };
    const token = opts.token?.();
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, { method, headers, cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (json ?? {}) as { error?: string; missing?: string[] };
      throw new ApiError(res.status, err.error ?? 'error', err.missing ?? []);
    }
    return json as T;
  }
  const stepUp = (token: string) => ({ 'x-step-up-token': token });
  const w = (id: string) => `/wallets/${s(id)}`;

  return {
    stepUpStart: (target: StepUpTarget) => call<{ challengeId: string }>('POST', '/auth/step-up/start', target),
    stepUpVerify: (challengeId: string, code: string) => call<{ stepUpToken: string; expiresAt: string }>('POST', '/auth/step-up/verify', { challengeId, code }),

    funds: (id: string) => call<FundsView>('GET', `${w(id)}/funds`),
    claim: (id: string) => call<ClaimView>('GET', `${w(id)}/claim`),
    lookup: (id: string, ident: { policyNo?: string; nationalId?: string }) =>
      call<{ outcome: LookupOutcome; policyNo: string | null; linkable: boolean }>('POST', `${w(id)}/claim/lookup`, ident),
    linkClaim: (id: string, recipientPersonId: string, recipientIdNumber: string) =>
      call<ClaimView>('POST', `${w(id)}/claim`, { recipientPersonId, recipientIdNumber }),
    uploadDocument: (walletId: string, cls: 'DEATH_EVIDENCE' | 'ID' | 'OTHER', contentType: string, bytes: Uint8Array) =>
      call<{ id: string }>('POST', '/documents', { class: cls, contentType, dataBase64: bytesToBase64(bytes), walletId }),
    claimEvidence: (id: string, documentIds: string[]) => call<unknown>('POST', `${w(id)}/claim/evidence`, { documentIds }),

    payees: (id: string) => call<Payee[]>('GET', `${w(id)}/payees`),
    addPayee: (id: string, p: { label: string; holderName: string; rail: Payee['rail']; destination: string }, stepUpToken: string) =>
      call<Payee>('POST', `${w(id)}/payees`, p, stepUp(stepUpToken)),

    payouts: (id: string) => call<Payout[]>('GET', `${w(id)}/payouts`),
    requestPayout: (id: string, body: ReturnType<typeof payoutBody>, stepUpToken: string) =>
      call<PlanResult>('POST', `${w(id)}/payouts`, body, stepUp(stepUpToken)),
    cancelPayout: (payoutId: string, reason: string) => call<unknown>('POST', `/payouts/${s(payoutId)}/cancel`, { reason }),

    cases: (id: string) => call<CaseView[]>('GET', `${w(id)}/cases`),
    openCase: (id: string, type: (typeof OPENABLE_CASE_TYPES)[number], summary: string) => call<CaseView>('POST', `${w(id)}/cases`, { type, summary }),
    caseView: (caseId: string) => call<CaseView>('GET', `/cases/${s(caseId)}`),

    closure: (id: string) => call<ClosureCheck>('GET', `${w(id)}/closure`),
    startClose: (id: string, reasonCode: ClosureReason, note?: string) =>
      call<{ status: string }>('POST', `${w(id)}/close`, { kind: 'CLOSE', reasonCode, ...(note?.trim() ? { note: note.trim() } : {}) }),
    finalise: (id: string) => call<{ status: string }>('POST', `${w(id)}/close/finalise`),
    thank: (id: string) => call<{ queued: number }>('POST', `${w(id)}/thank-contributors`),
    statements: (id: string) => call<Statement[]>('GET', `${w(id)}/statements`),
  };
}

export type FamilyClient = ReturnType<typeof createFamilyClient>;
