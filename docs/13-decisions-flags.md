# 13 Open decisions → flags/config, and go-live gates

Rule: unresolved decision ⇒ config key with SAFEST default; feature disabled/blocked. Record any you build around in PROGRESS.md Assumptions.

| ID | Decision (owner) | Config key / behaviour until decided |
|---|---|---|
| D01 | Legal classification/perimeter (Legal, Compliance) | `live_funds.enabled=false` hard gate; sandbox only |
| D02 | Custody/float owner, settlement, insolvency (Finance, Legal) | same gate; no live settlement accounts |
| D03 | Benefit recipient when ≠ wallet admin (Claims, Legal, Finance) | benefit route BLOCKED on mismatch; approval ref required |
| D04 | Authority evidence + multi-approver thresholds | `approvals.*`; unset ⇒ ALL payouts dual-approved |
| D05 | Death-verification standard/reviewer/SLA | `verification.evidence_types`, `verification.sla_hours` |
| D06 | Exact MVP rails + capabilities | `rail.ecocash/onemoney/card` default false; mocks only |
| D07 | Card countries/ccy/FX/chargebacks | `rail.card` false |
| D08 | Fee model/payer/tax/disclosure | fee schedule empty ⇒ no fee, no fee copy |
| D09 | Recon tolerance/materiality/SLA/emergency release | `recon.*`; unset ⇒ zero tolerance, exception (not blanket freeze) |
| D10 | Claim auto-approval limits, arrears rules, review SLA | `claims.auto_approve_limit_minor` unset ⇒ all manual |
| D11 | Excess funds/unspent benefit/refund/charity/residual | `closure.excess_funds_policy` unset ⇒ closure blocked if residual>0; `refund.policy` unset ⇒ manual case |
| D12 | Retention by data category | `retention.*`; 7y planning only |
| D13 | Privacy roles, lawful basis, deceased data, cross-border | flag `data.cross_border=false` |
| D14 | Fidelity module/API owners, SoR, auth, SLAs | adapters + mocks; `fidelity.claims_link=false` |
| D15 | MVP languages/support | English live; others i18n-ready |
| D16 | WhatsApp/SMS provider, consent, templates, retention, cost | `channel.whatsapp` simulator until set; `channel.sms` |
| D17 | Approved parlours; direct settlement MVP vs P2 | direct settlement OFF; manual payee only |
| D18 | IPEC/RBZ reporting formats | generic export only |
| D19 | Pilot caps, monitoring, go/no-go, rollback | `pilot.max_wallets`, `pilot.max_amount_minor`, kill-switch flag |
| D20 | Weekend/after-hours support | runbook placeholder |

## Global kill switches (build in P00)
`live_funds.enabled`, `contributions.enabled`, `payouts.enabled`, per-rail flags, `channel.*`, `marketing.enabled`, `fees.enabled`, `commissions.enabled` (never used in MVP). Flag changes audited; financial flags require dual approval.

## Commercial (never implement as live)
No transaction fee, wallet fee, commission, referral income, revenue share, partner payment, cross-sell, or customer-data monetisation. Community contributions ≠ Fidelity revenue; Fidelity benefit ≠ platform revenue; family funds ≠ Fidelity operating cash. Value-model metrics = reporting only, with baseline + attribution; illustrative funnel (1,000 wallets × 30 contributors, 40% opt-in, 5% conversion → 600) is NOT a forecast and must not appear as a target in product.

## Production go-live gates (all must be evidenced; P10 produces checklist)
1. Legal/regulatory assessment signed (perimeter, IPEC/RBZ/AML/data protection).
2. Funds-flow/custody/float/settlement approved (Finance/Treasury/Legal).
3. MVP rails contracted + certified end-to-end (collect, payout, refund, chargeback, settlement, recon).
4. Verification, claims, beneficiary, mandate, payout-approval procedures approved.
5. Fees/FX/refunds/complaints/disputes/excess-funds policy approved + disclosed.
6. PIA, controller/processor roles, retention schedule, processor agreements, cross-border review.
7. Security testing done; critical/high remediated or risk-accepted; backup restore + incident response tested.
8. Support rota, recon owner, exception SLAs, partner escalation, runbooks, continuity tested.
9. Requirements→test evidence traced; sign-off by Product, Claims, Finance, Ops, IT Security, Legal, Compliance, Risk.
