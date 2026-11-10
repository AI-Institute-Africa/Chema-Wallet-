# Chema Wallet

Funeral-support platform for Fidelity Life Assurance (Zimbabwe), by AI Institute Africa.
Build rules: [CLAUDE.md](CLAUDE.md) · spec index: [docs/00-INDEX.md](docs/00-INDEX.md) · status: [PROGRESS.md](PROGRESS.md)

## Requirements
Node 22+, pnpm 10 (`npm i -g pnpm@10.33.0`), Docker (only to run the stack; tests don't need it).

## Commands
```sh
pnpm install            # never `npm install` in this workspace
pnpm verify             # typecheck + lint + test + secret scan (what CI runs)
pnpm test               # vitest; Postgres via in-process PGlite
docker compose up -d --build   # postgres:55432, redis:56379, api:7600
curl localhost:7600/health     # liveness; /health/ready checks the DB
pnpm db:migrate         # apply db/migrations to $DATABASE_URL
docker compose down
```

## Layout
`apps/api` Fastify API · `apps/web`, `apps/admin` (later phases) ·
`packages/shared` Money, db + migrator, log masking, i18n ·
`packages/core` flags/config · `packages/ledger|providers|channels|fidelity` (later phases) ·
`db/migrations` plain SQL, checksum-verified · `tools/eslint-plugin-chema` invariant lint rules.

## Safety defaults
Every flag in `packages/core/src/flags/registry.ts` defaults to disabled/unset.
`live_funds.enabled=false`: no real money. Financial flags cannot be changed until
dual approval exists (P01/P09). `commissions.enabled` is locked off.
