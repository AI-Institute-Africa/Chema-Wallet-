// P10 load + burst test on mocks (docs/10 Capacity: plan 10,000 funerals /
// 300,000 contributors in year 1). Dev tool only — imports test harnesses.
//
//   CHEMA_TEST_DATABASE_URL=postgres://chema:change-me@localhost:55432/chema \
//     pnpm --filter @chema/api load -- --wallets 40 --contributions 4000 --concurrency 32
//
// Runs the real services (bus, ledger, payments, contributions, outbox) on a
// throwaway real Postgres database with mock rails:
//   1. burst: N guest contributions spread over W verified wallets, C at a time
//      (latency of initiation = contribute() incl. the mock provider call);
//   2. confirm: every provider callback delivered C at a time, plus duplicates
//      of 10% of them (webhook + worker);
//   3. settle: outbox relay + settlement worker;
//   4. checks: every payment credited exactly once, ledger sums to zero, each
//      wallet total = sum of its contributions, audit chain intact.
// Prints a JSON report (pasted into docs/evidence/load-test.md).
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { verifyChain } from '@chema/core';
import { createContributionHarness } from '@chema/contributions/testing';
import { getBalances } from '@chema/ledger';
import { money } from '@chema/shared';
import { realPgTestDb } from '@chema/shared/testing';

function arg(name: string, d: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number.parseInt(process.argv[i + 1] ?? '', 10) : Number.NaN;
  return Number.isSafeInteger(v) && v > 0 ? v : d;
}

/** Timings and rates for the report (not money). */
const ms = (v: number) => Number(v.toFixed(0));
const rate = (perMs: number) => Number((perMs * 1000).toFixed(1));

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank percentile of latencies in ms (timings, not money).
  const rank = Math.trunc((p * sorted.length + 99) / 100);
  const i = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return Number((sorted[i] ?? 0).toFixed(1));
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function main(): Promise<void> {
  const url = process.env['CHEMA_TEST_DATABASE_URL'];
  if (!url) throw new Error('set CHEMA_TEST_DATABASE_URL (docker compose up -d postgres)');
  const W = arg('wallets', 40);
  const N = arg('contributions', 4000);
  const C = arg('concurrency', 32);
  // --keep: leave the throwaway database in place (for the backup/restore drill) and print its name.
  const keep = process.argv.includes('--keep');

  const db = await realPgTestDb(url, C + 8);
  const t = await createContributionHarness({}, { db });
  try {
    const setupStart = performance.now();
    const wallets: { walletId: string; slug: string }[] = [];
    for (let i = 0; i < W; i++) wallets.push(await t.publicWallet());
    const setupMs = performance.now() - setupStart;

    // 1. burst initiation
    const latencies: number[] = [];
    const paymentIds: string[] = [];
    const errors: string[] = [];
    const amounts = new Map<string, bigint>();
    const burstStart = performance.now();
    await pool(
      Array.from({ length: N }, (_v, i) => i),
      C,
      async (i) => {
        const w = wallets[i % W] as { walletId: string; slug: string };
        const minor = BigInt(100 + (i % 50) * 100);
        const phone = `+26377${String(1_000_000 + i).slice(-7)}`;
        const t0 = performance.now();
        try {
          const r = await t.contributions.contribute(
            t.guest(),
            t.input(w.slug, { amount: money(minor, 'USD'), idempotencyKey: `load-${randomUUID()}`, payerPhone: phone, contact: { kind: 'PHONE', value: phone } }),
          );
          latencies.push(performance.now() - t0);
          paymentIds.push(r.payment.id);
          amounts.set(w.walletId, (amounts.get(w.walletId) ?? 0n) + minor);
        } catch (err) {
          errors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        }
      },
    );
    const burstMs = performance.now() - burstStart;

    // 2. confirm (+10% duplicate callbacks)
    const { rows: refs } = await db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE provider_ref IS NOT NULL');
    for (const r of refs) t.ecocash.succeed(r.provider_ref);
    const hooks = t.ecocash.takeWebhooks(t.h.now());
    const withDupes = [...hooks, ...hooks.filter((_h, i) => i % 10 === 0)];
    const confirmStart = performance.now();
    let duplicates = 0;
    await pool(withDupes, C, async (hook) => {
      const r = await t.payments.receiveWebhook('ECOCASH', hook.headers, hook.body);
      if (r.duplicate) duplicates++;
      else await t.payments.processEvent(r.eventRowId);
    });
    const confirmMs = performance.now() - confirmStart;

    // 3. settle (outbox → worker)
    const settleStart = performance.now();
    const settledCount = async () =>
      Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM contribution WHERE settled_state = 'SUCCEEDED'")).rows[0]?.n ?? 0);
    // pump() stops after 10 relay rounds: keep pumping while the outbox still holds PENDING events.
    const pendingOutbox = async () =>
      Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM outbox_event WHERE status = 'PENDING'")).rows[0]?.n ?? 0);
    for (let stalls = 0, last = -1; stalls < 3; ) {
      await t.pump();
      const left = await pendingOutbox();
      if (left === 0 && (await settledCount()) >= paymentIds.length) break;
      stalls = left === last ? stalls + 1 : 0;
      last = left;
    }
    const settleMs = performance.now() - settleStart;
    const contributionsSettled = await settledCount();

    // 4. checks
    const { rows: states } = await db.query<{ state: string; n: string }>('SELECT state, count(*)::text AS n FROM payment GROUP BY state');
    const { rows: credits } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM ledger_journal WHERE kind = 'CONTRIBUTION'",
    );
    const { rows: sum } = await db.query<{ net: string }>(
      "SELECT coalesce(sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END), 0)::text AS net FROM ledger_entry",
    );
    let walletMismatches = 0;
    for (const w of wallets) {
      const b = (await getBalances(db, w.walletId)).find((x) => x.account.kind === 'COMMUNITY');
      if ((b?.settled.minor ?? 0n) !== (amounts.get(w.walletId) ?? 0n)) walletMismatches++;
    }
    const chain = await verifyChain(db);

    latencies.sort((a, b) => a - b);
    const database = (await db.query<{ d: string }>('SELECT current_database() AS d')).rows[0]?.d;
    const report = {
      kept: keep ? database : undefined,
      config: { wallets: W, contributions: N, concurrency: C, database: 'PostgreSQL 16 (docker)', rails: 'mock' },
      setup: { walletsVerifiedMs: ms(setupMs) },
      burst: {
        ok: paymentIds.length,
        errors: errors.length,
        errorSamples: [...new Set(errors)].slice(0, 5),
        wallMs: ms(burstMs),
        perSecond: rate(paymentIds.length / burstMs),
        initiationMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: pct(latencies, 100) },
      },
      confirm: { callbacks: withDupes.length, duplicatesRejected: duplicates, wallMs: ms(confirmMs), perSecond: rate(withDupes.length / confirmMs) },
      settle: { wallMs: ms(settleMs), perSecond: rate(contributionsSettled / settleMs) },
      checks: {
        paymentStates: Object.fromEntries(states.map((s) => [s.state, Number(s.n)])),
        contributionJournals: Number(credits[0]?.n ?? 0),
        contributionsSettled,
        exactlyOnceCredit: Number(credits[0]?.n ?? 0) === paymentIds.length,
        ledgerNet: sum[0]?.net,
        walletTotalsMatch: walletMismatches === 0,
        auditChain: chain,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const pass = errors.length === 0 && contributionsSettled === paymentIds.length && report.checks.exactlyOnceCredit && sum[0]?.net === '0' && walletMismatches === 0;
    process.exitCode = pass ? 0 : 1;
  } finally {
    if (keep) process.exit(process.exitCode ?? 0); // skip close(): it drops the database
    await t.close();
    await db.close().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
