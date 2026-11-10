# P03 Payments (mock rails first)
**Load:** docs/04-ledger-payments.md §3–§8, docs/14-test-plan.md §P
**Goal:** idempotent collection pipeline with state machine, webhooks, refunds, recon core.

## Do
1. Migrations: payment, provider_event (raw, append), recon_run, recon_exception, fee_schedule (empty).
2. Provider adapter interface + `MockEcoCash/MockOneMoney/MockCard` with scenario switches (delay, dup callback, timeout, partial settle, chargeback, outage). Rails gated by flags; disabled rail ⇒ 404 on API and absent from rail list endpoint.
3. Payment service: initiate (idempotency key), state machine per §3, credit ledger ONLY on SUCCEEDED, once.
4. Webhook endpoint: signature verify, timestamp window, replay cache, raw store, queue, idempotent processor.
5. Status-query job (backoff, 72h window) for PENDING_UNKNOWN.
6. Refund/chargeback: compensating journals + case stub + source-aware hold.
7. Fee/FX: schedule lookup (empty ⇒ zero), pre-payment disclosure object, store gross/fee/fx/net.
8. Reconciliation job: match ledger ↔ provider settlement rows; tolerance config; exceptions with owner/age/severity; proportionate hold; unmatched→suspense.
9. `live_funds.enabled=false` ⇒ collection works only on mock/sandbox adapters; real adapters refuse to init.

## Done when
docs/14 §P and §L recon rows pass against mocks; no code path credits on anything but SUCCEEDED.
