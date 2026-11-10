import type { Currency, Money } from '@chema/shared';

export const WALLET_ACCOUNT_KINDS = ['COMMUNITY', 'FIDELITY_BENEFIT', 'GROUP'] as const;
export type WalletAccountKind = (typeof WALLET_ACCOUNT_KINDS)[number];

export const SYSTEM_ACCOUNT_KINDS = [
  'PROVIDER_CLEARING',
  'PAYOUT_CLEARING',
  'FEES',
  'REFUND_CLEARING',
  'SUSPENSE_UNMATCHED',
  /** Recon differences within tolerance (P03, docs/04 §7): recorded, never written off silently. */
  'RECON_DIFF',
] as const;
export type SystemAccountKind = (typeof SYSTEM_ACCOUNT_KINDS)[number];

export type AccountKind = WalletAccountKind | SystemAccountKind;

/** System accounts that may receive value leaving a wallet sub-ledger (docs/04 §2). */
export const WALLET_EXIT_KINDS: ReadonlySet<AccountKind> = new Set<AccountKind>([
  'FEES',
  'REFUND_CLEARING',
  'PAYOUT_CLEARING',
]);

/** One sub-ledger in one currency. walletId is null for system accounts. */
export interface LedgerAccount {
  id: string;
  walletId: string | null;
  kind: AccountKind;
  /** Group id for GROUP, rail for *_CLEARING, otherwise null. */
  qualifier: string | null;
  currency: Currency;
}

export const JOURNAL_KINDS = [
  'CONTRIBUTION',
  'BENEFIT',
  'PAYOUT',
  'REFUND',
  'CHARGEBACK',
  'FEE',
  'SETTLEMENT',
  'SUSPENSE',
  'ADJUSTMENT',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export type Side = 'D' | 'C';

export interface EntryInput {
  accountId: string;
  side: Side;
  /** Positive; in the account's currency. */
  amount: Money;
  txnRef?: string;
  providerRef?: string;
}

export interface JournalInput {
  /** Same key + same content ⇒ the original journal is returned, nothing is written. */
  idempotencyKey: string;
  kind: JournalKind;
  entries: readonly EntryInput[];
  /** Required for ADJUSTMENT. */
  reason?: string;
  approvalRef?: string;
  /** Required for PAYOUT (and only then): the reservation this payout pays. */
  reservationId?: string;
}

export interface PostResult {
  journalId: string;
  /** True when the key had already been posted: nothing was written this time. */
  replayed: boolean;
}
