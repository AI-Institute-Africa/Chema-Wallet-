// UI redesign (2026-11-11): the Fidelity policy number is shown on the public
// page only when the family turns on showPolicyNumber (personal data, off by default).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContributionHarness, type ContributionHarness } from './test-support';

let t: ContributionHarness;
beforeAll(async () => {
  t = await createContributionHarness();
});
afterAll(async () => {
  await t.close();
});

describe('privacy: showPolicyNumber', () => {
  it('off by default ⇒ no policy key in the public JSON; on ⇒ insurer + number; a wallet without a policy shows none', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    await t.h.db.query('INSERT INTO fidelity_link (wallet_id, policy_no, created_by) VALUES ($1, $2, $3)', [walletId, 'FLA-2024-9841', admin.personId]);
    const before = await t.contributions.page(slug);
    expect(before).not.toHaveProperty('policy');
    expect(JSON.stringify(before, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('FLA-2024-9841');
    expect((await t.h.bus.execute(t.contributions.commands.viewPrivacy, { walletId }, { actor: admin.actor })).showPolicyNumber).toBe(false);

    await t.h.bus.execute(t.contributions.commands.updatePrivacy, { walletId, settings: { showPolicyNumber: true } }, { actor: admin.actor });
    expect((await t.contributions.page(slug)).policy).toEqual({ insurer: 'Fidelity Life Assurance', number: 'FLA-2024-9841' });

    const other = await t.publicWallet({ showPolicyNumber: true });
    expect(await t.contributions.page(other.slug)).not.toHaveProperty('policy');
  });
});
