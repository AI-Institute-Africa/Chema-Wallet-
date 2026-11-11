# Security and resilience evidence (P10, 2026-11-11)

These are engineering tests run against the mocks. They do not replace an independent pen test or a production restore test (go-live gate 7).

## Security

| Control (docs/10) | What was done | Evidence | Result |
|---|---|---|---|
| Authz on every endpoint | Every registered route is collected through `onRoute` (`routesOf(app)`, over 100 routes). Each non-public route is called four ways: with no auth, a forged bearer, a random bearer and Basic auth. A signed-in stranger then calls every route that is not self-scoped. Public routes get junk ids and slugs plus a SQL-injection string | `apps/api/src/security.test.ts` › authorisation fuzz | All non-public routes answer 401; stranger calls get 4xx; no 5xx anywhere. Mutation check: a route that skips auth fails the test |
| IDOR | Real ids are taken from a funded wallet: wallet, payment, receipt, payout, document, approval, contribution and verification case. They are substituted into over 35 routes and called as a stranger and as another wallet's admin | security.test › IDOR sweep | Reads answer 403/404, writes 4xx, never 2xx. The owner still reads their own wallet |
| Staff surface | Every `/admin/*` route is called as a customer, and finance/ledger routes as a verifier | security.test › staff routes | 403 everywhere |
| Rate limits | Per-client fixed window (`apps/api/src/security.ts`) over a pluggable `RateLimitStore`: in-process by default, `RedisRateLimitStore` (atomic INCR + PEXPIRE Lua script, hashed keys) when `REDIS_URL` is set, so all API instances share one budget; a store failure falls back to the in-process window (still limited). Auth/staff/hand-off POSTs: 20 per minute. Public contribution POSTs: 30 per minute. All other routes: 600 per minute. Signed provider webhooks and health checks are exempt. Over-limit requests get 429 + `Retry-After`. Limits are configurable with `CHEMA_RATE_*`, and the proxy-hop count with `CHEMA_TRUST_PROXY_HOPS` | security.test › rate limits (7 tests); ratelimit-redis.test (needs REDIS_URL; passed 2026-11-11 against redis:7) | PASS. On by default; tests opt out explicitly |
| Headers / CSP | API sends `default-src 'none'` CSP, nosniff, DENY framing, no-referrer, HSTS, COOP and Permissions-Policy on every response, and `no-store` on authenticated ones. Web and admin set a CSP limited to self plus the API origin, `frame-ancestors 'none'`, nosniff and Referrer-Policy | security.test › response headers; `apps/*/next.config.ts` | PASS. Next pages still need `'unsafe-inline'` scripts until a nonce middleware lands (known gap) |
| Log PII scan | The full sweep plus a real OTP sign-in runs through the API with debug logging, including a phone and a national id in the query string. The captured log is scanned for E.164 phones, national ids, 16-digit PANs, the OTP code and the session token | security.test › log PII scan | No findings |
| Step-up / compromise | A step-up grant now dies with its session: `StepUpGrants.consume` requires a live, unrevoked session | `packages/ops/src/acceptance.test.ts` §S S8 | Fixed in P10 (test failed before the fix) |
| Dependency scan | `pnpm dep-audit` (runtime deps, high or above) runs in `pnpm verify`; CI also runs `pnpm audit --audit-level high` | 2026-11-11 run | No known vulnerabilities (runtime or dev). The dev-only `eslint → minimatch <11.0.1` advisory is fixed by a root `pnpm.overrides` (`minimatch@>=7 <11.0.1` ⇒ `>=11.0.1`, resolves 11.0.8); `pnpm lint` passes with it |
| Secret scan | `pnpm secret-scan` | 2026-11-11 run | Clean |
| Scope audit | `pnpm scope-audit`: Bank/Mukuru/WorldRemit/USSD/InnBucks and hard-coded fee amounts or rates checked across code, UI, copy, migrations, runbooks and tests. Spec docs are exempt. Tests that prove absence carry `scope-audit:allow` | `scripts/scope-audit.test.ts` | Zero hits |

## Resilience / chaos

| Scenario | Evidence | Result |
|---|---|---|
| Payout worker killed mid provider call (the provider accepted, the worker died before recording) | `packages/payouts/src/chaos.test.ts` | A second worker leaves it alone while the lease is live. After lease expiry it records a timeout, asks the provider and confirms. Result: one provider payout per reference, one PAYOUT journal, correct balances |
| Payment worker killed after the webhook was stored | chaos.test | The status poller credits from the provider. Replaying the queued event twice adds nothing. A late redelivery of the old signed webhook is refused (STALE_TIMESTAMP) |
| Out-of-order callbacks | chaos.test | A late FAILED after SUCCEEDED keeps SUCCEEDED, the credit stands and nothing is debited. Callbacks for 5 payments delivered reversed and duplicated: each credited once |
| Queue replay | chaos.test | Settlement jobs replayed after delivery: one receipt and no extra SMS |
| Duplicate callbacks at load | load test (docs/evidence/load-test.md) | 400 duplicates rejected, 0 extra credits |
| Webhook vs status-query race; many workers on one event | `packages/payments/src/concurrency.test.ts` (real PG) | One credit |

## Backup / restore drill

`scripts/restore-drill.sh <db>` runs these steps against compose Postgres 16:
1. Dump with `pg_dump -Fc` and restore into a fresh database.
2. Compare row counts (payment, contribution, receipt, journals, entries, audit rows), the ledger net and the audit-chain head.
3. Run `pnpm audit:verify` on the copy.

Run 2026-11-11 on a database seeded by the load tool (120 contributions, 1,282 audit rows):

```
== restored chema_test_74728652d2d5_restored in 8 s
payment=120 contribution=120 receipt=120 ledger_journal=120 ledger_entry=240 ledger_net=0 audit_rows=1282
audit_head=21558a9d…4744 (identical on both sides)
== facts identical
audit chain OK: 1282 rows, head 21558a9d…4744
```

Not covered: production-size restore, point-in-time recovery, replica failover, and the RTO/RPO targets themselves, which the owners have to define (gate 7, D19).

## Gaps tranche (2026-11-11)

| Control | Built | Evidence | Result |
|---|---|---|---|
| Sign out everywhere | `identity.sign_out_everywhere` (customer, own sessions) and `identity.revoke_sessions` (FIDELITY_ADMIN, MFA, portal-only, written reason); step-up grants die with their sessions | ACC §S S8; routes.test; admin-routes.test | PASS |
| Device-bound sessions | A session that recorded `x-device-id` at login is refused (401, audited `identity.session` DEVICE_MISMATCH) from any other or no device: staff always, customers behind `security.bind_customer_device` (off) | routes.test (2 tests) | PASS. The portal must send `x-device-id` at login for staff binding to bite |
| Audit anchoring | Worker appends the chain head (seq, hash, ts) to `CHEMA_AUDIT_ANCHOR_FILE` (JSONL, default `.data/audit-anchors.jsonl`) every `CHEMA_AUDIT_ANCHOR_INTERVAL_MS` (5 min); `pnpm audit:verify --anchors <file>` fails on TRUNCATED / ANCHOR_MISMATCH | chain.test › external anchoring (5 tests) | PASS. Production: put the anchor file on write-once storage (object lock / WORM) |
| Access-review sign-off | `access_review_signoff` (append-only): reviewer, role, period, row count + sha256 of the exact CSV, notes; stale export refused (409, audited); a reviewer who changed staff access in the period is refused | ops.test › access review sign-off; admin-routes.test | PASS |
