// Payment states and rows (docs/04 §3). The transition table is duplicated in
// SQL (payment_transition_ok, migration 0009): the database refuses anything
// this file would refuse.
import type { NextAction } from '@chema/providers';
import type { Currency, Money } from '@chema/shared';

export const PAYMENT_STATES = [
  'INITIATED',
  'PENDING_UNKNOWN',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED',
  'REFUNDED',
  'CHARGED_BACK',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** Not final: never spendable, polled and reconciled. */
export const OPEN_STATES: ReadonlySet<PaymentState> = new Set<PaymentState>(['INITIATED', 'PENDING_UNKNOWN']);

const TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  INITIATED: ['PENDING_UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED'],
  PENDING_UNKNOWN: ['SUCCEEDED', 'FAILED', 'EXPIRED'],
  SUCCEEDED: ['REFUNDED', 'CHARGED_BACK'],
  FAILED: [],
  EXPIRED: [],
  REFUNDED: [],
  CHARGED_BACK: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export type StateSource = 'INITIATE' | 'PROVIDER_SYNC' | 'WEBHOOK' | 'POLL' | 'REFUND' | 'CHARGEBACK';

export interface PaymentRow {
  id: string;
  wallet_id: string;
  credit_account_id: string;
  rail: string;
  idempotency_key: string;
  request_hash: string;
  payer_person_id: string | null;
  currency: Currency;
  gross_minor: string;
  fee_minor: string;
  fee_payer: 'CONTRIBUTOR' | 'WALLET' | null;
  net_minor: string;
  fx_rate: string | null;
  settlement_currency: Currency;
  state: PaymentState;
  provider_ref: string | null;
  next_action: NextAction | null;
  failure_reason: string | null;
  confirmed_minor: string | null;
  provider_fee_minor: string | null;
  credited_gross_minor: string | null;
  credit_journal_id: string | null;
  receipt_id: string | null;
  poll_attempts: number;
  next_poll_at: Date | null;
  created_at: Date;
}

export const PAYMENT_COLUMNS = `id, wallet_id, credit_account_id, rail, idempotency_key, request_hash, payer_person_id, currency,
  gross_minor::text AS gross_minor, fee_minor::text AS fee_minor, fee_payer, net_minor::text AS net_minor, fx_rate,
  settlement_currency, state, provider_ref, next_action, failure_reason,
  confirmed_minor::text AS confirmed_minor, provider_fee_minor::text AS provider_fee_minor,
  credited_gross_minor::text AS credited_gross_minor, credit_journal_id, receipt_id, poll_attempts, next_poll_at, created_at`;

/** Pre-payment disclosure (docs/04 §6): shown before the payer is sent to checkout. */
export interface FeeDisclosure {
  totalCharged: Money;
  /** null ⇒ no fee (nothing to disclose, no "free" claim either). */
  feePayer: 'CONTRIBUTOR' | 'WALLET' | null;
  providerFee: Money;
  /** null ⇒ no currency conversion. */
  fxRate: string | null;
  expectedCredit: Money;
}

/** What callers (API, WhatsApp later) may show about a payment. */
export interface PaymentView {
  id: string;
  walletId: string;
  rail: string;
  state: PaymentState;
  disclosure: FeeDisclosure;
  next: NextAction | null;
  receiptId: string | null;
  failureReason: string | null;
  createdAt: string;
}
