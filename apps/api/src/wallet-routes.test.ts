// P04 over HTTP: draft → evidence upload → submit → assign → decide → public
// page/QR/report; every non-ACTIVE wallet is 404 on every public endpoint, and
// the production contribution gate (verifiedWalletGate) is what payments use.
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR } from '@chema/core';
import { ALL_PASS, PUBLIC_BASE, createWalletHarness, type WalletHarness } from '@chema/wallet/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { buildPayments } from './payments';

let t: WalletHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createWalletHarness({ 'contributions.enabled': 'true', 'rail.ecocash': 'true' });
  const payments = await buildPayments(t.h, { env: {}, clock: t.h.now });
  app = buildApp({ db: t.h.db, core: t.h, payments: payments.service, wallets: { commands: t.w, publicBaseUrl: PUBLIC_BASE } });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const pdf = () => Buffer.from(`%PDF-1.4 ${randomUUID()}`).toString('base64');

async function scanAll(walletId: string): Promise<void> {
  // The worker's job, done inline: scan every pending document of the wallet.
  const { rows } = await t.h.db.query<{ id: string }>('SELECT id FROM document WHERE linked_wallet = $1 AND malware_scan IS NULL', [walletId]);
  for (const r of rows) await t.h.bus.execute(t.h.documents.applyScan, { documentId: r.id }, { actor: SYSTEM_ACTOR });
}

async function draftOverHttp(token: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/wallets',
    headers: auth(token),
    payload: { deceasedName: `Rudo Chikore ${randomUUID().slice(0, 6)}`, dateOfDeath: '2026-11-04', funeralLocation: 'Bulawayo', currency: 'USD', targetMinor: '200000' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json<{ id: string; status: string; badge: unknown; publicSlug: unknown; share: unknown }>();
  expect(body).toMatchObject({ status: 'DRAFT', badge: null, publicSlug: null, share: null });
  return body.id;
}

async function evidence(token: string, walletId: string, evidenceType: string) {
  return app.inject({
    method: 'POST',
    url: `/wallets/${walletId}/evidence`,
    headers: auth(token),
    payload: { evidenceType, contentType: 'application/pdf', dataBase64: pdf() },
  });
}

async function initiatePayment(token: string, walletId: string) {
  return app.inject({
    method: 'POST',
    url: '/payments',
    headers: { ...auth(token), 'idempotency-key': `k-${randomUUID()}` },
    payload: { walletId, rail: 'ECOCASH', amount: { minor: '1500', ccy: 'USD' } },
  });
}

describe('wallet routes', () => {
  it('end to end: draft → evidence → submit → verify → public page, QR, share, report, contributions', async () => {
    const admin = await t.h.customer();
    const walletId = await draftOverHttp(admin.token);

    expect((await evidence(admin.token, walletId, 'DEATH_CERTIFICATE')).statusCode).toBe(201);
    const early = await app.inject({ method: 'POST', url: `/wallets/${walletId}/submit`, headers: auth(admin.token) });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'missing_evidence', missing: expect.arrayContaining(['ADMIN_ID', 'MANDATE']) });

    expect((await evidence(admin.token, walletId, 'ADMIN_ID')).statusCode).toBe(201);
    expect((await evidence(admin.token, walletId, 'MANDATE')).statusCode).toBe(201);
    await scanAll(walletId);
    const sub = await app.inject({ method: 'POST', url: `/wallets/${walletId}/submit`, headers: auth(admin.token) });
    expect(sub.statusCode).toBe(200);
    const { caseId } = sub.json<{ caseId: string }>();

    // Unverified ⇒ the payment gate refuses it.
    const contributor = await t.h.customer();
    expect((await initiatePayment(contributor.token, walletId)).statusCode).toBe(403);

    const verifier = await t.verifier();
    const fa = await t.fidelityAdmin();
    const assign = await app.inject({
      method: 'POST',
      url: `/wallets/${walletId}/assign-verifier`,
      headers: auth(fa.token),
      payload: { verifierPersonId: verifier.personId },
    });
    expect(assign.statusCode).toBe(200);
    const queue = await app.inject({ method: 'GET', url: '/verification/queue', headers: auth(verifier.token) });
    expect(queue.json<{ cases: { caseId: string }[] }>().cases.map((c) => c.caseId)).toEqual([caseId]);

    // The family admin cannot decide its own case.
    const self = await app.inject({
      method: 'POST',
      url: `/verification/cases/${caseId}/decide`,
      headers: auth(admin.token),
      payload: { outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
    });
    expect(self.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: `/verification/cases/${caseId}/decide`,
      headers: auth(verifier.token),
      payload: { outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
    });
    expect(ok.statusCode).toBe(200);
    const slug = ok.json<{ publicSlug: string }>().publicSlug;

    const page = await app.inject({ method: 'GET', url: `/public/wallets/${slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      slug,
      badge: { label: 'Verified funeral', tooltip: 'Funeral checks passed. This does not mean insurance cover or claim approval.' },
      share: { url: `${PUBLIC_BASE}/w/${slug}` },
    });
    // Public page shows nothing private.
    expect(JSON.stringify(page.json())).not.toMatch(/admin|phone|evidence|walletId|target/i);
    const qr = await app.inject({ method: 'GET', url: `/public/wallets/${slug}/qr.svg` });
    expect(qr.statusCode).toBe(200);
    expect(qr.headers['content-type']).toContain('image/svg+xml');
    expect(qr.body).toContain('<svg');

    expect((await initiatePayment(contributor.token, walletId)).statusCode).toBe(201);

    const report = await app.inject({ method: 'POST', url: `/public/wallets/${slug}/report`, payload: { category: 'SCAM', details: 'Looks copied.' } });
    expect(report.statusCode).toBe(202);
    const mine = await app.inject({ method: 'GET', url: `/wallets/${walletId}`, headers: auth(admin.token) });
    expect(mine.json()).toMatchObject({ status: 'ACTIVE', publicSlug: slug });
    expect(mine.json()).not.toHaveProperty('fraudFlags');
  });

  it('draft, pending, rejected and suspended wallets are 404 on every public endpoint', async () => {
    const { walletId, slug } = await t.activeWallet();
    const fa = await t.fidelityAdmin();
    const sus = await app.inject({
      method: 'POST',
      url: `/wallets/${walletId}/suspend`,
      headers: auth(fa.token),
      payload: { reasonCode: 'AUTHORITY_DISPUTE', note: 'Two relatives claim administrator role.' },
    });
    expect(sus.statusCode).toBe(200);
    const unknown = 'a'.repeat(26);
    for (const s of [slug, unknown, 'not-a-slug', '../../etc']) {
      expect((await app.inject({ method: 'GET', url: `/public/wallets/${s}` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/public/wallets/${s}/qr.svg` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/public/wallets/${s}/report`, payload: { category: 'SCAM' } })).statusCode).toBe(404);
    }
    const c = await t.h.customer();
    expect((await initiatePayment(c.token, walletId)).statusCode).toBe(403);
  });

  it('private wallet view: unauthenticated 401, stranger 403, unknown 404', async () => {
    const admin = await t.h.customer();
    const walletId = await draftOverHttp(admin.token);
    expect((await app.inject({ method: 'GET', url: `/wallets/${walletId}` })).statusCode).toBe(401);
    const stranger = await t.h.customer();
    expect((await app.inject({ method: 'GET', url: `/wallets/${walletId}`, headers: auth(stranger.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/wallets/${randomUUID()}`, headers: auth(admin.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/wallets', headers: auth(admin.token), payload: { deceasedName: 'x' } })).statusCode).toBe(400);
  });
});
