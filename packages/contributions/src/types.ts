// Contribution, tribute and public-page shapes (docs/06).
import type { FeeDisclosure, PaymentState } from '@chema/payments';
import type { NextAction } from '@chema/providers';
import type { Money } from '@chema/shared';
import type { Badge, ShareLinks } from '@chema/wallet';

/** Family privacy toggles (docs/06 Public page). Stored in wallet.privacy. */
export const PRIVACY_KEYS = [
  'showTotal',
  'showUsageSummary',
  'showPhoto',
  'showContributorNames',
  'showAmounts',
  'showTributes',
  // UI redesign (2026-11-11): the Fidelity policy number on the public page. Personal data: off by default.
  'showPolicyNumber',
] as const;
export type PrivacyKey = (typeof PRIVACY_KEYS)[number];
export type PrivacySettings = Record<PrivacyKey, boolean>;

/**
 * Safest default (CLAUDE.md rule 5): everything hidden until the family turns
 * it on. The page still shows the deceased's name, funeral details, the badge
 * and the contribute / share / report buttons.
 */
export const DEFAULT_PRIVACY: PrivacySettings = {
  showTotal: false,
  showUsageSummary: false,
  showPhoto: false,
  showContributorNames: false,
  showAmounts: false,
  showTributes: false,
  showPolicyNumber: false,
};

/** Unknown keys and non-booleans in stored JSON are ignored (default applies). */
export function privacyOf(raw: unknown): PrivacySettings {
  const out: PrivacySettings = { ...DEFAULT_PRIVACY };
  if (raw && typeof raw === 'object') {
    for (const k of PRIVACY_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

export const TRIBUTE_STATUSES = ['AWAITING_PAYMENT', 'VISIBLE', 'HIDDEN', 'REJECTED', 'REMOVED', 'VOID'] as const;
export type TributeStatus = (typeof TRIBUTE_STATUSES)[number];

export const CONTACT_KINDS = ['PHONE', 'EMAIL'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface ContributeInput {
  slug: string;
  rail: string;
  amount: Money;
  idempotencyKey: string;
  /** Light KYC (docs/06): always required while kyc.contributor_light_max_minor is unset. */
  payerName: string;
  payerPhone: string;
  /** Public display only; KYC data is kept either way. */
  anonymous: boolean;
  displayName?: string;
  tribute?: string;
  contact?: { kind: ContactKind; value: string };
  /** Group contribution (feature.group_contributions). The actor must be the group's representative. */
  groupId?: string;
}

export interface ContributeResult {
  contributionId: string;
  /** Capability for the signed receipt/status link. Never stored; recomputed from the id. */
  accessToken: string;
  payment: { id: string; state: PaymentState; disclosure: FeeDisclosure; next: NextAction | null };
  replayed: boolean;
}

export interface ContributionReceipt {
  receiptNo: string;
  funeralName: string;
  walletRef: string;
  paymentRef: string;
  rail: string;
  amount: Money;
  fee: Money;
  net: Money;
  /** null ⇒ no currency conversion. */
  fxRate: string | null;
  issuedAt: string;
}

export interface ContributionView {
  id: string;
  walletId: string;
  funeralName: string;
  state: PaymentState;
  disclosure: FeeDisclosure;
  next: NextAction | null;
  anonymous: boolean;
  displayName: string | null;
  groupName: string | null;
  tribute: { status: TributeStatus; message: string | null; flagReasons: string[]; appealed: boolean } | null;
  receipt: ContributionReceipt | null;
  createdAt: string;
}

export interface PublicTribute {
  id: string;
  /** Display name, group name, or "Sympathetic Friend". */
  name: string;
  /** Shown only when the family shows amounts. */
  amount: Money | null;
  message: string;
  at: string;
}

export interface PublicPageView {
  slug: string;
  deceasedName: string;
  dateOfDeath: string;
  funeralDate: string | null;
  funeralLocation: string;
  badge: Badge;
  share: ShareLinks;
  /** Relative API path, present only with consent + showPhoto. */
  photoPath: string | null;
  /** null ⇒ the family hides the total (and target/progress). */
  totals: { raised: Money; target: Money | null } | null;
  /** true ⇒ the wallet is closing/closed: no contributions, no share links. */
  closed: boolean;
  /** null ⇒ hidden. Anonymised: purposes and amounts only, never payees. */
  usage: { paidOut: Money; byPurpose: { purpose: string; amount: Money }[] } | null;
  /** null ⇒ the family hides tributes. Newest first, never ranked by amount. */
  tributes: PublicTribute[] | null;
  contribute: { currency: Money['ccy']; rails: string[]; min: Money; max: Money | null; groupsEnabled: boolean };
  /**
   * Present ONLY when the family turned on showPolicyNumber and a policy number is
   * on record. It is a reference, never a statement of cover or claim approval.
   */
  policy?: { insurer: string; number: string };
}

export interface ModerationQueueItem {
  tributeId: string;
  walletId: string;
  message: string;
  flagReasons: string[];
  appealed: boolean;
  status: TributeStatus;
  updatedAt: string;
}

/** Outbox topics (docs/06 Events). */
export const CONTRIBUTION_TOPICS = [
  'contribution.initiated',
  'contribution.succeeded',
  'contribution.failed',
  'tribute.flagged',
  'target.reached',
] as const;
