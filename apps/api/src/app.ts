import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createLogger, type SqlClient } from '@chema/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

export interface AppOptions {
  db?: SqlClient;
  logger?: FastifyBaseLogger;
  version?: string;
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

  return app;
}
