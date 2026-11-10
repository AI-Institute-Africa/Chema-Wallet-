# P00 Bootstrap
**Load:** docs/13-decisions-flags.md (flags + kill switches only)
**Goal:** runnable monorepo skeleton + config/flag system.

## Do
1. Init monorepo per CLAUDE.md layout (pnpm workspaces), TS strict, ESLint, Vitest, Docker Compose (postgres, redis).
2. SQL migration runner (plain `.sql`, ordered, checksum-verified).
3. Typed config + feature-flag service: all keys in docs/13 defined with SAFEST defaults; flag reads from DB table `config_flag` + env override; changes write audit stub (full audit in P01).
4. Money type (`Money {minor:int, ccy}`), no floats anywhere; lint rule/test banning `number` for amounts.
5. Fastify app with `/health`, structured logging w/ PII masking, request-id.
6. CI script: typecheck, lint, test, secret scan.
7. i18n message catalogue scaffold (en).

## Done when
`pnpm test` green; `docker compose up` serves /health; flags default to disabled; README has run commands (keep README < 40 lines).
