# 07 Wallet closure, residual funds, final statement

**Who:** wallet admin (starts), ops/finance or Fidelity admin (finalise). **Where:** closure API/app, Reports → Family statement, Audit explorer.

## Close a wallet
1. The admin (or a Fidelity admin) starts closure. The wallet stops taking contributions (`CLOSING`).
2. Closure checks list everything that blocks it: pending payments, open payouts, open disputes or cases, active holds, and residual balance. The API names each blocker (409 with `blockers`).
3. Clear each blocker through its own runbook. Never work around one.
4. Finalise. This produces the final statement, and the public page shows the closed state and usage by purpose.

## Residual funds (D11)
- `closure.excess_funds_policy` is unset, so **closure is blocked while any residual is above 0**. There is no default destination, whether charity, refund or platform. Community money never funds Fidelity or platform operations.
- Until a policy is decided, the family spends the residual through a normal payout, or the wallet stays `CLOSING`. Any refund follows runbook 03 (manual, dual).
- An unspent Fidelity benefit follows Fidelity's rules for that claim. It is never mixed into community money.

## Final statement
- Reports → Family statement shows balances per sub-ledger (community, Fidelity benefit and group are kept separate), settled contribution counts, payouts and every journal.
- Before you finalise, run Audit → Reconstruct on the wallet. It must say "consistent", meaning every journal was explained by an audited action and the balances replay. If it does not, stop and treat it as a data incident (runbook 05).
- Thanks to contributors (`wallet.thank_contributors`) are sent by the admin and respect each contributor's privacy choices.
