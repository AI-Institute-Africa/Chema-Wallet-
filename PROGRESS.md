# PROGRESS

## Status
| Phase | State | Date |
|---|---|---|
| P00 bootstrap | done | 2026-11-10 |
| P01 identity/audit/consent | done | 2026-11-10 |
| P02 ledger | todo | |
| P03 payments | todo | |
| P04 wallet + verification | todo | |
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

## Gotchas / handoff to next phase
- New state change = a `Command {name, resolve, run}` run through `core.bus.execute`. Add its action to `ACTIONS` + `MATRIX` (`packages/core/src/authz/matrix.ts`) AND to the independent `EXPECTED` table in `matrix.test.ts` (the test fails if either is missing). Step-up actions: `STEP_UP_ACTIONS`; maker→checker pairs: `CHECKER_ACTION`.
- Maker-checker: in the maker command call `createApproval(tx, actor, {action, subject…, payload})`; the checker runs `decideApproval`; the maker then executes with `consumeApproval(tx, actor, id, {…same payload})`. `requiresDual(action, amount, threshold)` says whether a checker is needed. Escalation for an unavailable approver is NOT built (P07).
- Inside a bus handler/transaction never touch `db` directly or call a service that does (PGlite has one connection ⇒ deadlock; pg would read outside the tx). Use the `tx`, e.g. `flags.getIn(tx, key)`.
- SQL trap: `SELECT seq::text AS seq … ORDER BY seq` sorts as TEXT ('10' < '2'). Qualify the column (`ORDER BY audit_log.seq`). This was a real bug here.
- P04 must add FKs to `wallet(id)` on `wallet_role.wallet_id`, `staff_assignment.wallet_id`, `approval.wallet_id`, `consent_record.wallet_id`, `document.linked_wallet`, and create the `wallet_role ADMIN` row inside the create-draft command.
- Not built yet: bus commands for role admin (`role.admin`: grant/revoke `wallet_role`, `staff_assignment`, staff enrol/disable) and for applying a flag change. `StaffAuthService.enroll` and `FlagService.set` are callable only from code/tests (no HTTP route, no seed CLI). P09 wraps them.
- Audit: `pnpm audit:verify` (exit 1 + first bad seq). Detects edits, deletions, forks; truncating the NEWEST rows needs an externally anchored chain head (P09/P10).
- Tests: `createHarness()` from `@chema/core/testing` = PGlite + real services + mock OTP/blobs + controllable clock (`h.customer()`, `h.staff(role)`, `h.grantRole`, `h.assign`, `h.advance(ms)`).
- Outbox: `enqueueOutbox(tx, topic, payload)` in the producer's tx; topics so far `document.scan`, `document.purge`; handlers live in `apps/api/src/worker.ts` (`pnpm dev:worker`, compose service `worker`) and must be idempotent. The BullMQ test only runs with `REDIS_URL` set.
- `auth_session.device_ref` is stored but device binding is not enforced; no general HTTP rate limiting beyond OTP/staff lockout (P10).
- New migrations: `db/migrations/NNNN_snake.sql`, contiguous numbers (next = 0007); never edit an applied file (checksum fails hard). `.gitattributes` forces LF.
- Vitest capped at 2 workers (RAM). pino `formatters.log` runs before serializers: never deep-walk class instances there.
- Ports: api 7600, postgres 55432, redis 56379.
