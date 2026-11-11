// P06 over HTTP: lookup → link → Fidelity callback → funds view; outage ⇒ 503;
// forged callback ⇒ 401; contributors see no claim; flag off ⇒ 404.
import { grantConsent } from '@chema/core';
import { createFidelityHarness, type FidelityHarness } from '@chema/fidelity/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let t: FidelityHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createFidelityHarness();
  app = buildApp({ db: t.h.db, core: t.h, payments: t.payments, contributions: t.contributions, claims: t.claims });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('claim routes', () => {
  it('lookup → link → approved, routed, settled callback → funds show the benefit line', async () => {
    const { walletId, admin } = await t.publicWallet();
    const { rows } = await t.h.db.query<{ deceased_name: string }>('SELECT deceased_name FROM wallet WHERE id = $1', [walletId]);
    const policyNo = t.fidelity.seed('APPROVED', { name: rows[0]!.deceased_name });

    // No consent yet ⇒ 403.
    let r = await app.inject({ method: 'POST', url: `/wallets/${walletId}/claim/lookup`, headers: auth(admin.token), payload: { policyNo } });
    expect(r.statusCode).toBe(403);
    await t.h.bus.execute(grantConsent, { subjectPersonId: admin.personId, purpose: 'DISCLOSURE', walletId }, { actor: admin.actor });

    t.fidelity.down = true;
    r = await app.inject({ method: 'POST', url: `/wallets/${walletId}/claim/lookup`, headers: auth(admin.token), payload: { policyNo } });
    expect(r.statusCode).toBe(503);
    t.fidelity.down = false;
    r = await app.inject({ method: 'POST', url: `/wallets/${walletId}/claim/lookup`, headers: auth(admin.token), payload: { policyNo } });
    expect(r.json()).toMatchObject({ outcome: 'ELIGIBLE', linkable: true });

    r = await app.inject({
      method: 'POST',
      url: `/wallets/${walletId}/claim`,
      headers: auth(admin.token),
      payload: { recipientPersonId: admin.personId, recipientIdNumber: '63-123456A42' },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ linked: true, claimStatus: 'SUBMITTED' });

    const claimRef = t.fidelity.claimRefs().at(-1)!;
    t.fidelity.approve(claimRef);
    t.fidelity.routeTo(claimRef, '63-123456A42');
    t.fidelity.pay(claimRef, { minor: 300_00n, ccy: 'USD' });
    for (const cb of t.fidelity.takeWebhooks()) {
      const w = await app.inject({ method: 'POST', url: '/fidelity/webhooks', headers: cb.headers, payload: cb.body });
      expect(w.statusCode).toBe(202);
      const { rows: ev } = await t.h.db.query<{ id: string }>('SELECT id FROM fidelity_event WHERE processed_at IS NULL');
      for (const e of ev) await t.claims.processEvent(e.id);
    }
    const forged = t.fidelity.signed('{"eventId":"x","type":"claim.approved","claimRef":"y"}');
    const bad = await app.inject({ method: 'POST', url: '/fidelity/webhooks', headers: { ...forged.headers, 'x-chema-signature': 'v1=00' }, payload: forged.body });
    expect(bad.statusCode).toBe(401);

    r = await app.inject({ method: 'GET', url: `/wallets/${walletId}/funds`, headers: auth(admin.token) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      benefit: { status: 'CREDITED' },
      lines: [
        { source: 'COMMUNITY', available: { minor: '0', ccy: 'USD' } },
        { source: 'FIDELITY_BENEFIT', available: { minor: '30000', ccy: 'USD' } },
      ],
    });

    const stranger = await t.h.customer();
    r = await app.inject({ method: 'GET', url: `/wallets/${walletId}/claim`, headers: auth(stranger.token) });
    expect(r.statusCode).toBe(403);
  });

  it('re-linking with a different recipient ⇒ 409 recipient_change_refused; the same recipient ⇒ 202 (idempotent)', async () => {
    const c = await t.linkedCase();
    const url = `/wallets/${c.walletId}/claim`;
    const other = await app.inject({ method: 'POST', url, headers: auth(c.admin.token), payload: { recipientPersonId: c.admin.personId, recipientIdNumber: '63-000000B42' } });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({ error: 'recipient_change_refused' });
    const same = await app.inject({ method: 'POST', url, headers: auth(c.admin.token), payload: { recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId } });
    expect(same.statusCode).toBe(202);
    expect(same.json()).toMatchObject({ linked: true });
  });

  it('flag off ⇒ claim routes 404', async () => {
    const off = await createFidelityHarness({ 'fidelity.claims_link': 'false' });
    const offApp = buildApp({ db: off.h.db, core: off.h, claims: off.claims });
    try {
      const { walletId, admin } = await off.publicWallet();
      const r = await offApp.inject({ method: 'POST', url: `/wallets/${walletId}/claim/lookup`, headers: auth(admin.token), payload: { policyNo: 'P1' } });
      expect(r.statusCode).toBe(404);
    } finally {
      await offApp.close();
      await off.close();
    }
  });
});
