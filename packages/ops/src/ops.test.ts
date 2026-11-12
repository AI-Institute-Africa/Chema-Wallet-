import { ConflictError, ForbiddenError, RefusedError, SYSTEM_ACTOR, type Actor } from '@chema/core';
import { ensureSystemAccount, getBalances, LedgerValidationError, post } from '@chema/ledger';
import { inTx } from '@chema/ledger/testing';
import { money } from '@chema/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalItem } from './queues';
import type { Kpi } from './reports';
import { createOpsHarness, type OpsHarness } from './test-support';

let t: OpsHarness | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

type Account = { id: string; kind: string; currency: string; code: string };

async function communityAccount(h: OpsHarness, actor: Actor, walletId: string): Promise<Account> {
  const accounts = (await h.ops.run(actor, h.ops.queues.adjustmentAccounts, { walletId })) as Account[];
  const a = accounts.find((x) => x.kind === 'COMMUNITY' && x.currency === 'USD');
  if (!a) throw new Error('no community account');
  return a;
}

async function suspense(h: OpsHarness) {
  return inTx(h.h.db, (tx) => ensureSystemAccount(tx, 'SUSPENSE_UNMATCHED', 'USD'));
}

const available = async (h: OpsHarness, walletId: string) =>
  (await getBalances(h.h.db, walletId)).find((b) => b.account.kind === 'COMMUNITY' && b.account.currency === 'USD')!.available.minor;

const REASON = 'Unmatched EcoCash credit traced to this family by provider statement.';

describe('ledger adjustment (maker-checker, docs/02 + docs/04 §1)', () => {
  it('needs a different ops person to approve, posts once, and only for the maker', async () => {
    t = await createOpsHarness();
    const w = await t.fundedWallet(100_00n);
    const maker = await t.h.staff('OPS_FINANCE');
    const checker = await t.h.staff('OPS_FINANCE');
    const sus = await suspense(t);
    const community = await communityAccount(t, maker.actor, w.walletId);
    const entries = [
      { accountId: sus.id, side: 'D' as const, minor: '2500', ccy: 'USD' as const },
      { accountId: community.id, side: 'C' as const, minor: '2500', ccy: 'USD' as const },
    ];
    const before = await available(t, w.walletId);

    const req = await t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON });
    expect(req.status).toBe('PENDING_APPROVAL');
    expect(await available(t, w.walletId)).toBe(before);

    // Maker cannot check, nor execute before approval.
    await expect(t.ops.run(maker.actor, t.ops.commands.decide, { approvalId: req.approvalId, decision: 'APPROVED' })).rejects.toThrow('MAKER_CANNOT_CHECK');
    await expect(t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON, approvalId: req.approvalId })).rejects.toThrow('NOT_APPROVED');
    // Neither family nor other staff roles can check a ledger adjustment.
    const auditor = await t.h.staff('AUDITOR');
    await expect(t.ops.run(auditor.actor, t.ops.commands.decide, { approvalId: req.approvalId, decision: 'APPROVED' })).rejects.toThrow(ForbiddenError);
    await expect(t.ops.run(w.approver.actor, t.ops.commands.decide, { approvalId: req.approvalId, decision: 'APPROVED' })).rejects.toThrow(ForbiddenError);

    await t.ops.run(checker.actor, t.ops.commands.decide, { approvalId: req.approvalId, decision: 'APPROVED' });
    // The checker cannot run what they approved; a changed payload is not what was approved.
    await expect(t.ops.run(checker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON, approvalId: req.approvalId })).rejects.toThrow('NOT_MAKER');
    const tampered = entries.map((e) => ({ ...e, minor: '9900' }));
    await expect(t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries: tampered, reason: REASON, approvalId: req.approvalId })).rejects.toThrow('APPROVAL_PAYLOAD_MISMATCH');

    const done = await t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON, approvalId: req.approvalId });
    expect(done.status).toBe('POSTED');
    expect(await available(t, w.walletId)).toBe(before + 2500n);
    await expect(t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON, approvalId: req.approvalId })).rejects.toThrow('APPROVAL_ALREADY_USED');

    const { rows } = await t.h.db.query<{ kind: string; approval_ref: string; reason: string }>(
      'SELECT kind, approval_ref, reason FROM ledger_journal WHERE id = $1',
      [(done as { journalId: string }).journalId],
    );
    expect(rows[0]).toEqual({ kind: 'ADJUSTMENT', approval_ref: req.approvalId, reason: REASON });
  });

  it('refuses requests the books would refuse, from the wrong people, or outside the portal', async () => {
    t = await createOpsHarness();
    const w = await t.fundedWallet(10_00n);
    const ops = await t.h.staff('OPS_FINANCE');
    const sus = await suspense(t);
    const community = await communityAccount(t, ops.actor, w.walletId);
    // Unbalanced: rejected at request time, no approval created.
    await expect(
      t.ops.run(ops.actor, t.ops.commands.ledgerAdjust, {
        entries: [
          { accountId: sus.id, side: 'D', minor: '100', ccy: 'USD' },
          { accountId: community.id, side: 'C', minor: '200', ccy: 'USD' },
        ],
        reason: REASON,
      }),
    ).rejects.toThrow();
    const { rows } = await t.h.db.query("SELECT 1 FROM approval WHERE action = 'ledger.adjust'");
    expect(rows).toHaveLength(0);

    const entries = [
      { accountId: sus.id, side: 'D' as const, minor: '100', ccy: 'USD' as const },
      { accountId: community.id, side: 'C' as const, minor: '100', ccy: 'USD' as const },
    ];
    for (const who of [w.admin.actor, (await t.h.staff('FIDELITY_ADMIN')).actor, (await t.h.staff('AGENT')).actor]) {
      await expect(t.ops.run(who, t.ops.commands.ledgerAdjust, { entries, reason: REASON })).rejects.toThrow(ForbiddenError);
    }
    // A staff identity on a non-portal channel never reaches a high-risk action.
    await expect(t.ops.run({ ...ops.actor, channel: 'WEB' }, t.ops.commands.ledgerAdjust, { entries, reason: REASON })).rejects.toThrow('PORTAL_ONLY');
    await expect(t.ops.run(ops.actor, t.ops.commands.ledgerAdjust, { entries, reason: 'short' })).rejects.toThrow('REASON_REQUIRED');

    // The ledger itself refuses an ADJUSTMENT that did not come from an approval.
    await expect(
      inTx(t.h.db, (tx) =>
        post(tx, SYSTEM_ACTOR, {
          idempotencyKey: 'rogue-adjust',
          kind: 'ADJUSTMENT',
          reason: 'no approval at all',
          entries: [
            { accountId: sus.id, side: 'D', amount: money(1n, 'USD') },
            { accountId: community.id, side: 'C', amount: money(1n, 'USD') },
          ],
        }),
      ),
    ).rejects.toThrow(LedgerValidationError);
  });

  it('shows the checker queue with who may decide each approval', async () => {
    t = await createOpsHarness();
    const w = await t.fundedWallet(10_00n);
    const maker = await t.h.staff('OPS_FINANCE');
    const other = await t.h.staff('OPS_FINANCE');
    const auditor = await t.h.staff('AUDITOR');
    const sus = await suspense(t);
    const community = await communityAccount(t, maker.actor, w.walletId);
    const req = await t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, {
      entries: [
        { accountId: sus.id, side: 'D', minor: '100', ccy: 'USD' },
        { accountId: community.id, side: 'C', minor: '100', ccy: 'USD' },
      ],
      reason: REASON,
    });
    const pick = (items: ApprovalItem[]) => items.find((i) => i.id === req.approvalId)!;
    expect(pick(await t.ops.run(maker.actor, t.ops.queues.approvals, {}))).toMatchObject({ canDecide: false, whyNot: 'MAKER_CANNOT_CHECK' });
    expect(pick(await t.ops.run(other.actor, t.ops.queues.approvals, {}))).toMatchObject({ canDecide: true, action: 'ledger.adjust' });
    expect(pick(await t.ops.run(auditor.actor, t.ops.queues.approvals, {})).canDecide).toBe(false);
    await expect(t.ops.run(w.admin.actor, t.ops.queues.approvals, {})).rejects.toThrow(ForbiddenError);
  });
});

describe('config flags (docs/12 queue 9)', () => {
  it('applies a non-financial flag at once and a financial one only after another admin approves', async () => {
    t = await createOpsHarness();
    const a = await t.h.staff('FIDELITY_ADMIN');
    const b = await t.h.staff('FIDELITY_ADMIN');
    const reason = 'Pilot board approved OCR assist for verifiers.';
    await t.ops.run(a.actor, t.ops.commands.flagApply, { key: 'ai.ocr', value: true, reason });
    expect(await t.h.flags.get('ai.ocr')).toBe(true);

    const key = 'feature.group_contributions';
    await expect(t.ops.run(a.actor, t.ops.commands.flagApply, { key, value: true, reason })).rejects.toThrow('DUAL_APPROVAL_REQUIRED');
    const { approvalId } = await t.ops.run(a.actor, t.ops.commands.flagRequest, { key, value: true });
    await expect(t.ops.run(a.actor, t.ops.commands.decide, { approvalId, decision: 'APPROVED' })).rejects.toThrow('MAKER_CANNOT_CHECK');
    await t.ops.run(b.actor, t.ops.commands.decide, { approvalId, decision: 'APPROVED' });
    // Approved value is pinned: a different value is refused.
    await expect(t.ops.run(a.actor, t.ops.commands.flagApply, { key, value: false, reason, approvalId })).rejects.toThrow('APPROVAL_PAYLOAD_MISMATCH');
    await t.ops.run(a.actor, t.ops.commands.flagApply, { key, value: true, reason, approvalId });
    expect(await t.h.flags.get(key)).toBe(true);

    await expect(t.ops.run(a.actor, t.ops.commands.flagApply, { key: 'commissions.enabled', value: true, reason })).rejects.toThrow();
    const ops = await t.h.staff('OPS_FINANCE');
    await expect(t.ops.run(ops.actor, t.ops.commands.flagApply, { key: 'ai.ocr', value: false, reason })).rejects.toThrow(ForbiddenError);

    const view = await t.ops.run(ops.actor, t.ops.queues.config, {});
    expect(view.flags.find((f) => (f as { key: string }).key === key)).toMatchObject({ value: true, source: 'db', financial: true });
    expect(view.changes.length).toBe(2);
  });
});

describe('staff and role admin (docs/02 Staff, docs/12 queue 10)', () => {
  it('enrols ordinary roles directly, privileged roles only with a second admin, and disables at once', async () => {
    t = await createOpsHarness();
    const a = await t.h.staff('FIDELITY_ADMIN');
    const b = await t.h.staff('FIDELITY_ADMIN');

    const v = await t.ops.run(a.actor, t.ops.commands.staffEnroll, { login: 'verifier.one', role: 'COMMUNITY_VERIFIER', name: 'V One' });
    if (v.status !== 'ENROLLED') throw new Error('expected enrolment');
    const s = await t.h.staffAuth.login({ login: 'verifier.one', password: v.initialPassword, totp: t.h.totpFor(v.totpSecret) });
    expect(await t.h.auth.authenticate(s.token)).toMatchObject({ kind: 'STAFF', staffRole: 'COMMUNITY_VERIFIER', mfa: true });

    const req = await t.ops.run(a.actor, t.ops.commands.staffEnroll, { login: 'finance.two', role: 'OPS_FINANCE' });
    expect(req.status).toBe('PENDING_APPROVAL');
    const approvalId = (req as { approvalId: string }).approvalId;
    await expect(t.ops.run(a.actor, t.ops.commands.decide, { approvalId, decision: 'APPROVED' })).rejects.toThrow('MAKER_CANNOT_CHECK');
    await t.ops.run(b.actor, t.ops.commands.decide, { approvalId, decision: 'APPROVED' });
    await expect(t.ops.run(a.actor, t.ops.commands.staffEnroll, { login: 'finance.two', role: 'FIDELITY_ADMIN', approvalId })).rejects.toThrow('APPROVAL_PAYLOAD_MISMATCH');
    const fin = await t.ops.run(a.actor, t.ops.commands.staffEnroll, { login: 'finance.two', role: 'OPS_FINANCE', approvalId });
    expect(fin.status).toBe('ENROLLED');

    // Disable: sessions die immediately; nobody disables themselves; privileged re-enable is dual.
    const staffId = (v as { staffId: string }).staffId;
    await expect(
      t.ops.run(a.actor, t.ops.commands.staffSetDisabled, { staffId: (fin as { staffId: string }).staffId, disabled: false, reason: 'Re-enable after leave of absence.' }),
    ).resolves.toMatchObject({ status: 'DONE', changed: false });
    await t.ops.run(a.actor, t.ops.commands.staffSetDisabled, { staffId, disabled: true, reason: 'Left the verification team.' });
    expect(await t.h.auth.authenticate(s.token)).toBeNull();
    const { rows } = await t.h.db.query<{ id: string }>('SELECT id FROM staff_account WHERE person_id = $1', [a.personId]);
    await expect(t.ops.run(a.actor, t.ops.commands.staffSetDisabled, { staffId: rows[0]!.id, disabled: true, reason: 'Trying to lock myself out.' })).rejects.toThrow('CANNOT_CHANGE_OWN_ACCOUNT');
    const finId = (fin as { staffId: string }).staffId;
    await t.ops.run(a.actor, t.ops.commands.staffSetDisabled, { staffId: finId, disabled: true, reason: 'Suspended pending review.' });
    const back = await t.ops.run(a.actor, t.ops.commands.staffSetDisabled, { staffId: finId, disabled: false, reason: 'Review cleared, restoring access.' });
    expect(back.status).toBe('PENDING_APPROVAL');

    const review = await t.ops.run((await t.h.staff('AUDITOR')).actor, t.ops.queues.accessReview, {});
    expect(review.csv).toContain('verifier.one,COMMUNITY_VERIFIER,true');
    expect(review.csv).toContain('finance.two,OPS_FINANCE,true');
    await expect(t.ops.run((await t.h.staff('OPS_FINANCE')).actor, t.ops.commands.staffEnroll, { login: 'x.y.z', role: 'AGENT' })).rejects.toThrow(ForbiddenError);
  });

  it('scopes a verifier\'s queues to assigned wallets and refuses family members as case staff', async () => {
    t = await createOpsHarness();
    const fa = await t.h.staff('FIDELITY_ADMIN');
    const verifier = await t.h.staff('COMMUNITY_VERIFIER');
    const w = await t.fundedWallet(10_00n);
    await t.h.db.query(
      `INSERT INTO fraud_flag (wallet_id, rule, dedupe_key, created_at) VALUES ($1, 'CREATOR_VELOCITY', 'test:velocity', now())`,
      [w.walletId],
    );
    expect((await t.ops.run(verifier.actor, t.ops.queues.fraud, {})).flags).toHaveLength(0);
    expect((await t.ops.run(fa.actor, t.ops.queues.fraud, {})).flags).toHaveLength(1);
    await t.ops.run(fa.actor, t.ops.commands.staffAssign, { staffPersonId: verifier.personId, walletId: w.walletId });
    expect((await t.ops.run(verifier.actor, t.ops.queues.fraud, {})).flags).toHaveLength(1);
    await expect(t.ops.run(fa.actor, t.ops.commands.staffAssign, { staffPersonId: verifier.personId, walletId: w.walletId })).rejects.toThrow('ALREADY_ASSIGNED');

    const conflicted = await t.h.staff('CLAIMS_OFFICER');
    await t.h.grantRole(w.walletId, conflicted.personId, 'APPROVER');
    await expect(t.ops.run(fa.actor, t.ops.commands.staffAssign, { staffPersonId: conflicted.personId, walletId: w.walletId })).rejects.toThrow('FAMILY_ROLE_CONFLICT');
  });
});

describe('access review sign-off (docs/12 queue 10)', () => {
  const NOTES = 'Reviewed every staff account against the HR roster; no exceptions.';

  it('records who reviewed which exact export for which period; a stale export and a self-certifying admin are refused (audited)', async () => {
    t = await createOpsHarness();
    const x = t;
    const auditor = await x.h.staff('AUDITOR');
    const admin = await x.h.staff('FIDELITY_ADMIN');
    const from = '2026-01-01T00:00:00.000Z';
    // The admin changes staff access inside the period under review.
    await x.ops.run(admin.actor, x.ops.commands.staffEnroll, { login: 'agent.review', role: 'AGENT' });

    const exp = await x.ops.run(auditor.actor, x.ops.queues.accessReview, {});
    expect(exp.csvSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(exp.rowCount).toBe(exp.rows.length);
    expect(exp.signoffs).toEqual([]);
    const input = { periodFrom: from, periodTo: x.h.now().toISOString(), rowCount: exp.rowCount, csvSha256: exp.csvSha256, notes: NOTES };

    // Only an AUDITOR or a FIDELITY_ADMIN may sign; not ops/finance.
    const ops = await x.h.staff('OPS_FINANCE');
    await expect(x.ops.run(ops.actor, x.ops.commands.accessReviewSignoff, input)).rejects.toBeInstanceOf(ForbiddenError);
    // ops was enrolled after the export: the auditor's export is now stale ⇒ refused, audited, nothing stored.
    const stale = await x.ops.run(auditor.actor, x.ops.commands.accessReviewSignoff, input).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(RefusedError);
    expect((stale as RefusedError).reason).toBe('EXPORT_CHANGED');

    const fresh = await x.ops.run(auditor.actor, x.ops.queues.accessReview, {});
    const current = { ...input, periodTo: x.h.now().toISOString(), rowCount: fresh.rowCount, csvSha256: fresh.csvSha256 };
    // The admin who enrolled someone during the period cannot certify that period.
    await expect(x.ops.run(admin.actor, x.ops.commands.accessReviewSignoff, current)).rejects.toThrow('REVIEWER_CHANGED_ACCESS');
    // Notes are required.
    await expect(x.ops.run(auditor.actor, x.ops.commands.accessReviewSignoff, { ...current, notes: 'ok' })).rejects.toThrow('REASON_REQUIRED');
    const { signoffId } = await x.ops.run(auditor.actor, x.ops.commands.accessReviewSignoff, current);

    const { rows } = await x.h.db.query<Record<string, unknown>>('SELECT * FROM access_review_signoff');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: signoffId, reviewer_person: auditor.personId, reviewer_role: 'AUDITOR', row_count: fresh.rowCount, csv_sha256: fresh.csvSha256, notes: NOTES });
    const { rows: audit } = await x.h.db.query<{ actor_id: string; authz_result: string; reason_code: string }>(
      "SELECT actor_id, authz_result, reason_code FROM audit_log WHERE action = 'role.review.signoff' ORDER BY audit_log.seq",
    );
    expect(audit).toEqual([
      { actor_id: ops.personId, authz_result: 'DENIED', reason_code: 'NO_PERMISSION' },
      { actor_id: auditor.personId, authz_result: 'DENIED', reason_code: 'EXPORT_CHANGED' },
      { actor_id: admin.personId, authz_result: 'DENIED', reason_code: 'REVIEWER_CHANGED_ACCESS' },
      { actor_id: auditor.personId, authz_result: 'ALLOWED', reason_code: 'ACCESS_REVIEW_SIGNED' },
    ]);
    // The sign-off shows on the next export, and cannot be edited or deleted.
    const next = await x.ops.run(auditor.actor, x.ops.queues.accessReview, {});
    expect(next.signoffs).toEqual([expect.objectContaining({ id: signoffId, reviewerPersonId: auditor.personId, csvSha256: fresh.csvSha256 })]);
    await expect(x.h.db.query("UPDATE access_review_signoff SET notes = 'rewritten after the fact' WHERE id = $1", [signoffId])).rejects.toThrow(/append-only/);
    await expect(x.h.db.query('DELETE FROM access_review_signoff WHERE id = $1', [signoffId])).rejects.toThrow(/append-only/);
  });

  it('an admin who changed no access in the period may sign it', async () => {
    t = await createOpsHarness();
    const x = t;
    const admin = await x.h.staff('FIDELITY_ADMIN');
    const exp = await x.ops.run(admin.actor, x.ops.queues.accessReview, {});
    const out = await x.ops.run(admin.actor, x.ops.commands.accessReviewSignoff, {
      periodFrom: '2026-01-01T00:00:00.000Z',
      periodTo: x.h.now().toISOString(),
      rowCount: exp.rowCount,
      csvSha256: exp.csvSha256,
      notes: NOTES,
    });
    expect(out.signoffId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('reconciliation exceptions (docs/04 §7)', () => {
  it('is owned, and resolved only after its hold went through dual release', async () => {
    t = await createOpsHarness();
    const w = await t.fundedWallet(10_00n);
    const a = await t.h.staff('OPS_FINANCE');
    const b = await t.h.staff('OPS_FINANCE');
    const { holdId } = await t.payouts.run(a.actor, t.payouts.governance.holdPlace, {
      walletId: w.walletId,
      scope: 'SOURCE',
      source: { kind: 'COMMUNITY' },
      reasonCode: 'RECON_VARIANCE',
      note: 'Settlement short against ledger credits.',
      reviewAt: new Date(t.h.now().getTime() + 86_400_000),
    });
    const { rows } = await t.h.db.query<{ id: string }>(
      `INSERT INTO recon_exception (dedup_key, kind, severity, rail, wallet_id, currency, variance_minor, detail, hold_id, owner_role, opened_at, sla_due_at)
       VALUES ('test:variance', 'AMOUNT_VARIANCE', 'MEDIUM', 'ECOCASH', $1, 'USD', 500, 'Settlement short by 5.00', $2, 'OPS_FINANCE', $3, $4) RETURNING id`,
      [w.walletId, holdId, t.h.now().toISOString(), new Date(t.h.now().getTime() + 72 * 3_600_000).toISOString()],
    );
    const exceptionId = rows[0]!.id;
    const resolution = 'Provider resent the missing settlement row; matched.';

    await expect(t.ops.run(a.actor, t.ops.commands.reconResolve, { exceptionId, resolution })).rejects.toThrow('NOT_OWNER');
    await t.ops.run(a.actor, t.ops.commands.reconAssign, { exceptionId });
    await expect(t.ops.run(b.actor, t.ops.commands.reconAssign, { exceptionId })).rejects.toThrow(ConflictError);
    await expect(t.ops.run(a.actor, t.ops.commands.reconResolve, { exceptionId, resolution })).rejects.toThrow('HOLD_ACTIVE');

    const holds = await t.ops.run(b.actor, t.ops.queues.holds, {});
    expect(holds.map((h) => (h as { id: string }).id)).toContain(holdId);
    const rel = await t.payouts.run(a.actor, t.payouts.governance.holdRelease, { holdId, reason: 'Variance explained by late settlement row.' });
    await expect(t.ops.run(a.actor, t.ops.commands.decide, { approvalId: rel.approvalId, decision: 'APPROVED' })).rejects.toThrow('MAKER_CANNOT_CHECK');
    await t.ops.run(b.actor, t.ops.commands.decide, { approvalId: rel.approvalId, decision: 'APPROVED' });
    await t.payouts.run(a.actor, t.payouts.governance.holdRelease, { holdId, reason: 'Variance explained by late settlement row.', approvalId: rel.approvalId });

    await t.ops.run(a.actor, t.ops.commands.reconResolve, { exceptionId, resolution });
    await expect(t.ops.run(a.actor, t.ops.commands.reconResolve, { exceptionId, resolution })).rejects.toThrow('ALREADY_RESOLVED');

    const fin = await t.ops.run(a.actor, t.ops.reports.finance, {});
    expect(fin.exceptionAgeing).toEqual([]);
  });
});

describe('support hand-off (docs/12 Support)', () => {
  it('lists open WhatsApp escalations with their reference and closes them with a note', async () => {
    t = await createOpsHarness();
    const p = '+263771234500';
    await t.say(p, 'hi');
    await t.say(p, 'blah');
    await t.say(p, 'blah blah');
    await t.say(p, 'zzz');
    const reply = await t.say(p, '1');
    const ref = /WA-[A-Z2-7]{8}/.exec(reply)?.[0];
    const ops = await t.h.staff('OPS_FINANCE');
    const q = (await t.ops.run(ops.actor, t.ops.queues.support, {})) as { id: string; ref: string; reason: string; signedIn: boolean }[];
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ ref, reason: 'MISUNDERSTOOD', signedIn: false });
    await t.ops.run(ops.actor, t.ops.commands.supportClose, { escalationId: q[0]!.id, note: 'Called back; helped them find the wallet link.' });
    expect(await t.ops.run(ops.actor, t.ops.queues.support, {})).toHaveLength(0);
    await expect(t.ops.run(ops.actor, t.ops.commands.supportClose, { escalationId: q[0]!.id, note: 'Closing it a second time.' })).rejects.toThrow('ALREADY_CLOSED');
    await expect(t.ops.run((await t.h.staff('AGENT')).actor, t.ops.queues.support, {})).rejects.toThrow(ForbiddenError);
  });
});

describe('reports (docs/12)', () => {
  it('reports KPIs per currency, never estimates what is not measured, and gates each report by role', async () => {
    t = await createOpsHarness();
    const w = await t.fundedWallet(300_00n);
    const fa = await t.h.staff('FIDELITY_ADMIN');
    // Ledger rows carry the database clock, not the harness clock: use a wide window.
    const wide = { from: '2026-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };
    const r = await t.ops.run(fa.actor, t.ops.reports.management, wide);
    const k = (id: string) => r.kpis.find((x: Kpi) => x.id === id)!;
    expect(k('funerals_supported').value).toBe(1);
    expect(k('community_raised').breakdown).toEqual({ USD: '30000' });
    expect(k('duplicate_postings').value).toBe(0);
    expect(k('verify_pass_rate').value).toBe(1);
    for (const id of ['link_conversion', 'availability', 'satisfaction', 'fidelity_value']) {
      expect(k(id)).toMatchObject({ measured: false, value: null });
    }
    const ops = await t.h.staff('OPS_FINANCE');
    await expect(t.ops.run(ops.actor, t.ops.reports.management, {})).rejects.toThrow(ForbiddenError);

    const fam = await t.ops.run(ops.actor, t.ops.reports.family, { walletId: w.walletId });
    expect((fam.contributions as { settled: number }).settled).toBe(1);
    const reg = await t.ops.run((await t.h.staff('AUDITOR')).actor, t.ops.reports.regulator, wide);
    expect(reg.format).toBe('GENERIC_CSV_PENDING_D18');
    expect(reg.csv).toContain(`${w.walletId},ACTIVE,USD`);
    await expect(t.ops.run(ops.actor, t.ops.reports.regulator, {})).rejects.toThrow(ForbiddenError);

    const agent = await t.h.staff('AGENT');
    const ar = (await t.ops.run(agent.actor, t.ops.reports.agent, {})) as { personId: string }[];
    expect(ar.map((x) => x.personId)).toEqual([agent.personId]);
  });
});

describe('audit explorer (docs/14: audit reconstruction of a wallet)', () => {
  it('reconstructs a wallet from audit + ledger on seeded data and flags a journal nobody audited', async () => {
    t = await createOpsHarness();
    const w = await t.fundedWallet(200_00n);
    const maker = await t.h.staff('OPS_FINANCE');
    const checker = await t.h.staff('OPS_FINANCE');
    const auditor = await t.h.staff('AUDITOR');
    const sus = await suspense(t);
    const community = await communityAccount(t, maker.actor, w.walletId);
    const entries = [
      { accountId: sus.id, side: 'D' as const, minor: '700', ccy: 'USD' as const },
      { accountId: community.id, side: 'C' as const, minor: '700', ccy: 'USD' as const },
    ];
    const req = await t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON });
    await t.ops.run(checker.actor, t.ops.commands.decide, { approvalId: req.approvalId, decision: 'APPROVED' });
    await t.ops.run(maker.actor, t.ops.commands.ledgerAdjust, { entries, reason: REASON, approvalId: req.approvalId });

    const r = await t.ops.run(auditor.actor, t.ops.audit.walletTimeline, { walletId: w.walletId });
    expect(r.checks.unexplainedJournals).toEqual([]);
    expect(r.checks.journals).toBe(2); // the contribution + the adjustment
    expect(r.checks.balancesOk).toBe(true);
    expect(r.checks.chain.ok).toBe(true);
    expect(r.ok).toBe(true);
    const actions = r.events.map((e) => e.action);
    for (const a of ['wallet.create_draft', 'verification.decide', 'contribution.create', 'ledger.contribution', 'ledger.adjust', 'ledger.adjustment', 'approval.decide']) {
      expect(actions).toContain(a);
    }

    // A journal written straight to the database, outside any command.
    const clearing = await inTx(t.h.db, (tx) => ensureSystemAccount(tx, 'PROVIDER_CLEARING', 'USD', 'ECOCASH'));
    const rogue = await inTx(t.h.db, (tx) =>
      post(tx, SYSTEM_ACTOR, {
        idempotencyKey: 'rogue-credit',
        kind: 'CONTRIBUTION',
        entries: [
          { accountId: clearing.id, side: 'D', amount: money(100n, 'USD'), txnRef: 'payment:00000000-0000-4000-8000-000000000000' },
          { accountId: community.id, side: 'C', amount: money(100n, 'USD'), txnRef: 'payment:00000000-0000-4000-8000-000000000000' },
        ],
      }),
    );
    const bad = await t.ops.run(auditor.actor, t.ops.audit.walletTimeline, { walletId: w.walletId });
    expect(bad.checks.unexplainedJournals).toEqual([rogue.journalId]);
    expect(bad.ok).toBe(false);

    expect(await t.ops.run(auditor.actor, t.ops.audit.verifyChain, {})).toMatchObject({ ok: true });
    await expect(t.ops.run(maker.actor, t.ops.audit.verifyChain, {})).rejects.toThrow(ForbiddenError);
    await expect(t.ops.run(w.admin.actor, t.ops.audit.walletTimeline, { walletId: w.walletId })).rejects.toThrow(ForbiddenError);
  });
});
