import { describe, expect, it } from 'vitest';
import { ApiError, bytesToBase64, createApiClient, draftBody, majorToMinor, type Fetch } from './api';
import { missingLine } from './copy';

describe('web api client', () => {
  it('converts major-unit strings to minor units without floats', () => {
    expect(majorToMinor('1500')).toBe(150000n);
    expect(majorToMinor('1500.5')).toBe(150050n);
    expect(majorToMinor(' 0.07 ')).toBe(7n);
    for (const bad of ['1,500', '1e3', '-5', '1.234', '']) expect(() => majorToMinor(bad)).toThrow(RangeError);
  });

  it('builds the draft body and drops blank optional fields', () => {
    expect(
      draftBody({ deceasedName: ' Rudo ', dateOfDeath: '2026-11-04', funeralLocation: 'Bulawayo', currency: 'USD', target: '', funeralDate: ' ', policyNo: 'FLA-1' }),
    ).toEqual({ deceasedName: 'Rudo', dateOfDeath: '2026-11-04', funeralLocation: 'Bulawayo', currency: 'USD', fidelity: { policyNo: 'FLA-1' } });
    expect(draftBody({ deceasedName: 'A', dateOfDeath: '2026-11-04', funeralLocation: 'B', currency: 'ZWG', target: '20' })).toMatchObject({
      targetMinor: '2000',
    });
  });

  it('base64-encodes bytes', () => {
    expect(bytesToBase64(new TextEncoder().encode('%PDF'))).toBe(Buffer.from('%PDF').toString('base64'));
  });

  it('sends the bearer token and surfaces API errors with the missing list', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fake: Fetch = async (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ error: 'missing_evidence', missing: ['MANDATE'] }), { status: 409 });
    };
    const api = createApiClient({ baseUrl: 'http://api.test/', token: () => 'tok', fetch: fake });
    const err = await api.submit('w-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'missing_evidence', missing: ['MANDATE'] });
    expect(seen[0]?.url).toBe('http://api.test/wallets/w-1/submit');
    expect((seen[0]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('explains missing evidence in plain words', () => {
    expect(missingLine('DEATH_EVIDENCE(DEATH_CERTIFICATE|BURIAL_ORDER)')).toMatch(/proof of death/);
    expect(missingLine('MANDATE:SCAN_PENDING')).toMatch(/still being scanned/);
  });
});
