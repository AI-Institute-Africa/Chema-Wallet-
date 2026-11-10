// Composition of the Fidelity claim path for the API and the worker. The real
// integration is unconfirmed (D14): production gets RealFidelity, which refuses
// every call; elsewhere MockFidelity stands in. Everything is behind
// `fidelity.claims_link` (off by default).
import { randomBytes } from 'node:crypto';
import type { CoreServices, Secrets } from '@chema/core';
import { ClaimsService, MockFidelity, RealFidelity, deriveRecipientKey, type FidelityAdapter } from '@chema/fidelity';

export interface ClaimsWiring {
  service: ClaimsService;
  adapter: FidelityAdapter;
  mock: boolean;
}

export function buildClaims(
  core: CoreServices,
  secrets: Secrets,
  opts: { env?: Record<string, string | undefined>; adapter?: FidelityAdapter; clock?: () => Date } = {},
): ClaimsWiring {
  const env = opts.env ?? process.env;
  let adapter = opts.adapter;
  if (!adapter) {
    if (env['NODE_ENV'] === 'production') {
      adapter = new RealFidelity();
    } else {
      const configured = env['CHEMA_FIDELITY_WEBHOOK_SECRET'];
      const webhookSecret = configured && configured.length >= 16 ? configured : randomBytes(32).toString('base64');
      adapter = new MockFidelity({ webhookSecret, ...(opts.clock ? { clock: opts.clock } : {}) });
    }
  }
  const service = new ClaimsService({
    db: core.db,
    bus: core.bus,
    flags: core.flags,
    adapter,
    recipientKey: deriveRecipientKey(secrets.dataKey),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  return { service, adapter, mock: adapter instanceof MockFidelity };
}
