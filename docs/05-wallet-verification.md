# 05 Wallet lifecycle & community verification

## Create draft (family or authorised agent; web or WhatsApp)
Fields: deceased_name, date_of_death, funeral_date, funeral_location, family contact, target (optional), photo (optional; needs consent record). Draft: private, no slug/link/QR/badge, no contributions.

## Community verification (NOT insurance claim verification)
Purpose: funeral sufficiently evidenced + administrator identity + authority. Fidelity does not auto-verify every death. Evidence standard/reviewer org/SLA = decision D05 → config `verification.evidence_types` (default: DEATH_CERTIFICATE | PARLOUR_CONFIRMATION | BURIAL_ORDER, any ONE + admin ID + mandate evidence; reviewer decides). Build reviewer workflow + checklist, don't hard-code the standard.

Reviewer records: evidence reviewed, outcome, timestamp, reason code, escalation/appeal route. Reviewer ≠ creator ≠ agent on the case.
Outcomes: APPROVED → wallet ACTIVE, slug+QR generated, badge shown. REJECTED → reason, appeal path. MORE_INFO → request via channel.
Pending/rejected wallets never show the badge. Badge meaning (show in UI tooltip): "funeral checks passed" — not coverage, not claim approval.

## Fraud / duplicate controls (rules first, human decides)
- Duplicate wallet detection: same deceased (normalised name + DoD + location), same certificate number/hash, same admin phone across multiple deaths, velocity. Flags create a review task; only a human blocks/suspends with written reason.
- Report-suspicious-wallet: public button → fraud case.
- Unverified wallets cannot be shared publicly (no public route returns 200).
- Document upload: malware scan, encrypted storage, access-controlled, linked to case.

## Public activation
On APPROVED: generate unguessable slug, QR (SVG/PNG), pre-written share text (WhatsApp/SMS/Facebook/copy link), e.g. "Family of {name}, please help us give {pronoun} a dignified send-off. Contribute here: {link}" (localised).

## Agent-assisted
Agent creates draft + uploads evidence on behalf; family admin identity still verified; agent cannot approve own verification.

## Edge: Fidelity link at create time
If user supplies a policy number/ID: store `fidelity_link` stub, start claim path separately (doc 07). Never gate verification on it.

## Events emitted (outbox)
wallet.draft_created · wallet.verification_submitted · wallet.verified · wallet.verification_rejected · wallet.suspended · wallet.report_received
