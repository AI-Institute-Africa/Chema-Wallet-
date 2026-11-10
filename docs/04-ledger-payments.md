# 04 Ledger, payments, reconciliation

## 1. Ledger rules
Double-entry; every journal balances to 0 per currency. Append-only; reversals = new journal linked via `reverses_journal_id` + reason + actor. No deletes. Every entry carries provider_ref/txn ref where applicable.

## 2. Accounts
Per wallet: `W:COMMUNITY`, `W:FIDELITY_BENEFIT`, `W:GROUP:<group>` (tag), plus derived balance buckets.
System: `SYS:PROVIDER_CLEARING:<rail>`, `SYS:FEES`, `SYS:PAYOUT_CLEARING:<rail>`, `SYS:REFUND_CLEARING`, `SYS:SUSPENSE_UNMATCHED`.
Buckets (derived, displayed separately): **pending** (initiated/unknown), **held**, **available**, **paid**. Available = settled credits − refunds/chargebacks − fees borne − paid − held − reserved(pending payouts).
Community funds never used for Fidelity/platform ops/other wallets (enforce: no journal may move value across wallets or from W:COMMUNITY to any SYS account except fees/refund/payout clearing).

## 3. Payment state machine
| State | Rule |
|---|---|
| INITIATED | request exists; NO credit |
| PENDING_UNKNOWN | not final; not spendable; poll provider status + reconcile |
| SUCCEEDED/SETTLED | credit only on validated authoritative confirmation; post ONCE |
| FAILED/EXPIRED | no credit; retry only per rail safe-retry rules |
| REFUNDED/REVERSED/CHARGEBACK | linked compensating entries; keep original |
Receipt only after success state. Receipt retrievable even if message delivery fails.

## 4. Idempotency & webhooks
- Every request and callback has a unique reference; `payment.idempotency_key` UNIQUE.
- Webhooks: verify signature, timestamp window, replay cache; store raw event first (append), then process via queue; processing is idempotent (same event twice ⇒ one posting).
- Timeouts → PENDING_UNKNOWN, not FAILED. Provider status query job with backoff (queue retry window up to 72h).
- Outbox pattern: ledger commit + event publish atomic.
- Concurrent contributions must not corrupt balances (row-level lock/serializable on wallet balance reads for payouts).

## 5. Provider adapter interface (packages/providers)
```
collect(req) → {providerRef, redirectUrl|prompt}
queryStatus(ref) → state
verifyWebhook(headers, body) → event | reject
payout(req) → {providerRef}
refund(ref, amount) → {providerRef}
settlementReport(date) → rows
```
Ship: `MockEcoCash`, `MockOneMoney`, `MockCard` (configurable delay, duplicate-callback, timeout, partial-settle, chargeback scenarios for tests). Real adapters only when flag on + certification recorded. Disabled rail must not appear in any UI/message.

## 6. Fees & FX
No hard-coded fee. Fee schedule = config table, empty by default (⇒ zero, none displayed as "free" claims). Before payment show: total charged, fee payer, provider fee, FX rate, expected credited amount. Record gross, fee, fx_rate, net, settlement_currency per payment.

## 7. Reconciliation (daily + on-demand)
Match wallet ledger ↔ provider settlement rows ↔ (Fidelity record for benefit credits).
- Tolerances: config per rail+currency (`recon.tolerance.<rail>.<ccy>`); unset ⇒ zero tolerance but NO blanket freeze.
- Within tolerance: record difference (account `SYS:RECON_DIFF`), never silently write off.
- Material variance ⇒ `recon_exception` (owner, age, severity, target SLA, escalation) + proportionate hold on the affected txn/source. Wallet-wide hold ONLY for documented fraud/legal/material risk (human decision).
- Manual release: evidence + reason + dual approval + audit. Holds have `review_at`; none indefinite.
- Unmatched incoming → SUSPENSE_UNMATCHED + exception.

## 8. Refunds / chargebacks
Refund eligibility, destination (original instrument where supported/lawful), timing, fee treatment, partly-spent wallets: policy config (D11). Never mark refund/payout complete before provider confirmation. Chargeback ⇒ compensating entries + case (type CHARGEBACK) + source-aware hold.

## 9. Required invariants as property tests
sum(journal)=0 · idempotent replay · available never negative · payout ≤ available · compensating entries net original · no cross-wallet value movement.
