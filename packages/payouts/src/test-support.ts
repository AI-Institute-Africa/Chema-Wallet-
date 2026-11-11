// Test-only harness for P07: the Fidelity harness (verification, contributions,
// mock rails, MockFidelity) + PayoutService, plus helpers that walk the REAL
// commands: step-up by OTP, payee add + name check + approval, funded wallet.
// Never import at runtime.
import { randomUUID } from 'node:crypto';
import type { Action, FlagKey } from '@chema/core';
import { createFidelityHarness, type FidelityHarness } from '@chema/fidelity/testing';
import type { MockRail } from '@chema/providers';
import { money, type SqlClient } from '@chema/shared';
import { PayoutService } from './service';
import { payoutKeys } from './store';
import type { PayoutPurpose, PayoutSource } from './types';

type Person = Awaited<ReturnType<FidelityHarness['h']['customer']>>;

export interface PayoutHarness extends FidelityHarness {
  payouts: PayoutService;
  onemoney: MockRail;
  /** A fresh step-up token for `action` on the wallet (real OTP flow). */
  stepUp(p: Person, action: Action, walletId: string): Promise<string>;
  /** Grant a family APPROVER role directly (fixture; the governed path is mandate.change). */
  approver(walletId: string): Promise<Person>;
  /** Payee added by the admin, name-checked, approved by `checker`, ACTIVE. Returns its id. */
  activePayee(admin: Person, checker: Person, walletId: string, opts?: { holder?: string; personId?: string; phone?: string }): Promise<string>;
  /** ACTIVE wallet with an approver and `minor` of settled community money. */
  fundedWallet(minor?: bigint): Promise<{ walletId: string; slug: string; admin: Person; approver: Person; verifierPersonId: string }>;
  /** Request a single-part payout (admin, step-up). */
  requestPayout(admin: Person, walletId: string, payeeId: string, minor: bigint, opts?: { source?: PayoutSource; purpose?: PayoutPurpose }): ReturnType<PayoutService['requestPayout']>;
  /** Deliver payout callbacks of a rail: webhook → provider_event → outbox → payouts.processEvent. */
  deliverPayouts(rail: MockRail): Promise<void>;
}

let phoneSeq = 5_000_000;
const nextPhone = () => `+26371${String(phoneSeq++).padStart(7, '0')}`;

export async function createPayoutHarness(flags: Partial<Record<FlagKey, string>> = {}, opts: { db?: SqlClient } = {}): Promise<PayoutHarness> {
  const t = await createFidelityHarness({ 'payouts.enabled': 'true', 'rail.onemoney': 'true', ...flags }, opts);
  const { h } = t;
  const rails = t.payments.deps.rails;
  const onemoney = rails.adapter('ONEMONEY') as MockRail;
  const payouts = new PayoutService({ db: h.db, bus: h.bus, flags: h.flags, rails, keys: payoutKeys(t.secrets), clock: h.now });
  const seenPayoutEvents = new Set<unknown>();

  const p: PayoutHarness = {
    ...t,
    payouts,
    onemoney,
    async stepUp(person, action, walletId) {
      h.advance(6 * 60_000); // stay under the OTP send limit (3 per 15 min per phone)
      const { rows } = await h.db.query<{ phone_e164: string }>('SELECT phone_e164 FROM person WHERE id = $1', [person.personId]);
      const phone = rows[0]?.phone_e164 ?? '';
      const { challengeId } = await h.auth.startStepUp(person.actor, { action, subjectType: 'wallet', subjectId: walletId });
      const code = h.otp.lastCodeFor(phone);
      if (!code) throw new Error('no step-up OTP');
      return (await h.auth.verifyStepUp(person.actor, challengeId, code)).stepUpToken;
    },
    async approver(walletId) {
      const a = await h.customer();
      await h.grantRole(walletId, a.personId, 'APPROVER');
      return a;
    },
    async activePayee(admin, checker, walletId, o = {}) {
      const phone = o.phone ?? nextPhone();
      const holder = o.holder ?? 'Doves Funeral Services';
      t.ecocash.accountNames.set(phone, holder.toUpperCase());
      const token = await p.stepUp(admin, 'wallet.change_payout_destination', walletId);
      const r = await payouts.addPayee(
        admin.actor,
        { walletId, label: holder, holderName: holder, rail: 'ECOCASH', destination: phone, ...(o.personId ? { personId: o.personId } : {}) },
        token,
      );
      await payouts.decide(checker.actor, r.approvalId, 'APPROVED');
      return r.payee.id;
    },
    async fundedWallet(minor = 1_000_00n) {
      const { walletId, slug, admin } = await t.publicWallet();
      const { rows } = await h.db.query<{ reviewer: string }>('SELECT reviewer FROM verification_case WHERE wallet_id = $1 AND outcome = $2', [walletId, 'APPROVED']);
      const approver = await p.approver(walletId);
      let left = minor;
      while (left > 0n) {
        const part = left > 1_000_00n ? 1_000_00n : left;
        await t.contributePaid(slug, part);
        left -= part;
      }
      return { walletId, slug, admin, approver, verifierPersonId: rows[0]?.reviewer ?? '' };
    },
    async requestPayout(admin, walletId, payeeId, minor, o = {}) {
      const token = await p.stepUp(admin, 'payout.request', walletId);
      return payouts.requestPayout(
        admin.actor,
        {
          walletId,
          source: { kind: o.source ?? 'COMMUNITY' },
          currency: 'USD',
          parts: [{ payeeId, amountMinor: minor, purpose: o.purpose ?? 'PARLOUR' }],
          idempotencyKey: `plan-${randomUUID()}`,
        },
        token,
      );
    },
    async deliverPayouts(rail) {
      for (const hook of rail.takeWebhooks(h.now())) {
        const r = await t.payments.receiveWebhook(rail.rail, hook.headers, hook.body);
        await t.payments.processEvent(r.eventRowId);
      }
      await t.pump();
      for (const e of t.events) {
        if (e.topic !== 'payout.event' || seenPayoutEvents.has(e)) continue;
        seenPayoutEvents.add(e);
        await payouts.processEvent(e.payload as { rail: string; providerRef: string; reference?: string });
      }
    },
  };
  return p;
}

export { money };
