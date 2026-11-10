# 11 AI & automation limits

AI is an assistive layer, NOT a launch dependency. MVP = deterministic rules + human review. Every AI feature sits behind a flag (`ai.<name>`, default OFF) and an interface with a rules-based/no-op implementation.

| Feature | May do | Must NOT |
|---|---|---|
| OCR/extraction | extract fields from certificates/ID; flag mismatches/missing | verify death alone; establish cover; decline claims |
| Fraud/anomaly flags | flag duplicate wallets, reused evidence, velocity, odd payout patterns | block wallets / adverse action without human decision + written reason |
| Claim triage | prioritise queue; suggest straight-through vs manual | decide outcome (only Fidelity-approved deterministic rules or authorised officers) |
| Assistant (WhatsApp/web) | explain approved process, answer approved FAQs, retrieve authorised status, guide forms | invent policy terms/balances/payment status; promise approval; disclose private data; change beneficiary; release funds |
| Tribute moderation | flag spam/abusive → hidden pending review | permanently remove without appeal path |
| Insights/target suggestion | suggest realistic target from cost data (later) | pressure contributors |

Governance: record purpose, data provenance, model/version, intended/prohibited use, accuracy + failure-mode tests, drift/false-positive monitoring, human override + reason, audit. Permissions enforced in core services, never in prompts. Fallback to human when uncertain/distressed/complaint/fraud.

MVP build: implement `FraudRules` (deterministic duplicate/velocity rules), `ModerationRules` (keyword/rate), FAQ retrieval over approved static content. OCR + LLM assistant = interface stubs only.
