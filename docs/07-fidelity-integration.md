# 07 Fidelity policy & claims integration

Flag: `fidelity.claims_link` (default OFF). Everything here is behind an adapter; the real Fidelity module APIs/SSO/event bus are UNCONFIRMED (D14). Build against interfaces + a mock.

## Boundaries
- Fidelity Claims = system of record for policy eligibility, claim assessment/decision, benefit payment.
- Chema = funeral case + community ledger. Chema never decides claims.
- Community verification and claim verification are separate; neither substitutes the other.
- Community path continues if claim is absent/pending/declined.

## Adapter interface (packages/fidelity)
```
lookupPolicy(identifier, requester) → {policyNo, status, coveredLives[], premiumStatus}   // consent + role gated
createOrLinkClaim(walletRef, policyNo, evidenceRefs) → {claimRef}
getClaimStatus(claimRef) → NONE|SUBMITTED|IN_REVIEW|MORE_INFO|APPROVED|DECLINED (+reason, mapped)
submitEvidence(claimRef, docRefs)
onClaimEvent(webhook) → verified, idempotent
getApprovedRecipientRoute(claimRef) → {recipientId, route, approvedBy}
```
Ship `MockFidelity` with scenarios: no policy, inactive, covered-life mismatch, arrears, duplicate claim, pending, declined, approved, beneficiary mismatch, benefit payment not settled.

## Flow
1. Policy identified via approved lookup (needs consent; match rules).
2. Claim initiated/linked, Chema wallet ref stored on claim; evidence shared with access controls.
3. Fidelity officer (or Fidelity-approved deterministic straight-through rule) decides. Auto-approval limit = D10, config `claims.auto_approve_limit_minor` unset ⇒ none.
4. APPROVED alone is NOT enough to credit. Credit `W:FIDELITY_BENEFIT` only when: claim APPROVED + recipient/payment route APPROVED by Claims/Finance/Legal + payment settled per Fidelity record.
5. If proposed wallet recipient ≠ policy beneficiary ⇒ `route_status=BLOCKED_MISMATCH`, create BENEFICIARY_MISMATCH case, hold benefit routing until written Legal+Claims+Finance approval is recorded (attach approval ref). Never route proceeds to admin/other wallet by inference.
6. Benefit is an insurance obligation: not platform revenue; no Chema fee on it (config forbids).
7. Family view: source-labelled line "Fidelity benefit" next to community, each with its own restrictions/status. Benefit payouts spend only from benefit sub-ledger where permitted.

## Resilience
Outbox + retry queue; if Fidelity unreachable, queue events, show "status updating"; reconcile benefit credits against Fidelity ledger daily (doc 04 §7). No duplicate claim submission (idempotency key = wallet+policy+deceased). Duplicate claim block surfaced from Fidelity response.

## Events out
claim.linked · claim.evidence_submitted · benefit.credited · benefit.route_blocked
Events in: claim.status_changed · claim.approved · claim.declined · benefit.paid

## Never
- AI/OCR output as claim decision. - Showing claim detail to contributors. - Assuming wallet admin = beneficiary. - Hard-coding sum assured/limits.
