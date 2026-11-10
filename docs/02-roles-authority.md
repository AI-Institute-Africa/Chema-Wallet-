# 02 Roles, authority, approvals

## Separate identities/roles (never collapse)
policy_beneficiary · claimant · wallet_admin · family_approver · agent · payout_recipient · contributor · fidelity_claims_officer · fidelity_ops_finance · fidelity_admin/auditor · community_verifier · funeral_partner(read-only MVP) · system.
"Family" is NOT one user or legal decision-maker. UI/copy must name the authorised person(s) and scope.

## Wallet mandate
Documented authority for the wallet admin (evidence uploaded, reviewed by verifier). Stores: admin, approvers, evidence refs, approved_by, approved_at, thresholds. No mandate ⇒ no payouts.

## Permission matrix (RBAC + case-level scope; enforce server-side)
| Action | admin | approver | agent | contributor | claims | ops/fin | verifier | auditor |
|---|---|---|---|---|---|---|---|---|
| create draft | Y | - | Y (on behalf) | - | - | - | - | - |
| submit verification | Y | - | Y | - | - | - | - | - |
| approve/reject verification | - | - | NO | - | - | - | Y (not own case) | - |
| view wallet totals/ledger | Y | Y | assigned | public only | assigned | Y | assigned | read |
| request payout | Y | - | NO self-approve | - | - | - | - | - |
| approve payout (checker) | - | Y | NO | - | - | Y (>threshold) | - | - |
| change payout destination / replace admin | dual | dual | NO | - | - | - | - | - |
| claim decision | - | - | - | - | Y | - | - | - |
| ledger adjustment | - | - | - | - | - | maker+checker | - | - |
| view own contribution/receipt | - | - | - | Y | - | - | - | - |
| privileged config / role admin | - | - | - | - | - | - | - | MFA |

## Dual approval (maker-checker) REQUIRED for
payout destination change · administrator replacement · exceptional/high-value payout · material ledger adjustment · disputed release · emergency hold release. Maker ≠ checker, distinct persons. Thresholds configurable (`approvals.payout_high_value_minor`, unset ⇒ ALL payouts require dual approval). Unavailable approver ⇒ escalation path, not bypass.

## Agent rules
Assist/create drafts/submit evidence; cannot impersonate family, self-approve verification, approve own payout, or be the checker on anything they made.

## Staff
MFA for privileged and financial roles. Least privilege. Access reviews logged. Staff sees only assigned cases unless role is oversight.

## Step-up verification (sensitive actions)
Payout request, authority/destination change, admin replacement ⇒ OTP or secure-portal auth (+ dual approval where listed). Phone number alone is never proof of identity/authority.
