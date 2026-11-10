// Fidelity Claims adapter (docs/07 "Adapter interface"). Fidelity is the
// system of record for policies, claim decisions and benefit payments; the
// real module APIs / SSO / event bus are unconfirmed (D14), so the service is
// built against this interface, a MockFidelity and a stub that refuses to run.
// Adapters hold no business logic: they translate, they never decide.
import type { Money } from '@chema/shared';

export const CLAIM_STATUSES = ['NONE', 'SUBMITTED', 'IN_REVIEW', 'MORE_INFO', 'APPROVED', 'DECLINED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface PolicyIdentifier {
  policyNo?: string;
  /** National ID of the deceased (the covered life). */
  nationalId?: string;
}

export interface CoveredLife {
  lifeRef: string;
  name: string;
  nationalId?: string;
}

export interface PolicyRecord {
  policyNo: string;
  status: 'ACTIVE' | 'INACTIVE' | 'LAPSED';
  premiumStatus: 'UP_TO_DATE' | 'ARREARS';
  coveredLives: readonly CoveredLife[];
}

/** Who is asking, for Fidelity's own access log. Never a phone number or name. */
export interface Requester {
  ref: string;
  role: string;
}

export interface ClaimRequest {
  /** sha256(wallet | policy | deceased): the same claim is never lodged twice. */
  idempotencyKey: string;
  /** Chema wallet id, stored on the Fidelity claim. */
  walletRef: string;
  policyNo: string;
  deceased: { name: string; dateOfDeath: string; nationalId?: string };
  evidenceRefs: readonly string[];
}

export interface ClaimStatusReport {
  status: ClaimStatus;
  /** Mapped reason code for DECLINED / MORE_INFO (e.g. POLICY_LAPSED). Never free text. */
  reasonCode?: string;
}

/** Fidelity's approved recipient / payment route (Claims + Finance + Legal). */
export interface RecipientRoute {
  routeRef: string;
  /** WALLET ⇒ the benefit is paid into this wallet's benefit sub-ledger; DIRECT ⇒ Fidelity pays the recipient itself. */
  route: 'WALLET' | 'DIRECT';
  /** Identity of the approved recipient (national ID). Hashed on arrival, never stored. */
  recipient: { idNumber: string };
  /** Fidelity functions that approved the route, e.g. ['CLAIMS', 'FINANCE']. */
  approvedBy: readonly string[];
}

export interface BenefitPayment {
  paymentRef: string;
  amount: Money;
  status: 'PENDING' | 'SETTLED' | 'FAILED';
  /** YYYY-MM-DD, when SETTLED. */
  settledOn?: string;
}

/** One line of Fidelity's benefit-payment ledger for a day (daily recon). */
export interface BenefitSettlementRow {
  paymentRef: string;
  claimRef: string;
  walletRef: string;
  amount: Money;
  settledOn: string;
}

export const FIDELITY_EVENT_TYPES = ['claim.status_changed', 'claim.approved', 'claim.declined', 'benefit.paid', 'route.decided'] as const;
export type FidelityEventType = (typeof FIDELITY_EVENT_TYPES)[number];

/** A verified callback. It only says WHAT changed; the service re-reads the record. */
export interface FidelityEvent {
  eventId: string;
  type: FidelityEventType;
  claimRef: string;
}

export interface FidelityAdapter {
  readonly name: string;
  /** null ⇒ no policy found. Consent + role are checked by the caller. */
  lookupPolicy(identifier: PolicyIdentifier, requester: Requester): Promise<PolicyRecord | null>;
  /** Idempotent on `idempotencyKey`. Throws DuplicateClaimError if another claim exists for this deceased. */
  createOrLinkClaim(req: ClaimRequest): Promise<{ claimRef: string }>;
  getClaimStatus(claimRef: string): Promise<ClaimStatusReport>;
  submitEvidence(claimRef: string, docRefs: readonly string[]): Promise<void>;
  /** Throws WebhookRejectedError unless signed, fresh and well formed. */
  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: string, now: Date): FidelityEvent;
  /** null ⇒ no route decided yet. */
  getApprovedRecipientRoute(claimRef: string): Promise<RecipientRoute | null>;
  /** null ⇒ no benefit payment exists yet. */
  getBenefitPayment(claimRef: string): Promise<BenefitPayment | null>;
  /** Benefit payments Fidelity recorded as settled into Chema on `date`. */
  benefitSettlements(date: string): Promise<readonly BenefitSettlementRow[]>;
}

/** Fidelity could not be reached (or timed out): retry later; nothing is assumed. */
export class FidelityUnavailableError extends Error {
  constructor(readonly reason = 'unavailable') {
    super(`fidelity unavailable: ${reason}`);
    this.name = 'FidelityUnavailableError';
  }
}

/** Fidelity already holds a claim for this deceased under this policy (surfaced, never overridden). */
export class DuplicateClaimError extends Error {
  constructor() {
    super('duplicate claim');
    this.name = 'DuplicateClaimError';
  }
}

/** Fidelity definitively refused the request (e.g. unknown policy). `code` is mapped, never free text. */
export class FidelityRejectedError extends Error {
  constructor(readonly code: string) {
    super(`fidelity rejected: ${code}`);
    this.name = 'FidelityRejectedError';
  }
}

/** The real integration is not configured (D14). */
export class FidelityNotConfiguredError extends Error {
  constructor() {
    super('Fidelity integration is not configured (D14)');
    this.name = 'FidelityNotConfiguredError';
  }
}
