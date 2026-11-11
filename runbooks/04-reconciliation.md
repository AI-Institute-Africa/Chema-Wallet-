# 04 Daily recon, unmatched incoming, tolerance breach

**Queues:** Recon exceptions, Holds register, Ledger adjustment, Reports → Finance. **Who:** ops/finance.

## Daily recon
1. Import or receive the provider settlement rows, then run recon per rail and date (`POST /recon/runs`). The worker also runs it.
2. Reports → Finance shows the runs: rows seen, matched, within tolerance and exceptions, plus exception ageing.
3. A difference within tolerance (`recon.tolerance.<rail>.<ccy>`) is posted to `SYS:RECON_DIFF`. It is recorded, never written off silently. Tolerance is unset by default, which means zero tolerance, but there is still **no blanket freeze**.

## Working an exception
1. Click **Take** to own it. Each exception has one owner, set once.
2. Investigate with the provider statement, the payment and the audit explorer (Audit → wallet id).
3. If money must move, use **Ledger adjustment**. This posts a compensating journal and is dual: request, a second ops person approves, then execute. Never edit or delete ledger rows.
4. If the exception placed a hold, release it through the Holds register (dual, runbook 02) **before** resolving.
5. Click **Resolve** with a written resolution. The API refuses while the hold is active (`HOLD_ACTIVE`) and refuses anyone who is not the owner (`NOT_OWNER`).

## Unmatched incoming
- The money sits in `SYS:SUSPENSE_UNMATCHED` with an `UNMATCHED_INCOMING` exception. Once you identify the wallet from provider evidence, adjust it from suspense into the wallet: debit suspense, credit the wallet's community sub-ledger. This needs dual approval.
- If no wallet can be identified, keep it in suspense. Refunding it to the payer follows the refund runbook (03).

## Tolerance breach (material variance)
- The system opens an exception and a **proportionate** hold on the affected transaction or source only. Do not widen it to a wallet-wide hold unless there is documented fraud or legal risk.

## Ageing and escalation
- SLA by severity (D09 is not decided, so these are code defaults): HIGH 24 h, MEDIUM 72 h, LOW 168 h. Past SLA, the sweep raises the escalation level and starts a new window. "Past SLA" and "unowned" counts are on Reports → Finance.
