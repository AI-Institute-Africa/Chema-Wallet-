# P01 Identity, RBAC, audit, consent
**Load:** docs/02-roles-authority.md, docs/03-domain-model.md (person, identity_binding, wallet_role, audit_log, consent_record, document), docs/10-privacy-security-audit.md
**Goal:** the security spine every later phase uses.

## Do
1. Migrations: person, identity_binding, wallet_role, consent_record, document, audit_log (hash-chained, DB triggers deny UPDATE/DELETE), outbox_event.
2. Auth: OTP login (provider interface + mock), sessions w/ expiry, step-up token (short-lived, action-scoped), staff auth w/ MFA (TOTP).
3. RBAC + case-level authorisation middleware: `authorize(actor, action, subject)` implementing the doc-02 matrix. Deny by default. Unit-test every matrix cell.
4. Approval service (maker-checker): maker≠checker, agent can't approve own, thresholds from config (unset ⇒ always dual).
5. Audit service: `audit.record()` mandatory wrapper for state-changing commands (command bus decorator so it can't be skipped).
6. Consent service: grant/withdraw/query by purpose.
7. Document service: encrypted storage interface (local-FS impl), malware-scan interface (mock), access-controlled retrieval, retention_class.
8. Transactional outbox + worker skeleton (BullMQ).

## Tests (docs/14 §S subset)
IDOR attempts denied; audit hash chain verifies & detects tampering; trigger blocks UPDATE/DELETE; step-up token single-action; consent withdrawal.

## Done when
All matrix cells tested; audit chain verifier CLI exists; PROGRESS.md updated.
