# P05 Public page + contribution journey
**Load:** docs/06-contribution-public.md, docs/04-ledger-payments.md §3 §6 (state + fees only), docs/14-test-plan.md §S (privacy rows) + §A items 10,11,13
**Goal:** a contributor can open the link and contribute in ~30 s with receipt.

## Do
1. Public page (Next.js, SSR, low-bandwidth, mobile-first, large text): fields per doc 06, privacy toggles honoured server-side (never ship hidden data to client).
2. Live total (SSE or polling) derived from ledger.
3. Contribute flow: amount, name/Anonymous, tribute, contact for receipt, pre-payment disclosure, enabled-rail picker, redirect/prompt to provider, pending state UI.
4. Contribution entity ↔ payment; on SUCCEEDED event: receipt generation, tribute visibility (privacy + moderation), family notification event (respects anonymity/privacy).
5. Receipt: signed link + lookup by contributor for own txn; reissue.
6. Tribute wall + ModerationRules (flag→HIDDEN pending review) + deletion/suppression request.
7. Family privacy settings screen (toggles from doc 06).
8. Group contribution behind `feature.group_contributions` (off).
9. Message catalogue for all copy; dignity rules (no pressure, no ranking, no anchoring amounts).
10. Notification service skeleton: template + queue + retry + status; channels: web/email/SMS mock (WhatsApp in P08).

## Done when
Contribute → receipt works on mock rail end-to-end; anonymous hides public display but audit retains; IDOR tests on receipt/contribution pass.
