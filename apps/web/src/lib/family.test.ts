import { describe, expect, it } from 'vitest';
import { ApiError, type Fetch } from './api';
import { buildCsp, newNonce } from './csp';
import {
  benefitMessage,
  cancellable,
  closureBlockerLabel,
  createFamilyClient,
  explainError,
  labelFor,
  payoutBody,
  payoutStatusLabel,
  purposeLabel,
  sourceKey,
  splitFunds,
  type BenefitStatus,
  type FundsLine,
} from './family';
import { createHandoffClient, handoffDestination, handoffToken } from './handoff';

const m = (minor: string) => ({ minor, ccy: 'USD' as const });
const line = (source: FundsLine['source']): FundsLine => ({
  source,
  labelKey: `funds.source.${source.toLowerCase()}`,
  groupId: null,
  settled: m('100'),
  pending: m('0'),
  held: m('0'),
  available: m('100'),
  paid: m('0'),
});

describe('family display helpers', () => {
  it('keeps the Fidelity benefit apart from community and group money', () => {
    const s = splitFunds([line('COMMUNITY'), line('FIDELITY_BENEFIT'), line('GROUP')]);
    expect(s.community.map((l) => l.source)).toEqual(['COMMUNITY', 'GROUP']);
    expect(s.benefit.map((l) => l.source)).toEqual(['FIDELITY_BENEFIT']);
  });

  it('has a catalogue message for every benefit status', () => {
    const all: BenefitStatus[] = [
      'NOT_LINKED', 'LINK_PENDING', 'DUPLICATE_CLAIM', 'LINK_REJECTED', 'CLAIM_SUBMITTED', 'CLAIM_IN_REVIEW', 'CLAIM_MORE_INFO',
      'CLAIM_DECLINED', 'ROUTE_PENDING', 'ROUTE_BLOCKED', 'PAYMENT_PENDING', 'CREDITED', 'PAID_DIRECT',
    ];
    const texts = all.map(benefitMessage);
    expect(new Set(texts).size).toBe(all.length);
    expect(benefitMessage('CLAIM_DECLINED')).toMatch(/Community contributions are not affected/);
  });

  it('maps codes to catalogue labels with safe fallbacks (never raw codes)', () => {
    expect(purposeLabel('PARLOUR')).toBe('Funeral parlour');
    expect(purposeLabel('NOPE')).toBe('Other approved costs');
    expect(payoutStatusLabel('RAIL_DOWN')).toMatch(/our team is handling it/);
    expect(payoutStatusLabel('SOMETHING_NEW')).not.toMatch(/SOMETHING/);
    expect(closureBlockerLabel('OPEN_PAYOUTS')).toBe('Some payouts are not finished.');
    expect(closureBlockerLabel('NEW_CHECK')).toBe('Another check is not finished yet.');
    expect(labelFor('funds.source.community', 'COMMUNITY')).toBe('Community contributions');
    expect(labelFor('evil.key', 'FIDELITY_BENEFIT')).toBe('Fidelity benefit');
    expect(sourceKey('W:GROUP:abc')).toBe('funds.source.group');
  });

  it('offers cancel only before submission', () => {
    expect(['AWAITING_APPROVAL', 'APPROVED', 'RETRY'].every(cancellable)).toBe(true);
    expect(['SUBMITTED', 'CONFIRMED', 'RAIL_DOWN', 'CANCELLED'].some(cancellable)).toBe(false);
  });

  it('builds the payout body in minor units without floats', () => {
    const b = payoutBody({ source: 'COMMUNITY', currency: 'USD', payeeId: 'p', amount: '150.5', purpose: 'FOOD', note: ' ', idempotencyKey: 'web:k' });
    expect(b).toEqual({ source: { kind: 'COMMUNITY' }, currency: 'USD', parts: [{ payeeId: 'p', amountMinor: '15050', purpose: 'FOOD' }], idempotencyKey: 'web:k' });
    expect(() => payoutBody({ source: 'COMMUNITY', currency: 'USD', payeeId: 'p', amount: '0', purpose: 'FOOD', idempotencyKey: 'k' })).toThrow(RangeError);
    expect(() => payoutBody({ source: 'COMMUNITY', currency: 'USD', payeeId: 'p', amount: '1e3', purpose: 'FOOD', idempotencyKey: 'k' })).toThrow(RangeError);
  });

  it('explains API errors calmly', () => {
    expect(explainError(new ApiError(401, 'unauthenticated'))).toBe('Please sign in to continue.');
    expect(explainError(new ApiError(409, 'insufficient_funds'))).toMatch(/not enough available money/);
    expect(explainError(new ApiError(409, 'closure_blocked'))).toBe('This cannot be done right now (closure blocked).');
    expect(explainError(new ApiError(503, 'fidelity_unavailable'))).toMatch(/Nothing was changed/);
    expect(explainError(new Error('x'))).toBe('Something went wrong. Please try again.');
  });

  it('sends the step-up token as a header, never in the URL', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fake: Fetch = async (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ planId: 'x', approvalId: null, payouts: [], replayed: false }), { status: 201 });
    };
    const c = createFamilyClient({ baseUrl: 'http://api.test', token: () => 'sess', fetch: fake });
    await c.requestPayout('w-1', payoutBody({ source: 'COMMUNITY', currency: 'USD', payeeId: 'p', amount: '1', purpose: 'FOOD', idempotencyKey: 'web:k' }), 'STEPUP');
    expect(seen[0]?.url).toBe('http://api.test/wallets/w-1/payouts');
    const h = seen[0]?.init?.headers as Record<string, string>;
    expect(h['x-step-up-token']).toBe('STEPUP');
    expect(h['authorization']).toBe('Bearer sess');
  });
});

describe('hand-off helpers', () => {
  const tok = 'abcDEF123_-abcDEF123_-xyz';
  it('reads the token only from a bare fragment', () => {
    expect(handoffToken(`#${tok}`)).toBe(tok);
    expect(handoffToken('')).toBeNull();
    expect(handoffToken('#short')).toBeNull();
    expect(handoffToken(`#t=${tok}`)).toBeNull();
    expect(handoffToken(`#${tok}&x=1`)).toBeNull();
  });

  it('continues only to a well-formed wallet id', () => {
    const w = '0b6f3c2a-1d2e-4f5a-8b9c-0d1e2f3a4b5c';
    expect(handoffDestination('EVIDENCE', w)).toBe(`/wallets/${w}/evidence`);
    expect(handoffDestination('PORTAL', w)).toBe(`/wallets/${w}`);
    expect(handoffDestination('PORTAL', '//evil.example')).toBe('/');
    expect(handoffDestination('PORTAL', null)).toBe('/');
  });

  it('posts the token in the body with no referrer, and never in the URL', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fake: Fetch = async (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ purpose: 'LOGIN', expiresAt: '2026-11-11T10:00:00Z', summary: {} }), { status: 200 });
    };
    await createHandoffClient({ baseUrl: 'http://api.test', fetch: fake }).describe(tok);
    expect(seen[0]?.url).toBe('http://api.test/handoff/describe');
    expect(seen[0]?.url).not.toContain(tok);
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ token: tok });
    expect(seen[0]?.init?.referrerPolicy).toBe('no-referrer');
  });
});

describe('CSP', () => {
  it('is nonce-based with strict-dynamic and no inline scripts; eval only in dev', () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
    const prod = buildCsp({ nonce, apiOrigin: 'https://api.example', dev: false });
    const script = prod.split('; ').find((d) => d.startsWith('script-src')) ?? '';
    expect(script).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(prod).toContain('connect-src \'self\' https://api.example');
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).not.toContain('unsafe-eval');
    expect(buildCsp({ nonce, apiOrigin: 'http://localhost:7600', dev: true })).toContain("'unsafe-eval'");
    expect(() => buildCsp({ nonce: "x' 'unsafe-inline", apiOrigin: 'http://a', dev: false })).toThrow(RangeError);
  });
});
