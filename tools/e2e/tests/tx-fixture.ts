// Family statement fixture (Transactions, 2026-11-25): contributions (one
// anonymous on the public page), a payout with purpose/note/payee, a payout
// returned by the provider, a refund, the Fidelity benefit, and pending items.
import { W, usd } from './support';

const contribution = (name: string, over: Record<string, unknown> = {}) => ({
  contributionId: `c-${name}`,
  name,
  publicName: null,
  anonymousPublicly: false,
  groupName: null,
  rail: 'ECOCASH',
  receiptNo: `R-${name.slice(0, 3).toUpperCase()}`,
  hasMessage: true,
  ...over,
});
const payout = (over: Record<string, unknown> = {}) => ({
  payoutId: 'po-1',
  purpose: 'PARLOUR',
  note: 'Coffin and hearse',
  payeeLabel: 'Doves Funeral Services',
  payeeMasked: '+26377•••4567',
  rail: 'ECOCASH',
  providerRef: 'ECOCASH-PO-1',
  confirmedAt: '2026-11-21T10:00:00.000Z',
  ...over,
});
const base = { reversal: false, reversesId: null, reversedById: null, groupName: null, approvalRef: null, contribution: null, payout: null, claimRef: null, note: null };

export const txFixture = {
  walletId: W,
  summary: [
    { source: 'COMMUNITY', groupName: null, currency: 'USD', moneyIn: usd('18000'), moneyOut: usd('9000'), balance: usd('9000'), pending: usd('700'), available: usd('8500'), reserved: usd('500') },
    { source: 'FIDELITY_BENEFIT', groupName: null, currency: 'USD', moneyIn: usd('100000'), moneyOut: usd('0'), balance: usd('100000'), pending: usd('0'), available: usd('100000'), reserved: usd('0') },
  ],
  pending: [
    { type: 'PAYOUT', id: 'po-3', at: '2026-11-22T09:00:00.000Z', status: 'AWAITING_APPROVAL', direction: 'OUT', source: 'COMMUNITY', amount: usd('500'), payout: payout({ payoutId: 'po-3', purpose: 'TRANSPORT', note: 'Bus for family', confirmedAt: null }), contribution: null },
    { type: 'CONTRIBUTION', id: 'pay-9', at: '2026-11-22T08:00:00.000Z', status: 'INITIATED', direction: 'IN', source: 'COMMUNITY', amount: usd('700'), payout: null, contribution: contribution('Tendai Late') },
  ],
  lines: [
    { ...base, id: 'j7', seq: '7', at: '2026-11-21T12:00:00.000Z', kind: 'REFUND', direction: 'OUT', source: 'COMMUNITY', amount: usd('3000'), balanceAfter: usd('9000'), approvalRef: 'appr-9', contribution: contribution('Farai Katsande') },
    { ...base, id: 'j6', seq: '6', at: '2026-11-21T11:00:00.000Z', kind: 'PAYOUT', reversal: true, reversesId: 'j5', direction: 'IN', source: 'COMMUNITY', amount: usd('1000'), balanceAfter: usd('12000'), payout: payout({ payoutId: 'po-2', note: null }) },
    { ...base, id: 'j5', seq: '5', at: '2026-11-21T10:30:00.000Z', kind: 'PAYOUT', reversedById: 'j6', direction: 'OUT', source: 'COMMUNITY', amount: usd('1000'), balanceAfter: usd('11000'), payout: payout({ payoutId: 'po-2', note: null }) },
    { ...base, id: 'j4', seq: '4', at: '2026-11-21T10:00:00.000Z', kind: 'PAYOUT', direction: 'OUT', source: 'COMMUNITY', amount: usd('6000'), balanceAfter: usd('12000'), payout: payout() },
    { ...base, id: 'j3', seq: '3', at: '2026-11-20T15:00:00.000Z', kind: 'BENEFIT', direction: 'IN', source: 'FIDELITY_BENEFIT', amount: usd('100000'), balanceAfter: usd('100000'), claimRef: 'CLM-77' },
    { ...base, id: 'j2', seq: '2', at: '2026-11-20T09:00:00.000Z', kind: 'CONTRIBUTION', direction: 'IN', source: 'COMMUNITY', amount: usd('5000'), balanceAfter: usd('18000'), contribution: contribution('Rudo Moyo', { anonymousPublicly: true, publicName: 'Sympathetic Friend' }) },
    { ...base, id: 'j1', seq: '1', at: '2026-11-19T09:00:00.000Z', kind: 'CONTRIBUTION', direction: 'IN', source: 'COMMUNITY', amount: usd('13000'), balanceAfter: usd('13000'), contribution: contribution('Chipo Ndlovu') },
  ],
  nextCursor: null,
};
