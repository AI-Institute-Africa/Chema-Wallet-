// Family-side wallet roles established by a flow (docs/02: roles are distinct
// and never inferred from one another). Each grant names the flow that
// established it; `grantedBy` is the person whose act did, or null when the
// fact came from Fidelity (a SYSTEM flow). Idempotent: an existing live role
// is left as it is. CommandTx only, so a grant always happens inside an
// authorised, audited bus command.
import type { CommandTx } from '../command/bus';
import type { WalletRoleName } from './types';

/** The flows that may grant a role, and the only roles each may grant. */
export const ROLE_GRANT_SOURCES = {
  /** The family member who lodged/linked the Fidelity claim. */
  CLAIM_LINK: ['CLAIMANT'],
  /** A payee bound to this person became ACTIVE (name check + dual approval). */
  PAYEE_ACTIVE: ['PAYOUT_RECIPIENT'],
  /** Fidelity's approved route names this person (by their declared ID) as the policy beneficiary + recipient. */
  FIDELITY_ROUTE: ['POLICY_BENEFICIARY', 'PAYOUT_RECIPIENT'],
  /** The written Legal + Claims + Finance approval (beneficiary mismatch) names this person as the recipient. */
  ROUTE_UNBLOCK: ['PAYOUT_RECIPIENT'],
} as const satisfies Record<string, readonly WalletRoleName[]>;
export type RoleGrantSource = keyof typeof ROLE_GRANT_SOURCES;

export interface RoleGrant<S extends RoleGrantSource> {
  walletId: string;
  personId: string;
  role: (typeof ROLE_GRANT_SOURCES)[S][number];
  source: S;
  grantedBy: string | null;
}

/** Returns true when a new role row was written. */
export async function grantWalletRole<S extends RoleGrantSource>(tx: CommandTx, g: RoleGrant<S>): Promise<boolean> {
  const allowed: readonly string[] = ROLE_GRANT_SOURCES[g.source];
  if (!allowed.includes(g.role)) throw new Error(`role ${g.role} cannot be granted by ${g.source}`);
  const { rows } = await tx.query(
    `INSERT INTO wallet_role (wallet_id, person_id, role, granted_by, grant_source) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (wallet_id, person_id, role) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
    [g.walletId, g.personId, g.role, g.grantedBy, g.source],
  );
  return rows.length === 1;
}
