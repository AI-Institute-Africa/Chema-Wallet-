// Secure hand-off (`/h#<token>`, links sent on WhatsApp). The token lives only
// in the URL fragment (never sent to our web server, never in a query string
// or Referer) and is posted to the API in the request BODY. Nothing here logs it.
import { ApiError, type Fetch } from './api';

export type HandoffPurpose = 'LOGIN' | 'PAYOUT_REQUEST' | 'EVIDENCE' | 'PORTAL';

export interface HandoffSummary {
  purpose: HandoffPurpose;
  expiresAt: string;
  summary: Record<string, string>;
}

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

/** `#<token>` → token, or null for anything else (including `#t=…` or extra parts). */
export function handoffToken(hash: string): string | null {
  const v = hash.startsWith('#') ? hash.slice(1) : hash;
  return TOKEN.test(v) ? v : null;
}

/** Where a context-only link continues to. Only a well-formed wallet id is used. */
export function handoffDestination(purpose: HandoffPurpose, walletId: string | null): string {
  const ok = walletId !== null && /^[0-9a-f-]{36}$/i.test(walletId);
  if (!ok) return '/';
  return purpose === 'EVIDENCE' ? `/wallets/${walletId}/evidence` : `/wallets/${walletId}`;
}

export function createHandoffClient(opts: { baseUrl: string; token?: () => string | null; fetch?: Fetch }) {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');
  async function post<T>(path: string, body: unknown, withSession = false): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const session = withSession ? opts.token?.() : null;
    if (session) headers['authorization'] = `Bearer ${session}`;
    // no-referrer: the page URL (with its fragment) never leaves in a Referer.
    const res = await doFetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store', referrerPolicy: 'no-referrer' });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, ((json ?? {}) as { error?: string }).error ?? 'error');
    return json as T;
  }
  return {
    describe: (token: string) => post<HandoffSummary>('/handoff/describe', { token }),
    otp: (token: string) => post<{ challengeId: string }>('/handoff/otp', { token }),
    confirm: (token: string, challengeId: string, code: string) =>
      post<{ purpose: HandoffPurpose; status?: string }>('/handoff/confirm', { token, challengeId, code }),
    open: (token: string) => post<{ purpose: HandoffPurpose; walletId: string | null }>('/handoff/open', { token }, true),
  };
}
