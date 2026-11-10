// Actors, subjects and roles for authorisation. Roles are distinct and never
// inferred from one another (docs/02): wallet roles come only from wallet_role
// rows, staff roles only from staff_account, and a phone number proves nothing.

export const CHANNELS = ['WEB', 'WHATSAPP', 'SMS', 'ADMIN', 'SYSTEM'] as const;
export type Channel = (typeof CHANNELS)[number];

export const STAFF_ROLES = [
  'AGENT',
  'CLAIMS_OFFICER',
  'OPS_FINANCE',
  'COMMUNITY_VERIFIER',
  'FIDELITY_ADMIN',
  'AUDITOR',
] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const WALLET_ROLES = [
  'ADMIN',
  'APPROVER',
  'AGENT',
  'POLICY_BENEFICIARY',
  'CLAIMANT',
  'PAYOUT_RECIPIENT',
] as const;
export type WalletRoleName = (typeof WALLET_ROLES)[number];

export interface Actor {
  kind: 'CUSTOMER' | 'STAFF' | 'SYSTEM';
  /** person.id; 'system' for SYSTEM. */
  personId: string;
  staffRole?: StaffRole;
  /** True only for a staff session that passed TOTP. Customers: false. */
  mfa: boolean;
  channel: Channel;
  sessionId?: string;
  ip?: string;
  device?: string;
}

export const SYSTEM_ACTOR: Actor = { kind: 'SYSTEM', personId: 'system', mfa: false, channel: 'SYSTEM' };

/** What is being acted on, resolved server-side from ids — never from client claims. */
export interface Subject {
  type: string;
  id: string;
  walletId?: string;
  /** Person the record belongs to (receipt, document uploader, consent subject). */
  ownerPersonId?: string;
  /** For approvals: who made the request. */
  makerPersonId?: string;
  /** Who created the underlying case/record (agents can't check their own work). */
  createdByPersonId?: string;
  amountMinor?: bigint;
}

/** Actor ↔ subject relationships loaded from the database. */
export interface Relations {
  walletRoles: ReadonlySet<WalletRoleName>;
  /** Staff assignment to the subject's wallet (staff_assignment row). */
  assigned: boolean;
}

export const NO_RELATIONS: Relations = { walletRoles: new Set(), assigned: false };

export function actorRoleLabel(actor: Actor): string {
  if (actor.kind === 'STAFF') return actor.staffRole ?? 'STAFF';
  return actor.kind;
}
