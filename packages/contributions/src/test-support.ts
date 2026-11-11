// Test-only harness for contributions: wallet harness (real verification) +
// payments on mock rails + the verified-wallet gate + contribution and
// notification services. `pump()` plays the worker: relays the outbox and runs
// the same handlers the worker runs. Never import at runtime.
import { randomUUID } from 'node:crypto';
import { InMemoryJobQueue, OutboxRelay, ephemeralSecrets, publicActor, type Actor, type FlagKey, type Secrets } from '@chema/core';
import { MockSender, NotificationService } from '@chema/channels';
import { PaymentService, RailRegistry } from '@chema/payments';
import { MockCard, MockEcoCash, MockOneMoney, type MockRail } from '@chema/providers';
import { money, type SqlClient } from '@chema/shared';
import { verifiedWalletGate } from '@chema/wallet';
import { PUBLIC_BASE, createWalletHarness, type WalletHarness } from '@chema/wallet/testing';
import { ContributionService } from './service';
import type { ContributeInput } from './types';

export { PUBLIC_BASE };
export const WEBHOOK_SECRET = 'test-webhook-secret-p05';

export interface ContributionHarness extends WalletHarness {
  /** Platform secrets of this harness (notifications are sealed with secrets.dataKey). */
  secrets: Secrets;
  payments: PaymentService;
  contributions: ContributionService;
  notifications: NotificationService;
  sms: MockSender;
  email: MockSender;
  ecocash: MockRail;
  card: MockRail;
  /** Topic → payloads handled by pump() (events the worker only logs). */
  events: { topic: string; payload: Record<string, unknown> }[];
  guest(): Actor;
  input(slug: string, over?: Partial<ContributeInput>): ContributeInput;
  /** Deliver every due callback of a rail (webhook + worker). */
  deliver(rail: MockRail): Promise<void>;
  /** Relay the outbox and run the worker handlers until nothing is left. */
  pump(): Promise<void>;
  /** ACTIVE wallet with all privacy toggles on unless overridden. */
  publicWallet(privacy?: Record<string, boolean>, target?: bigint): Promise<{ walletId: string; slug: string; admin: Awaited<ReturnType<WalletHarness['h']['customer']>> }>;
}

const DEFAULT_FLAGS: Partial<Record<FlagKey, string>> = {
  'contributions.enabled': 'true',
  'rail.ecocash': 'true',
  'rail.card': 'true',
  'contribution.max_minor.usd': '100000',
  'contribution.max_minor.zwg': '10000000',
};

export async function createContributionHarness(
  flags: Partial<Record<FlagKey, string>> = {},
  opts: { db?: SqlClient } = {},
): Promise<ContributionHarness> {
  const w = await createWalletHarness({ ...DEFAULT_FLAGS, ...flags }, opts);
  const { h } = w;
  const rails = new RailRegistry(h.flags);
  const railOpts = { webhookSecret: WEBHOOK_SECRET, clock: h.now };
  const ecocash = new MockEcoCash(railOpts);
  const card = new MockCard(railOpts);
  for (const r of [ecocash, new MockOneMoney(railOpts), card]) await rails.register(r);
  const payments = new PaymentService({ db: h.db, bus: h.bus, flags: h.flags, rails, gate: verifiedWalletGate, clock: h.now });
  const secrets = ephemeralSecrets();
  const contributions = new ContributionService({ db: h.db, bus: h.bus, flags: h.flags, payments, secrets, publicBaseUrl: PUBLIC_BASE, clock: h.now });
  const sms = new MockSender('SMS');
  const email = new MockSender('EMAIL');
  const notifications = new NotificationService({ db: h.db, bus: h.bus, key: secrets.dataKey, senders: [sms, email], clock: h.now });
  const queue = new InMemoryJobQueue();
  const relay = new OutboxRelay(h.db, queue);
  const done = new Set<string>();
  const events: ContributionHarness['events'] = [];

  const t: ContributionHarness = {
    ...w,
    secrets,
    payments,
    contributions,
    notifications,
    sms,
    email,
    ecocash,
    card,
    events,
    guest: () => publicActor({ ip: '198.51.100.7' }),
    input: (slug, over = {}) => ({
      slug,
      rail: 'ECOCASH',
      amount: money(10_00n, 'USD'),
      idempotencyKey: `idem-${randomUUID()}`,
      payerName: 'Tinotenda Chikwanha',
      payerPhone: '+263772000111',
      anonymous: false,
      displayName: 'Tino',
      tribute: 'May she rest in peace.',
      contact: { kind: 'PHONE', value: '+263772000111' },
      ...over,
    }),
    async deliver(rail) {
      for (const hook of rail.takeWebhooks(h.now())) {
        const r = await payments.receiveWebhook(rail.rail, hook.headers, hook.body);
        await payments.processEvent(r.eventRowId);
      }
    },
    async pump() {
      for (let round = 0; round < 10; round++) {
        await relay.runOnce();
        const pending = [...queue.jobs.entries()].filter(([id]) => !done.has(id));
        if (pending.length === 0) return;
        for (const [id, job] of pending) {
          done.add(id);
          const payload = job.payload as Record<string, unknown>;
          switch (job.topic) {
            case 'payment.succeeded':
            case 'payment.failed':
              await contributions.settle(String(payload['paymentId']));
              break;
            case 'notification.send':
              await notifications.deliver(String(payload['notificationId']));
              break;
            default:
              events.push({ topic: job.topic, payload });
          }
        }
      }
    },
    async publicWallet(privacy, target) {
      const admin = await h.customer();
      const { walletId, slug } = await w.activeWallet(admin);
      if (target !== undefined) await h.db.query('UPDATE wallet SET target_minor = $2 WHERE id = $1', [walletId, target.toString()]);
      const all = { showTotal: true, showUsageSummary: true, showPhoto: true, showContributorNames: true, showAmounts: true, showTributes: true };
      await h.bus.execute(contributions.commands.updatePrivacy, { walletId, settings: { ...all, ...(privacy ?? {}) } }, { actor: admin.actor });
      return { walletId, slug, admin };
    },
  };
  return t;
}
