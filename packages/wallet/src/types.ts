// Wallet lifecycle vocabulary (docs/03 state machine, docs/05 verification).
import { ConflictError, type DocumentClass } from '@chema/core';

export const WALLET_STATUSES = [
  'DRAFT',
  'PENDING_VERIFICATION',
  'ACTIVE',
  'VERIFICATION_REJECTED',
  'SUSPENDED',
  'CLOSING',
  'CLOSED',
] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

/** Statuses a public endpoint may serve. Everything else is a 404 (docs/05). */
export const PUBLIC_STATUSES: ReadonlySet<WalletStatus> = new Set<WalletStatus>(['ACTIVE']);

/** Death evidence kinds; which ones count is config `verification.evidence_types` (D05). */
export const DEATH_EVIDENCE_TYPES = ['DEATH_CERTIFICATE', 'PARLOUR_CONFIRMATION', 'BURIAL_ORDER'] as const;
export type DeathEvidenceType = (typeof DEATH_EVIDENCE_TYPES)[number];

export const EVIDENCE_TYPES = [...DEATH_EVIDENCE_TYPES, 'ADMIN_ID', 'MANDATE', 'OTHER'] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** The document class each evidence type must be uploaded as. */
export const EVIDENCE_DOCUMENT_CLASS: Readonly<Record<EvidenceType, DocumentClass>> = {
  DEATH_CERTIFICATE: 'DEATH_EVIDENCE',
  PARLOUR_CONFIRMATION: 'DEATH_EVIDENCE',
  BURIAL_ORDER: 'DEATH_EVIDENCE',
  ADMIN_ID: 'ID',
  MANDATE: 'MANDATE',
  OTHER: 'OTHER',
};

export const VERIFICATION_OUTCOMES = ['APPROVED', 'REJECTED', 'MORE_INFO'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export const VERIFICATION_REASON_CODES = [
  'EVIDENCE_SUFFICIENT',
  'MISSING_EVIDENCE',
  'IDENTITY_MISMATCH',
  'AUTHORITY_NOT_SHOWN',
  'EVIDENCE_NOT_AUTHENTIC',
  'DETAILS_INCONSISTENT',
  'DUPLICATE_WALLET',
  'OTHER',
] as const;
export type VerificationReasonCode = (typeof VERIFICATION_REASON_CODES)[number];

/** Reviewer checklist (docs/05: evidence reviewed). APPROVED needs every item PASS. */
export const CHECKLIST_ITEMS = [
  'DEATH_EVIDENCE_VALID',
  'ADMIN_IDENTITY_MATCHES',
  'MANDATE_SHOWS_AUTHORITY',
  'DETAILS_CONSISTENT',
  'FRAUD_FLAGS_REVIEWED',
] as const;
export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];
export type Checklist = Record<ChecklistItem, 'PASS' | 'FAIL'>;

export const SUSPEND_REASON_CODES = [
  'FRAUD_SUSPECTED',
  'AUTHORITY_DISPUTE',
  'EVIDENCE_CHALLENGED',
  'LEGAL_ORDER',
  'OTHER',
] as const;
export type SuspendReasonCode = (typeof SUSPEND_REASON_CODES)[number];

export const REPORT_CATEGORIES = ['FAKE_DEATH', 'NOT_FAMILY', 'DUPLICATE', 'SCAM', 'OTHER'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const FRAUD_RULES = ['DUPLICATE_DECEASED', 'DUPLICATE_CERTIFICATE', 'ADMIN_MULTI_DEATH', 'CREATOR_VELOCITY'] as const;
export type FraudRule = (typeof FRAUD_RULES)[number];

/** Outbox topics (docs/05 Events + MORE_INFO / unsuspend notifications). */
export const WALLET_TOPICS = [
  'wallet.draft_created',
  'wallet.verification_submitted',
  'wallet.verified',
  'wallet.verification_rejected',
  'wallet.verification_more_info',
  'wallet.suspended',
  'wallet.unsuspended',
  'wallet.report_received',
] as const;
export type WalletTopic = (typeof WALLET_TOPICS)[number];

export const includes = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** Submission refused: names exactly what is missing. */
export class MissingEvidenceError extends ConflictError {
  constructor(readonly missing: readonly string[]) {
    super('MISSING_EVIDENCE');
    this.name = 'MissingEvidenceError';
  }
}

export interface Badge {
  label: string;
  tooltip: string;
}

export interface ShareLinks {
  text: string;
  url: string;
  whatsapp: string;
  sms: string;
  facebook: string;
  copy: string;
}

export interface EvidenceView {
  id: string;
  documentId: string;
  evidenceType: EvidenceType;
  scan: 'PENDING' | 'CLEAN' | 'INFECTED';
  addedAt: string;
}

export interface CaseView {
  id: string;
  submittedAt: string;
  appealOf: string | null;
  outcome: VerificationOutcome | null;
  reasonCode: VerificationReasonCode | null;
  decidedAt: string | null;
}

export interface FraudFlagView {
  id: string;
  rule: FraudRule;
  matchedWalletId: string | null;
  details: Record<string, unknown>;
  reviewedAt: string | null;
  reviewOutcome: 'DISMISSED' | 'CONFIRMED' | null;
}

/** The private wallet view (family, assigned staff). */
export interface WalletView {
  id: string;
  status: WalletStatus;
  deceasedName: string;
  dateOfDeath: string;
  funeralDate: string | null;
  funeralLocation: string;
  currency: 'USD' | 'ZWG';
  targetMinor: string | null;
  createdByKind: 'CUSTOMER' | 'AGENT';
  createdAt: string;
  verifiedAt: string | null;
  /** Only while ACTIVE (docs/05: pending/rejected never show the badge). */
  badge: Badge | null;
  publicSlug: string | null;
  share: ShareLinks | null;
  evidence: EvidenceView[];
  latestCase: CaseView | null;
  canAppeal: boolean;
  /** Staff only. */
  fraudFlags?: FraudFlagView[];
}

/** What a public endpoint may show (ACTIVE wallets only). */
export interface PublicWalletView {
  slug: string;
  deceasedName: string;
  funeralDate: string | null;
  badge: Badge;
  share: ShareLinks;
}
