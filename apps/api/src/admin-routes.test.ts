// P09 over HTTP: staff-only portal surface, role-gated nav, a ledger
// adjustment end to end through the shared checker route (maker ≠ checker),
// a staff enrolment that logs in, CSV exports, audit reconstruction.
import { ensureSystemAccount } from '@chema/ledger';
import { inTx } from '@chema/ledger/testing';
import { createOpsHarness, type OpsHarness } from '@chema/ops/testing';
import { PUBLIC_BASE } from '@chema/wallet/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let t: OpsHarness;
let app: FastifyInstance;
beforeAll(async () => {
  t = await createOpsHarness();
  app = buildApp({
    db: t.h.db,
    core: t.h,
    payments: t.payments,
    wallets: { commands: t.w, publicBaseUrl: PUBLIC_BASE },
    contributions: t.contributions,
    claims: t.claims,
    payouts: t.payouts,
    ops: t.ops,
  });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('admin routes', () => {
  it('serves staff only, with a nav that follows the permission matrix', async () => {
    const customer = await t.h.customer();
    expect((await app.inject({ method: 'GET', url: '/admin/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/admin/me', headers: auth(customer.token) })).statusCode).toBe(403);
    const ops = await t.h.staff('OPS_FINANCE');
    const me = (await app.inject({ method: 'GET', url: '/admin/me', headers: auth(ops.token) })).json();
    expect(me.role).toBe('OPS_FINANCE');
    expect(me.sections).toEqual(expect.arrayContaining(['approvals', 'recon', 'ledger', 'holds', 'reports', 'audit']));
    expect(me.sections).not.toContain('verification');
    expect(me.sections).not.toContain('management');
    const verifier = await t.h.staff('COMMUNITY_VERIFIER');
    const v = (await app.inject({ method: 'GET', url: '/admin/me', headers: auth(verifier.token) })).json();
    expect(v.sections).toEqual(expect.arrayContaining(['verification', 'moderation', 'fraud']));
    expect(v.sections).not.toContain('ledger');
    expect((await app.inject({ method: 'GET', url: '/admin/queues/holds', headers: auth(verifier.token) })).statusCode).toBe(403);
  });

  it('adjusts the ledger only after a second ops person approves on the checker route', async () => {
    const w = await t.fundedWallet(20_00n);
    const maker = await t.h.staff('OPS_FINANCE');
    const checker = await t.h.staff('OPS_FINANCE');
    const accounts = (await app.inject({ method: 'GET', url: `/admin/ledger/accounts?walletId=${w.walletId}`, headers: auth(maker.token) })).json();
    const community = accounts.find((a: { kind: string; currency: string }) => a.kind === 'COMMUNITY' && a.currency === 'USD');
    await inTx(t.h.db, (tx) => ensureSystemAccount(tx, 'FEES', 'USD'));
    const fees = (await app.inject({ method: 'GET', url: '/admin/ledger/accounts', headers: auth(maker.token) })).json()
      .find((a: { kind: string; currency: string }) => a.kind === 'FEES' && a.currency === 'USD');
    // Debit the wallet to FEES (an allowed exit): checked against available funds like any debit.
    const body = {
      entries: [
        { accountId: community.id, side: 'D', minor: '150', ccy: 'USD' },
        { accountId: fees.id, side: 'C', minor: '150', ccy: 'USD' },
      ],
      reason: 'Provider fee missed at settlement, per finance memo 12.',
    };
    let r = await app.inject({ method: 'POST', url: '/admin/ledger/adjustments', headers: auth(maker.token), payload: body });
    expect(r.statusCode).toBe(202);
    const { approvalId } = r.json();
    r = await app.inject({ method: 'POST', url: `/approvals/${approvalId}/decision`, headers: auth(maker.token), payload: { decision: 'APPROVED' } });
    expect(r.statusCode).toBe(403);
    r = await app.inject({ method: 'POST', url: `/approvals/${approvalId}/decision`, headers: auth(checker.token), payload: { decision: 'APPROVED' } });
    expect(r.statusCode).toBe(200);
    r = await app.inject({ method: 'POST', url: '/admin/ledger/adjustments', headers: auth(maker.token), payload: { ...body, approvalId } });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('POSTED');

    const auditor = await t.h.staff('AUDITOR');
    r = await app.inject({ method: 'GET', url: `/admin/audit/wallets/${w.walletId}`, headers: auth(auditor.token) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, checks: { unexplainedJournals: [] } });
    r = await app.inject({ method: 'POST', url: '/admin/audit/verify', headers: auth(auditor.token) });
    expect(r.json()).toMatchObject({ ok: true });
  });

  it('enrols staff who can then log in, and exports the access review as CSV', async () => {
    const fa = await t.h.staff('FIDELITY_ADMIN');
    let r = await app.inject({ method: 'POST', url: '/admin/staff', headers: auth(fa.token), payload: { login: 'claims.nyasha', role: 'CLAIMS_OFFICER' } });
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const e = r.json();
    r = await app.inject({ method: 'POST', url: '/staff/auth/login', payload: { login: 'claims.nyasha', password: e.initialPassword, totp: t.h.totpFor(e.totpSecret) } });
    expect(r.statusCode).toBe(200);
    r = await app.inject({ method: 'POST', url: '/admin/staff', headers: auth(fa.token), payload: { login: 'admin.two', role: 'FIDELITY_ADMIN' } });
    expect(r.statusCode).toBe(202);
    r = await app.inject({ method: 'GET', url: '/admin/staff?format=csv', headers: auth(fa.token) });
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain('claims.nyasha,CLAIMS_OFFICER,false');
    expect(r.body).not.toContain('admin.two');
  });

  it('access review: export with sha256, sign-off 201 (stale export 409), listed afterwards', async () => {
    const auditor = await t.h.staff('AUDITOR');
    let r = await app.inject({ method: 'GET', url: '/admin/access-review', headers: auth(auditor.token) });
    expect(r.statusCode).toBe(200);
    const exp = r.json<{ csv: string; csvSha256: string; rowCount: number }>();
    const csv = await app.inject({ method: 'GET', url: '/admin/staff?format=csv', headers: auth(auditor.token) });
    expect(csv.body).toBe(exp.csv);
    const body = { periodFrom: '2026-01-01T00:00:00.000Z', periodTo: t.h.now().toISOString(), rowCount: exp.rowCount, csvSha256: exp.csvSha256, notes: 'Quarterly review: all accounts match the HR roster.' };
    r = await app.inject({ method: 'POST', url: '/admin/access-review/signoffs', headers: auth(auditor.token), payload: body });
    expect(r.statusCode).toBe(201);
    const { signoffId } = r.json<{ signoffId: string }>();
    r = await app.inject({ method: 'POST', url: '/admin/access-review/signoffs', headers: auth(auditor.token), payload: { ...body, csvSha256: '0'.repeat(64) } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'export_changed' });
    r = await app.inject({ method: 'POST', url: '/admin/access-review/signoffs', headers: auth(auditor.token), payload: { ...body, periodTo: body.periodFrom } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'GET', url: '/admin/access-review', headers: auth(auditor.token) });
    expect(r.json().signoffs[0]).toMatchObject({ id: signoffId, reviewerRole: 'AUDITOR' });
  });

  it('a Fidelity admin signs a suspected-compromised customer out everywhere (reason required); others cannot', async () => {
    const victim = await t.h.customer();
    const fa = await t.h.staff('FIDELITY_ADMIN');
    const ops = await t.h.staff('OPS_FINANCE');
    const url = `/admin/people/${victim.personId}/sessions/revoke`;
    expect((await app.inject({ method: 'POST', url, headers: auth(fa.token), payload: { reason: 'short' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: auth(ops.token), payload: { reason: 'Customer reported a lost phone today.' } })).statusCode).toBe(403);
    const r = await app.inject({ method: 'POST', url, headers: auth(fa.token), payload: { reason: 'Customer reported a lost phone today.' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ revoked: 1 });
    expect(await t.h.auth.authenticate(victim.token)).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/admin/people/00000000-0000-4000-8000-000000000000/sessions/revoke', headers: auth(fa.token), payload: { reason: 'Customer reported a lost phone today.' } })).statusCode).toBe(404);
  });

  it('UI gaps: GET /me, the family people list, the verifier mandate queue, ops override evidence upload', async () => {
    const w = await t.fundedWallet(20_00n);
    // Who am I (self only).
    const me = await app.inject({ method: 'GET', url: '/me', headers: auth(w.admin.token) });
    expect(me.json()).toMatchObject({ personId: w.admin.personId, kind: 'CUSTOMER' });
    // People on the wallet: admin + approver see ids, names, roles; nobody else.
    const people = await app.inject({ method: 'GET', url: `/wallets/${w.walletId}/people`, headers: auth(w.approver.token) });
    expect(people.statusCode).toBe(200);
    const list = people.json<{ people: { personId: string; roles: string[] }[] }>().people;
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ personId: w.admin.personId, roles: ['ADMIN'] }),
      expect.objectContaining({ personId: w.approver.personId, roles: ['APPROVER'] }),
    ]));
    expect(JSON.stringify(list)).not.toMatch(/\+263/);
    const stranger = await t.h.customer();
    expect((await app.inject({ method: 'GET', url: `/wallets/${w.walletId}/people`, headers: auth(stranger.token) })).statusCode).toBe(403);
    const ops = await t.h.staff('OPS_FINANCE');
    expect((await app.inject({ method: 'GET', url: `/wallets/${w.walletId}/people`, headers: auth(ops.token) })).statusCode).toBe(403);

    // Mandate change awaiting the verifier: an assigned verifier sees it, an unassigned one does not.
    const doc = await t.upload(w.admin.actor, w.walletId, 'MANDATE');
    const token = await t.stepUp(w.admin, 'mandate.change', w.walletId);
    const change = await t.payouts.run(w.admin.actor, t.payouts.mandate.request, { walletId: w.walletId, kind: 'ADD_APPROVER', approverPhone: '+263719990088', reason: 'Adding my aunt as a second approver.', evidenceDocs: [doc] }, token);
    const v = await t.verifier();
    const other = await t.verifier();
    await t.h.assign(v.personId, w.walletId);
    const q = (tok: string) => app.inject({ method: 'GET', url: '/admin/queues/mandate-changes', headers: auth(tok) });
    expect((await q(v.token)).json()).toEqual([expect.objectContaining({ changeId: change.id, walletId: w.walletId, kind: 'ADD_APPROVER', evidenceCount: 1 })]);
    expect((await q(other.token)).json()).toEqual([]);
    expect((await q(ops.token)).statusCode).toBe(403);
    const fa = await t.h.staff('FIDELITY_ADMIN');
    expect((await q(fa.token)).json().map((c: { changeId: string }) => c.changeId)).toContain(change.id);

    // Ops/finance may upload only OVERRIDE_EVIDENCE, only to a wallet with a payout on a down rail.
    const pdf = Buffer.from('%PDF-1.4 override receipt').toString('base64');
    const up = (cls: string, tok: string) =>
      app.inject({ method: 'POST', url: '/documents', headers: auth(tok), payload: { class: cls, contentType: 'application/pdf', dataBase64: pdf, walletId: w.walletId } });
    expect((await up('OVERRIDE_EVIDENCE', ops.token)).statusCode).toBe(403); // no RAIL_DOWN payout here
    expect((await up('OTHER', ops.token)).statusCode).toBe(403);
    expect((await up('OVERRIDE_EVIDENCE', w.admin.token)).statusCode).toBe(403); // the family never uploads that class
    const { rows } = await t.h.db.query<{ reason_code: string }>(
      "SELECT reason_code FROM audit_log WHERE action = 'document.upload' AND authz_result = 'DENIED' AND actor_id = $1 ORDER BY audit_log.seq",
      [ops.personId],
    );
    expect(rows.map((r) => r.reason_code)).toEqual(['NO_PAYOUT_TO_OVERRIDE', 'OPS_UPLOADS_OVERRIDE_EVIDENCE_ONLY']);
  });

  it('reports and regulator CSV; bad periods are 400', async () => {
    const fa = await t.h.staff('FIDELITY_ADMIN');
    let r = await app.inject({ method: 'GET', url: '/admin/reports/management?from=2026-01-01T00:00:00Z&to=2100-01-01T00:00:00Z', headers: auth(fa.token) });
    expect(r.statusCode).toBe(200);
    expect(r.json().kpis.length).toBeGreaterThan(10);
    r = await app.inject({ method: 'GET', url: '/admin/reports/management?from=yesterday', headers: auth(fa.token) });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'GET', url: '/admin/reports/regulator?format=csv', headers: auth(fa.token) });
    expect(r.body.split('\n')[0]).toBe('id,status,currency,created_at,verified_at,community_net_minor,benefit_minor,paid_out_minor,contributions');
  });
});
