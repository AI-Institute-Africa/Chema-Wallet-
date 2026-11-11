// P10 flag audit, D19 pilot envelope: a LIVE rail takes money only with
// live_funds.enabled AND pilot.enabled AND both caps set; then one contribution
// ≤ pilot.max_amount_minor and at most pilot.max_wallets wallets. Mock and
// sandbox rails are untouched by the pilot flags.
import { randomUUID } from 'node:crypto';
import { MockRail } from '@chema/providers';
import { insertTestWallet } from '@chema/shared/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RailRegistry } from './rails';
import { PaymentService } from './service';
import { createPaymentsHarness, usd, WEBHOOK_SECRET, type PaymentsHarness } from './test-support';

let t: PaymentsHarness | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A payments stack whose ECOCASH adapter moves real money (mode LIVE). */
async function liveStack(flags: Record<string, string>) {
  t = await createPaymentsHarness({ 'live_funds.enabled': 'true', ...flags });
  const h = t.h;
  const rails = new RailRegistry(h.flags);
  await rails.register(new MockRail({ rail: 'ECOCASH', webhookSecret: WEBHOOK_SECRET, mode: 'LIVE', clock: h.now }));
  const open = new Set<string>();
  const service = new PaymentService({ db: h.db, bus: h.bus, flags: h.flags, rails, gate: { canAccept: async (_q, id) => open.has(id) }, clock: h.now });
  const wallet = async () => {
    const id = await insertTestWallet(h.db, randomUUID(), 'USD');
    open.add(id);
    return id;
  };
  const pay = async (walletId: string, minor: bigint) => {
    const c = await h.customer();
    return service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(minor), idempotencyKey: `k-${randomUUID()}` });
  };
  const listed = () => h.db.transaction((q) => rails.listCollectable(q));
  return { service, wallet, pay, listed };
}

describe('D19 pilot envelope on LIVE rails', () => {
  it.each([
    ['pilot off', {}],
    ['pilot on, caps unset', { 'pilot.enabled': 'true' }],
    ['pilot on, wallet cap only', { 'pilot.enabled': 'true', 'pilot.max_wallets': '5' }],
    ['pilot on, amount cap only', { 'pilot.enabled': 'true', 'pilot.max_amount_minor': '5000' }],
  ])('%s ⇒ the live rail does not exist for callers, even with live_funds on', async (_name, flags) => {
    const s = await liveStack(flags);
    expect(await s.listed()).toEqual([]);
    await expect(s.pay(await s.wallet(), 10_00n)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('pilot on with both caps: amount cap per contribution, wallet cap across wallets, existing pilot wallets keep working', async () => {
    const s = await liveStack({ 'pilot.enabled': 'true', 'pilot.max_wallets': '2', 'pilot.max_amount_minor': '5000' });
    expect(await s.listed()).toEqual(['ECOCASH']);
    const [a, b, c] = [await s.wallet(), await s.wallet(), await s.wallet()];
    await expect(s.pay(a, 50_01n)).rejects.toMatchObject({ reason: 'PILOT_AMOUNT_CAP' });
    expect((await s.pay(a, 50_00n)).id).toBeTruthy();
    expect((await s.pay(b, 1_00n)).id).toBeTruthy();
    await expect(s.pay(c, 1_00n)).rejects.toMatchObject({ reason: 'PILOT_WALLET_CAP' });
    // Wallets already in the pilot are not locked out by the cap.
    expect((await s.pay(a, 2_00n)).id).toBeTruthy();
    expect((await s.pay(b, 3_00n)).id).toBeTruthy();
  });

  it('live_funds off stops the live rail at once, whatever the pilot says', async () => {
    t = await createPaymentsHarness({ 'pilot.enabled': 'true', 'pilot.max_wallets': '2', 'pilot.max_amount_minor': '5000' });
    const rails = new RailRegistry(t.h.flags);
    await expect(rails.register(new MockRail({ rail: 'ECOCASH', webhookSecret: WEBHOOK_SECRET, mode: 'LIVE' }))).rejects.toMatchObject({
      name: 'LiveFundsDisabledError',
    });
  });

  it('mock rails ignore the pilot flags (sandbox traffic needs no pilot)', async () => {
    t = await createPaymentsHarness();
    const c = await t.h.customer();
    const view = await t.service.initiate(c.actor, { walletId: await t.newWallet(), rail: 'ECOCASH', amount: usd(900_00n), idempotencyKey: `k-${randomUUID()}` });
    expect(view.id).toBeTruthy();
  });
});
