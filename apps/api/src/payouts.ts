// Composition of the P07 payouts service for the API and the worker. Payouts
// go over the same (mock) rails as collections; `payouts.enabled` and the rail
// flags are off by default, so nothing leaves a wallet until both are on.
import type { CoreServices, Secrets } from '@chema/core';
import type { RailRegistry } from '@chema/payments';
import { PayoutService, payoutKeys } from '@chema/payouts';

export function buildPayouts(core: CoreServices, rails: RailRegistry, secrets: Secrets, opts: { clock?: () => Date } = {}): PayoutService {
  return new PayoutService({
    db: core.db,
    bus: core.bus,
    flags: core.flags,
    rails,
    keys: payoutKeys(secrets),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
}
