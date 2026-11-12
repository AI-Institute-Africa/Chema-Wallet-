/// <reference lib="dom" />
// Mock Chema API (in the browser) + page guards: every page must render with
// no console errors, no uncaught exceptions, no CSP violations, and a nonce
// CSP whose nonce is on every script the server sent.
import { expect, type Page, type Request, type Response } from '@playwright/test';

export const API = 'http://localhost:7600';
export const WEB = 'http://localhost:3100';
export const ADMIN = 'http://localhost:3101';

export type Handler = (req: Request, body: unknown) => { status?: number; json?: unknown } | unknown;

export interface Mock {
  calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[];
  unmocked: string[];
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-step-up-token, x-contribution-token, idempotency-key',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

/** Routes: "METHOD /path" → handler result (JSON body, or {status, json}). */
export async function mockApi(page: Page, routes: Record<string, Handler | unknown>): Promise<Mock> {
  const mock: Mock = { calls: [], unmocked: [] };
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const key = `${req.method()} ${url.pathname}`;
    let body: unknown;
    try {
      body = req.postData() ? JSON.parse(req.postData() as string) : undefined;
    } catch {
      body = req.postData();
    }
    mock.calls.push({ method: req.method(), path: url.pathname + url.search, body, headers: req.headers() });
    const h = routes[key];
    if (h === undefined) {
      mock.unmocked.push(key);
      return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) });
    }
    const out = typeof h === 'function' ? (h as Handler)(req, body) : h;
    const shaped = out && typeof out === 'object' && 'status' in (out as object) && 'json' in (out as object) ? (out as { status: number; json: unknown }) : { status: 200, json: out };
    return route.fulfill({ status: shaped.status, headers: CORS, contentType: 'application/json', body: JSON.stringify(shaped.json ?? {}) });
  });
  return mock;
}

export interface Guard {
  errors: string[];
  documents: Response[];
}

export function guard(page: Page): Guard {
  const g: Guard = { errors: [], documents: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') g.errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => g.errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.request().resourceType() === 'document') g.documents.push(r);
  });
  return g;
}

/** The API mocks return 4xx on purpose in some flows; Chromium logs those as console errors. */
const EXPECTED = /Failed to load resource: the server responded with a status of 4\d\d/;

export async function expectClean(page: Page, g: Guard, mock: Mock): Promise<void> {
  expect(g.errors.filter((e) => !EXPECTED.test(e)), 'console/page errors').toEqual([]);
  expect(mock.unmocked, 'API calls without a mock').toEqual([]);
  const doc = g.documents.at(-1);
  expect(doc, 'a document response').toBeTruthy();
  nonceOf((await doc?.allHeaders())?.['content-security-policy'] ?? '');
}

function nonceOf(csp: string): string {
  const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? '';
  const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(script)?.[1];
  expect(nonce, `nonce in script-src: ${script}`).toBeTruthy();
  expect(script).toContain("'strict-dynamic'");
  expect(script).not.toContain("'unsafe-inline'");
  expect(script).not.toContain("'unsafe-eval'");
  return nonce as string;
}

/**
 * Full page load + CSP check: every script element the SERVER rendered carries
 * this response's nonce. (Chunks loaded later by client navigation are trusted
 * through 'strict-dynamic' and carry none, so this runs right after the load.)
 */
export async function open(page: Page, url: string): Promise<Response> {
  const res = await page.goto(url, { waitUntil: 'load' });
  expect(res, `response for ${url}`).toBeTruthy();
  const nonce = nonceOf(res?.headers()['content-security-policy'] ?? '');
  const nonces = await page.evaluate(() => [...document.querySelectorAll('script')].map((s) => s.nonce ?? ''));
  expect(nonces.length).toBeGreaterThan(0);
  for (const n of nonces) expect(n).toBe(nonce);
  return res as Response;
}

export async function signInWeb(page: Page): Promise<void> {
  await page.addInitScript(() => window.sessionStorage.setItem('chema.session', 'test-session-token'));
}

export async function signInStaff(page: Page): Promise<void> {
  await page.addInitScript(() => window.sessionStorage.setItem('chema.staff.session', 'test-staff-token'));
}

export const usd = (minor: string) => ({ minor, ccy: 'USD' });
export const W = '0b6f3c2a-1d2e-4f5a-8b9c-0d1e2f3a4b5c';
export const P1 = '11111111-1111-4111-8111-111111111111';
export const P2 = '22222222-2222-4222-8222-222222222222';
export const C1 = '33333333-3333-4333-8333-333333333333';
export const D1 = '44444444-4444-4444-8444-444444444444';
export const A1 = '55555555-5555-4555-8555-555555555555';
export const M1 = '66666666-6666-4666-8666-666666666666';
export const ME = '77777777-7777-4777-8777-777777777777';
