// P10 flag audit (docs/13 global kill switches): `payouts.enabled` off refuses
// every new payout with a reason, while money already in the wallet stays put.
import { getBalances } from '@chema/ledger';
import { afterEach, describe, expect, it } from 'vitest';
import { createPayoutHarness, type PayoutHarness } from './test-support';

let t: PayoutHarness | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('payouts.enabled kill switch', () => {
  it('off ⇒ payout requests are refused (PAYOUTS_DISABLED) and the wallet balance is untouched', async () => {
    t = await createPayoutHarness({ 'payouts.enabled': 'false' });
    const w = await t.fundedWallet(40_00n);
    const payee = await t.activePayee(w.admin, w.approver, w.walletId);
    await expect(t.requestPayout(w.admin, w.walletId, payee, 10_00n)).rejects.toMatchObject({ check: 'PAYOUTS_DISABLED' });
    const community = (await getBalances(t.h.db, w.walletId)).find((x) => x.account.kind === 'COMMUNITY');
    expect(community?.available.minor).toBe(40_00n);
    expect(community?.reserved.minor).toBe(0n);
  });
});
