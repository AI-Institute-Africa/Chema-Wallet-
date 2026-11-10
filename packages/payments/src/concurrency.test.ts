// Concurrency of the collection pipeline (docs/14 §L "concurrent contributions",
// docs/04 §4 "same event twice ⇒ one posting").
//
// Runs on PGlite always and on real Postgres 16 when CHEMA_TEST_DATABASE_URL is
// set. Only the real-Postgres run proves anything about races: PGlite has one
// connection, so its transactions never overlap.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlClient } from '@chema/shared';
import { realPgTestDb } from '@chema/shared/testing';
import { createPaymentsHarness, usd, type PaymentsHarness } from './test-support';

const REAL_PG = process.env.CHEMA_TEST_DATABASE_URL;
const backends: Array<[string, (() => Promise<SqlClient>) | undefined]> = [['pglite', undefined]];
if (REAL_PG) backends.push(['postgres', () => realPgTestDb(REAL_PG, 12)]);

describe.each(backends)('payments concurrency on %s', (_name, open) => {
  let t: PaymentsHarness;
  beforeAll(async () => {
    t = await createPaymentsHarness({}, open ? { db: await open() } : {});
  });
  afterAll(async () => {
    await t?.close();
  });

  async function initiated(walletId: string, minor: bigint) {
    const c = await t.h.customer();
    const v = await t.service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(minor), idempotencyKey: `k-${randomUUID()}` });
    return { id: v.id, providerRef: t.ecocash.providerRefFor(v.id)! };
  }

  async function stored(): Promise<string[]> {
    const ids: string[] = [];
    for (const w of t.ecocash.takeWebhooks(new Date(8.64e15))) ids.push((await t.service.receiveWebhook('ECOCASH', w.headers, w.body)).eventRowId);
    return ids;
  }

  async function settled(walletId: string) {
    return (await t.service.balances(walletId)).find((b) => b.account.kind === 'COMMUNITY')!.settled.minor;
  }

  it('concurrent contributions to one wallet: every credit lands, nothing lost or doubled', async () => {
    const walletId = await t.newWallet();
    const payments = [];
    for (let i = 0; i < 12; i++) payments.push(await initiated(walletId, 100n + BigInt(i)));
    // Callbacks are signed at "now" on the harness clock; keep it there.
    for (const p of payments) t.ecocash.succeed(p.providerRef);
    const events = await stored();
    const results = await Promise.all(events.map((id) => t.service.processEvent(id)));
    expect(results.every((r) => r.outcome === 'CREDITED')).toBe(true);
    expect(await settled(walletId)).toBe(payments.reduce((s, _p, i) => s + 100n + BigInt(i), 0n));
  });

  it('the same event processed by many workers at once posts once', async () => {
    const walletId = await t.newWallet();
    const p = await initiated(walletId, 5_00n);
    t.ecocash.succeed(p.providerRef);
    const [eventId] = await stored();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => t.service.processEvent(eventId!)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await settled(walletId)).toBe(5_00n);
    const { rows } = await t.h.db.query("SELECT 1 FROM ledger_journal WHERE idempotency_key = $1", [`payment:${p.id}:credit`]);
    expect(rows).toHaveLength(1);
  });

  it('webhook and status query racing on one payment: one credit', async () => {
    const walletId = await t.newWallet();
    const p = await initiated(walletId, 7_00n);
    t.ecocash.succeed(p.providerRef);
    const [eventId] = await stored();
    t.h.advance(61_000);
    await Promise.allSettled([t.service.processEvent(eventId!), t.service.pollDue(), t.service.processEvent(eventId!)]);
    expect(await settled(walletId)).toBe(7_00n);
  });
});
