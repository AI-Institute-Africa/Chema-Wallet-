# 05 Fraud, impersonation, data incident

**Queues:** Fraud flags, Cases, Audit explorer, Staff & roles. **Who:** Fidelity admin (decisions), auditor (evidence), ops/finance (holds).

## Suspected fraudulent wallet
1. Fraud flags shows the rule hits and the public "report this wallet" submissions. Each report already has a `FRAUD` case.
2. Protect first. Place a WALLET hold with `FRAUD_RISK` and a written note. One person can do this.
3. Suspending a wallet is an adverse action, so a human decides it with a written reason (`wallet.suspend`). The public page then returns 404. AI suggestions are never the decision.
4. Run Audit → Reconstruct on the wallet. Save the timeline and the checks with the case.
5. Releasing the hold, refunding contributors or closing the wallet each follows its own dual path (runbooks 02, 03, 07).

## Impersonation (someone claims to be family or staff)
- A phone number is never proof of identity or authority. Check the mandate and the verification evidence.
- Staff impersonation: disable the account in Staff & roles. Its sessions end at once. Re-enabling a privileged role needs a second Fidelity admin.

## Data incident
1. Contain it. Disable affected staff accounts. If a channel is involved, turn off its flag (`channel.whatsapp`, `channel.sms`).
2. Check integrity. Audit → **Verify audit chain**. A break gives the first bad sequence number. Record it. Do not try to "repair" the chain.
3. Note: if the newest rows were truncated, the chain alone cannot show it. Compare the head hash with the last value you recorded outside the system (P10 adds external anchoring).
4. Preserve evidence. Export the access review (Staff & roles → Export CSV) and the affected wallet timelines.
5. The notification and regulator duties depend on the privacy rules in `docs/10`. Legal decides them. This runbook does not.
