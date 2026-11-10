# 01 Product & scope

## Idea
Chema (Zimbabwean practice): community mobilises money for a funeral. Platform digitises it. Principles: open (no policy/account needed to contribute), human (tribute/prayer, anonymity option), low-burden for family (assisted journeys), transparent-but-private, financially controlled, channel-consistent, human-accountable automation. Dignity: no dark patterns, no pressure, no shaming of small amounts — every amount honoured.

## Three funding sources → one family-facing view, separate records
| Source | Who | Treatment |
|---|---|---|
| Fidelity benefit | Fidelity, after claim approval + authorised recipient/route confirmed | benefit sub-ledger, claim ref |
| Community Chema | anyone | community sub-ledger; requires verified wallet |
| Group top-up | linked church/burial society (optional, not mandatory MVP) | group tag/sub-ledger, authorised representative |
Display: pending / held / available / paid shown separately. Consolidated total is a view, not proof of legal pooling.

## Systems of record
- Chema: wallet admin, community contribution ledger.
- Fidelity Claims: policy eligibility, claim assessment/decision.
- Provider/finance records: settlement evidence.
- Wallet record, verified funeral, Fidelity-linked policy, approved claim = four DISTINCT statuses.

## MVP matrix
| Capability | Status | Condition |
|---|---|---|
| Draft wallet (family/agent) | MUST | draft never publicly shareable |
| Community verification | MUST | evidence + admin identity + authority; reviewer; audit |
| Verified page/link/QR | MUST | only after verification approved |
| EcoCash, OneMoney | MUST-conditional | flag `rail.ecocash`, `rail.onemoney`; mock until certified |
| Card | MUST-conditional | flag `rail.card`; acquirer approval |
| Fidelity link/claim | MUST-conditional | flag `fidelity.claims_link` |
| Receipts, tribute wall, privacy | MUST | |
| Payout controls, refund, dispute, recon | MUST | before live funds |
| Bank, Mukuru/WorldRemit, USSD, parlour settlement, registrar API | PHASE 2 | not in UI/tests/copy |
| Advanced AI/fraud models | POST-MVP | rules + human review first |
| Pre-need wallet, recurring groups, multi-funeral dashboards, partner API | PHASE 3 | |

Scope rule: any scope change needs Product, IT, Finance, Compliance, Ops sign-off (note in PROGRESS.md, don't just build).

## Timing targets (measure separately)
- Draft creation < 5 min (straightforward).
- Verification: Ops-approved SLA (unknown; config `verification.sla_hours`).
- First contribution < 10 min from VERIFIED ACTIVATION (not from draft).
- Contribution initiation response < 5 s excluding provider time; slow provider ⇒ show "pending".
- Fidelity claim SLA is separate; never blocks community path.

## Languages
English MVP-required; Shona/Ndebele i18n-ready (all strings via message catalogue); coverage confirmed pre-pilot (D15).

## Currency
Contributor may pay in provider-supported currency. Record gross, fee, FX rate, net, settlement currency. Show approved fee, FX, net BEFORE payment. No hard-coded fee.
