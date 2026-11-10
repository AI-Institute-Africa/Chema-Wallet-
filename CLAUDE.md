# Chema Wallet — Claude Code build instructions

Funeral-support platform for Fidelity Life Assurance (Zimbabwe), by AI Institute Africa.
Friends/relatives/sympathisers contribute to ONE verified funeral case. An approved Fidelity funeral benefit can be linked to the same case. Channels: WhatsApp, responsive web/PWA, admin portal — all call the SAME core services.

## Context discipline (read first)
1. ONE phase per session. Start by reading: this file → `docs/00-INDEX.md` → `PROGRESS.md` → the `phases/Pxx-*.md` you were given.
2. Load ONLY the docs the phase file lists under **Load**. Never read all of `docs/`.
3. Don't paste spec text back into chat or code comments; reference by file (`see docs/04 §3`).
4. End of phase: run tests → update `PROGRESS.md` (done / decisions / assumptions / next) → commit → tell the user to `/clear`.
5. Spec silent or conflicting → check `docs/13-decisions-and-flags.md`. Build it as a config flag defaulting to the SAFEST option (disabled). Log it under "Assumptions" in PROGRESS.md. Never invent legal, regulatory, fee, custody or provider facts.

## Stack (ASSUMPTION — source docs don't specify; change here once, update PROGRESS.md)
TypeScript (Node 22), Fastify, PostgreSQL 16 (plain SQL migrations; no ORM on ledger paths), Redis + BullMQ (queues/retries), Zod (validation), Vitest, Next.js (public PWA + admin portal), Docker Compose for local. Money = integer minor units + ISO currency. Base currency USD; ZiG display/secondary.

## Non-negotiable invariants
- Channels hold NO business logic or money logic. WhatsApp is not the system of record.
- Money: double-entry ledger, append-only. Corrections = linked compensating entries. Never UPDATE/DELETE ledger or audit rows.
- Credit a wallet ONLY on validated authoritative provider confirmation, posted once (idempotency keys + signed/replay-protected webhooks). Pending/unknown is never spendable.
- Community, Fidelity-benefit and group money are SEPARATE sub-ledgers. "One wallet" is a family-facing VIEW, not commingling. Community funds never fund Fidelity/platform operations.
- Payout ≤ eligible available balance, respects source restrictions, holds, approvals.
- Public page/link/QR/contributions are blocked until community verification is approved. Verified badge ≠ policy cover ≠ claim approval.
- Community-only wallets work with no Fidelity policy; claim delay/decline never blocks community funds.
- Roles are distinct: policy beneficiary, claimant, wallet admin, family approver, agent, payout recipient. Never infer one from another. Agents cannot self-approve.
- AI assists only. Humans decide claim declines, wallet blocks, adverse actions. Money/state changes run in deterministic services that re-validate identity, authority, rules, state.
- Never collect PINs/passwords/OTPs/card data in chat. Payment happens in provider checkout.
- Anonymous = public display only; AML/audit data stays.
- No hard-coded fees, commissions, revenue share, marketing use of data. All behind disabled flags.
- Message delivery failure never affects transaction state.
- Every state-changing action writes audit: who, role, channel, session, action, ts, authz result, approval ref, txn ref.

## MVP scope guardrails
IN: draft wallet, community verification, verified page/link/QR, EcoCash+OneMoney (flag, mock until certified), card (flag), Fidelity link (flag), receipts, tribute wall, privacy, source-aware ledger, reconciliation, payouts w/ dual approval, disputes/refunds/closure, WhatsApp, admin portal.
OUT (do not expose in UI, journeys, tests, copy): Bank transfer, Mukuru/WorldRemit, USSD, InnBucks, parlour auto-settlement, registrar API, advanced AI/fraud models, pre-need wallets.
Real provider adapters stay behind flags; build interface + sandbox/mock adapters first.

## Layout
```
apps/api  apps/web  apps/admin  packages/core packages/ledger packages/providers packages/channels packages/fidelity packages/shared
docs/  phases/  PROGRESS.md
```
