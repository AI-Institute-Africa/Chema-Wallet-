# 02 Authority change, approver unavailable, dispute, emergency hold release

**Queues:** Cases, Holds register, Approvals. **Who:** ops/finance, Fidelity admin.

## Authority change / admin replacement
- The family requests it in the app (`mandate.change`) with step-up. A second family member approves it. A verifier then re-checks the evidence (`mandate.verify`).
- Staff never change an admin or approver directly. "Family" is not one person. The change must name who is authorised.
- If no other family checker exists, the request escalates to a Fidelity admin (see next section).

## Approver unavailable
- After 24 h, or at once when the wallet has no other admin/approver, the maker may **escalate** the approval. Payouts and payee changes escalate to ops/finance. Authority changes escalate to the Fidelity admin.
- In **Approvals**, the escalated item shows `escalatedTo`. You decide it as a distinct checker. Escalation is a route to a decision. It is not a bypass.

## Family dispute
1. Open a case (`AUTHORITY_DISPUTE` or `PAYMENT_DISPUTE`) from the wallet. Severity follows the risk.
2. Place a **SOURCE** hold on the disputed source only. A dispute about community money does not freeze the Fidelity benefit, and the reverse is also true.
3. A **WALLET** hold is only for documented fraud, legal or material risk (`FRAUD_RISK`, `LEGAL_RISK`, `MATERIAL_RISK`).
4. Every hold has a review date. The Holds register marks overdue holds. Review them; holds never lapse by themselves.

## Emergency hold release (dual)
1. Holds register → **Request release** with the reason and the evidence reference.
2. A different ops/finance person or Fidelity admin approves it in **Approvals**.
3. The requester → **Execute** with the approval id. The case log records `HOLD_RELEASED`.
4. Out of hours: there is no single-person release. If no checker can be reached, the money stays held (D20 after-hours cover is not decided).
