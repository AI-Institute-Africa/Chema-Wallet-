import { describe, expect, it } from 'vitest';
import type { Fetch } from './api';
import { createPublicClient, formatMoney, progressPercent, tokenFromHash } from './public';

describe('public web client', () => {
  it('formats minor units for display without floats', () => {
    expect(formatMoney({ minor: '1050', ccy: 'USD' })).toBe('10.50 USD');
    expect(formatMoney({ minor: '7', ccy: 'ZWG' })).toBe('0.07 ZWG');
  });

  it('progress is integer maths, capped at 100', () => {
    expect(progressPercent({ minor: '2500', ccy: 'USD' }, { minor: '10000', ccy: 'USD' })).toBe(25);
    expect(progressPercent({ minor: '20000', ccy: 'USD' }, { minor: '10000', ccy: 'USD' })).toBe(100);
  });

  it('reads the link token from the fragment only', () => {
    const tok = 'a'.repeat(43);
    expect(tokenFromHash(`#t=${tok}`)).toBe(tok);
    expect(tokenFromHash('#t=short')).toBeNull();
    expect(tokenFromHash('')).toBeNull();
  });

  it('sends the link as a header, never in the URL', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fake: Fetch = async (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response('{}', { status: 200 });
    };
    const c = createPublicClient({ baseUrl: 'http://api.test', fetch: fake });
    await c.contribution('c-1', 'secret-token-value-123456');
    expect(seen[0]?.url).toBe('http://api.test/public/contributions/c-1');
    expect((seen[0]?.init?.headers as Record<string, string>)['x-contribution-token']).toBe('secret-token-value-123456');
  });
});
