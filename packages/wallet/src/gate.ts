// Contribution gate for @chema/payments (structurally its ContributionGate):
// money is accepted only into a wallet whose community verification was
// APPROVED and that is currently ACTIVE (not suspended, closing or closed).
import type { Queryable } from '@chema/shared';

export const verifiedWalletGate = {
  async canAccept(q: Queryable, walletId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(walletId)) return false;
    const { rows } = await q.query<{ ok: boolean }>(
      "SELECT (status = 'ACTIVE' AND public_slug IS NOT NULL AND verified_at IS NOT NULL) AS ok FROM wallet WHERE id = $1",
      [walletId],
    );
    return rows[0]?.ok === true;
  },
};
