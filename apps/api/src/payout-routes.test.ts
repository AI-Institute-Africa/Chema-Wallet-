// P07 over HTTP: payee (step-up) → checker decision → payout plan → provider
// confirmation; closure check answers 409 with the unmet preconditions; a
// contributor gets nothing; money is a string on the wire.
import { createPayoutHarness, type PayoutHarness } from '@chema/payouts/testing';
import { PUBLIC_BASE } from '@chema/wallet/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let t: PayoutHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createPayoutHarness();
  app = buildApp({
    db: t.h.db,
    core: t.h,
    payments: t.payments,
    wallets: { commands: t.w, publicBaseUrl: PUBLIC_BASE },
    contributions: t.contributions,
    claims: t.claims,
    payouts: t.payouts,
  });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string, stepUp?: string) => ({ authorization: `Bearer ${token}`, ...(stepUp ? { 'x-step-up-token': stepUp } : {}) });

describe('payout routes', () => {
  it('payee → approval → payout → confirmation; closure blocked with reasons', async () => {
    const w = await t.fundedWallet(50_00n);
    t.ecocash.accountNames.set('+263718880001', 'DOVES FUNERAL');
    let r = await app.inject({
      method: 'POST',
      url: `/wallets/${w.walletId}/payees`,
      headers: auth(w.admin.token),
      payload: { label: 'Doves', holderName: 'Doves Funeral', rail: 'ECOCASH', destination: '+263718880001' },
    });
    expect(r.statusCode).toBe(403); // no step-up
    const su = await t.stepUp(w.admin, 'wallet.change_payout_destination', w.walletId);
    r = await app.inject({
      method: 'POST',
      url: `/wallets/${w.walletId}/payees`,
      headers: auth(w.admin.token, su),
      payload: { label: 'Doves', holderName: 'Doves Funeral', rail: 'ECOCASH', destination: '+263718880001' },
    });
    expect(r.statusCode).toBe(201);
    const { payee, approvalId } = r.json() as { payee: { id: string; destination: string }; approvalId: string };
    expect(payee.destination).toBe('+26371•••0001');
    r = await app.inject({ method: 'POST', url: `/approvals/${approvalId}/decision`, headers: auth(w.approver.token), payload: { decision: 'APPROVED' } });
    expect(r.statusCode).toBe(200);

    const su2 = await t.stepUp(w.admin, 'payout.request', w.walletId);
    r = await app.inject({
      method: 'POST',
      url: `/wallets/${w.walletId}/payouts`,
      headers: auth(w.admin.token, su2),
      payload: { source: { kind: 'COMMUNITY' }, currency: 'USD', parts: [{ payeeId: payee.id, amountMinor: '2000', purpose: 'PARLOUR' }], idempotencyKey: 'http-plan-0001' },
    });
    expect(r.statusCode).toBe(201);
    const plan = r.json() as { approvalId: string; payouts: { id: string; amount: { minor: string } }[] };
    expect(plan.payouts[0]!.amount.minor).toBe('2000');
    await app.inject({ method: 'POST', url: `/approvals/${plan.approvalId}/decision`, headers: auth(w.approver.token), payload: { decision: 'APPROVED' } });
    t.ecocash.payoutSucceed(t.ecocash.payoutRefFor(plan.payouts[0]!.id)!);
    await t.deliverPayouts(t.ecocash);
    r = await app.inject({ method: 'GET', url: `/payouts/${plan.payouts[0]!.id}`, headers: auth(w.admin.token) });
    expect(r.json()).toMatchObject({ status: 'CONFIRMED' });

    // A contributor (no role) sees no payouts.
    const stranger = await t.h.customer();
    r = await app.inject({ method: 'GET', url: `/wallets/${w.walletId}/payouts`, headers: auth(stranger.token) });
    expect(r.statusCode).toBe(403);

    r = await app.inject({ method: 'POST', url: `/wallets/${w.walletId}/close`, headers: auth(w.admin.token), payload: { kind: 'CLOSE', reasonCode: 'FUNERAL_COMPLETED' } });
    expect(r.statusCode).toBe(200);
    r = await app.inject({ method: 'POST', url: `/wallets/${w.walletId}/close/finalise`, headers: auth(w.admin.token) });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'closure_blocked', blockers: expect.arrayContaining(['RESIDUAL_POLICY_UNSET']) });
    r = await app.inject({ method: 'GET', url: `/public/wallets/${w.slug}` });
    expect(r.json()).toMatchObject({ closed: true, usage: { byPurpose: [{ purpose: 'PARLOUR', amount: { minor: '2000', ccy: 'USD' } }] } });
  });

  it('a case with an over-long or missing reason is a 400, not a write', async () => {
    const w = await t.fundedWallet(10_00n);
    const r = await app.inject({ method: 'POST', url: `/wallets/${w.walletId}/cases`, headers: auth(w.admin.token), payload: { type: 'AUTHORITY_DISPUTE', summary: 'short' } });
    expect(r.statusCode).toBe(400);
  });
});
