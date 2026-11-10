# 03 Domain model (build as SQL migrations)

All tables: `id uuid`, `created_at`, `updated_at` (except append-only: ledger_*, audit_log, outbox).

## Entities
- **person**: phone_e164, name, fidelity_customer_id?, language
- **identity_binding**: person, channel, handle, verified_at, method, revoked_at
- **wallet**: status, deceased_name, date_of_death, funeral_date, funeral_location, target_minor?, currency, photo_doc?, photo_consent_id?, public_slug (null until ACTIVE), verified_at, admin_person, privacy jsonb, created_by (person/agent), source_channel
- **wallet_role**: wallet, person, role(ADMIN|APPROVER|AGENT|POLICY_BENEFICIARY|CLAIMANT|PAYOUT_RECIPIENT), granted_by, revoked_at
- **mandate**: wallet, evidence_docs[], approved_by, approved_at, thresholds jsonb
- **verification_case**: wallet, evidence[], reviewer, outcome(APPROVED|REJECTED|MORE_INFO), reason_code, decided_at, escalation/appeal fields
- **document**: storage_ref(encrypted), class(DEATH_EVIDENCE|ID|MANDATE|OTHER), malware_scan, retention_class, linked_case
- **contribution**: wallet, contributor_person?, display_name, anonymous, tribute?, tribute_status(VISIBLE|HIDDEN|FLAGGED), source(COMMUNITY|GROUP), group_id?, payment, gross, fee, fx_rate, net, currency, status
- **payment**: direction(IN|OUT), rail, idempotency_key UNIQUE, provider_ref, state, amounts, provider_events[] (raw, append)
- **ledger_account / ledger_journal / ledger_entry**: see doc 04
- **fidelity_link**: wallet, policy_no, claim_ref, claim_status_mirror, benefit_minor?, route_status(UNSET|PENDING_APPROVAL|APPROVED|BLOCKED_MISMATCH), approved_recipient?
- **payout_request**: wallet, purpose, recipient, amount, source_subledger, status, step_up_ok, approvals[]
- **approval**: subject_type, subject_id, maker, checker, decision, reason_code, ts
- **case**: type(AUTHORITY_DISPUTE|PAYMENT_DISPUTE|CHARGEBACK|FRAUD|BENEFICIARY_MISMATCH|PROVIDER_DISPUTE|RECON_EXCEPTION), category, affected_txn/source, amount, evidence, owner, status, sla_due, escalation, outcome
- **hold**: wallet, scope(TXN|SOURCE|WALLET), ref, reason, owner, review_at, released_by
- **consent_record**: subject_person, purpose(PHOTO|NAME|TRIBUTE|NOTIFY|MARKETING|DISCLOSURE), given_by, ts, withdrawn_at
- **notification**: event, recipient, channel, template, status, attempts
- **outbox_event**: topic, payload, status (transactional outbox)
- **audit_log**: append-only, hash-chained (prev_hash)
- **recon_run / recon_exception**: see doc 04
- **report/flag**: suspicious-wallet reports

## State machines
Wallet: `DRAFT → PENDING_VERIFICATION → ACTIVE | VERIFICATION_REJECTED(→appeal→PENDING_VERIFICATION)`; `ACTIVE → SUSPENDED(by human, reason) ↔ ACTIVE`; `ACTIVE → CLOSING → CLOSED`. CLOSED: no contributions.
Payment: `INITIATED → PENDING_UNKNOWN → SUCCEEDED | FAILED_EXPIRED`; `SUCCEEDED → REFUNDED | REVERSED | CHARGEBACK` (via compensating entries).
Payout: `REQUESTED → STEP_UP_OK → PENDING_APPROVAL → APPROVED → SUBMITTED → (PENDING_PROVIDER) → CONFIRMED | FAILED`; never mark complete before provider confirmation.
Claim mirror: `NONE | SUBMITTED | IN_REVIEW | MORE_INFO | APPROVED | DECLINED`.

## Invariants enforced in DB where possible
UNIQUE(payment.idempotency_key), UNIQUE(provider_ref, rail); CHECK wallet.public_slug IS NULL unless status IN (ACTIVE,SUSPENDED,CLOSING,CLOSED); triggers deny UPDATE/DELETE on ledger_*, audit_log; journal entries sum to zero per currency.
