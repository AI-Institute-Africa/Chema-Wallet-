// P07 payouts, governance, disputes, refunds, closure (docs/08, docs/02,
// docs/14 §G §O) on mock rails + MockFidelity, through the real commands.
import { ConflictError, ForbiddenError, decideApproval, grantConsent } from '@chema/core';
import { getBalances } from '@chema/ledger';
import { money } from '@chema/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClosureBlockedError } from './closure';
import { PayoutCheckError } from './payouts';
import { createPayoutHarness, type PayoutHarness } from './test-support';

let t: PayoutHarness;
beforeEach(async () => {
  t = await createPayoutHarness();
});
afterEach(async () => {
  await t.close();
});

const usd = (m: bigint) => money(m, 'USD');
const HOUR = 3_600_000;

async function community(walletId: string) {
  const b = (await getBalances(t.h.db, walletId)).find((x) => x.account.kind === 'COMMUNITY')!;
  return { settled: b.settled.minor, reserved: b.reserved.minor, held: b.held.minor, available: b.available.minor, paid: b.paid.minor };
}

async function status(payoutId: string): Promise<string> {
  const { rows } = await t.h.db.query<{ status: string }>('SELECT status FROM payout_request WHERE id = $1', [payoutId]);
  return rows[0]!.status;
}

/** The provider pays it out and calls back; the callback is a trigger, the status query decides. */
async function providerPays(payoutId: string) {
  const ref = t.ecocash.payoutRefFor(payoutId)!;
  t.ecocash.payoutSucceed(ref);
  await t.deliverPayouts(t.ecocash);
}

async function setup(minor = 1_000_00n) {
  const w = await t.fundedWallet(minor);
  const payee = await t.activePayee(w.admin, w.approver, w.walletId);
  return { ...w, payee };
}

describe('payees: manual entry + name check + dual approval of the destination', () => {
  it('activates only after a provider name MATCH and a different person approving', async () => {
    const w = await t.fundedWallet(10_00n);
    t.ecocash.accountNames.set('+263719990001', 'DOVES FUNERAL SERVICES');
    const token = await t.stepUp(w.admin, 'wallet.change_payout_destination', w.walletId);
    const r = await t.payouts.addPayee(
      w.admin.actor,
      { walletId: w.walletId, label: 'Doves', holderName: 'Doves Funeral Services', rail: 'ECOCASH', destination: '+263719990001' },
      token,
    );
    expect(r.payee).toMatchObject({ status: 'PENDING', verification: 'MATCH', destination: '+26371•••0001' });
    // The maker cannot check their own destination.
    await expect(t.payouts.decide(w.admin.actor, r.approvalId, 'APPROVED')).rejects.toBeInstanceOf(ForbiddenError);
    await t.payouts.decide(w.approver.actor, r.approvalId, 'APPROVED');
    const list = await t.payouts.run(w.admin.actor, t.payouts.payees.list, { walletId: w.walletId });
    expect(list[0]).toMatchObject({ status: 'ACTIVE' });
    // The full number is never stored in clear text.
    const { rows } = await t.h.db.query<{ destination_sealed: string }>('SELECT destination_sealed FROM payee');
    expect(rows[0]!.destination_sealed).not.toContain('263719990001');
  });

  it('a name mismatch rejects the payee even if approved; adding one needs step-up', async () => {
    const w = await t.fundedWallet(10_00n);
    t.ecocash.accountNames.set('+263719990002', 'SOMEONE ELSE');
    await expect(
      t.payouts.addPayee(w.admin.actor, { walletId: w.walletId, label: 'X', holderName: 'Doves Funeral', rail: 'ECOCASH', destination: '+263719990002' }),
    ).rejects.toThrow('STEP_UP_REQUIRED');
    const token = await t.stepUp(w.admin, 'wallet.change_payout_destination', w.walletId);
    const r = await t.payouts.addPayee(w.admin.actor, { walletId: w.walletId, label: 'X', holderName: 'Doves Funeral', rail: 'ECOCASH', destination: '+263719990002' }, token);
    expect(r.payee.status).toBe('REJECTED');
  });

  it('a destination change retires the old payee and cancels its unsubmitted payouts', async () => {
    const w = await setup(100_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 40_00n); // dual ⇒ awaiting approval
    expect(plan.payouts[0]!.status).toBe('AWAITING_APPROVAL');
    const replacement = await t.activePayee(w.admin, w.approver, w.walletId, { holder: 'Nyaradzo Funeral' });
    expect(replacement).toBeTruthy();
    // activePayee did not pass replacesPayeeId; do the governed change explicitly.
    t.ecocash.accountNames.set('+263719990003', 'GOOD SAMARITAN PARLOUR');
    const token = await t.stepUp(w.admin, 'wallet.change_payout_destination', w.walletId);
    const r = await t.payouts.addPayee(
      w.admin.actor,
      { walletId: w.walletId, label: 'GS', holderName: 'Good Samaritan Parlour', rail: 'ECOCASH', destination: '+263719990003', replacesPayeeId: w.payee },
      token,
    );
    await t.payouts.decide(w.approver.actor, r.approvalId, 'APPROVED');
    expect(await status(plan.payouts[0]!.id)).toBe('CANCELLED');
    expect((await community(w.walletId)).reserved).toBe(0n);
    const { rows } = await t.h.db.query<{ status: string }>('SELECT status FROM payee WHERE id = $1', [w.payee]);
    expect(rows[0]!.status).toBe('RETIRED');
  });
});

describe('§G single vs dual approval', () => {
  it('threshold unset ⇒ every payout waits for a checker; completes only on provider confirmation', async () => {
    const w = await setup(100_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 70_00n);
    const id = plan.payouts[0]!.id;
    expect(plan.payouts[0]!.status).toBe('AWAITING_APPROVAL');
    expect(await community(w.walletId)).toMatchObject({ settled: 100_00n, reserved: 70_00n, available: 30_00n, paid: 0n });
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    expect(await status(id)).toBe('SUBMITTED');
    // Submitted is not paid: no journal, money still reserved.
    expect(await community(w.walletId)).toMatchObject({ settled: 100_00n, reserved: 70_00n, paid: 0n });
    await providerPays(id);
    expect(await status(id)).toBe('CONFIRMED');
    expect(await community(w.walletId)).toMatchObject({ settled: 30_00n, reserved: 0n, available: 30_00n, paid: 70_00n });
    await t.deliverPayouts(t.ecocash); // nothing new; replays are no-ops
    const { rows } = await t.h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_journal WHERE kind = 'PAYOUT'");
    expect(rows[0]!.n).toBe(1);
  });

  it('threshold set ⇒ at or under it is single approval; above it ops/finance may check', async () => {
    t = await (async () => {
      await t.close();
      return createPayoutHarness({ 'approvals.payout_high_value_minor': '5000' });
    })();
    const w = await setup(200_00n);
    const small = await t.requestPayout(w.admin, w.walletId, w.payee, 50_00n);
    expect(small.approvalId).toBeNull();
    expect(small.payouts[0]!.status).toBe('APPROVED');
    expect(await status(small.payouts[0]!.id)).toBe('SUBMITTED');
    const big = await t.requestPayout(w.admin, w.walletId, w.payee, 60_00n);
    expect(big.payouts[0]!.status).toBe('AWAITING_APPROVAL');
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payouts.decide(ops.actor, big.approvalId!, 'APPROVED');
    expect(await status(big.payouts[0]!.id)).toBe('SUBMITTED');
  });

  it('a split plan (70/30) is checked as one total and each part is paid on its own', async () => {
    const w = await setup(100_00n);
    const second = await t.activePayee(w.admin, w.approver, w.walletId, { holder: 'Mbare Catering' });
    const token = await t.stepUp(w.admin, 'payout.request', w.walletId);
    const plan = await t.payouts.requestPayout(
      w.admin.actor,
      {
        walletId: w.walletId,
        source: { kind: 'COMMUNITY' },
        currency: 'USD',
        parts: [
          { payeeId: w.payee, amountMinor: 70_00n, purpose: 'PARLOUR' },
          { payeeId: second, amountMinor: 30_00n, purpose: 'FOOD' },
        ],
        idempotencyKey: 'plan-split-0001',
      },
      token,
    );
    expect(plan.payouts.map((p) => p.amount.minor)).toEqual([70_00n, 30_00n]);
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    await providerPays(plan.payouts[0]!.id);
    t.ecocash.payoutFail(t.ecocash.payoutRefFor(plan.payouts[1]!.id)!);
    await t.deliverPayouts(t.ecocash);
    expect([await status(plan.payouts[0]!.id), await status(plan.payouts[1]!.id)]).toEqual(['CONFIRMED', 'FAILED']);
    // Failed part's reservation released; only the paid part left the wallet.
    expect(await community(w.walletId)).toMatchObject({ settled: 30_00n, reserved: 0n, available: 30_00n, paid: 70_00n });
  });

  it('payout > available is refused, and a rejected request releases its reservation', async () => {
    const w = await setup(50_00n);
    await expect(t.requestPayout(w.admin, w.walletId, w.payee, 50_01n)).rejects.toMatchObject({ check: 'INSUFFICIENT_AVAILABLE' });
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 50_00n);
    await expect(t.requestPayout(w.admin, w.walletId, w.payee, 1n)).rejects.toMatchObject({ check: 'INSUFFICIENT_AVAILABLE' });
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'REJECTED');
    expect(await status(plan.payouts[0]!.id)).toBe('REJECTED');
    expect((await community(w.walletId)).available).toBe(50_00n);
  });

  it('no step-up ⇒ denied; agents and contributors can never request; same idempotency key replays', async () => {
    const w = await setup(50_00n);
    const input = { walletId: w.walletId, source: { kind: 'COMMUNITY' as const }, currency: 'USD' as const, parts: [{ payeeId: w.payee, amountMinor: 10_00n, purpose: 'PARLOUR' as const }], idempotencyKey: 'plan-idem-0001' };
    await expect(t.payouts.requestPayout(w.admin.actor, input)).rejects.toThrow('STEP_UP_REQUIRED');
    const agent = await t.h.staff('AGENT');
    await t.h.grantRole(w.walletId, agent.personId, 'AGENT');
    await expect(t.payouts.requestPayout(agent.actor, input)).rejects.toBeInstanceOf(ForbiddenError);
    const a = await t.payouts.requestPayout(w.admin.actor, input, await t.stepUp(w.admin, 'payout.request', w.walletId));
    const b = await t.payouts.requestPayout(w.admin.actor, input, await t.stepUp(w.admin, 'payout.request', w.walletId));
    expect(b).toMatchObject({ planId: a.planId, replayed: true });
    expect((await community(w.walletId)).reserved).toBe(10_00n);
  });
});

describe('§G unavailable approver ⇒ escalation, never a bypass', () => {
  it('no other family checker ⇒ escalate at once to ops/finance, who checks it', async () => {
    const { walletId, slug, admin } = await t.publicWallet();
    await t.contributePaid(slug, 50_00n);
    // No approver on the wallet: the destination change escalates too.
    t.ecocash.accountNames.set('+263719990009', 'DOVES');
    const pr = await t.payouts.addPayee(admin.actor, { walletId, label: 'D', holderName: 'Doves', rail: 'ECOCASH', destination: '+263719990009' }, await t.stepUp(admin, 'wallet.change_payout_destination', walletId));
    await t.payouts.escalateApproval(admin.actor, pr.approvalId, 'No second family member available');
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payouts.decide(ops.actor, pr.approvalId, 'APPROVED');
    const plan = await t.requestPayout(admin, walletId, pr.payee.id, 20_00n);
    // Un-escalated, ops/finance is not a checker while the threshold is unset.
    await expect(t.payouts.decide(ops.actor, plan.approvalId!, 'APPROVED')).rejects.toThrow('THRESHOLD_UNSET');
    await t.payouts.escalateApproval(admin.actor, plan.approvalId!, 'No second family member available');
    await t.payouts.decide(ops.actor, plan.approvalId!, 'APPROVED');
    expect(await status(plan.payouts[0]!.id)).toBe('SUBMITTED');
  });

  it('with an approver on the wallet the maker must wait 24 h; only the maker may escalate', async () => {
    const w = await setup(50_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 20_00n);
    await expect(t.payouts.escalateApproval(w.admin.actor, plan.approvalId!, 'Approver is not answering')).rejects.toThrow('TOO_EARLY_TO_ESCALATE');
    await expect(t.payouts.escalateApproval(w.approver.actor, plan.approvalId!, 'Approver is not answering')).rejects.toBeInstanceOf(ForbiddenError);
    t.h.advance(25 * HOUR);
    await t.payouts.escalateApproval(w.admin.actor, plan.approvalId!, 'Approver is not answering');
    // A FIDELITY_ADMIN is not the escalation target for payouts.
    const fa = await t.h.staff('FIDELITY_ADMIN');
    await expect(t.payouts.decide(fa.actor, plan.approvalId!, 'APPROVED')).rejects.toBeInstanceOf(ForbiddenError);
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payouts.decide(ops.actor, plan.approvalId!, 'APPROVED');
    expect(await status(plan.payouts[0]!.id)).toBe('SUBMITTED');
  });
});

describe('§G family dispute (hold + case) and source-aware holds', () => {
  it('authority dispute holds community payouts, not the Fidelity benefit; release is dual; then resolve', async () => {
    const c = await t.linkedCase('APPROVED');
    await t.contributePaid(c.slug, 80_00n);
    const approver = await t.approver(c.walletId);
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    t.fidelity.pay(c.claimRef, usd(500_00n));
    await t.deliverFidelity();
    const community1 = await t.activePayee(c.admin, approver, c.walletId);
    const benefitPayee = await t.activePayee(c.admin, approver, c.walletId, { holder: 'Recipient Person', personId: c.admin.personId });
    const pending = await t.requestPayout(c.admin, c.walletId, community1, 30_00n);
    await t.payouts.decide(approver.actor, pending.approvalId!, 'APPROVED'); // submitted before the dispute

    const dispute = await t.payouts.run(approver.actor, t.payouts.governance.open, {
      walletId: c.walletId,
      type: 'AUTHORITY_DISPUTE',
      summary: 'Brother disputes that the admin may spend the community money.',
    });
    expect(dispute.holds).toEqual([expect.objectContaining({ scope: 'SOURCE', source: 'COMMUNITY', released: false })]);
    await expect(t.requestPayout(c.admin, c.walletId, community1, 10_00n)).rejects.toMatchObject({ check: 'HOLD_APPLIES' });
    // The benefit (separate source, approved recipient) is not frozen by a community dispute.
    const benefit = await t.requestPayout(c.admin, c.walletId, benefitPayee, 100_00n, { source: 'FIDELITY_BENEFIT', purpose: 'FAMILY_BENEFICIARY' });
    await t.payouts.decide(approver.actor, benefit.approvalId!, 'APPROVED');
    expect(await status(benefit.payouts[0]!.id)).toBe('SUBMITTED');

    // Resolution needs the hold released first, and release is maker-checker.
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payouts.run(ops.actor, t.payouts.governance.assign, { caseId: dispute.id, assigneePersonId: ops.personId });
    await expect(t.payouts.run(ops.actor, t.payouts.governance.resolve, { caseId: dispute.id, outcome: 'NOT_UPHELD', note: 'Mandate documents are in order.' })).rejects.toThrow('CASE_HAS_ACTIVE_HOLDS');
    const holdId = dispute.holds[0]!.id;
    const rel = await t.payouts.run(ops.actor, t.payouts.governance.holdRelease, { holdId, reason: 'Mediation done, mandate upheld.' });
    await expect(t.h.bus.execute(decideApproval, { approvalId: rel.approvalId, decision: 'APPROVED' }, { actor: ops.actor })).rejects.toBeInstanceOf(ForbiddenError);
    const ops2 = await t.h.staff('OPS_FINANCE');
    await t.h.bus.execute(decideApproval, { approvalId: rel.approvalId, decision: 'APPROVED' }, { actor: ops2.actor });
    await t.payouts.run(ops.actor, t.payouts.governance.holdRelease, { holdId, reason: 'Mediation done, mandate upheld.', approvalId: rel.approvalId });
    const done = await t.payouts.run(ops.actor, t.payouts.governance.resolve, { caseId: dispute.id, outcome: 'NOT_UPHELD', note: 'Mandate documents are in order.' });
    expect(done).toMatchObject({ status: 'RESOLVED', outcome: 'NOT_UPHELD' });
    await t.requestPayout(c.admin, c.walletId, community1, 10_00n);
  });

  it('a hold placed after approval stops an unsubmitted payout; a wallet-wide hold needs a risk reason', async () => {
    const w = await setup(50_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 20_00n);
    const ops = await t.h.staff('OPS_FINANCE');
    await expect(
      t.payouts.run(ops.actor, t.payouts.governance.holdPlace, { walletId: w.walletId, scope: 'WALLET', reasonCode: 'AUTHORITY_DISPUTE', note: 'Family disagreement reported.', reviewAt: new Date() }),
    ).rejects.toThrow('WALLET_HOLD_NEEDS_RISK_REASON');
    await t.payouts.run(ops.actor, t.payouts.governance.holdPlace, { walletId: w.walletId, scope: 'WALLET', reasonCode: 'FRAUD_RISK', note: 'Police report received about the death.', reviewAt: new Date() });
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    expect(await status(plan.payouts[0]!.id)).toBe('APPROVED');
    const v = await t.payouts.run(w.admin.actor, t.payouts.payouts.view, { payoutId: plan.payouts[0]!.id });
    expect(v.blockedBy).toBe('HOLD:FRAUD_RISK');
    expect(t.ecocash.calls.filter((c) => c.op === 'payout')).toHaveLength(0);
  });

  it('a disputed payout blocks only that payout (proportionate)', async () => {
    const w = await setup(100_00n);
    const a = await t.requestPayout(w.admin, w.walletId, w.payee, 20_00n);
    const b = await t.requestPayout(w.admin, w.walletId, w.payee, 20_00n);
    await t.payouts.run(w.approver.actor, t.payouts.governance.open, {
      walletId: w.walletId,
      type: 'PAYMENT_DISPUTE',
      summary: 'This parlour invoice was already paid in cash.',
      payoutRequestId: a.payouts[0]!.id,
    });
    await t.payouts.decide(w.approver.actor, a.approvalId!, 'APPROVED');
    await t.payouts.decide(w.approver.actor, b.approvalId!, 'APPROVED');
    expect([await status(a.payouts[0]!.id), await status(b.payouts[0]!.id)]).toEqual(['APPROVED', 'SUBMITTED']);
  });

  it('privileged staff are scoped: an unassigned claims officer can neither see nor resolve a case', async () => {
    const w = await setup(10_00n);
    const c = await t.payouts.run(w.admin.actor, t.payouts.governance.open, { walletId: w.walletId, type: 'FRAUD', summary: 'Someone is collecting for this funeral elsewhere.' });
    const claims = await t.h.staff('CLAIMS_OFFICER');
    await expect(t.payouts.run(claims.actor, t.payouts.governance.view, { caseId: c.id })).rejects.toThrow('NOT_ASSIGNED');
    const other = await t.h.staff('CLAIMS_OFFICER');
    const fa = await t.fidelityAdmin();
    await t.payouts.run(fa.actor, t.payouts.governance.assign, { caseId: c.id, assigneePersonId: other.personId });
    // Assigned to the wallet now, but not the case owner.
    await t.h.assign(claims.personId, w.walletId);
    await expect(t.payouts.run(claims.actor, t.payouts.governance.resolve, { caseId: c.id, outcome: 'NOT_UPHELD', note: 'No evidence of fraud found.' })).rejects.toThrow('NOT_CASE_OWNER');
    await t.payouts.run(other.actor, t.payouts.governance.resolve, { caseId: c.id, outcome: 'NOT_UPHELD', note: 'No evidence of fraud found.' });
    // The family cannot resolve a case.
    await expect(t.payouts.run(w.admin.actor, t.payouts.governance.resolve, { caseId: c.id, outcome: 'WITHDRAWN', note: 'We withdraw it now.' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('§G admin replacement (dual + verifier re-check)', () => {
  it('approver requests, old admin checks, verifier re-checks, requester executes; the wallet follows', async () => {
    const w = await setup(50_00n);
    const doc = await t.upload(w.approver.actor, w.walletId, 'MANDATE').catch(async () => t.upload(w.admin.actor, w.walletId, 'MANDATE'));
    const newPhone = '+263719998877';
    const token = await t.stepUp(w.approver, 'wallet.replace_admin', w.walletId);
    const change = await t.payouts.run(
      w.approver.actor,
      t.payouts.mandate.request,
      { walletId: w.walletId, kind: 'REPLACE_ADMIN', newAdminPhone: newPhone, reason: 'Admin is in hospital; family agreed on the sister.', evidenceDocs: [doc] },
      token,
    );
    const old = await t.requestPayout(w.admin, w.walletId, w.payee, 10_00n); // unsubmitted request of the old admin
    await t.payouts.decide(w.admin.actor, change.approvalId, 'APPROVED');
    await expect(t.payouts.run(w.approver.actor, t.payouts.mandate.execute, { changeId: change.id })).rejects.toThrow('AWAITING_VERIFIER');
    const verifier = await t.verifier();
    await expect(
      t.payouts.run(verifier.actor, t.payouts.mandate.verify, { changeId: change.id, outcome: 'APPROVED', reasonCode: 'AUTHORITY_SHOWN' }),
    ).rejects.toThrow('NOT_ASSIGNED');
    await t.h.assign(verifier.personId, w.walletId);
    await t.payouts.run(verifier.actor, t.payouts.mandate.verify, { changeId: change.id, outcome: 'APPROVED', reasonCode: 'AUTHORITY_SHOWN' });
    // The new admin must have confirmed the phone by OTP first.
    await expect(t.payouts.run(w.approver.actor, t.payouts.mandate.execute, { changeId: change.id })).rejects.toThrow('NEW_ADMIN_NOT_CONFIRMED');
    const sister = await t.h.customer(newPhone);
    const done = await t.payouts.run(w.approver.actor, t.payouts.mandate.execute, { changeId: change.id });
    expect(done.status).toBe('EXECUTED');
    const { rows } = await t.h.db.query<{ admin_person: string }>('SELECT admin_person FROM wallet WHERE id = $1', [w.walletId]);
    expect(rows[0]!.admin_person).toBe(sister.personId);
    expect(await status(old.payouts[0]!.id)).toBe('CANCELLED');
    await expect(t.requestPayout(w.admin, w.walletId, w.payee, 1_00n)).rejects.toBeInstanceOf(ForbiddenError);
    await t.requestPayout(sister, w.walletId, w.payee, 1_00n);
  });

  it('the database refuses an admin change that did not go through an executed replacement', async () => {
    const w = await setup(10_00n);
    const other = await t.h.customer();
    await expect(t.h.db.query('UPDATE wallet SET admin_person = $2 WHERE id = $1', [w.walletId, other.personId])).rejects.toThrow(/admin replacement/);
  });

  it('a verifier who is party to the change, or a checker who made it, is refused', async () => {
    const w = await setup(10_00n);
    const doc = await t.upload(w.admin.actor, w.walletId, 'MANDATE');
    const token = await t.stepUp(w.admin, 'mandate.change', w.walletId);
    const change = await t.payouts.run(w.admin.actor, t.payouts.mandate.request, { walletId: w.walletId, kind: 'ADD_APPROVER', approverPhone: '+263719990077', reason: 'Adding my uncle as a second approver.', evidenceDocs: [doc] }, token);
    await expect(t.payouts.decide(w.admin.actor, change.approvalId, 'APPROVED')).rejects.toBeInstanceOf(ForbiddenError);
    await t.payouts.decide(w.approver.actor, change.approvalId, 'APPROVED');
    const v = await t.verifier();
    await t.h.assign(v.personId, w.walletId);
    await t.payouts.run(v.actor, t.payouts.mandate.verify, { changeId: change.id, outcome: 'APPROVED', reasonCode: 'AUTHORITY_SHOWN' });
    const r = await t.payouts.run(w.admin.actor, t.payouts.mandate.execute, { changeId: change.id });
    expect(r.status).toBe('EXECUTED');
    const { rows } = await t.h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM wallet_role WHERE wallet_id = $1 AND role = 'APPROVER' AND revoked_at IS NULL", [w.walletId]);
    expect(rows[0]!.n).toBe(2);
  });
});

describe('§O operations', () => {
  it('rail outage ⇒ retry queue recovers; exhausted ⇒ RAIL_DOWN ⇒ dual-approved manual override', async () => {
    const w = await setup(100_00n);
    t.ecocash.scenario.outage = true;
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 40_00n);
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    const id = plan.payouts[0]!.id;
    expect(await status(id)).toBe('RETRY');
    t.ecocash.scenario.outage = false;
    t.h.advance(2 * 60_000);
    await t.payouts.runDue();
    expect(await status(id)).toBe('SUBMITTED');
    await providerPays(id);
    expect(await status(id)).toBe('CONFIRMED');

    t.ecocash.scenario.outage = true;
    const plan2 = await t.requestPayout(w.admin, w.walletId, w.payee, 30_00n);
    await t.payouts.decide(w.approver.actor, plan2.approvalId!, 'APPROVED');
    for (let i = 0; i < 6; i++) {
      t.h.advance(40 * 60_000);
      await t.payouts.runDue();
    }
    const id2 = plan2.payouts[0]!.id;
    expect(await status(id2)).toBe('RAIL_DOWN');
    expect((await community(w.walletId)).reserved).toBe(30_00n); // still set aside, never lost
    const ops = await t.h.staff('OPS_FINANCE');
    const evidence = await t.upload(w.admin.actor, w.walletId, 'OTHER');
    const o = await t.payouts.run(ops.actor, t.payouts.payouts.override, { payoutId: id2, externalRef: 'BANK-TT-55102', documentId: evidence });
    await expect(t.h.bus.execute(decideApproval, { approvalId: o.approvalId, decision: 'APPROVED' }, { actor: ops.actor })).rejects.toBeInstanceOf(ForbiddenError);
    const ops2 = await t.h.staff('OPS_FINANCE');
    await t.h.bus.execute(decideApproval, { approvalId: o.approvalId, decision: 'APPROVED' }, { actor: ops2.actor });
    await t.payouts.run(ops.actor, t.payouts.payouts.override, { payoutId: id2, externalRef: 'BANK-TT-55102', documentId: evidence, approvalId: o.approvalId });
    expect(await status(id2)).toBe('CONFIRMED');
    expect(await community(w.walletId)).toMatchObject({ settled: 30_00n, reserved: 0n, paid: 70_00n });
  });

  it('timeout ⇒ submitted-unknown, resolved by status query (never resubmitted blindly)', async () => {
    const w = await setup(50_00n);
    t.ecocash.scenario.payoutTimeout = true;
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 25_00n);
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    const id = plan.payouts[0]!.id;
    expect(await status(id)).toBe('SUBMITTED');
    t.ecocash.scenario.payoutTimeout = false;
    t.ecocash.payoutSucceed(t.ecocash.payoutRefFor(id)!);
    t.ecocash.takeWebhooks(); // callback lost
    t.h.advance(2 * 60_000);
    await t.payouts.runDue();
    expect(await status(id)).toBe('CONFIRMED');
    expect(t.ecocash.calls.filter((c) => c.op === 'payout')).toHaveLength(1);
  });

  it('provider reversal after confirmation ⇒ linked compensating journal, money back in the wallet', async () => {
    const w = await setup(50_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 20_00n);
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    const id = plan.payouts[0]!.id;
    await providerPays(id);
    t.ecocash.payoutReverse(t.ecocash.payoutRefFor(id)!);
    await t.deliverPayouts(t.ecocash);
    expect(await status(id)).toBe('REVERSED');
    expect(await community(w.walletId)).toMatchObject({ settled: 50_00n, available: 50_00n, paid: 0n });
  });

  it('notification failure never affects payout state', async () => {
    const w = await setup(50_00n);
    t.sms.failNext(100);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 20_00n);
    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    await providerPays(plan.payouts[0]!.id);
    await t.pump();
    expect(await status(plan.payouts[0]!.id)).toBe('CONFIRMED');
    const { rows } = await t.h.db.query<{ status: string }>("SELECT status FROM notification WHERE template = 'payout.notice.confirmed'");
    expect(rows[0]!.status).toBe('RETRY');
  });

  it('case and recon-exception ageing ⇒ escalation by the sweep', async () => {
    const w = await setup(10_00n);
    const c = await t.payouts.run(w.admin.actor, t.payouts.governance.open, { walletId: w.walletId, type: 'PROVIDER_DISPUTE', summary: 'EcoCash says the payment never arrived.' });
    expect((await t.payouts.sweep()).casesEscalated).toBe(0);
    t.h.advance(169 * HOUR);
    const r = await t.payouts.sweep();
    expect(r.casesEscalated).toBe(1);
    const fa = await t.fidelityAdmin();
    const v = await t.payouts.run(fa.actor, t.payouts.governance.view, { caseId: c.id });
    expect(v).toMatchObject({ status: 'ESCALATED', escalationLevel: 1 });
    expect(new Date(v.slaDueAt).getTime()).toBeGreaterThan(t.h.now().getTime());
    // A recon exception past its SLA escalates too (level only rises).
    t.ecocash.addSettlementRow('2026-11-01', { providerRef: 'ECOCASH-UNKNOWN-1', gross: usd(5_00n), fee: usd(0n), merchantRef: t.ecocash.merchantRef });
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payments.runRecon(ops.actor, 'ECOCASH', '2026-11-01');
    t.h.advance(25 * HOUR);
    expect((await t.payouts.sweep()).exceptionsEscalated).toBeGreaterThanOrEqual(1);
    await expect(t.h.db.query('UPDATE recon_exception SET escalation_level = 0')).rejects.toThrow(/only rises/);
  });
});

describe('§O closure', () => {
  async function settleRecon() {
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payments.runRecon(ops.actor, 'ECOCASH', t.h.now().toISOString().slice(0, 10));
  }

  it('closure blocked with residual (policy unset), pending payouts and open disputes; then closes with statements', async () => {
    const w = await setup(60_00n);
    await t.payouts.run(w.admin.actor, t.payouts.closure.start, { walletId: w.walletId, kind: 'CLOSE', reasonCode: 'FUNERAL_COMPLETED' });
    // Contributions stop at once; the page shows the closed state.
    await expect(t.contributions.contribute(t.guest(), t.input(w.slug))).rejects.toThrow();
    const page = await t.contributions.page(w.slug);
    expect(page).toMatchObject({ closed: true, contribute: { rails: [] } });

    let check = await t.payouts.run(w.admin.actor, t.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual(expect.arrayContaining(['RECON_NOT_FINAL', 'RESIDUAL_POLICY_UNSET']));
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 60_00n); // residual payouts allowed while CLOSING
    const dispute = await t.payouts.run(w.approver.actor, t.payouts.governance.open, { walletId: w.walletId, type: 'PROVIDER_DISPUTE', summary: 'Checking one receipt with the provider.' });
    check = await t.payouts.run(w.admin.actor, t.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual(expect.arrayContaining(['OPEN_PAYOUTS', 'ACTIVE_RESERVATIONS', 'OPEN_CASES']));
    await expect(t.payouts.run(w.admin.actor, t.payouts.closure.finalise, { walletId: w.walletId })).rejects.toBeInstanceOf(ClosureBlockedError);

    await t.payouts.decide(w.approver.actor, plan.approvalId!, 'APPROVED');
    await providerPays(plan.payouts[0]!.id);
    const ops = await t.h.staff('OPS_FINANCE');
    await t.payouts.run(ops.actor, t.payouts.governance.resolve, { caseId: dispute.id, outcome: 'WITHDRAWN', note: 'Provider confirmed the receipt.' });
    await settleRecon();
    check = await t.payouts.run(w.admin.actor, t.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual([]);

    const closed = await t.payouts.run(w.admin.actor, t.payouts.closure.finalise, { walletId: w.walletId });
    expect(closed.status).toBe('CLOSED');
    const st = await t.payouts.run(w.admin.actor, t.payouts.closure.statements, { walletId: w.walletId });
    expect(st.map((s) => s.kind)).toEqual(['FAMILY']); // the audit pack is for staff
    expect(st[0]!.content).toMatchObject({ payouts: [expect.objectContaining({ purpose: 'PARLOUR', amount: { minor: '6000', ccy: 'USD' } })] });
    const staffSt = await t.payouts.run(ops.actor, t.payouts.closure.statements, { walletId: w.walletId });
    expect(staffSt.map((s) => s.kind)).toEqual(['AUDIT_PACK', 'FAMILY']);
    const closedPage = await t.contributions.page(w.slug);
    expect(closedPage.usage?.byPurpose).toEqual([{ purpose: 'PARLOUR', amount: usd(60_00n) }]);
  });

  it('residual > 0 with the policy unset keeps the wallet open, even with everything else done', async () => {
    const w = await setup(30_00n);
    await t.payouts.run(w.admin.actor, t.payouts.closure.start, { walletId: w.walletId, kind: 'CLOSE', reasonCode: 'FUNERAL_COMPLETED' });
    await settleRecon();
    const check = await t.payouts.run(w.admin.actor, t.payouts.closure.check, { walletId: w.walletId });
    expect(check.blockers).toEqual(['RESIDUAL_POLICY_UNSET']);
    expect(check.residual).toEqual([expect.objectContaining({ source: 'W:COMMUNITY', amount: usd(30_00n) })]);
    await expect(t.payouts.run(w.admin.actor, t.payouts.closure.finalise, { walletId: w.walletId })).rejects.toMatchObject({ blockers: ['RESIDUAL_POLICY_UNSET'] });
    await expect(t.h.db.query("UPDATE wallet SET status = 'CLOSED' WHERE id = $1", [w.walletId])).rejects.toThrow(/wallet_closure/);
  });

  it('cancellation: pending payouts cancelled, REFUND case opened, nothing refunded automatically', async () => {
    const w = await setup(40_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 10_00n);
    const r = await t.payouts.run(w.admin.actor, t.payouts.closure.start, { walletId: w.walletId, kind: 'CANCEL', reasonCode: 'CREATED_IN_ERROR' });
    expect(r.cancelledRequests).toBe(1);
    expect(await status(plan.payouts[0]!.id)).toBe('CANCELLED');
    const { rows } = await t.h.db.query<{ case_type: string; closed_at: Date | null }>('SELECT case_type, closed_at FROM case_record WHERE id = $1', [r.refundCaseId]);
    expect(rows[0]).toMatchObject({ case_type: 'REFUND', closed_at: null });
    const { rows: refunds } = await t.h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM refund');
    expect(refunds[0]!.n).toBe(0);
    expect((await community(w.walletId)).settled).toBe(40_00n);
  });

  it('thank-you: one tap, once, only to contributors with a live NOTIFY consent', async () => {
    const w = await setup(10_00n);
    const consenting = await t.h.customer();
    const silent = await t.h.customer();
    await t.h.bus.execute(grantConsent, { subjectPersonId: consenting.personId, purpose: 'NOTIFY' }, { actor: consenting.actor });
    for (const c of [consenting, silent]) {
      const res = await t.contributions.contribute(c.actor, t.input(w.slug, { payerPhone: '+263772000222' }));
      const { rows } = await t.h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [res.payment.id]);
      t.ecocash.succeed(rows[0]!.provider_ref);
    }
    await t.deliver(t.ecocash);
    await t.pump();
    await t.payouts.run(w.admin.actor, t.payouts.closure.start, { walletId: w.walletId, kind: 'CLOSE', reasonCode: 'FUNERAL_COMPLETED' });
    const r = await t.payouts.run(w.admin.actor, t.payouts.closure.thank, { walletId: w.walletId });
    expect(r.queued).toBe(1);
    await expect(t.payouts.run(w.admin.actor, t.payouts.closure.thank, { walletId: w.walletId })).rejects.toBeInstanceOf(ConflictError);
    const { rows } = await t.h.db.query<{ recipient_person: string }>("SELECT recipient_person FROM notification WHERE template = 'closure.thank_you'");
    expect(rows.map((x) => x.recipient_person)).toEqual([consenting.personId]);
  });
});

describe('database guards (bypassing the library)', () => {
  it('payout_request: illegal transition, unpaid close without release, and benefit to a non-recipient are refused', async () => {
    const w = await setup(50_00n);
    const plan = await t.requestPayout(w.admin, w.walletId, w.payee, 10_00n);
    const id = plan.payouts[0]!.id;
    await expect(t.h.db.query("UPDATE payout_request SET status = 'CONFIRMED' WHERE id = $1", [id])).rejects.toThrow(/illegal transition/);
    await expect(
      t.h.db.query("UPDATE payout_request SET status = 'CANCELLED', closed_at = now(), close_reason = 'x' WHERE id = $1", [id]),
    ).rejects.toThrow(/reservation released/);
    await expect(t.h.db.query('UPDATE payout_request SET amount_minor = 1 WHERE id = $1', [id])).rejects.toThrow(/only listed columns/);
    await expect(t.h.db.query('DELETE FROM payout_request WHERE id = $1', [id])).rejects.toThrow(/DELETE denied/);
  });

  it('the benefit cannot be requested to anyone but the approved recipient', async () => {
    const c = await t.linkedCase('APPROVED');
    const approver = await t.approver(c.walletId);
    t.fidelity.approve(c.claimRef);
    t.fidelity.routeTo(c.claimRef, c.recipientId);
    t.fidelity.pay(c.claimRef, usd(100_00n));
    await t.deliverFidelity();
    const parlour = await t.activePayee(c.admin, approver, c.walletId);
    await expect(t.requestPayout(c.admin, c.walletId, parlour, 10_00n, { source: 'FIDELITY_BENEFIT' })).rejects.toBeInstanceOf(PayoutCheckError);
  });
});
