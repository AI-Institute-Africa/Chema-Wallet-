// Concurrency (docs/14 §L "concurrent contributions", phases/P02 Done-when).
//
// Runs twice: on PGlite (always; one connection, so transactions queue) and
// on a real Postgres 16 server when CHEMA_TEST_DATABASE_URL is set — that is
// the run that proves the locking, because there the transactions really
// overlap. CI sets it (see .github/workflows/ci.yml).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, type SqlClient } from '@chema/shared';
import { migratedTestDb, realPgTestDb } from '@chema/shared/testing';
import { getBalances, post, reserve, reverse, type JournalInput } from './index';
import { creditWallet, inTx, seedSystem, seedWallet, TEST_ACTOR, type SystemAccounts } from './test-support';

const usd = (minor: bigint) => money(minor, 'USD');
const REAL_PG = process.env.CHEMA_TEST_DATABASE_URL;

const backends: Array<[name: string, open: () => Promise<SqlClient>]> = [['pglite', migratedTestDb]];
if (REAL_PG) backends.push(['postgres', () => realPgTestDb(REAL_PG, 12)]);

async function settle<T>(tasks: Array<() => Promise<T>>) {
  const results = await Promise.allSettled(tasks.map((t) => t()));
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === 'fulfilled').map((r) => r.value);
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error);
  return { ok, errors };
}

describe.each(backends)('concurrency on %s', (_name, open) => {
  let db: SqlClient;
  let sys: SystemAccounts;

  beforeAll(async () => {
    db = await open();
    sys = await seedSystem(db, 'USD');
  });
  afterAll(async () => {
    await db?.close();
  });

  const reserveTask = (accountId: string, minor: bigint) => () =>
    inTx(db, (tx) =>
      reserve(tx, TEST_ACTOR, { accountId, amount: usd(minor), ref: { type: 'payout_request', id: randomUUID() }, idempotencyKey: `r:${randomUUID()}` }),
    );

  it('parallel reservations never exceed the balance', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    const { ok, errors } = await settle(Array.from({ length: 25 }, () => reserveTask(w.community.id, 100n)));
    expect(ok).toHaveLength(10);
    expect(errors).toHaveLength(15);
    for (const e of errors) expect(e.name).toBe('InsufficientFundsError');
    const [b] = await getBalances(db, w.walletId);
    expect([b?.reserved.minor, b?.available.minor]).toEqual([1_000n, 0n]);
  }, 60_000);

  it('parallel contributions all land, none lost', async () => {
    const w = await seedWallet(db);
    const { ok, errors } = await settle(Array.from({ length: 30 }, (_, i) => () => creditWallet(db, sys, w.community, BigInt(i + 1))));
    expect(errors).toEqual([]);
    expect(ok).toHaveLength(30);
    const [b] = await getBalances(db, w.walletId);
    expect(b?.settled.minor).toBe(465n); // 1 + 2 + … + 30
  }, 60_000);

  it('mixed credits, reservations, payouts and refunds never overdraw', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 500n);

    const payoutTask = (minor: bigint) => async () => {
      const { reservationId } = await reserveTask(w.community.id, minor)();
      return inTx(db, (tx) =>
        post(tx, TEST_ACTOR, {
          idempotencyKey: `p:${randomUUID()}`,
          kind: 'PAYOUT',
          reservationId,
          entries: [
            { accountId: w.community.id, side: 'D', amount: usd(minor) },
            { accountId: sys.payoutClearing.id, side: 'C', amount: usd(minor) },
          ],
        }),
      );
    };
    const refundTask = (minor: bigint) => () =>
      inTx(db, (tx) =>
        post(tx, TEST_ACTOR, {
          idempotencyKey: `f:${randomUUID()}`,
          kind: 'REFUND',
          entries: [
            { accountId: w.community.id, side: 'D', amount: usd(minor) },
            { accountId: sys.refundClearing.id, side: 'C', amount: usd(minor) },
          ],
        }),
      );

    const tasks: Array<() => Promise<unknown>> = [];
    for (let i = 0; i < 12; i++) {
      tasks.push(() => creditWallet(db, sys, w.community, 50n));
      tasks.push(payoutTask(90n));
      tasks.push(refundTask(70n));
      tasks.push(reserveTask(w.community.id, 40n));
    }
    const { errors } = await settle(tasks);
    for (const e of errors) expect(e.name).toBe('InsufficientFundsError');

    const { rows } = await db.query<{ settled: string; reserved: string; credits: string; debits: string }>(
      `SELECT (SELECT COALESCE(sum(CASE side WHEN 'C' THEN amount_minor ELSE -amount_minor END), 0) FROM ledger_entry WHERE account_id = $1)::text AS settled,
              (SELECT COALESCE(sum(amount_minor), 0) FROM ledger_reservation WHERE account_id = $1 AND released_at IS NULL AND consumed_at IS NULL)::text AS reserved,
              (SELECT COALESCE(sum(amount_minor), 0) FROM ledger_entry WHERE account_id = $1 AND side = 'C')::text AS credits,
              (SELECT COALESCE(sum(amount_minor), 0) FROM ledger_entry WHERE account_id = $1 AND side = 'D')::text AS debits`,
      [w.community.id],
    );
    const r = rows[0]!;
    expect(BigInt(r.credits)).toBe(500n + 12n * 50n); // every credit landed
    expect(BigInt(r.settled)).toBeGreaterThanOrEqual(BigInt(r.reserved)); // never overdrawn
    const [b] = await getBalances(db, w.walletId);
    expect(b!.available.minor >= 0n).toBe(true);
    expect(b!.settled.minor).toBe(BigInt(r.credits) - BigInt(r.debits));
  }, 120_000);

  it('the same journal key posted in parallel is written once', async () => {
    const w = await seedWallet(db);
    const key = `same:${randomUUID()}`;
    const { ok, errors } = await settle(Array.from({ length: 12 }, () => () => creditWallet(db, sys, w.community, 250n, key)));
    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.journalId)).size).toBe(1);
    expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
    const [b] = await getBalances(db, w.walletId);
    expect(b?.settled.minor).toBe(250n);
  }, 60_000);

  it('the same payout journal posted in parallel pays once', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    const { reservationId } = await reserveTask(w.community.id, 300n)();
    const input: JournalInput = {
      idempotencyKey: `same-payout:${randomUUID()}`,
      kind: 'PAYOUT',
      reservationId,
      entries: [
        { accountId: w.community.id, side: 'D', amount: usd(300n) },
        { accountId: sys.payoutClearing.id, side: 'C', amount: usd(300n) },
      ],
    };
    const { ok, errors } = await settle(Array.from({ length: 8 }, () => () => inTx(db, (tx) => post(tx, TEST_ACTOR, input))));
    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.journalId)).size).toBe(1);
    const [b] = await getBalances(db, w.walletId);
    expect([b?.settled.minor, b?.paid.minor]).toEqual([700n, 300n]);
  }, 60_000);

  it('parallel reversals of one journal produce one reversal', async () => {
    const w = await seedWallet(db);
    const { journalId } = await creditWallet(db, sys, w.community, 400n);
    const { ok, errors } = await settle(Array.from({ length: 8 }, () => () => inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, 'duplicate'))));
    expect(errors).toEqual([]);
    expect(new Set(ok.map((r) => r.journalId)).size).toBe(1);
    const [b] = await getBalances(db, w.walletId);
    expect(b?.settled.minor).toBe(0n);
  }, 60_000);
});
