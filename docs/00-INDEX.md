# Index — what to load, when

Source of truth: Chema Wallet BRD (v4+ amendments control over original v3 text) + Fidelity Proposal. These docs are the distilled, build-ready version. Stale v3 items (InnBucks, $1 card fee, $1 mismatch freeze, Bank/Mukuru/USSD in MVP, "100% payout success", "Fidelity verifies every death") are intentionally removed.

| File | Contents | Load for phases |
|---|---|---|
| 01-product-scope | main idea, 3 sources, MVP matrix, flags | all (skim) |
| 02-roles-authority | roles, permission matrix, dual approval | P01 P04 P07 P08 P09 |
| 03-domain-model | entities, state machines | P01-P07 |
| 04-ledger-payments | ledger, sub-ledgers, payment states, recon | P02 P03 P07 P09 |
| 05-wallet-verification | lifecycle, verification, fraud, badge | P04 |
| 06-contribution-public | public page, contribute, tribute, receipts | P05 |
| 07-fidelity-integration | claim path, beneficiary rule, adapters | P06 |
| 08-payout-governance-closure | payouts, holds, disputes, refunds, close | P07 |
| 09-whatsapp-channel | orchestrator, security, catalogue | P08 |
| 10-privacy-security-audit | consent, retention, NFRs, audit | P01 P10 |
| 11-ai-automation | AI limits | P04 P08 |
| 12-admin-ops-reporting | queues, runbooks, KPIs | P09 |
| 13-decisions-flags | D01-D20 → flags, go-live gates | P00 P10 |
| 14-test-plan | scenarios + acceptance | each phase (its section) + P10 |

## Build order
P00 → P01 → P02 → P03 → P04 → P05 → P06 → P07 → P08 → P09 → P10. Each phase leaves a green test suite and a runnable app.

## Rules of thumb
- Phase file lists exact docs under **Load**. Load nothing else.
- Test-plan: read only the section named in the phase file.
- Open question? → 13-decisions-flags.md, don't guess.
