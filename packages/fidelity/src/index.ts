// @chema/fidelity — Fidelity policy & claims link (docs/07), behind
// `fidelity.claims_link`. Adapter interface + MockFidelity + a real stub that
// refuses to run (D14), and the ClaimsService channels call.
export * from './adapter';
export { MockFidelity, MOCK_SCENARIOS, type MockScenario, type SignedCallback } from './mock';
export { RealFidelity } from './real';
export { ClaimsService, type ClaimsServiceDeps } from './service';
export { coveredLifeMatches, lookupOutcome, type ClaimView, type LinkInput, type LookupView, type UnblockInput } from './commands';
export { CLAIM_TOPICS, FIDELITY_RETRY, SYNC_INTERVAL_MS, type ClaimTopic } from './requests';
export { FIDELITY_EVENT_TOPIC } from './sync';
export { FIDELITY_RAIL, type BenefitReconSummary } from './recon';
export { benefitStatus, fundsView, type BenefitStatus, type FundsLine, type FundsView } from './view';
export { deriveRecipientKey, LINKABLE_OUTCOMES, LOOKUP_OUTCOMES, type LookupOutcome } from './store';
