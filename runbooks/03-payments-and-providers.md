# 03 Provider outage, pending/unknown, duplicate callback, failed payout, refund, chargeback

**Queues:** Failures, Recon exceptions, Approvals. **Who:** ops/finance.

## Provider outage
- To turn off a rail, set its flag (`rail.ecocash`, `rail.onemoney`, `rail.card`). These are financial flags, so the change is dual (Config & flags → Request → second Fidelity admin → Apply). A disabled rail disappears from every UI and message.
- Payouts that hit an outage go to `RAIL_DOWN` and retry by themselves. Watch them in **Failures**.

## Pending / unknown payment
- `PENDING_UNKNOWN` is never spendable and never credited. The worker keeps polling until the poll window ends, then raises a `POLL_WINDOW_EXPIRED` exception (runbook 04).
- Never credit a wallet by hand because a payer shows an SMS or a screenshot. Only the provider's confirmation counts. If the provider later settles it, recon matches it or puts it in suspense.

## Duplicate callback
- Callbacks are signed, replay-protected and idempotent, so a duplicate posts nothing. No action is needed. If a duplicate journal ever appears, the `duplicate_postings` KPI shows non-zero (Reports). Treat that as an incident (runbook 05).

## Failed payout
- `FAILED` / `REJECTED` releases the reservation. The money is available again. Tell the family through the case. Check the payee name.
- **Rail down, paid outside the rail:** use **Override** (maker) with the external reference and a document. A second ops/finance person approves. Never record an override without proof of payment.

## Refund (D11)
- `refund.policy` is unset, so every refund is a manual, dual-approved case: `POST /payments/:id/refunds` (maker), approved by a second ops/finance person.
- Refunds of partly spent wallets follow the case outcome. They never go below what is available.

## Chargeback
- The provider's chargeback posts a reversal and a TXN hold. A shortfall raises `CHARGEBACK_SHORTFALL` (runbook 04). Open or attach a `CHARGEBACK` case and keep the evidence on it.
