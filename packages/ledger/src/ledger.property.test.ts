// Model-based property tests (docs/04 §9, docs/14 §L): random sequences of
// ledger operations run against the real library + PGlite and against a tiny
// in-memory model. After every step the outcome (ok / which error) and every
// balance bucket must match the model; after every run the books are checked
// with raw SQL for the global invariants.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, type SqlClient } from '@chema/shared';
import { migratedTestDb } from '@chema/shared/testing';
import {
  getBalances,
  placeHold,
  post,
  release,
  releaseHold,
  reserve,
  reverse,
  type HoldInput,
  type JournalInput,
  type LedgerAccount,
} from './index';
import { inTx, seedSystem, seedWallet, TEST_ACTOR, type SystemAccounts, type TestWallet } from './test-support';

let db: SqlClient;
let sys: SystemAccounts;

beforeAll(async () => {
  db = await migratedTestDb();
  sys = await seedSystem(db, 'USD');
});
afterAll(async () => {
  await db.close();
});

const usd = (minor: bigint) => money(minor, 'USD');
const REVIEW = new Date('2026-12-01T00:00:00Z');

// ── Operations ─────────────────────────────────────────────────────────────
type Sub = 0 | 1; // 0 = COMMUNITY, 1 = FIDELITY_BENEFIT
type Op =
  | { t: 'credit'; w: number; s: Sub; amt: bigint }
  | { t: 'debit'; w: number; s: Sub; amt: bigint; to: 'FEES' | 'REFUND_CLEARING' }
  | { t: 'reserve'; w: number; s: Sub; amt: bigint }
  | { t: 'payout'; i: number }
  | { t: 'release'; i: number }
  | { t: 'reverse'; i: number }
  | { t: 'replay'; i: number }
  | { t: 'cross'; w: number; amt: bigint }
  | { t: 'mix'; w: number; amt: bigint }
  | { t: 'exit'; w: number; s: Sub; amt: bigint }
  | { t: 'holdTxn'; i: number; part: bigint }
  | { t: 'holdSource'; w: number; s: Sub }
  | { t: 'releaseHold'; i: number };

const amt = fc.bigInt({ min: 1n, max: 600n });
const w = fc.integer({ min: 0, max: 1 });
const s = fc.constantFrom<Sub>(0, 1);
const i = fc.nat({ max: 1_000 });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('credit' as const), w, s, amt }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('debit' as const), w, s, amt, to: fc.constantFrom('FEES' as const, 'REFUND_CLEARING' as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('reserve' as const), w, s, amt }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('payout' as const), i }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('release' as const), i }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('reverse' as const), i }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('replay' as const), i }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('cross' as const), w, amt }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('mix' as const), w, amt }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('exit' as const), w, s, amt }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('holdTxn' as const), i, part: fc.bigInt({ min: 0n, max: 1_000n }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('holdSource' as const), w, s }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('releaseHold' as const), i }) },
);

// ── Model ──────────────────────────────────────────────────────────────────
interface MJournal {
  id: string;
  input: JournalInput;
  account: string;
  /** Credit-normal effect on the wallet account. */
  delta: bigint;
  isReversal: boolean;
  reversed: boolean;
}
interface MReservation {
  id: string;
  account: string;
  amt: bigint;
  state: 'ACTIVE' | 'RELEASED' | 'CONSUMED';
}
interface MHold {
  id: string;
  active: boolean;
  /** TXN: account + amount + journal; SOURCE: account only. */
  account: string;
  amt: bigint | null;
  journal: MJournal | null;
}

class Model {
  settled = new Map<string, bigint>();
  paid = new Map<string, bigint>();
  journals: MJournal[] = [];
  reservations: MReservation[] = [];
  holds: MHold[] = [];

  reserved(acc: string): bigint {
    return this.reservations.filter((r) => r.account === acc && r.state === 'ACTIVE').reduce((a, r) => a + r.amt, 0n);
  }
  held(acc: string): bigint {
    const spendable = (this.settled.get(acc) ?? 0n) - this.reserved(acc);
    // A TXN hold on a reversed journal no longer counts.
    const active = this.holds.filter((h) => h.active && h.account === acc && !h.journal?.reversed);
    if (active.some((h) => h.amt === null)) return spendable;
    const txn = active.reduce((a, h) => a + (h.amt ?? 0n), 0n);
    return txn > spendable ? spendable : txn;
  }
  available(acc: string): bigint {
    return (this.settled.get(acc) ?? 0n) - this.reserved(acc) - this.held(acc);
  }
  /** What reversing j may take out: available + what is held for j itself. */
  reversible(j: MJournal): bigint {
    const own = this.holds
      .filter((h) => h.active && h.journal === j && h.account === j.account)
      .reduce((a, h) => a + (h.amt ?? 0n), 0n);
    const held = this.held(j.account);
    return this.available(j.account) + (own < held ? own : held);
  }
  apply(acc: string, delta: bigint, payout: boolean): void {
    this.settled.set(acc, (this.settled.get(acc) ?? 0n) + delta);
    if (payout) this.paid.set(acc, (this.paid.get(acc) ?? 0n) - delta);
  }
}

const pick = <T>(xs: readonly T[], n: number): T | undefined => (xs.length === 0 ? undefined : xs[n % xs.length]);

async function outcome<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof Error && err.name.endsWith('Error') && 'code' in err) return { ok: false, error: err.name };
    throw err; // anything that is not a typed ledger error is a bug
  }
}

function run(ws: TestWallet[], m: Model, op: Op): Promise<void> {
  const acct = (wi: number, sub: Sub): LedgerAccount => {
    const wallet = ws[wi] as TestWallet;
    return sub === 0 ? wallet.community : wallet.fidelityBenefit;
  };

  const postJournal = async (input: JournalInput, account: string, delta: bigint, expectErr: string | null) => {
    const r = await outcome(() => inTx(db, (tx) => post(tx, TEST_ACTOR, input)));
    if (expectErr) {
      expect(r).toEqual({ ok: false, error: expectErr });
      return undefined;
    }
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return undefined;
    expect(r.value.replayed).toBe(false);
    m.apply(account, delta, input.kind === 'PAYOUT');
    const j: MJournal = { id: r.value.journalId, input, account, delta, isReversal: false, reversed: false };
    m.journals.push(j);
    return j;
  };

  const twoLeg = (kind: JournalInput['kind'], from: string, to: string, minor: bigint, extra: Partial<JournalInput> = {}): JournalInput => ({
    idempotencyKey: `p:${randomUUID()}`,
    kind,
    ...extra,
    entries: [
      { accountId: from, side: 'D', amount: usd(minor) },
      { accountId: to, side: 'C', amount: usd(minor) },
    ],
  });

  return (async () => {
    switch (op.t) {
      case 'credit': {
        const a = acct(op.w, op.s);
        await postJournal(twoLeg(op.s === 0 ? 'CONTRIBUTION' : 'BENEFIT', sys.providerClearing.id, a.id, op.amt), a.id, op.amt, null);
        return;
      }
      case 'debit': {
        const a = acct(op.w, op.s);
        const to = op.to === 'FEES' ? sys.fees : sys.refundClearing;
        const ok = op.amt <= m.available(a.id);
        await postJournal(twoLeg(op.to === 'FEES' ? 'FEE' : 'REFUND', a.id, to.id, op.amt), a.id, -op.amt, ok ? null : 'InsufficientFundsError');
        return;
      }
      case 'reserve': {
        const a = acct(op.w, op.s);
        const ok = op.amt <= m.available(a.id);
        const r = await outcome(() =>
          inTx(db, (tx) =>
            reserve(tx, TEST_ACTOR, { accountId: a.id, amount: usd(op.amt), ref: { type: 'payout_request', id: randomUUID() }, idempotencyKey: `r:${randomUUID()}` }),
          ),
        );
        if (!ok) {
          expect(r).toEqual({ ok: false, error: 'InsufficientFundsError' });
          return;
        }
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (r.ok) m.reservations.push({ id: r.value.reservationId, account: a.id, amt: op.amt, state: 'ACTIVE' });
        return;
      }
      case 'payout': {
        const res = pick(m.reservations, op.i);
        if (!res) return;
        const input = twoLeg('PAYOUT', res.account, sys.payoutClearing.id, res.amt, { reservationId: res.id });
        const ok = res.state === 'ACTIVE';
        // payout ≤ available at reservation time, and it pays exactly the reservation
        const j = await postJournal(input, res.account, -res.amt, ok ? null : 'ReservationStateError');
        if (j) res.state = 'CONSUMED';
        return;
      }
      case 'release': {
        const res = pick(m.reservations, op.i);
        if (!res) return;
        const r = await outcome(() => inTx(db, (tx) => release(tx, TEST_ACTOR, res.id, 'prop')));
        if (res.state === 'CONSUMED') {
          expect(r).toEqual({ ok: false, error: 'ReservationStateError' });
          return;
        }
        expect(r).toEqual({ ok: true, value: res.state === 'ACTIVE' });
        res.state = 'RELEASED';
        return;
      }
      case 'reverse': {
        const j = pick(m.journals, op.i);
        if (!j) return;
        const r = await outcome(() => inTx(db, (tx) => reverse(tx, TEST_ACTOR, j.id, 'prop')));
        if (j.isReversal) {
          expect(r).toEqual({ ok: false, error: 'LedgerValidationError' });
          return;
        }
        if (j.reversed) {
          expect(r.ok && r.value.replayed).toBe(true);
          return;
        }
        if (j.delta > 0n && j.delta > m.reversible(j)) {
          expect(r).toEqual({ ok: false, error: 'InsufficientFundsError' });
          return;
        }
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (!r.ok) return;
        expect(r.value.replayed).toBe(false);
        j.reversed = true;
        m.apply(j.account, -j.delta, j.input.kind === 'PAYOUT');
        m.journals.push({ id: r.value.journalId, input: j.input, account: j.account, delta: -j.delta, isReversal: true, reversed: false });
        return;
      }
      case 'replay': {
        const j = pick(
          m.journals.filter((x) => !x.isReversal),
          op.i,
        );
        if (!j) return;
        const r = await outcome(() => inTx(db, (tx) => post(tx, TEST_ACTOR, j.input)));
        expect(r).toEqual({ ok: true, value: { journalId: j.id, replayed: true } });
        return;
      }
      case 'cross': {
        const from = acct(op.w, 0);
        const to = acct(1 - op.w, 0);
        await postJournal(twoLeg('ADJUSTMENT', from.id, to.id, op.amt, { reason: 'prop' }), from.id, 0n, 'CrossWalletError');
        return;
      }
      case 'mix': {
        const from = acct(op.w, 0);
        const to = acct(op.w, 1);
        await postJournal(twoLeg('ADJUSTMENT', from.id, to.id, op.amt, { reason: 'prop' }), from.id, 0n, 'CrossSubLedgerError');
        return;
      }
      case 'exit': {
        const a = acct(op.w, op.s);
        await postJournal(twoLeg('REFUND', a.id, sys.suspense.id, op.amt), a.id, 0n, 'SubLedgerExitError');
        return;
      }
      case 'holdTxn': {
        const j = pick(
          m.journals.filter((x) => x.delta > 0n),
          op.i,
        );
        if (!j) return;
        const amount = 1n + (op.part % j.delta);
        const wallet = ws.find((x) => x.community.id === j.account || x.fidelityBenefit.id === j.account) as TestWallet;
        const input: HoldInput = {
          scope: 'TXN',
          walletId: wallet.walletId,
          journalId: j.id,
          amount: usd(amount),
          reasonCode: 'PROP',
          ownerId: 'ops',
          reviewAt: REVIEW,
        };
        const id = await inTx(db, (tx) => placeHold(tx, TEST_ACTOR, input));
        m.holds.push({ id, active: true, account: j.account, amt: amount, journal: j });
        return;
      }
      case 'holdSource': {
        const a = acct(op.w, op.s);
        const id = await inTx(db, (tx) =>
          placeHold(tx, TEST_ACTOR, {
            scope: 'SOURCE',
            walletId: (ws[op.w] as TestWallet).walletId,
            source: { kind: op.s === 0 ? 'COMMUNITY' : 'FIDELITY_BENEFIT' },
            reasonCode: 'PROP',
            ownerId: 'ops',
            reviewAt: REVIEW,
          }),
        );
        m.holds.push({ id, active: true, account: a.id, amt: null, journal: null });
        return;
      }
      case 'releaseHold': {
        const h = pick(m.holds, op.i);
        if (!h) return;
        expect(await inTx(db, (tx) => releaseHold(tx, TEST_ACTOR, h.id, 'prop'))).toBe(h.active);
        h.active = false;
        return;
      }
    }
  })();
}

async function assertMatchesModel(ws: TestWallet[], m: Model): Promise<void> {
  for (const wallet of ws) {
    for (const b of await getBalances(db, wallet.walletId)) {
      const id = b.account.id;
      const got = [b.settled.minor, b.reserved.minor, b.held.minor, b.available.minor, b.paid.minor];
      const want = [m.settled.get(id) ?? 0n, m.reserved(id), m.held(id), m.available(id), m.paid.get(id) ?? 0n];
      expect(got).toEqual(want);
      expect(b.available.minor >= 0n).toBe(true);
    }
  }
}

/** Global invariants, straight from the tables. */
async function assertBooks(): Promise<void> {
  const q = async (sql: string) => (await db.query<{ n: string }>(sql)).rows.map((r) => r.n);
  // Every journal sums to zero per currency.
  expect(
    await q(`SELECT journal_id::text AS n FROM ledger_entry GROUP BY journal_id, currency
             HAVING sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END) <> 0`),
  ).toEqual([]);
  // So the whole ledger sums to zero per currency.
  expect(
    await q(`SELECT currency AS n FROM ledger_entry GROUP BY currency
             HAVING sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END) <> 0`),
  ).toEqual([]);
  // No journal touches more than one wallet (or sub-ledger).
  expect(
    await q(`SELECT e.journal_id::text AS n FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
              WHERE a.wallet_id IS NOT NULL GROUP BY e.journal_id HAVING count(DISTINCT a.id) > 1`),
  ).toEqual([]);
  // A reversal nets its original to zero on every account.
  expect(
    await q(`SELECT r.id::text AS n FROM ledger_journal r JOIN ledger_entry e ON e.journal_id IN (r.id, r.reverses_journal_id)
              WHERE r.reverses_journal_id IS NOT NULL GROUP BY r.id, e.account_id
             HAVING sum(CASE e.side WHEN 'D' THEN e.amount_minor ELSE -e.amount_minor END) <> 0`),
  ).toEqual([]);
  // No wallet account is overdrawn or over-reserved.
  expect(
    await q(`SELECT a.id::text AS n FROM ledger_account a
              WHERE a.wallet_id IS NOT NULL
                AND COALESCE((SELECT sum(CASE side WHEN 'C' THEN amount_minor ELSE -amount_minor END) FROM ledger_entry WHERE account_id = a.id), 0)
                  < COALESCE((SELECT sum(amount_minor) FROM ledger_reservation WHERE account_id = a.id AND released_at IS NULL AND consumed_at IS NULL), 0)`),
  ).toEqual([]);
  // Every payout journal consumed exactly one reservation of the same amount.
  expect(
    await q(`SELECT j.id::text AS n FROM ledger_journal j
              WHERE j.kind = 'PAYOUT' AND j.reverses_journal_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM ledger_reservation r WHERE r.consumed_journal_id = j.id)`),
  ).toEqual([]);
}

describe('ledger properties', () => {
  it('random operation sequences keep the books consistent with the model', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const ws = [await seedWallet(db), await seedWallet(db)];
        const m = new Model();
        for (const op of ops) {
          await run(ws, m, op);
          await assertMatchesModel(ws, m);
        }
        await assertBooks();
      }),
      { numRuns: 100 },
    );
  }, 240_000);
});
