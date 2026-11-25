import { describe, expect, it } from 'vitest';
import type { Fetch } from './api';
import type { MoneyJSON } from './public';
import { createFamilyClient, filterLines, groupByDay, payeeText, percentOf, txTitle, type TxLine } from './family';

const usd = (minor: string): MoneyJSON => ({ minor, ccy: 'USD' });
const line = (over: Partial<TxLine>): TxLine => ({
  id: 'j1',
  seq: '1',
  at: '2026-11-20T10:00:00.000Z',
  kind: 'CONTRIBUTION',
  reversal: false,
  reversesId: null,
  reversedById: null,
  direction: 'IN',
  source: 'COMMUNITY',
  groupName: null,
  amount: usd('5000'),
  balanceAfter: usd('5000'),
  approvalRef: null,
  contribution: null,
  payout: null,
  claimRef: null,
  note: null,
  ...over,
});
const contribution = { contributionId: 'c1', name: 'Chipo Ndlovu', publicName: null, anonymousPublicly: false, groupName: null, rail: 'ECOCASH', receiptNo: 'R-1', hasMessage: true };
const payout = { payoutId: 'p1', purpose: 'PARLOUR', note: 'Coffin', payeeLabel: 'Doves Funeral Services', payeeMasked: '+26377•••4567', rail: 'ECOCASH', providerRef: 'X', confirmedAt: null };

describe('transactions display helpers', () => {
  it('titles say who and where', () => {
    expect(txTitle(line({ contribution }))).toBe('Chipo Ndlovu contributed');
    expect(txTitle(line({ kind: 'PAYOUT', direction: 'OUT', payout }))).toBe('Paid Doves Funeral Services (+26377•••4567)');
    expect(txTitle(line({ kind: 'PAYOUT', reversal: true, payout }))).toBe('Returned by the provider: Doves Funeral Services (+26377•••4567)');
    expect(txTitle(line({ kind: 'REFUND', direction: 'OUT', contribution }))).toBe('Refund to Chipo Ndlovu');
    expect(txTitle(line({ kind: 'BENEFIT', source: 'FIDELITY_BENEFIT' }))).toBe('Fidelity benefit received');
    expect(payeeText(null)).toBe('');
  });

  it('filters by direction and groups newest-first lines by day', () => {
    const ls = [line({ id: 'a', at: '2026-11-21T09:00:00.000Z' }), line({ id: 'b', direction: 'OUT', at: '2026-11-21T08:00:00.000Z' }), line({ id: 'c', at: '2026-11-19T08:00:00.000Z' })];
    expect(filterLines(ls, 'IN').map((l) => l.id)).toEqual(['a', 'c']);
    expect(filterLines(ls, 'OUT').map((l) => l.id)).toEqual(['b']);
    expect(filterLines(ls, 'PENDING')).toEqual([]);
    expect(groupByDay(ls).map((g) => g.items.length)).toEqual([2, 1]);
  });

  it('percent from minor units, never NaN', () => {
    expect(percentOf(usd('7000'), usd('10000'))).toBe(70);
    expect(percentOf(usd('1'), usd('3'))).toBe(33);
    expect(percentOf(usd('5'), usd('0'))).toBe(0);
  });

  it('client: transactions with cursor, CSV fetched with the session header', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetchFn: Fetch = async (url, init) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>)['authorization'] ?? null });
      if (url.endsWith('/csv')) return new Response('date\r\n', { status: 200, headers: { 'content-disposition': 'attachment; filename="chema-x-transactions.csv"' } });
      return new Response(JSON.stringify({ walletId: 'w', summary: [], pending: [], lines: [], nextCursor: null }), { status: 200 });
    };
    const c = createFamilyClient({ baseUrl: 'http://api', token: () => 'tok', fetch: fetchFn });
    await c.transactions('w1', '42');
    expect(calls[0]!.url).toBe('http://api/wallets/w1/transactions?cursor=42');
    const csv = await c.transactionsCsv('w1');
    expect(csv).toEqual({ filename: 'chema-x-transactions.csv', csv: 'date\r\n' });
    expect(calls[1]).toEqual({ url: 'http://api/wallets/w1/transactions/csv', auth: 'Bearer tok' });
  });
});
