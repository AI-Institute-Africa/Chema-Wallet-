// P10 security sweep over the whole HTTP surface (docs/10 security controls,
// docs/14 §S): response headers, rate limits, an authorisation fuzz of EVERY
// registered route, an IDOR sweep with another family's real ids, and a scan
// of everything the API logged for PII and secrets.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createOpsHarness, type OpsHarness } from '@chema/ops/testing';
import { createLogger } from '@chema/shared';
import { PUBLIC_BASE } from '@chema/wallet/testing';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, routesOf, type RouteInfo } from './app';
import { SECURITY_HEADERS, defaultRateLimitRules } from './security';

let t: OpsHarness;
let app: FastifyInstance;
const logLines: string[] = [];

beforeAll(async () => {
  t = await createOpsHarness();
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(chunk.toString('utf8'));
      cb();
    },
  });
  app = buildApp({
    db: t.h.db,
    core: t.h,
    payments: t.payments,
    wallets: { commands: t.w, publicBaseUrl: PUBLIC_BASE },
    contributions: t.contributions,
    claims: t.claims,
    payouts: t.payouts,
    whatsapp: t.wa,
    ops: t.ops,
    logger: createLogger('debug', sink) as FastifyBaseLogger,
    // The sweeps below send hundreds of requests from one address.
    rateLimit: false,
  });
  await app.ready();
}, 60_000);
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Routes a person may call with no session (everything else must answer 401). */
const PUBLIC = [
  /^\/health(\/|$)/,
  /^\/public\//,
  /^\/webhooks\//,
  /^\/fidelity\/webhooks$/,
  /^\/auth\/otp\//,
  /^\/staff\/auth\/login$/,
  /^\/handoff\//,
  /^\/payments\/rails$/, // which rails are on: public by design (docs/06 give page)
];
const isPublic = (r: RouteInfo) => PUBLIC.some((re) => re.test(r.url));

/** Any customer may call these on their OWN behalf; they are scoped to the caller. */
const SELF_SCOPED = new Set([
  'GET /me/consents',
  'POST /me/consents',
  'GET /contributions/mine',
  'POST /wallets',
  'POST /documents',
  'POST /auth/logout',
  'POST /auth/step-up/start',
  'POST /auth/step-up/verify',
  'GET /cases',
]);

/** Inject with a JSON body on writes only. */
function send(method: string, url: string, headers: Record<string, string> = {}, body: object = {}) {
  const m = method as 'GET';
  return method === 'GET' || method === 'DELETE' ? app.inject({ method: m, url, headers }) : app.inject({ method: m, url, headers, payload: body });
}

function fill(url: string, ids: Record<string, string> = {}): string {
  return url.replace(/:([A-Za-z]+)/g, (_m, name: string) => ids[name] ?? randomUUID());
}

describe('response headers', () => {
  it('every response carries the security headers, errors included', async () => {
    for (const url of ['/health', '/wallets/not-a-wallet', '/public/wallets/nope']) {
      const r = await app.inject({ method: 'GET', url });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers[k], `${url} ${k}`).toBe(v);
    }
  });

  it('authenticated responses are never cacheable', async () => {
    const c = await t.h.customer();
    const r = await app.inject({ method: 'GET', url: '/me/consents', headers: auth(c.token) });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});

describe('rate limits', () => {
  async function limited(rules = defaultRateLimitRules({ CHEMA_RATE_AUTH_PER_MIN: '3', CHEMA_RATE_CONTRIBUTE_PER_MIN: '2', CHEMA_RATE_GLOBAL_PER_MIN: '5' })) {
    let now = 1_000_000;
    const a = buildApp({ rateLimit: { rules, now: () => now } });
    await a.ready();
    return { a, tick: (ms: number) => (now += ms) };
  }

  it('auth endpoints: 429 with Retry-After past the budget, per client, reset after the window', async () => {
    const { a, tick } = await limited();
    const hit = (ip: string) => a.inject({ method: 'POST', url: '/auth/otp/start', remoteAddress: ip, payload: {} });
    for (let i = 0; i < 3; i++) expect((await hit('10.0.0.1')).statusCode).not.toBe(429);
    const r = await hit('10.0.0.1');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.json()).toEqual({ error: 'rate_limited' });
    expect((await hit('10.0.0.2')).statusCode).not.toBe(429); // another client is unaffected
    tick(60_000);
    expect((await hit('10.0.0.1')).statusCode).not.toBe(429);
    await a.close();
  });

  it('public contribution posts have their own tighter budget', async () => {
    const { a } = await limited();
    const hit = () => a.inject({ method: 'POST', url: '/public/wallets/x/contributions', remoteAddress: '10.0.0.3', payload: {} });
    expect((await hit()).statusCode).not.toBe(429);
    expect((await hit()).statusCode).not.toBe(429);
    expect((await hit()).statusCode).toBe(429);
    await a.close();
  });

  it('global budget applies to reads; provider webhooks and health are exempt', async () => {
    const { a } = await limited();
    for (let i = 0; i < 5; i++) await a.inject({ method: 'GET', url: '/wallets/x', remoteAddress: '10.0.0.4' });
    expect((await a.inject({ method: 'GET', url: '/wallets/x', remoteAddress: '10.0.0.4' })).statusCode).toBe(429);
    for (let i = 0; i < 20; i++) {
      expect((await a.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.4' })).statusCode).toBe(200);
      expect((await a.inject({ method: 'POST', url: '/webhooks/ECOCASH', remoteAddress: '10.0.0.4', payload: {} })).statusCode).not.toBe(429);
    }
    await a.close();
  });

  it('is on by default', async () => {
    const a = buildApp({});
    await a.ready();
    let last = 0;
    for (let i = 0; i < 25 && last !== 429; i++) {
      last = (await a.inject({ method: 'POST', url: '/staff/auth/login', remoteAddress: '10.0.0.9', payload: {} })).statusCode;
    }
    expect(last).toBe(429);
    await a.close();
  });
});

describe('authorisation fuzz: every registered route', () => {
  it('registers the full surface (sanity: the sweep is not empty)', () => {
    const routes = routesOf(app);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((r) => !isPublic(r)).length).toBeGreaterThan(80);
  });

  it('no session, a forged token or an expired-looking token ⇒ 401 on every non-public route; never a 5xx', async () => {
    const bad: string[] = [];
    for (const r of routesOf(app).filter((x) => !isPublic(x) && x.method !== 'OPTIONS')) {
      for (const headers of [{}, auth('forged-token'), auth(`${randomUUID()}.${randomUUID()}`), { authorization: 'Basic YTpi' }]) {
        const res = await send(r.method, fill(r.url), headers);
        if (res.statusCode !== 401) bad.push(`${r.method} ${r.url} ${JSON.stringify(headers).slice(0, 30)} → ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('a signed-in stranger gets 4xx on every route that is not self-scoped; never 2xx or 5xx', async () => {
    const stranger = await t.h.customer();
    const bad: string[] = [];
    for (const r of routesOf(app).filter((x) => !isPublic(x) && x.method !== 'OPTIONS')) {
      if (SELF_SCOPED.has(`${r.method} ${r.url}`)) continue;
      const res = await send(r.method, fill(r.url), auth(stranger.token));
      if (res.statusCode < 400 || res.statusCode >= 500) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('public routes with junk ids, slugs and bodies answer 4xx, never 5xx', async () => {
    const bad: string[] = [];
    const junk = ['nope', randomUUID(), "x'; DROP TABLE wallet;--", '%00', 'a'.repeat(300)];
    for (const r of routesOf(app).filter((x) => isPublic(x) && x.method !== 'OPTIONS' && !x.url.startsWith('/health'))) {
      for (const j of junk) {
        const url = r.url.replace(/:([A-Za-z]+)/g, () => encodeURIComponent(j));
        const res = await send(r.method, url, {}, { junk: j });
        if (res.statusCode >= 500) bad.push(`${r.method} ${url.slice(0, 60)} → ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('staff routes refuse customers, and staff without the right role', async () => {
    const customer = await t.h.customer();
    const verifier = await t.h.staff('COMMUNITY_VERIFIER');
    const bad: string[] = [];
    for (const r of routesOf(app).filter((x) => x.url.startsWith('/admin/') && x.url !== '/admin/me')) {
      const c = await send(r.method, fill(r.url), auth(customer.token));
      if (c.statusCode !== 403) bad.push(`customer ${r.method} ${r.url} → ${c.statusCode}`);
    }
    for (const url of ['/admin/ledger/accounts', '/admin/queues/holds', '/admin/reports/finance', '/admin/staff']) {
      const v = await app.inject({ method: 'GET', url, headers: auth(verifier.token) });
      if (v.statusCode !== 403) bad.push(`verifier GET ${url} → ${v.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('IDOR sweep: another family’s real ids', () => {
  it('a stranger, and a different wallet’s admin, read nothing of a funded wallet with a payout, case, documents and receipts', async () => {
    const owner = await t.fundedWallet(300_00n);
    const payeeId = await t.activePayee(owner.admin, owner.approver, owner.walletId);
    await t.requestPayout(owner.admin, owner.walletId, payeeId, 50_00n);
    const q = async (sql: string) => (await t.h.db.query<{ id: string }>(sql, [owner.walletId])).rows[0]?.id;
    const ids: Record<string, string | undefined> = {
      wallet: owner.walletId,
      payment: await q('SELECT id::text AS id FROM payment WHERE wallet_id = $1 LIMIT 1'),
      receipt: await q('SELECT id::text AS id FROM receipt WHERE wallet_id = $1 LIMIT 1'),
      payout: await q('SELECT id::text AS id FROM payout_request WHERE wallet_id = $1 LIMIT 1'),
      document: await q('SELECT id::text AS id FROM document WHERE linked_wallet = $1 LIMIT 1'),
      approval: await q("SELECT id::text AS id FROM approval WHERE wallet_id = $1 LIMIT 1"),
      contribution: await q('SELECT id::text AS id FROM contribution WHERE wallet_id = $1 LIMIT 1'),
      verification: await q('SELECT id::text AS id FROM verification_case WHERE wallet_id = $1 LIMIT 1'),
    };
    for (const [k, v] of Object.entries(ids)) expect(v, k).toBeTruthy();

    const paramFor: [RegExp, string][] = [
      [/^\/(wallets|admin\/audit\/wallets|admin\/reports\/family)\/:id/, 'wallet'],
      [/^\/payments\/:id/, 'payment'],
      [/^\/receipts\/:id/, 'receipt'],
      [/^\/payouts\/:id/, 'payout'],
      [/^\/documents\/:id/, 'document'],
      [/^\/approvals\/:id/, 'approval'],
      [/^\/public\/contributions\/:id/, 'contribution'],
      [/^\/verification\/cases\/:id/, 'verification'],
    ];
    const targets = routesOf(app).flatMap((r) => {
      const hit = paramFor.find(([re]) => re.test(r.url));
      return hit ? [{ r, id: ids[hit[1]] as string }] : [];
    });
    expect(targets.length).toBeGreaterThan(35);

    const stranger = await t.h.customer();
    const otherAdmin = (await t.publicWallet()).admin; // admin of a DIFFERENT wallet
    const bad: string[] = [];
    for (const who of [stranger, otherAdmin]) {
      for (const { r, id } of targets) {
        const res = await send(r.method, fill(r.url, { id }), auth(who.token));
        // Reads must be refused outright; writes may also fail validation, but never succeed.
        const ok = r.method === 'GET' ? [403, 404].includes(res.statusCode) : res.statusCode >= 400 && res.statusCode < 500;
        if (!ok) bad.push(`${r.method} ${r.url} → ${res.statusCode}`);
      }
    }
    expect(bad).toEqual([]);

    // The owner CAN read their own wallet: the sweep is refusing strangers, not everyone.
    expect((await app.inject({ method: 'GET', url: `/wallets/${owner.walletId}`, headers: auth(owner.admin.token) })).statusCode).toBe(200);
  });
});

describe('log PII scan', () => {
  it('after the sweeps, no phone number, OTP, token, national id or card number appears in any log line', async () => {
    // Drive one OTP sign-in through HTTP so the log holds auth traffic too.
    const phone = '+263771234987';
    const s = await app.inject({ method: 'POST', url: '/auth/otp/start', payload: { phone } });
    const { challengeId } = s.json() as { challengeId: string };
    const code = t.h.otp.lastCodeFor(phone) ?? '';
    expect(code).not.toBe('');
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { challengeId, code } });
    expect(v.statusCode).toBe(200);
    const token = (v.json() as { token?: string }).token ?? '';
    await app.inject({ method: 'GET', url: '/me/consents', headers: auth(token) });
    await app.inject({ method: 'GET', url: `/me/consents?phone=${encodeURIComponent(phone)}&id=63-123456A42`, headers: auth(token) });

    expect(logLines.length).toBeGreaterThan(100);
    const text = logLines.join('');
    const findings: string[] = [];
    const patterns: [string, RegExp][] = [
      ['E.164 phone', /(?<![\d.])\+?263\d{9}(?!\d)/],
      ['national id', /(?<![\d.])\d{2}-\d{6,7}[A-Z]\d{2}(?!\d)/],
      ['card PAN', /(?<![\w.-])(?:\d{4}[ -]?){3}\d{4}(?![\w.-])/], // not inside a UUID or a float
    ];
    for (const [name, re] of patterns) {
      const m = text.match(re);
      if (m) findings.push(`${name}: [${m[0]}] in ${text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 60)}`);
    }
    if (code && text.includes(`"${code}"`)) findings.push('OTP code');
    if (token && text.includes(token)) findings.push('session token');
    expect(findings).toEqual([]);
  });
});
