// The real Fidelity Claims integration. Owners, APIs, auth, event bus and SLAs
// are unconfirmed (D14): every method refuses to run until it is built against
// a confirmed contract. Never fall back to the mock in production.
import { FidelityNotConfiguredError, type BenefitPayment, type BenefitSettlementRow, type ClaimStatusReport, type FidelityAdapter, type FidelityEvent, type PolicyRecord, type RecipientRoute } from './adapter';

export class RealFidelity implements FidelityAdapter {
  readonly name = 'FIDELITY';

  lookupPolicy(): Promise<PolicyRecord | null> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
  createOrLinkClaim(): Promise<{ claimRef: string }> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
  getClaimStatus(): Promise<ClaimStatusReport> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
  submitEvidence(): Promise<void> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
  verifyWebhook(): FidelityEvent {
    throw new FidelityNotConfiguredError();
  }
  getApprovedRecipientRoute(): Promise<RecipientRoute | null> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
  getBenefitPayment(): Promise<BenefitPayment | null> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
  benefitSettlements(): Promise<readonly BenefitSettlementRow[]> {
    return Promise.reject(new FidelityNotConfiguredError());
  }
}
