// P05 over HTTP: public page (privacy server-side), guest contribute with no
// account, signed link (header, never the URL), receipt re-issue, tribute
// removal, privacy + photo, moderation, CORS for the link header.
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR } from '@chema/core';
import { createContributionHarness, PUBLIC_BASE, type ContributionHarness } from '@chema/contributions/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let t: ContributionHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createContributionHarness();
  app = buildApp({
    db: t.h.db,
    core: t.h,
    payments: t.payments,
    wallets: { commands: t.w, publicBaseUrl: PUBLIC_BASE },
    contributions: t.contributions,
    corsOrigins: [PUBLIC_BASE],
  });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const body = {
  rail: 'ECOCASH',
  amount: { minor: '2500', ccy: 'USD' },
  payerName: 'Chipo Dube',
  payerPhone: '+263773111222',
  anonymous: false,
  displayName: 'Chipo',
  tribute: 'Go well, Baba.',
  contact: { kind: 'EMAIL', value: 'chipo@example.org' },
};

async function contribute(slug: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: `/public/wallets/${slug}/contributions`,
    headers: { 'idempotency-key': `web-${randomUUID()}`, ...headers },
    payload: { ...body, ...over },
  });
}

async function confirm(paymentId: string) {
  const { rows } = await t.h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [paymentId]);
  t.ecocash.succeed(rows[0]!.provider_ref);
  // Webhook over HTTP, then the worker.
  for (const hook of t.ecocash.takeWebhooks(t.h.now())) {
    const res = await app.inject({ method: 'POST', url: '/webhooks/ECOCASH', headers: { ...hook.headers, 'content-type': 'application/json' }, payload: hook.body });
    expect(res.statusCode).toBe(202);
  }
  const { rows: ev } = await t.h.db.query<{ id: string }>("SELECT id FROM provider_event WHERE provider_ref = $1", [rows[0]!.provider_ref]);
  for (const e of ev) await t.payments.processEvent(e.id);
  await t.pump();
}

describe('public page over HTTP', () => {
  it('serves only what the family allows; money as strings', async () => {
    const { slug, walletId, admin } = await t.publicWallet({ showTributes: false, showAmounts: false });
    let page = (await app.inject({ method: 'GET', url: `/public/wallets/${slug}` })).json();
    expect(page).toMatchObject({ slug, tributes: null, totals: { raised: { minor: '0', ccy: 'USD' } }, photoPath: null });
    expect((await app.inject({ method: 'GET', url: `/public/wallets/${slug}/tributes` })).statusCode).toBe(404);

    // Family changes privacy over HTTP; a stranger cannot.
    const stranger = await t.h.customer();
    expect((await app.inject({ method: 'PUT', url: `/wallets/${walletId}/privacy`, headers: auth(stranger.token), payload: { showTotal: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: `/wallets/${walletId}/privacy`, headers: auth(admin.token), payload: { showSecrets: true } })).statusCode).toBe(400);
    const put = await app.inject({ method: 'PUT', url: `/wallets/${walletId}/privacy`, headers: auth(admin.token), payload: { showTotal: false } });
    expect(put.json()).toMatchObject({ showTotal: false, showTributes: false });
    expect((await app.inject({ method: 'GET', url: `/wallets/${walletId}/privacy`, headers: auth(admin.token) })).json()).toMatchObject({ showTotal: false, photo: false });
    page = (await app.inject({ method: 'GET', url: `/public/wallets/${slug}` })).json();
    expect(page.totals).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/public/wallets/${slug}/total` })).statusCode).toBe(404);
  });

  it('unknown, malformed and unverified slugs are the same 404 on every public route', async () => {
    const admin = await t.h.customer();
    await t.draft(admin.actor);
    for (const slug of ['a'.repeat(26), 'not-a-slug']) {
      for (const url of [`/public/wallets/${slug}`, `/public/wallets/${slug}/total`, `/public/wallets/${slug}/photo`, `/public/wallets/${slug}/tributes`]) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
      expect((await contribute(slug)).statusCode).toBe(404);
    }
  });
});

describe('contribute over HTTP (no account)', () => {
  it('guest → 201 + link; pending; webhook; receipt via the link header; re-issue; removal', async () => {
    const { slug } = await t.publicWallet();
    expect((await contribute(slug, {}, { 'idempotency-key': '' })).statusCode).toBe(400);
    const res = await contribute(slug);
    expect(res.statusCode).toBe(201);
    const c = res.json<{ contributionId: string; accessToken: string; payment: { id: string; state: string } }>();
    expect(c.payment.state).toBe('INITIATED');
    const link = { 'x-contribution-token': c.accessToken };

    const pending = await app.inject({ method: 'GET', url: `/public/contributions/${c.contributionId}`, headers: link });
    expect(pending.json()).toMatchObject({ state: 'INITIATED', receipt: null });
    expect(pending.headers['cache-control']).toBe('no-store');

    await confirm(c.payment.id);
    const done = await app.inject({ method: 'GET', url: `/public/contributions/${c.contributionId}`, headers: link });
    expect(done.json()).toMatchObject({ state: 'SUCCEEDED', receipt: { amount: { minor: '2500', ccy: 'USD' }, rail: 'ECOCASH' }, tribute: { status: 'VISIBLE' } });
    expect(t.email.sent[0]?.to).toBe('chipo@example.org');

    // No link / wrong link ⇒ 404, the same as an unknown contribution.
    expect((await app.inject({ method: 'GET', url: `/public/contributions/${c.contributionId}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/public/contributions/${c.contributionId}`, headers: { 'x-contribution-token': 'A'.repeat(43) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/public/contributions/${randomUUID()}`, headers: link })).statusCode).toBe(404);
    // A logged-in stranger is not the owner either.
    const stranger = await t.h.customer();
    expect((await app.inject({ method: 'GET', url: `/public/contributions/${c.contributionId}`, headers: auth(stranger.token) })).statusCode).toBe(404);

    const re = await app.inject({ method: 'POST', url: `/public/contributions/${c.contributionId}/receipt/reissue`, headers: link });
    expect(re.statusCode).toBe(200);
    expect(re.json()).toEqual(done.json().receipt);

    const page = (await app.inject({ method: 'GET', url: `/public/wallets/${slug}` })).json();
    expect(page.tributes[0]).toMatchObject({ name: 'Chipo', message: 'Go well, Baba.', amount: { minor: '2500', ccy: 'USD' } });
    expect((await app.inject({ method: 'GET', url: `/public/wallets/${slug}/total` })).json()).toMatchObject({ raised: { minor: '2500' } });

    const rm = await app.inject({ method: 'POST', url: `/public/contributions/${c.contributionId}/tribute/remove`, headers: link });
    expect(rm.json()).toEqual({ status: 'REMOVED' });
    expect((await app.inject({ method: 'GET', url: `/public/wallets/${slug}/tributes` })).json()).toEqual({ tributes: [] });
  });

  it('limits and validation answer with stable error codes', async () => {
    const { slug } = await t.publicWallet();
    expect((await contribute(slug, { amount: { minor: '9999999', ccy: 'USD' } })).json()).toEqual({ error: 'amount_above_maximum' });
    expect((await contribute(slug, { payerPhone: '0773' })).statusCode).toBe(400);
    expect((await contribute(slug, { rail: 'BANK' })).statusCode).toBe(404); // scope-audit:allow (proves the rail is absent)
    expect((await contribute(slug, { pin: '1234' })).statusCode).toBe(201); // unknown fields are dropped, never stored
    const { rows } = await t.h.db.query<{ row: string }>('SELECT row_to_json(c)::text AS row FROM contribution c');
    expect(rows.map((r) => r.row).join()).not.toContain('1234');
  });

  it('a logged-in contributor lists their own contributions', async () => {
    const { slug } = await t.publicWallet();
    const me = await t.h.customer();
    const res = await contribute(slug, {}, auth(me.token));
    expect(res.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/contributions/mine', headers: auth(me.token) });
    expect(list.json().contributions.map((c: { id: string }) => c.id)).toEqual([res.json().contributionId]);
  });
});

describe('family photo + moderation over HTTP', () => {
  it('photo upload → scan → set; served with nosniff; hidden when the toggle is off', async () => {
    const { slug, walletId, admin } = await t.publicWallet();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(randomUUID())]);
    const up = await app.inject({ method: 'POST', url: `/wallets/${walletId}/photo`, headers: auth(admin.token), payload: { contentType: 'image/png', dataBase64: png.toString('base64') } });
    expect(up.statusCode).toBe(201);
    const docId = up.json<{ id: string }>().id;
    // Not yet scanned ⇒ refused.
    expect((await app.inject({ method: 'PUT', url: `/wallets/${walletId}/photo`, headers: auth(admin.token), payload: { documentId: docId } })).statusCode).toBe(409);
    await t.h.bus.execute(t.h.documents.applyScan, { documentId: docId }, { actor: SYSTEM_ACTOR });
    expect((await app.inject({ method: 'PUT', url: `/wallets/${walletId}/photo`, headers: auth(admin.token), payload: { documentId: docId } })).json()).toEqual({ photo: true });
    const photo = await app.inject({ method: 'GET', url: `/public/wallets/${slug}/photo` });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect(photo.headers['x-content-type-options']).toBe('nosniff');
    expect(photo.rawPayload.equals(png)).toBe(true);
    await app.inject({ method: 'PUT', url: `/wallets/${walletId}/privacy`, headers: auth(admin.token), payload: { showPhoto: false } });
    expect((await app.inject({ method: 'GET', url: `/public/wallets/${slug}/photo` })).statusCode).toBe(404);
  });

  it('flagged tribute waits in the review queue; only moderators see it', async () => {
    const { slug } = await t.publicWallet();
    const res = await contribute(slug, { tribute: 'check www.example.com for more' });
    await confirm(res.json().payment.id);
    const admin = await t.h.customer();
    expect((await app.inject({ method: 'GET', url: '/tributes/review-queue', headers: auth(admin.token) })).statusCode).toBe(403);
    const mod = await t.verifier();
    const q = await app.inject({ method: 'GET', url: '/tributes/review-queue', headers: auth(mod.token) });
    const item = q.json<{ items: { tributeId: string; flagReasons: string[] }[] }>().items.find((i) => i.flagReasons.includes('LINK'));
    expect(item).toBeDefined();
    const ok = await app.inject({ method: 'POST', url: `/tributes/${item!.tributeId}/moderate`, headers: auth(mod.token), payload: { outcome: 'APPROVE' } });
    expect(ok.json()).toEqual({ status: 'VISIBLE' });
  });

  it('CORS lets the web app send the link header', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/public/contributions/x', headers: { origin: PUBLIC_BASE, 'access-control-request-method': 'GET' } });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers'])).toContain('x-contribution-token');
  });
});

describe('pre-payment disclosure', () => {
  it('quotes before checkout without writing anything', async () => {
    const { slug } = await t.publicWallet();
    const before = await t.h.db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment');
    const q = await app.inject({ method: 'POST', url: `/public/wallets/${slug}/quote`, payload: { rail: 'ECOCASH', amount: { minor: '1000', ccy: 'USD' } } });
    expect(q.json()).toEqual({
      totalCharged: { minor: '1000', ccy: 'USD' },
      feePayer: null,
      providerFee: { minor: '0', ccy: 'USD' },
      fxRate: null,
      expectedCredit: { minor: '1000', ccy: 'USD' },
    });
    const after = await t.h.db.query<{ n: string }>('SELECT count(*)::text AS n FROM payment');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    expect((await app.inject({ method: 'POST', url: `/public/wallets/${slug}/quote`, payload: { rail: 'ONEMONEY', amount: { minor: '1000', ccy: 'USD' } } })).statusCode).toBe(404);
  });
});
