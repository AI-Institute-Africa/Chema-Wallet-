// P06 Fidelity claims link (docs/07, docs/14 §C) on MockFidelity.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConflictError, ForbiddenError, NotFoundError, SYSTEM_ACTOR, decideApproval } from '@chema/core';
import { BenefitSourceError, ensureSystemAccount, getBalances, post } from '@chema/ledger';
import { WebhookRejectedError } from '@chema/providers';
import { money } from '@chema/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFidelityHarness, type FidelityHarness } from './test-support';

let t: FidelityHarness;
beforeEach(async () => {
  t = await createFidelityHarness();
});
afterEach(async () => {
  await t.close();
});

const usd = (m: bigint) => money(m, 'USD');

async function bal(walletId: string, kind: 'COMMUNITY' | 'FIDELITY_BENEFIT') {
  const b = (await getBalances(t.h.db, walletId)).find((x) => x.account.kind === kind)!;
  return { settled: b.settled.minor, held: b.held.minor, available: b.available.minor };
}

async function link(walletId: string) {
  const { rows } = await t.h.db.query<Record<string, unknown>>('SELECT * FROM fidelity_link WHERE wallet_id = $1', [walletId]);
  return rows[0]!;
}

describe('§C lookup outcomes (consent + role gated)', () => {
  it.each([
    ['APPROVED', 'ELIGIBLE', true],
    ['NO_POLICY', 'NO_POLICY', false],
    ['INACTIVE', 'INACTIVE', true],
    ['COVERED_LIFE_MISMATCH', 'COVERED_LIFE_MISMATCH', false],
    ['ARREARS', 'ARREARS', true],
  ] as const)('%s ⇒ %s', async (scenario, outcome, linkable) => {
    const c = await t.claimCase(scenario);
    expect(c.lookup).toMatchObject({ outcome, linkable });
    // Only the outcome is stored; the policy number is masked in views.
    expect(c.lookup.policyNo === null || c.lookup.policyNo.includes('*')).toBe(true);
  });

  it('no policy / covered-life mismatch cannot be linked; the community path is untouched', async () => {
    for (const s of ['NO_POLICY', 'COVERED_LIFE_MISMATCH'] as const) {
      const c = await t.claimCase(s);
      await t.contributePaid(c.slug);
      await expect(
        t.claims.linkClaim(c.admin.actor, { walletId: c.walletId, recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId }),
      ).rejects.toThrow(ConflictError);
      expect(await bal(c.walletId, 'COMMUNITY')).toEqual({ settled: 10_00n, held: 0n, available: 10_00n });
    }
  });

  it('needs the admin DISCLOSURE consent; denial is audited and Fidelity is never called', async () => {
    const { walletId, admin } = await t.publicWallet();
    const before = t.fidelity.calls.length;
    await expect(t.claims.lookupPolicy(admin.actor, walletId, { policyNo: 'POL-X' })).rejects.toThrow(ForbiddenError);
    expect(t.fidelity.calls.length).toBe(before);
    const { rows } = await t.h.db.query("SELECT reason_code FROM audit_log WHERE action = 'claim.lookup_policy' AND authz_result = 'DENIED'");
    expect(rows).toEqual([{ reason_code: 'CONSENT_REQUIRED' }]);
  });

  it('contributors and unassigned claims officers cannot look up or view claims', async () => {
    const c = await t.claimCase('APPROVED');
    const stranger = await t.h.customer();
    await expect(t.claims.view(stranger.actor, c.walletId)).rejects.toThrow(ForbiddenError);
    const officer = await t.h.staff('CLAIMS_OFFICER');
    await expect(t.claims.lookupPolicy(officer.actor, c.walletId)).rejects.toThrow(ForbiddenError);
    await t.h.assign(officer.personId, c.walletId);
    await expect(t.claims.lookupPolicy(officer.actor, c.walletId)).resolves.toMatchObject({ outcome: 'ELIGIBLE' });
  });

  it('flag off ⇒ the claim path does not exist (audited NOT_FOUND)', async () => {
    const off = await createFidelityHarness({ 'fidelity.claims_link': 'false' });
    try {
      const { walletId, admin } = await off.publicWallet();
      await off.consent(admin, walletId);
      await expect(off.claims.lookupPolicy(admin.actor, walletId, { policyNo: 'POL-1' })).rejects.toThrow(NotFoundError);
      const cb = off.fidelity.signed(JSON.stringify({ eventId: 'e1', type: 'claim.approved', claimRef: 'C' }));
      await expect(off.claims.receiveWebhook(cb.headers, cb.body)).rejects.toThrow(NotFoundError);
    } finally {
      await off.close();
    }
  });
});

describe('§C claim lifecycle', () => {
  it('link is idempotent (wallet + policy + deceased) and mirrors SUBMITTED', async () => {
    const c = await t.linkedCase();
    expect(await link(c.walletId)).toMatchObject({ link_state: 'LINKED', claim_status_mirror: 'SUBMITTED', route_status: 'PENDING_APPROVAL' });
    const again = await t.claims.linkClaim(c.admin.actor, { walletId: c.walletId, recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId });
    expect(again.linked).toBe(true);
    expect(t.fidelity.calls.filter((x) => x.op === 'createOrLinkClaim')).toHaveLength(1);
  });

  it('duplicate claim is surfaced from Fidelity, never overridden', async () => {
    const c = await t.claimCase('DUPLICATE_CLAIM');
    const v = await t.claims.linkClaim(c.admin.actor, { walletId: c.walletId, recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId });
    expect(v).toMatchObject({ linkState: 'DUPLICATE_CLAIM', linkError: 'DUPLICATE_CLAIM', linked: false });
    await expect(
      t.claims.linkClaim(c.admin.actor, { walletId: c.walletId, recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId }),
    ).rejects.toThrow('DUPLICATE_CLAIM');
  });

  it('pending / in review: mirrored, nothing credited', async () => {
    const c = await t.linkedCase('PENDING');
    t.fidelity.setStatus(c.claimRef, 'IN_REVIEW');
    await t.deliverFidelity();
    expect((await t.claims.view(c.admin.actor, c.walletId)).claimStatus).toBe('IN_REVIEW');
    expect(await bal(c.walletId, 'FIDELITY_BENEFIT')).toEqual({ settled: 0n, held: 0n, available: 0n });
    const { rows } = await t.h.db.query("SELECT from_status, to_status, source FROM claim_status_event ORDER BY ts, from_status");
    expect(rows).toEqual([
      { from_status: 'NONE', to_status: 'SUBMITTED', source: 'FIDELITY' },
      { from_status: 'SUBMITTED', to_status: 'IN_REVIEW', source: 'FIDELITY' },
    ]);
  });

  it('decline leaves community funds intact and still contributable', async () => {
    const c = await t.linkedCase('DECLINED');
    await t.contributePaid(c.slug, 25_00n);
    t.fidelity.decline(c.claimRef, 'POLICY_EXCLUSION');
    await t.deliverFidelity();
    const f = await t.claims.funds(c.admin.actor, c.walletId);
    expect(f.benefit).toMatchObject({ status: 'CLAIM_DECLINED', reason: 'POLICY_EXCLUSION' });
    expect(await bal(c.walletId, 'COMMUNITY')).toEqual({ settled: 25_00n, held: 0n, available: 25_00n });
    await t.contributePaid(c.slug, 5_00n);
    expect((await bal(c.walletId, 'COMMUNITY')).settled).toBe(30_00n);
  });

  it('approved + route approved + settled ⇒ credited once to W:FIDELITY_BENEFIT, no fee, separate from community', async () => {
    const c = await t.linkedCase('APPROVED');
    await t.contributePaid(c.slug, 10_00n);
    t.fidelity.approve(c.claimRef);
    await t.deliverFidelity();
    // APPROVED alone is not enough (docs/07 §4).
    expect((await bal(c.walletId, 'FIDELITY_BENEFIT')).settled).toBe(0n);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    await t.deliverFidelity();
    expect((await bal(c.walletId, 'FIDELITY_BENEFIT')).settled).toBe(0n);
    t.fidelity.pay(c.claimRef, usd(500_00n));
    await t.deliverFidelity();
    await t.deliverFidelity(); // redelivery: nothing new
    expect(await bal(c.walletId, 'FIDELITY_BENEFIT')).toEqual({ settled: 500_00n, held: 0n, available: 500_00n });
    expect(await bal(c.walletId, 'COMMUNITY')).toEqual({ settled: 10_00n, held: 0n, available: 10_00n });
    const { rows } = await t.h.db.query<{ n: string }>("SELECT count(*)::text AS n FROM ledger_journal WHERE kind = 'BENEFIT'");
    expect(rows[0]!.n).toBe('1');
    const fees = await t.h.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
        WHERE a.kind = 'FEES' AND e.journal_id IN (SELECT id FROM ledger_journal WHERE kind = 'BENEFIT')`,
    );
    expect(fees.rows[0]!.n).toBe('0');
    const f = await t.claims.funds(c.admin.actor, c.walletId);
    expect(f.benefit.status).toBe('CREDITED');
    expect(f.lines.map((l) => [l.source, l.labelKey, l.available.minor])).toEqual([
      ['COMMUNITY', 'funds.source.community', 10_00n],
      ['FIDELITY_BENEFIT', 'funds.source.fidelity_benefit', 500_00n],
    ]);
    // Public page never shows the benefit or claim (docs/07 Never).
    const page = JSON.stringify(await t.contributions.page(c.slug), (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(page).not.toMatch(/benefit|claimStatus|claimRef|policy|50000/i);
    expect(page).toContain('"raised":{"minor":"1000"');
  });

  it('benefit payment not settled ⇒ shown pending, never spendable', async () => {
    const c = await t.linkedCase('NOT_SETTLED');
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    t.fidelity.pay(c.claimRef, usd(300_00n), 'PENDING');
    await t.deliverFidelity();
    const f = await t.claims.funds(c.admin.actor, c.walletId);
    expect(f.benefit.status).toBe('PAYMENT_PENDING');
    const line = f.lines.find((l) => l.source === 'FIDELITY_BENEFIT')!;
    expect([line.pending.minor, line.settled.minor, line.available.minor]).toEqual([300_00n, 0n, 0n]);
  });

  it('settled before route approval is NOT credited until the route is approved', async () => {
    const c = await t.linkedCase('APPROVED');
    t.fidelity.approve(c.claimRef);
    t.fidelity.pay(c.claimRef, usd(100_00n));
    await t.deliverFidelity();
    expect((await bal(c.walletId, 'FIDELITY_BENEFIT')).settled).toBe(0n);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    await t.deliverFidelity();
    expect((await bal(c.walletId, 'FIDELITY_BENEFIT')).settled).toBe(100_00n);
  });

  it('DIRECT route: Fidelity pays the beneficiary itself, nothing enters the wallet', async () => {
    const c = await t.linkedCase('APPROVED');
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, c.recipientId, { route: 'DIRECT' });
    t.fidelity.pay(c.claimRef, usd(100_00n));
    await t.deliverFidelity();
    expect((await bal(c.walletId, 'FIDELITY_BENEFIT')).settled).toBe(0n);
    expect((await t.claims.funds(c.admin.actor, c.walletId)).benefit.status).toBe('PAID_DIRECT');
  });
});

describe('§C beneficiary mismatch ⇒ route blocked', () => {
  async function blocked() {
    const c = await t.linkedCase('BENEFICIARY_MISMATCH');
    await t.contributePaid(c.slug, 20_00n);
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, 'SOMEONE-ELSE-99');
    t.fidelity.pay(c.claimRef, usd(400_00n));
    await t.deliverFidelity();
    return c;
  }

  it('opens a case, holds the benefit source only, credits nothing', async () => {
    const c = await blocked();
    const l = await link(c.walletId);
    expect(l['route_status']).toBe('BLOCKED_MISMATCH');
    const cases = await t.h.db.query("SELECT case_type FROM case_record WHERE wallet_id = $1", [c.walletId]);
    expect(cases.rows).toEqual([{ case_type: 'BENEFICIARY_MISMATCH' }]);
    const holds = await t.h.db.query<{ scope: string; source_kind: string }>('SELECT scope, source_kind FROM hold WHERE wallet_id = $1 AND released_at IS NULL', [c.walletId]);
    expect(holds.rows).toEqual([{ scope: 'SOURCE', source_kind: 'FIDELITY_BENEFIT' }]);
    expect((await bal(c.walletId, 'FIDELITY_BENEFIT')).settled).toBe(0n);
    expect(await bal(c.walletId, 'COMMUNITY')).toEqual({ settled: 20_00n, held: 0n, available: 20_00n });
    expect((await t.claims.funds(c.admin.actor, c.walletId)).benefit.status).toBe('ROUTE_BLOCKED');
  });

  it('needs a written approval + maker-checker to unblock; then credits', async () => {
    const c = await blocked();
    const doc = await t.upload(c.admin.actor, c.walletId, 'OTHER');
    const officer = await t.h.staff('CLAIMS_OFFICER');
    const input = { walletId: c.walletId, externalApprovalRef: 'LCF-2026-0042', documentId: doc, recipientPersonId: c.admin.personId };
    await expect(t.claims.unblockRoute(officer.actor, input)).rejects.toThrow('NOT_ASSIGNED');
    await t.h.assign(officer.personId, c.walletId);
    const req = await t.claims.unblockRoute(officer.actor, input);
    expect(req.status).toBe('PENDING_APPROVAL');
    // Executing without the checker's decision is refused.
    await expect(t.claims.unblockRoute(officer.actor, { ...input, approvalId: req.approvalId })).rejects.toThrow();
    // Maker cannot check their own request.
    await expect(t.h.bus.execute(decideApproval, { approvalId: req.approvalId, decision: 'APPROVED' }, { actor: officer.actor })).rejects.toThrow(ForbiddenError);
    const opsfin = await t.h.staff('OPS_FINANCE');
    await t.h.bus.execute(decideApproval, { approvalId: req.approvalId, decision: 'APPROVED' }, { actor: opsfin.actor });
    const done = await t.claims.unblockRoute(officer.actor, { ...input, approvalId: req.approvalId });
    expect(done.status).toBe('UNBLOCKED');
    expect(await link(c.walletId)).toMatchObject({ route_status: 'APPROVED', route_approval_ref: req.approvalId, external_approval_ref: 'LCF-2026-0042' });
    expect(await bal(c.walletId, 'FIDELITY_BENEFIT')).toEqual({ settled: 400_00n, held: 0n, available: 400_00n });
  });

  it('the DB refuses to unblock without a consumed approval, or to credit early', async () => {
    const c = await blocked();
    const l = await link(c.walletId);
    await expect(t.h.db.query("UPDATE fidelity_link SET route_status = 'APPROVED' WHERE id = $1", [l['id']])).rejects.toThrow(/not allowed/);
    const journal = await t.h.db.transaction(async (tx) => {
      const clearing = await ensureSystemAccount(tx as never, 'BENEFIT_CLEARING', 'USD');
      const acct = (await getBalances(tx, c.walletId)).find((b) => b.account.kind === 'FIDELITY_BENEFIT')!.account;
      return post(tx as never, SYSTEM_ACTOR, {
        idempotencyKey: 'rogue-benefit',
        kind: 'BENEFIT',
        entries: [
          { accountId: clearing.id, side: 'D', amount: usd(1n) },
          { accountId: acct.id, side: 'C', amount: usd(1n) },
        ],
      });
    });
    await expect(t.h.db.query('UPDATE fidelity_link SET benefit_journal_id = $2 WHERE id = $1', [l['id'], journal.journalId])).rejects.toThrow(/credited before/);
  });
});

describe('§C resilience: Fidelity down ⇒ queued and retried', () => {
  it('link while down shows "status updating", retries with backoff, then links', async () => {
    const c = await t.claimCase('APPROVED');
    t.fidelity.down = true;
    const v = await t.claims.linkClaim(c.admin.actor, { walletId: c.walletId, recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId });
    expect(v).toMatchObject({ linkState: 'QUEUED', statusUpdating: true });
    expect((await t.claims.funds(c.admin.actor, c.walletId)).benefit).toMatchObject({ status: 'LINK_PENDING', statusUpdating: true });
    expect((await t.claims.deliverDue()).attempted).toBe(0); // backoff not elapsed
    t.h.advance(61_000);
    await t.claims.deliverDue(); // still down
    t.fidelity.down = false;
    t.h.advance(121_000);
    await t.claims.deliverDue();
    expect(await t.claims.view(c.admin.actor, c.walletId)).toMatchObject({ linked: true, statusUpdating: false });
    expect(t.fidelity.calls.filter((x) => x.op === 'createOrLinkClaim').length).toBe(3);
  });

  it('missed callbacks are caught by the poller', async () => {
    const c = await t.linkedCase('APPROVED');
    t.fidelity.approve(c.claimRef);
    t.fidelity.takeWebhooks(); // lost
    t.h.advance(7 * 3_600_000);
    const r = await t.claims.pollDue();
    expect(r.queued).toBe(1);
    expect((await t.claims.view(c.admin.actor, c.walletId)).claimStatus).toBe('APPROVED');
  });

  it('callbacks are signed and replay-protected', async () => {
    const c = await t.linkedCase('APPROVED');
    t.fidelity.approve(c.claimRef);
    const [cb] = t.fidelity.takeWebhooks();
    await expect(t.claims.receiveWebhook(cb!.headers, cb!.body.replace('claim.approved', 'claim.declined'))).rejects.toThrow(WebhookRejectedError);
    const first = await t.claims.receiveWebhook(cb!.headers, cb!.body);
    const second = await t.claims.receiveWebhook(cb!.headers, cb!.body);
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
  });
});

describe('benefit reconciliation vs the Fidelity record', () => {
  it('matches credited benefits; raises uncredited ones; idempotent', async () => {
    const ok = await t.linkedCase('APPROVED');
    t.fidelity.approve(ok.claimRef);
    t.fidelity.routeTo(ok.claimRef, ok.recipientId);
    const blocked = await t.linkedCase('BENEFICIARY_MISMATCH');
    t.fidelity.approve(blocked.claimRef);
    t.fidelity.routeTo(blocked.claimRef, 'NOT-THEM-1');
    const day = t.h.now().toISOString().slice(0, 10);
    t.fidelity.pay(ok.claimRef, usd(200_00n), 'SETTLED', day);
    t.fidelity.pay(blocked.claimRef, usd(150_00n), 'SETTLED', day);
    await t.deliverFidelity();
    const s = await t.claims.runRecon(SYSTEM_ACTOR, day);
    expect(s).toMatchObject({ rowsSeen: 2, matched: 1, exceptions: 1 });
    const again = await t.claims.runRecon(SYSTEM_ACTOR, day);
    expect(again).toMatchObject({ matched: 0, exceptions: 0 });
    const { rows } = await t.h.db.query("SELECT kind FROM recon_exception WHERE rail = 'FIDELITY'");
    expect(rows).toEqual([{ kind: 'BENEFIT_UNCREDITED' }]);
  });
});

describe('ledger benefit source rules (TS + DB)', () => {
  it('no fee on the benefit; no contribution into the benefit', async () => {
    const c = await t.linkedCase('APPROVED');
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    t.fidelity.pay(c.claimRef, usd(50_00n));
    await t.deliverFidelity();
    const acct = (await getBalances(t.h.db, c.walletId)).find((b) => b.account.kind === 'FIDELITY_BENEFIT')!.account;
    await expect(
      t.h.db.transaction(async (tx) => {
        const fees = await ensureSystemAccount(tx as never, 'FEES', 'USD');
        return post(tx as never, SYSTEM_ACTOR, {
          idempotencyKey: 'fee-on-benefit',
          kind: 'FEE',
          entries: [
            { accountId: acct.id, side: 'D', amount: usd(1_00n) },
            { accountId: fees.id, side: 'C', amount: usd(1_00n) },
          ],
        });
      }),
    ).rejects.toThrow(BenefitSourceError);
    await expect(
      t.h.db.transaction(async (tx) => {
        const pc = await ensureSystemAccount(tx as never, 'PROVIDER_CLEARING', 'USD', 'ECOCASH');
        return post(tx as never, SYSTEM_ACTOR, {
          idempotencyKey: 'contribution-into-benefit',
          kind: 'CONTRIBUTION',
          entries: [
            { accountId: pc.id, side: 'D', amount: usd(1_00n) },
            { accountId: acct.id, side: 'C', amount: usd(1_00n) },
          ],
        });
      }),
    ).rejects.toThrow(BenefitSourceError);
  });
});

describe('no code path lets AI/OCR or a person change a claim status', () => {
  it('only sync.ts writes claim_status_mirror or posts BENEFIT journals', () => {
    const root = resolve(__dirname, '../../..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.') || name === 'db' || name === 'docs') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.ts$|test-support\.ts$/.test(name)) {
          const s = readFileSync(p, 'utf8');
          if (/claim_status_mirror\s*=/.test(s) || /kind:\s*'BENEFIT'/.test(s)) hits.push(p.slice(root.length + 1).replaceAll('\\', '/'));
        }
      }
    };
    walk(join(root, 'packages'));
    walk(join(root, 'apps'));
    expect(hits).toEqual(['packages/fidelity/src/sync.ts']);
  });
});
