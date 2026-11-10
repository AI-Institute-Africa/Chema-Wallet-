# PROGRESS

## Status
| Phase | State | Date |
|---|---|---|
| P00 bootstrap | done | 2026-11-10 |
| P01 identity/audit/consent | done | 2026-11-10 |
| P02 ledger | done | 2026-11-10 |
| P03 payments | done | 2026-11-10 |
| P04 wallet + verification | done | 2026-11-10 |
| P05 public page + contribute | todo | |
| P06 Fidelity claims link | todo | |
| P07 payouts/governance/closure | todo | |
| P08 WhatsApp | todo | |
| P09 admin portal + recon + reports | todo | |
| P10 hardening + acceptance | todo | |

## Decisions
(append: date — decision — why)
- 2026-11-10 — Repo `RUBIEM-DEVELOPERS-REPO/Chema-Wallet-` made private; only the distilled spec is committed (BRD/Proposal .docx stay out) — client-confidential material.
- 2026-11-10 — pnpm workspaces; TS run via `tsx` (no build step yet) — fastest path to a runnable skeleton.
- 2026-11-10 — TypeScript pinned to 6.0.x — typescript-eslint 8 supports `<6.1`; TS 7 breaks lint.
- 2026-11-10 — Tests use PGlite (in-process Postgres 16 WASM) behind a `SqlClient` interface; runtime uses node-postgres — no Docker needed for `pnpm test`.
- 2026-11-10 — `Money = { minor: bigint, ccy }`, JSON `{minor: "string", ccy}`; ZiG uses ISO 4217 `ZWG` — no float or `number` path for amounts.
- 2026-11-10 — Money lint: `chema/no-number-money` (names with money words typed `number`), `parseFloat` and `Math.round/floor/ceil` banned.
- 2026-11-10 — P01: `CommandBus.execute(cmd, input, {actor})` is the only path for state changes and sensitive reads: resolve subject from DB → `authorize` (deny by default) → step-up → handler → ALLOWED audit row, all in ONE transaction; denials (incl. NOT_FOUND) are audited separately. Handlers get a branded `CommandTx` so mutating code cannot run outside the bus.
- 2026-11-10 — P01: audit chain = contiguous `seq` + `prev_hash UNIQUE` + sha256 over canonical JSON, appended under an advisory lock; before/after stored as hashes only (no PII in audit_log) — tamper-evident and linear across processes.
- 2026-11-10 — P01: OTP codes HMACed, session/step-up tokens sha256-hashed, TOTP seeds AES-GCM encrypted; TOTP/HOTP implemented over `node:crypto` (RFC vectors tested) — no auth dependency to trust.
- 2026-11-10 — P01: `allow_set_once(col…)` trigger fn (migration 0002) for "mostly immutable" tables (consent, approval, wallet_role, document, holds); `deny_mutation()` stays for fully append-only ones.
- 2026-11-10 — P01: request logs redact ALL query-string values — a test showed a token placed in a URL reached the log.
- 2026-11-10 — P01: financial flags change via `config.change` approval (maker `requestFlagChange` → a different FIDELITY_ADMIN `decideApproval` → maker `FlagService.set(…, {approvalId})`); the approval pins key+value and is single use.
- 2026-11-10 — P01: BullMQ 6 needs `ioredis` installed and a constructed client under ESM; `packages/core/src/outbox/bullmq.ts` owns and closes the clients.
- 2026-11-10 — P02: ledger = `ledger_account` (one sub-ledger × one currency) / `ledger_journal` / `ledger_entry`, plain SQL. Library functions take the bus's `CommandTx` + `Actor` (like `createApproval`) and do NO authorisation: P07/P09 wrap them in commands.
- 2026-11-10 — P02: every rule is enforced twice — typed errors in TS before any write (`guards.ts`, funds checks) and AFTER-INSERT statement triggers in the DB (`ledger_journal_guard`, `ledger_funds_guard`, `ledger_reservation_guard`, `hold_guard`) proven by raw-SQL tests that bypass the library.
- 2026-11-10 — P02: entries of a journal must arrive in ONE INSERT statement (trigger seals the journal); a header without ≥2 entries fails at commit (deferred constraint trigger).
- 2026-11-10 — P02: locking = `lockWallet` (`SELECT … FOR NO KEY UPDATE` on all the wallet's accounts, refuses non-READ-COMMITTED) before any wallet debit, reserve or hold; credits take no lock so contributions never queue. The DB triggers re-lock the account row, so even a caller that skips the library cannot overdraw.
- 2026-11-10 — P02: idempotency = UNIQUE key + sha256 of canonical content: same key + same content ⇒ replay (same id, nothing written); same key + different content ⇒ `IdempotencyConflictError`. Reversal key is `reverse:<journalId>` (reserved prefix) + `reverses_journal_id UNIQUE`.
- 2026-11-10 — P02: a PAYOUT journal must consume exactly one active reservation of the same account + amount (checked in TS and by trigger). `paid` = net debits of PAYOUT journals, so reversing a payout lowers it.
- 2026-11-10 — P02: a reversal may spend the money held by TXN holds on the journal it reverses (that is what the hold protects), and a TXN hold on a reversed journal stops counting toward `held`. Found in self-review; tests fail without it.
- 2026-11-10 — P02: real-Postgres concurrency suite runs when `CHEMA_TEST_DATABASE_URL` is set (CI has a postgres:16 service). PGlite has one connection, so PGlite-only runs CANNOT catch races: removing the app lock + DB guard gave 18 reservations of 100 against a 1 000 balance on real PG and passed on PGlite.
- 2026-11-10 — P03: new package `@chema/payments` (core + ledger + providers). It cannot live in core (ledger depends on core ⇒ cycle); `@chema/providers` holds adapters only and depends on shared alone.
- 2026-11-10 — P03: provider calls never run inside a DB transaction. Sequence = command (tx) → provider call → command (tx): initiate → `collect()` → `payment.record_submission`; webhook verify → `payment.receive_event` (raw store + outbox) → worker `payment.process_event`; `queryStatus()` → `payment.poll`; refund execute → `refund()` → `payment.refund_submission`; `settlementReport()` → `recon.run`.
- 2026-11-10 — P03: the credit happens in ONE function, `applyConfirmation` (`packages/payments/src/confirm.ts`), enforced three ways: payment row `FOR UPDATE` + must be open; ledger key `payment:<id>:credit`; `payment_guard` trigger lets `credit_journal_id` be set once, only with SUCCEEDED, only to that payment's CONTRIBUTION journal. A test greps the repo: no other non-test file posts `kind: 'CONTRIBUTION'`.
- 2026-11-10 — P03: replay cache = `UNIQUE (rail, provider_event_id)` on append-only `provider_event` (durable) + ±5 min signed-timestamp window; one `provider_event_outcome` row per event, processed under a row lock ⇒ a redelivery is a no-op.
- 2026-11-10 — P03: FAILED/EXPIRED are final. A late success for them is never credited; it surfaces as UNMATCHED_INCOMING in recon (suspense + exception). Collect timeouts and unexpected errors ⇒ PENDING_UNKNOWN, never FAILED.
- 2026-11-10 — P03: refund = maker-checker (`payment.refund` / `payment.refund.approve`, opsfin, maker ≠ checker). Executing debits the wallet into REFUND_CLEARING at once (unspendable); provider confirmation moves REFUND_CLEARING → PROVIDER_CLEARING and completes it; provider refusal reverses the debit.
- 2026-11-10 — P03: chargeback = DISPUTE_OPENED places a TXN hold for the disputed amount on that payment's credit only + CHARGEBACK case; CHARGEBACK releases it and debits min(amount, available, not-yet-compensated) to REFUND_CLEARING; any shortfall is parked in SUSPENSE_UNMATCHED + CHARGEBACK_SHORTFALL exception. Never negative; no loss-bearer chosen (human ADJUSTMENT later).
- 2026-11-10 — P03: recon differences within tolerance post to new system account `SYS:RECON_DIFF` (migration 0010 widens the kind CHECK); short settlement beyond tolerance = TXN hold for the shortfall on that payment only; over-settlement and unmatched rows go to SUSPENSE_UNMATCHED. Re-running a day is idempotent.
- 2026-11-10 — P04: new package `@chema/wallet` (core + ledger), like `@chema/payments`: wallet lifecycle, community verification, activation, FraudRules, reports. Channels run its commands through `core.bus`.
- 2026-11-10 — P04: wallet state machine enforced twice — `ConflictError`s in commands and the `wallet_guard` trigger (legal transitions only, immutable identity columns, set-once slug/verified_at, deceased details frozen after DRAFT, no DELETE). CHECKs: slug only in ACTIVE/SUSPENDED/CLOSING/CLOSED, and ACTIVE ⇒ slug + verified_at. Every status change writes append-only `wallet_status_event` (who, role, reason, note, case).
- 2026-11-10 — P04: reviewer ≠ submitter ≠ creator ≠ admin ≠ anyone holding a wallet_role, checked three ways: matrix `assigned_not_own_case` (audited DENIED), handler `isParty` (ForbiddenError REVIEWER_IS_PARTY, rolled back, not audited), and trigger `verification_case_reviewer_guard`. An appeal must be decided by a different reviewer than the one who rejected it.
- 2026-11-10 — P04: evidence standard = completeness only (one accepted `verification.evidence_types` death proof + ADMIN_ID + MANDATE, each malware-scanned CLEAN); `MissingEvidenceError.missing` names the gaps (API 409 `{error:'missing_evidence', missing}`). Evidence types are on `verification_evidence` rows, each type pinned to a document class.
- 2026-11-10 — P04: APPROVED needs every checklist item PASS and no open fraud flag; REJECTED/MORE_INFO need notes. One open case per wallet (partial unique index); decision columns set-once. Parallel submits/decides proven on real Postgres (`packages/wallet/src/concurrency.test.ts`).
- 2026-11-10 — P04: public slug = 128 random bits, base32 lowercase (26 chars). QR (`qrcode`, SVG) and share text are built on demand from the slug, never stored. Badge copy is the existing i18n key `badge.verified.tooltip`.
- 2026-11-10 — P04: public endpoints `/public/wallets/:slug[/qr.svg|/report]` give 404 for unknown, malformed and every non-ACTIVE slug (SUSPENDED included). `verifiedWalletGate` (ACTIVE + slug + verified_at) replaces `DENY_ALL_GATE` in `apps/api/src/payments.ts`.
- 2026-11-10 — P04: fraud rules (`DeterministicFraudRules`) run at create, add-evidence and submit, and only write idempotent `fraud_flag` rows (dedupe_key). Status never changes. Flags are visible to verifiers and oversight only, not to the family or the assisting agent.
- 2026-11-10 — P04: `wallet_id` FKs added (migration 0012) on wallet_role, staff_assignment, approval, consent_record, document.linked_wallet, ledger_account, ledger_journal, ledger_reservation, hold, payment, case_record, receipt, recon_exception. Test fixtures go through `insertTestWallet` (`@chema/shared/testing`). `payments.newWallet()` is now async.
- 2026-11-10 — P04: web = Next.js 16 app router in `apps/web` (draft form, evidence upload, status page; client components calling the API). It has its own tsconfig (DOM lib); root `typecheck` runs both. CI also runs `next build`.
- 2026-11-10 — P03: rail flags gate NEW money only (initiate, rail list, webhook intake ⇒ 404 when off). Polling and recon still use the adapter for payments already in flight, so switching a rail off cannot strand moving money.

## Assumptions (not in spec; safest default taken)
- Flag precedence: env `CHEMA_FLAG_<KEY>` > `config_flag` row > registry default. Env can enable financial flags (needed for mock rails in dev/test); DB writes cannot.
- Financial flags (`financial: true` in registry) are refused by `FlagService.set` (`DualApprovalRequiredError`, denial audited) unless a matching APPROVED `config.change` approval is supplied (P01).
- `commissions.enabled` locked false from every source, including env.
- Keys added beyond docs/13 wording: `settlement.direct_parlour` (D17), `pilot.enabled` (D19 kill switch), `i18n.enabled_locales` (D15, default `['en']`), `ai.*` (docs/11), `recon.tolerance.<rail>.<usd|zwg>` (6 keys).
- `retention.financial_years` default unset ⇒ retain, never auto-delete (7y is planning only, D12).
- `verification.evidence_types` default = docs/05 list (any ONE + admin ID + mandate).
- Local Node is 24; Docker image and CI use Node 22.
- `apps/web`, `apps/admin` are placeholders; Next.js lands in P04/P05/P09.
- P01 staff auth: password (scrypt) + TOTP in one step behind `StaffAuthenticator`; ONE role per staff account; SSO adapter later. Spec says "MFA for privileged and financial roles" — applied to ALL staff (stricter).
- P01 matrix column "fidelity_admin/auditor" split: `FIDELITY_ADMIN` (config, role admin, holds; MFA) vs `AUDITOR` (read only).
- P01 matrix rows added beyond docs/02 (least privilege): `consent.manage` own only; `consent.view` own + auditor + fidelity_admin; `document.upload` wallet ADMIN / assigned agent / own unlinked; `document.read` uploader, wallet ADMIN, assigned agent/claims/verifier, auditor; `document.delete` + `retention.hold` FIDELITY_ADMIN; `document.scan_result` SYSTEM; `config.change(.approve)` FIDELITY_ADMIN maker/checker.
- P01 "create draft: admin Y": the admin does not exist before the draft, so any customer session may create one (P04 makes them ADMIN). "view own receipt: contributor" = any customer, own receipt only.
- P01 ops/finance is a payout checker only when amount > `approvals.payout_high_value_minor`; unset ⇒ never (family approver only). Every payout still needs a checker while unset.
- P01 agent case assignment = `wallet_role AGENT`; other staff = `staff_assignment`. A customer session never gets AGENT authority and a staff session never gets family roles, even for the same person.
- P01 limits (not in spec; code constants in `identity/sessions.ts`): OTP 6 digits / 5 min / 5 attempts / 3 per 15 min per phone; customer session 12 h; staff session 8 h; step-up grant 5 min single-use; staff lock 15 min after 5 failures.
- P01 documents: max 5 MB; pdf/jpeg/png only; every class gets retention class SENSITIVE; no automatic deletion — only explicit FIDELITY_ADMIN delete, blocked by a retention hold on the document or its wallet (D12 unresolved).
- P01 secrets: `CHEMA_AUTH_SECRET` (OTP HMAC) and `CHEMA_DATA_KEY` (wraps document keys + TOTP seeds), base64 of 32 bytes, from env (secrets manager in prod). No defaults: without them the api serves health only and the worker exits.
- P01 OTP delivery + malware scanner are MOCKS (D16 provider undecided). The running API therefore cannot complete an OTP login (the code is never delivered or logged); tests read it from `MockOtpProvider`.
- P02 sub-ledger → sub-ledger movement inside one wallet is refused (`CrossSubLedgerError`); spec only bans cross-wallet. Community/benefit/group never mix, even with approval.
- P02 the exit rule (wallet → only FEES / REFUND_CLEARING / PAYOUT_CLEARING) applies to every wallet sub-ledger, not only COMMUNITY. Exact reversals are exempt (they undo an allowed movement).
- P02 a wallet debit larger than `available` is refused for every journal kind, chargebacks included. docs/04 §8 was not in P02's load list: P03 decides how a chargeback shortfall is booked (e.g. SUSPENSE + case) — the ledger will not go negative.
- P02 `pending` is not in the ledger and never spendable: `getBalances(q, walletId, { pending })` takes a caller-supplied source; zero until P03.
- P02 `reserved` is returned as its own field next to the four spec buckets; `available = settled − reserved − held`. `uncoveredHold` reports TXN holds whose money had already left.
- P02 a hold needs reason code, owner and review date (no open-ended freezes). Placing a hold never fails for lack of funds. Reserved funds stay reserved under a hold: whether an in-flight payout proceeds is P07's call.
- P02 reversing a reversal is refused; a partial refund is a new REFUND journal, not a reversal.
- P02 journal kinds (`CONTRIBUTION BENEFIT PAYOUT REFUND CHARGEBACK FEE SETTLEMENT SUSPENSE ADJUSTMENT`) are a guess from the account list; extend by migration. ADJUSTMENT and reversals require a reason.
- P02 rails are not hard-coded: a clearing-account qualifier is any `^[A-Z][A-Z0-9_]{1,31}$` code.
- P02 multi-currency: one account per (sub-ledger, currency); journals balance per currency; no FX inside the ledger.
- P03 contribution gate: production `DENY_ALL_GATE` — no wallet table yet, so `POST /payments` is 403 for every wallet until P04/P05 swap in the verification check (`ContributionGate.canAccept`).
- P03 only COMMUNITY contributions; group contributions (`feature.group_contributions`) are P05.
- P03 fee semantics: amount = what the contributor gives; fee payer CONTRIBUTOR ⇒ gross = amount + fee; WALLET ⇒ net = amount − fee. Fee = fixed + amount × bps / 10 000 (integer floor). Credited to `SYS:FEES`. The disclosed fee is compared with the provider-reported fee ⇒ FEE_VARIANCE on mismatch.
- P03 FX: no rate source exists ⇒ payment currency = settlement currency, `fx_rate` null, cross-currency confirmations not credited (CURRENCY_MISMATCH exception).
- P03 confirmation ≠ request: credit min(confirmed, requested); excess ⇒ SUSPENSE + AMOUNT_VARIANCE; short ⇒ credit confirmed + AMOUNT_VARIANCE. Fee scales pro rata on a short credit.
- P03 polling: 1 min doubling, capped 6 h, window 72 h from initiation; after the window the payment stays PENDING_UNKNOWN (never assumed failed) + POLL_WINDOW_EXPIRED exception.
- P03 exception SLA (D09 unresolved): HIGH 24 h, MEDIUM 72 h, LOW 168 h; owner = `OPS_FINANCE` role queue (hold `owner_id` holds the same label); settlement lag 1 day before MISSING_SETTLEMENT. Code constants in `exceptions.ts` / `recon.ts`; P09 makes them config.
- P03 refund provider timeout: refund stays open with money in REFUND_CLEARING (not spendable, not lost) until a callback or an operator settles it; no auto-retry.
- P03 provider events that arrive before the state they need (e.g. DISPUTE_OPENED before the payment is credited) are recorded with outcome `NOT_CREDITED` and not retried.
- P03 mock webhook wire format + HMAC-SHA256 over `${ts}.${body}` (headers `x-chema-signature: v1=…`, `x-chema-timestamp`) is ours; each real adapter implements its provider's scheme. `CHEMA_MOCK_WEBHOOK_SECRET` (≥16 chars) or a per-process random secret.
- P03 `recon_exception.escalation_level` exists but nothing escalates yet (P09); the column is not in the set-once list, so P09 adds a migration to move it.

- P04 MORE_INFO sends the wallet back to DRAFT (a transition docs/03 does not list). The family adds evidence and resubmits, which opens a new case.
- P04 agent-assisted drafts: the agent supplies `adminPhone` (find-or-create person). The agent gets wallet_role AGENT and the family member ADMIN. Submit is refused (`ADMIN_NOT_CONFIRMED`) until that admin has a verified identity_binding (has logged in by OTP once).
- P04 roles: suspend/unsuspend and verifier assignment = FIDELITY_ADMIN only, with a written note of at least 10 characters plus a reason code. Verifiers see only cases assigned to them (`staff_assignment`); FIDELITY_ADMIN routes the queue. `wallet.view` = admin, approver, assigned agent/verifier, auditor, fidelity_admin.
- P04 photo is NOT taken at create (the columns exist, with a CHECK that photo needs consent). Public photos and their consent flow are P05.
- P04 share text is pronoun-neutral ("give them") because we collect no pronoun. The public view shows only name, funeral date, badge and share links. Privacy-driven fields are P05.
- P04 fraud velocity: more than `fraud.velocity_max_drafts_24h` (unset ⇒ 3) drafts per creator in 24 h ⇒ flag. It applies to agents too. Flags are review tasks only, so the stricter default is safe.
- P04 suspicious-wallet reports: only for ACTIVE wallets. A report opens `case_record` type FRAUD and changes no status. Anonymous reports run as SYSTEM with an HMAC-keyed IP hash (`CHEMA_REPORT_IP_KEY`, else random per process). Limit 5/hour per reporter.
- P04 `CHEMA_PUBLIC_BASE_URL` (default `http://localhost:3000`) builds share links/QR; web reads `NEXT_PUBLIC_API_URL` (default `http://localhost:7600`).

## Gotchas / handoff to next phase
- New state change = a `Command {name, resolve, run}` run through `core.bus.execute`. Add its action to `ACTIONS` + `MATRIX` (`packages/core/src/authz/matrix.ts`) AND to the independent `EXPECTED` table in `matrix.test.ts` (the test fails if either is missing). Step-up actions: `STEP_UP_ACTIONS`; maker→checker pairs: `CHECKER_ACTION`.
- Maker-checker: in the maker command call `createApproval(tx, actor, {action, subject…, payload})`; the checker runs `decideApproval`; the maker then executes with `consumeApproval(tx, actor, id, {…same payload})`. `requiresDual(action, amount, threshold)` says whether a checker is needed. Escalation for an unavailable approver is NOT built (P07).
- Inside a bus handler/transaction never touch `db` directly or call a service that does (PGlite has one connection ⇒ deadlock; pg would read outside the tx). Use the `tx`, e.g. `flags.getIn(tx, key)`.
- SQL trap: `SELECT seq::text AS seq … ORDER BY seq` sorts as TEXT ('10' < '2'). Qualify the column (`ORDER BY audit_log.seq`). This was a real bug here.
- Not built yet: bus commands for role admin (`role.admin`: grant/revoke `wallet_role`, `staff_assignment`, staff enrol/disable) and for applying a flag change. `StaffAuthService.enroll` and `FlagService.set` are callable only from code/tests (no HTTP route, no seed CLI). P09 wraps them.
- Audit: `pnpm audit:verify` (exit 1 + first bad seq). Detects edits, deletions, forks; truncating the NEWEST rows needs an externally anchored chain head (P09/P10).
- Tests: `createHarness()` from `@chema/core/testing` = PGlite + real services + mock OTP/blobs + controllable clock (`h.customer()`, `h.staff(role)`, `h.grantRole`, `h.assign`, `h.advance(ms)`).
- Outbox: `enqueueOutbox(tx, topic, payload)` in the producer's tx; topics so far `document.scan`, `document.purge`; handlers live in `apps/api/src/worker.ts` (`pnpm dev:worker`, compose service `worker`) and must be idempotent. The BullMQ test only runs with `REDIS_URL` set.
- `auth_session.device_ref` is stored but device binding is not enforced; no general HTTP rate limiting beyond OTP/staff lockout (P10).
- Ledger (P02): `@chema/ledger` — `bootstrapWalletAccounts`, `ensureGroupAccount`, `ensureSystemAccount`, `post`, `reverse`, `reserve`, `release`, `placeHold`, `releaseHold`, `getBalances`, `getStatement`, `lockWallet`. Contribution = DR `SYS:PROVIDER_CLEARING:<RAIL>` / CR `W:COMMUNITY` (+ CR `SYS:FEES`); payout = `reserve` → (approvals) → `post({kind:'PAYOUT', reservationId})` DR wallet / CR `SYS:PAYOUT_CLEARING:<RAIL>`; failed request ⇒ `release`.
- P07/P09: wrap `reserve/release/placeHold/releaseHold/reverse` and ADJUSTMENT posts in bus commands (matrix actions + maker-checker for `ledger.adjust`, hold release). The ledger checks books, not people.
- Ledger tests: `@chema/ledger/testing` (`inTx`, `seedSystem`, `seedWallet`, `creditWallet`). `inTx` bypasses the bus — tests only. Model-based property suite: `ledger.property.test.ts` (fast-check, 100 runs × ≤40 ops). For real concurrency: `docker compose up -d postgres` then `CHEMA_TEST_DATABASE_URL=postgres://chema:change-me@localhost:55432/chema pnpm vitest run packages/ledger`; `realPgTestDb()` in `@chema/shared/testing` creates + drops a throwaway database.
- Ledger SQL: never `UPDATE`/`DELETE` ledger rows; corrections are `reverse()` or a new journal. Insert all entries of a journal in one statement or the seal trigger rejects them.
- New migrations: `db/migrations/NNNN_snake.sql`, contiguous numbers (next = 0011); never edit an applied file (checksum fails hard). `.gitattributes` forces LF.
- Vitest capped at 2 workers (RAM). pino `formatters.log` runs before serializers: never deep-walk class instances there.
- Ports: api 7600, postgres 55432, redis 56379.
- Payments (P03): channels call `PaymentService` (`@chema/payments`) only: `listRails`, `initiate`, `view`, `receipt`, `receiveWebhook`, `processEvent` (worker), `pollDue` (worker loop), `requestRefund`, `runRecon`, `listExceptions`, `balances` (fills `pending`). Tests: `createPaymentsHarness(flags, {db?})` from `@chema/payments/testing` (mock rails on the harness clock, `t.newWallet()` opens the gate, `t.deliver(rail)` = webhook + worker).
- P07 owns: dispute/case workflow on `case_record` (stub), exception resolution + hold release with maker-checker, refunds of partly spent wallets (D11), payouts via `adapter.payout` (interface only so far).
- Mock rails (`@chema/providers`): `MockRail.scenario` switches + driver methods `succeed/fail/expire/openDispute/chargeback/winDispute/addSettlementRow/takeWebhooks`. Callbacks are signed when due, so advancing the clock past the window makes queued ones stale.
- Wallet (P04): `walletCommands(deps)` from `@chema/wallet` = `createDraft view addEvidence submit appeal assign queue decide suspend unsuspend report reviewFlag`. Public reads (no bus): `publicWalletView`, `publicWalletQr`, `loadPublicWallet` (404 unless ACTIVE). Gate: `verifiedWalletGate`. Tests: `createWalletHarness()` from `@chema/wallet/testing` (`t.draft`, `t.fullEvidence`, `t.verifier`, `t.assignVerifier`, `t.activeWallet()` → ACTIVE wallet + slug; `ALL_PASS` checklist).
- Any new table with `wallet_id` needs an FK to `wallet(id)`. Tests below the wallet package create the row with `insertTestWallet(q, id)`.
- P05 builds on: `/public/wallets/:slug` (extend the view under `wallet.privacy`), the `/w/:slug` page in apps/web (share links already point there), photo + consent, tribute wall. Contributions already pass the gate for ACTIVE wallets.
- P06: `fidelity_link` table exists (stub: policy_no/national_id, route_status UNSET, claim_status_mirror NONE), one row per wallet. Verification never reads it; keep it that way.
- P07: wallet ACTIVE → CLOSING → CLOSED transitions exist in `wallet_guard` but have no command yet. A mandate is approved with the case (`mandate.approved_at`): "no mandate ⇒ no payouts" should check it. `wallet.replace_admin` will need a migration, because `admin_person` is immutable in `wallet_guard`.
- P08/P09: wallet outbox topics (`WALLET_TOPICS`) are logged-only in the worker. Real notifications, the fraud-case workflow and the report queue UI come later. A REVIEWER_IS_PARTY denial is not audited (thrown in the handler); P10 could move it into a resolve-time subject field.
- Web: `pnpm --filter @chema/web dev` (port 3000). Login cannot complete against the running API (OTP is a mock), so the screens are exercised by `next build` + API tests.
- Next migration = 0013.
