# 06 Contribution & public funeral page

## Public page (only for ACTIVE/closing states; else 404/"not available")
Shows (each governed by family privacy settings): deceased name, dates, funeral details, photo (if consent), verified badge, target + progress bar, total raised (live), tribute wall, contribute/share buttons, "report this page". Family privacy toggles: total, usage summary, photo, contributor names, amounts, tributes. Contributors see ONLY public info + own transactions.
Live total: server-sent events or short polling; derived from ledger, not a cached counter of truth.

## Contribute (no account needed, ≈30 s)
1. Amount (min/max config), display name or Anonymous ("Sympathetic Friend"), optional tribute/prayer, optional contact for receipt (phone/email).
2. Pre-payment disclosure: fee payer, fee, FX, expected credited amount (if schedule configured).
3. Pay via enabled rail only (provider checkout/prompt; never PIN/card in our UI or chat).
4. Payment state per doc 04. Show "pending" if provider slow.
5. On SUCCEEDED: ledger credit (once), receipt, tribute becomes visible (if not anonymous/ per privacy+moderation), family notified ("Tino contributed $10: May she rest in peace" — respect their anonymity/privacy settings).
Contributor KYC: light (phone + name) under threshold; thresholds config (`kyc.contributor_light_max_minor`, unset ⇒ require phone+name always). Anonymous hides public display only; payment/AML/audit data kept.

## Receipt
Contains amount, funeral name, wallet ref, receipt no., payment ref, currency/FX/net. Issued only after success. Retrievable by contributor via signed link/WhatsApp lookup for own txn even if delivery failed. Re-issue allowed (same content).

## Tribute wall
Name/Anonymous, optional amount (per privacy), message. AI/rule moderation flags abusive/spam → HIDDEN pending human review; transparent rules, appeal. Contributor may request deletion/suppression of tribute (public content only; financial records retained per retention schedule).

## Group contribution (flagged, optional)
Group identity + authorised representative; tagged to group sub-ledger; group name shown. Flag `feature.group_contributions` default OFF.

## Dignity rules (UI/copy)
No countdown/pressure/dark patterns, no leaderboards, no ranking or shaming small/anonymous amounts, no "suggested amounts" that anchor high. Every amount honoured.

## Language
All strings in message catalogue; English now; keys ready for Shona/Ndebele.

## Events
contribution.initiated · contribution.succeeded · contribution.failed · tribute.flagged · target.reached
