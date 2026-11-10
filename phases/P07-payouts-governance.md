# P07 Payouts, governance, disputes, refunds, closure
**Load:** docs/08-payout-governance-closure.md, docs/02-roles-authority.md (dual approval + agent rules), docs/04-ledger-payments.md §7 §8, docs/14-test-plan.md §G §O
**Goal:** safe money-out and wallet end-of-life.

## Do
1. Migrations: payout_request, payout_plan, approval (if not P01), case workflows, hold workflows.
2. Payout command: ordered checks per doc 08; reserve funds; step-up; dual approval per thresholds (unset ⇒ always); payee (manual entry + verification + dual approval on destination/changes).
3. Submission via provider adapter (mock); complete only on provider confirm; failure → compensating entries + retry queue; dual-approved manual override for rail down.
4. Split payouts via payout_plan.
5. Admin replacement + mandate change flows (dual + verifier re-check).
6. Case management: create/assign/SLA/escalate/resolve with reason codes; authority dispute ⇒ proportionate hold; source-aware hold rules (community dispute ≠ Fidelity freeze).
7. Refund/cancellation per `refund.policy` (unset ⇒ manual case, not auto).
8. Closure: preconditions (final recon, no pending, no material disputes/holds, residual policy), statement generation, thank-you one-tap (respect notify consent), public page closed state, block further contributions.
9. Contributor-facing anonymised usage summary (privacy-aware).

## Done when
docs/14 §G and §O pass; payout > available impossible under concurrency test; closure blocked when residual>0 and policy unset.
