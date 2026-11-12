import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from './csp';
import { failureGroups, isUuid, mandateApprovals, overrideStep, reasonsFor, subjectHref } from './portal';

const U = '0b6f3c2a-1d2e-4f5a-8b9c-0d1e2f3a4b5c';

describe('portal helpers', () => {
  it('offers only verify reasons that fit the outcome', () => {
    expect(reasonsFor('APPROVED')).toEqual(['AUTHORITY_SHOWN']);
    expect(reasonsFor('REJECTED')).not.toContain('AUTHORITY_SHOWN');
    expect(reasonsFor('REJECTED')).toContain('IDENTITY_MISMATCH');
  });

  it('maps payout status to the override step', () => {
    expect(overrideStep('RAIL_DOWN')).toBe('REQUEST');
    expect(overrideStep('OVERRIDE_PENDING')).toBe('EXECUTE');
    expect(overrideStep('CONFIRMED')).toBe('NONE');
  });

  it('groups failures by kind, known kinds first, unknown kept', () => {
    const g = failureGroups({ payouts: [{ id: 1 }], zeta: [], whatsapp: [{ id: 2 }, { id: 3 }], notifications: 'bad' });
    expect(g.map((x) => x.kind)).toEqual(['whatsapp', 'notifications', 'payouts', 'zeta']);
    expect(g[0]?.rows).toHaveLength(2);
    expect(g[1]?.rows).toEqual([]);
    expect(failureGroups(null)).toEqual([]);
  });

  it('links approval subjects to their detail screens', () => {
    expect(subjectHref({ subjectType: 'mandate_change', subjectId: U })).toBe(`/mandate/${U}`);
    expect(subjectHref({ subjectType: 'payout_request', subjectId: U })).toBe(`/payouts/${U}`);
    expect(subjectHref({ subjectType: 'payout_request', subjectId: '../x' })).toBeNull();
    expect(subjectHref({ subjectType: 'hold', subjectId: U })).toBeNull();
    expect(mandateApprovals([{ subjectType: 'mandate_change' }, { subjectType: 'hold' }])).toHaveLength(1);
    expect(isUuid(` ${U} `)).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });

  it('builds a nonce CSP without inline scripts', () => {
    const nonce = newNonce();
    const csp = buildCsp({ nonce, apiOrigin: 'http://localhost:7600', dev: false });
    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
