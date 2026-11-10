# 14 Test plan (read only the section your phase names)

## §V Verification
missing evidence · approved evidence (any configured type) · identity mismatch · duplicate certificate · community-only wallet · agent-assisted creation · rejection + appeal · pending/rejected shows no badge · draft not publicly reachable (404) · verifier≠creator.

## §P Payments (against mock rails)
success · timeout→pending_unknown→resolved by status query · delayed callback · duplicate callback (1 credit) · replayed/forged webhook rejected · provider outage · partial settlement · fee/FX variance · chargeback · refund · wrong destination · disabled rail absent from UI/API · receipt only on success · receipt retrievable when notification fails.

## §L Ledger
concurrent contributions · reversal nets original · partial payout · unmatched incoming→suspense+exception · tolerance breach→exception+proportionate hold (not blanket freeze) · manual adjustment needs maker-checker · audit reconstruction of a wallet · property tests (sum=0, no negative available, payout≤available, no cross-wallet movement).

## §C Claims/Fidelity (MockFidelity)
no policy · inactive · covered-life mismatch · arrears · duplicate claim · pending · declined · approved · beneficiary mismatch→route blocked · benefit payment not settled · claim decline leaves community funds intact · Fidelity down→queued/retried · benefit never credited before route approved.

## §G Governance
single vs dual approval · unavailable approver · family dispute (hold + case) · admin replacement · agent delegation + no self-approve · privileged staff access scoped · dispute on community does not freeze Fidelity source.

## §S Privacy/security
anonymous contribution (public hidden, audit kept) · photo consent withdrawal · tribute removal · unauthorised access (IDOR on wallet/receipt/claim) · phone/reference tampering over WhatsApp · retention hold · API replay · account compromise/step-up · no PIN/OTP/card data in chat or logs.

## §O Operations
notification failure (txn unaffected) · queue recovery after outage · channel outage fallback · recon ageing/escalation · emergency hold/release (dual) · final close + statement · closure blocked with residual/pending/disputes.

## §A MVP acceptance (end-to-end, all on mocks with flags on)
1. Draft can exist without badge; public share + contribution blocked until verification passes.
2. Community-only wallet works with no policy.
3. Claim state and community funding distinct; decline/delay doesn't erase community funds.
4. Policy beneficiary, claimant, admin, recipient represented separately; benefit route blocked until approved.
5. Only enabled rails shown; Bank/remittance/USSD/InnBucks absent everywhere.
6. Duplicate requests/webhooks never double-credit/pay.
7. pending/failed/succeeded/reversed/refunded/charged-back distinct + auditable.
8. Recon exceptions owned+time-bound; small variance doesn't freeze all payouts.
9. Payouts ≤ eligible available; respect source restrictions/holds/approvals.
10. Receipt retrievable if delivery fails.
11. Privacy settings + anonymity consistent across pages, notifications, reports.
12. Refund, cancellation, dispute, excess-funds, closure pass end-to-end.
13. Contributor sees total + receipt < 30 s w/o calling family; contribution initiation < 5 s (excl. provider).
14. A fake/unverified wallet cannot be publicly shared.
