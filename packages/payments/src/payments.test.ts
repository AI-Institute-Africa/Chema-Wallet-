// docs/14 §P against the mock rails. One test per row, named after it.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, ForbiddenError, NotFoundError, ConflictError, SYSTEM_ACTOR } from '@chema/core';
import { reserve } from '@chema/ledger';
import { inTx } from '@chema/ledger/testing';
import { WebhookRejectedError, type MockRail } from '@chema/providers';
import { createPaymentsHarness, usd, type PaymentsHarness } from './test-support';

let t: PaymentsHarness;
beforeAll(async () => {
  t = await createPaymentsHarness();
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  for (const r of [t.ecocash, t.onemoney, t.card]) {
    r.scenario = {};
    r.takeWebhooks(new Date(8.64e15));
  }
});

const key = () => `k-${randomUUID()}`;

async function pay(rail: MockRail, minor: bigint, existingWallet?: string) {
  const walletId = existingWallet ?? (await t.newWallet());
  const c = await t.h.customer();
  const view = await t.service.initiate(c.actor, { walletId, rail: rail.rail, amount: usd(minor), idempotencyKey: key() });
  return { c, walletId, view, providerRef: rail.providerRefFor(view.id) };
}

async function community(walletId: string) {
  const b = (await t.service.balances(walletId)).find((x) => x.account.kind === 'COMMUNITY' && x.account.currency === 'USD');
  if (!b) throw new Error('no community account');
  return { settled: b.settled.minor, pending: b.pending.minor, held: b.held.minor, available: b.available.minor };
}

async function creditJournals(paymentId: string) {
  const { rows } = await t.h.db.query("SELECT id FROM ledger_journal WHERE idempotency_key = $1 AND kind = 'CONTRIBUTION'", [
    `payment:${paymentId}:credit`,
  ]);
  return rows.length;
}

async function exceptionsFor(paymentId: string) {
  const { rows } = await t.h.db.query<{ kind: string; hold_id: string | null }>(
    'SELECT kind, hold_id FROM recon_exception WHERE payment_id = $1 ORDER BY opened_at, kind',
    [paymentId],
  );
  return rows;
}

describe('§P payments (mock rails)', () => {
  it('success: credited once on SUCCEEDED, pending until then, receipt issued', async () => {
    const { c, walletId, view, providerRef } = await pay(t.ecocash, 10_00n);
    expect(view).toMatchObject({ state: 'INITIATED', next: { type: 'PROMPT' }, receiptId: null });
    expect(view.disclosure).toEqual({ totalCharged: usd(10_00n), feePayer: null, providerFee: usd(0n), fxRate: null, expectedCredit: usd(10_00n) });
    expect(await community(walletId)).toMatchObject({ settled: 0n, pending: 10_00n, available: 0n });

    t.ecocash.succeed(providerRef!);
    expect(await t.deliver(t.ecocash)).toEqual([{ outcome: 'CREDITED', duplicate: false }]);

    const after = await t.service.view(c.actor, view.id);
    expect(after.state).toBe('SUCCEEDED');
    expect(after.receiptId).not.toBeNull();
    expect(await community(walletId)).toMatchObject({ settled: 10_00n, pending: 0n, available: 10_00n });
    expect(await creditJournals(view.id)).toBe(1);
    const receipt = await t.service.receipt(c.actor, after.receiptId!);
    expect(receipt).toMatchObject({ paymentId: view.id, net: usd(10_00n), providerRef });
  });

  it('timeout → pending_unknown → resolved by status query', async () => {
    t.ecocash.scenario = { timeout: true };
    const { walletId, view } = await pay(t.ecocash, 7_00n);
    expect(view.state).toBe('PENDING_UNKNOWN');
    t.ecocash.scenario = {};
    // The provider did get it; the payer approves; the callback is lost.
    t.ecocash.succeed(t.ecocash.providerRefFor(view.id)!);
    t.ecocash.takeWebhooks(new Date(8.64e15));
    expect(await community(walletId)).toMatchObject({ settled: 0n, pending: 7_00n });

    t.h.advance(61_000);
    expect((await t.service.pollDue()).polled).toBeGreaterThanOrEqual(1);
    expect(await community(walletId)).toMatchObject({ settled: 7_00n, pending: 0n, available: 7_00n });
    expect(await creditJournals(view.id)).toBe(1);
  });

  it('pending unknown payments back off and, after 72h, stay unknown and are raised (never assumed failed)', async () => {
    t.onemoney.scenario = { timeout: true };
    const { walletId, view } = await pay(t.onemoney, 3_00n);
    t.onemoney.scenario = {};
    for (let i = 0; i < 40; i++) {
      t.h.advance(6 * 3_600_000);
      await t.service.pollDue();
    }
    const { rows } = await t.h.db.query<{ state: string; next_poll_at: Date | null; poll_attempts: number }>(
      'SELECT state, next_poll_at, poll_attempts FROM payment WHERE id = $1',
      [view.id],
    );
    expect(rows[0]).toMatchObject({ state: 'PENDING_UNKNOWN', next_poll_at: null });
    expect(rows[0]!.poll_attempts).toBeLessThan(25);
    expect((await exceptionsFor(view.id)).map((e) => e.kind)).toEqual(['POLL_WINDOW_EXPIRED']);
    expect(await community(walletId)).toMatchObject({ settled: 0n, available: 0n });
  });

  it('delayed callback: nothing until it arrives, then one credit', async () => {
    t.ecocash.scenario = { callbackDelayMs: 10 * 60_000 };
    const { walletId, view, providerRef } = await pay(t.ecocash, 5_00n);
    t.ecocash.succeed(providerRef!);
    expect(await t.deliver(t.ecocash)).toEqual([]);
    expect((await community(walletId)).settled).toBe(0n);
    t.h.advance(10 * 60_000);
    expect(await t.deliver(t.ecocash)).toEqual([{ outcome: 'CREDITED', duplicate: false }]);
    expect(await creditJournals(view.id)).toBe(1);
  });

  it('duplicate callback: one credit', async () => {
    t.ecocash.scenario = { duplicateCallbacks: 2 };
    const { walletId, view, providerRef } = await pay(t.ecocash, 4_00n);
    t.ecocash.succeed(providerRef!);
    expect(await t.deliver(t.ecocash)).toEqual([
      { outcome: 'CREDITED', duplicate: false },
      { outcome: 'CREDITED', duplicate: true },
      { outcome: 'CREDITED', duplicate: true },
    ]);
    // A status query answering after the webhook changes nothing either.
    t.h.advance(61_000);
    await t.service.pollDue();
    expect(await creditJournals(view.id)).toBe(1);
    expect((await community(walletId)).settled).toBe(4_00n);
    const { rows } = await t.h.db.query('SELECT 1 FROM provider_event WHERE provider_ref = $1', [providerRef]);
    expect(rows).toHaveLength(1);
  });

  it('replayed / forged webhook rejected; nothing stored', async () => {
    const { view, providerRef } = await pay(t.card, 6_00n);
    t.card.succeed(providerRef!);
    const [w] = t.card.takeWebhooks();
    const forged = w!.body.replace('"minor":"600"', '"minor":"600000"');
    await expect(t.service.receiveWebhook('CARD', w!.headers, forged)).rejects.toMatchObject({ reason: 'BAD_SIGNATURE' });
    await expect(t.service.receiveWebhook('CARD', { ...w!.headers, 'x-chema-signature': undefined }, w!.body)).rejects.toBeInstanceOf(
      WebhookRejectedError,
    );
    // Same delivery replayed inside the window: stored once, processed once.
    const first = await t.service.receiveWebhook('CARD', w!.headers, w!.body);
    const again = await t.service.receiveWebhook('CARD', w!.headers, w!.body);
    expect(again).toEqual({ eventRowId: first.eventRowId, duplicate: true });
    await t.service.processEvent(first.eventRowId);
    expect(await t.service.processEvent(first.eventRowId)).toMatchObject({ outcome: 'CREDITED' });
    expect(await creditJournals(view.id)).toBe(1);
    // Replayed after the window: refused before any storage.
    t.h.advance(6 * 60_000);
    await expect(t.service.receiveWebhook('CARD', w!.headers, w!.body)).rejects.toMatchObject({ reason: 'STALE_TIMESTAMP' });
    const { rows } = await t.h.db.query('SELECT 1 FROM provider_event WHERE provider_ref = $1', [providerRef]);
    expect(rows).toHaveLength(1);
  });

  it('provider outage: FAILED, no credit, a new attempt works once the provider is back', async () => {
    t.onemoney.scenario = { outage: true };
    const walletId = await t.newWallet();
    const { view } = await pay(t.onemoney, 2_00n, walletId);
    expect(view).toMatchObject({ state: 'FAILED', receiptId: null });
    expect(await community(walletId)).toMatchObject({ settled: 0n, pending: 0n });
    t.onemoney.scenario = {};
    const retry = await pay(t.onemoney, 2_00n, walletId);
    expect(retry.view.state).toBe('INITIATED');
  });

  it('partial settlement: credit stands, recon raises a variance with a hold on that payment only', async () => {
    t.ecocash.scenario = { settleShortMinor: 3_00n };
    const { walletId, view, providerRef } = await pay(t.ecocash, 10_00n);
    t.ecocash.succeed(providerRef!, '2026-11-20');
    await t.deliver(t.ecocash);
    const opsfin = await t.h.staff('OPS_FINANCE');
    await t.service.runRecon(opsfin.actor, 'ECOCASH', '2026-11-20');
    const ex = await exceptionsFor(view.id);
    expect(ex.map((e) => e.kind)).toEqual(['AMOUNT_VARIANCE']);
    expect(await community(walletId)).toMatchObject({ settled: 10_00n, held: 3_00n, available: 7_00n });
    const { rows } = await t.h.db.query<{ scope: string; amount_minor: string }>(
      'SELECT scope, amount_minor::text AS amount_minor FROM hold WHERE wallet_id = $1',
      [walletId],
    );
    expect(rows).toEqual([{ scope: 'TXN', amount_minor: '300' }]);
  });

  it('fee/FX variance: a provider fee different from the disclosed one is raised, not absorbed silently', async () => {
    t.ecocash.scenario = { providerFeeMinor: 25n };
    const { walletId, view, providerRef } = await pay(t.ecocash, 8_00n);
    expect(view.disclosure.fxRate).toBeNull();
    t.ecocash.succeed(providerRef!);
    await t.deliver(t.ecocash);
    expect((await exceptionsFor(view.id)).map((e) => e.kind)).toEqual(['FEE_VARIANCE']);
    expect((await community(walletId)).settled).toBe(8_00n);
  });

  it('confirmed amount differs: never credit more than asked; excess parked in suspense', async () => {
    t.card.scenario = { confirmDeltaMinor: 50n };
    const over = await pay(t.card, 10_00n);
    t.card.succeed(over.providerRef!);
    await t.deliver(t.card);
    expect((await community(over.walletId)).settled).toBe(10_00n);
    expect((await exceptionsFor(over.view.id)).map((e) => e.kind)).toEqual(['AMOUNT_VARIANCE']);

    t.card.scenario = { confirmDeltaMinor: -1_00n };
    const under = await pay(t.card, 10_00n);
    t.card.succeed(under.providerRef!);
    await t.deliver(t.card);
    expect((await community(under.walletId)).settled).toBe(9_00n);
  });

  it('chargeback: dispute holds only the disputed amount; chargeback takes it back with a case', async () => {
    const { walletId, view, providerRef } = await pay(t.card, 100_00n);
    t.card.succeed(providerRef!);
    await t.deliver(t.card);
    const dispute = t.card.openDispute(providerRef!, usd(40_00n));
    expect(await t.deliver(t.card)).toEqual([{ outcome: 'HOLD_PLACED', duplicate: false }]);
    expect(await community(walletId)).toMatchObject({ held: 40_00n, available: 60_00n });

    t.card.chargeback(providerRef!, usd(40_00n), dispute);
    expect(await t.deliver(t.card)).toEqual([{ outcome: 'CHARGED_BACK', duplicate: false }]);
    expect(await community(walletId)).toMatchObject({ settled: 60_00n, held: 0n, available: 60_00n });
    const { rows } = await t.h.db.query("SELECT 1 FROM case_record WHERE case_type = 'CHARGEBACK' AND payment_id = $1", [view.id]);
    expect(rows).toHaveLength(1);
    expect((await t.service.view((await t.h.staff('OPS_FINANCE')).actor, view.id)).state).toBe('SUCCEEDED');
  });

  it('chargeback after the money is committed: recovers what is there, shortfall to suspense + exception, never negative', async () => {
    const { walletId, view, providerRef } = await pay(t.card, 50_00n);
    t.card.succeed(providerRef!);
    await t.deliver(t.card);
    const { rows: acct } = await t.h.db.query<{ credit_account_id: string }>('SELECT credit_account_id FROM payment WHERE id = $1', [view.id]);
    // A payout in flight has reserved 45.00 (P07 makes this through a command).
    await inTx(t.h.db, (tx) =>
      reserve(tx, SYSTEM_ACTOR, { accountId: acct[0]!.credit_account_id, amount: usd(45_00n), ref: { type: 'test', id: 'x' }, idempotencyKey: key() }),
    );
    const dispute = randomUUID();
    t.card.chargeback(providerRef!, usd(50_00n), dispute);
    expect(await t.deliver(t.card)).toEqual([{ outcome: 'CHARGED_BACK_SHORTFALL', duplicate: false }]);
    expect(await community(walletId)).toMatchObject({ settled: 45_00n, available: 0n });
    expect((await exceptionsFor(view.id)).map((e) => e.kind)).toEqual(['CHARGEBACK_SHORTFALL']);
    const { rows } = await t.h.db.query<{ recovered_minor: string; shortfall_minor: string }>(
      'SELECT recovered_minor::text AS recovered_minor, shortfall_minor::text AS shortfall_minor FROM payment_dispute WHERE dispute_ref = $1',
      [dispute],
    );
    expect(rows[0]).toEqual({ recovered_minor: '500', shortfall_minor: '4500' });
  });

  it('refund: dual-approved, out of the wallet at once, COMPLETED only on provider confirmation', async () => {
    const { walletId, view, providerRef } = await pay(t.ecocash, 20_00n);
    t.ecocash.succeed(providerRef!);
    await t.deliver(t.ecocash);
    const maker = await t.h.staff('OPS_FINANCE');
    const checker = await t.h.staff('OPS_FINANCE');
    const input = { paymentId: view.id, amount: usd(20_00n), reason: 'duplicate contribution' };

    const asked = await t.service.requestRefund(maker.actor, input);
    expect(asked.status).toBe('PENDING_APPROVAL');
    const approvalId = (asked as { approvalId: string }).approvalId;
    await expect(t.h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: maker.actor })).rejects.toBeInstanceOf(ForbiddenError);
    // Not executable before approval.
    await expect(t.service.requestRefund(maker.actor, { ...input, approvalId })).rejects.toMatchObject({ reason: 'NOT_APPROVED' });
    await t.h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: checker.actor });

    const done = await t.service.requestRefund(maker.actor, { ...input, approvalId });
    expect(done).toMatchObject({ status: 'SUBMITTING', submission: 'PENDING_PROVIDER' });
    expect(await community(walletId)).toMatchObject({ settled: 0n, available: 0n });
    expect((await t.service.view(maker.actor, view.id)).state).toBe('SUCCEEDED');

    expect(await t.deliver(t.ecocash)).toEqual([{ outcome: 'REFUND_COMPLETED', duplicate: false }]);
    expect((await t.service.view(maker.actor, view.id)).state).toBe('REFUNDED');
    // The approval is single use.
    await expect(t.service.requestRefund(maker.actor, { ...input, approvalId })).rejects.toBeInstanceOf(ConflictError);
  });

  it('refund refused by the provider: debit reversed, money back in the wallet', async () => {
    const { walletId, view, providerRef } = await pay(t.onemoney, 9_00n);
    t.onemoney.succeed(providerRef!);
    await t.deliver(t.onemoney);
    const maker = await t.h.staff('OPS_FINANCE');
    const checker = await t.h.staff('OPS_FINANCE');
    const input = { paymentId: view.id, amount: usd(4_00n), reason: 'partial refund' };
    const { approvalId } = (await t.service.requestRefund(maker.actor, input)) as { approvalId: string };
    await t.h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: checker.actor });
    t.onemoney.scenario = { refundFails: true };
    await t.service.requestRefund(maker.actor, { ...input, approvalId });
    expect((await community(walletId)).available).toBe(5_00n);
    expect(await t.deliver(t.onemoney)).toEqual([{ outcome: 'REFUND_FAILED', duplicate: false }]);
    expect(await community(walletId)).toMatchObject({ settled: 9_00n, available: 9_00n });
    expect((await t.service.view(maker.actor, view.id)).state).toBe('SUCCEEDED');
  });

  it('wrong destination: money confirmed into another merchant account is not credited', async () => {
    t.ecocash.scenario = { wrongMerchant: true };
    const { walletId, view, providerRef } = await pay(t.ecocash, 3_00n);
    t.ecocash.succeed(providerRef!);
    expect(await t.deliver(t.ecocash)).toEqual([{ outcome: 'WRONG_DESTINATION', duplicate: false }]);
    expect((await community(walletId)).settled).toBe(0n);
    expect((await exceptionsFor(view.id)).map((e) => e.kind)).toEqual(['WRONG_DESTINATION']);
    expect(await creditJournals(view.id)).toBe(0);
  });

  it('disabled rail: absent from the list, 404 on initiate and webhook', async () => {
    const t2 = await createPaymentsHarness({ 'rail.card': 'false' });
    try {
      expect(await t2.service.listRails()).toEqual(['ECOCASH', 'ONEMONEY']);
      const c = await t2.h.customer();
      await expect(
        t2.service.initiate(c.actor, { walletId: (await t2.newWallet()), rail: 'CARD', amount: usd(1_00n), idempotencyKey: key() }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(t2.service.receiveWebhook('CARD', {}, '{}')).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        t2.service.initiate(c.actor, { walletId: (await t2.newWallet()), rail: 'BANK', amount: usd(1_00n), idempotencyKey: key() }),
      ).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await t2.close();
    }
  });

  it('receipt only on success', async () => {
    t.card.scenario = { reject: true };
    const failed = await pay(t.card, 1_00n);
    expect(failed.view).toMatchObject({ state: 'FAILED', receiptId: null });
    t.card.scenario = {};
    const open = await pay(t.card, 1_00n);
    t.card.fail(open.providerRef!);
    await t.deliver(t.card);
    const { rows } = await t.h.db.query('SELECT 1 FROM receipt WHERE payment_id IN ($1, $2)', [failed.view.id, open.view.id]);
    expect(rows).toHaveLength(0);
    expect((await t.service.view(open.c.actor, open.view.id)).state).toBe('FAILED');
  });

  it('receipt retrievable when the notification fails', async () => {
    const { c, view, providerRef } = await pay(t.ecocash, 2_50n);
    t.ecocash.succeed(providerRef!);
    await t.deliver(t.ecocash);
    // The notification is an outbox job delivered after commit; mark it failed as a dead provider would.
    const { rows: jobs } = await t.h.db.query<{ id: string; payload: { receiptId: string } }>(
      "SELECT id, payload FROM outbox_event WHERE topic = 'receipt.notify' ORDER BY created_at DESC LIMIT 1",
    );
    await t.h.db.query("UPDATE outbox_event SET status = 'FAILED', attempts = 20, last_error = 'sms down' WHERE id = $1", [jobs[0]!.id]);
    const after = await t.service.view(c.actor, view.id);
    expect(after.state).toBe('SUCCEEDED');
    expect(jobs[0]!.payload.receiptId).toBe(after.receiptId);
    expect((await t.service.receipt(c.actor, after.receiptId!)).paymentId).toBe(view.id);
    // Someone else's receipt is not theirs to read.
    const other = await t.h.customer();
    await expect(t.service.receipt(other.actor, after.receiptId!)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('collection gates and idempotency', () => {
  it('an unverified wallet cannot take money; contributions kill switch', async () => {
    const c = await t.h.customer();
    await expect(
      t.service.initiate(c.actor, { walletId: randomUUID(), rail: 'ECOCASH', amount: usd(1_00n), idempotencyKey: key() }),
    ).rejects.toMatchObject({ reason: 'WALLET_NOT_ACCEPTING_CONTRIBUTIONS' });
    const off = await createPaymentsHarness({ 'contributions.enabled': 'false' });
    try {
      const c2 = await off.h.customer();
      await expect(
        off.service.initiate(c2.actor, { walletId: (await off.newWallet()), rail: 'ECOCASH', amount: usd(1_00n), idempotencyKey: key() }),
      ).rejects.toMatchObject({ reason: 'CONTRIBUTIONS_DISABLED' });
    } finally {
      await off.close();
    }
  });

  it('same key + same request ⇒ same payment, provider asked once; same key + different request ⇒ conflict', async () => {
    const c = await t.h.customer();
    const walletId = await t.newWallet();
    const k = key();
    const before = t.ecocash.calls.length;
    const a = await t.service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(5_00n), idempotencyKey: k });
    const b = await t.service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(5_00n), idempotencyKey: k });
    expect(b).toMatchObject({ id: a.id, replayed: true });
    expect(t.ecocash.calls.length - before).toBe(1);
    await expect(t.service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(6_00n), idempotencyKey: k })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('fees: with a schedule and fees.enabled the payer sees the fee before paying and FEES gets it', async () => {
    const f = await createPaymentsHarness({ 'fees.enabled': 'true' });
    try {
      await f.h.db.query(
        "INSERT INTO fee_schedule (rail, currency, fee_payer, fixed_minor, rate_bps, effective_from) VALUES ('ECOCASH', 'USD', 'CONTRIBUTOR', 10, 150, '2026-01-01')",
      );
      const c = await f.h.customer();
      const walletId = await f.newWallet();
      const v = await f.service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(20_00n), idempotencyKey: key() });
      // 0.10 + 1.5% of 20.00 = 0.40, added on top.
      expect(v.disclosure).toEqual({ totalCharged: usd(20_40n), feePayer: 'CONTRIBUTOR', providerFee: usd(40n), fxRate: null, expectedCredit: usd(20_00n) });
      f.ecocash.scenario = { providerFeeMinor: 40n };
      f.ecocash.succeed(f.ecocash.providerRefFor(v.id)!);
      await f.deliver(f.ecocash);
      const b = (await f.service.balances(walletId)).find((x) => x.account.kind === 'COMMUNITY')!;
      expect(b.settled.minor).toBe(20_00n);
      const { rows } = await f.h.db.query<{ bal: string }>(
        `SELECT sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END)::text AS bal
           FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE a.kind = 'FEES'`,
      );
      expect(rows[0]!.bal).toBe('40');
      const { rows: ex } = await f.h.db.query('SELECT 1 FROM recon_exception');
      expect(ex).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
