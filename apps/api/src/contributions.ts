// Composition of contributions + notifications for the API and the worker.
// Notification senders are MOCKS until a channel provider is chosen (D16):
// they log that a message went out (ids only, never the text or address).
import { MockSender, NotificationService, type ChannelSender } from '@chema/channels';
import type { CoreServices, Secrets } from '@chema/core';
import { ContributionService } from '@chema/contributions';
import type { PaymentService } from '@chema/payments';

export interface ContributionsWiring {
  service: ContributionService;
  notifications: NotificationService;
}

export function buildContributions(
  core: CoreServices,
  payments: PaymentService,
  opts: { secrets: Secrets; publicBaseUrl: string; senders?: readonly ChannelSender[]; clock?: () => Date },
): ContributionsWiring {
  const clock = opts.clock ? { clock: opts.clock } : {};
  const service = new ContributionService({
    db: core.db,
    bus: core.bus,
    flags: core.flags,
    payments,
    secrets: opts.secrets,
    publicBaseUrl: opts.publicBaseUrl,
    ...clock,
  });
  const notifications = new NotificationService({
    db: core.db,
    bus: core.bus,
    key: opts.secrets.dataKey,
    senders: opts.senders ?? [new MockSender('SMS'), new MockSender('EMAIL')],
    ...clock,
  });
  return { service, notifications };
}
