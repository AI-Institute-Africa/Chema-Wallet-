// The ledger library, example by example (docs/14 §L). Property and
// concurrency suites live next to this file.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, type Money, type SqlClient } from '@chema/shared';
import { insertTestWallet, migratedTestDb } from '@chema/shared/testing';
import {
  accountCode,
  AlreadyReversedError,
  bootstrapWalletAccounts,
  CrossSubLedgerError,
  CrossWalletError,
  ensureGroupAccount,
  ensureSystemAccount,
  getBalances,
  getStatement,
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerValidationError,
  placeHold,
  post,
  release,
  releaseHold,
  ReservationStateError,
  reserve,
  reverse,
  SubLedgerExitError,
  UnbalancedJournalError,
  UnknownAccountError,
  UnknownWalletError,
  type JournalInput,
  type LedgerAccount,
  type SubLedgerBalance,
} from './index';
import {
  creditWallet,
  inTx,
  seedSystem,
  seedWallet,
  TEST_ACTOR,
  type SystemAccounts,
  type TestWallet,
} from './test-support';

let db: SqlClient;
let sys: SystemAccounts;

beforeAll(async () => {
  db = await migratedTestDb();
  sys = await seedSystem(db, 'USD');
});
afterAll(async () => {
  await db.close();
});

const usd = (minor: bigint): Money => money(minor, 'USD');
const key = (): string => `t:${randomUUID()}`;
const REVIEW = new Date('2026-12-01T00:00:00Z');

async function bucket(w: TestWallet, account: LedgerAccount = w.community): Promise<SubLedgerBalance> {
  const found = (await getBalances(db, w.walletId)).find((b) => b.account.id === account.id);
  if (!found) throw new Error('no balance row');
  return found;
}

/** settled / reserved / held / available / paid as plain bigints. */
async function figures(w: TestWallet, account: LedgerAccount = w.community) {
  const b = await bucket(w, account);
  return {
    settled: b.settled.minor,
    reserved: b.reserved.minor,
    held: b.held.minor,
    available: b.available.minor,
    paid: b.paid.minor,
  };
}

const doPost = (input: JournalInput) => inTx(db, (tx) => post(tx, TEST_ACTOR, input));

function debitWallet(account: LedgerAccount, to: LedgerAccount, minor: bigint, kind: JournalInput['kind'] = 'REFUND') {
  return doPost({
    idempotencyKey: key(),
    kind,
    entries: [
      { accountId: account.id, side: 'D', amount: usd(minor) },
      { accountId: to.id, side: 'C', amount: usd(minor) },
    ],
  });
}

async function payOut(w: TestWallet, minor: bigint, account: LedgerAccount = w.community) {
  const { reservationId } = await inTx(db, (tx) =>
    reserve(tx, TEST_ACTOR, { accountId: account.id, amount: usd(minor), ref: { type: 'payout_request', id: randomUUID() }, idempotencyKey: key() }),
  );
  const journal: JournalInput = {
    idempotencyKey: key(),
    kind: 'PAYOUT',
    reservationId,
    entries: [
      { accountId: account.id, side: 'D', amount: usd(minor) },
      { accountId: sys.payoutClearing.id, side: 'C', amount: usd(minor) },
    ],
  };
  return { reservationId, journal, result: await doPost(journal) };
}

describe('accounts', () => {
  it('bootstraps a wallet idempotently and names accounts', async () => {
    const walletId = await insertTestWallet(db, randomUUID());
    const first = await inTx(db, (tx) => bootstrapWalletAccounts(tx, walletId, 'USD'));
    const again = await inTx(db, (tx) => bootstrapWalletAccounts(tx, walletId, 'USD'));
    expect(again).toEqual(first);
    const group = await inTx(db, (tx) => ensureGroupAccount(tx, walletId, 'st-marys', 'USD'));
    expect(accountCode(first.community)).toBe('W:COMMUNITY');
    expect(accountCode(first.fidelityBenefit)).toBe('W:FIDELITY_BENEFIT');
    expect(accountCode(group)).toBe('W:GROUP:st-marys');
    expect(accountCode(sys.providerClearing)).toBe('SYS:PROVIDER_CLEARING:MOCK');
    expect(accountCode(sys.suspense)).toBe('SYS:SUSPENSE_UNMATCHED');
    expect((await getBalances(db, walletId)).map((b) => b.code)).toEqual([
      'W:COMMUNITY',
      'W:FIDELITY_BENEFIT',
      'W:GROUP:st-marys',
    ]);
  });

  it('validates rails and group ids', async () => {
    await expect(inTx(db, (tx) => ensureSystemAccount(tx, 'PROVIDER_CLEARING', 'USD'))).rejects.toThrow(LedgerValidationError);
    await expect(inTx(db, (tx) => ensureSystemAccount(tx, 'FEES', 'USD', 'MOCK'))).rejects.toThrow(LedgerValidationError);
    await expect(inTx(db, (tx) => ensureSystemAccount(tx, 'PAYOUT_CLEARING', 'USD', 'eco cash'))).rejects.toThrow(LedgerValidationError);
    await expect(inTx(db, (tx) => ensureGroupAccount(tx, randomUUID(), 'a b', 'USD'))).rejects.toThrow(LedgerValidationError);
    await expect(inTx(db, (tx) => bootstrapWalletAccounts(tx, 'not-a-uuid', 'USD'))).rejects.toThrow(LedgerValidationError);
  });
});

describe('post', () => {
  it('credits a contribution, with the fee split to SYS:FEES', async () => {
    const w = await seedWallet(db);
    await doPost({
      idempotencyKey: key(),
      kind: 'CONTRIBUTION',
      entries: [
        { accountId: sys.providerClearing.id, side: 'D', amount: usd(1_000n), providerRef: 'prov-1', txnRef: 'pay-1' },
        { accountId: w.community.id, side: 'C', amount: usd(970n), txnRef: 'pay-1' },
        { accountId: sys.fees.id, side: 'C', amount: usd(30n), txnRef: 'pay-1' },
      ],
    });
    expect(await figures(w)).toEqual({ settled: 970n, reserved: 0n, held: 0n, available: 970n, paid: 0n });
    expect(await figures(w, w.fidelityBenefit)).toEqual({ settled: 0n, reserved: 0n, held: 0n, available: 0n, paid: 0n });
    const [journal] = await getStatement(db, w.walletId);
    expect(journal?.entries.map((e) => [e.lineNo, e.side, e.amount.minor, e.txnRef, e.providerRef])).toEqual([
      [1, 'D', 1_000n, 'pay-1', 'prov-1'],
      [2, 'C', 970n, 'pay-1', null],
      [3, 'C', 30n, 'pay-1', null],
    ]);
    expect(journal?.actorId).toBe('system');
  });

  it('is idempotent: the same key and content writes nothing new', async () => {
    const w = await seedWallet(db);
    const k = key();
    const first = await creditWallet(db, sys, w.community, 500n, k);
    const second = await creditWallet(db, sys, w.community, 500n, k);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ journalId: first.journalId, replayed: true });
    expect((await figures(w)).settled).toBe(500n);
    expect(await getStatement(db, w.walletId)).toHaveLength(1);
    // Same key, different content: refused, never merged.
    await expect(creditWallet(db, sys, w.community, 501n, k)).rejects.toThrow(IdempotencyConflictError);
    expect((await figures(w)).settled).toBe(500n);
  });

  it('rejects malformed journals before writing', async () => {
    const w = await seedWallet(db);
    const other = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    const pair = (a: string, b: string, da = 100n, cb = 100n): JournalInput => ({
      idempotencyKey: key(),
      kind: 'REFUND',
      entries: [
        { accountId: a, side: 'D', amount: usd(da) },
        { accountId: b, side: 'C', amount: usd(cb) },
      ],
    });
    await expect(doPost(pair(w.community.id, sys.refundClearing.id, 100n, 99n))).rejects.toThrow(UnbalancedJournalError);
    await expect(doPost(pair(w.community.id, other.community.id))).rejects.toThrow(CrossWalletError);
    await expect(doPost(pair(w.community.id, w.fidelityBenefit.id))).rejects.toThrow(CrossSubLedgerError);
    await expect(doPost(pair(w.community.id, sys.suspense.id))).rejects.toThrow(SubLedgerExitError);
    await expect(doPost(pair(w.community.id, sys.providerClearing.id))).rejects.toThrow(SubLedgerExitError);
    await expect(doPost(pair(w.community.id, randomUUID()))).rejects.toThrow(UnknownAccountError);
    await expect(doPost({ ...pair(w.community.id, sys.fees.id), entries: [] })).rejects.toThrow(LedgerValidationError);
    await expect(doPost({ ...pair(w.community.id, sys.fees.id), idempotencyKey: '' })).rejects.toThrow(LedgerValidationError);
    await expect(doPost({ ...pair(w.community.id, sys.fees.id), idempotencyKey: 'reverse:x' })).rejects.toThrow(LedgerValidationError);
    await expect(doPost({ ...pair(w.community.id, sys.fees.id), kind: 'ADJUSTMENT' })).rejects.toThrow(LedgerValidationError);
    await expect(
      doPost({
        idempotencyKey: key(),
        kind: 'CONTRIBUTION',
        entries: [
          { accountId: sys.providerClearing.id, side: 'D', amount: money(100n, 'ZWG') },
          { accountId: w.community.id, side: 'C', amount: money(100n, 'ZWG') },
        ],
      }),
    ).rejects.toThrow(LedgerValidationError);
    // Nothing above reached the books.
    expect((await figures(w)).settled).toBe(1_000n);
    expect(await getStatement(db, w.walletId)).toHaveLength(1);
  });

  it('a failed post leaves the caller’s transaction usable', async () => {
    const w = await seedWallet(db);
    await inTx(db, async (tx) => {
      await expect(
        post(tx, TEST_ACTOR, {
          idempotencyKey: key(),
          kind: 'REFUND',
          entries: [
            { accountId: w.community.id, side: 'D', amount: usd(1n) },
            { accountId: sys.refundClearing.id, side: 'C', amount: usd(1n) },
          ],
        }),
      ).rejects.toThrow(InsufficientFundsError);
      await post(tx, TEST_ACTOR, {
        idempotencyKey: key(),
        kind: 'CONTRIBUTION',
        entries: [
          { accountId: sys.providerClearing.id, side: 'D', amount: usd(5n) },
          { accountId: w.community.id, side: 'C', amount: usd(5n) },
        ],
      });
    });
    expect((await figures(w)).settled).toBe(5n);
  });

  it('never lets a debit exceed the available balance', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    await expect(debitWallet(w.community, sys.refundClearing, 1_001n)).rejects.toThrow(InsufficientFundsError);
    await debitWallet(w.community, sys.refundClearing, 400n);
    await expect(debitWallet(w.community, sys.refundClearing, 601n)).rejects.toThrow(InsufficientFundsError);
    await debitWallet(w.community, sys.refundClearing, 600n);
    expect(await figures(w)).toEqual({ settled: 0n, reserved: 0n, held: 0n, available: 0n, paid: 0n });
  });

  it('keeps community and benefit money apart', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.fidelityBenefit, 50_000n);
    await creditWallet(db, sys, w.community, 300n);
    // The benefit cannot cover a community debit.
    await expect(debitWallet(w.community, sys.refundClearing, 301n)).rejects.toThrow(InsufficientFundsError);
    expect((await figures(w, w.fidelityBenefit)).available).toBe(50_000n);
    expect((await figures(w)).available).toBe(300n);
  });
});

describe('reservations and payouts', () => {
  it('reserve → payout moves reserved to paid; partial payouts add up', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);

    const { reservationId } = await inTx(db, (tx) =>
      reserve(tx, TEST_ACTOR, { accountId: w.community.id, amount: usd(300n), ref: { type: 'payout_request', id: 'pr-1' }, idempotencyKey: 'res-1-' + w.walletId }),
    );
    expect(await figures(w)).toEqual({ settled: 1_000n, reserved: 300n, held: 0n, available: 700n, paid: 0n });

    await doPost({
      idempotencyKey: key(),
      kind: 'PAYOUT',
      reservationId,
      entries: [
        { accountId: w.community.id, side: 'D', amount: usd(300n) },
        { accountId: sys.payoutClearing.id, side: 'C', amount: usd(300n) },
      ],
    });
    expect(await figures(w)).toEqual({ settled: 700n, reserved: 0n, held: 0n, available: 700n, paid: 300n });

    await payOut(w, 450n);
    expect(await figures(w)).toEqual({ settled: 250n, reserved: 0n, held: 0n, available: 250n, paid: 750n });
    await expect(payOut(w, 251n)).rejects.toThrow(InsufficientFundsError);
  });

  it('cannot reserve more than is available, across several requests', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    const res = (minor: bigint, k = key()) =>
      inTx(db, (tx) => reserve(tx, TEST_ACTOR, { accountId: w.community.id, amount: usd(minor), ref: { type: 'payout_request', id: 'x' }, idempotencyKey: k }));
    const k1 = key();
    const first = await res(600n, k1);
    await expect(res(401n)).rejects.toThrow(InsufficientFundsError);
    await res(400n);
    await expect(res(1n)).rejects.toThrow(InsufficientFundsError);
    // Replay of the first request reserves nothing more.
    expect(await res(600n, k1)).toEqual({ reservationId: first.reservationId, replayed: true });
    await expect(res(599n, k1)).rejects.toThrow(IdempotencyConflictError);
    expect(await figures(w)).toEqual({ settled: 1_000n, reserved: 1_000n, held: 0n, available: 0n, paid: 0n });
    // Reserved money cannot be debited by anything else.
    await expect(debitWallet(w.community, sys.refundClearing, 1n)).rejects.toThrow(InsufficientFundsError);
  });

  it('release returns funds; a released or consumed reservation cannot pay', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 500n);
    const mk = () =>
      inTx(db, (tx) => reserve(tx, TEST_ACTOR, { accountId: w.community.id, amount: usd(200n), ref: { type: 'payout_request', id: 'x' }, idempotencyKey: key() }));
    const payout = (reservationId: string, minor = 200n): JournalInput => ({
      idempotencyKey: key(),
      kind: 'PAYOUT',
      reservationId,
      entries: [
        { accountId: w.community.id, side: 'D', amount: usd(minor) },
        { accountId: sys.payoutClearing.id, side: 'C', amount: usd(minor) },
      ],
    });

    const a = await mk();
    expect(await inTx(db, (tx) => release(tx, TEST_ACTOR, a.reservationId, 'payout rejected'))).toBe(true);
    expect(await inTx(db, (tx) => release(tx, TEST_ACTOR, a.reservationId, 'again'))).toBe(false);
    expect((await figures(w)).available).toBe(500n);
    await expect(doPost(payout(a.reservationId))).rejects.toThrow(ReservationStateError);

    const b = await mk();
    await expect(doPost(payout(b.reservationId, 199n))).rejects.toThrow(ReservationStateError); // amount mismatch
    await expect(doPost(payout(randomUUID()))).rejects.toThrow(ReservationStateError);
    const paid = payout(b.reservationId);
    const done = await doPost(paid);
    await expect(doPost(payout(b.reservationId))).rejects.toThrow(ReservationStateError); // consumed
    await expect(inTx(db, (tx) => release(tx, TEST_ACTOR, b.reservationId, 'late'))).rejects.toThrow(ReservationStateError);
    // Replaying the payout journal itself is still a no-op.
    expect(await doPost(paid)).toEqual({ journalId: done.journalId, replayed: true });
    expect(await figures(w)).toEqual({ settled: 300n, reserved: 0n, held: 0n, available: 300n, paid: 200n });
  });

  it('a payout needs a reservation, and only a payout takes one', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 500n);
    await expect(debitWallet(w.community, sys.payoutClearing, 100n, 'PAYOUT')).rejects.toThrow(LedgerValidationError);
    const { reservationId } = await inTx(db, (tx) =>
      reserve(tx, TEST_ACTOR, { accountId: w.community.id, amount: usd(100n), ref: { type: 'payout_request', id: 'x' }, idempotencyKey: key() }),
    );
    await expect(
      doPost({
        idempotencyKey: key(),
        kind: 'REFUND',
        reservationId,
        entries: [
          { accountId: w.community.id, side: 'D', amount: usd(100n) },
          { accountId: sys.refundClearing.id, side: 'C', amount: usd(100n) },
        ],
      }),
    ).rejects.toThrow(LedgerValidationError);
    await expect(
      inTx(db, (tx) => reserve(tx, TEST_ACTOR, { accountId: sys.fees.id, amount: usd(1n), ref: { type: 'x', id: 'x' }, idempotencyKey: key() })),
    ).rejects.toThrow(UnknownAccountError);
  });
});

describe('reverse', () => {
  it('nets the original to zero and links to it', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 200n);
    const { journalId } = await creditWallet(db, sys, w.community, 500n);
    const rev = await inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, 'duplicate provider callback'));
    expect(rev.replayed).toBe(false);
    expect((await figures(w)).settled).toBe(200n);

    const statement = await getStatement(db, w.walletId);
    const reversal = statement.find((j) => j.journalId === rev.journalId);
    expect(reversal?.reversesJournalId).toBe(journalId);
    expect(reversal?.kind).toBe('CONTRIBUTION');
    expect(reversal?.reason).toBe('duplicate provider callback');
    const { rows } = await db.query<{ net: string }>(
      `SELECT sum(CASE side WHEN 'D' THEN amount_minor ELSE -amount_minor END)::text AS net
         FROM ledger_entry WHERE journal_id IN ($1, $2) GROUP BY account_id`,
      [journalId, rev.journalId],
    );
    expect(rows.map((r) => r.net)).toEqual(['0', '0']);
  });

  it('happens once: same reason replays, anything else is refused', async () => {
    const w = await seedWallet(db);
    const { journalId } = await creditWallet(db, sys, w.community, 500n);
    const first = await inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, 'mistake'));
    expect(await inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, 'mistake'))).toEqual({ journalId: first.journalId, replayed: true });
    await expect(inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, 'other reason'))).rejects.toThrow(AlreadyReversedError);
    await expect(inTx(db, (tx) => reverse(tx, TEST_ACTOR, first.journalId, 'undo the undo'))).rejects.toThrow(LedgerValidationError);
    await expect(inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, '  '))).rejects.toThrow(LedgerValidationError);
    expect((await figures(w)).settled).toBe(0n);
  });

  it('cannot take back money that has already been paid out or reserved', async () => {
    const w = await seedWallet(db);
    const { journalId } = await creditWallet(db, sys, w.community, 500n);
    await payOut(w, 400n);
    await expect(inTx(db, (tx) => reverse(tx, TEST_ACTOR, journalId, 'chargeback'))).rejects.toThrow(InsufficientFundsError);
    expect(await figures(w)).toEqual({ settled: 100n, reserved: 0n, held: 0n, available: 100n, paid: 400n });
  });

  it('reversing a payout puts the money back and lowers paid', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 500n);
    const { result } = await payOut(w, 400n);
    await inTx(db, (tx) => reverse(tx, TEST_ACTOR, result.journalId, 'provider reversed the payout'));
    expect(await figures(w)).toEqual({ settled: 500n, reserved: 0n, held: 0n, available: 500n, paid: 0n });
  });
});

describe('holds', () => {
  const hold = (input: Parameters<typeof placeHold>[2]) => inTx(db, (tx) => placeHold(tx, TEST_ACTOR, input));
  const common = (w: TestWallet) => ({ walletId: w.walletId, reasonCode: 'PAYMENT_DISPUTE', ownerId: 'ops-1', reviewAt: REVIEW });

  it('TXN hold is proportionate: only that amount is held', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    const { journalId } = await creditWallet(db, sys, w.community, 250n);
    const id = await hold({ ...common(w), scope: 'TXN', journalId });
    expect(await figures(w)).toEqual({ settled: 1_250n, reserved: 0n, held: 250n, available: 1_000n, paid: 0n });
    // Held money can be neither reserved nor debited…
    await expect(payOut(w, 1_001n)).rejects.toThrow(InsufficientFundsError);
    await expect(debitWallet(w.community, sys.refundClearing, 1_001n)).rejects.toThrow(InsufficientFundsError);
    // …the rest stays usable.
    await payOut(w, 1_000n);
    expect(await inTx(db, (tx) => releaseHold(tx, TEST_ACTOR, id, 'dispute resolved'))).toBe(true);
    expect(await inTx(db, (tx) => releaseHold(tx, TEST_ACTOR, id, 'again'))).toBe(false);
    expect(await figures(w)).toEqual({ settled: 250n, reserved: 0n, held: 0n, available: 250n, paid: 1_000n });
  });

  it('TXN hold can cover part of a transaction, never more than it credited', async () => {
    const w = await seedWallet(db);
    const { journalId } = await creditWallet(db, sys, w.community, 300n);
    await hold({ ...common(w), scope: 'TXN', journalId, amount: usd(120n) });
    expect((await figures(w)).held).toBe(120n);
    await expect(hold({ ...common(w), scope: 'TXN', journalId, amount: usd(301n) })).rejects.toThrow(LedgerValidationError);
    await expect(hold({ ...common(w), scope: 'TXN', journalId: randomUUID() })).rejects.toThrow(/journal not found/);
  });

  it('SOURCE hold freezes one sub-ledger and leaves the others alone', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 800n);
    await creditWallet(db, sys, w.fidelityBenefit, 5_000n);
    const id = await hold({ ...common(w), scope: 'SOURCE', source: { kind: 'FIDELITY_BENEFIT' }, reasonCode: 'BENEFICIARY_MISMATCH' });
    expect(await figures(w, w.fidelityBenefit)).toEqual({ settled: 5_000n, reserved: 0n, held: 5_000n, available: 0n, paid: 0n });
    expect(await figures(w)).toEqual({ settled: 800n, reserved: 0n, held: 0n, available: 800n, paid: 0n });
    await expect(payOut(w, 1n, w.fidelityBenefit)).rejects.toThrow(InsufficientFundsError);
    await payOut(w, 800n); // community funds are not blocked by a benefit dispute
    // Money arriving while the hold stands is held too.
    await creditWallet(db, sys, w.fidelityBenefit, 100n);
    expect((await figures(w, w.fidelityBenefit)).held).toBe(5_100n);
    await inTx(db, (tx) => releaseHold(tx, TEST_ACTOR, id, 'route approved'));
    expect((await figures(w, w.fidelityBenefit)).available).toBe(5_100n);
  });

  it('WALLET hold freezes every sub-ledger; reserved funds stay reserved', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 800n);
    await creditWallet(db, sys, w.fidelityBenefit, 500n);
    await inTx(db, (tx) => reserve(tx, TEST_ACTOR, { accountId: w.community.id, amount: usd(300n), ref: { type: 'payout_request', id: 'x' }, idempotencyKey: key() }));
    await hold({ ...common(w), scope: 'WALLET', reasonCode: 'AUTHORITY_DISPUTE' });
    expect(await figures(w)).toEqual({ settled: 800n, reserved: 300n, held: 500n, available: 0n, paid: 0n });
    expect(await figures(w, w.fidelityBenefit)).toEqual({ settled: 500n, reserved: 0n, held: 500n, available: 0n, paid: 0n });
    await expect(debitWallet(w.community, sys.refundClearing, 1n)).rejects.toThrow(InsufficientFundsError);
  });

  it('a hold placed after the money left reports the shortfall instead of a negative balance', async () => {
    const w = await seedWallet(db);
    const { journalId } = await creditWallet(db, sys, w.community, 500n);
    await payOut(w, 450n);
    await hold({ ...common(w), scope: 'TXN', journalId });
    const b = await bucket(w);
    expect([b.settled.minor, b.held.minor, b.available.minor, b.uncoveredHold.minor]).toEqual([50n, 50n, 0n, 450n]);
  });

  it('a held transaction can be reversed (refund / chargeback) without freeing other money', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 1_000n);
    const disputed = await creditWallet(db, sys, w.community, 250n);
    const holdId = await hold({ ...common(w), scope: 'TXN', journalId: disputed.journalId });
    expect((await figures(w)).available).toBe(1_000n);
    // The held 250 is exactly what the reversal may take.
    await inTx(db, (tx) => reverse(tx, TEST_ACTOR, disputed.journalId, 'chargeback'));
    // The hold no longer counts: the money it protected has left.
    expect(await figures(w)).toEqual({ settled: 1_000n, reserved: 0n, held: 0n, available: 1_000n, paid: 0n });
    expect(await inTx(db, (tx) => releaseHold(tx, TEST_ACTOR, holdId, 'chargeback booked'))).toBe(true);
  });

  it('a partial TXN hold lets the reversal use the held part plus what is available', async () => {
    const w = await seedWallet(db);
    const disputed = await creditWallet(db, sys, w.community, 500n);
    await hold({ ...common(w), scope: 'TXN', journalId: disputed.journalId, amount: usd(200n) });
    await payOut(w, 250n); // available was 300; 50 left + 200 held = 250 < 500
    await expect(inTx(db, (tx) => reverse(tx, TEST_ACTOR, disputed.journalId, 'chargeback'))).rejects.toThrow(InsufficientFundsError);
    await creditWallet(db, sys, w.community, 250n); // 300 available + 200 held = 500
    await inTx(db, (tx) => reverse(tx, TEST_ACTOR, disputed.journalId, 'chargeback'));
    expect(await figures(w)).toEqual({ settled: 0n, reserved: 0n, held: 0n, available: 0n, paid: 250n });
  });

  it('a TXN hold on another transaction does not help a reversal', async () => {
    const w = await seedWallet(db);
    const a = await creditWallet(db, sys, w.community, 300n);
    const b = await creditWallet(db, sys, w.community, 300n);
    await hold({ ...common(w), scope: 'TXN', journalId: b.journalId });
    await payOut(w, 300n); // all of a's money is gone; b's is held
    await expect(inTx(db, (tx) => reverse(tx, TEST_ACTOR, a.journalId, 'refund'))).rejects.toThrow(InsufficientFundsError);
  });

  it('needs a reason, an owner, a review date and a known wallet', async () => {
    const w = await seedWallet(db);
    await expect(hold({ ...common(w), scope: 'WALLET', reasonCode: ' ' })).rejects.toThrow(LedgerValidationError);
    await expect(hold({ ...common(w), scope: 'WALLET', ownerId: '' })).rejects.toThrow(LedgerValidationError);
    await expect(hold({ ...common(w), scope: 'WALLET', reviewAt: new Date('nope') })).rejects.toThrow(LedgerValidationError);
    await expect(hold({ ...common(w), scope: 'WALLET', walletId: randomUUID() })).rejects.toThrow(UnknownWalletError);
    await expect(hold({ ...common(w), scope: 'SOURCE', source: { kind: 'GROUP' } })).rejects.toThrow(LedgerValidationError);
  });
});

describe('balances and statement', () => {
  it('reports pending only from the caller-supplied source, never as spendable', async () => {
    const w = await seedWallet(db);
    await creditWallet(db, sys, w.community, 100n);
    const withPending = await getBalances(db, w.walletId, {
      pending: async () => new Map([[w.community.id, 700n]]),
    });
    const community = withPending.find((b) => b.account.id === w.community.id);
    expect(community?.pending.minor).toBe(700n);
    expect(community?.available.minor).toBe(100n);
    expect((await bucket(w)).pending.minor).toBe(0n);
    expect(await getBalances(db, randomUUID())).toEqual([]);
    expect(await getBalances(db, 'not-a-uuid')).toEqual([]);
  });

  it('a wallet can be reconstructed from its statement (audit)', async () => {
    const w = await seedWallet(db);
    const c1 = await creditWallet(db, sys, w.community, 900n);
    await creditWallet(db, sys, w.fidelityBenefit, 4_000n);
    await debitWallet(w.community, sys.fees, 20n, 'FEE');
    await payOut(w, 300n);
    const c2 = await creditWallet(db, sys, w.community, 60n);
    await inTx(db, (tx) => reverse(tx, TEST_ACTOR, c2.journalId, 'duplicate'));
    await payOut(w, 1_000n, w.fidelityBenefit);

    const statement = await getStatement(db, w.walletId);
    expect(statement).toHaveLength(7);
    expect(statement[0]?.journalId).toBe(c1.journalId);
    expect(statement.map((j) => j.seq)).toEqual([...statement.map((j) => j.seq)].sort((a, b) => (a < b ? -1 : 1)));

    const settled = new Map<string, bigint>();
    const paid = new Map<string, bigint>();
    for (const j of statement) {
      let net = 0n;
      for (const e of j.entries) {
        const signed = e.side === 'C' ? e.amount.minor : -e.amount.minor;
        net += signed;
        settled.set(e.accountId, (settled.get(e.accountId) ?? 0n) + signed);
        if (j.kind === 'PAYOUT') paid.set(e.accountId, (paid.get(e.accountId) ?? 0n) - signed);
      }
      expect(net).toBe(0n); // every journal balances
    }
    for (const b of await getBalances(db, w.walletId)) {
      expect(settled.get(b.account.id) ?? 0n).toBe(b.settled.minor);
      expect(paid.get(b.account.id) ?? 0n).toBe(b.paid.minor);
    }
    expect((await figures(w)).settled).toBe(580n);
    expect((await figures(w, w.fidelityBenefit)).paid).toBe(1_000n);
  });
});
