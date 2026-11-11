// P10 chaos / recovery (phases/P10 Do 3): workers killed mid-payment and
// mid-payout, late and out-of-order provider callbacks, queue replay. Each
// scenario ends with the books checked: money moves once or not at all.
import { getBalances } from '@chema/ledger';
import { money } from '@chema/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PAYOUT_RETRY } from './types';
import { createPayoutHarness, type PayoutHarness } from './test-support';

let t: PayoutHarness;
beforeEach(async () => {
  t = await createPayoutHarness();
});
afterEach(async () => {
  await t.close();
});

async function community(walletId: string) {
  const b = (await getBalances(t.h.db, walletId)).find((x) => x.account.kind === 'COMMUNITY')!;
  return { settled: b.settled.minor, reserved: b.reserved.minor, paid: b.paid.minor };
}
async function payoutStatus(id: string) {
  return (await t.h.db.query<{ status: string }>('SELECT status FROM payout_request WHERE id = $1', [id])).rows[0]?.status;
}
async function journals(kind: string, walletId: string) {
  const { rows } = await t.h.db.query<{ n: string }>(
    `SELECT count(DISTINCT j.id)::text AS n FROM ledger_journal j JOIN ledger_entry e ON e.journal_id = j.id
       JOIN ledger_account a ON a.id = e.account_id WHERE j.kind = $1 AND a.wallet_id = $2`,
    [kind, walletId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** A guest contribution that has reached the provider (INITIATED), not yet confirmed. */
async function initiated(slug: string, minor: bigint) {
  const r = await t.contributions.contribute(t.guest(), t.input(slug, { amount: money(minor, 'USD') }));
  const { rows } = await t.h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [r.payment.id]);
  return { paymentId: r.payment.id, providerRef: rows[0]!.provider_ref };
}

describe('chaos: payout worker killed mid provider call', () => {
  it('lease expires ⇒ the next worker records a timeout and asks the provider; paid once, one journal', async () => {
    const w = await t.fundedWallet(100_00n);
    const payee = await t.activePayee(w.admin, w.approver, w.walletId);
    const plan = await t.requestPayout(w.admin, w.walletId, payee, 40_00n);
    const id = plan.payouts[0]!.id;

    // The worker reaches the provider, the provider accepts, then the process dies
    // before it can record the answer: the call never returns.
    const original = t.ecocash.payout.bind(t.ecocash);
    let reached = false;
    t.ecocash.payout = async (req) => {
      await original(req);
      reached = true;
      return new Promise<never>(() => undefined);
    };
    void t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    for (let i = 0; i < 200 && !reached; i++) await new Promise((r) => setTimeout(r, 10));
    expect(reached).toBe(true);
    expect(await payoutStatus(id)).toBe('SUBMITTING');
    t.ecocash.payout = original;

    // A second worker before the lease runs out leaves it alone.
    await t.payouts.runDue();
    expect(await payoutStatus(id)).toBe('SUBMITTING');

    // After the lease: recorded as a timeout, then polled; the provider has it.
    t.h.advance(PAYOUT_RETRY.leaseMs + 1_000);
    await t.payouts.runDue();
    t.ecocash.payoutSucceed(t.ecocash.payoutRefFor(id)!);
    await t.deliverPayouts(t.ecocash);
    t.h.advance(PAYOUT_RETRY.firstDelayMs * 10);
    await t.payouts.runDue();
    expect(await payoutStatus(id)).toBe('CONFIRMED');

    // One provider-side payout for this reference, one PAYOUT journal, books right.
    expect(t.ecocash.calls.filter((c) => c.op === 'payout' && c.reference === id).length).toBeGreaterThanOrEqual(1);
    expect(new Set(t.ecocash.calls.filter((c) => c.op === 'payout' && c.reference === id).map(() => t.ecocash.payoutRefFor(id))).size).toBe(1);
    expect(await journals('PAYOUT', w.walletId)).toBe(1);
    expect(await community(w.walletId)).toMatchObject({ settled: 60_00n, reserved: 0n, paid: 40_00n });
  });
});

describe('chaos: payment worker killed after the webhook was stored', () => {
  it('the poller resolves it from the provider; the queued event replayed later credits nothing more', async () => {
    const { slug, walletId } = await t.publicWallet();
    const p = await initiated(slug, 25_00n);
    t.ecocash.succeed(p.providerRef);
    // Webhook received and stored (API side), worker dies before processing it.
    const [hook] = t.ecocash.takeWebhooks(t.h.now());
    const stored = await t.payments.receiveWebhook('ECOCASH', hook!.headers, hook!.body);
    expect((await community(walletId)).settled).toBe(0n);

    // Restarted worker: the status poller confirms with the provider.
    t.h.advance(10 * 60_000);
    await t.payments.pollDue();
    expect((await community(walletId)).settled).toBe(25_00n);

    // Queue replay: the stored event is processed (twice), and the same webhook redelivered.
    await t.payments.processEvent(stored.eventRowId);
    await t.payments.processEvent(stored.eventRowId);
    // Redelivering the old signed webhook now is refused outright (replay window passed).
    await expect(t.payments.receiveWebhook('ECOCASH', hook!.headers, hook!.body)).rejects.toMatchObject({ reason: 'STALE_TIMESTAMP' });
    expect((await community(walletId)).settled).toBe(25_00n);
    expect(await journals('CONTRIBUTION', walletId)).toBe(1);
  });
});

describe('chaos: out-of-order provider callbacks', () => {
  it('a late FAILED after SUCCEEDED does not undo the credit or move money', async () => {
    const { slug, walletId } = await t.publicWallet();
    const p = await initiated(slug, 12_00n);
    t.ecocash.succeed(p.providerRef);
    t.ecocash.fail(p.providerRef, 'late decline');
    const hooks = t.ecocash.takeWebhooks(t.h.now());
    expect(hooks).toHaveLength(2);
    for (const h of hooks) {
      const r = await t.payments.receiveWebhook('ECOCASH', h.headers, h.body);
      await t.payments.processEvent(r.eventRowId);
    }
    const { rows } = await t.h.db.query<{ state: string }>('SELECT state FROM payment WHERE id = $1', [p.paymentId]);
    expect(rows[0]!.state).toBe('SUCCEEDED');
    expect((await community(walletId)).settled).toBe(12_00n);
    expect(await journals('CONTRIBUTION', walletId)).toBe(1);
  });

  it('callbacks for many payments delivered in reverse order: each credited once', async () => {
    const { slug, walletId } = await t.publicWallet();
    const ps = [];
    for (let i = 1; i <= 5; i++) ps.push(await initiated(slug, BigInt(i) * 1_00n));
    for (const p of ps) t.ecocash.succeed(p.providerRef);
    const hooks = t.ecocash.takeWebhooks(t.h.now()).reverse();
    for (const h of [...hooks, ...hooks]) {
      const r = await t.payments.receiveWebhook('ECOCASH', h.headers, h.body);
      if (!r.duplicate) await t.payments.processEvent(r.eventRowId);
    }
    expect((await community(walletId)).settled).toBe(15_00n);
    expect(await journals('CONTRIBUTION', walletId)).toBe(5);
  });
});

describe('chaos: outbox queue replay', () => {
  it('settlement and notification jobs replayed after an outage do their work once', async () => {
    const { slug } = await t.publicWallet();
    const p = await initiated(slug, 8_00n);
    t.ecocash.succeed(p.providerRef);
    await t.deliver(t.ecocash);
    await t.pump();
    const before = t.sms.sent.length;
    // The whole queue is replayed (e.g. BullMQ restored from a snapshot).
    await t.contributions.settle(p.paymentId);
    await t.contributions.settle(p.paymentId);
    await t.pump();
    expect(t.sms.sent.length).toBe(before);
    const { rows } = await t.h.db.query<{ n: string }>('SELECT count(*)::text AS n FROM receipt WHERE payment_id = $1', [p.paymentId]);
    expect(rows[0]!.n).toBe('1');
    const { rows: c } = await t.h.db.query<{ settled_state: string }>('SELECT settled_state FROM contribution WHERE payment_id = $1', [p.paymentId]);
    expect(c[0]!.settled_state).toBe('SUCCEEDED');
  });
});
