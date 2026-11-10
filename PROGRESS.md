# PROGRESS

## Status
| Phase | State | Date |
|---|---|---|
| P00 bootstrap | done | 2026-11-10 |
| P01 identity/audit/consent | todo | |
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

## Assumptions (not in spec; safest default taken)
- Flag precedence: env `CHEMA_FLAG_<KEY>` > `config_flag` row > registry default. Env can enable financial flags (needed for mock rails in dev/test); DB writes cannot.
- Financial flags (`financial: true` in registry) are refused by `FlagService.set` (`DualApprovalRequiredError`, denial audited) until an approval service exists.
- `commissions.enabled` locked false from every source, including env.
- Keys added beyond docs/13 wording: `settlement.direct_parlour` (D17), `pilot.enabled` (D19 kill switch), `i18n.enabled_locales` (D15, default `['en']`), `ai.*` (docs/11), `recon.tolerance.<rail>.<usd|zwg>` (6 keys).
- `retention.financial_years` default unset ⇒ retain, never auto-delete (7y is planning only, D12).
- `verification.evidence_types` default = docs/05 list (any ONE + admin ID + mandate).
- Local Node is 24; Docker image and CI use Node 22.
- `apps/web`, `apps/admin` are placeholders; Next.js lands in P04/P05/P09.

## Gotchas / handoff to next phase
- P01: replace `AuditSink` stub (`packages/core/src/audit/sink.ts`) with hash-chained audit_log; event shape already matches docs/10 fields. Reuse SQL fn `deny_mutation()` (migration 0001) for append-only triggers.
- New migrations: `db/migrations/NNNN_snake.sql`, contiguous numbers; never edit an applied file (checksum fails hard). `.gitattributes` forces LF.
- Tests: `migratedTestDb()` from `@chema/shared/testing` = fresh PGlite with all migrations. Vitest capped at 2 workers (RAM).
- pino `formatters.log` runs before serializers: never deep-walk class instances there (it dropped `req.method/url`). req/res/err have masking serializers in `packages/shared/src/log/logger.ts`.
- Redis is in compose but unused until the outbox worker (P01).
- Ports: api 7600, postgres 55432, redis 56379.
