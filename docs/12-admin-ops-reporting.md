# 12 Admin portal, operations, reporting

Secure admin portal = controlled workspace for Fidelity officers, verifiers, finance/ops, auditors. Role-based; MFA for privileged/financial; high-risk actions (claim decisions, financial release, ledger adjustments, privileged access, overrides) live HERE (maker-checker).

## Work queues
1. Verification queue (evidence viewer, checklist, approve/reject/more-info, reason codes, SLA clock, appeals)
2. Claims queue (mirrors Fidelity; link-out/embedded per adapter; manual review, SLA)
3. Payout approvals (checker view: destination, amount, source, balance, holds)
4. Cases (disputes, fraud, beneficiary mismatch, chargebacks) with owner/SLA/escalation
5. Reconciliation exceptions (owner, age, severity, target, escalation; manual release w/ dual approval)
6. Moderation (flagged tributes)
7. Fraud flags / suspicious-wallet reports
8. Holds register (owner, reason, review_at, overdue highlight)
9. Config & flags (changes audited, dual-approved for financial flags)
10. User/role admin (MFA, access review export)

## Reports
- Family: total raised, contributors (per privacy), Fidelity benefit, payouts, balance, statement.
- Contributor: my contribution, receipt, public total, thanks.
- Fidelity mgmt: funerals supported, benefits (from Fidelity records), community raised, draft→verified time, first-contribution time, straight-through rate (if enabled), satisfaction, regulator reports (format TBD D18).
- Agent: wallets created, claims assisted. Finance: recon status, exceptions ageing, fees/FX, settlements.
KPI definitions (separate activity from financial outcomes; no unsupported causal claims): activation (drafts, verify pass rate, median draft→verified), engagement (first contribution after activation, contributors/funeral, link conversion), payments (per rail state counts, settlement time), financial integrity (match rate, exception count/age, duplicate postings, payout accuracy), claims (initiation→decision→payout times, kept separate), reliability (availability, latency), trust (complaints, disputed payouts, suspicious wallets, support response), Fidelity value (attributable leads/policies/retention — needs baseline + attribution design; no revenue claims).

## Runbooks (write as markdown in /runbooks, short)
verification reject/appeal · authority change/approver unavailable/dispute/emergency hold-release · provider outage/pending-unknown/duplicate callback/failed payout/refund/chargeback · daily recon/unmatched/tolerance breach · fraud/impersonation/data incident · WhatsApp outage/human hand-off/after-hours · wallet closure/residual/final statement.

## Support
Weekend/after-hours escalation (D20); human hand-off from any channel preserves context.
