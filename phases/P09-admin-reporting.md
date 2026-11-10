# P09 Admin portal, reconciliation UI, reports, runbooks
**Load:** docs/12-admin-ops-reporting.md, docs/02-roles-authority.md (permission matrix), docs/04-ledger-payments.md §7
**Goal:** operational control surface for staff.

## Do
1. apps/admin (Next.js): staff login + MFA; role-gated nav; assigned-case scoping.
2. Queues 1–10 from doc 12 (verification, claims mirror, payout approvals, cases, recon exceptions, moderation, fraud flags, holds register, config/flags, user/role admin).
3. Maker-checker UI for payout approvals, ledger adjustments, hold release, flag changes (financial flags dual-approved).
4. Ledger adjustment command (compensating journal, reason, dual approval, audit).
5. Reports: family statement, contributor view, Fidelity management dashboard (KPI defs from doc 12; no revenue/forecast claims), agent, finance recon, generic regulator export (format TBD).
6. Audit explorer: reconstruct a wallet timeline from audit + ledger; chain verifier button.
7. Runbooks: write `/runbooks/*.md` (7 groups in doc 12), each ≤ 1 page.
8. Support hand-off view (conversation ref, case link).

## Done when
Every high-risk action is reachable only via portal with maker≠checker; wallet reconstruction from audit works on seeded data.
