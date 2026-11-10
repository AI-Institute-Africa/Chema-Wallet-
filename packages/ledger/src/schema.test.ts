// Database-level guards, exercised with RAW SQL that bypasses the library:
// whatever the application does, the tables themselves refuse bad books.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable, SqlClient } from '@chema/shared';
import { migratedTestDb } from '@chema/shared/testing';
import { bootstrapWalletAccounts } from './accounts';
import { creditWallet, inTx, seedSystem, seedWallet, type SystemAccounts, type TestWallet } from './test-support';

let db: SqlClient;
let usd: SystemAccounts;
let zwg: SystemAccounts;

beforeAll(async () => {
  db = await migratedTestDb();
  usd = await seedSystem(db, 'USD');
  zwg = await seedSystem(db, 'ZWG');
});
afterAll(async () => {
  await db.close();
});

interface RawJournal {
  walletId?: string | null;
  kind?: string;
  reverses?: string | null;
  reason?: string | null;
}

async function rawJournal(q: Queryable, j: RawJournal = {}): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO ledger_journal (idempotency_key, payload_hash, kind, wallet_id, reverses_journal_id, reason, actor_id, actor_role)
     VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, 'raw', 'TEST') RETURNING id`,
    [randomUUID(), 'a'.repeat(64), j.kind ?? 'CONTRIBUTION', j.walletId ?? null, j.reverses ?? null, j.reason ?? null],
  );
  return rows[0]!.id;
}

type Line = [accountId: string, side: 'D' | 'C', minor: bigint, currency?: string];

async function rawEntries(q: Queryable, journalId: string, lines: Line[]): Promise<void> {
  const values = lines.map((_, i) => `($1, ${i + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5}::bigint)`);
  const params: unknown[] = [journalId];
  for (const [accountId, side, minor, currency] of lines) params.push(accountId, currency ?? 'USD', side, minor.toString());
  await q.query(
    `INSERT INTO ledger_entry (journal_id, line_no, account_id, currency, side, amount_minor) VALUES ${values.join(', ')}`,
    params,
  );
}

/** Header + entries in one transaction, straight into the tables. */
function rawPost(j: RawJournal, lines: Line[]): Promise<string> {
  return db.transaction(async (tx) => {
    const id = await rawJournal(tx, j);
    await rawEntries(tx, id, lines);
    return id;
  });
}

async function fundedWallet(minor = 10_000n): Promise<TestWallet> {
  const w = await seedWallet(db);
  await creditWallet(db, usd, w.community, minor);
  return w;
}

describe('journal shape (trigger ledger_journal_guard)', () => {
  it('accepts a balanced journal', async () => {
    const w = await seedWallet(db);
    await expect(
      rawPost({ walletId: w.walletId }, [
        [usd.providerClearing.id, 'D', 500n],
        [w.community.id, 'C', 500n],
      ]),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects a journal that does not sum to zero', async () => {
    const w = await seedWallet(db);
    await expect(
      rawPost({ walletId: w.walletId }, [
        [usd.providerClearing.id, 'D', 500n],
        [w.community.id, 'C', 499n],
      ]),
    ).rejects.toThrow(/does not balance per currency/);
  });

  it('balances per currency, not across currencies', async () => {
    const w = await seedWallet(db, 'USD');
    const wZwg = await inTx(db, (tx) => bootstrapWalletAccounts(tx, w.walletId, 'ZWG'));
    // 500 USD in, 500 ZWG out: the grand total is zero but neither currency balances.
    await expect(
      rawPost({ walletId: w.walletId }, [
        [usd.providerClearing.id, 'D', 500n, 'USD'],
        [wZwg.community.id, 'C', 500n, 'ZWG'],
      ]),
    ).rejects.toThrow(/does not balance per currency/);
    await expect(
      rawPost({ walletId: w.walletId }, [
        [usd.providerClearing.id, 'D', 500n, 'USD'],
        [w.community.id, 'C', 500n, 'USD'],
        [zwg.providerClearing.id, 'D', 900n, 'ZWG'],
        [wZwg.community.id, 'C', 900n, 'ZWG'],
      ]),
    ).resolves.toBeTruthy();
  });

  it('seals a journal: no entries can be added later, even balanced ones', async () => {
    const w = await seedWallet(db);
    const id = await rawPost({ walletId: w.walletId }, [
      [usd.providerClearing.id, 'D', 500n],
      [w.community.id, 'C', 500n],
    ]);
    await expect(
      db.query(
        `INSERT INTO ledger_entry (journal_id, line_no, account_id, currency, side, amount_minor)
         VALUES ($1, 3, $2, 'USD', 'D', 100), ($1, 4, $3, 'USD', 'C', 100)`,
        [id, usd.providerClearing.id, w.community.id],
      ),
    ).rejects.toThrow(/is sealed/);
  });

  it('refuses a journal header with no entries', async () => {
    await expect(db.transaction((tx) => rawJournal(tx))).rejects.toThrow(/has no entries/);
  });

  it('refuses value moving across wallets', async () => {
    const a = await fundedWallet();
    const b = await seedWallet(db);
    await expect(
      rawPost({ walletId: a.walletId }, [
        [a.community.id, 'D', 100n],
        [b.community.id, 'C', 100n],
      ]),
    ).rejects.toThrow(/more than one wallet sub-ledger/);
  });

  it('refuses value moving between sub-ledgers of one wallet', async () => {
    const w = await fundedWallet();
    await expect(
      rawPost({ walletId: w.walletId }, [
        [w.community.id, 'D', 100n],
        [w.fidelityBenefit.id, 'C', 100n],
      ]),
    ).rejects.toThrow(/more than one wallet sub-ledger/);
  });

  it('lets wallet funds leave only to fees, refund clearing or payout clearing', async () => {
    const w = await fundedWallet();
    for (const target of [usd.suspense, usd.providerClearing]) {
      await expect(
        rawPost({ walletId: w.walletId, kind: 'REFUND' }, [
          [w.community.id, 'D', 100n],
          [target.id, 'C', 100n],
        ]),
      ).rejects.toThrow(/system account that is not allowed/);
    }
    for (const target of [usd.fees, usd.refundClearing]) {
      await expect(
        rawPost({ walletId: w.walletId, kind: 'REFUND' }, [
          [w.community.id, 'D', 100n],
          [target.id, 'C', 100n],
        ]),
      ).resolves.toBeTruthy();
    }
  });

  it('requires the journal wallet_id to match its entries', async () => {
    const w = await seedWallet(db);
    const lines: Line[] = [
      [usd.providerClearing.id, 'D', 100n],
      [w.community.id, 'C', 100n],
    ];
    await expect(rawPost({ walletId: null }, lines)).rejects.toThrow(/wallet_id does not match/);
    await expect(rawPost({ walletId: (await seedWallet(db)).walletId }, lines)).rejects.toThrow(/wallet_id does not match/);
  });

  it('refuses an entry in a currency other than its account', async () => {
    const w = await seedWallet(db);
    await expect(
      rawPost({ walletId: w.walletId }, [
        [usd.providerClearing.id, 'D', 100n, 'ZWG'],
        [w.community.id, 'C', 100n, 'ZWG'],
      ]),
    ).rejects.toThrow(/foreign key/);
  });

  it('refuses zero and negative amounts', async () => {
    const w = await seedWallet(db);
    for (const bad of [0n, -5n]) {
      await expect(
        rawPost({ walletId: w.walletId }, [
          [usd.providerClearing.id, 'D', bad],
          [w.community.id, 'C', bad],
        ]),
      ).rejects.toThrow(/check constraint/);
    }
  });
});

describe('reversals', () => {
  it('must mirror the original exactly, keep its kind, and happen once', async () => {
    const w = await seedWallet(db);
    const original = await rawPost({ walletId: w.walletId }, [
      [usd.providerClearing.id, 'D', 500n],
      [w.community.id, 'C', 500n],
    ]);
    const base = { walletId: w.walletId, reverses: original, reason: 'test' };

    await expect(
      rawPost(base, [
        [w.community.id, 'D', 400n],
        [usd.providerClearing.id, 'C', 400n],
      ]),
    ).rejects.toThrow(/does not net its original to zero/);
    await expect(
      rawPost({ ...base, kind: 'REFUND' }, [
        [w.community.id, 'D', 500n],
        [usd.providerClearing.id, 'C', 500n],
      ]),
    ).rejects.toThrow(/must keep the kind/);
    await expect(rawPost({ ...base, reason: null }, [])).rejects.toThrow(/check constraint/);

    const mirror: Line[] = [
      [w.community.id, 'D', 500n],
      [usd.providerClearing.id, 'C', 500n],
    ];
    const reversal = await rawPost(base, mirror);
    await expect(rawPost(base, mirror)).rejects.toThrow(/unique/);
    await expect(
      rawPost({ walletId: w.walletId, reverses: reversal, reason: 'again' }, [
        [usd.providerClearing.id, 'D', 500n],
        [w.community.id, 'C', 500n],
      ]),
    ).rejects.toThrow(/reverses a reversal/);
  });
});

describe('funds (trigger ledger_funds_guard, ledger_reservation_guard)', () => {
  it('refuses a debit that would overdraw a wallet account', async () => {
    const w = await fundedWallet(1_000n);
    await expect(
      rawPost({ walletId: w.walletId, kind: 'REFUND' }, [
        [w.community.id, 'D', 1_001n],
        [usd.refundClearing.id, 'C', 1_001n],
      ]),
    ).rejects.toThrow(/would be overdrawn/);
  });

  it('refuses a payout that does not consume a matching reservation', async () => {
    const w = await fundedWallet(1_000n);
    await expect(
      rawPost({ walletId: w.walletId, kind: 'PAYOUT' }, [
        [w.community.id, 'D', 100n],
        [usd.payoutClearing.id, 'C', 100n],
      ]),
    ).rejects.toThrow(/does not consume a matching reservation/);
  });

  const rawReservation = (q: Queryable, w: TestWallet, accountId: string, minor: bigint, walletId = w.walletId) =>
    q.query<{ id: string }>(
      `INSERT INTO ledger_reservation (wallet_id, account_id, currency, amount_minor, ref_type, ref_id, idempotency_key, payload_hash, created_by)
       VALUES ($1, $2, 'USD', $3::bigint, 'test', 'x', $4, $5, 'raw') RETURNING id`,
      [walletId, accountId, minor.toString(), randomUUID(), 'b'.repeat(64)],
    );

  it('refuses reservations beyond the balance, or on another wallet’s account', async () => {
    const w = await fundedWallet(1_000n);
    await expect(rawReservation(db, w, w.community.id, 1_001n)).rejects.toThrow(/would exceed its balance/);
    await expect(rawReservation(db, w, w.community.id, 600n)).resolves.toBeTruthy();
    await expect(rawReservation(db, w, w.community.id, 401n)).rejects.toThrow(/would exceed its balance/);
    await expect(rawReservation(db, w, w.community.id, 100n, (await seedWallet(db)).walletId)).rejects.toThrow(/not on an account of its wallet/);
    await expect(rawReservation(db, w, usd.fees.id, 1n)).rejects.toThrow(/not on an account of its wallet/);
    // The reserved 600 cannot be debited either.
    await expect(
      rawPost({ walletId: w.walletId, kind: 'REFUND' }, [
        [w.community.id, 'D', 401n],
        [usd.refundClearing.id, 'C', 401n],
      ]),
    ).rejects.toThrow(/would be overdrawn/);
  });

  it('lets a reservation change only by being released or consumed, once', async () => {
    const w = await fundedWallet(1_000n);
    const { rows } = await rawReservation(db, w, w.community.id, 100n);
    const id = rows[0]!.id;
    await expect(db.query('UPDATE ledger_reservation SET amount_minor = 1 WHERE id = $1', [id])).rejects.toThrow(/only set-once columns/);
    await expect(db.query('DELETE FROM ledger_reservation WHERE id = $1', [id])).rejects.toThrow(/append-only/);
    await db.query(
      `UPDATE ledger_reservation SET released_at = now(), released_by = 'raw', release_reason = 'x' WHERE id = $1`,
      [id],
    );
    await expect(
      db.query(`UPDATE ledger_reservation SET released_at = now() + interval '1 day' WHERE id = $1`, [id]),
    ).rejects.toThrow(/set-once/);
  });
});

describe('holds', () => {
  it('a TXN hold cannot exceed what the journal credited, nor sit on another wallet', async () => {
    const w = await seedWallet(db);
    const other = await seedWallet(db);
    const { journalId } = await creditWallet(db, usd, w.community, 500n);
    const insert = (walletId: string, minor: bigint) =>
      db.query(
        `INSERT INTO hold (wallet_id, scope, account_id, currency, journal_id, amount_minor, reason_code, owner_id, review_at, placed_by)
         VALUES ($1, 'TXN', $2, 'USD', $3, $4::bigint, 'TEST', 'ops', now(), 'raw')`,
        [walletId, w.community.id, journalId, minor.toString()],
      );
    await expect(insert(w.walletId, 501n)).rejects.toThrow(/exceeds what the journal credited/);
    await expect(insert(other.walletId, 100n)).rejects.toThrow(/not in the wallet of the hold/);
    await expect(insert(w.walletId, 500n)).resolves.toBeTruthy();
  });

  it('enforces the shape of each scope', async () => {
    const w = await seedWallet(db);
    const insert = (cols: string, vals: string) =>
      db.query(
        `INSERT INTO hold (wallet_id, reason_code, owner_id, review_at, placed_by, ${cols})
         VALUES ($1, 'TEST', 'ops', now(), 'raw', ${vals})`,
        [w.walletId],
      );
    await expect(insert('scope', `'SOURCE'`)).rejects.toThrow(/check constraint/);
    await expect(insert('scope, source_kind', `'WALLET', 'COMMUNITY'`)).rejects.toThrow(/check constraint/);
    await expect(insert('scope, source_kind', `'SOURCE', 'GROUP'`)).rejects.toThrow(/check constraint/);
    await expect(insert('scope, source_kind', `'SOURCE', 'COMMUNITY'`)).resolves.toBeTruthy();
    await expect(insert('scope', `'WALLET'`)).resolves.toBeTruthy();
  });
});

describe('append-only', () => {
  it('denies UPDATE, DELETE and TRUNCATE on accounts, journals and entries', async () => {
    const w = await fundedWallet();
    for (const table of ['ledger_account', 'ledger_journal', 'ledger_entry']) {
      await expect(db.query(`UPDATE ${table} SET created_at = now()`)).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
      await expect(db.exec(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
    }
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM ledger_entry WHERE account_id = $1',
      [w.community.id],
    );
    expect(rows[0]!.n).toBe('1');
  });
});
