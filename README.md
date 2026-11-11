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
cp .env.example .env    # then set CHEMA_AUTH_SECRET / CHEMA_DATA_KEY (openssl rand -base64 32)
docker compose up -d --build   # postgres:55432, redis:56379, api:7600, worker
curl localhost:7600/health     # liveness; /health/ready checks the DB
pnpm db:migrate         # apply db/migrations to $DATABASE_URL
pnpm audit:verify       # check the audit_log hash chain in $DATABASE_URL
pnpm dev:worker         # outbox relay + job worker (needs REDIS_URL)
pnpm staff:enroll --login admin.one --role FIDELITY_ADMIN   # bootstrap staff (prints password + TOTP secret once)
pnpm dev:admin          # staff portal on :3001
docker compose down
```

## Layout
`apps/api` Fastify API · `apps/web` public PWA · `apps/admin` staff portal (P09) · `runbooks/` ops procedures ·
`packages/shared` Money, db + migrator, log masking, i18n ·
`packages/core` identity, authz matrix, command bus, approvals, audit chain, consent, documents, outbox, flags · `packages/ledger|payments|providers|channels|contributions|wallet|fidelity|payouts|whatsapp|ops` ·
`db/migrations` plain SQL, checksum-verified · `tools/eslint-plugin-chema` invariant lint rules.

## Safety defaults
Every flag in `packages/core/src/flags/registry.ts` defaults to disabled/unset.
`live_funds.enabled=false`: no real money. Financial flags change only through a
maker-checker approval. `commissions.enabled` is locked off.
