// Contributions are blocked until community verification is approved
// (CLAUDE.md invariant). P03 has no wallet table yet, so the production gate
// refuses everything; P04/P05 replace it with the verification check.
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
