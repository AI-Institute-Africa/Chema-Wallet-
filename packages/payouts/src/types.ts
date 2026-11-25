// P07 vocabulary (docs/08). Lists live here once; the migration's CHECKs
// repeat them and a schema test keeps the two in step.
import type { Currency, Money } from '@chema/shared';

export const PAYOUT_PURPOSES = ['PARLOUR', 'TRANSPORT', 'FOOD', 'CHURCH', 'FAMILY_BENEFICIARY', 'OTHER_APPROVED'] as const;
export type PayoutPurpose = (typeof PAYOUT_PURPOSES)[number];

/** Mobile-money rails only: docs/08 "manual payee entry (mobile money number)". */
export const PAYOUT_RAILS = ['ECOCASH', 'ONEMONEY'] as const;
export type PayoutRail = (typeof PAYOUT_RAILS)[number];

export const PAYOUT_SOURCES = ['COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP'] as const;
export type PayoutSource = (typeof PAYOUT_SOURCES)[number];

export const PAYOUT_STATUSES = [
  'AWAITING_APPROVAL',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'RETRY',
  'RAIL_DOWN',
  'OVERRIDE_PENDING',
  'CONFIRMED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'REVERSED',
] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Statuses in which the reservation is still live (money set aside, not paid). */
export const OPEN_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'AWAITING_APPROVAL',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'RETRY',
  'RAIL_DOWN',
  'OVERRIDE_PENDING',
];

/** Not yet handed to a provider: may be cancelled, released and blocked by holds. */
export const UNSUBMITTED: readonly PayoutStatus[] = ['AWAITING_APPROVAL', 'APPROVED', 'RETRY', 'RAIL_DOWN'];

/** Submission retry: 1 min doubling, 5 attempts, then RAIL_DOWN (manual decision). */
export const PAYOUT_RETRY = { maxAttempts: 5, firstDelayMs: 60_000, leaseMs: 5 * 60_000, confirmWindowMs: 72 * 3_600_000 } as const;

export const CASE_TYPES = [
  'AUTHORITY_DISPUTE',
  'PAYMENT_DISPUTE',
  'CHARGEBACK',
  'FRAUD',
  'BENEFICIARY_MISMATCH',
  'PROVIDER_DISPUTE',
  'RECON',
  'REFUND',
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

/** Case types a person may open by hand (the others are opened by the system). */
export const OPENABLE_CASE_TYPES = ['AUTHORITY_DISPUTE', 'PAYMENT_DISPUTE', 'FRAUD', 'PROVIDER_DISPUTE'] as const;
export type OpenableCaseType = (typeof OPENABLE_CASE_TYPES)[number];

export const CASE_OUTCOMES = ['UPHELD', 'NOT_UPHELD', 'WITHDRAWN', 'SETTLED_BY_AGREEMENT', 'REFERRED_LEGAL', 'DUPLICATE', 'OTHER'] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Hold reasons. WALLET scope and any hold on another source than the dispute's need a *_RISK reason. */
export const HOLD_REASONS = [
  'AUTHORITY_DISPUTE',
  'PAYMENT_DISPUTE',
  'PROVIDER_DISPUTE',
  'BENEFICIARY_MISMATCH',
  'FRAUD_RISK',
  'LEGAL_RISK',
  'MATERIAL_RISK',
  'RECON_VARIANCE',
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];
export const RISK_REASONS: readonly HoldReason[] = ['FRAUD_RISK', 'LEGAL_RISK', 'MATERIAL_RISK'];

export const MANDATE_CHANGE_KINDS = ['REPLACE_ADMIN', 'ADD_APPROVER', 'REMOVE_APPROVER'] as const;
export type MandateChangeKind = (typeof MANDATE_CHANGE_KINDS)[number];
export const MANDATE_VERIFY_REASONS = [
  'AUTHORITY_SHOWN',
  'AUTHORITY_NOT_SHOWN',
  'IDENTITY_MISMATCH',
  'EVIDENCE_NOT_AUTHENTIC',
  'DISPUTED',
  'OTHER',
] as const;
export type MandateVerifyReason = (typeof MANDATE_VERIFY_REASONS)[number];

export const CLOSURE_REASONS = ['FUNERAL_COMPLETED', 'FAMILY_REQUEST', 'FRAUD_CONFIRMED', 'CREATED_IN_ERROR', 'DUPLICATE', 'OTHER'] as const;
export type ClosureReason = (typeof CLOSURE_REASONS)[number];

/** Case types that block closure while open ("material" disputes, docs/08 Closure). */
export const MATERIAL_CASE_TYPES: readonly CaseType[] = [
  'AUTHORITY_DISPUTE',
  'PAYMENT_DISPUTE',
  'CHARGEBACK',
  'FRAUD',
  'BENEFICIARY_MISMATCH',
  'PROVIDER_DISPUTE',
  'RECON',
  'REFUND',
];

export const PAYOUT_TOPICS = [
  'payout.requested',
  'payout.approved',
  'payout.submitted',
  'payout.confirmed',
  'payout.failed',
  'case.opened',
  'case.resolved',
  'hold.placed',
  'hold.released',
  'wallet.closing',
  'wallet.closed',
] as const;
export type PayoutTopic = (typeof PAYOUT_TOPICS)[number];

export function includes<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface PayeeView {
  id: string;
  walletId: string;
  label: string;
  holderName: string;
  personId: string | null;
  rail: PayoutRail;
  /** e.g. +26377•••4567. The full number is never returned. */
  destination: string;
  status: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'RETIRED';
  verification: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE' | null;
  approvalId: string;
  replacesPayee: string | null;
  createdAt: string;
}

export interface PayoutView {
  id: string;
  walletId: string;
  planId: string;
  partNo: number;
  payeeId: string;
  purpose: PayoutPurpose;
  /** Free text the family gave with the request (shown to the family and staff only). */
  purposeNote: string | null;
  /** Payee label and masked destination, for display; the full number is never returned. */
  payeeLabel: string | null;
  payeeMasked: string | null;
  source: PayoutSource;
  amount: Money;
  rail: string;
  status: PayoutStatus;
  approvalId: string | null;
  attempts: number;
  providerRef: string | null;
  lastError: string | null;
  /** Why an approved request is not moving (hold, open case, rail off), if anything. */
  blockedBy: string | null;
  requestedBy: string;
  requestedAt: string;
  confirmedAt: string | null;
}

export interface CaseView {
  id: string;
  type: CaseType;
  walletId: string | null;
  status: 'OPEN' | 'ASSIGNED' | 'ESCALATED' | 'RESOLVED';
  severity: Severity;
  summary: string;
  assigneeId: string | null;
  slaDueAt: string;
  escalationLevel: number;
  source: PayoutSource | null;
  amount: Money | null;
  payoutRequestId: string | null;
  holds: { id: string; scope: string; source: string | null; reasonCode: string; released: boolean }[];
  outcome: CaseOutcome | null;
  openedAt: string;
  closedAt: string | null;
}

export interface ClosureCheck {
  walletId: string;
  status: string;
  /** Empty ⇒ the wallet may be closed now. */
  blockers: string[];
  residual: { source: string; currency: Currency; amount: Money }[];
}

export interface UsageLine {
  purpose: PayoutPurpose;
  amount: Money;
}
