# 06 WhatsApp outage, human hand-off, after-hours

**Queues:** Support hand-offs, Failures. **Who:** ops/finance, claims officer, Fidelity admin.

## WhatsApp outage
- WhatsApp is a channel, not the system of record. An outage never changes a transaction or a balance.
- Failed sends show in **Failures** (WhatsApp `FAILED` / `IGNORED`, dead notifications). Families can use the web app. The receipt link still works.
- The real provider is behind `channel.whatsapp` (D16). Off means the simulator only.

## Human hand-off
1. A hand-off opens when the person asks for one, after repeated misunderstandings, on distress, complaint or fraud words, or when an integration is down. They receive a reference `WA-XXXXXXXX`.
2. Support hand-offs lists open ones with the reason, whether the person is signed in, and the wallets where they hold a role. Message bodies are not shown.
3. Contact the person. Use the reference so they know the call is genuine. Never ask for a PIN, password, OTP or card number.
4. Anything high-risk (claim decisions, releasing funds, adjustments, overrides) happens in this portal, never in chat.
5. **Close** it with a written note of the outcome. Closed is final. If they need more help, a new hand-off opens.

## After-hours / weekends
- D20 is not decided, so there is no staffed after-hours cover. Hand-offs wait in the queue. Work them oldest first the next working period. The median close time is on Reports → Management.
- No money decision is taken out of hours by one person. Dual-approval items wait for two people (runbook 02).
