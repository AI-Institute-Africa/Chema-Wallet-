# P04 Wallet lifecycle + community verification
**Load:** docs/05-wallet-verification.md, docs/03-domain-model.md (wallet, mandate, verification_case, wallet state machine), docs/11-ai-automation.md (FraudRules row), docs/14-test-plan.md §V
**Goal:** draft → verify → ACTIVE (slug/QR/badge) with fraud rules and appeals.

## Do
1. Migrations: wallet, mandate, verification_case, report.
2. Commands: createDraft (family/agent), uploadEvidence, submitForVerification, decideVerification (verifier role only; ≠ creator/agent), appeal, suspend/unsuspend (human + reason).
3. Evidence standard via config `verification.evidence_types`; checklist model; reason-code enum.
4. Activation: unguessable slug, QR (SVG), share-text generator (localised template, WhatsApp/SMS/Facebook/copy).
5. FraudRules: duplicate wallet detection (name+DoD+location normalisation, certificate hash, admin phone multi-death, velocity) ⇒ review task only.
6. Report-suspicious-wallet → fraud case.
7. Public route guard: non-ACTIVE wallets return 404 on every public endpoint.
8. Fidelity link stub captured at create (no gating).
9. Events to outbox (list in doc 05).
10. Minimal API + web screens: create draft form, evidence upload, status page.

## Done when
docs/14 §V all pass; draft has no slug/QR/badge; badge tooltip text per doc 05.
