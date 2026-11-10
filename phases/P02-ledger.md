# P02 Ledger
**Load:** docs/04-ledger-payments.md §1 §2 §9 (skip rest), docs/03-domain-model.md (ledger invariants section)
**Goal:** correct, append-only double-entry core. No payments yet.

## Do
1. Migrations: ledger_account, ledger_journal, ledger_entry; triggers: balanced journal per currency, deny UPDATE/DELETE.
2. `packages/ledger`: `post(journal)`, `reverse(journalId, reason, actor)`, account bootstrap per wallet (COMMUNITY, FIDELITY_BENEFIT, GROUP:<id>) and system accounts.
3. Balance service returning pending/held/available/paid per sub-ledger (derive from entries + holds + reservations).
4. Guard: reject any journal moving value across wallets, or W:COMMUNITY→non-allowed SYS accounts.
5. Reservation API (reserve/release funds for payout requests) with locking (`SELECT … FOR UPDATE` on wallet balance row or serializable txn).
6. Hold model (txn/source/wallet scope) feeding `held` bucket.

## Tests (docs/14 §L)
Property tests (fast-check): sum=0, available≥0, reversal nets original, concurrency (parallel posts + reservations never overdraw), no cross-wallet movement, replay of same journal key is idempotent.

## Done when
Property + concurrency suites green; ledger package has no dependency on channels/providers.
