// Transactions (2026-11-25): the family statement — every money movement on a
// wallet, what it was and where it went — plus the public dated usage list.
import { randomUUID } from 'node:crypto';
import { decideApproval, ForbiddenError } from '@chema/core';
import { csvCell } from '@chema/contributions';
import { getBalances } from '@chema/ledger';
import { money } from '@chema/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPayoutHarness, type PayoutHarness } from './test-support';

let t: PayoutHarness;
beforeEach(async () => {
  t = await createPayoutHarness();
});
afterEach(async () => {
  await t.close();
});

const usd = (m: bigint) => money(m, 'USD');
type Person = Awaited<ReturnType<PayoutHarness['h']['customer']>>;

async function txOf(actor: Person['actor'], walletId: string, extra: { cursor?: string; limit?: number } = {}) {
  return t.h.bus.execute(t.contributions.commands.transactions, { walletId, ...extra }, { actor });
}

/** A guest gift that the provider confirms; returns the payment id. */
async function gift(slug: string, minor: bigint, over: Record<string, unknown> = {}): Promise<string> {
  const r = await t.contributions.contribute(t.guest(), t.input(slug, { amount: usd(minor), ...over }));
  const { rows } = await t.h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [r.payment.id]);
  t.ecocash.succeed(rows[0]?.provider_ref ?? '');
  await t.deliver(t.ecocash);
  await t.pump();
  return r.payment.id;
}

async function payout(admin: Person, approver: Person, walletId: string, payeeId: string, minor: bigint, note?: string) {
  const token = await t.stepUp(admin, 'payout.request', walletId);
  const plan = await t.payouts.requestPayout(
    admin.actor,
    {
      walletId,
      source: { kind: 'COMMUNITY' },
      currency: 'USD',
      parts: [{ payeeId, amountMinor: minor, purpose: 'PARLOUR', ...(note ? { note } : {}) }],
      idempotencyKey: `plan-${randomUUID()}`,
    },
    token,
  );
  await t.payouts.decide(approver.actor, plan.approvalId as string, 'APPROVED');
  return plan.payouts[0]!.id;
}

async function providerPays(payoutId: string) {
  t.ecocash.payoutSucceed(t.ecocash.payoutRefFor(payoutId)!);
  await t.deliverPayouts(t.ecocash);
}

describe('family transactions: what came in and where the money went', () => {
  it('lists contributions (real names, anonymity flagged), payouts with purpose/note/payee, a returned payout, a refund and pending items; balances replay to the ledger', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    const approver = await t.approver(walletId);
    await gift(slug, 100_00n, { payerName: 'Chipo Ndlovu', displayName: 'Chipo' });
    const anonPayment = await gift(slug, 50_00n, { payerName: 'Rudo Moyo', displayName: 'Rudo', anonymous: true });
    const refundPayment = await gift(slug, 30_00n, { payerName: 'Farai Katsande', displayName: 'Farai' });
    const payeeId = await t.activePayee(admin, approver, walletId, { holder: 'Doves Funeral Services' });

    const paid = await payout(admin, approver, walletId, payeeId, 60_00n, 'Coffin and hearse');
    await providerPays(paid);
    const returned = await payout(admin, approver, walletId, payeeId, 10_00n);
    await providerPays(returned);
    t.ecocash.payoutReverse(t.ecocash.payoutRefFor(returned)!);
    await t.deliverPayouts(t.ecocash);

    // Refund of Farai's gift: ops/finance maker + a different checker.
    const maker = await t.h.staff('OPS_FINANCE');
    const checker = await t.h.staff('OPS_FINANCE');
    const input = { paymentId: refundPayment, amount: usd(30_00n), reason: 'sent twice' };
    const { approvalId } = (await t.payments.requestRefund(maker.actor, input)) as { approvalId: string };
    await t.h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: checker.actor });
    await t.payments.requestRefund(maker.actor, { ...input, approvalId });
    await t.deliver(t.ecocash);

    // Still waiting: a payout nobody approved yet, and a gift the provider has not confirmed.
    const token = await t.stepUp(admin, 'payout.request', walletId);
    await t.payouts.requestPayout(
      admin.actor,
      { walletId, source: { kind: 'COMMUNITY' }, currency: 'USD', parts: [{ payeeId, amountMinor: 5_00n, purpose: 'TRANSPORT', note: 'Bus for family' }], idempotencyKey: `plan-${randomUUID()}` },
      token,
    );
    await t.contributions.contribute(t.guest(), t.input(slug, { amount: usd(7_00n), payerName: 'Tendai Late' }));

    const v = await txOf(admin.actor, walletId);

    // Contributions: real names to the family; the anonymous one is flagged.
    const contribs = v.lines.filter((l) => l.kind === 'CONTRIBUTION' && !l.reversal);
    expect(contribs.map((l) => l.contribution?.name).sort()).toEqual(['Chipo Ndlovu', 'Farai Katsande', 'Rudo Moyo']);
    const anon = contribs.find((l) => l.contribution?.name === 'Rudo Moyo')!;
    expect(anon.contribution).toMatchObject({ anonymousPublicly: true, publicName: 'Sympathetic Friend' });
    expect(anon.direction).toBe('IN');
    expect(anon.contribution?.receiptNo).toBeTruthy();

    // Payout: purpose, note, payee label + masked number (never the full number).
    const out = v.lines.find((l) => l.kind === 'PAYOUT' && l.payout?.payoutId === paid && !l.reversal)!;
    expect(out).toMatchObject({ direction: 'OUT', amount: usd(60_00n), source: 'COMMUNITY' });
    expect(out.payout).toMatchObject({ purpose: 'PARLOUR', note: 'Coffin and hearse', payeeLabel: 'Doves Funeral Services' });
    expect(out.payout?.payeeMasked).toMatch(/•••\d{4}$/);
    expect(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))).not.toMatch(/\+2637\d{8}/);

    // Returned by the provider: the reversal line comes back IN and links to the original.
    const reversed = v.lines.find((l) => l.kind === 'PAYOUT' && l.payout?.payoutId === returned && !l.reversal)!;
    const back = v.lines.find((l) => l.reversal && l.reversesId === reversed.id)!;
    expect(back).toMatchObject({ direction: 'IN', amount: usd(10_00n) });
    expect(reversed.reversedById).toBe(back.id);

    // Refund: OUT, linked to Farai's contribution.
    const refund = v.lines.find((l) => l.kind === 'REFUND')!;
    expect(refund).toMatchObject({ direction: 'OUT', amount: usd(30_00n) });
    expect(refund.contribution?.name).toBe('Farai Katsande');

    // Pending: the unapproved payout and the unconfirmed gift.
    expect(v.pending.map((p) => p.type).sort()).toEqual(['CONTRIBUTION', 'PAYOUT']);
    expect(v.pending.find((p) => p.type === 'PAYOUT')?.payout).toMatchObject({ purpose: 'TRANSPORT', note: 'Bus for family' });
    expect(v.pending.find((p) => p.type === 'CONTRIBUTION')?.contribution?.name).toBe('Tendai Late');

    // Newest first, and the running balance ends where the ledger says.
    const seqs = v.lines.map((l) => BigInt(l.seq));
    expect([...seqs].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))).toEqual(seqs);
    const community = (await getBalances(t.h.db, walletId)).find((b) => b.account.kind === 'COMMUNITY')!;
    expect(v.lines.find((l) => l.source === 'COMMUNITY')?.balanceAfter).toEqual(community.settled);
    const sum = v.summary.find((s) => s.source === 'COMMUNITY')!;
    expect(sum.balance).toEqual(community.settled);
    expect(sum.moneyIn.minor - sum.moneyOut.minor).toBe(community.settled.minor);

    // Every family read is a recorded sensitive read.
    const { rows } = await t.h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'wallet.transactions' AND subject_id = $1 AND authz_result = 'ALLOWED' AND reason_code = 'CONTRIBUTOR_NAMES_READ'",
      [walletId],
    );
    expect(rows[0]!.n).toBe(1);
    expect(anonPayment).toBeTruthy();
  });

  it('pages newest first by journal seq', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    for (const m of [1_00n, 2_00n, 3_00n]) await gift(slug, m);
    const first = await txOf(admin.actor, walletId, { limit: 2 });
    expect(first.lines).toHaveLength(2);
    expect(first.nextCursor).toBe(first.lines[1]!.seq);
    const second = await txOf(admin.actor, walletId, { limit: 2, cursor: first.nextCursor! });
    expect(second.lines).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.lines[0]!.amount).toEqual(usd(1_00n));
  });

  it('keeps the Fidelity benefit as its own source', async () => {
    const c = await t.linkedCase('APPROVED');
    await t.contributePaid(c.slug, 20_00n);
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    t.fidelity.pay(c.claimRef, usd(100_00n));
    await t.deliverFidelity();
    const v = await txOf(c.admin.actor, c.walletId);
    const benefit = v.lines.find((l) => l.kind === 'BENEFIT')!;
    expect(benefit).toMatchObject({ source: 'FIDELITY_BENEFIT', direction: 'IN', amount: usd(100_00n), contribution: null });
    expect(benefit.claimRef).toBeTruthy();
    expect(v.summary.map((s) => s.source).sort()).toEqual(['COMMUNITY', 'FIDELITY_BENEFIT']);
  });

  it('who may read: admin and approver yes; strangers, unassigned agents and contributors no (audited)', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    await gift(slug, 5_00n);
    const approver = await t.approver(walletId);
    await expect(txOf(approver.actor, walletId)).resolves.toBeTruthy();
    const stranger = await t.h.customer();
    const agent = await t.h.staff('AGENT');
    for (const who of [stranger, agent]) await expect(txOf(who.actor, walletId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.h.bus.execute(t.contributions.commands.transactions, { walletId }, { actor: t.guest() })).rejects.toBeInstanceOf(ForbiddenError);
    const { rows } = await t.h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'wallet.transactions' AND subject_id = $1 AND authz_result = 'DENIED'",
      [walletId],
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(3);
    expect(admin).toBeTruthy();
  });

  it('CSV export has one row per line, signed amounts from minor units, and neutralised formulas', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    await gift(slug, 12_50n, { payerName: '=HYPERLINK("http://x")', displayName: 'Evil' });
    const v = await txOf(admin.actor, walletId);
    const { csv, filename } = await t.h.bus.execute(t.contributions.commands.transactionsCsv, { walletId }, { actor: admin.actor });
    expect(filename).toMatch(/^chema-.*-transactions\.csv$/);
    const rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('date,status,direction,source,type,description,purpose,note,reference,amount,balance_after,currency');
    expect(rows).toHaveLength(1 + v.lines.length + v.pending.length);
    expect(csv).toContain(',12.50,12.50,USD');
    expect(csv).not.toMatch(/,=HYPERLINK/);
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-12.50', true)).toBe('-12.50');
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });

  it('a payout view now carries the note and the payee label + masked number', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    const approver = await t.approver(walletId);
    await gift(slug, 40_00n);
    const payeeId = await t.activePayee(admin, approver, walletId, { holder: 'Mutare Transport' });
    await payout(admin, approver, walletId, payeeId, 15_00n, 'Bus to Mutare');
    const list = await t.payouts.run(admin.actor, t.payouts.payouts.list, { walletId });
    expect(list[0]).toMatchObject({ purposeNote: 'Bus to Mutare', payeeLabel: 'Mutare Transport' });
    expect(list[0]!.payeeMasked).toMatch(/•••\d{4}$/);
  });
});

describe('public usage: where the money went (contributors)', () => {
  it('dated payouts with purpose and amount only; nothing about the payee, number or note; hidden unless the family shows usage', async () => {
    const { walletId, slug, admin } = await t.publicWallet({ showUsageSummary: true });
    const approver = await t.approver(walletId);
    await gift(slug, 80_00n);
    const payeeId = await t.activePayee(admin, approver, walletId, { holder: 'Doves Funeral Services' });
    const paid = await payout(admin, approver, walletId, payeeId, 70_00n, 'Coffin secret note');
    await providerPays(paid);

    const page = await t.contributions.page(slug);
    expect(page.usage?.payouts).toEqual([{ purpose: 'PARLOUR', amount: usd(70_00n), at: expect.any(String) }]);
    const raw = JSON.stringify(page, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(raw).not.toMatch(/payee|destination|masked|Doves|Coffin secret|note|•••/i);

    await t.h.bus.execute(t.contributions.commands.updatePrivacy, { walletId, settings: { showUsageSummary: false } }, { actor: admin.actor });
    expect((await t.contributions.page(slug)).usage).toBeNull();
  });
});
