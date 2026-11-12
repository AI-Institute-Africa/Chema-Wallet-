// docs/14 §A acceptance + the §G/§S rows whose coverage was unit-level only.
// Each describe carries the test-plan ID so the traceability table can cite it.
// Everything runs in-process on the full ops harness (mock rails, MockFidelity,
// WhatsApp simulator) through the real commands.
import { performance } from 'node:perf_hooks';
import { ForbiddenError, NotFoundError, decideApproval, unseal, type FlagKey } from '@chema/core';
import { getBalances } from '@chema/ledger';
import type { MockRail } from '@chema/providers';
import { money, type Money } from '@chema/shared';
import { ClosureBlockedError, PayoutCheckError } from '@chema/payouts';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpsHarness, type OpsHarness } from './test-support';

let t: OpsHarness | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** The harness of the running test (set at the top of each test). */
const H = (): OpsHarness => {
  if (!t) throw new Error('no harness');
  return t;
};

type DraftInput = Parameters<OpsHarness['w']['createDraft']['run']>[1];
type Checklist = Parameters<OpsHarness['w']['decide']['run']>[1]['checklist'];
// @chema/wallet is not a dependency of @chema/ops: the two fixtures are restated here.
const ALL_PASS: Checklist = {
  DEATH_EVIDENCE_VALID: 'PASS',
  ADMIN_IDENTITY_MATCHES: 'PASS',
  MANDATE_SHOWS_AUTHORITY: 'PASS',
  DETAILS_CONSISTENT: 'PASS',
  FRAUD_FLAGS_REVIEWED: 'PASS',
};
const draftInput = (over: Partial<DraftInput> = {}): DraftInput => ({
  deceasedName: `Tendai Moyo ${Math.random().toString(36).slice(2, 10)}`,
  dateOfDeath: '2026-11-05',
  funeralDate: '2026-11-12',
  funeralLocation: 'Warren Hills, Harare',
  currency: 'USD',
  ...over,
});

const usd = (m: bigint): Money => money(m, 'USD');
/** What an API would send (bigints as strings). */
const wire = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const WIDE = { from: '2026-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };
const OUT_OF_SCOPE = /bank|mukuru|worldremit|ussd|innbucks/i; // scope-audit:allow (proves absence)

let phoneSeq = 6_100_000;
const phone = () => `+26378${String(phoneSeq++).padStart(7, '0')}`;

async function providerRefOf(paymentId: string): Promise<string> {
  const { rows } = await H().h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [paymentId]);
  return rows[0]?.provider_ref ?? '';
}

/** Guest contribution on `rail`, confirmed by the provider, worker run. */
async function paid(slug: string, minor: bigint, over: Partial<Parameters<OpsHarness['input']>[1]> = {}, rail?: MockRail) {
  const x = H();
  const r = rail ?? x.ecocash;
  const c = await x.contributions.contribute(x.guest(), x.input(slug, { amount: usd(minor), rail: r.rail, ...over }));
  r.succeed(await providerRefOf(c.payment.id));
  await x.deliver(r);
  await x.pump();
  return c;
}

async function community(walletId: string) {
  const b = (await getBalances(H().h.db, walletId)).find((x) => x.account.kind === 'COMMUNITY')!;
  return { settled: b.settled.minor, reserved: b.reserved.minor, held: b.held.minor, available: b.available.minor, paid: b.paid.minor };
}

async function benefit(walletId: string) {
  const b = (await getBalances(H().h.db, walletId)).find((x) => x.account.kind === 'FIDELITY_BENEFIT')!;
  return { settled: b.settled.minor, available: b.available.minor };
}

async function payoutStatus(payoutId: string): Promise<string> {
  const { rows } = await H().h.db.query<{ status: string }>('SELECT status FROM payout_request WHERE id = $1', [payoutId]);
  return rows[0]?.status ?? '';
}

async function providerPays(payoutId: string) {
  const x = H();
  x.ecocash.payoutSucceed(x.ecocash.payoutRefFor(payoutId)!);
  await x.deliverPayouts(x.ecocash);
}

/** Ops/finance maker + a different checker refund `minor` of a payment, provider confirms. */
async function refund(paymentId: string, minor: bigint, rail: MockRail, reason = 'Contributor paid twice by mistake.') {
  const x = H();
  const maker = await x.h.staff('OPS_FINANCE');
  const checker = await x.h.staff('OPS_FINANCE');
  const input = { paymentId, amount: usd(minor), reason };
  const { approvalId } = (await x.payments.requestRefund(maker.actor, input)) as { approvalId: string };
  await x.h.bus.execute(decideApproval, { approvalId, decision: 'APPROVED' }, { actor: checker.actor });
  await x.payments.requestRefund(maker.actor, { ...input, approvalId });
  await x.deliver(rail);
  await x.pump();
}

/** A financial flag change through the portal: maker, a second FIDELITY_ADMIN checks, maker applies. */
async function governedFlag(key: FlagKey, value: unknown, reason: string) {
  const x = H();
  const a = await x.h.staff('FIDELITY_ADMIN');
  const b = await x.h.staff('FIDELITY_ADMIN');
  const { approvalId } = await x.ops.run(a.actor, x.ops.commands.flagRequest, { key, value } as never);
  await x.ops.run(b.actor, x.ops.commands.decide, { approvalId, decision: 'APPROVED' });
  await x.ops.run(a.actor, x.ops.commands.flagApply, { key, value, reason, approvalId } as never);
}

async function deniedAudit(actorId: string, action: string) {
  const { rows } = await H().h.db.query<{ reason_code: string | null; actor_role: string }>(
    `SELECT reason_code, actor_role FROM audit_log WHERE actor_id = $1 AND action = $2 AND authz_result = 'DENIED' ORDER BY seq`,
    [actorId, action],
  );
  return rows;
}

async function rolesOf(walletId: string) {
  const { rows } = await H().h.db.query<{ person_id: string; role: string }>(
    'SELECT person_id, role FROM wallet_role WHERE wallet_id = $1 AND revoked_at IS NULL ORDER BY role, person_id',
    [walletId],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('§G G5 — agent delegation + no self-approve', () => {
  it('an assigned agent drafts, uploads, submits and links the claim for the family, but is refused (and audited) as decider/checker', async () => {
    t = await createOpsHarness();
    const x = t;
    const agent = await x.h.staff('AGENT');
    const adminPhone = phone();

    // Acts for the family: draft on behalf, evidence uploads, submission.
    const draft = await x.h.bus.execute(x.w.createDraft, draftInput({ adminPhone }), { actor: agent.actor });
    const walletId = draft.id;
    expect(draft.createdByKind).toBe('AGENT');
    await x.fullEvidence(agent.actor, walletId);
    const admin = await x.h.customer(adminPhone); // the family admin confirms their own phone
    const { caseId } = await x.h.bus.execute(x.w.submit, { walletId }, { actor: agent.actor });
    const { rows: w } = await x.h.db.query<{ created_by: string; admin_person: string }>('SELECT created_by, admin_person FROM wallet WHERE id = $1', [walletId]);
    expect(w[0]).toEqual({ created_by: agent.personId, admin_person: admin.personId });

    // Refused as the decider of the verification it submitted; the denial is audited.
    await expect(
      x.h.bus.execute(x.w.decide, { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS }, { actor: agent.actor }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await deniedAudit(agent.personId, 'verification.decide')).toEqual([{ actor_role: 'AGENT', reason_code: 'NO_PERMISSION' }]);

    // A verifier decides instead.
    const verifier = await x.verifier();
    await x.assignVerifier(walletId, verifier.personId);
    const decided = await x.h.bus.execute(
      x.w.decide,
      { caseId, outcome: 'APPROVED', reasonCode: 'EVIDENCE_SUFFICIENT', checklist: ALL_PASS },
      { actor: verifier.actor },
    );
    const slug = decided.publicSlug ?? '';

    // More delegated work: the Fidelity lookup + claim link on the family's behalf (after the admin's consent).
    const { rows: dn } = await x.h.db.query<{ deceased_name: string }>('SELECT deceased_name FROM wallet WHERE id = $1', [walletId]);
    const policyNo = x.fidelity.seed('APPROVED', { name: dn[0]?.deceased_name ?? '' });
    await x.consent(admin, walletId);
    await expect(x.claims.lookupPolicy(agent.actor, walletId, { policyNo })).resolves.toMatchObject({ outcome: 'ELIGIBLE' });
    await x.claims.linkClaim(agent.actor, { walletId, recipientPersonId: admin.personId, recipientIdNumber: '63-123456X42', claimantPersonId: admin.personId });
    const { rows: linkAudit } = await x.h.db.query<{ authz_result: string }>(
      "SELECT authz_result FROM audit_log WHERE action = 'claim.link' AND actor_id = $1",
      [agent.personId],
    );
    expect(linkAudit).toEqual([{ authz_result: 'ALLOWED' }]);

    // Money side: the agent never requests a payout and is never the checker.
    await paid(slug, 40_00n);
    const approver = await x.approver(walletId);
    const payee = await x.activePayee(admin, approver, walletId);
    const plan = await x.requestPayout(admin, walletId, payee, 10_00n);
    await expect(x.payouts.decide(agent.actor, plan.approvalId!, 'APPROVED')).rejects.toBeInstanceOf(ForbiddenError);
    expect((await deniedAudit(agent.personId, 'approval.decide')).length).toBeGreaterThanOrEqual(1);
    await expect(
      x.payouts.requestPayout(agent.actor, {
        walletId,
        source: { kind: 'COMMUNITY' },
        currency: 'USD',
        parts: [{ payeeId: payee, amountMinor: 1_00n, purpose: 'PARLOUR' }],
        idempotencyKey: 'plan-agent-0001',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await deniedAudit(agent.personId, 'payout.request')).toHaveLength(1);
    // The agent cannot even obtain a step-up (customer-only).
    await expect(x.h.auth.startStepUp(agent.actor, { action: 'payout.request', subjectType: 'wallet', subjectId: walletId })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await payoutStatus(plan.payouts[0]!.id)).toBe('AWAITING_APPROVAL');
  });
});

describe('§S S8 — account compromise / step-up', () => {
  it('logout kills the token, the session and its unused step-up grant; a payout needs a fresh step-up on the new session', async () => {
    t = await createOpsHarness();
    const x = t;
    const w = await x.fundedWallet(50_00n);
    const payee = await x.activePayee(w.admin, w.approver, w.walletId);
    const adminPhone = (await x.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [w.admin.personId])).rows[0]!.phone_e164;
    const input = (k: string) => ({
      walletId: w.walletId,
      source: { kind: 'COMMUNITY' as const },
      currency: 'USD' as const,
      parts: [{ payeeId: payee, amountMinor: 10_00n, purpose: 'PARLOUR' as const }],
      idempotencyKey: k,
    });

    // An unused step-up grant exists on the (possibly compromised) session.
    const staleGrant = await x.stepUp(w.admin, 'payout.request', w.walletId);
    const oldSessionId = w.admin.actor.sessionId!;

    // Suspected takeover: the session is ended.
    await x.h.auth.logout(w.admin.actor);
    expect(await x.h.auth.authenticate(w.admin.token)).toBeNull();
    expect(await x.h.auth.actorForSession(oldSessionId)).toBeNull();
    const { rows: lo } = await x.h.db.query("SELECT 1 FROM audit_log WHERE action = 'identity.logout' AND session_ref = $1", [oldSessionId]);
    expect(lo).toHaveLength(1);
    // The old session can no longer start a step-up of its own either: there is no actor to present.

    // Back in with a fresh OTP login: sensitive action without fresh step-up ⇒ refused (audited).
    const fresh = await x.h.customer(adminPhone);
    expect(fresh.actor.sessionId).not.toBe(oldSessionId);
    await expect(x.payouts.requestPayout(fresh.actor, input('plan-s8-0001'))).rejects.toThrow('STEP_UP_REQUIRED');
    // The old session's unused grant is bound to the dead session: refused on the new one.
    await expect(x.payouts.requestPayout(fresh.actor, input('plan-s8-0002'), staleGrant)).rejects.toThrow('STEP_UP_REQUIRED');
    const denied = await deniedAudit(w.admin.personId, 'payout.request');
    expect(denied.map((d) => d.reason_code)).toEqual(['STEP_UP_REQUIRED', 'STEP_UP_REQUIRED']);
    const { rows: none } = await x.h.db.query('SELECT 1 FROM payout_request WHERE wallet_id = $1', [w.walletId]);
    expect(none).toHaveLength(0);

    // A fresh step-up on the new session works, once.
    const token = await x.stepUp(fresh, 'payout.request', w.walletId);
    const plan = await x.payouts.requestPayout(fresh.actor, input('plan-s8-0003'), token);
    expect(plan.payouts[0]!.status).toBe('AWAITING_APPROVAL');
    await expect(x.payouts.requestPayout(fresh.actor, input('plan-s8-0004'), token)).rejects.toThrow('STEP_UP_REQUIRED');
  });

  // Second line of defence (fixed in P10): StepUpGrants.consume requires the grant's session to be
  // live, so an Actor captured before logout cannot spend an unused grant in-process either.
  it('an unused step-up grant of a revoked session cannot be redeemed, even with an Actor captured before logout', async () => {
    t = await createOpsHarness();
    const x = t;
    const w = await x.fundedWallet(50_00n);
    const payee = await x.activePayee(w.admin, w.approver, w.walletId);
    const staleGrant = await x.stepUp(w.admin, 'payout.request', w.walletId);
    const captured = w.admin.actor;
    await x.h.auth.logout(captured);
    await expect(
      x.payouts.requestPayout(
        captured,
        { walletId: w.walletId, source: { kind: 'COMMUNITY' }, currency: 'USD', parts: [{ payeeId: payee, amountMinor: 10_00n, purpose: 'PARLOUR' }], idempotencyKey: 'plan-s8-gap1' },
        staleGrant,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('sign out everywhere: the customer ends every own session (and their step-up grants); a Fidelity admin does it for a suspected compromise', async () => {
    t = await createOpsHarness();
    const x = t;
    const w = await x.fundedWallet(50_00n);
    const payee = await x.activePayee(w.admin, w.approver, w.walletId);
    const adminPhone = (await x.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [w.admin.personId])).rows[0]!.phone_e164;
    const plan = (k: string) => ({
      walletId: w.walletId,
      source: { kind: 'COMMUNITY' as const },
      currency: 'USD' as const,
      parts: [{ payeeId: payee, amountMinor: 10_00n, purpose: 'PARLOUR' as const }],
      idempotencyKey: k,
    });

    // Two live sessions (web + WhatsApp); an unused step-up grant sits on the first.
    const second = await x.h.customer(adminPhone, 'WHATSAPP');
    const staleGrant = await x.stepUp(w.admin, 'payout.request', w.walletId);
    const out = await x.h.bus.execute(x.h.sessions.signOutEverywhere, {}, { actor: second.actor });
    expect(out.revoked).toBeGreaterThanOrEqual(2);
    for (const s of [w.admin, second]) {
      expect(await x.h.auth.authenticate(s.token)).toBeNull();
      expect(await x.h.auth.actorForSession(s.actor.sessionId!)).toBeNull();
    }
    // The grant died with its session, even presented with the captured Actor.
    await expect(x.payouts.requestPayout(w.admin.actor, plan('plan-soe-0001'), staleGrant)).rejects.toThrow('STEP_UP_REQUIRED');
    const { rows: own } = await x.h.db.query<{ authz_result: string; reason_code: string }>(
      "SELECT authz_result, reason_code FROM audit_log WHERE action = 'identity.sign_out_everywhere' AND actor_id = $1",
      [w.admin.personId],
    );
    expect(own).toEqual([{ authz_result: 'ALLOWED', reason_code: 'SIGN_OUT_EVERYWHERE' }]);

    // A staff member cannot use the customer self-service command on themselves or anyone.
    const ops = await x.h.staff('OPS_FINANCE');
    await expect(x.h.bus.execute(x.h.sessions.signOutEverywhere, {}, { actor: ops.actor })).rejects.toBeInstanceOf(ForbiddenError);

    // Suspected compromise of another account: only a Fidelity admin, with a written reason.
    const victim = await x.h.customer();
    const victim2 = await x.h.customer((await x.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [victim.personId])).rows[0]!.phone_e164);
    const input = { personId: victim.personId, reason: 'SIM swap reported by the family on the hotline' };
    await expect(x.ops.run(ops.actor, x.ops.commands.revokePersonSessions, input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await deniedAudit(ops.personId, 'identity.revoke_sessions')).toEqual([{ actor_role: 'OPS_FINANCE', reason_code: 'NO_PERMISSION' }]);
    const fadmin = await x.h.staff('FIDELITY_ADMIN');
    await expect(x.ops.run(fadmin.actor, x.ops.commands.revokePersonSessions, { ...input, reason: 'short' })).rejects.toThrow('REASON_REQUIRED');
    expect(await x.h.auth.authenticate(victim.token)).not.toBeNull();
    await expect(x.ops.run(fadmin.actor, x.ops.commands.revokePersonSessions, input)).resolves.toEqual({ revoked: 2 });
    expect(await x.h.auth.authenticate(victim.token)).toBeNull();
    expect(await x.h.auth.authenticate(victim2.token)).toBeNull();
    // The admin's own staff session is untouched; the action is audited with the reason code.
    expect(await x.h.auth.authenticate(fadmin.token)).not.toBeNull();
    const { rows: adm } = await x.h.db.query<{ actor_role: string; subject_id: string; reason_code: string; after_hash: string | null }>(
      "SELECT actor_role, subject_id, reason_code, after_hash FROM audit_log WHERE action = 'identity.revoke_sessions' AND authz_result = 'ALLOWED'",
    );
    expect(adm).toHaveLength(1);
    expect(adm[0]).toMatchObject({ actor_role: 'FIDELITY_ADMIN', subject_id: victim.personId, reason_code: 'SUSPECTED_COMPROMISE' });
    expect(adm[0]!.after_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('§A 4 — policy beneficiary, claimant, admin, payout recipient represented separately', () => {
  it('each role is granted by the flow that establishes it, as its own row; none is inferred; the benefit route stays blocked until approved', async () => {
    t = await createOpsHarness();
    const x = t;
    const c = await x.claimCase('APPROVED');
    const admin = c.admin;
    // Family members join through the mandate (fixture: APPROVER role). No A4 role is inserted by SQL.
    const claimant = await x.approver(c.walletId); // lodges the claim through the assigned agent
    const recipient = await x.approver(c.walletId); // the family's proposed benefit recipient
    const approver = await x.approver(c.walletId); // checks payouts; holds no other role
    const outsider = await x.h.customer(); // no role on the case at all
    const agent = await x.h.staff('AGENT');
    await x.h.assign(agent.personId, c.walletId);
    const recipientIdNo = '63-777777R42';
    const roles = async (personId: string) => (await rolesOf(c.walletId)).filter((r) => r.person_id === personId).map((r) => r.role).sort();
    const linkAs = (actor: typeof admin.actor, over: { recipientPersonId?: string; recipientIdNumber?: string; claimantPersonId?: string } = {}) =>
      x.claims.linkClaim(actor, { walletId: c.walletId, recipientPersonId: recipient.personId, recipientIdNumber: recipientIdNo, ...over });

    // An agent must name the family member they lodge for (never inferred), and only a family member;
    // a customer can lodge only as themself.
    await expect(linkAs(agent.actor)).rejects.toThrow('CLAIMANT_REQUIRED');
    await expect(linkAs(agent.actor, { claimantPersonId: outsider.personId })).rejects.toThrow('CLAIMANT_NOT_ON_WALLET');
    await expect(linkAs(admin.actor, { claimantPersonId: claimant.personId })).rejects.toThrow('CLAIMANT_MUST_BE_SELF');
    await linkAs(agent.actor, { claimantPersonId: claimant.personId });
    const { rows: lr } = await x.h.db.query<{
      claim_ref: string; claimant_person: string; created_by: string; proposed_recipient: string; approved_recipient: string | null; route_status: string;
    }>('SELECT claim_ref, claimant_person, created_by, proposed_recipient, approved_recipient, route_status FROM fidelity_link WHERE wallet_id = $1', [c.walletId]);
    const claimRef = lr[0]!.claim_ref;
    // The claimant is stored on the link, apart from who looked the policy up (created_by) and the recipient.
    expect(lr[0]).toMatchObject({
      claimant_person: claimant.personId,
      created_by: admin.personId,
      proposed_recipient: recipient.personId,
      approved_recipient: null,
      route_status: 'PENDING_APPROVAL',
    });
    expect(await roles(claimant.personId)).toEqual(['APPROVER', 'CLAIMANT']);
    // Being nominated is not being a recipient or a beneficiary; the agent gets no family role.
    expect(await roles(recipient.personId)).toEqual(['APPROVER']);
    expect(await roles(agent.personId)).toEqual([]);
    const { rows: grant } = await x.h.db.query<{ granted_by: string; grant_source: string }>(
      "SELECT granted_by, grant_source FROM wallet_role WHERE wallet_id = $1 AND role = 'CLAIMANT'",
      [c.walletId],
    );
    expect(grant).toEqual([{ granted_by: agent.personId, grant_source: 'CLAIM_LINK' }]);

    // The claimant and the nominated recipient cannot request payouts.
    const parlour = await x.activePayee(admin, approver, c.walletId);
    await paid(c.slug, 30_00n);
    await expect(x.requestPayout(claimant, c.walletId, parlour, 5_00n)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(x.requestPayout(recipient, c.walletId, parlour, 5_00n)).rejects.toBeInstanceOf(ForbiddenError);

    // Benefit route blocked until approved: claim APPROVED + money SETTLED is still not credited.
    x.fidelity.approve(claimRef);
    x.fidelity.pay(claimRef, usd(400_00n));
    await x.deliverFidelity();
    expect(await benefit(c.walletId)).toEqual({ settled: 0n, available: 0n });
    expect((await x.claims.funds(admin.actor, c.walletId)).benefit.status).not.toBe('CREDITED');
    // A payee bound to the recipient becoming ACTIVE (name check + dual approval) makes them a PAYOUT_RECIPIENT…
    const toRecipient = await x.activePayee(admin, approver, c.walletId, { holder: 'Recipient Person', personId: recipient.personId });
    expect(await roles(recipient.personId)).toEqual(['APPROVER', 'PAYOUT_RECIPIENT']);
    const { rows: pr } = await x.h.db.query<{ granted_by: string; grant_source: string }>(
      "SELECT granted_by, grant_source FROM wallet_role WHERE wallet_id = $1 AND person_id = $2 AND role = 'PAYOUT_RECIPIENT'",
      [c.walletId, recipient.personId],
    );
    expect(pr).toEqual([{ granted_by: admin.personId, grant_source: 'PAYEE_ACTIVE' }]);
    // …which is still not the approved benefit route: the benefit cannot go out yet.
    await expect(x.requestPayout(admin, c.walletId, toRecipient, 1_00n, { source: 'FIDELITY_BENEFIT', purpose: 'FAMILY_BENEFICIARY' })).rejects.toBeInstanceOf(PayoutCheckError);

    // The admin cannot redirect the benefit to themself: a re-link with another recipient is refused and audited.
    await expect(linkAs(admin.actor, { recipientPersonId: admin.personId, recipientIdNumber: '63-000001A42' })).rejects.toThrow('RECIPIENT_CHANGE_REFUSED');
    expect((await deniedAudit(admin.personId, 'claim.link')).map((d) => d.reason_code)).toContain('RECIPIENT_CHANGE_REFUSED');
    const { rows: still } = await x.h.db.query<{ proposed_recipient: string }>('SELECT proposed_recipient FROM fidelity_link WHERE wallet_id = $1', [c.walletId]);
    expect(still[0]!.proposed_recipient).toBe(recipient.personId);

    // Fidelity approves the route to the recipient's ID ⇒ credited. Fidelity's route identifies them as the
    // POLICY_BENEFICIARY: its own row, source FIDELITY_ROUTE, granted by no Chema person.
    x.fidelity.routeTo(claimRef, recipientIdNo);
    await x.deliverFidelity();
    expect((await benefit(c.walletId)).settled).toBe(400_00n);
    const { rows: after } = await x.h.db.query<{ approved_recipient: string; route_status: string }>(
      'SELECT approved_recipient, route_status FROM fidelity_link WHERE wallet_id = $1',
      [c.walletId],
    );
    expect(after[0]).toEqual({ approved_recipient: recipient.personId, route_status: 'APPROVED' });
    expect(await roles(recipient.personId)).toEqual(['APPROVER', 'PAYOUT_RECIPIENT', 'POLICY_BENEFICIARY']);
    const { rows: pb } = await x.h.db.query<{ granted_by: string | null; grant_source: string }>(
      "SELECT granted_by, grant_source FROM wallet_role WHERE wallet_id = $1 AND role = 'POLICY_BENEFICIARY'",
      [c.walletId],
    );
    expect(pb).toEqual([{ granted_by: null, grant_source: 'FIDELITY_ROUTE' }]);

    // Benefit to a payee of the admin: refused. To the approved recipient: accepted.
    const toAdmin = await x.activePayee(admin, approver, c.walletId, { holder: 'Admin Person', personId: admin.personId });
    await expect(x.requestPayout(admin, c.walletId, toAdmin, 50_00n, { source: 'FIDELITY_BENEFIT', purpose: 'FAMILY_BENEFICIARY' })).rejects.toBeInstanceOf(PayoutCheckError);
    const ben = await x.requestPayout(admin, c.walletId, toRecipient, 50_00n, { source: 'FIDELITY_BENEFIT', purpose: 'FAMILY_BENEFICIARY' });
    expect(ben.payouts[0]!.status).toBe('AWAITING_APPROVAL');

    // Nothing inferred: the admin became a payout recipient only through their own ACTIVE payee (never a
    // claimant or beneficiary); the approver and the outsider hold nothing extra.
    expect(await roles(admin.personId)).toEqual(['ADMIN', 'PAYOUT_RECIPIENT']);
    expect(await roles(approver.personId)).toEqual(['APPROVER']);
    expect(await roles(claimant.personId)).toEqual(['APPROVER', 'CLAIMANT']);
    const { rows: none } = await x.h.db.query('SELECT 1 FROM wallet_role WHERE person_id = $1', [outsider.personId]);
    expect(none).toHaveLength(0);
    // The beneficiary / recipient roles grant no money authority: the recipient still cannot request a payout.
    await expect(x.requestPayout(recipient, c.walletId, toRecipient, 1_00n, { source: 'FIDELITY_BENEFIT', purpose: 'FAMILY_BENEFICIARY' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('§A 5 — only enabled rails shown; out-of-scope rails absent everywhere', () => {
  it('payments list, quote, public page, WhatsApp pay menu and admin config agree; a disabled rail disappears from all', async () => {
    // rail.card left to the database (not pinned in env) so the portal can switch it at runtime.
    t = await createOpsHarness({ 'rail.card': undefined } as unknown as Partial<Record<FlagKey, string>>);
    const x = t;
    const { slug } = await x.publicWallet();
    const ops = await x.h.staff('OPS_FINANCE');

    const surfaces = async () => {
      const rails = await x.payments.listRails();
      const page = await x.contributions.page(slug);
      const quotes = [];
      for (const r of rails) quotes.push(await x.contributions.quote(slug, r, usd(10_00n)));
      const p = phone();
      await x.say(p, 'hi');
      await x.say(p, '1');
      await x.say(p, `https://chema.test/w/${slug}`);
      const waMenu = await x.say(p, '10');
      const config = await x.ops.run(ops.actor, x.ops.queues.config, {});
      const configOn = (config.flags as { key: string; value: unknown }[])
        .filter((f) => f.key.startsWith('rail.') && f.value === true)
        .map((f) => f.key.slice('rail.'.length).toUpperCase())
        .sort();
      return { rails: [...rails].sort(), page, quotes, waMenu, config, configOn };
    };
    const scan = (s: Awaited<ReturnType<typeof surfaces>>) => {
      for (const out of [wire(s.rails), wire(s.page), wire(s.quotes), s.waMenu, wire(s.config)]) expect(out).not.toMatch(OUT_OF_SCOPE);
    };
    // Out-of-scope rails cannot be used either.
    for (const rail of ['BANK', 'MUKURU', 'WORLDREMIT', 'USSD', 'INNBUCKS']) { // scope-audit:allow (proves absence)
      await expect(x.contributions.contribute(x.guest(), x.input(slug, { rail }))).rejects.toBeInstanceOf(NotFoundError);
    }

    const off = await surfaces();
    scan(off);
    expect(off.rails).toEqual(['ECOCASH', 'ONEMONEY']);
    expect(off.configOn).toEqual(off.rails);
    expect([...off.page.contribute.rails].sort()).toEqual(off.rails);
    expect(off.waMenu).toMatch(/ecocash/i);
    expect(off.waMenu).not.toMatch(/card/i);

    await governedFlag('rail.card', true, 'Acquirer approval received for card payments.');
    const on = await surfaces();
    scan(on);
    expect(on.rails).toEqual(['CARD', 'ECOCASH', 'ONEMONEY']);
    expect(on.configOn).toEqual(on.rails);
    expect([...on.page.contribute.rails].sort()).toEqual(on.rails);
    expect(on.waMenu).toMatch(/card/i);
    expect(on.quotes).toHaveLength(3);

    await governedFlag('rail.card', false, 'Acquirer suspended card processing.');
    const again = await surfaces();
    scan(again);
    expect(again.rails).toEqual(['ECOCASH', 'ONEMONEY']);
    expect(again.configOn).toEqual(again.rails);
    expect(wire(again.page)).not.toMatch(/card/i);
    expect(again.waMenu).not.toMatch(/card/i);
    await expect(x.contributions.quote(slug, 'CARD', usd(10_00n))).rejects.toBeInstanceOf(NotFoundError);
    await expect(x.contributions.contribute(x.guest(), x.input(slug, { rail: 'CARD' }))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('§A 7 — pending/failed/succeeded/reversed/refunded/charged-back distinct + auditable', () => {
  it('drives one payment (or payout) into each state and tells them apart from audit + ledger', async () => {
    t = await createOpsHarness();
    const x = t;
    const w = await x.fundedWallet(60_00n);
    const payee = await x.activePayee(w.admin, w.approver, w.walletId);
    const db = x.h.db;
    const state = async (paymentId: string) => (await db.query<{ state: string }>('SELECT state FROM payment WHERE id = $1', [paymentId])).rows[0]!.state;
    const stateLog = async (paymentId: string) =>
      (await db.query<{ from_state: string | null; to_state: string; source: string }>(
        'SELECT from_state, to_state, source FROM payment_state_log WHERE payment_id = $1 ORDER BY id',
        [paymentId],
      )).rows;
    const journalKinds = async (paymentId: string) =>
      (await db.query<{ kind: string }>(
        `SELECT DISTINCT j.kind FROM ledger_journal j JOIN ledger_entry e ON e.journal_id = j.id WHERE e.txn_ref = $1 ORDER BY j.kind`,
        [`payment:${paymentId}`],
      )).rows.map((r) => r.kind);

    // pending
    const pending = await x.contributions.contribute(x.guest(), x.input(w.slug, { amount: usd(3_00n) }));
    // failed
    const failed = await x.contributions.contribute(x.guest(), x.input(w.slug, { amount: usd(4_00n) }));
    x.ecocash.fail(await providerRefOf(failed.payment.id));
    await x.deliver(x.ecocash);
    await x.pump();
    // succeeded
    const succeeded = await paid(w.slug, 5_00n);
    // refunded (full refund, provider confirmed)
    const refunded = await paid(w.slug, 6_00n);
    await refund(refunded.payment.id, 6_00n, x.ecocash);
    // charged back (card, full amount)
    const charged = await paid(w.slug, 7_00n, {}, x.card);
    const cref = await providerRefOf(charged.payment.id);
    const disputeRef = x.card.openDispute(cref, usd(7_00n));
    await x.deliver(x.card);
    x.card.chargeback(cref, usd(7_00n), disputeRef);
    await x.deliver(x.card);
    // reversed (payout confirmed, then returned by the provider ⇒ compensating journal)
    const plan = await x.requestPayout(w.admin, w.walletId, payee, 8_00n);
    await x.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    const payoutId = plan.payouts[0]!.id;
    await providerPays(payoutId);
    x.ecocash.payoutReverse(x.ecocash.payoutRefFor(payoutId)!);
    await x.deliverPayouts(x.ecocash);

    const states = {
      pending: await state(pending.payment.id),
      failed: await state(failed.payment.id),
      succeeded: await state(succeeded.payment.id),
      refunded: await state(refunded.payment.id),
      chargedBack: await state(charged.payment.id),
      reversed: await payoutStatus(payoutId),
    };
    expect(states).toEqual({ pending: 'INITIATED', failed: 'FAILED', succeeded: 'SUCCEEDED', refunded: 'REFUNDED', chargedBack: 'CHARGED_BACK', reversed: 'REVERSED' });
    expect(new Set(Object.values(states)).size).toBe(6);

    // Every payment transition is in the append-only state log with its source.
    expect(await stateLog(pending.payment.id)).toEqual([{ from_state: null, to_state: 'INITIATED', source: 'INITIATE' }]);
    expect((await stateLog(failed.payment.id)).map((r) => r.to_state)).toEqual(['INITIATED', 'FAILED']);
    expect((await stateLog(succeeded.payment.id)).map((r) => r.to_state)).toEqual(['INITIATED', 'SUCCEEDED']);
    expect(await stateLog(refunded.payment.id)).toEqual(expect.arrayContaining([expect.objectContaining({ from_state: 'SUCCEEDED', to_state: 'REFUNDED', source: 'REFUND' })]));
    expect(await stateLog(charged.payment.id)).toEqual(expect.arrayContaining([expect.objectContaining({ from_state: 'SUCCEEDED', to_state: 'CHARGED_BACK', source: 'CHARGEBACK' })]));

    // The ledger tells them apart: no journal for pending/failed, distinct kinds otherwise.
    expect(await journalKinds(pending.payment.id)).toEqual([]);
    expect(await journalKinds(failed.payment.id)).toEqual([]);
    expect(await journalKinds(succeeded.payment.id)).toEqual(['CONTRIBUTION']);
    expect(await journalKinds(refunded.payment.id)).toEqual(['CONTRIBUTION', 'REFUND']);
    expect(await journalKinds(charged.payment.id)).toEqual(['CHARGEBACK', 'CONTRIBUTION']);
    const { rows: pj } = await db.query<{ kind: string; reverses: boolean }>(
      `SELECT j.kind, (j.reverses_journal_id IS NOT NULL) AS reverses FROM ledger_journal j
        WHERE j.wallet_id = $1 AND j.kind = 'PAYOUT' ORDER BY j.seq`,
      [w.walletId],
    );
    expect(pj).toEqual([{ kind: 'PAYOUT', reverses: false }, { kind: 'PAYOUT', reverses: true }]);
    const { rows: pe } = await db.query<{ to_status: string }>('SELECT to_status FROM payout_event WHERE payout_id = $1 ORDER BY ts, id', [payoutId]);
    expect(pe.map((r) => r.to_status)).toEqual(expect.arrayContaining(['CONFIRMED', 'REVERSED']));

    // Audit: each state-changing step is an ALLOWED audit row tied to its payment.
    const auditFor = async (paymentId: string) =>
      (await db.query<{ action: string; reason_code: string | null }>(
        `SELECT action, reason_code FROM audit_log WHERE authz_result = 'ALLOWED' AND (txn_ref = $1 OR subject_id = $2) ORDER BY seq`,
        [`payment:${paymentId}`, paymentId],
      )).rows.map((r) => `${r.action}:${r.reason_code ?? ''}`);
    const sigs = {
      pending: await auditFor(pending.payment.id),
      failed: await auditFor(failed.payment.id),
      succeeded: await auditFor(succeeded.payment.id),
      refunded: await auditFor(refunded.payment.id),
      chargedBack: await auditFor(charged.payment.id),
    };
    for (const s of Object.values(sigs)) expect(s.length).toBeGreaterThan(0);
    expect(new Set(Object.values(sigs).map((s) => s.join('|'))).size).toBe(5);
    const { rows: pa } = await db.query("SELECT 1 FROM audit_log WHERE authz_result = 'ALLOWED' AND (subject_id = $1 OR txn_ref LIKE '%' || $1 || '%')", [payoutId]);
    expect(pa.length).toBeGreaterThan(0);
  });
});

describe('§A 11 — anonymity + privacy consistent across page, family view, notifications, reports', () => {
  it('an anonymous contributor’s name and KYC name never leave the vault; hidden public fields stay hidden', async () => {
    t = await createOpsHarness();
    const x = t;
    // Names hidden, amounts hidden on the public page; anonymity set by the contributor.
    const { slug, walletId, admin } = await x.publicWallet({ showContributorNames: false, showAmounts: false });
    const anonKyc = 'Rufaro Mlambo-Secret';
    const anonDisplay = 'RufaroDisplay';
    await paid(slug, 12_34n, { anonymous: true, payerName: anonKyc, displayName: anonDisplay, tribute: 'Go well, sekuru.' });
    // A named contributor on the same wallet (their name must stay off the public page: showContributorNames=false).
    const namedKyc = 'Tinotenda Chikwanha-Kyc';
    await paid(slug, 5_00n, { payerName: namedKyc, displayName: 'TinoShown', payerPhone: '+263772000999', contact: { kind: 'PHONE', value: '+263772000999' } });

    // Public surfaces: page, tribute feed, WhatsApp wallet lookup.
    const page = wire(await x.contributions.page(slug));
    const tributes = wire(await x.contributions.tributes(slug));
    const p = phone();
    await x.say(p, 'hi');
    await x.say(p, '1');
    const waPublic = await x.say(p, `https://chema.test/w/${slug}`);
    for (const s of [page, tributes, waPublic]) {
      for (const secret of [anonKyc, anonDisplay, namedKyc, 'TinoShown', 'Rufaro']) expect(s).not.toContain(secret);
      expect(s).not.toContain('"minor":"1234"'); // showAmounts=false
    }
    expect(page).toContain('Sympathetic Friend');

    // Family view: wallet view, funds, the family report and every family notification.
    const family = [
      wire(await x.h.bus.execute(x.w.view, { walletId }, { actor: admin.actor })),
      wire(await x.claims.funds(admin.actor, walletId)),
    ];
    // Reports staff see.
    const fa = await x.h.staff('FIDELITY_ADMIN');
    const ops = await x.h.staff('OPS_FINANCE');
    const auditor = await x.h.staff('AUDITOR');
    const reports = [
      wire(await x.ops.run(ops.actor, x.ops.reports.family, { walletId })),
      wire(await x.ops.run(fa.actor, x.ops.reports.management, WIDE)),
      wire(await x.ops.run(ops.actor, x.ops.reports.finance, {})),
      wire(await x.ops.run(auditor.actor, x.ops.reports.regulator, WIDE)),
      wire(await x.ops.run(auditor.actor, x.ops.audit.walletTimeline, { walletId })),
    ];
    for (const s of [...family, ...reports]) {
      for (const secret of [anonKyc, anonDisplay, 'Rufaro', namedKyc]) expect(s).not.toContain(secret);
    }
    const famReport = (await x.ops.run(ops.actor, x.ops.reports.family, { walletId })) as { contributions: { settled: number; anonymousPublicly: number } };
    expect(famReport.contributions).toEqual({ settled: 2, anonymousPublicly: 1 });

    // Notifications: what the mock senders actually sent (SMS, email, WhatsApp) …
    const outbox = [...x.sms.sent, ...x.email.sent, ...x.sim.sent.map((m) => ({ to: m.to, text: m.text }))];
    expect(outbox.length).toBeGreaterThan(0);
    for (const m of outbox) for (const secret of [anonKyc, anonDisplay, 'Rufaro', namedKyc]) expect(m.text).not.toContain(secret);
    const adminPhone = (await x.h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [admin.personId])).rows[0]!.phone_e164;
    const toFamily = x.sms.sent.filter((m) => m.to === adminPhone).map((m) => m.text);
    expect(toFamily.some((s) => s.startsWith('Sympathetic Friend contributed'))).toBe(true);
    // … and every queued notification (incl. in-app WEB notices), opened with the platform key.
    const { rows: notes } = await x.h.db.query<{ id: string; params_sealed: string }>('SELECT id, params_sealed FROM notification');
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) {
      const params = unseal(x.secrets.dataKey, Buffer.from(n.params_sealed, 'base64'), `notification:params:${n.id}`).toString('utf8');
      for (const secret of [anonKyc, anonDisplay, 'Rufaro', namedKyc]) expect(params).not.toContain(secret);
    }

    // Anonymous = display only: the audit trail and sealed KYC are kept.
    const { rows: kept } = await x.h.db.query<{ anonymous: boolean; kyc: number }>(
      'SELECT anonymous, length(kyc_sealed) AS kyc FROM contribution WHERE wallet_id = $1 AND anonymous',
      [walletId],
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.kyc).toBeGreaterThan(40);
    const { rows: aud } = await x.h.db.query("SELECT 1 FROM audit_log WHERE action = 'contribution.create' AND authz_result = 'ALLOWED'");
    expect(aud).toHaveLength(2);
  });
});

describe('§A 12 — refund, dispute, excess funds, closure end-to-end on one wallet', () => {
  it('contributions → dispute (hold + case) → resolve → payout → refund → residual blocked → policy set → residual paid → closed with statements', async () => {
    t = await createOpsHarness();
    const x = t;
    const w = await x.fundedWallet(100_00n);
    const payee = await x.activePayee(w.admin, w.approver, w.walletId);
    const toRefund = await paid(w.slug, 20_00n, { payerPhone: '+263772000777', contact: { kind: 'PHONE', value: '+263772000777' } });
    expect(await community(w.walletId)).toMatchObject({ settled: 120_00n, available: 120_00n });

    // Dispute: hold on the community source + a case; payouts refused while it stands.
    const dispute = await x.payouts.run(w.approver.actor, x.payouts.governance.open, {
      walletId: w.walletId,
      type: 'AUTHORITY_DISPUTE',
      summary: 'A brother disputes that the admin may spend the community money.',
    });
    expect(dispute.holds).toEqual([expect.objectContaining({ scope: 'SOURCE', source: 'COMMUNITY', released: false })]);
    await expect(x.requestPayout(w.admin, w.walletId, payee, 10_00n)).rejects.toMatchObject({ check: 'HOLD_APPLIES' });

    // Resolve: dual-approved hold release, then the case.
    const ops = await x.h.staff('OPS_FINANCE');
    const ops2 = await x.h.staff('OPS_FINANCE');
    await x.payouts.run(ops.actor, x.payouts.governance.assign, { caseId: dispute.id, assigneePersonId: ops.personId });
    const holdId = dispute.holds[0]!.id;
    const rel = await x.payouts.run(ops.actor, x.payouts.governance.holdRelease, { holdId, reason: 'Mediation done; mandate upheld by the family.' });
    await x.h.bus.execute(decideApproval, { approvalId: rel.approvalId, decision: 'APPROVED' }, { actor: ops2.actor });
    await x.payouts.run(ops.actor, x.payouts.governance.holdRelease, { holdId, reason: 'Mediation done; mandate upheld by the family.', approvalId: rel.approvalId });
    expect(await x.payouts.run(ops.actor, x.payouts.governance.resolve, { caseId: dispute.id, outcome: 'NOT_UPHELD', note: 'Mandate documents are in order.' })).toMatchObject({
      status: 'RESOLVED',
    });

    // Payout, confirmed by the provider.
    const plan = await x.requestPayout(w.admin, w.walletId, payee, 70_00n);
    await x.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    await providerPays(plan.payouts[0]!.id);
    expect(await payoutStatus(plan.payouts[0]!.id)).toBe('CONFIRMED');

    // Refund of one contribution (dual-approved, provider-confirmed).
    await refund(toRefund.payment.id, 20_00n, x.ecocash);
    const { rows: ps } = await x.h.db.query<{ state: string }>('SELECT state FROM payment WHERE id = $1', [toRefund.payment.id]);
    expect(ps[0]!.state).toBe('REFUNDED');
    expect(await community(w.walletId)).toMatchObject({ settled: 30_00n, available: 30_00n, paid: 70_00n });

    // Close: contributions stop at once; residual with the policy unset blocks closure.
    await x.payouts.run(w.admin.actor, x.payouts.closure.start, { walletId: w.walletId, kind: 'CLOSE', reasonCode: 'FUNERAL_COMPLETED' });
    await expect(x.contributions.contribute(x.guest(), x.input(w.slug))).rejects.toThrow();
    const settleRecon = async () => x.payments.runRecon(ops.actor, 'ECOCASH', x.h.now().toISOString().slice(0, 10));
    await settleRecon();
    const closeCase = async () => {
      // Any refund case the refund opened is worked and closed by ops before closure.
      const { rows } = await x.h.db.query<{ id: string }>('SELECT id FROM case_record WHERE wallet_id = $1 AND closed_at IS NULL', [w.walletId]);
      for (const r of rows) {
        await x.payouts.run(ops.actor, x.payouts.governance.assign, { caseId: r.id, assigneePersonId: ops.personId }).catch(() => undefined);
        await x.payouts.run(ops.actor, x.payouts.governance.resolve, { caseId: r.id, outcome: 'SETTLED_BY_AGREEMENT', note: 'Refund completed and confirmed by provider.' }).catch(() => undefined);
      }
    };
    await closeCase();
    let check = await x.payouts.run(w.admin.actor, x.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual(['RESIDUAL_POLICY_UNSET']);
    expect(check.residual).toEqual([expect.objectContaining({ source: 'W:COMMUNITY', amount: usd(30_00n) })]);
    await expect(x.payouts.run(w.admin.actor, x.payouts.closure.finalise, { walletId: w.walletId })).rejects.toBeInstanceOf(ClosureBlockedError);

    // Excess-funds policy approved through the portal: residual still has to be handled by people.
    await governedFlag('closure.excess_funds_policy', 'PAY_TO_FAMILY_RECIPIENT', 'Board approved residual policy for the pilot.');
    check = await x.payouts.run(w.admin.actor, x.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual(['RESIDUAL_BALANCE']);
    const last = await x.requestPayout(w.admin, w.walletId, payee, 30_00n, { purpose: 'OTHER_APPROVED' });
    await x.payouts.decide(w.approver.actor, last.approvalId!, 'APPROVED');
    await providerPays(last.payouts[0]!.id);
    check = await x.payouts.run(w.admin.actor, x.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual([]);

    // Closure with statements.
    const closed = await x.payouts.run(w.admin.actor, x.payouts.closure.finalise, { walletId: w.walletId });
    expect(closed.status).toBe('CLOSED');
    const fam = await x.payouts.run(w.admin.actor, x.payouts.closure.statements, { walletId: w.walletId });
    expect(fam.map((s) => s.kind)).toEqual(['FAMILY']);
    const content = fam[0]!.content as { payouts: { amount: { minor: string } }[]; movements: { kind: string }[] };
    expect(content.payouts.map((p) => p.amount.minor)).toEqual(['7000', '3000']);
    expect(content.movements.map((m) => m.kind)).toEqual(expect.arrayContaining(['CONTRIBUTION', 'PAYOUT', 'REFUND']));
    const staff = await x.payouts.run(ops.actor, x.payouts.closure.statements, { walletId: w.walletId });
    expect(staff.map((s) => s.kind)).toEqual(['AUDIT_PACK', 'FAMILY']);
    expect(await community(w.walletId)).toMatchObject({ settled: 0n, available: 0n, paid: 100_00n });
  });

  it('cancellation: unsubmitted payouts cancelled, a REFUND case opened, nothing refunded automatically', async () => {
    t = await createOpsHarness();
    const x = t;
    const w = await x.fundedWallet(40_00n);
    const payee = await x.activePayee(w.admin, w.approver, w.walletId);
    const plan = await x.requestPayout(w.admin, w.walletId, payee, 10_00n);
    const r = await x.payouts.run(w.admin.actor, x.payouts.closure.start, { walletId: w.walletId, kind: 'CANCEL', reasonCode: 'CREATED_IN_ERROR' });
    expect(r.cancelledRequests).toBe(1);
    expect(await payoutStatus(plan.payouts[0]!.id)).toBe('CANCELLED');
    const { rows } = await x.h.db.query<{ case_type: string; closed_at: Date | null }>('SELECT case_type, closed_at FROM case_record WHERE id = $1', [r.refundCaseId]);
    expect(rows[0]).toMatchObject({ case_type: 'REFUND', closed_at: null });
    const { rows: refunds } = await x.h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM refund');
    expect(refunds[0]!.n).toBe(0);
    expect(await community(w.walletId)).toMatchObject({ settled: 40_00n, reserved: 0n });
    const check = await x.payouts.run(w.admin.actor, x.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual(expect.arrayContaining(['OPEN_CASES', 'RESIDUAL_POLICY_UNSET']));
  });
});

describe('§A 13 — contributor sees total + receipt < 30 s with no family action; initiation < 5 s', () => {
  it('initiation < 5 s; after the provider webhook, receipt and public total are there at once (harness + wall clock)', async () => {
    t = await createOpsHarness();
    const x = t;
    const { slug, admin } = await x.publicWallet();
    const before = (await x.contributions.page(slug)).totals?.raised;
    expect(before).toEqual(usd(0n));

    const t0 = performance.now();
    const r = await x.contributions.contribute(x.guest(), x.input(slug, { amount: usd(15_00n) }));
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(r.payment.state).toBe('INITIATED');

    const familyAudit = async () =>
      (await x.h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1', [admin.personId])).rows[0]!.n;
    const familyBefore = await familyAudit();
    const confirmedAt = x.h.now().getTime();

    x.ecocash.succeed(await providerRefOf(r.payment.id));
    const t1 = performance.now();
    await x.deliver(x.ecocash);
    await x.pump();
    const view = await x.contributions.view(x.guest(), r.contributionId, r.accessToken);
    const page = await x.contributions.page(slug);
    const wall = performance.now() - t1;

    expect(view.state).toBe('SUCCEEDED');
    expect(view.receipt).toMatchObject({ amount: usd(15_00n) });
    expect(page.totals?.raised).toEqual(usd(15_00n));
    expect(wall).toBeLessThan(30_000);
    // Harness clock: nothing had to wait (no clock advance needed for the receipt + total).
    expect(x.h.now().getTime() - confirmedAt).toBeLessThan(30_000);
    // No family action took part.
    expect(await familyAudit()).toBe(familyBefore);
  });
});
