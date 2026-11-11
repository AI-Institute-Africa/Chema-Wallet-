# Runbooks

Short operating procedures for the staff portal (`apps/admin`). One page each. They describe what the system does today. Where a business decision is still open (`docs/13`), the runbook says so and uses the safe default. It never invents a rule.

| # | Runbook | Owner role |
|---|---|---|
| 01 | [Verification: reject and appeal](01-verification.md) | Community verifier, Fidelity admin |
| 02 | [Authority, disputes, holds](02-authority-and-holds.md) | Ops/finance, Fidelity admin |
| 03 | [Payments and providers](03-payments-and-providers.md) | Ops/finance |
| 04 | [Reconciliation](04-reconciliation.md) | Ops/finance |
| 05 | [Fraud, impersonation, data incidents](05-fraud-and-incidents.md) | Fidelity admin, auditor |
| 06 | [WhatsApp outage, hand-off, after-hours](06-whatsapp-and-support.md) | Ops/finance, claims |
| 07 | [Closure, residual funds, final statement](07-closure.md) | Ops/finance, Fidelity admin |

These rules apply to every runbook:
- **Maker ≠ checker.** These actions need a second, different person: ledger adjustments, hold releases, payout overrides, refunds, unblocking a claim route, financial flags, and granting privileged roles. The flow is: request (maker) → approve in **Approvals** (checker) → execute with the approval id (maker). The API refuses a self-check (`MAKER_CANNOT_CHECK`).
- **Write the reason.** Every human decision needs a written reason of at least 10 characters. The reason goes into the audit log.
- **Never collect PINs, passwords, OTPs or card data** in chat, on calls or in notes.
- **Messages are not money.** A failed notification never changes a transaction. Check the ledger, not the chat.
- **When in doubt, hold, don't release.** A hold is protective and needs one person. A release needs two.
