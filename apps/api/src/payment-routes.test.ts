// P03 over HTTP: rails list, initiate with Idempotency-Key, raw-body signed
// webhooks (forged ⇒ 401, replay ⇒ 200 once), receipts, staff-only recon.
import { randomUUID } from 'node:crypto';
import { createPaymentsHarness, type PaymentsHarness } from '@chema/payments/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let t: PaymentsHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createPaymentsHarness({ 'rail.onemoney': 'false' });
  app = buildApp({ db: t.h.db, core: t.h, payments: t.service });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function initiate(token: string, walletId: string, rail = 'ECOCASH', key = `k-${randomUUID()}`) {
  return app.inject({
    method: 'POST',
    url: '/payments',
    headers: { ...auth(token), 'idempotency-key': key },
    payload: { walletId, rail, amount: { minor: '1500', ccy: 'USD' } },
  });
}

describe('payment routes', () => {
  it('rail list shows enabled rails only; a disabled rail is 404 on initiate and webhook', async () => {
    const res = await app.inject({ method: 'GET', url: '/payments/rails' });
    expect(res.json()).toEqual({ rails: ['CARD', 'ECOCASH'] });
    const c = await t.h.customer();
    expect((await initiate(c.token, (await t.newWallet()), 'ONEMONEY')).statusCode).toBe(404);
    const hook = await app.inject({ method: 'POST', url: '/webhooks/ONEMONEY', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(hook.statusCode).toBe(404);
  });

  it('initiate needs a session and an Idempotency-Key; replay returns the same payment', async () => {
    const c = await t.h.customer();
    const walletId = await t.newWallet();
    expect((await app.inject({ method: 'POST', url: '/payments', payload: {} })).statusCode).toBe(401);
    const noKey = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: auth(c.token),
      payload: { walletId, rail: 'ECOCASH', amount: { minor: '1500', ccy: 'USD' } },
    });
    expect(noKey.statusCode).toBe(400);
    const key = `k-${randomUUID()}`;
    const first = await initiate(c.token, walletId, 'ECOCASH', key);
    expect(first.statusCode).toBe(201);
    const body = first.json<{ id: string; state: string; disclosure: { totalCharged: { minor: string } } }>();
    expect(body.state).toBe('INITIATED');
    expect(body.disclosure.totalCharged).toEqual({ minor: '1500', ccy: 'USD' });
    const again = await initiate(c.token, walletId, 'ECOCASH', key);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ id: string }>().id).toBe(body.id);
    // Unverified wallet (gate refuses) ⇒ 403.
    expect((await initiate(c.token, randomUUID())).statusCode).toBe(403);
  });

  it('webhook: forged ⇒ 401, genuine ⇒ 202 then replay ⇒ 200; credit visible on the payment and receipt', async () => {
    const c = await t.h.customer();
    const walletId = await t.newWallet();
    const { id } = (await initiate(c.token, walletId)).json<{ id: string }>();
    t.ecocash.succeed(t.ecocash.providerRefFor(id)!);
    const [w] = t.ecocash.takeWebhooks();

    const forged = await app.inject({ method: 'POST', url: '/webhooks/ECOCASH', headers: { ...w!.headers, 'x-chema-signature': 'v1=00' }, payload: w!.body });
    expect(forged.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/webhooks/ECOCASH', headers: w!.headers, payload: w!.body });
    expect(ok.statusCode).toBe(202);
    const replay = await app.inject({ method: 'POST', url: '/webhooks/ECOCASH', headers: w!.headers, payload: w!.body });
    expect(replay.statusCode).toBe(200);

    // The API only stores + queues; the worker processes the outbox job.
    const pending = await app.inject({ method: 'GET', url: `/payments/${id}`, headers: auth(c.token) });
    expect(pending.json<{ state: string }>().state).toBe('INITIATED');
    const { rows } = await t.h.db.query<{ payload: { eventRowId: string } }>(
      "SELECT payload FROM outbox_event WHERE topic = 'payment.event' ORDER BY created_at DESC LIMIT 1",
    );
    await t.service.processEvent(rows[0]!.payload.eventRowId);

    const done = (await app.inject({ method: 'GET', url: `/payments/${id}`, headers: auth(c.token) })).json<{ state: string; receiptId: string }>();
    expect(done.state).toBe('SUCCEEDED');
    const receipt = await app.inject({ method: 'GET', url: `/receipts/${done.receiptId}`, headers: auth(c.token) });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json<{ net: unknown }>().net).toEqual({ minor: '1500', ccy: 'USD' });

    const other = await t.h.customer();
    expect((await app.inject({ method: 'GET', url: `/payments/${id}`, headers: auth(other.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/receipts/${done.receiptId}`, headers: auth(other.token) })).statusCode).toBe(403);
  });

  it('recon runs and exceptions are staff-only', async () => {
    const c = await t.h.customer();
    const ops = await t.h.staff('OPS_FINANCE');
    expect((await app.inject({ method: 'POST', url: '/recon/runs', headers: auth(c.token), payload: { rail: 'ECOCASH', date: '2026-11-10' } })).statusCode).toBe(403);
    const run = await app.inject({ method: 'POST', url: '/recon/runs', headers: auth(ops.token), payload: { rail: 'ECOCASH', date: '2026-11-10' } });
    expect(run.statusCode).toBe(201);
    expect(run.json<{ rowsSeen: number }>().rowsSeen).toBeGreaterThanOrEqual(1);
    expect((await app.inject({ method: 'GET', url: '/recon/exceptions', headers: auth(ops.token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/recon/exceptions', headers: auth(c.token) })).statusCode).toBe(403);
  });
});
