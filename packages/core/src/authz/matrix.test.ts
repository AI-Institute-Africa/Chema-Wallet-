// Every docs/02 matrix cell, asserted against an expectation table written
// independently of MATRIX (so a wrong MATRIX edit fails here).
import { describe, expect, it } from 'vitest';
import { authorize, type AuthzInput } from './authorize';
import { ACTIONS, type Action } from './matrix';
import type { Actor, Relations, StaffRole, Subject, WalletRoleName } from './types';

const W = '11111111-1111-4111-8111-111111111111';
const OTHER = 'other-person';

type Persona =
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
  | 'public';

const PERSONAS: Persona[] = [
  'admin',
  'approver',
  'agent',
  'contributor',
  'claims',
  'opsfin',
  'verifier',
  'auditor',
  'fidelity_admin',
  'system',
  'public',
];

function customer(id: string, roles: WalletRoleName[]): { actor: Actor; relations: Relations } {
  return {
    actor: { kind: 'CUSTOMER', personId: id, mfa: false, channel: 'WEB', sessionId: `s-${id}` },
    relations: { walletRoles: new Set(roles), assigned: false },
  };
}

function staff(id: string, role: StaffRole, assigned: boolean, walletRoles: WalletRoleName[] = []) {
  return {
    actor: { kind: 'STAFF', personId: id, staffRole: role, mfa: true, channel: 'ADMIN', sessionId: `s-${id}` } as Actor,
    relations: { walletRoles: new Set(walletRoles), assigned },
  };
}

/** Each persona in its "in scope" form: family roles on W, staff assigned to W. */
const P: Record<Persona, { actor: Actor; relations: Relations }> = {
  admin: customer('p-admin', ['ADMIN']),
  approver: customer('p-approver', ['APPROVER']),
  agent: staff('p-agent', 'AGENT', false, ['AGENT']),
  contributor: customer('p-contrib', []),
  claims: staff('p-claims', 'CLAIMS_OFFICER', true),
  opsfin: staff('p-opsfin', 'OPS_FINANCE', false),
  verifier: staff('p-verifier', 'COMMUNITY_VERIFIER', true),
  auditor: staff('p-auditor', 'AUDITOR', false),
  fidelity_admin: staff('p-fadmin', 'FIDELITY_ADMIN', false),
  system: { actor: { kind: 'SYSTEM', personId: 'system', mfa: false, channel: 'SYSTEM' }, relations: { walletRoles: new Set(), assigned: false } },
  public: { actor: { kind: 'PUBLIC', personId: 'public', mfa: false, channel: 'WEB' }, relations: { walletRoles: new Set(), assigned: false } },
};

/** Rows whose subject belongs to the acting persona. */
const OWN_ROWS = new Set<Action>([
  'receipt.view_own',
  'consent.manage',
  'consent.view',
  'payment.view',
  'contribution.view_own',
  'receipt.reissue',
  'tribute.manage_own',
  'approval.escalate',
]);

function subjectFor(action: Action, persona: Persona): Subject {
  if (action === 'wallet.create_draft') return { type: 'wallet', id: 'new' };
  return {
    type: 'x',
    id: 'x-1',
    walletId: W,
    ownerPersonId: OWN_ROWS.has(action) ? P[persona].actor.personId : OTHER,
    makerPersonId: OTHER,
    createdByPersonId: OTHER,
    amountMinor: 100_00n,
  };
}

const THRESHOLD = 50_00n;

function decide(persona: Persona, action: string, subject: Subject, threshold: bigint | null = THRESHOLD) {
  const input: AuthzInput = { ...P[persona], action, subject, payoutHighValueMinor: threshold };
  return authorize(input);
}

const CUSTOMERS: Persona[] = ['admin', 'approver', 'contributor'];

// Expected ALLOWED personas per action. Everything else must be DENIED.
const EXPECTED: Record<Action, Persona[]> = {
  // docs/02: create draft = admin Y, agent Y. A draft's admin doesn't exist yet, so
  // every customer session may create one (and becomes ADMIN).
  'wallet.create_draft': [...CUSTOMERS, 'agent'],
  'wallet.view': ['admin', 'approver', 'agent', 'verifier', 'auditor', 'fidelity_admin'],
  'verification.add_evidence': ['admin', 'agent'],
  'verification.submit': ['admin', 'agent'],
  'verification.assign': ['fidelity_admin'],
  'verification.queue': ['verifier', 'fidelity_admin'],
  'verification.decide': ['verifier'],
  'verification.appeal': ['admin'],
  'wallet.suspend': ['fidelity_admin'],
  'wallet.unsuspend': ['fidelity_admin'],
  'wallet.report': [...CUSTOMERS, 'system'],
  'fraud_flag.review': ['verifier', 'fidelity_admin'],
  'wallet.view_ledger': ['admin', 'approver', 'agent', 'claims', 'opsfin', 'verifier', 'auditor', 'fidelity_admin'],
  // Public page reads do not run through the bus (no login, ACTIVE only), so PUBLIC has no cell here.
  'wallet.view_public': PERSONAS.filter((p) => p !== 'system' && p !== 'public'),
  'payout.request': ['admin'],
  'payout.approve': ['approver', 'opsfin'],
  'wallet.change_payout_destination': ['admin', 'approver'],
  'wallet.change_payout_destination.approve': ['admin', 'approver'],
  'wallet.replace_admin': ['admin', 'approver'],
  'wallet.replace_admin.approve': ['admin', 'approver'],
  'claim.decide': ['claims'],
  'ledger.adjust': ['opsfin'],
  'payment.initiate': ['contributor', 'admin', 'approver'],
  // own payment only for customers (owner = payer)
  'payment.view': [...CUSTOMERS, 'opsfin', 'auditor'],
  'payment.process': ['system'],
  'payment.refund': ['opsfin'],
  'payment.refund.approve': ['opsfin'],
  'recon.run': ['opsfin', 'system'],
  'recon.exception.view': ['opsfin', 'auditor'],
  'ledger.adjust.approve': ['opsfin'],
  // "view own contribution/receipt: contributor Y" — any customer, own receipt only.
  'receipt.view_own': CUSTOMERS,
  'config.change': ['fidelity_admin'],
  'config.change.approve': ['fidelity_admin'],
  'role.admin': ['fidelity_admin'],
  'consent.manage': CUSTOMERS,
  'consent.view': [...CUSTOMERS, 'auditor', 'fidelity_admin'],
  'document.upload': ['admin', 'agent'],
  'document.read': ['admin', 'agent', 'claims', 'verifier', 'auditor'],
  'document.delete': ['fidelity_admin'],
  'document.scan_result': ['system'],
  'retention.hold': ['fidelity_admin'],
  // P05: no account needed to contribute.
  'contribution.create': [...CUSTOMERS, 'public'],
  // PUBLIC passes the matrix; the signed-link guard is tested in @chema/contributions.
  'contribution.view_own': [...CUSTOMERS, 'public', 'opsfin', 'auditor'],
  'contribution.settle': ['system'],
  'receipt.reissue': [...CUSTOMERS, 'public'],
  'tribute.manage_own': [...CUSTOMERS, 'public'],
  'tribute.moderate': ['verifier', 'fidelity_admin'],
  'wallet.privacy.update': ['admin'],
  'wallet.photo.set': ['admin'],
  'group.create': CUSTOMERS,
  'notification.process': ['system'],
  // P06 (docs/07): consent is checked in the command guard, not the matrix.
  'claim.lookup_policy': ['admin', 'agent', 'claims'],
  'claim.link': ['admin', 'agent'],
  'claim.submit_evidence': ['admin', 'agent'],
  'claim.view': ['admin', 'approver', 'agent', 'claims', 'auditor', 'fidelity_admin'],
  'claim.process': ['system'],
  // Assignment of the maker is checked in the command guard.
  'claim.route.unblock': ['claims'],
  'claim.route.unblock.approve': ['opsfin'],
  // P07 (docs/08, docs/02 dual approval)
  'payee.view': ['admin', 'approver', 'opsfin', 'auditor', 'fidelity_admin'],
  'payout.view': ['admin', 'approver', 'agent', 'claims', 'opsfin', 'auditor', 'fidelity_admin'],
  'payout.cancel': ['admin', 'opsfin'],
  'payout.process': ['system'],
  'payout.override': ['opsfin'],
  'payout.override.approve': ['opsfin'],
  // Only the approval's maker (owner) may escalate it.
  'approval.escalate': CUSTOMERS,
  'mandate.change': ['admin', 'approver'],
  // fidelity_admin only once escalated (tested below).
  'mandate.change.approve': ['admin', 'approver'],
  'mandate.verify': ['verifier'],
  'mandate.execute': ['admin', 'approver'],
  'case.open': ['admin', 'approver', 'claims', 'opsfin', 'fidelity_admin'],
  'case.view': ['admin', 'approver', 'claims', 'opsfin', 'auditor', 'fidelity_admin'],
  'case.assign': ['opsfin', 'fidelity_admin'],
  'case.update': ['claims', 'opsfin', 'fidelity_admin'],
  'case.resolve': ['claims', 'opsfin', 'fidelity_admin'],
  'case.process': ['system'],
  'hold.place': ['claims', 'opsfin', 'fidelity_admin'],
  'hold.release': ['opsfin', 'fidelity_admin'],
  'hold.release.approve': ['opsfin', 'fidelity_admin'],
  'wallet.close': ['admin', 'fidelity_admin'],
  'wallet.close.finalise': ['admin', 'opsfin', 'fidelity_admin'],
  'wallet.thank_contributors': ['admin'],
  'wallet.statement.view': ['admin', 'approver', 'opsfin', 'auditor', 'fidelity_admin'],
};

describe('permission matrix — every cell', () => {
  it('has an expectation for every action', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    for (const persona of PERSONAS) {
      const want = EXPECTED[action].includes(persona);
      it(`${action} × ${persona} ⇒ ${want ? 'ALLOW' : 'DENY'}`, () => {
        const d = decide(persona, action, subjectFor(action, persona));
        expect(d.allowed, `${d.reason}`).toBe(want);
      });
    }
  }
});

describe('maker actions require approval', () => {
  for (const action of ['payout.request', 'wallet.change_payout_destination', 'wallet.replace_admin', 'ledger.adjust', 'config.change'] as const) {
    it(`${action} is granted as maker`, () => {
      const persona = EXPECTED[action][0]!;
      expect(decide(persona, action, subjectFor(action, persona)).requiresApproval).toBe(true);
    });
  }
});

describe('scope: case-level authorisation (IDOR)', () => {
  const unassigned = {
    agent: staff('p-agent', 'AGENT', false),
    claims: staff('p-claims', 'CLAIMS_OFFICER', false),
    verifier: staff('p-verifier', 'COMMUNITY_VERIFIER', false),
  };
  const sub = (over: Partial<Subject> = {}): Subject => ({ type: 'wallet', id: W, walletId: W, ...over });

  it.each([
    ['agent', 'verification.submit'],
    ['agent', 'wallet.view_ledger'],
    ['agent', 'document.read'],
    ['claims', 'wallet.view_ledger'],
    ['claims', 'claim.decide'],
    ['claims', 'claim.lookup_policy'],
    ['claims', 'claim.view'],
    ['agent', 'claim.link'],
    ['claims', 'document.read'],
    ['verifier', 'verification.decide'],
    ['verifier', 'wallet.view_ledger'],
  ] as const)('unassigned %s cannot %s', (who, action) => {
    const d = authorize({ ...unassigned[who], action, subject: sub(), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'NOT_ASSIGNED' });
  });

  it('contributor cannot view another person’s receipt', () => {
    const d = authorize({ ...P.contributor, action: 'receipt.view_own', subject: sub({ ownerPersonId: OTHER }), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'NOT_OWNER' });
  });

  it('wallet admin cannot view a contributor’s receipt on their own wallet', () => {
    const d = authorize({ ...P.admin, action: 'receipt.view_own', subject: sub({ ownerPersonId: OTHER }), payoutHighValueMinor: null });
    expect(d.allowed).toBe(false);
  });

  it('admin of wallet A has no authority on wallet B (no roles loaded for B)', () => {
    const outsider = customer('p-admin', []);
    for (const action of ['wallet.view_ledger', 'payout.request', 'verification.submit', 'document.read'] as const) {
      expect(authorize({ ...outsider, action, subject: sub({ ownerPersonId: OTHER }), payoutHighValueMinor: null }).allowed).toBe(false);
    }
  });

  it('contributor cannot see the ledger (public only)', () => {
    expect(authorize({ ...P.contributor, action: 'wallet.view_ledger', subject: sub(), payoutHighValueMinor: null }).allowed).toBe(false);
    expect(authorize({ ...P.contributor, action: 'wallet.view_public', subject: sub(), payoutHighValueMinor: null }).allowed).toBe(true);
  });

  it('plain contributor cannot attach documents to a wallet they hold no role on', () => {
    const d = authorize({ ...P.contributor, action: 'document.upload', subject: sub({ ownerPersonId: 'p-contrib' }), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'NOT_WALLET_MEMBER' });
    const unlinked = authorize({
      ...P.contributor,
      action: 'document.upload',
      subject: { type: 'document', id: 'new', ownerPersonId: 'p-contrib' },
      payoutHighValueMinor: null,
    });
    expect(unlinked.allowed).toBe(true);
  });
});

describe('maker-checker cells', () => {
  const sub = (over: Partial<Subject>): Subject => ({ type: 'approval', id: 'a1', walletId: W, makerPersonId: OTHER, amountMinor: 100_00n, ...over });

  it('approver cannot check their own request', () => {
    const d = authorize({ ...P.approver, action: 'payout.approve', subject: sub({ makerPersonId: 'p-approver' }), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'MAKER_CANNOT_CHECK' });
  });

  it('admin cannot check their own destination change', () => {
    const d = authorize({ ...P.admin, action: 'wallet.change_payout_destination.approve', subject: sub({ makerPersonId: 'p-admin' }), payoutHighValueMinor: null });
    expect(d.allowed).toBe(false);
  });

  it('ops/finance checks a payout only above the configured threshold', () => {
    const above = authorize({ ...P.opsfin, action: 'payout.approve', subject: sub({ amountMinor: 50_01n }), payoutHighValueMinor: THRESHOLD });
    const equal = authorize({ ...P.opsfin, action: 'payout.approve', subject: sub({ amountMinor: 50_00n }), payoutHighValueMinor: THRESHOLD });
    expect(above.allowed).toBe(true);
    expect(equal).toMatchObject({ allowed: false, reason: 'BELOW_THRESHOLD' });
  });

  it('ops/finance is not a payout checker while the threshold is unset (safest)', () => {
    const d = authorize({ ...P.opsfin, action: 'payout.approve', subject: sub({}), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'THRESHOLD_UNSET' });
  });

  it('ops/finance cannot check their own ledger adjustment', () => {
    const d = authorize({ ...P.opsfin, action: 'ledger.adjust.approve', subject: sub({ makerPersonId: 'p-opsfin' }), payoutHighValueMinor: null });
    expect(d.allowed).toBe(false);
  });

  it('agents are never checkers, even when assigned', () => {
    for (const action of ACTIONS.filter((a) => a.endsWith('.approve'))) {
      expect(authorize({ ...P.agent, action, subject: sub({}), payoutHighValueMinor: THRESHOLD }).allowed, action).toBe(false);
    }
  });

  it('checker cell without a maker on the subject is denied', () => {
    const d = authorize({ ...P.approver, action: 'payout.approve', subject: { type: 'approval', id: 'a1', walletId: W }, payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'NO_MAKER' });
  });
});

describe('escalated approvals (unavailable approver, docs/02)', () => {
  const sub = (over: Partial<Subject>): Subject => ({ type: 'approval', id: 'a1', walletId: W, makerPersonId: OTHER, amountMinor: 10_00n, ...over });

  it('ops/finance checks an escalated payout even below the threshold / with it unset', () => {
    const d = authorize({ ...P.opsfin, action: 'payout.approve', subject: sub({ escalatedTo: 'OPS_FINANCE' }), payoutHighValueMinor: null });
    expect(d.allowed).toBe(true);
  });

  it('an escalation to FIDELITY_ADMIN does not let ops/finance check', () => {
    const d = authorize({ ...P.opsfin, action: 'payout.approve', subject: sub({ escalatedTo: 'FIDELITY_ADMIN' }), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'ESCALATED_ELSEWHERE' });
  });

  it('fidelity_admin checks an escalated admin replacement / mandate change, never un-escalated ones', () => {
    for (const action of ['wallet.replace_admin.approve', 'mandate.change.approve'] as const) {
      expect(authorize({ ...P.fidelity_admin, action, subject: sub({ escalatedTo: 'FIDELITY_ADMIN' }), payoutHighValueMinor: null }).allowed).toBe(true);
      expect(authorize({ ...P.fidelity_admin, action, subject: sub({}), payoutHighValueMinor: null })).toMatchObject({ allowed: false, reason: 'NOT_ESCALATED' });
    }
  });

  it('ops/finance checks an escalated destination change', () => {
    const d = authorize({ ...P.opsfin, action: 'wallet.change_payout_destination.approve', subject: sub({ escalatedTo: 'OPS_FINANCE' }), payoutHighValueMinor: null });
    expect(d.allowed).toBe(true);
  });

  it('escalation never lets the maker check their own request', () => {
    const d = authorize({ ...P.opsfin, action: 'payout.approve', subject: sub({ escalatedTo: 'OPS_FINANCE', makerPersonId: 'p-opsfin' }), payoutHighValueMinor: null });
    expect(d).toMatchObject({ allowed: false, reason: 'MAKER_CANNOT_CHECK' });
  });
});

describe('verifier: not own case', () => {
  it('verifier cannot decide a case they created', () => {
    const d = authorize({
      ...P.verifier,
      action: 'verification.decide',
      subject: { type: 'verification_case', id: 'v1', walletId: W, createdByPersonId: 'p-verifier' },
      payoutHighValueMinor: null,
    });
    expect(d).toMatchObject({ allowed: false, reason: 'OWN_CASE' });
  });
});

describe('deny by default', () => {
  it('unknown action is denied for everyone', () => {
    for (const persona of PERSONAS) {
      expect(decide(persona, 'wallet.teleport', subjectFor('wallet.view_ledger', persona))).toMatchObject({
        allowed: false,
        reason: 'UNKNOWN_ACTION',
      });
    }
  });

  it('staff without MFA are denied everything', () => {
    const noMfa = { ...P.fidelity_admin, actor: { ...P.fidelity_admin.actor, mfa: false } };
    for (const action of ACTIONS) {
      expect(authorize({ ...noMfa, action, subject: subjectFor(action, 'fidelity_admin'), payoutHighValueMinor: null }).allowed).toBe(false);
    }
  });

  it('a staff role with no matrix column gets nothing', () => {
    const ghost = { actor: { kind: 'STAFF', personId: 'g', mfa: true, channel: 'ADMIN' } as Actor, relations: { walletRoles: new Set<WalletRoleName>(), assigned: true } };
    for (const action of ACTIONS) {
      expect(authorize({ ...ghost, action, subject: subjectFor(action, 'contributor'), payoutHighValueMinor: null }).allowed).toBe(false);
    }
  });
});
