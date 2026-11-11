# Production go-live gates

Source: docs/13 "Production go-live gates" and docs/10 "Pre-production evidence".

A gate is **MET** only when the signed or approved artefact exists and is referenced here. Engineering cannot meet a human-owned gate, so every gate below is **NOT-MET**. The "Engineering evidence" column lists only what the repo contributes toward a gate. It is input for the owners, not a substitute for their sign-off.

`live_funds.enabled` stays `false`, and so do the pilot flags. With them off, no LIVE adapter can register or collect (docs/evidence/flag-audit.md).

Status as of 2026-11-11 (P10).

| # | Gate | Owner(s) | Status | Engineering evidence | Missing artefact |
|---|---|---|---|---|---|
| 1 | Legal/regulatory assessment signed (perimeter, IPEC/RBZ/AML/data protection) | Legal, Compliance | NOT-MET | Product is built behind the D01 hard gate; no legal classification is asserted anywhere in product | Signed legal opinion on perimeter and licensing (D01); AML/CFT assessment |
| 2 | Funds-flow, custody, float and settlement approved | Finance/Treasury, Legal | NOT-MET | Source-separated sub-ledgers; community funds never fund operations (ledger invariants and tests) | Approved custody/float model, settlement accounts and insolvency position (D02) |
| 3 | MVP rails contracted and certified end to end (collect, payout, refund, chargeback, settlement, recon) | Partnerships, Finance, IT | NOT-MET | Adapter interface plus mock rails covering every flow in §P; LIVE adapters refused while the gate is off | Signed EcoCash/OneMoney/card contracts; provider certification reports; live adapters (D06/D07) |
| 4 | Verification, claims, beneficiary, mandate and payout-approval procedures approved | Claims, Operations, Legal | NOT-MET | Safest defaults: all payouts dual-approved (D04); benefit route blocked on mismatch (D03); 3 evidence types configurable (D05) | Approved procedures, thresholds and verification standard/SLA (D03, D04, D05, D10) |
| 5 | Fees/FX/refunds/complaints/disputes/excess-funds policy approved and disclosed | Product, Finance, Legal | NOT-MET | Fee schedule empty and `fees.enabled=false`; residual funds block closure; every refund is a manual case | Approved fee/FX policy (D08); refund and excess-funds policy (D11); complaints procedure |
| 6 | PIA, controller/processor roles, retention schedule, processor agreements, cross-border review | DPO, Legal | NOT-MET | Consent records; field-level encryption; masked logs (security test log PII scan); retention holds; `data.cross_border=false` | PIA; controller/processor determination (D13); retention schedule (D12); processor DPAs (WhatsApp/SMS/hosting) |
| 7 | Security testing done; critical/high fixed or risk-accepted; backup restore and incident response tested | IT Security | NOT-MET | docs/evidence/security-and-resilience.md: authz fuzz, IDOR sweep, rate limits, headers/CSP, log scan, dependency audit (0 runtime vulns), secret scan; local backup/restore drill passed | Independent penetration test; vulnerability scan of the deployed environment; production backup restore and failover test; incident-response exercise; risk acceptance of open findings |
| 8 | Support rota, recon owner, exception SLAs, partner escalation, runbooks, continuity tested | Operations | NOT-MET | `runbooks/` drafts; recon exceptions owned with ageing escalation; D20 placeholder | Named recon owner; staffed support rota incl. after hours (D20); agreed exception SLAs (D09); partner escalation contacts; continuity test |
| 9 | Requirements traced to test evidence; sign-off by Product, Claims, Finance, Ops, IT Security, Legal, Compliance, Risk | All listed | NOT-MET | docs/evidence/traceability.md: all docs/14 scenarios PASS on mocks | Sign-offs from each function; UAT on certified rails |

## Pre-production evidence (docs/10)

| Evidence | Owner | Status | Note |
|---|---|---|---|
| PIA | DPO | NOT-MET | Not started in repo; human-owned |
| Processor due diligence | Procurement, DPO | NOT-MET | Providers not chosen (D16 WhatsApp/SMS; hosting) |
| Pen test | IT Security (independent tester) | NOT-MET | In-repo security tests are not a pen test |
| Vuln scan | IT Security | NOT-MET for the environment | Dependency audit clean for runtime deps. One moderate dev-only advisory (eslint → minimatch, ReDoS) is open for risk acceptance |
| Backup restore test | IT/Infra | NOT-MET for production | Local drill passed 2026-11-11 (8 s restore of a 1,282-row audit chain, identical facts). Production RTO/RPO not defined |
| Incident-response test | IT Security, Ops | NOT-MET | No exercise run |

## Open decisions blocking go-live

D01–D20 are all open. See PROGRESS.md "Open decisions" for each decision's safe default.
