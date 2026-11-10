// Provider adapter contract (docs/04 §5). Adapters translate one rail's API
// into these shapes and hold NO business or money logic: the payments service
// decides what a confirmation means for the ledger.
import type { Money } from '@chema/shared';

/** Rail code: upper-case, matches the ledger clearing-account qualifier. */
export type RailCode = string;

/**
 * MOCK    – in-process simulator (tests, local dev).
 * SANDBOX – the provider's test environment; no real money.
 * LIVE    – real money; refused unless `live_funds.enabled` (D01).
 */
export type AdapterMode = 'MOCK' | 'SANDBOX' | 'LIVE';

export interface CollectRequest {
  /** Our payment id: sent to the provider as its merchant reference. */
  reference: string;
  amount: Money;
  /** Payer wallet/phone for mobile money (E.164). Never a PIN. */
  payerMsisdn?: string;
  description: string;
}

/** What the payer does next. Payment always happens in provider checkout / on the handset. */
export type NextAction =
  | { type: 'REDIRECT'; url: string }
  | { type: 'PROMPT'; message: string };

export interface CollectResult {
  providerRef: string;
  next: NextAction;
}

export type ProviderStatus =
  | { state: 'PENDING' }
  | { state: 'SUCCEEDED'; providerRef: string; amount: Money; fee: Money; merchantRef: string }
  | { state: 'FAILED'; providerRef?: string; reason: string }
  | { state: 'EXPIRED'; providerRef?: string }
  /** The provider has no record of this reference (request may never have arrived). */
  | { state: 'NOT_FOUND' };

export const PROVIDER_EVENT_TYPES = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_EXPIRED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'DISPUTE_OPENED',
  'DISPUTE_WON',
  'CHARGEBACK',
] as const;
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

/** A verified, normalised provider callback. */
export interface ProviderEvent {
  /** Provider's unique event id (replay key). */
  eventId: string;
  type: ProviderEventType;
  /** Collection reference at the provider. */
  providerRef: string;
  /** Our reference echoed back, when the provider supports it. */
  reference?: string;
  /** Merchant account the money went to — must be ours. */
  merchantRef: string;
  amount?: Money;
  fee?: Money;
  /** Refund reference (REFUND_*), dispute reference (DISPUTE_*, CHARGEBACK). */
  refundRef?: string;
  disputeRef?: string;
  reason?: string;
  occurredAt: string;
}

export interface RefundResult {
  providerRef: string;
}

export interface PayoutRequest {
  reference: string;
  amount: Money;
  destination: string;
}

export interface SettlementRow {
  providerRef: string;
  /** What the payer was charged. */
  gross: Money;
  /** What the provider kept. */
  fee: Money;
  merchantRef: string;
}

export interface ProviderAdapter {
  readonly rail: RailCode;
  readonly mode: AdapterMode;
  /** Our merchant account at the provider; callbacks for any other are refused. */
  readonly merchantRef: string;
  collect(req: CollectRequest): Promise<CollectResult>;
  /** Look up by provider ref, or by our reference when the ref was never returned. */
  queryStatus(q: { providerRef?: string; reference: string }): Promise<ProviderStatus>;
  /** Verify signature + timestamp window; return the normalised event or throw WebhookRejectedError. */
  verifyWebhook(headers: Readonly<Record<string, string | undefined>>, rawBody: string, now: Date): ProviderEvent;
  payout(req: PayoutRequest): Promise<{ providerRef: string }>;
  refund(q: { providerRef: string; amount: Money; reference: string }): Promise<RefundResult>;
  /** Settlement rows for one calendar day (YYYY-MM-DD, provider time zone). */
  settlementReport(date: string): Promise<SettlementRow[]>;
}
