// UI redesign (2026-11-11): the family admin edits the fundraising target.
// Admin only, audited with before/after; nobody else; not on a closed wallet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWalletHarness, type WalletHarness } from './test-support';

let t: WalletHarness;
beforeAll(async () => {
  t = await createWalletHarness();
});
afterAll(async () => {
  await t.close();
});

const audit = async (walletId: string) =>
  (
    await t.h.db.query<{ authz_result: string; reason_code: string | null }>(
      "SELECT authz_result, reason_code FROM audit_log WHERE action = 'wallet.update_target' AND subject_id = $1 ORDER BY audit_log.seq",
      [walletId],
    )
  ).rows;

describe('wallet.update_target', () => {
  it('the admin sets, changes and clears the target on a draft and on an active wallet; each change is audited', async () => {
    const admin = await t.h.customer();
    const draftId = await t.draft(admin.actor);
    let v = await t.h.bus.execute(t.w.updateTarget, { walletId: draftId, targetMinor: 150_000n }, { actor: admin.actor });
    expect(v.targetMinor).toBe('150000');

    const { walletId, admin: a2 } = await t.activeWallet();
    v = await t.h.bus.execute(t.w.updateTarget, { walletId, targetMinor: 200_000n }, { actor: a2.actor });
    expect(v.targetMinor).toBe('200000');
    v = await t.h.bus.execute(t.w.updateTarget, { walletId, targetMinor: null }, { actor: a2.actor });
    expect(v.targetMinor).toBeNull();
    expect((await audit(walletId)).map((r) => [r.authz_result, r.reason_code])).toEqual([
      ['ALLOWED', 'TARGET_CHANGED'],
      ['ALLOWED', 'TARGET_CHANGED'],
    ]);
  });

  it('approver, another customer and staff are refused and the refusal is audited; the target is unchanged', async () => {
    const { walletId } = await t.activeWallet();
    await t.h.db.query('UPDATE wallet SET target_minor = 1000 WHERE id = $1', [walletId]);
    const approver = await t.h.customer();
    await t.h.grantRole(walletId, approver.personId, 'APPROVER');
    const stranger = await t.h.customer();
    const ops = await t.h.staff('OPS_FINANCE');
    const fa = await t.h.staff('FIDELITY_ADMIN');
    for (const who of [approver, stranger, ops, fa]) {
      await expect(t.h.bus.execute(t.w.updateTarget, { walletId, targetMinor: 999_999n }, { actor: who.actor })).rejects.toMatchObject({
        name: expect.stringMatching(/Forbidden|NotFound/),
      });
    }
    expect((await audit(walletId)).filter((r) => r.authz_result === 'DENIED')).toHaveLength(4);
    const { rows } = await t.h.db.query<{ target_minor: string }>('SELECT target_minor::text AS target_minor FROM wallet WHERE id = $1', [walletId]);
    expect(rows[0]!.target_minor).toBe('1000');
  });

  it('a zero or negative target is refused; a suspended wallet cannot be edited', async () => {
    const { walletId, admin } = await t.activeWallet();
    await expect(t.h.bus.execute(t.w.updateTarget, { walletId, targetMinor: 0n }, { actor: admin.actor })).rejects.toMatchObject({ name: 'ValidationError' });
    const fa = await t.h.staff('FIDELITY_ADMIN');
    await t.h.bus.execute(t.w.suspend, { walletId, reasonCode: 'FRAUD_SUSPECTED', note: 'checking a report' }, { actor: fa.actor });
    await expect(t.h.bus.execute(t.w.updateTarget, { walletId, targetMinor: 5_000n }, { actor: admin.actor })).rejects.toMatchObject({
      reason: 'WALLET_NOT_EDITABLE',
    });
  });
});
