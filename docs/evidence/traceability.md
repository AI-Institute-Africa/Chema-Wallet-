# Traceability: requirement → test → status

Source: `docs/14-test-plan.md` §V §P §L §C §G §S §O §A, plus the P10 hardening items. Everything here runs on mocks (mock rails, MockFidelity, the WhatsApp simulator, mock OTP), with PGlite in `pnpm test`. Concurrency and recovery suites also run on real PostgreSQL 16 when `CHEMA_TEST_DATABASE_URL` is set.

Status values:
- **PASS**: a test asserts the scenario and is green in `pnpm test`.
- **PASS (gap noted)**: green, with a related product gap logged in PROGRESS.md "Known gaps".

Paths are relative to the repo root. Test names are the `describe › it` strings, shortened.

Abbreviations:

| Short | File |
|---|---|
| WV | packages/wallet/src/verification.test.ts |
| PAY | packages/payments/src/payments.test.ts |
| PCONC | packages/payments/src/concurrency.test.ts |
| RECON | packages/payments/src/recon.test.ts |
| LED | packages/ledger/src/ledger.test.ts |
| LSCH | packages/ledger/src/schema.test.ts |
| LPROP | packages/ledger/src/ledger.property.test.ts |
| LCONC | packages/ledger/src/concurrency.test.ts |
| PO | packages/payouts/src/payouts.test.ts |
| CHAOS | packages/payouts/src/chaos.test.ts |
| CL | packages/fidelity/src/claims.test.ts |
| CT | packages/contributions/src/contributions.test.ts |
| MX | packages/core/src/authz/matrix.test.ts |
| GOV | packages/core/src/command/governance.test.ts |
| ID | packages/core/src/identity/identity.test.ts |
| DOC | packages/core/src/documents/documents.test.ts |
| WA | packages/whatsapp/src/whatsapp.test.ts |
| OPS | packages/ops/src/ops.test.ts |
| ACC | packages/ops/src/acceptance.test.ts (P10) |
| SEC | apps/api/src/security.test.ts (P10) |
| ROUTES | apps/api/src/*-routes.test.ts |

## §V Verification

| ID | Scenario | Test | Status |
|---|---|---|---|
| V1 | missing evidence | WV `§V missing evidence › refuses submission and names what is missing` | PASS |
| V2 | approved evidence (any configured type) | WV `§V approved evidence › %s + ID + mandate activates the wallet` (3 types); `only counts the types the config accepts (D05)` | PASS |
| V3 | identity mismatch | WV `§V identity mismatch › rejects with a reason code and leaves no slug, QR or badge` | PASS |
| V4 | duplicate certificate | WV `§V duplicate certificate › flags the second wallet for review…`; `flags the identical certificate file reused on another wallet` | PASS |
| V5 | community-only wallet | WV `§V community-only wallet › activates with no Fidelity policy at all` | PASS |
| V6 | agent-assisted creation | WV `§V agent-assisted creation › agent drafts + uploads…; agent cannot decide`; ACC `§G G5` | PASS |
| V7 | rejection + appeal | WV `§V rejection + appeal › rejected → appeal → a different reviewer approves`; `only the wallet admin may appeal` | PASS |
| V8 | pending/rejected shows no badge | WV `§V pending/rejected shows no badge › draft and pending wallets have no slug, QR, share text or badge` | PASS |
| V9 | draft not publicly reachable (404) | WV `§V draft not publicly reachable (404)`; ROUTES wallet-routes `…404 on every public endpoint`; contribution-routes `unknown, malformed and unverified slugs are the same 404` | PASS |
| V10 | verifier ≠ creator | WV `§V verifier ≠ creator` (2 tests, handler + DB); MX `verifier cannot decide a case they created` | PASS |

## §P Payments (mock rails)

| ID | Scenario | Test | Status |
|---|---|---|---|
| P1 | success | PAY `success: credited once on SUCCEEDED, pending until then, receipt issued` | PASS |
| P2 | timeout → pending_unknown → resolved by status query | PAY `timeout → pending_unknown → resolved by status query`; `…after 72h, stay unknown and are raised` | PASS |
| P3 | delayed callback | PAY `delayed callback: nothing until it arrives, then one credit` | PASS |
| P4 | duplicate callback (1 credit) | PAY `duplicate callback: one credit`; PCONC `the same event processed by many workers at once posts once` | PASS |
| P5 | replayed/forged webhook rejected | PAY `replayed / forged webhook rejected; nothing stored`; ROUTES payment-routes `webhook: forged ⇒ 401…replay ⇒ 200`; CHAOS stale redelivery refused | PASS |
| P6 | provider outage | PAY `provider outage: FAILED, no credit, a new attempt works once the provider is back` | PASS |
| P7 | partial settlement | PAY `partial settlement: credit stands, recon raises a variance with a hold on that payment only` | PASS |
| P8 | fee/FX variance | PAY `fee/FX variance: a provider fee different from the disclosed one is raised` | PASS |
| P9 | chargeback | PAY `chargeback: dispute holds only the disputed amount…`; `chargeback after the money is committed…never negative` | PASS |
| P10 | refund | PAY `refund: dual-approved…COMPLETED only on provider confirmation`; `refund refused by the provider: debit reversed` | PASS |
| P11 | wrong destination | PAY `wrong destination: money confirmed into another merchant account is not credited` | PASS |
| P12 | disabled rail absent from UI/API | PAY `disabled rail: absent from the list, 404 on initiate and webhook`; ROUTES payment-routes; ACC `§A 5` | PASS |
| P13 | receipt only on success | PAY `receipt only on success`; CT `a failed payment publishes nothing, issues no receipt` | PASS |
| P14 | receipt retrievable when notification fails | PAY `receipt retrievable when the notification fails`; CT `§A 10` | PASS |

## §L Ledger

| ID | Scenario | Test | Status |
|---|---|---|---|
| L1 | concurrent contributions | LCONC `parallel contributions all land, none lost`; PCONC `concurrent contributions to one wallet…`; load test (docs/evidence/load-test.md) | PASS |
| L2 | reversal nets original | LED `reverse › nets the original to zero and links to it`; LSCH `reversals › must mirror the original exactly…`; LCONC `parallel reversals … produce one reversal` | PASS |
| L3 | partial payout | LED `reserve → payout moves reserved to paid; partial payouts add up` | PASS |
| L4 | unmatched incoming → suspense + exception | RECON `unmatched incoming → suspense + exception (never credited to a wallet)` | PASS |
| L5 | tolerance breach → exception + proportionate hold | RECON `tolerance breach → exception + proportionate hold (not a blanket freeze)`; `zero tolerance when unset…` | PASS |
| L6 | manual adjustment needs maker-checker | OPS `ledger adjustment (maker-checker)…`; ROUTES admin-routes `adjusts the ledger only after a second ops person approves` | PASS |
| L7 | audit reconstruction of a wallet | LED `a wallet can be reconstructed from its statement`; OPS `audit explorer › reconstructs a wallet from audit + ledger…` | PASS |
| L8 | property tests (sum=0, no negative available, payout ≤ available, no cross-wallet) | LPROP `random operation sequences keep the books consistent with the model`; LSCH `refuses value moving across wallets`, `refuses a debit that would overdraw` | PASS |

## §C Claims / Fidelity (MockFidelity)

| ID | Scenario | Test | Status |
|---|---|---|---|
| C1 | no policy | CL `§C lookup outcomes` (it.each, NO_POLICY row); `no policy / covered-life mismatch cannot be linked` | PASS |
| C2 | inactive | CL `§C lookup outcomes` (INACTIVE row) | PASS |
| C3 | covered-life mismatch | CL `no policy / covered-life mismatch cannot be linked; the community path is untouched` | PASS |
| C4 | arrears | CL `§C lookup outcomes` (ARREARS row) | PASS |
| C5 | duplicate claim | CL `duplicate claim is surfaced from Fidelity, never overridden` | PASS |
| C6 | pending | CL `pending / in review: mirrored, nothing credited` | PASS |
| C7 | declined | CL `decline leaves community funds intact and still contributable` | PASS |
| C8 | approved | CL `approved + route approved + settled ⇒ credited once to W:FIDELITY_BENEFIT`; ROUTES fidelity-routes | PASS |
| C9 | beneficiary mismatch → route blocked | CL `§C beneficiary mismatch ⇒ route blocked` (3 tests incl. DB refusal) | PASS |
| C10 | benefit payment not settled | CL `benefit payment not settled ⇒ shown pending, never spendable` | PASS |
| C11 | claim decline leaves community funds intact | CL `decline leaves community funds intact and still contributable` | PASS |
| C12 | Fidelity down → queued/retried | CL `§C resilience › link while down…retries with backoff`; `missed callbacks are caught by the poller` | PASS |
| C13 | benefit never credited before route approved | CL `settled before route approval is NOT credited until the route is approved`; `the DB refuses…to credit early` | PASS |

## §G Governance

| ID | Scenario | Test | Status |
|---|---|---|---|
| G1 | single vs dual approval | PO `§G single vs dual approval` (2 tests); GOV `dual-approval rule: unset threshold ⇒ every payout is dual` | PASS |
| G2 | unavailable approver | PO `§G unavailable approver ⇒ escalation, never a bypass` (2 tests); MX `escalated approvals` | PASS |
| G3 | family dispute (hold + case) | PO `authority dispute holds community payouts, not the Fidelity benefit; release is dual`; `a disputed payout blocks only that payout` | PASS |
| G4 | admin replacement | PO `§G admin replacement (dual + verifier re-check)` (3 tests incl. DB refusal) | PASS |
| G5 | agent delegation + no self-approve | ACC `§G G5 › an assigned agent drafts, uploads, submits and links the claim…but is refused (and audited) as decider/checker`; MX `agents are never checkers`; GOV `an assigned agent cannot be the checker` | PASS |
| G6 | privileged staff access scoped | PO `privileged staff are scoped…`; OPS `scopes a verifier's queues to assigned wallets`; SEC `staff routes refuse customers, and staff without the right role` | PASS |
| G7 | dispute on community does not freeze Fidelity source | PO `authority dispute holds community payouts, not the Fidelity benefit`; LED `SOURCE hold freezes one sub-ledger` | PASS |

## §S Privacy / security

| ID | Scenario | Test | Status |
|---|---|---|---|
| S1 | anonymous contribution (public hidden, audit kept) | CT `anonymous: public + family see "Sympathetic Friend"; KYC and audit are kept`; ACC `§A 11` | PASS |
| S2 | photo consent withdrawal | CT `photo: needs consent + toggle; withdrawing consent hides it at once`; GOV `consent › grant → query → withdraw` | PASS |
| S3 | tribute removal | CT `removal erases the message only: payment, receipt and total stay` | PASS |
| S4 | IDOR on wallet/receipt/claim | SEC `IDOR sweep: another family's real ids` (every route with a wallet/payment/receipt/payout/document/approval/contribution/verification id, as a stranger and as another wallet's admin); CT `§S — IDOR on contribution / receipt / tribute`; MX `scope: case-level authorisation (IDOR)` | PASS |
| S5 | phone/reference tampering over WhatsApp | WA `§S WhatsApp security` (4 tests) | PASS |
| S6 | retention hold | DOC `retention holds` (3 tests) | PASS |
| S7 | API replay | CT `a replayed submission is the same contribution…`; PAY idempotency tests; ROUTES payment-routes `replay returns the same payment`; CHAOS stale webhook redelivery refused | PASS |
| S8 | account compromise / step-up | ACC `§S S8 › logout kills the token, the session and its unused step-up grant…`; `an unused step-up grant of a revoked session cannot be redeemed`; `sign out everywhere: the customer ends every own session (and their step-up grants); a Fidelity admin does it for a suspected compromise`; routes.test `POST /auth/sessions/revoke-all…`, `a staff session is bound to the device it logged in on…`; admin-routes.test `a Fidelity admin signs a suspected-compromised customer out everywhere…`; GOV `a step-up grant for wallet A does not unlock wallet B` | PASS |
| S9 | no PIN/OTP/card data in chat or logs | WA `never stores a PIN, OTP or card number typed in chat`; ROUTES routes `no secrets in logs`; SEC `log PII scan` | PASS |

## §O Operations

| ID | Scenario | Test | Status |
|---|---|---|---|
| O1 | notification failure (txn unaffected) | PO `notification failure never affects payout state`; WA `WhatsApp delivery failure leaves the ledger unchanged` | PASS |
| O2 | queue recovery after outage | PO `rail outage ⇒ retry queue recovers…`; outbox `queue failure keeps the event pending…`; CHAOS `outbox queue replay`, `payment worker killed after the webhook was stored` | PASS |
| O3 | channel outage fallback | WA `…falls back to SMS when allowed`; `orchestrator fallbacks › integration down ⇒ a fallback message` | PASS |
| O4 | recon ageing/escalation | PO `case and recon-exception ageing ⇒ escalation by the sweep` | PASS |
| O5 | emergency hold/release (dual) | PO `a hold placed after approval stops an unsubmitted payout; a wallet-wide hold needs a risk reason`; OPS `resolved only after its hold went through dual release` | PASS |
| O6 | final close + statement | PO `§O closure › …then closes with statements`; ACC `§A 12` | PASS |
| O7 | closure blocked with residual/pending/disputes | PO `closure blocked with residual (policy unset), pending payouts and open disputes`; `residual > 0 with the policy unset keeps the wallet open` | PASS |

## §A MVP acceptance (end to end, mocks, flags on)

| ID | Item | Test | Status |
|---|---|---|---|
| A1 | draft without badge; share + contribution blocked until verified | WV; CT `an unverified (draft) or suspended wallet takes no contribution`; ROUTES wallet-routes `end to end: draft → … → contributions` | PASS |
| A2 | community-only wallet works with no policy | WV `activates with no Fidelity policy at all`; CL community path untouched | PASS |
| A3 | claim state and community funding distinct | CL `decline leaves community funds intact`; LED `keeps community and benefit money apart` | PASS |
| A4 | beneficiary, claimant, admin, recipient separate; route blocked until approved | ACC `§A 4 › each role is granted by the flow that establishes it, as its own row; none is inferred…`; CLAIMS `re-linking a lodged claim to a different recipient is refused (audited)…`, `needs a written approval + maker-checker to unblock; then credits` (ROUTE_UNBLOCK ⇒ PAYOUT_RECIPIENT), `a blocked route grants no recipient or beneficiary role`; MATRIX `roles established by flows grant no authority` | PASS |
| A5 | only enabled rails; Bank/remittance/USSD/InnBucks absent everywhere | ACC `§A 5`; `scripts/scope-audit.test.ts` `the repository is clean`; PAY disabled rail | PASS |
| A6 | duplicate requests/webhooks never double-credit/pay | CT, PAY, PO, payouts concurrency, LCONC; CHAOS reverse-order + duplicates; load test (400 duplicate callbacks, 0 extra credits) | PASS |
| A7 | pending/failed/succeeded/reversed/refunded/charged-back distinct + auditable | ACC `§A 7 › drives one payment (or payout) into each state…` | PASS |
| A8 | recon exceptions owned + time-bound; small variance doesn't freeze all | OPS `is owned, and resolved only after…dual release`; PO ageing sweep; RECON `within tolerance…no hold`, `proportionate hold` | PASS |
| A9 | payouts ≤ eligible available; source restrictions/holds/approvals | PO `payout > available is refused…`; LED; LCONC `parallel reservations never exceed the balance`; PO benefit recipient | PASS |
| A10 | receipt retrievable if delivery fails | CT `§A 10`; PAY | PASS |
| A11 | privacy + anonymity consistent across pages, notifications, reports | ACC `§A 11 › an anonymous contributor's name and KYC name never leave the vault…` (page, tributes, WhatsApp, family view, 5 staff reports, audit timeline, every sent message, decrypted notification params) | PASS |
| A12 | refund, cancellation, dispute, excess funds, closure end to end | ACC `§A 12` (2 tests, one wallet story + cancellation) | PASS |
| A13 | total + receipt < 30 s without the family; initiation < 5 s | ACC `§A 13`; CT guest flow `< 5_000` ms; load test p99 initiation (docs/evidence/load-test.md) | PASS |
| A14 | fake/unverified wallet cannot be publicly shared | WV `a draft, pending or rejected wallet has no slug…`; ROUTES `unverified slugs are the same 404`; `…404 on every public endpoint` | PASS |

## P10 hardening items

| Item | Evidence | Status |
|---|---|---|
| Load/burst to plan baseline | `apps/api/src/load-test.ts`; results in docs/evidence/load-test.md | PASS |
| Chaos: worker killed mid-payment / mid-payout | CHAOS `payout worker killed mid provider call`, `payment worker killed after the webhook was stored` | PASS |
| Chaos: duplicate / out-of-order webhooks | CHAOS `out-of-order provider callbacks` (2 tests); PCONC | PASS |
| Chaos: queue replay | CHAOS `outbox queue replay` | PASS |
| DB backup/restore | `scripts/restore-drill.sh` run 2026-11-11 (docs/evidence/security-and-resilience.md) | PASS (local drill; production failover not tested) |
| Dependency + secret scan | `pnpm dep-audit` (runtime deps: 0 known), CI `pnpm audit --audit-level high`, `pnpm secret-scan` | PASS |
| Authz fuzz on all endpoints | SEC `authorisation fuzz: every registered route` (4 tests) | PASS |
| IDOR sweep | SEC `IDOR sweep` | PASS |
| Rate limits | SEC `rate limits` (4 tests) | PASS |
| Headers / CSP | SEC `response headers`; web/admin `next.config.ts` | PASS |
| Log PII scan | SEC `log PII scan` | PASS |
| Scope audit | `scripts/scope-audit.test.ts`, `pnpm scope-audit` in `pnpm verify` | PASS |
| Flag audit + kill switches + live gate | docs/evidence/flag-audit.md; `packages/payments/src/pilot.test.ts`; `packages/payouts/src/killswitch.test.ts`; `packages/core/src/flags/flags.test.ts`; RECON LIVE adapter refused | PASS |

## UI redesign (2026-11-11)

| Item | Evidence | Status |
|---|---|---|
| Admin-only, audited target edit | `packages/wallet/src/target.test.ts` (3 tests); `apps/api/src/wallet-routes.test.ts` `PUT /wallets/:id/target…`; `packages/core/src/authz/matrix.test.ts` (EXPECTED row) | PASS |
| Policy number is opt-in (`showPolicyNumber`, default off) | `packages/contributions/src/policy.test.ts` | PASS |
| Chips never reach the API payload; no ranking/countdown keys | `packages/contributions/src/contributions.test.ts` `only enabled rails; the page offers no suggested or ranked amounts` (unchanged); `apps/web/src/lib/memorial.test.ts` | PASS (docs/06 "no suggested amounts" overridden for the UI by product decision, see PROGRESS) |
| Public and owner see the same memorial | `tools/e2e/tests/memorial.spec.ts` `the family admin sees the same memorial page…` | PASS (mocked API) |
| No card fields; card is a provider redirect | memorial.spec `public memorial page…no card fields` | PASS |
| Theme toggle persists; pre-paint script carries the nonce | memorial.spec `theme: toggle switches light/dark…` | PASS |
| Draft preview is private and cannot take contributions | memorial.spec `draft wallet: private preview…` | PASS |

## Transactions (2026-11-25)

| Item | Evidence | Status |
|---|---|---|
| Family statement: contributions with real names (anonymity flagged), payouts with purpose/note/payee (masked), provider reversal linked, refund linked, pending items, running balance = ledger | `packages/payouts/src/transactions.test.ts` › `lists contributions (real names, anonymity flagged)…` | PASS |
| Paging newest first by journal seq | same file › `pages newest first by journal seq` | PASS |
| Fidelity benefit kept as its own source | same file › `keeps the Fidelity benefit as its own source` | PASS |
| Who may read (admin/approver yes; stranger, unassigned agent, guest no; denials audited) | same file › `who may read…` | PASS |
| CSV export: one row per line, signed minor-unit amounts, formula neutralising | same file › `CSV export…`; `apps/api/src/contribution-routes.test.ts` › `family transactions over HTTP` | PASS |
| PayoutView carries note + payee label + masked number | same file › `a payout view now carries…` | PASS |
| Public usage list: purpose, amount, date only; hidden unless usage summary is on | same file › `public usage: where the money went` | PASS |
| UI: statement page, filters, details, CSV download, nav, owner recent activity, public section | `tools/e2e/tests/transactions.spec.ts`; `memorial.spec.ts` (usage + recent activity); `apps/web/src/lib/transactions.test.ts` | PASS |

