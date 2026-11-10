# 09 WhatsApp channel

WhatsApp = interaction channel only. Same core services/permissions/ledger as web/admin. Not a wallet, DB, payment system or system of record.

## Platform
Official WhatsApp Business Platform only (Fidelity-owned account or approved BSP; D16). No WhatsApp Web automation / personal accounts. Verify current Meta rules (opt-in, templates, 24h service window) at build time — don't hard-code assumptions. Build behind `ChannelProvider` interface; local simulator for dev/tests.

## Pipeline
webhook → verify signature + replay → store raw (idempotent by message id) → queue → resolve session (consent, identity binding, role) → orchestrator → core API → response/secure link → delivery status tracking (retry, dead-letter) → reconcile message events vs business txns.

## Orchestrator
Manages intent, session state, language, menus, validation, hand-off. Deterministic state machine drives all state changes; AI (optional) may interpret free text/answer approved FAQs, then ROUTES — core service re-validates identity, authority, rules, state, approvals before commit. Minimum conversation memory; no sensitive data echoed into shared/forwarded context. Fallbacks for: misunderstood message, integration down, expired session, failed verification, human escalation (preserve conversation ref). Detect distress/complaint/fraud → offer human.

## Identity & security
- Bind phone→identity only after approved verification. Phone number alone ≠ identity/authority.
- Step-up (OTP/secure portal/device re-verify/dual approval) for sensitive actions.
- Secure web hand-off: short-lived, SINGLE-USE reference; no reusable tokens in chat; transaction context preserved.
- Never ask/store PINs, passwords, card data, OTPs in ordinary chat.
- Mask PII/policy/claim/financial data in messages; return minimum needed; same privacy settings as web.
- Rate limits, abuse detection, session expiry, immutable audit per action.
- User must not reach another's data by changing phone, wording or reference (test this).
- Uploads: malware scan, encrypted, access-controlled, linked to case.

## Service catalogue (completion: chat or secure hand-off)
**Family/admin**: create draft; link policy; submit evidence; invite/replace approvers (step-up+dual); view permitted totals/statements; review contributions; request/track payouts (step-up; approval in secure flow); claim updates; missing info; raise dispute; close wallet; send thanks.
**Contributor**: find/verify wallet; view public info; contribute (→ provider checkout); tribute; receipt; own status; public total; report suspicious wallet; get help.
**Fidelity officer (low-risk only)**: assigned-case alerts; permitted summaries; verification status; request evidence; case notes; escalate fraud; operational summaries. **Portal-only**: claim decisions, financial release, ledger adjustments, privileged access, overrides (unless a separate control assessment approves).
**Agent/partner**: assisted wallet journeys, assigned task notifications; no self-approval.

## Notifications (event-driven; disclose only what recipient may see)
wallet verified/rejected · contribution received (to family) · receipt (to contributor) · target reached · claim milestones · payout status · dispute · recon exception (ops) · closure/thanks. Templates registered/approved (D16); localisable. Delivery failure ⇒ queue retry; NEVER alters transaction state; fallback SMS/web/assisted.

## Outage
WhatsApp down ⇒ web + portal still fully work; SMS fallback for receipts/OTP (flag `channel.sms`).
