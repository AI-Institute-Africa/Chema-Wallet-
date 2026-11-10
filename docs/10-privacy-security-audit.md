# 10 Privacy, security, audit, NFRs

## Consent (table `consent_record`)
Capture for photo, names, tribute, notifications, optional public disclosures, marketing: who consented, purpose, date, withdrawal. Withdrawal honoured (suppress public content; keep required records).
Marketing/cross-sell: flag `marketing.enabled` default OFF; needs lawful basis + notice + permission + purpose limitation. NEVER sell/share data for unrelated marketing.

## Data classes & retention
| Class | Examples | Retention |
|---|---|---|
| Financial/claims/AML/audit/dispute | ledger, payments, cases, approvals | approved legal schedule (D12); 7 yrs = planning assumption ONLY → config `retention.financial_years` |
| Public tribute/photo/names | tribute text, photo | separate delete/suppress process |
| Sensitive | death certificate, ID docs, mandate evidence | encrypted, restricted, extra protection, own retention class |
Retention holds supported. Privacy roles/lawful basis/deceased-person data/cross-border = D13 (don't assume).

## Security controls
TLS everywhere; encryption at rest (field-level for docs/PII); secrets manager (no plaintext secrets in repo/env files committed); RBAC + case-level authz server-side; least privilege; MFA for privileged/financial roles; secure API + webhook controls (signatures, replay, rate limits); masking in logs/notifications; access logging; device/session binding for portal; dependency + vulnerability scanning in CI; secure SDLC.

## Audit log (append-only, hash-chained)
Fields: id, ts, actor_id, actor_role, channel, session_ref, action, subject_type/id, authz_result, approval_ref, txn_ref, before/after hash, ip/device (where lawful), reason_code. Covers: identity, consent, verification, payment, claim, approval, payout, refund, config change, admin actions. Must allow end-to-end reconstruction of any wallet.

## NFRs (targets, validate by test/monitoring; don't promise 100% third-party success)
| | |
|---|---|
| Availability | 99.9% monthly for core app orchestration, measured separately from providers |
| Performance | contribution initiation < 5 s excl. provider; draft < 5 min |
| Reliability | durable queues, idempotent retry (72h window), recon, recovery tests, no silent loss; report confirmed-loss |
| Capacity | plan 10,000 funerals / 300,000 contributors Y1 — load+burst test |
| Usability | mobile-first, low-bandwidth, accessible (large text, simple language), grief-sensitive, clear fee/consent |
| Resilience | backups, tested restore, RTO/RPO documented, queue recovery, channel fallback, runbooks |
| Compliance areas | IPEC, RBZ, AML/CFT, Data Protection Act, consumer protection, tax/accounting, outsourcing — assessment areas only; do NOT assert legal classification |

## Pre-production evidence (tracked in 13)
PIA · processor due diligence · pen test · vuln scan · backup restore test · incident-response test.
