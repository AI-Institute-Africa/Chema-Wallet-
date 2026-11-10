// CommandBus, consent, maker-checker approvals and financial flag changes,
// end to end on PGlite with real sessions.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApproval, consumeApproval, decideApproval, requiresDual } from '../approval/service';
import { verifyChain } from '../audit/chain';
import { grantConsent, hasConsent, listConsents, withdrawConsent } from '../consent/service';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors';
import { requestFlagChange } from '../flags/commands';
import { DualApprovalRequiredError } from '../flags/service';
import { createHarness, type Harness } from '../test-support';
import type { Command } from './bus';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

async function auditFor(subjectId: string) {
  const { rows } = await h.db.query<{ action: string; authz_result: string; reason_code: string | null }>(
    'SELECT action, authz_result, reason_code FROM audit_log WHERE subject_id = $1 ORDER BY audit_log.seq',
    [subjectId],
  );
  return rows;
}

/** Test-only maker command standing in for P07's payout request. */
const requestPayout: Command<{ walletId: string; amountMinor: bigint; fail?: boolean }, { approvalId: string | null }> = {
  name: 'payout.request',
  async resolve(_q, input) {
    return { action: 'payout.request', subject: { type: 'wallet', id: input.walletId, walletId: input.walletId, amountMinor: input.amountMinor } };
  },
  async run(tx, input, ctx) {
    if (input.fail) throw new Error('handler failed');
    const approvalId = await createApproval(tx, ctx.actor, {
      action: 'payout.request',
      subjectType: 'wallet',
      subjectId: input.walletId,
      walletId: input.walletId,
      payload: { walletId: input.walletId, amountMinor: input.amountMinor },
      amount: { minor: input.amountMinor, ccy: 'USD' },
    });
    return { result: { approvalId }, audit: { approvalRef: approvalId } };
  },
};

async function familyWallet() {
  const walletId = randomUUID();
  const admin = await h.customer();
  const approver = await h.customer();
  await h.grantRole(walletId, admin.personId, 'ADMIN');
  await h.grantRole(walletId, approver.personId, 'APPROVER');
  return { walletId, admin, approver };
}

async function stepUp(actor: Awaited<ReturnType<Harness['customer']>>, walletId: string) {
  const { challengeId } = await h.auth.startStepUp(actor.actor, { action: 'payout.request', subjectType: 'wallet', subjectId: walletId });
  const phone = (await h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [actor.personId])).rows[0]!.phone_e164;
  return (await h.auth.verifyStepUp(actor.actor, challengeId, h.otp.lastCodeFor(phone)!)).stepUpToken;
}

describe('CommandBus', () => {
  it('denial: nothing changes, DENIED row audited with reason', async () => {
    const { walletId } = await familyWallet();
    const outsider = await h.customer();
    await expect(h.bus.execute(requestPayout, { walletId, amountMinor: 10_00n }, { actor: outsider.actor })).rejects.toMatchObject({
      reason: 'NO_PERMISSION',
    });
    expect(await auditFor(walletId)).toEqual([{ action: 'payout.request', authz_result: 'DENIED', reason_code: 'NO_PERMISSION' }]);
    const { rows } = await h.db.query('SELECT 1 FROM approval WHERE subject_id = $1', [walletId]);
    expect(rows).toHaveLength(0);
  });

  it('step-up required: refused without a grant, allowed with one, grant is single-use', async () => {
    const { walletId, admin } = await familyWallet();
    await expect(h.bus.execute(requestPayout, { walletId, amountMinor: 10_00n }, { actor: admin.actor })).rejects.toMatchObject({
      reason: 'STEP_UP_REQUIRED',
    });
    const token = await stepUp(admin, walletId);
    const out = await h.bus.execute(requestPayout, { walletId, amountMinor: 10_00n }, { actor: admin.actor, stepUpToken: token });
    expect(out.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      h.bus.execute(requestPayout, { walletId, amountMinor: 10_00n }, { actor: admin.actor, stepUpToken: token }),
    ).rejects.toMatchObject({ reason: 'STEP_UP_REQUIRED' });
    expect((await auditFor(walletId)).map((r) => `${r.authz_result}:${r.reason_code ?? ''}`)).toEqual([
      'DENIED:STEP_UP_REQUIRED',
      'ALLOWED:payout.request', // identity.step_up row (subject = wallet)
      'ALLOWED:',
      'DENIED:STEP_UP_REQUIRED',
    ]);
  });

  it('a step-up grant for wallet A does not unlock wallet B', async () => {
    const a = await familyWallet();
    const walletB = randomUUID();
    await h.grantRole(walletB, a.admin.personId, 'ADMIN');
    const token = await stepUp(a.admin, a.walletId);
    await expect(
      h.bus.execute(requestPayout, { walletId: walletB, amountMinor: 1n }, { actor: a.admin.actor, stepUpToken: token }),
    ).rejects.toMatchObject({ reason: 'STEP_UP_REQUIRED' });
  });

  it('handler failure rolls back state and the ALLOWED audit row together', async () => {
    const { walletId, admin } = await familyWallet();
    const token = await stepUp(admin, walletId);
    await expect(
      h.bus.execute(requestPayout, { walletId, amountMinor: 1n, fail: true }, { actor: admin.actor, stepUpToken: token }),
    ).rejects.toThrow('handler failed');
    expect((await auditFor(walletId)).filter((r) => r.action === 'payout.request')).toEqual([]);
  });

  it('a command guard denial is audited, runs after authorize, and the handler never runs', async () => {
    const { walletId, admin } = await familyWallet();
    let ran = false;
    const guarded: Command<{ walletId: string; deny: boolean }, string> = {
      name: 'test.guarded',
      async resolve(_q, input) {
        return { action: 'consent.manage', subject: { type: 'wallet', id: input.walletId, ownerPersonId: admin.personId } };
      },
      async guard(_q, input) {
        return input.deny ? 'CASE_PARTY' : null;
      },
      async run() {
        ran = true;
        return { result: 'ok' };
      },
    };
    await expect(h.bus.execute(guarded, { walletId, deny: true }, { actor: admin.actor })).rejects.toMatchObject({ reason: 'CASE_PARTY' });
    expect(ran).toBe(false);
    // Unauthorised actor: the matrix denial wins; the guard is not consulted.
    const outsider = await h.customer();
    await expect(h.bus.execute(guarded, { walletId, deny: true }, { actor: outsider.actor })).rejects.toMatchObject({ reason: 'NOT_OWNER' });
    await expect(h.bus.execute(guarded, { walletId, deny: false }, { actor: admin.actor })).resolves.toBe('ok');
    expect((await auditFor(walletId)).map((r) => `${r.authz_result}:${r.reason_code ?? ''}`)).toEqual([
      'DENIED:CASE_PARTY',
      'DENIED:NOT_OWNER',
      'ALLOWED:',
    ]);
  });

  it('NOT_FOUND is audited as a denial (IDOR probing is visible)', async () => {
    const c = await h.customer();
    const ghost = randomUUID();
    await expect(h.bus.execute(withdrawConsent, { consentId: ghost }, { actor: c.actor })).rejects.toBeInstanceOf(NotFoundError);
    expect(await auditFor(ghost)).toEqual([{ action: 'consent.withdraw', authz_result: 'DENIED', reason_code: 'NOT_FOUND' }]);
  });
});

describe('consent', () => {
  it('grant → query → withdraw (record kept) → query', async () => {
    const c = await h.customer();
    const g = await h.bus.execute(grantConsent, { subjectPersonId: c.personId, purpose: 'PHOTO' }, { actor: c.actor });
    expect(await hasConsent(h.db, c.personId, 'PHOTO')).toBe(true);
    expect(await hasConsent(h.db, c.personId, 'MARKETING')).toBe(false);

    const again = await h.bus.execute(grantConsent, { subjectPersonId: c.personId, purpose: 'PHOTO' }, { actor: c.actor });
    expect(again.id).toBe(g.id);

    const w = await h.bus.execute(withdrawConsent, { consentId: g.id }, { actor: c.actor });
    expect(w.withdrawnAt).toBeInstanceOf(Date);
    expect(await hasConsent(h.db, c.personId, 'PHOTO')).toBe(false);
    await expect(h.bus.execute(withdrawConsent, { consentId: g.id }, { actor: c.actor })).rejects.toBeInstanceOf(ConflictError);

    const all = await h.bus.execute(listConsents, { subjectPersonId: c.personId }, { actor: c.actor });
    expect(all).toHaveLength(1);
    expect(all[0]!.withdrawnAt).not.toBeNull();
    expect((await auditFor(g.id)).map((r) => r.action)).toEqual(['consent.grant', 'consent.grant', 'consent.withdraw']);
  });

  it('re-grant after withdrawal creates a new record; history keeps both', async () => {
    const c = await h.customer();
    const g = await h.bus.execute(grantConsent, { subjectPersonId: c.personId, purpose: 'NOTIFY' }, { actor: c.actor });
    await h.bus.execute(withdrawConsent, { consentId: g.id }, { actor: c.actor });
    const g2 = await h.bus.execute(grantConsent, { subjectPersonId: c.personId, purpose: 'NOTIFY' }, { actor: c.actor });
    expect(g2.id).not.toBe(g.id);
    expect(await h.bus.execute(listConsents, { subjectPersonId: c.personId, purpose: 'NOTIFY' }, { actor: c.actor })).toHaveLength(2);
  });

  it('IDOR: another customer cannot grant, withdraw or list my consents', async () => {
    const me = await h.customer();
    const mallory = await h.customer();
    const g = await h.bus.execute(grantConsent, { subjectPersonId: me.personId, purpose: 'TRIBUTE' }, { actor: me.actor });
    await expect(h.bus.execute(grantConsent, { subjectPersonId: me.personId, purpose: 'MARKETING' }, { actor: mallory.actor })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(h.bus.execute(withdrawConsent, { consentId: g.id }, { actor: mallory.actor })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(h.bus.execute(listConsents, { subjectPersonId: me.personId }, { actor: mallory.actor })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await hasConsent(h.db, me.personId, 'TRIBUTE')).toBe(true);
  });

  it('DB refuses deleting or rewriting a consent record', async () => {
    const c = await h.customer();
    const g = await h.bus.execute(grantConsent, { subjectPersonId: c.personId, purpose: 'NAME' }, { actor: c.actor });
    await expect(h.db.query('DELETE FROM consent_record WHERE id = $1', [g.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query("UPDATE consent_record SET purpose = 'MARKETING' WHERE id = $1", [g.id])).rejects.toThrow(/set-once/);
  });

  it('auditor can read consents; claims officer cannot', async () => {
    const c = await h.customer();
    const auditor = await h.staff('AUDITOR');
    const claims = await h.staff('CLAIMS_OFFICER');
    await expect(h.bus.execute(listConsents, { subjectPersonId: c.personId }, { actor: auditor.actor })).resolves.toEqual([]);
    await expect(h.bus.execute(listConsents, { subjectPersonId: c.personId }, { actor: claims.actor })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('maker-checker approvals', () => {
  async function pendingPayout(amountMinor = 10_00n) {
    const f = await familyWallet();
    const token = await stepUp(f.admin, f.walletId);
    const { approvalId } = await h.bus.execute(requestPayout, { walletId: f.walletId, amountMinor }, { actor: f.admin.actor, stepUpToken: token });
    return { ...f, approvalId: approvalId! };
  }

  it('approver checks the admin’s request', async () => {
    const p = await pendingPayout();
    const out = await h.bus.execute(decideApproval, { approvalId: p.approvalId, decision: 'APPROVED' }, { actor: p.approver.actor });
    expect(out.decision).toBe('APPROVED');
  });

  it('maker cannot check their own request, even holding the approver role', async () => {
    const p = await pendingPayout();
    await h.grantRole(p.walletId, p.admin.personId, 'APPROVER');
    await expect(
      h.bus.execute(decideApproval, { approvalId: p.approvalId, decision: 'APPROVED' }, { actor: p.admin.actor }),
    ).rejects.toMatchObject({ reason: 'MAKER_CANNOT_CHECK' });
  });

  it('DB enforces maker ≠ checker even if the service were bypassed', async () => {
    const p = await pendingPayout();
    await expect(
      h.db.query("UPDATE approval SET checker_id = maker_id, checker_role = 'X', decision = 'APPROVED', decided_at = now() WHERE id = $1", [
        p.approvalId,
      ]),
    ).rejects.toThrow(/check/i);
  });

  it('an assigned agent cannot be the checker', async () => {
    const p = await pendingPayout();
    const agent = await h.staff('AGENT');
    await h.grantRole(p.walletId, agent.personId, 'AGENT');
    await expect(
      h.bus.execute(decideApproval, { approvalId: p.approvalId, decision: 'APPROVED' }, { actor: agent.actor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('an approver of another wallet cannot check this one', async () => {
    const p = await pendingPayout();
    const other = await familyWallet();
    await expect(
      h.bus.execute(decideApproval, { approvalId: p.approvalId, decision: 'APPROVED' }, { actor: other.approver.actor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('decisions are final and approvals are single-use', async () => {
    const p = await pendingPayout();
    await h.bus.execute(decideApproval, { approvalId: p.approvalId, decision: 'REJECTED', reasonCode: 'NOT_AGREED' }, { actor: p.approver.actor });
    const second = await h.customer();
    await h.grantRole(p.walletId, second.personId, 'APPROVER');
    await expect(
      h.bus.execute(decideApproval, { approvalId: p.approvalId, decision: 'APPROVED' }, { actor: second.actor }),
    ).rejects.toBeInstanceOf(ConflictError);

    const q = await pendingPayout();
    await h.bus.execute(decideApproval, { approvalId: q.approvalId, decision: 'APPROVED' }, { actor: q.approver.actor });
    const use: Command<{ approvalId: string; walletId: string }, true> = {
      name: 'test.use_approval',
      async resolve(_q, i) {
        return { action: 'wallet.view_ledger', subject: { type: 'wallet', id: i.walletId, walletId: i.walletId } };
      },
      async run(tx, i, ctx) {
        await consumeApproval(tx, ctx.actor, i.approvalId, {
          action: 'payout.request',
          subjectType: 'wallet',
          subjectId: i.walletId,
          payload: { walletId: i.walletId, amountMinor: 10_00n },
        });
        return { result: true };
      },
    };
    await expect(h.bus.execute(use, { approvalId: q.approvalId, walletId: q.walletId }, { actor: q.admin.actor })).resolves.toBe(true);
    await expect(h.bus.execute(use, { approvalId: q.approvalId, walletId: q.walletId }, { actor: q.admin.actor })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('dual-approval rule: unset threshold ⇒ every payout is dual; listed actions always', () => {
    expect(requiresDual('payout.request', 1n, null)).toBe(true);
    expect(requiresDual('payout.request', 1n, 100n)).toBe(false);
    expect(requiresDual('payout.request', 101n, 100n)).toBe(true);
    expect(requiresDual('payout.request', null, 100n)).toBe(true);
    for (const a of ['wallet.change_payout_destination', 'wallet.replace_admin', 'ledger.adjust', 'config.change'] as const) {
      expect(requiresDual(a, 0n, 1_000_000n)).toBe(true);
    }
  });
});

describe('financial flag change via approval', () => {
  it('maker requests, a different FIDELITY_ADMIN approves, maker applies once', async () => {
    const maker = await h.staff('FIDELITY_ADMIN');
    const checker = await h.staff('FIDELITY_ADMIN');
    const req = requestFlagChange(h.flags);
    const { approvalId } = await h.bus.execute(req, { key: 'approvals.payout_high_value_minor', value: 500_00n }, { actor: maker.actor });

    const flagActor = { id: maker.personId, role: 'FIDELITY_ADMIN', channel: 'ADMIN' };
    // not yet approved
    await expect(h.flags.set('approvals.payout_high_value_minor', 500_00n, flagActor, 'raise', { approvalId })).rejects.toBeInstanceOf(
      DualApprovalRequiredError,
    );
    // maker can't approve own
    await expect(h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: maker.actor })).rejects.toBeInstanceOf(ForbiddenError);
    await h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: checker.actor });

    // different value than approved
    await expect(h.flags.set('approvals.payout_high_value_minor', 900_00n, flagActor, 'raise', { approvalId })).rejects.toBeInstanceOf(
      DualApprovalRequiredError,
    );
    // checker can't apply the maker's approval
    await expect(
      h.flags.set('approvals.payout_high_value_minor', 500_00n, { id: checker.personId, role: 'FIDELITY_ADMIN' }, 'raise', { approvalId }),
    ).rejects.toBeInstanceOf(DualApprovalRequiredError);

    await h.flags.set('approvals.payout_high_value_minor', 500_00n, flagActor, 'raise', { approvalId });
    expect(await h.flags.get('approvals.payout_high_value_minor')).toBe(500_00n);
    // single use
    await expect(h.flags.set('approvals.payout_high_value_minor', 500_00n, flagActor, 'raise', { approvalId })).rejects.toBeInstanceOf(
      DualApprovalRequiredError,
    );
    const { rows } = await h.db.query<{ approval_ref: string }>(
      "SELECT approval_ref FROM config_flag_change WHERE key = 'approvals.payout_high_value_minor'",
    );
    expect(rows).toEqual([{ approval_ref: approvalId }]);
  });

  it('auditors cannot request config changes', async () => {
    const auditor = await h.staff('AUDITOR');
    await expect(
      h.bus.execute(requestFlagChange(h.flags), { key: 'payouts.enabled', value: true }, { actor: auditor.actor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('commissions.enabled stays locked even with an approval', async () => {
    await expect(
      h.flags.set('commissions.enabled', true, { id: 'x', role: 'FIDELITY_ADMIN' }, 'nope', { approvalId: randomUUID() }),
    ).rejects.toThrow(/locked/);
  });
});

describe('whole-file audit chain', () => {
  it('stays intact after everything above', async () => {
    expect(await verifyChain(h.db)).toMatchObject({ ok: true });
  });
});
