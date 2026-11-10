// docs/02 permission matrix as data. Absent cell ⇒ DENY. Rules for one
// action are OR'ed across the principals the actor holds.
//
// Principals (matrix columns): admin/approver come from wallet_role on the
// subject's wallet (customer sessions only); contributor = any customer
// session; staff columns come from staff_account.staff_role. "fidelity_admin/
// auditor" is split into FIDELITY_ADMIN (config, MFA) and AUDITOR (read only).

export type Principal =
  | 'admin'
  | 'approver'
  | 'agent'
  | 'contributor'
  | 'claims'
  | 'opsfin'
  | 'verifier'
  | 'auditor'
  | 'fidelity_admin'
  | 'system';

export type Rule =
  /** Y */
  | 'allow'
  /** Staff/agent assigned to the subject's wallet. */
  | 'assigned'
  /** Subject belongs to the actor (receipt, upload, consent). */
  | 'own'
  /** Own record not linked to any wallet. */
  | 'own_unlinked'
  /** Assigned, didn't create it, holds no family role on the case ("not own case"). */
  | 'assigned_not_own_case'
  /** Allowed to make the request; completion needs an approval (dual). */
  | 'maker'
  /** Checker: not the maker, not the creator. */
  | 'checker'
  /** Checker only when amount > approvals.payout_high_value_minor (unset ⇒ never). */
  | 'checker_above_threshold';

export const ACTIONS = [
  'wallet.create_draft',
  'verification.submit',
  'verification.decide',
  'wallet.view_ledger',
  'wallet.view_public',
  'payout.request',
  'payout.approve',
  'wallet.change_payout_destination',
  'wallet.change_payout_destination.approve',
  'wallet.replace_admin',
  'wallet.replace_admin.approve',
  'claim.decide',
  'ledger.adjust',
  'ledger.adjust.approve',
  'receipt.view_own',
  'config.change',
  'config.change.approve',
  'role.admin',
  'consent.manage',
  'consent.view',
  'document.upload',
  'document.read',
  'document.delete',
  'document.scan_result',
  'retention.hold',
] as const;
export type Action = (typeof ACTIONS)[number];

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

type Cells = Partial<Record<Principal, Rule>>;

export const MATRIX: Readonly<Record<Action, Cells>> = {
  // create draft: admin Y, agent Y (on behalf). The admin of a draft does not
  // exist before the draft, so any customer may create one and becomes ADMIN.
  'wallet.create_draft': { contributor: 'allow', agent: 'allow' },
  'verification.submit': { admin: 'allow', agent: 'assigned' },
  // agent NO; verifier Y (not own case)
  'verification.decide': { verifier: 'assigned_not_own_case' },
  'wallet.view_ledger': {
    admin: 'allow',
    approver: 'allow',
    agent: 'assigned',
    claims: 'assigned',
    opsfin: 'allow',
    verifier: 'assigned',
    auditor: 'allow',
    fidelity_admin: 'allow',
  },
  // contributor: public only. Publication gating (verified wallets only) lands in P04/P05.
  'wallet.view_public': {
    admin: 'allow',
    approver: 'allow',
    agent: 'allow',
    contributor: 'allow',
    claims: 'allow',
    opsfin: 'allow',
    verifier: 'allow',
    auditor: 'allow',
    fidelity_admin: 'allow',
  },
  // agent: NO (never requests, never self-approves)
  'payout.request': { admin: 'maker' },
  'payout.approve': { approver: 'checker', opsfin: 'checker_above_threshold' },
  'wallet.change_payout_destination': { admin: 'maker', approver: 'maker' },
  'wallet.change_payout_destination.approve': { admin: 'checker', approver: 'checker' },
  'wallet.replace_admin': { admin: 'maker', approver: 'maker' },
  'wallet.replace_admin.approve': { admin: 'checker', approver: 'checker' },
  // Staff see assigned cases only (docs/02 Staff).
  'claim.decide': { claims: 'assigned' },
  'ledger.adjust': { opsfin: 'maker' },
  'ledger.adjust.approve': { opsfin: 'checker' },
  'receipt.view_own': { contributor: 'own' },
  'config.change': { fidelity_admin: 'maker' },
  'config.change.approve': { fidelity_admin: 'checker' },
  'role.admin': { fidelity_admin: 'allow' },
  'consent.manage': { contributor: 'own' },
  'consent.view': { contributor: 'own', auditor: 'allow', fidelity_admin: 'allow' },
  // Sensitive documents: uploader, the wallet admin, assigned case staff, audit.
  'document.upload': { contributor: 'own_unlinked', admin: 'allow', agent: 'assigned' },
  'document.read': {
    contributor: 'own',
    admin: 'allow',
    agent: 'assigned',
    claims: 'assigned',
    verifier: 'assigned',
    auditor: 'allow',
  },
  'document.delete': { fidelity_admin: 'allow' },
  'document.scan_result': { system: 'allow' },
  'retention.hold': { fidelity_admin: 'allow' },
};

/** Actions that need a fresh step-up grant (docs/02 Step-up). */
export const STEP_UP_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'payout.request',
  'wallet.change_payout_destination',
  'wallet.replace_admin',
]);

/** The checker action for each maker action. */
export const CHECKER_ACTION: Readonly<Partial<Record<Action, Action>>> = {
  'payout.request': 'payout.approve',
  'wallet.change_payout_destination': 'wallet.change_payout_destination.approve',
  'wallet.replace_admin': 'wallet.replace_admin.approve',
  'ledger.adjust': 'ledger.adjust.approve',
  'config.change': 'config.change.approve',
};
