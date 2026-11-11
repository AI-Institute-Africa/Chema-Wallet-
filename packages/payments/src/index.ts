// @chema/payments — collection pipeline (docs/04 §3–§8). Depends on core,
// ledger, providers and shared; channels call PaymentService and nothing else.
export * from './types';
export { RailRegistry, LiveFundsDisabledError, railFlagKey } from './rails';
export { DENY_ALL_GATE, type ContributionGate } from './gate';
export { quoteFees, disclosureOf, FeeExceedsAmountError, type Quote } from './fees';
export { IllegalTransitionError } from './store';
export {
  SLA_HOURS,
  caseSlaHours,
  exceptionSlaHours,
  EXCEPTION_OWNER_ROLE,
  closeCase,
  openCase,
  raiseException,
  slaDue,
  type CaseType,
  type ExceptionKind,
  type RaiseInput,
  type Severity,
} from './exceptions';
export {
  paymentPendingSource,
  createPayment,
  nextPollDelay,
  POLL,
  viewReceipt,
  type InitiateInput,
  type InitiateResult,
  type PaymentDeps,
  type ReceiptView,
} from './collect';
export { SETTLEMENT_LAG_DAYS, type ReconSummary } from './recon';
export type { RefundInput, RefundResultView } from './refunds';
export { PaymentService, listExceptions, type PaymentServiceDeps, type ReconExceptionView } from './service';
export { PAYOUT_EVENT_TOPIC } from './events';
