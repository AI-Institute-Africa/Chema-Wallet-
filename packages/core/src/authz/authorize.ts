// authorize(actor, action, subject): deny by default, server-side, case-scoped.
// Pure decision function + a DB-backed Authorizer that loads relations.
import type { Queryable } from '@chema/shared';
import { isAction, MATRIX, type Action, type Principal, type Rule } from './matrix';
import { NO_RELATIONS, type Actor, type Relations, type Subject, type WalletRoleName } from './types';

export interface Decision {
  allowed: boolean;
  /** Machine reason code; recorded in audit_log.reason_code on denial. */
  reason: string;
  /** Principal + rule that granted it. */
  via?: `${Principal}:${Rule}`;
  /** Granted as a maker: the operation completes only after an approval. */
  requiresApproval?: boolean;
}

export interface AuthzInput {
  actor: Actor;
  action: string;
  subject: Subject;
  relations: Relations;
  /** approvals.payout_high_value_minor; null = unset. */
  payoutHighValueMinor: bigint | null;
}

const deny = (reason: string): Decision => ({ allowed: false, reason });

/** Matrix columns the actor occupies for this subject. */
export function principalsOf(actor: Actor, relations: Relations): Principal[] {
  switch (actor.kind) {
    case 'SYSTEM':
      return ['system'];
    case 'PUBLIC':
      return ['public'];
    case 'CUSTOMER': {
      const out: Principal[] = ['contributor'];
      if (relations.walletRoles.has('ADMIN')) out.push('admin');
      if (relations.walletRoles.has('APPROVER')) out.push('approver');
      return out;
    }
    case 'STAFF':
      switch (actor.staffRole) {
        case 'AGENT':
          return ['agent'];
        case 'CLAIMS_OFFICER':
          return ['claims'];
        case 'OPS_FINANCE':
          return ['opsfin'];
        case 'COMMUNITY_VERIFIER':
          return ['verifier'];
        case 'FIDELITY_ADMIN':
          return ['fidelity_admin'];
        case 'AUDITOR':
          return ['auditor'];
        default:
          return [];
      }
  }
}

function isAssigned(actor: Actor, relations: Relations): boolean {
  // Agents are assigned per case via wallet_role AGENT; other staff via staff_assignment.
  if (actor.staffRole === 'AGENT') return relations.walletRoles.has('AGENT') || relations.assigned;
  return relations.assigned;
}

function familyRoles(relations: Relations): WalletRoleName[] {
  return [...relations.walletRoles].filter((r) => r !== 'AGENT');
}

function check(rule: Rule, input: AuthzInput): string | null {
  const { actor, subject, relations } = input;
  const me = actor.personId;
  switch (rule) {
    case 'allow':
    case 'maker':
      return null;
    case 'assigned':
      if (!subject.walletId) return 'NO_CASE_SCOPE';
      return isAssigned(actor, relations) ? null : 'NOT_ASSIGNED';
    case 'own':
      return subject.ownerPersonId !== undefined && subject.ownerPersonId === me ? null : 'NOT_OWNER';
    case 'own_unlinked':
      if (subject.walletId) return 'NOT_WALLET_MEMBER';
      return subject.ownerPersonId !== undefined && subject.ownerPersonId === me ? null : 'NOT_OWNER';
    case 'assigned_not_own_case':
      if (!subject.walletId) return 'NO_CASE_SCOPE';
      if (!isAssigned(actor, relations)) return 'NOT_ASSIGNED';
      if (subject.createdByPersonId === me || familyRoles(relations).length > 0) return 'OWN_CASE';
      return null;
    case 'checker':
      if (subject.makerPersonId === undefined) return 'NO_MAKER';
      if (subject.makerPersonId === me) return 'MAKER_CANNOT_CHECK';
      if (subject.createdByPersonId === me) return 'CREATOR_CANNOT_CHECK';
      return null;
    case 'checker_above_threshold': {
      const base = check('checker', input);
      if (base) return base;
      if (input.payoutHighValueMinor === null) return 'THRESHOLD_UNSET';
      if (subject.amountMinor === undefined) return 'NO_AMOUNT';
      return subject.amountMinor > input.payoutHighValueMinor ? null : 'BELOW_THRESHOLD';
    }
    case 'checker_escalated': {
      const base = check('checker', input);
      if (base) return base;
      if (subject.escalatedTo === undefined) return 'NOT_ESCALATED';
      return actor.kind === 'STAFF' && actor.staffRole === subject.escalatedTo ? null : 'ESCALATED_ELSEWHERE';
    }
    case 'checker_threshold_or_escalated': {
      const threshold = check('checker_above_threshold', input);
      if (threshold === null) return null;
      return subject.escalatedTo === undefined ? threshold : check('checker_escalated', input);
    }
  }
}

export function authorize(input: AuthzInput): Decision {
  const { actor, action } = input;
  if (!isAction(action)) return deny('UNKNOWN_ACTION');
  if (actor.kind === 'STAFF' && !actor.mfa) return deny('MFA_REQUIRED');

  const cells = MATRIX[action];
  const principals = principalsOf(actor, input.relations);
  let firstReason = 'NO_PERMISSION';
  for (const p of principals) {
    const rule = cells[p];
    if (!rule) continue;
    const failure = check(rule, input);
    if (failure === null) {
      return { allowed: true, reason: 'OK', via: `${p}:${rule}`, ...(rule === 'maker' ? { requiresApproval: true } : {}) };
    }
    if (firstReason === 'NO_PERMISSION') firstReason = failure;
  }
  return deny(firstReason);
}

export interface ThresholdSource {
  /** Read through the caller's transaction (never a second connection). */
  payoutHighValueMinor(q: Queryable): Promise<bigint | null>;
}

/** Loads actor↔subject relations from the database, then applies the matrix. */
export class Authorizer {
  constructor(private readonly thresholds: ThresholdSource) {}

  async relations(q: Queryable, actor: Actor, subject: Subject): Promise<Relations> {
    if (!subject.walletId || actor.kind === 'SYSTEM' || actor.kind === 'PUBLIC') return NO_RELATIONS;
    const { rows: roles } = await q.query<{ role: WalletRoleName }>(
      'SELECT role FROM wallet_role WHERE wallet_id = $1 AND person_id = $2 AND revoked_at IS NULL',
      [subject.walletId, actor.personId],
    );
    // A customer session gets family roles only; a staff session only its AGENT
    // assignment — one login never borrows the other identity's authority.
    const walletRoles = new Set(
      roles.map((r) => r.role).filter((r) => (actor.kind === 'STAFF' ? r === 'AGENT' : r !== 'AGENT')),
    );
    let assigned = false;
    if (actor.kind === 'STAFF') {
      const { rows } = await q.query(
        'SELECT 1 FROM staff_assignment WHERE wallet_id = $1 AND staff_person_id = $2 AND revoked_at IS NULL',
        [subject.walletId, actor.personId],
      );
      assigned = rows.length > 0;
    }
    return { walletRoles, assigned };
  }

  async authorize(q: Queryable, actor: Actor, action: Action, subject: Subject): Promise<Decision> {
    const relations = await this.relations(q, actor, subject);
    const payoutHighValueMinor = await this.thresholds.payoutHighValueMinor(q);
    return authorize({ actor, action, subject, relations, payoutHighValueMinor });
  }
}
