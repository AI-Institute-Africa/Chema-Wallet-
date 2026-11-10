# P10 Hardening, acceptance, go-live evidence
**Load:** docs/14-test-plan.md (all), docs/13-decisions-flags.md (gates), docs/10-privacy-security-audit.md (NFR table)
**Goal:** prove MVP acceptance on mocks; produce the evidence pack. Do NOT enable live funds.

## Do
1. Run & complete every scenario in docs/14 §V §P §L §C §G §S §O §A; add missing tests. Keep a traceability table `docs/evidence/traceability.md` (requirement → test file → status).
2. Load/burst test to plan baseline (10k funerals / 300k contributors Y1) on mocks; record results.
3. Chaos/recovery: kill workers mid-payment, duplicate/out-of-order webhooks, DB failover restore test, queue replay.
4. Security: dependency + secret scan, authz fuzz on all endpoints, IDOR sweep, rate-limit tests, headers/CSP, log PII scan.
5. Scope audit: grep UI/copy/tests/API for Bank, Mukuru, WorldRemit, USSD, InnBucks, hard-coded fees ⇒ must be zero hits.
6. Flag audit: all docs/13 keys default safe; kill switches work; `live_funds.enabled=false` blocks real adapters.
7. Generate `docs/evidence/go-live-gates.md` from docs/13 list: each gate = status NOT-MET unless artefact exists (legal opinion, certification, PIA etc. are human-owned — list owner, never mark met).
8. Final PROGRESS.md: open decisions D01–D20, known gaps, pilot recommendation (caps, kill switch, rollback).

## Done when
All §A items pass; traceability complete; gates file honest. Report remaining human-owned blockers to the user.
