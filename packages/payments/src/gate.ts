// Contributions are blocked until community verification is approved
// (CLAUDE.md invariant). The production gate is `verifiedWalletGate` from
// @chema/wallet (P04); DENY_ALL_GATE remains as the fail-closed fallback.
import type { Queryable } from '@chema/shared';

export interface ContributionGate {
  /** Read through the caller's transaction. */
  canAccept(q: Queryable, walletId: string): Promise<boolean>;
}

export const DENY_ALL_GATE: ContributionGate = {
  async canAccept() {
    return false;
  },
};
