# 01 Verification: reject and appeal

**Queue:** Verification (assigned cases only). **Who:** community verifier. A Fidelity admin assigns cases.

## Decide a case
1. Open the case. Check the evidence and every checklist item: death evidence, admin identity, mandate shows authority, details consistent, fraud flags reviewed.
2. **Approve** only when every item passes. Approval publishes the page, link and QR. The verified badge is not policy cover and not claim approval.
3. **More info**: pick a reason code and write what is missing. The family sees the reason and can add evidence.
4. **Reject**: pick a reason code and write notes. Use `DUPLICATE_WALLET` when a matching wallet exists.
5. You cannot decide a case you created or one where you hold a family role. The API refuses it (`OWN_CASE`). Ask a Fidelity admin to reassign it.

## Duplicate / fraud flags
- A `DUPLICATE_DECEASED` or other flag holds approval until a human reviews it in **Fraud flags**. Dismiss or confirm it with a note.
- Confirmed fraud: see runbook 05. Do not approve.

## Appeal
1. Only the wallet admin can appeal a rejection. The appeal creates a new case linked to the old one.
2. Give the appeal to a **different** verifier. Do not use the one who rejected it.
3. Decide it the same way. Each case keeps its outcome; nothing is overwritten.

## SLA
`verification.sla_hours` is unset by default, so the UI promises no SLA (D05). Work the oldest case first.
