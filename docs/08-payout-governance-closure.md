# 08 Payouts, governance, disputes, holds, refunds, closure

## Payout request
Purposes (enum, config): PARLOUR, TRANSPORT, FOOD, CHURCH, FAMILY_BENEFICIARY, OTHER_APPROVED. Recipient must be a verified/approved payee. MVP: manual payee entry by admin (mobile money number) with verification + dual approval on destination; parlour directory/auto-settlement = Phase 2.
Checks (all server-side, in order): wallet ACTIVE/CLOSING · mandate valid · admin step-up OK · amount ≤ eligible available of the chosen sub-ledger · source restrictions (benefit vs community) · no applicable hold · destination allowed · approval thresholds → approvals complete (maker≠checker) · rail enabled.
Reserve funds on request (reduces available) → release if rejected/failed.
Split payout: admin sets splits (e.g., 70/30) = multiple payout_requests under one `payout_plan`; each independently checked.
Complete ONLY on provider confirmation. Failed → compensating entries, notify, retry via queue per rail rules; dual-approved manual override if rail down.
Contributors see anonymised usage only ("$700 paid to funeral parlour") subject to privacy settings.

## Governance & cases
Case types: AUTHORITY_DISPUTE, PAYMENT_DISPUTE, CHARGEBACK, FRAUD, BENEFICIARY_MISMATCH, PROVIDER_DISPUTE, RECON_EXCEPTION. Fields: id, category, affected txn/source, amount, evidence, owner, status, SLA, escalation, outcome. Reason codes mandatory on every decision.
Holds: proportionate + source-aware. Community dispute does NOT auto-freeze Fidelity benefit (and vice-versa) unless documented legal/fraud risk (human decision). Every hold: owner, reason, review_at.
Admin replacement: dual approval + verifier re-check of authority evidence.
Family dispute: open AUTHORITY_DISPUTE → hold affected payouts → officer mediation → outcome logged.

## Refunds & cancellation
Policy config (D11): eligibility, destination (original instrument where supported/lawful), timing, fees, treatment of partly spent wallets. Refund before wallet use if wallet cancelled. Refund complete only on provider confirmation.

## Closure
Preconditions: final reconciliation done · no pending transactions · no material open disputes/chargebacks/holds · residual balance resolved per approved policy (config `closure.excess_funds_policy`: unset ⇒ closure blocked if residual > 0).
On close: statement (family + audit pack), thank-you messages to contributors (family one-tap; respects contributor notify consent), no further contributions, public page shows closed state. Unspent Fidelity benefit follows D11 policy; never auto-transferred.

## Events
payout.requested · payout.approved · payout.submitted · payout.confirmed · payout.failed · case.opened · case.resolved · hold.placed · hold.released · wallet.closing · wallet.closed
