import { describe, expect, it } from 'vitest';
import { initials, minorToInput, moneyShort, orderRails, quickAmounts, relativeTime, toGo } from './memorial';

const usd = (minor: string) => ({ minor, ccy: 'USD' as const });

describe('memorial display helpers', () => {
  it('formats money without floats', () => {
    expect(moneyShort(usd('145000'))).toBe('$1,450');
    expect(moneyShort(usd('145050'))).toBe('$1,450.50');
    expect(moneyShort(usd('5'))).toBe('$0.05');
    expect(moneyShort({ minor: '3842500', ccy: 'ZWG' })).toBe('ZiG 38,425');
  });
  it('to go / reached', () => {
    expect(toGo(usd('145000'), usd('200000'))).toEqual(usd('55000'));
    expect(toGo(usd('200000'), usd('200000'))).toBeNull();
  });
  it('chips respect the wallet min/max', () => {
    expect(quickAmounts('USD', usd('100'), usd('2500'))).toEqual([500n, 1000n, 2000n]);
    expect(quickAmounts('USD', usd('1'), null)).toEqual([500n, 1000n, 2000n, 5000n]);
    expect(quickAmounts('ZWG', { minor: '1', ccy: 'ZWG' }, { minor: '100000000', ccy: 'ZWG' })).toHaveLength(4);
  });
  it('rails: mobile money first, only what the API returned', () => {
    expect(orderRails(['CARD', 'ECOCASH', 'ONEMONEY'])).toEqual(['ECOCASH', 'ONEMONEY', 'CARD']);
    expect(orderRails(['CARD'])).toEqual(['CARD']);
  });
  it('amount box text', () => {
    expect(minorToInput(2000n)).toBe('20');
    expect(minorToInput(1050n)).toBe('10.50');
  });
  it('initials and relative time', () => {
    expect(initials('Chipo & Family')).toBe('CF');
    expect(initials('Sympathetic Friend')).toBe('SF');
    expect(initials('Farai')).toBe('F');
    const now = new Date('2026-11-11T12:00:00Z');
    expect(relativeTime('2026-11-11T11:45:00Z', now)).toBe('15 min ago');
    expect(relativeTime('2026-11-11T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-01T09:00:00Z', now)).toBe('2026-11-01');
  });
});
