// P08 over HTTP: signed webhook in (raw body), forged one refused, secure
// hand-off sign-in completed through the page's endpoints.
import { createWhatsAppHarness, type WhatsAppHarness } from '@chema/whatsapp/testing';
import { PUBLIC_BASE } from '@chema/wallet/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let t: WhatsAppHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createWhatsAppHarness();
  app = buildApp({
    db: t.h.db,
    core: t.h,
    payments: t.payments,
    wallets: { commands: t.w, publicBaseUrl: PUBLIC_BASE },
    contributions: t.contributions,
    claims: t.claims,
    payouts: t.payouts,
    whatsapp: t.wa,
  });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const PHONE = '+263789990001';

describe('whatsapp routes', () => {
  it('accepts a signed webhook, refuses a forged one, dedupes a replay', async () => {
    const hook = t.sim.say(PHONE, 'hi', { messageId: 'wamid.http.1' });
    let r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp/simulator', headers: hook.headers, payload: hook.body });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ received: true, stored: 1 });
    r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp/simulator', headers: hook.headers, payload: hook.body });
    expect(r.json()).toMatchObject({ stored: 0, duplicates: 1 });
    r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp/simulator', headers: { ...hook.headers, 'x-sim-signature': '0'.repeat(64) }, payload: hook.body });
    expect(r.statusCode).toBe(401);
    r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp/meta', headers: hook.headers, payload: hook.body });
    expect(r.statusCode).toBe(404); // Meta not enabled
    r = await app.inject({ method: 'GET', url: '/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1' });
    expect(r.statusCode).toBe(403);
    await t.pumpWa();
    expect(t.sim.last(PHONE)).toContain('Reply with a number');
  });

  it('completes a sign-in through the hand-off endpoints', async () => {
    await t.say(PHONE, '7');
    const token = t.tokenFor(PHONE);
    let r = await app.inject({ method: 'POST', url: '/handoff/describe', payload: { token } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ purpose: 'LOGIN', summary: { phone: '+263•••••0001' } });
    t.h.advance(6 * 60_000);
    r = await app.inject({ method: 'POST', url: '/handoff/otp', payload: { token } });
    expect(r.statusCode).toBe(202);
    const { challengeId } = r.json() as { challengeId: string };
    r = await app.inject({ method: 'POST', url: '/handoff/confirm', payload: { token, challengeId, code: '000000' } });
    expect(r.statusCode).toBe(401);
    r = await app.inject({ method: 'POST', url: '/handoff/confirm', payload: { token, challengeId: challengeId, code: t.h.otp.lastCodeFor(PHONE) } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ purpose: 'LOGIN' });
    r = await app.inject({ method: 'POST', url: '/handoff/describe', payload: { token } });
    expect(r.statusCode).toBe(404); // single use
    r = await app.inject({ method: 'POST', url: '/handoff/describe', payload: { token: 'short' } });
    expect(r.statusCode).toBe(400);
    expect(await t.say(PHONE, 'menu')).toContain('Request a payout');
  });
});
