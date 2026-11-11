// Payout races. Runs on PGlite always and on real Postgres 16 when
// CHEMA_TEST_DATABASE_URL is set; only the real-Postgres run proves anything
// (PGlite has one connection, so transactions never overlap).
import { getBalances } from '@chema/ledger';
import type { SqlClient } from '@chema/shared';
import { realPgTestDb } from '@chema/shared/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayoutHarness, type PayoutHarness } from './test-support';

const REAL_PG = process.env.CHEMA_TEST_DATABASE_URL;
const backends: Array<[string, (() => Promise<SqlClient>) | undefined]> = [['pglite', undefined]];
if (REAL_PG) backends.push(['postgres', () => realPgTestDb(REAL_PG, 14)]);

describe.each(backends)('payout concurrency on %s', (_name, open) => {
  let t: PayoutHarness;
  beforeAll(async () => {
    // Single approval up to 100.00 so every request reserves at once.
    t = await createPayoutHarness({ 'approvals.payout_high_value_minor': '10000' }, open ? { db: await open() } : {});
  });
  afterAll(async () => {
    await t?.close();
  });

  it('parallel payout requests can never reserve more than is available', async () => {
    const w = await t.fundedWallet(100_00n);
    const payee = await t.activePayee(w.admin, w.approver, w.walletId);
    t.ecocash.scenario.outage = true; // keep everything reserved (RETRY), nothing paid
    const N = 10;
    const tokens: string[] = [];
    for (let i = 0; i < N; i++) tokens.push(await t.h.stepUpGrant(w.admin.actor, { action: 'payout.request', subjectType: 'wallet', subjectId: w.walletId }));
    const results = await Promise.allSettled(
      tokens.map((token) =>
        t.payouts.run(
          w.admin.actor,
          t.payouts.payouts.request,
          {
            walletId: w.walletId,
            source: { kind: 'COMMUNITY' },
            currency: 'USD',
            parts: [{ payeeId: payee, amountMinor: 30_00n, purpose: 'PARLOUR' }],
            idempotencyKey: `race-${randomUUID()}`,
          },
          token,
        ),
      ),
    );
    t.ecocash.scenario.outage = false;
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(3); // 3 × 30.00 ≤ 100.00 < 4 × 30.00
    const b = (await getBalances(t.h.db, w.walletId)).find((x) => x.account.kind === 'COMMUNITY')!;
    expect(b.reserved.minor).toBe(90_00n);
    expect(b.available.minor).toBe(10_00n);
  });

  it('two workers submitting the same payout make one provider call and one journal', async () => {
    const w = await t.fundedWallet(50_00n);
    const payee = await t.activePayee(w.admin, w.approver, w.walletId);
    t.ecocash.scenario.outage = true;
    const plan = await t.requestPayout(w.admin, w.walletId, payee, 20_00n);
    t.ecocash.scenario.outage = false;
    const id = plan.payouts[0]!.id;
    const before = t.ecocash.calls.filter((c) => c.op === 'payout' && c.reference === id).length;
    t.h.advance(5 * 60_000);
    await Promise.allSettled([t.payouts.submit(id), t.payouts.submit(id), t.payouts.submit(id)]);
    expect(t.ecocash.calls.filter((c) => c.op === 'payout' && c.reference === id).length - before).toBe(1);
    t.ecocash.payoutSucceed(t.ecocash.payoutRefFor(id)!);
    await Promise.allSettled([t.payouts.poll(id), t.payouts.poll(id), t.payouts.poll(id)]);
    const { rows } = await t.h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ledger_journal WHERE kind = 'PAYOUT' AND idempotency_key = $1",
      [`payout:${id}:confirm`],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
