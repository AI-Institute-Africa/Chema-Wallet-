// HTTP: auth, consent, documents — including cross-user IDOR over the wire
// and a check that OTP codes / tokens never reach the logs.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { SYSTEM_ACTOR } from '@chema/core';
import { createHarness, type Harness } from '@chema/core/testing';
import { createLogger } from '@chema/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

const lines: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    lines.push(chunk.toString());
    cb();
  },
});

let h: Harness;
let app: FastifyInstance;
beforeAll(async () => {
  h = await createHarness();
  app = buildApp({ db: h.db, core: h, logger: createLogger('debug', sink) as FastifyBaseLogger, rateLimit: false });
});
afterAll(async () => {
  await app.close();
  await h.close();
});

async function login(phone: string): Promise<string> {
  const start = await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone } });
  expect(start.statusCode).toBe(202);
  const { challengeId } = start.json<{ challengeId: string }>();
  const verify = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId, code: h.otp.lastCodeFor(phone) } });
  expect(verify.statusCode).toBe(200);
  return verify.json<{ token: string }>().token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('auth routes', () => {
  it('OTP login → session works → logout kills it', async () => {
    const token = await login('+263773000001');
    expect((await app.inject({ method: 'GET', url: '/me/consents', headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(token) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/me/consents', headers: auth(token) })).statusCode).toBe(401);
  });

  it('bad code ⇒ 401, bad phone ⇒ 400, no token ⇒ 401', async () => {
    const start = await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone: '+263773000002' } });
    const { challengeId } = start.json<{ challengeId: string }>();
    const real = h.otp.lastCodeFor('+263773000002');
    const bad = real === '000000' ? '111111' : '000000';
    expect((await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId, code: bad } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone: '0771' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/me/consents' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/me/consents', headers: auth('forged-token-value-xyz') })).statusCode).toBe(401);
  });

  it('rate limit ⇒ 429', async () => {
    const phone = '+263773000003';
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone } });
    expect((await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone } })).statusCode).toBe(429);
  });

  it('staff login needs password AND current TOTP', async () => {
    const s = await h.staff('AUDITOR');
    const ok = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { login: s.login, password: s.password, totp: h.totpFor(s.secret) } });
    expect(ok.statusCode).toBe(200);
    const noTotp = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { login: s.login, password: s.password, totp: '000000' } });
    expect(noTotp.statusCode).toBe(401);
  });

  it('step-up over HTTP: start + verify yields a token', async () => {
    const phone = '+263773000004';
    const token = await login(phone);
    const start = await app.inject({
      method: 'POST',
      url: '/auth/step-up/start',
      headers: auth(token),
      payload: { action: 'payout.request', subjectType: 'wallet', subjectId: randomUUID() },
    });
    expect(start.statusCode).toBe(202);
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/step-up/verify',
      headers: auth(token),
      payload: { challengeId: start.json<{ challengeId: string }>().challengeId, code: h.otp.lastCodeFor(phone) },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toHaveProperty('stepUpToken');
  });
});

describe('consent routes', () => {
  it('grant, list, withdraw; another user cannot withdraw mine', async () => {
    const me = await login('+263774000001');
    const mallory = await login('+263774000002');
    const g = await app.inject({ method: 'POST', url: '/me/consents', headers: auth(me), payload: { purpose: 'PHOTO' } });
    expect(g.statusCode).toBe(201);
    const id = g.json<{ id: string }>().id;

    expect((await app.inject({ method: 'DELETE', url: `/me/consents/${id}`, headers: auth(mallory) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/me/consents/${id}`, headers: auth(me) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/me/consents/${id}`, headers: auth(me) })).statusCode).toBe(409);

    const list = await app.inject({ method: 'GET', url: '/me/consents?purpose=PHOTO', headers: auth(me) });
    expect(list.json<{ consents: { withdrawnAt: string | null }[] }>().consents[0]!.withdrawnAt).not.toBeNull();
    // Mallory's own list never contains my records
    const theirs = await app.inject({ method: 'GET', url: '/me/consents', headers: auth(mallory) });
    expect(theirs.json<{ consents: unknown[] }>().consents).toEqual([]);
  });

  it('rejects unknown purposes', async () => {
    const me = await login('+263774000003');
    expect((await app.inject({ method: 'POST', url: '/me/consents', headers: auth(me), payload: { purpose: 'SELL_DATA' } })).statusCode).toBe(400);
  });
});

describe('document routes', () => {
  it('owner uploads and reads back; another user gets 403 (IDOR) and the denial is audited', async () => {
    const owner = await login('+263775000001');
    const other = await login('+263775000002');
    const pdf = Buffer.from('%PDF-1.4 burial order');
    const up = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: auth(owner),
      payload: { class: 'OTHER', contentType: 'application/pdf', dataBase64: pdf.toString('base64') },
    });
    expect(up.statusCode).toBe(201);
    const { id } = up.json<{ id: string }>();
    await h.bus.execute(h.documents.applyScan, { documentId: id }, { actor: SYSTEM_ACTOR });

    const mine = await app.inject({ method: 'GET', url: `/documents/${id}`, headers: auth(owner) });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toContain('application/pdf');
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.rawPayload.equals(pdf)).toBe(true);

    const theirs = await app.inject({ method: 'GET', url: `/documents/${id}`, headers: auth(other) });
    expect(theirs.statusCode).toBe(403);
    const { rows } = await h.db.query("SELECT 1 FROM audit_log WHERE action = 'document.read' AND subject_id = $1 AND authz_result = 'DENIED'", [id]);
    expect(rows).toHaveLength(1);

    expect((await app.inject({ method: 'GET', url: `/documents/${randomUUID()}`, headers: auth(owner) })).statusCode).toBe(404);
  });

  it('cannot attach a document to a wallet the caller has no role on', async () => {
    const t = await login('+263775000003');
    const res = await app.inject({
      method: 'POST',
      url: '/documents',
      headers: auth(t),
      payload: { class: 'ID', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF').toString('base64'), walletId: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('no secrets in logs', () => {
  it('OTP codes and session tokens never appear in log output', async () => {
    const phone = '+263776000001';
    const token = await login(phone);
    await app.inject({ method: 'GET', url: `/me/consents?token=${token}`, headers: auth(token) });
    const all = lines.join('');
    const codes = h.otp.sent.map((s) => s.code);
    for (const c of codes) expect(all).not.toContain(`"${c}"`);
    expect(all).not.toContain(token);
    expect(all).not.toContain('263776000001');
  });
});

describe('gaps: sign out everywhere + device-bound sessions', () => {
  const FLAG_ADMIN = { id: 'staff-flag-admin', role: 'FIDELITY_ADMIN', channel: 'ADMIN' };

  async function loginOn(phone: string, device?: string): Promise<string> {
    const start = await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone } });
    const { challengeId } = start.json<{ challengeId: string }>();
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { challengeId, code: h.otp.lastCodeFor(phone) },
      ...(device ? { headers: { 'x-device-id': device } } : {}),
    });
    expect(verify.statusCode).toBe(200);
    return verify.json<{ token: string }>().token;
  }

  it('POST /auth/sessions/revoke-all ends every session of the caller, this one too', async () => {
    const phone = '+263777100001';
    const a = await loginOn(phone);
    const b = await loginOn(phone);
    const other = await loginOn('+263777100002');
    const res = await app.inject({ method: 'POST', url: '/auth/sessions/revoke-all', headers: auth(b) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });
    for (const tok of [a, b]) expect((await app.inject({ method: 'GET', url: '/me/consents', headers: auth(tok) })).statusCode).toBe(401);
    // Somebody else's session is untouched.
    expect((await app.inject({ method: 'GET', url: '/me/consents', headers: auth(other) })).statusCode).toBe(200);
  });

  it('a staff session is bound to the device it logged in on: another or no device ⇒ 401 + audited', async () => {
    const login = `binder.${randomUUID().slice(0, 8)}`;
    const password = 'correct horse battery staple';
    const e = await h.staffAuth.enroll({ login, role: 'AUDITOR', password, enrolledBy: 'system' });
    const res = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      headers: { 'x-device-id': 'portal-laptop-1' },
      payload: { login, password, totp: h.totpFor(e.totpSecret) },
    });
    expect(res.statusCode).toBe(200);
    const token = res.json<{ token: string }>().token;
    const get = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/auth/logout', headers: { ...auth(token), ...headers } });
    expect((await get({ 'x-device-id': 'stolen-elsewhere' })).statusCode).toBe(401);
    expect((await get({})).statusCode).toBe(401);
    const { rows } = await h.db.query<{ reason_code: string; device: string | null }>(
      `SELECT reason_code, device FROM audit_log WHERE action = 'identity.session' AND actor_id = $1 AND authz_result = 'DENIED' ORDER BY audit_log.seq`,
      [e.personId],
    );
    expect(rows).toEqual([
      { reason_code: 'DEVICE_MISMATCH', device: 'stolen-elsewhere' },
      { reason_code: 'DEVICE_MISMATCH', device: null },
    ]);
    // The right device still works (logout ⇒ 204).
    expect((await get({ 'x-device-id': 'portal-laptop-1' })).statusCode).toBe(204);
  });

  it('customer sessions are device-bound only with security.bind_customer_device on', async () => {
    const token = await loginOn('+263777100003', 'phone-a');
    const elsewhere = { ...auth(token), 'x-device-id': 'phone-b' };
    // Flag off (default): a customer session is usable from another device.
    expect((await app.inject({ method: 'GET', url: '/me/consents', headers: elsewhere })).statusCode).toBe(200);
    await h.flags.set('security.bind_customer_device', true, FLAG_ADMIN, 'bind customer devices for the test');
    try {
      expect((await app.inject({ method: 'GET', url: '/me/consents', headers: elsewhere })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/me/consents', headers: { ...auth(token), 'x-device-id': 'phone-a' } })).statusCode).toBe(200);
      // A session that recorded no device has nothing to bind to.
      const unbound = await loginOn('+263777100004');
      expect((await app.inject({ method: 'GET', url: '/me/consents', headers: { ...auth(unbound), 'x-device-id': 'phone-z' } })).statusCode).toBe(200);
    } finally {
      await h.flags.set('security.bind_customer_device', false, FLAG_ADMIN, 'restore the default after the test');
    }
  });
});
