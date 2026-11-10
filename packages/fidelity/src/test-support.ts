// Test-only harness for the claim path: contributions harness (real
// verification, mock rails, contributions) + MockFidelity + ClaimsService.
// Never import at runtime.
import { grantConsent, type FlagKey } from '@chema/core';
import { createContributionHarness, type ContributionHarness } from '@chema/contributions/testing';
import { money, type SqlClient } from '@chema/shared';
import { randomUUID } from 'node:crypto';
import { MockFidelity, type MockScenario } from './mock';
import { ClaimsService } from './service';
import { deriveRecipientKey } from './store';

export const FIDELITY_WEBHOOK_SECRET = 'test-fidelity-webhook-secret';

type Person = Awaited<ReturnType<ContributionHarness['h']['customer']>>;

export interface ClaimCase {
  walletId: string;
  slug: string;
  admin: Person;
  deceasedName: string;
  /** National ID of the beneficiary the family proposes (admin by default in tests only). */
  recipientId: string;
  policyNo: string;
}

export interface FidelityHarness extends ContributionHarness {
  fidelity: MockFidelity;
  claims: ClaimsService;
  /** Deliver every signed Fidelity callback: webhook → event → SYNC. */
  deliverFidelity(): Promise<void>;
  /** Wallet admin consents to sharing the wallet's details with Fidelity. */
  consent(admin: Person, walletId: string): Promise<void>;
  /** ACTIVE wallet + consent + a seeded policy for `scenario`, looked up (not yet linked). */
  claimCase(scenario: MockScenario): Promise<ClaimCase & { lookup: Awaited<ReturnType<ClaimsService['lookupPolicy']>> }>;
  /** claimCase + link (the admin nominates themself with `recipientId`). Returns the claim ref. */
  linkedCase(scenario?: MockScenario): Promise<ClaimCase & { claimRef: string }>;
  /** Community contribution paid end to end; returns nothing. */
  contributePaid(slug: string, minor?: bigint): Promise<void>;
}

export async function createFidelityHarness(
  flags: Partial<Record<FlagKey, string>> = {},
  opts: { db?: SqlClient } = {},
): Promise<FidelityHarness> {
  const t = await createContributionHarness({ 'fidelity.claims_link': 'true', ...flags }, opts);
  const { h } = t;
  const fidelity = new MockFidelity({ webhookSecret: FIDELITY_WEBHOOK_SECRET, clock: h.now });
  const claims = new ClaimsService({
    db: h.db,
    bus: h.bus,
    flags: h.flags,
    adapter: fidelity,
    recipientKey: deriveRecipientKey(Buffer.alloc(32, 7)),
    clock: h.now,
  });

  const f: FidelityHarness = {
    ...t,
    fidelity,
    claims,
    async deliverFidelity() {
      for (const cb of fidelity.takeWebhooks()) {
        const r = await claims.receiveWebhook(cb.headers, cb.body);
        if (!r.duplicate) await claims.processEvent(r.eventRowId);
      }
    },
    async consent(admin, walletId) {
      await h.bus.execute(grantConsent, { subjectPersonId: admin.personId, purpose: 'DISCLOSURE', walletId }, { actor: admin.actor });
    },
    async claimCase(scenario) {
      const { walletId, slug, admin } = await t.publicWallet();
      const { rows } = await h.db.query<{ deceased_name: string }>('SELECT deceased_name FROM wallet WHERE id = $1', [walletId]);
      const deceasedName = rows[0]?.deceased_name ?? '';
      const policyNo = fidelity.seed(scenario, { name: deceasedName });
      await f.consent(admin, walletId);
      const lookup = await claims.lookupPolicy(admin.actor, walletId, { policyNo });
      return { walletId, slug, admin, deceasedName, policyNo, recipientId: `63-${randomUUID().slice(0, 6)}X42`, lookup };
    },
    async linkedCase(scenario = 'APPROVED') {
      const c = await f.claimCase(scenario);
      await claims.linkClaim(c.admin.actor, { walletId: c.walletId, recipientPersonId: c.admin.personId, recipientIdNumber: c.recipientId });
      const { rows } = await h.db.query<{ claim_ref: string }>('SELECT claim_ref FROM fidelity_link WHERE wallet_id = $1', [c.walletId]);
      return { ...c, claimRef: rows[0]?.claim_ref ?? '' };
    },
    async contributePaid(slug, minor = 10_00n) {
      const r = await t.contributions.contribute(t.guest(), t.input(slug, { amount: money(minor, 'USD') }));
      const { rows } = await h.db.query<{ provider_ref: string }>('SELECT provider_ref FROM payment WHERE id = $1', [r.payment.id]);
      t.ecocash.succeed(rows[0]?.provider_ref ?? '');
      await t.deliver(t.ecocash);
      await t.pump();
    },
  };
  return f;
}
