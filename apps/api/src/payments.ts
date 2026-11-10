// Composition of the payments service for the API and the worker. Only mock
// rails exist until a rail is certified (D06); they are registered always and
// collect only when their `rail.*` flag is on. The contribution gate accepts
// only verified, ACTIVE wallets (P04 `verifiedWalletGate`).
import { randomBytes } from 'node:crypto';
import type { CoreServices } from '@chema/core';
import { PaymentService, RailRegistry, type ContributionGate } from '@chema/payments';
import { verifiedWalletGate } from '@chema/wallet';
import { MockCard, MockEcoCash, MockOneMoney } from '@chema/providers';

export interface PaymentsWiring {
  service: PaymentService;
  rails: RailRegistry;
  /** True when the mock webhook secret was generated for this process only. */
  ephemeralWebhookSecret: boolean;
}

export async function buildPayments(
  core: CoreServices,
  opts: { env?: Record<string, string | undefined>; gate?: ContributionGate; clock?: () => Date } = {},
): Promise<PaymentsWiring> {
  const env = opts.env ?? process.env;
  const configured = env['CHEMA_MOCK_WEBHOOK_SECRET'];
  const webhookSecret = configured && configured.length >= 16 ? configured : randomBytes(32).toString('base64');
  const rails = new RailRegistry(core.flags);
  const railOpts = { webhookSecret, ...(opts.clock ? { clock: opts.clock } : {}) };
  for (const adapter of [new MockEcoCash(railOpts), new MockOneMoney(railOpts), new MockCard(railOpts)]) {
    await rails.register(adapter);
  }
  const service = new PaymentService({
    db: core.db,
    bus: core.bus,
    flags: core.flags,
    rails,
    gate: opts.gate ?? verifiedWalletGate,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { service, rails, ephemeralWebhookSecret: webhookSecret !== configured };
}
