# Load and burst test (P10, 2026-11-11)

Tool: `apps/api/src/load-test.ts`. It runs the real services (command bus, ledger, payments, contributions, outbox) on a throwaway PostgreSQL 16 database (docker compose), with mock rails and mock OTP.

```
docker compose up -d postgres
CHEMA_TEST_DATABASE_URL=postgres://chema:change-me@localhost:55432/chema \
  pnpm --filter @chema/api load -- --wallets 40 --contributions 4000 --concurrency 32
```

Each run has four phases:
1. **Burst**: N guest contributions spread over W verified wallets, C in flight at once. Initiation time = `contribute()`, including the mock provider call.
2. **Confirm**: every provider callback, plus a 10% duplicate of them, through webhook verify + store + worker processing, C at a time.
3. **Settle**: outbox relay plus the settlement/notification handlers, run by the sequential test-harness pump.
4. **Checks**:
   - each payment credited exactly once;
   - the ledger nets to zero;
   - each wallet's community balance equals its contributions;
   - every contribution is settled;
   - the audit chain verifies.

## Plan baseline (docs/10 Capacity)

Year 1 plan: 10,000 funerals and 300,000 contributors. That averages ≈ 0.01 contributions/s.

The burst assumption is 100 funerals each taking 30 contributions in the same hour, ≈ 0.8/s. The test keeps 32 initiations in flight continuously, which is 30–70 contributions/s on one laptop. That is roughly 30× the burst assumption and over 2,000× the average.

## Results

Host: Windows 11 laptop. RAM is the binding constraint (about 2.6 GB free at the start). Postgres 16 runs in Docker Desktop; the API services run in-process under tsx.

| Run | Conditions | Burst ok / errors | Burst rate | Initiation p50 / p95 / p99 / max (ms) | Callbacks (dupes) | Confirm rate | Settled | Credit once | Ledger net | Wallet totals | Audit chain |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | clean, 40 × 4,000 × 32 | 4,000 / 0 | 66.7/s | 409 / 1,081 / 1,459 / 1,715 | 4,400 (400 rejected) | 71.4/s | not measured (harness bug, fixed) | yes | 0 | match | OK, 17,082 rows |
| 2 | clean, 40 × 4,000 × 32 | 4,000 / 0 | 58.1/s | 483 / 811 / 1,182 / 3,289 | 4,400 (400 rejected) | 60.2/s | not measured (same bug) | yes | 0 | match | OK, 17,082 rows |
| 3 | **contended**: the full vitest suite (2 workers) ran on the same machine for most of the burst | 4,000 / 0 | 25.2/s | 909 / 4,291 / 8,800 / 9,109 | 4,400 (400 rejected) | 29.5/s | 4,000 / 4,000 at 5.5/s | yes | 0 | match | OK, 41,082 rows |

The 200-contribution warm-ups (5 wallets, concurrency 16) also passed every check. Their initiation p99 was 420 ms.

## Reading the results

- **Correctness held under every run.** There were no lost or double credits, 400 duplicate callbacks were rejected, the ledger netted to zero, every wallet total matched and the audit chain verified. This covers docs/14 §L "concurrent contributions" and §A 6 at volume.
- **Initiation under 5 s (§A 13) held at p99 in both clean runs**, with 32 concurrent initiations: 1.2–1.5 s at p99, 0.4–0.5 s at p50. On a box saturated by an unrelated test suite, p95 stayed under 5 s but p99 reached 8.8 s. Production sizing therefore needs dedicated CPU for the API and the database. The latency is mostly in-transaction work: authz, audit chain append under an advisory lock, and ledger posting.
- **The audit chain append is serial by design** (advisory lock, contiguous `seq`). It is the expected throughput ceiling. At about 60 contributions/s it is still far above the plan burst.
- **Settlement was measured with the test harness's sequential pump** (one job at a time, with in-memory queue bookkeeping): 5.5/s while contended. The production worker uses BullMQ with retries. Its parallel throughput was not measured.

## Not covered

- Payouts, claims and WhatsApp at volume.
- The BullMQ worker under load.
- Multi-instance API: the rate limiter is per process.
- Long soak runs (hours).
- Production-like hardware.

These are listed in PROGRESS.md "Known gaps".
