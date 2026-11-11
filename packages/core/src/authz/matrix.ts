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
  | 'system'
  /** Unauthenticated visitor (PUBLIC actor). Never owns or is assigned anything. */
  | 'public';

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
  | 'checker_above_threshold'
  /** Checker only on an approval escalated to the actor's staff role (unavailable approver, docs/02). */
  | 'checker_escalated'
  /** checker_above_threshold OR checker_escalated. */
  | 'checker_threshold_or_escalated';

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
  'contribution.create',
  'contribution.view_own',
  'contribution.settle',
  'receipt.reissue',
  'tribute.manage_own',
  'tribute.moderate',
  'wallet.privacy.update',
  'wallet.photo.set',
  'group.create',
  'notification.process',
  'claim.lookup_policy',
  'claim.link',
  'claim.submit_evidence',
  'claim.view',
  'claim.process',
  'claim.route.unblock',
  'claim.route.unblock.approve',
  // P07 payouts, governance, closure (docs/08).
  'payee.view',
  'payout.view',
  'payout.cancel',
  'payout.process',
  'payout.override',
  'payout.override.approve',
  'approval.escalate',
  'mandate.change',
  'mandate.change.approve',
  'mandate.verify',
  'mandate.execute',
  'case.open',
  'case.view',
  'case.assign',
  'case.update',
  'case.resolve',
  'case.process',
  'hold.place',
  'hold.release',
  'hold.release.approve',
  'wallet.close',
  'wallet.close.finalise',
  'wallet.thank_contributors',
  'wallet.statement.view',
  // P08 WhatsApp channel (docs/09).
  'whatsapp.ingest',
  'whatsapp.process',
  'handoff.redeem',
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
  // Unavailable family approver => the maker escalates; the escalated approval is
  // checked by a distinct OPS_FINANCE (money) or FIDELITY_ADMIN (authority) person.
  'payout.approve': { approver: 'checker', opsfin: 'checker_threshold_or_escalated' },
  'wallet.change_payout_destination': { admin: 'maker', approver: 'maker' },
  'wallet.change_payout_destination.approve': { admin: 'checker', approver: 'checker', opsfin: 'checker_escalated' },
  'wallet.replace_admin': { admin: 'maker', approver: 'maker' },
  'wallet.replace_admin.approve': { admin: 'checker', approver: 'checker', fidelity_admin: 'checker_escalated' },
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
  // P05 (docs/06). Contributing needs no account: a PUBLIC visitor or any
  // customer. What a PUBLIC actor may then do to its own contribution (view,
  // reissue the receipt, remove its tribute) is proven by the signed link,
  // checked in each command's guard (audited DENIED without it).
  'contribution.create': { contributor: 'allow', public: 'allow' },
  'contribution.view_own': { contributor: 'own', public: 'allow', opsfin: 'allow', auditor: 'allow' },
  'contribution.settle': { system: 'allow' },
  'receipt.reissue': { contributor: 'own', public: 'allow' },
  'tribute.manage_own': { contributor: 'own', public: 'allow' },
  // Human review of flagged tributes; moderation never touches money.
  'tribute.moderate': { verifier: 'allow', fidelity_admin: 'allow' },
  // Family privacy + photo: the wallet admin decides what the public sees.
  'wallet.privacy.update': { admin: 'allow' },
  'wallet.photo.set': { admin: 'allow' },
  // Group contributions (feature.group_contributions, off): the group's
  // authorised representative is the customer who creates it.
  'group.create': { contributor: 'allow' },
  'notification.process': { system: 'allow' },
  // P06 Fidelity claim path (docs/07), all behind `fidelity.claims_link`.
  // Chema never decides claims (`claim.decide` stays Fidelity-side): it looks
  // up a policy (consent-gated, checked in the guard), lodges/links the claim,
  // shares evidence and mirrors what Fidelity reports (SYSTEM only).
  'claim.lookup_policy': { admin: 'allow', agent: 'assigned', claims: 'assigned' },
  'claim.link': { admin: 'allow', agent: 'assigned' },
  'claim.submit_evidence': { admin: 'allow', agent: 'assigned' },
  // Never contributors: claim detail is not public (docs/07 Never).
  'claim.view': {
    admin: 'allow',
    approver: 'allow',
    agent: 'assigned',
    claims: 'assigned',
    auditor: 'allow',
    fidelity_admin: 'allow',
  },
  'claim.process': { system: 'allow' },
  // Beneficiary mismatch (D03): a claims officer records the written
  // Legal + Claims + Finance approval (maker; assignment checked in the guard),
  // ops/finance checks it. Never unblocked by inference.
  'claim.route.unblock': { claims: 'maker' },
  'claim.route.unblock.approve': { opsfin: 'checker' },
  // -- P07 (docs/08) --
  'payee.view': { admin: 'allow', approver: 'allow', opsfin: 'allow', auditor: 'allow', fidelity_admin: 'allow' },
  'payout.view': {
    admin: 'allow',
    approver: 'allow',
    agent: 'assigned',
    claims: 'assigned',
    opsfin: 'allow',
    auditor: 'allow',
    fidelity_admin: 'allow',
  },
  // Admin cancels own unsubmitted requests (guard); ops/finance for stuck ones.
  'payout.cancel': { admin: 'allow', opsfin: 'allow' },
  'payout.process': { system: 'allow' },
  // Rail down: ops records a payment made outside the rail; another ops person checks it.
  'payout.override': { opsfin: 'maker' },
  'payout.override.approve': { opsfin: 'checker' },
  // Only the maker of the approval (owner = maker) may escalate it.
  'approval.escalate': { contributor: 'own' },
  // Approvers are part of the mandate (docs/02): dual + verifier re-check.
  'mandate.change': { admin: 'maker', approver: 'maker' },
  'mandate.change.approve': { admin: 'checker', approver: 'checker', fidelity_admin: 'checker_escalated' },
  'mandate.verify': { verifier: 'assigned_not_own_case' },
  // The requester runs the approved change (checked in the guard).
  'mandate.execute': { admin: 'allow', approver: 'allow' },
  'case.open': { admin: 'allow', approver: 'allow', claims: 'assigned', opsfin: 'allow', fidelity_admin: 'allow' },
  'case.view': { admin: 'allow', approver: 'allow', claims: 'assigned', opsfin: 'allow', auditor: 'allow', fidelity_admin: 'allow' },
  'case.assign': { opsfin: 'allow', fidelity_admin: 'allow' },
  // Notes / evidence / escalation by the assigned case owner (guard).
  'case.update': { claims: 'assigned', opsfin: 'allow', fidelity_admin: 'allow' },
  'case.resolve': { claims: 'assigned', opsfin: 'allow', fidelity_admin: 'allow' },
  'case.process': { system: 'allow' },
  // Placing a hold is protective (one person, written reason); releasing is dual.
  'hold.place': { claims: 'assigned', opsfin: 'allow', fidelity_admin: 'allow' },
  'hold.release': { opsfin: 'maker', fidelity_admin: 'maker' },
  'hold.release.approve': { opsfin: 'checker', fidelity_admin: 'checker' },
  'wallet.close': { admin: 'allow', fidelity_admin: 'allow' },
  'wallet.close.finalise': { admin: 'allow', opsfin: 'allow', fidelity_admin: 'allow' },
  'wallet.thank_contributors': { admin: 'allow' },
  'wallet.statement.view': { admin: 'allow', approver: 'allow', opsfin: 'allow', auditor: 'allow', fidelity_admin: 'allow' },
  // -- P08 (docs/09) -- The WhatsApp pipeline stores and processes messages as
  // SYSTEM; every business action it routes runs as the bound person (or a
  // PUBLIC visitor) through the same commands as the web.
  'whatsapp.ingest': { system: 'allow' },
  'whatsapp.process': { system: 'allow' },
  // Secure hand-off: the single-use token is the capability (checked in the
  // guard); a LOGIN hand-off is redeemed before the person has a session.
  'handoff.redeem': { contributor: 'allow', public: 'allow' },
};

/** Actions that need a fresh step-up grant (docs/02 Step-up). */
export const STEP_UP_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'payout.request',
  'wallet.change_payout_destination',
  'wallet.replace_admin',
  'mandate.change',
]);

/** The checker action for each maker action. */
export const CHECKER_ACTION: Readonly<Partial<Record<Action, Action>>> = {
  'payout.request': 'payout.approve',
  'wallet.change_payout_destination': 'wallet.change_payout_destination.approve',
  'wallet.replace_admin': 'wallet.replace_admin.approve',
  'ledger.adjust': 'ledger.adjust.approve',
  'config.change': 'config.change.approve',
  'payment.refund': 'payment.refund.approve',
  'claim.route.unblock': 'claim.route.unblock.approve',
  'payout.override': 'payout.override.approve',
  'mandate.change': 'mandate.change.approve',
  'hold.release': 'hold.release.approve',
};

/** Who an unavailable-approver escalation goes to, per maker action. */
export const ESCALATION_ROLE: Readonly<Partial<Record<Action, 'OPS_FINANCE' | 'FIDELITY_ADMIN'>>> = {
  'payout.request': 'OPS_FINANCE',
  'wallet.change_payout_destination': 'OPS_FINANCE',
  'wallet.replace_admin': 'FIDELITY_ADMIN',
  'mandate.change': 'FIDELITY_ADMIN',
};
