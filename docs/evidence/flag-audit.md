# Flag audit (P10)

Registry: `packages/core/src/flags/registry.ts`. Precedence is env > db > default. Financial flags change only through a dual-approved `config.change`, and `commissions.enabled` is locked off.

The registry tests check the defaults themselves (`packages/core/src/flags/flags.test.ts`):
- every boolean defaults to `false`;
- every threshold, policy and limit defaults to unset (`null`);
- `i18n.enabled_locales` defaults to `['en']`;
- a fresh database resolves every flag to its default.

The table below covers what each flag does at its default, where the code reads it, and how it is tested. "No code path" means there is no feature that could act on the flag. The safe default then holds because nothing can switch the behaviour on, and the flag only reserves the decision for when it is made.

| Key | Default | Behaviour at default | Enforced in | Test |
|---|---|---|---|---|
| live_funds.enabled | false | LIVE adapters refuse to register; a LIVE rail is never collectable | payments/src/rails.ts | recon.test `a LIVE adapter refuses to initialise…`; pilot.test |
| pilot.enabled, pilot.max_wallets, pilot.max_amount_minor | false / unset | No LIVE traffic, even with live funds on. When all are set: one contribution ≤ amount cap, and at most N wallets on live rails | payments/src/rails.ts `liveAllowed`, payments/src/collect.ts `enforcePilotCaps` (added P10) | pilot.test (7 tests) |
| contributions.enabled | false | Every contribution refused | payments/src/collect.ts, contributions/src/public.ts | PAY `contributions kill switch` |
| payouts.enabled | false | Every payout refused (PAYOUTS_DISABLED); a manual override is outside the rail and still dual-approved | payouts/src/payouts.ts, store.ts | killswitch.test (added P10) |
| fees.enabled | false | No fee, no fee copy | payments/src/fees.ts | PAY `fees: with a schedule and fees.enabled…`; scope-audit (no hard-coded fees) |
| commissions.enabled | false, locked | Can never be turned on | registry `locked` | flags.test |
| marketing.enabled | false | Off | no code path (no marketing feature exists) | — |
| rail.ecocash / rail.onemoney / rail.card | false | Rail absent from lists; 404 on initiate and webhook | payments/src/rails.ts | PAY `disabled rail…`; ACC `§A 5` |
| channel.whatsapp | false | Local simulator only; Meta stub not wired | apps/api/src/whatsapp.ts | whatsapp-routes.test |
| channel.sms | false | No SMS sends | apps/api/src/contributions.ts | CT `SMS down: notification retries then DEAD…` |
| fidelity.claims_link | false | Claim routes answer 404 | fidelity/src/service.ts, commands.ts, apps/api/src/worker.ts | fidelity-routes.test `flag off ⇒ claim routes 404` |
| feature.group_contributions | false | Group contributions refused | contributions/src/commands.ts, public.ts | CT `group contributions are off by default` |
| settlement.direct_parlour | false | Manual payee only | no code path (direct settlement not built) | — |
| data.cross_border | false | Off | no code path (no cross-border transfer exists) | — |
| approvals.payout_high_value_minor | unset | Every payout dual-approved | core approvals `requiresDual` | GOV, PO `§G single vs dual approval` |
| kyc.contributor_light_max_minor | unset | Phone + name always required | contributions/src/commands.ts | CT `light KYC: name + phone always required…` |
| contribution.min_minor.* / max_minor.* | unset | Any positive amount / currency refused without a maximum | contributions | CT `gates and limits` |
| claims.auto_approve_limit_minor | unset | All claims manual (Fidelity decides) | no code path (Chema never approves a claim) | — |
| verification.evidence_types | 3 types | Only the configured types count | wallet verification | WV `only counts the types the config accepts (D05)` |
| verification.sla_hours | unset | No SLA promised: `dueBy` is null in the wallet view (`latestCase`) and the verifier queue; set ⇒ due-by = submittedAt + hours and `overdue` in the queue (nothing escalates automatically) | wallet/src/commands.ts `verificationDueBy` (added gaps tranche) | VER `verification.sla_hours: unset ⇒ no due-by promised; set ⇒ due-by…` |
| security.bind_customer_device | false | Customer sessions are not device-bound (staff sessions always are); on ⇒ a customer session that recorded a device at login is refused (401, audited DEVICE_MISMATCH) from any other device | core/src/identity/auth.ts `authenticate` | routes.test `customer sessions are device-bound only with security.bind_customer_device on` |
| recon.exception_sla_hours.{high,medium,low} | unset | Built-in 24 / 72 / 168 h (the shipped constants; shorter = earlier escalation); set ⇒ the sweep ages un-escalated exceptions by opened_at + hours and sets each new window to the configured hours. Values below 1 count as 1 | payments/src/exceptions.ts `exceptionSlaHours`, payouts/src/governance.ts sweep | PO `§O SLA thresholds from config › a configured exception SLA ages recon exceptions…` |
| case.sla_hours.{chargeback,refund,recon,fraud,beneficiary_mismatch,authority_dispute,payment_dispute,provider_dispute} | unset | Built-in hours = the SQL `case_sla_hours()` table (168/120/72/24/168/72/72/168); set ⇒ open un-escalated cases are re-based and escalations use the configured window | payments/src/exceptions.ts `caseSlaHours`, payouts/src/governance.ts sweep + manual escalation | PO `§O SLA thresholds from config` (defaults equal the DB function; re-base; next window) |
| fraud.velocity_max_drafts_24h | unset ⇒ 3 | Review flag only, never an adverse action | wallet | WV `same admin phone across different deaths, and creator velocity` |
| recon.tolerance.<rail>.<ccy> | unset | Zero tolerance: an exception plus a TXN hold, never a blanket freeze | payments recon | RECON `zero tolerance when unset…` |
| closure.excess_funds_policy | unset | Closure blocked while residual > 0 | payouts/src/closure.ts | PO `residual > 0 with the policy unset…`; ACC `§A 12` |
| refund.policy | unset | Every refund is a manual, dual-approved case | no auto-refund path exists | PAY `refund: dual-approved…`; PO `cancellation…nothing refunded automatically` |
| retention.financial_years | unset | Retain; never auto-delete | no auto-delete path exists (documents: soft delete + purge only after a manual delete with no hold) | DOC retention holds |
| i18n.enabled_locales | ['en'] | English only | shared i18n | packages/shared/src/i18n/i18n.test.ts; flags.test `only English is enabled by default` |
| ai.* (6 keys) | false | No AI features | no code path (no model integrations exist) | — |

## Kill switches work at runtime

- A rail toggled off through the dual-approved portal flag change disappears from every surface at once (ACC `§A 5`).
- `collectable()` re-reads `live_funds.enabled` and the pilot flags on every collection. Turning either off stops live money mid-flight, while in-flight polling and recon keep running (`rails.ts` header).
- `payouts.enabled` is checked again at submission (`store.ts`). A switch flipped after approval stops unsubmitted payouts.
