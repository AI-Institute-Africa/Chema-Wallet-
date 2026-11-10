# P06 Fidelity policy & claims link
**Load:** docs/07-fidelity-integration.md, docs/03-domain-model.md (fidelity_link, claim mirror, case), docs/14-test-plan.md §C
**Goal:** claim path linked to the wallet; benefit credited only when route approved. All behind `fidelity.claims_link`.

## Do
1. Migration: fidelity_link; reuse case table (BENEFICIARY_MISMATCH).
2. `packages/fidelity` adapter interface + `MockFidelity` (all scenarios in doc 07). Real adapter = empty stub throwing NotConfigured.
3. Commands: lookupPolicy (consent + role gated), createOrLinkClaim (idempotent key wallet+policy+deceased), submitEvidence, ingest claim webhook (signed, idempotent).
4. Route logic: states UNSET/PENDING_APPROVAL/APPROVED/BLOCKED_MISMATCH; mismatch ⇒ case + hold on benefit source only; approval ref required to unblock.
5. Benefit credit: only when claim APPROVED + route APPROVED + settled per Fidelity record ⇒ ledger post to W:FIDELITY_BENEFIT. No fee on benefit (enforce).
6. Family view: source-labelled benefit vs community, separate pending/held/available.
7. Queue + retry for outages; daily benefit recon vs Fidelity record (extend P03 recon).
8. Community path regression tests: claim decline/delay/absent never alters community balances.

## Done when
docs/14 §C all pass on mocks; no code path lets AI/OCR output change claim status.
