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
  'wallet.view',
  'verification.add_evidence',
  'verification.submit',
  'verification.assign',
  'verification.queue',
  'verification.decide',
  'verification.appeal',
  'wallet.suspend',
  'wallet.unsuspend',
  'wallet.report',
  'fraud_flag.review',
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
  'payment.initiate',
  'payment.view',
  'payment.process',
  'payment.refund',
  'payment.refund.approve',
  'recon.run',
  'recon.exception.view',
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
  // P04: the private (non-public) wallet view: status, evidence, case outcome.
  'wallet.view': {
    admin: 'allow',
    approver: 'allow',
    agent: 'assigned',
    verifier: 'assigned',
    auditor: 'allow',
    fidelity_admin: 'allow',
  },
  'verification.add_evidence': { admin: 'allow', agent: 'assigned' },
  'verification.submit': { admin: 'allow', agent: 'assigned' },
  // Verifiers see assigned cases only; a FIDELITY_ADMIN routes the queue.
  'verification.assign': { fidelity_admin: 'allow' },
  'verification.queue': { verifier: 'allow', fidelity_admin: 'allow' },
  // agent NO; verifier Y (not own case)
  'verification.decide': { verifier: 'assigned_not_own_case' },
  // Appeal route after REJECTED (docs/05): the wallet admin only.
  'verification.appeal': { admin: 'allow' },
  // Adverse actions are human decisions with a written reason (docs/11).
  'wallet.suspend': { fidelity_admin: 'allow' },
  'wallet.unsuspend': { fidelity_admin: 'allow' },
  // Report-suspicious-wallet is a public button: any customer, or the public
  // web route acting as SYSTEM (no login).
  'wallet.report': { contributor: 'allow', system: 'allow' },
  'fraud_flag.review': { verifier: 'assigned', fidelity_admin: 'allow' },
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
  // P03 payments (docs/04). Contributors pay into a wallet the ContributionGate
  // accepts (verified wallets, P04/P05). Provider callbacks, polling and the
  // credit run as SYSTEM only.
  'payment.initiate': { contributor: 'allow' },
  'payment.view': { contributor: 'own', opsfin: 'allow', auditor: 'allow' },
  'payment.process': { system: 'allow' },
  // refund.policy unset ⇒ every refund is a manual, dual-approved case (D11).
  'payment.refund': { opsfin: 'maker' },
  'payment.refund.approve': { opsfin: 'checker' },
  'recon.run': { opsfin: 'allow', system: 'allow' },
  'recon.exception.view': { opsfin: 'allow', auditor: 'allow' },
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
  'payment.refund': 'payment.refund.approve',
};
