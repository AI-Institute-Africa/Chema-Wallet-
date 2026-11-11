import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { CoreServices } from '@chema/core';
import type { ContributionService } from '@chema/contributions';
import type { ClaimsService } from '@chema/fidelity';
import type { PaymentService } from '@chema/payments';
import type { PayoutService } from '@chema/payouts';
import type { WhatsAppService } from '@chema/whatsapp';
import { createLogger, type SqlClient } from '@chema/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerContributionRoutes } from './contribution-routes';
import { registerCors } from './cors';
import { registerFidelityRoutes } from './fidelity-routes';
import { registerPaymentRoutes } from './payment-routes';
import { registerPayoutRoutes } from './payout-routes';
import { registerRoutes } from './routes';
import { registerWalletRoutes, type WalletWiring } from './wallet-routes';
import { registerWhatsAppRoutes } from './whatsapp-routes';

export interface AppOptions {
  db?: SqlClient;
  logger?: FastifyBaseLogger;
  version?: string;
  /** Core services; without them only health routes are served. */
  core?: CoreServices;
  /** Payments (P03); needs core. */
  payments?: PaymentService;
  /** Wallet lifecycle + verification (P04); needs core. */
  wallets?: WalletWiring;
  /** Public page + contributions (P05); needs core + payments. */
  contributions?: ContributionService;
  /** Fidelity claim path (P06); needs core. Claim routes 404 while `fidelity.claims_link` is off. */
  claims?: ClaimsService;
  /** Payouts, governance, closure (P07); needs core. */
  payouts?: PayoutService;
  /** WhatsApp channel + secure hand-off (P08); needs core. */
  whatsapp?: WhatsAppService;
  /** Meta webhook subscription verify token (D16). Unset ⇒ the handshake is refused. */
  metaVerifyToken?: string;
  /** Browser origins allowed to call the API (the web app). Empty ⇒ no CORS headers. */
  corsOrigins?: readonly string[];
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Honour a caller's x-request-id only if it is short and inert; otherwise mint one. */
export function requestIdFor(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && SAFE_REQUEST_ID.test(value) ? value : randomUUID();
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    loggerInstance: opts.logger ?? (createLogger(process.env['LOG_LEVEL'] ?? 'info') as FastifyBaseLogger),
    genReqId: requestIdFor,
  });

  registerCors(app, opts.corsOrigins ?? []);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Liveness: process is up. No dependencies.
  app.get('/health', async () => ({ ok: true, service: 'chema-api', version: opts.version ?? '0.0.0' }));

  // Readiness: dependencies reachable. 503 if not.
  app.get('/health/ready', async (req, reply) => {
    if (!opts.db) return reply.code(503).send({ ok: false, db: 'not_configured' });
    try {
      await opts.db.query('SELECT 1');
      return { ok: true, db: 'up' };
    } catch (err) {
      req.log.warn({ err }, 'readiness db check failed');
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });

  if (opts.core) {
    registerRoutes(app, opts.core);
    if (opts.payments) registerPaymentRoutes(app, opts.core, opts.payments);
    const contributions = opts.payments ? opts.contributions : undefined;
    if (opts.wallets) {
      registerWalletRoutes(app, opts.core, contributions ? { ...opts.wallets, publicPage: (slug) => contributions.page(slug) } : opts.wallets);
    }
    if (contributions) registerContributionRoutes(app, opts.core, contributions);
    if (opts.claims) registerFidelityRoutes(app, opts.core, opts.claims);
    if (opts.payouts) registerPayoutRoutes(app, opts.core, opts.payouts);
    if (opts.whatsapp) registerWhatsAppRoutes(app, opts.core, opts.whatsapp, opts.metaVerifyToken ? { metaVerifyToken: opts.metaVerifyToken } : {});
  }

  return app;
}
