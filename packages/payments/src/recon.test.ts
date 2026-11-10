// docs/14 §L reconciliation rows + DB guards + invariants for the collection pipeline.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@chema/core';
import { MockRail, type MockRail as Rail } from '@chema/providers';
import { LiveFundsDisabledError, RailRegistry } from './index';
import { createPaymentsHarness, usd, WEBHOOK_SECRET, type PaymentsHarness } from './test-support';

let t: PaymentsHarness;
beforeAll(async () => {
  t = await createPaymentsHarness({ 'recon.tolerance.ecocash.usd': '50' });
});
afterAll(async () => {
  await t.close();
});

const key = () => `k-${randomUUID()}`;

async function paid(rail: Rail, minor: bigint, settlementDate: string) {
  const c = await t.h.customer();
  const walletId = t.newWallet();
  const view = await t.service.initiate(c.actor, { walletId, rail: rail.rail, amount: usd(minor), idempotencyKey: key() });
  const providerRef = rail.providerRefFor(view.id)!;
  rail.succeed(providerRef, settlementDate);
  await t.deliver(rail);
  rail.scenario = {};
  return { walletId, paymentId: view.id, providerRef };
}

async function holdsOf(walletId: string) {
  const { rows } = await t.h.db.query<{ scope: string; amount_minor: string | null }>(
    'SELECT scope, amount_minor::text AS amount_minor FROM hold WHERE wallet_id = $1 AND released_at IS NULL',
    [walletId],
  );
  return rows;
}

async function exceptionKinds(where: string, param: string) {
  const { rows } = await t.h.db.query<{ kind: string }>(`SELECT kind FROM recon_exception WHERE ${where} = $1 ORDER BY kind`, [param]);
  return rows.map((r) => r.kind);
}

async function balance(kind: string) {
  const { rows } = await t.h.db.query<{ bal: string | null }>(
    `SELECT sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END)::text AS bal
       FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id WHERE a.kind = $1`,
    [kind],
  );
  return BigInt(rows[0]?.bal ?? '0');
}

describe('§L reconciliation', () => {
  it('exact settlement matches; a re-run changes nothing', async () => {
    const date = '2026-12-01';
    const p = await paid(t.ecocash, 10_00n, date);
    const ops = await t.h.staff('OPS_FINANCE');
    const first = await t.service.runRecon(ops.actor, 'ECOCASH', date);
    expect(first).toMatchObject({ rowsSeen: 1, matched: 1, withinTolerance: 0, exceptions: 0 });
    const again = await t.service.runRecon(ops.actor, 'ECOCASH', date);
    expect(again).toMatchObject({ rowsSeen: 1, matched: 0, exceptions: 0 });
    expect(await exceptionKinds('payment_id', p.paymentId)).toEqual([]);
  });

  it('unmatched incoming → suspense + exception (never credited to a wallet)', async () => {
    const date = '2026-12-02';
    const ref = `ECOCASH-STRAY-${randomUUID().slice(0, 6)}`;
    t.ecocash.addSettlementRow(date, { providerRef: ref, gross: usd(12_34n), fee: usd(0n), merchantRef: t.ecocash.merchantRef });
    const suspenseBefore = await balance('SUSPENSE_UNMATCHED');
    const ops = await t.h.staff('OPS_FINANCE');
    const s = await t.service.runRecon(ops.actor, 'ECOCASH', date);
    expect(s.exceptions).toBe(1);
    expect(await exceptionKinds('provider_ref', ref)).toEqual(['UNMATCHED_INCOMING']);
    expect((await balance('SUSPENSE_UNMATCHED')) - suspenseBefore).toBe(12_34n);
  });

  it('a settlement for a payment still PENDING_UNKNOWN goes to suspense, not to the wallet', async () => {
    const date = '2026-12-03';
    t.ecocash.scenario = { timeout: true };
    const c = await t.h.customer();
    const walletId = t.newWallet();
    const view = await t.service.initiate(c.actor, { walletId, rail: 'ECOCASH', amount: usd(6_00n), idempotencyKey: key() });
    t.ecocash.scenario = {};
    const ref = t.ecocash.providerRefFor(view.id)!;
    t.ecocash.succeed(ref, date);
    t.ecocash.takeWebhooks(new Date(8.64e15));
    const ops = await t.h.staff('OPS_FINANCE');
    await t.service.runRecon(ops.actor, 'ECOCASH', date);
    expect(await exceptionKinds('provider_ref', ref)).toEqual(['UNMATCHED_INCOMING']);
    const b = (await t.service.balances(walletId)).find((x) => x.account.kind === 'COMMUNITY')!;
    expect(b.settled.minor).toBe(0n);
  });

  it('within tolerance: difference recorded on RECON_DIFF, no hold, no exception', async () => {
    const date = '2026-12-04';
    t.ecocash.scenario = { settleShortMinor: 30n };
    const p = await paid(t.ecocash, 10_00n, date);
    const before = await balance('RECON_DIFF');
    const ops = await t.h.staff('OPS_FINANCE');
    const s = await t.service.runRecon(ops.actor, 'ECOCASH', date);
    expect(s).toMatchObject({ withinTolerance: 1, exceptions: 0 });
    // Debit-normal from the platform's side: 0.30 short, recorded, not written off.
    expect((await balance('RECON_DIFF')) - before).toBe(-30n);
    expect(await holdsOf(p.walletId)).toEqual([]);
  });

  it('tolerance breach → exception + proportionate hold (not a blanket freeze)', async () => {
    const date = '2026-12-05';
    t.ecocash.scenario = { settleShortMinor: 2_00n };
    const p = await paid(t.ecocash, 10_00n, date);
    const ops = await t.h.staff('OPS_FINANCE');
    await t.service.runRecon(ops.actor, 'ECOCASH', date);
    expect(await exceptionKinds('payment_id', p.paymentId)).toEqual(['AMOUNT_VARIANCE']);
    expect(await holdsOf(p.walletId)).toEqual([{ scope: 'TXN', amount_minor: '200' }]);
    const { rows } = await t.h.db.query<{ owner_role: string; sla_due_at: Date; opened_at: Date }>(
      'SELECT owner_role, sla_due_at, opened_at FROM recon_exception WHERE payment_id = $1',
      [p.paymentId],
    );
    expect(rows[0]!.owner_role).toBe('OPS_FINANCE');
    expect(new Date(rows[0]!.sla_due_at).getTime()).toBeGreaterThan(new Date(rows[0]!.opened_at).getTime());
  });

  it('zero tolerance when unset: any difference is an exception, still only a TXN hold', async () => {
    const date = '2026-12-06';
    t.onemoney.scenario = { settleShortMinor: 1n };
    const p = await paid(t.onemoney, 10_00n, date);
    const ops = await t.h.staff('OPS_FINANCE');
    await t.service.runRecon(ops.actor, 'ONEMONEY', date);
    expect(await exceptionKinds('payment_id', p.paymentId)).toEqual(['AMOUNT_VARIANCE']);
    expect(await holdsOf(p.walletId)).toEqual([{ scope: 'TXN', amount_minor: '1' }]);
  });

  it('credited but never settled → MISSING_SETTLEMENT after the lag', async () => {
    t.card.scenario = { settleShortMinor: 5_00n }; // settles nothing
    const p = await paid(t.card, 5_00n, '2026-11-10');
    const ops = await t.h.staff('OPS_FINANCE');
    await t.service.runRecon(ops.actor, 'CARD', '2026-11-10');
    expect(await exceptionKinds('payment_id', p.paymentId)).toEqual([]);
    await t.service.runRecon(ops.actor, 'CARD', '2026-11-13');
    expect(await exceptionKinds('payment_id', p.paymentId)).toEqual(['MISSING_SETTLEMENT']);
  });

  it('recon and the exception queue are staff-only', async () => {
    const c = await t.h.customer();
    await expect(t.service.runRecon(c.actor, 'ECOCASH', '2026-12-01')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(t.service.listExceptions(c.actor)).rejects.toBeInstanceOf(ForbiddenError);
    const auditor = await t.h.staff('AUDITOR');
    expect((await t.service.listExceptions(auditor.actor)).length).toBeGreaterThan(0);
    await expect(t.service.runRecon(auditor.actor, 'ECOCASH', '2026-12-01')).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('database guards (raw SQL, bypassing the service)', () => {
  async function failedPayment() {
    t.ecocash.scenario = { reject: true };
    const c = await t.h.customer();
    const v = await t.service.initiate(c.actor, { walletId: t.newWallet(), rail: 'ECOCASH', amount: usd(1_00n), idempotencyKey: key() });
    t.ecocash.scenario = {};
    return v.id;
  }

  it('illegal transitions and credits without a contribution journal are refused', async () => {
    const id = await failedPayment();
    await expect(t.h.db.query("UPDATE payment SET state = 'SUCCEEDED' WHERE id = $1", [id])).rejects.toThrow();
    await expect(t.h.db.query("UPDATE payment SET state = 'PENDING_UNKNOWN' WHERE id = $1", [id])).rejects.toThrow(/illegal transition/);
    await expect(t.h.db.query('UPDATE payment SET gross_minor = 1 WHERE id = $1', [id])).rejects.toThrow(/immutable/);
    await expect(t.h.db.query('DELETE FROM payment WHERE id = $1', [id])).rejects.toThrow();
  });

  it('a credit cannot point at some other journal, nor be moved once set', async () => {
    const p = await paid(t.ecocash, 2_00n, '2026-12-09');
    const { rows } = await t.h.db.query<{ id: string }>("SELECT id FROM ledger_journal WHERE kind <> 'CONTRIBUTION' LIMIT 1");
    await expect(t.h.db.query('UPDATE payment SET credit_journal_id = $2 WHERE id = $1', [p.paymentId, rows[0]!.id])).rejects.toThrow(
      /set-once/,
    );
    await expect(t.h.db.query('UPDATE payment SET confirmed_minor = 1 WHERE id = $1', [p.paymentId])).rejects.toThrow(/set-once/);
    await expect(t.h.db.query("UPDATE receipt SET net_minor = 1 WHERE payment_id = $1", [p.paymentId])).rejects.toThrow();
    await expect(t.h.db.query('DELETE FROM provider_event')).rejects.toThrow();
  });

  it('an open payment cannot be marked SUCCEEDED with a forged credit', async () => {
    const c = await t.h.customer();
    const v = await t.service.initiate(c.actor, { walletId: t.newWallet(), rail: 'ONEMONEY', amount: usd(1_00n), idempotencyKey: key() });
    const { rows } = await t.h.db.query<{ id: string }>("SELECT id FROM ledger_journal WHERE kind = 'CONTRIBUTION' LIMIT 1");
    await expect(
      t.h.db.query(
        "UPDATE payment SET state = 'SUCCEEDED', credit_journal_id = $2, confirmed_minor = 100, credited_gross_minor = 100 WHERE id = $1",
        [v.id, rows[0]!.id],
      ),
    ).rejects.toThrow();
  });
});

describe('invariants', () => {
  it('no code path credits a contribution except applyConfirmation', () => {
    const root = join(__dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === 'node_modules') continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('test-support.ts')) {
          if (/kind:\s*'CONTRIBUTION'/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    walk(join(root, '..', 'apps'));
    expect(hits).toEqual(['payments/src/confirm.ts']);
  });

  it('a LIVE adapter refuses to initialise while live_funds.enabled is off', async () => {
    const reg = new RailRegistry(t.h.flags);
    await expect(reg.register(new MockRail({ rail: 'ECOCASH', webhookSecret: WEBHOOK_SECRET, mode: 'LIVE' }))).rejects.toBeInstanceOf(
      LiveFundsDisabledError,
    );
    await reg.register(new MockRail({ rail: 'ECOCASH', webhookSecret: WEBHOOK_SECRET, mode: 'SANDBOX' }));
    expect(reg.rails()).toEqual(['ECOCASH']);
  });
});
