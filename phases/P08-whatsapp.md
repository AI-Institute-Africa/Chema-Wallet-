# P08 WhatsApp channel
**Load:** docs/09-whatsapp-channel.md, docs/02-roles-authority.md (step-up + agent rules), docs/11-ai-automation.md (Assistant row), docs/14-test-plan.md §S (WhatsApp rows)
**Goal:** WhatsApp as a thin channel over existing services. Simulator-backed; real provider behind `channel.whatsapp`.

## Do
1. `ChannelProvider` interface + local simulator (CLI/web test harness) + stub Meta Cloud API adapter (not enabled).
2. Webhook pipeline: signature, replay, raw store, idempotent by message id, queue.
3. Session/identity: phone→identity binding only after verification; role resolution; consent check; session expiry; rate limits.
4. Orchestrator: deterministic state machine for menus/forms; language preference; fallbacks (misunderstood, integration down, expired, failed verification, human escalation w/ conversation ref).
5. Catalogue per role (doc 09). Every action calls the SAME core command used by web/admin. NO logic duplication.
6. Secure hand-off: single-use short-lived links preserving context.
7. Contributor flow → provider checkout link; receipt retrieval; report suspicious wallet.
8. Officer low-risk actions only; portal-only actions return secure link.
9. Notification templates (placeholder registry; approvals D16), delivery-status tracking, retry, dead-letter; failures never alter txn state; SMS fallback flag.
10. FAQ retrieval from approved static content (no LLM required). LLM hook = interface stub only.
11. Masking + minimum-data responses.

## Tests
Tamper phone/reference ⇒ denied; duplicate webhook ⇒ one action; no PIN/OTP/card capture; delivery failure leaves ledger unchanged; WhatsApp-initiated and web-initiated contributions produce identical ledger entries.

## Done when
Simulator can run create-draft → contribute → receipt → payout-request-with-secure-handoff.
