// @chema/payouts — money out and wallet end of life (P07, docs/08): payees,
// split payouts on provider confirmation, rail-down override, cases, holds,
// mandate changes (admin replacement / approvers), cancellation + closure.
// Channels call PaymentService-style through PayoutService only.
export * from './types';
export { payoutKeys, maskDestination, type PayoutDeps, type PayoutKeys } from './store';
export { namesMatch, type AddPayeeInput } from './payees';
export { PayoutCheckError, type PlanPart, type RequestPlanInput, type PlanResult } from './payouts';
export { MAX_HOLD_REVIEW_DAYS, DEFAULT_HOLD_REVIEW_DAYS, type OpenCaseInput, type PlaceHoldArgs } from './governance';
export type { MandateChangeInput, MandateChangeView } from './mandate';
export { ClosureBlockedError, closureCheck } from './closure';
export { PayoutService, type PayoutServiceDeps } from './service';
