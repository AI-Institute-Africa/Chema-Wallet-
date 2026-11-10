// P01 HTTP surface: auth, step-up, consent, documents. Routes are thin: parse
// input, resolve the session, call core services. No business logic here.
import {
  AuthenticationError,
  CONSENT_PURPOSES,
  ConflictError,
  DOCUMENT_CLASSES,
  DOCUMENT_LIMITS,
  ForbiddenError,
  grantConsent,
  isAction,
  listConsents,
  NotFoundError,
  RateLimitedError,
  ValidationError,
  withdrawConsent,
  type Action,
  type Actor,
  type CoreServices,
} from '@chema/core';
import { InsufficientFundsError, LedgerError } from '@chema/ledger';
import { WebhookRejectedError } from '@chema/providers';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

const Uuid = z.uuid();
const SAFE_DEVICE = /^[A-Za-z0-9._:-]{1,64}$/;

function deviceOf(req: FastifyRequest): string | undefined {
  const h = req.headers['x-device-id'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && SAFE_DEVICE.test(v) ? v : undefined;
}

function meta(req: FastifyRequest) {
  const device = deviceOf(req);
  return { ip: req.ip, ...(device ? { device } : {}) };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError('invalid request');
  return r.data;
}

const StepUpTargetBody = z.object({
  action: z.string().refine((a): a is Action => isAction(a)),
  subjectType: z.string().min(1).max(64),
  subjectId: z.string().min(1).max(128),
});

export function registerRoutes(app: FastifyInstance, core: CoreServices): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ValidationError) return reply.code(400).send({ error: 'invalid_request' });
    if (err instanceof AuthenticationError) return reply.code(401).send({ error: 'authentication_failed' });
    if (err instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
    if (err instanceof NotFoundError) return reply.code(404).send({ error: 'not_found' });
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.reason.toLowerCase() });
    if (err instanceof RateLimitedError) return reply.code(429).send({ error: 'rate_limited' });
    // Forged / stale provider callback: nothing was stored.
    if (err instanceof WebhookRejectedError) return reply.code(401).send({ error: 'webhook_rejected' });
    if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: 'insufficient_funds' });
    if (err instanceof LedgerError) return reply.code(409).send({ error: 'ledger_rejected' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'invalid_request' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal' });
  });

  /** Resolve Bearer session; 401 if absent/invalid. */
  async function requireActor(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
    const actor = token ? await core.auth.authenticate(token) : null;
    if (!actor) {
      await reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    req.actor = actor;
  }
  const actorOf = (req: FastifyRequest): Actor => {
    if (!req.actor) throw new AuthenticationError('NO_SESSION');
    return req.actor;
  };
  const stepUpHeader = (req: FastifyRequest): string | undefined => {
    const v = req.headers['x-step-up-token'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  // ── Customer auth ────────────────────────────────────────────────────────
  app.post('/auth/otp/start', async (req, reply) => {
    const body = parse(z.object({ phone: z.string().max(20), channel: z.enum(['WEB', 'WHATSAPP']).default('WEB') }), req.body);
    const out = await core.auth.startLogin(body);
    return reply.code(202).send(out);
  });

  app.post('/auth/otp/verify', async (req) => {
    const body = parse(z.object({ challengeId: z.string().max(64), code: z.string().max(12) }), req.body);
    const s = await core.auth.verifyLogin({ ...body, ...meta(req) });
    return { token: s.token, expiresAt: s.expiresAt.toISOString() };
  });

  app.post('/auth/logout', { preHandler: requireActor }, async (req, reply) => {
    await core.auth.logout(actorOf(req));
    return reply.code(204).send();
  });

  app.post('/auth/step-up/start', { preHandler: requireActor }, async (req, reply) => {
    const target = parse(StepUpTargetBody, req.body);
    return reply.code(202).send(await core.auth.startStepUp(actorOf(req), target));
  });

  app.post('/auth/step-up/verify', { preHandler: requireActor }, async (req) => {
    const body = parse(z.object({ challengeId: z.string().max(64), code: z.string().max(12) }), req.body);
    const g = await core.auth.verifyStepUp(actorOf(req), body.challengeId, body.code);
    return { stepUpToken: g.stepUpToken, expiresAt: g.expiresAt.toISOString() };
  });

  // ── Staff auth (password + TOTP, one step) ─────────────────────────────────
  app.post('/staff/auth/login', async (req) => {
    const body = parse(
      z.object({ login: z.string().min(3).max(64), password: z.string().min(1).max(256), totp: z.string().max(12) }),
      req.body,
    );
    const s = await core.staffAuth.login({ ...body, ...meta(req) });
    return { token: s.token, expiresAt: s.expiresAt.toISOString() };
  });

  app.post('/staff/auth/step-up', { preHandler: requireActor }, async (req) => {
    const body = parse(StepUpTargetBody.extend({ totp: z.string().max(12) }), req.body);
    const g = await core.staffAuth.stepUp(actorOf(req), body.totp, body);
    return { stepUpToken: g.stepUpToken, expiresAt: g.expiresAt.toISOString() };
  });

  // ── Consent (own) ─────────────────────────────────────────────────────────
  app.get('/me/consents', { preHandler: requireActor }, async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ purpose: z.enum(CONSENT_PURPOSES).optional() }), req.query);
    const list = await core.bus.execute(
      listConsents,
      { subjectPersonId: actor.personId, ...(q.purpose ? { purpose: q.purpose } : {}) },
      { actor },
    );
    return { consents: list };
  });

  app.post('/me/consents', { preHandler: requireActor }, async (req, reply) => {
    const actor = actorOf(req);
    const body = parse(z.object({ purpose: z.enum(CONSENT_PURPOSES), walletId: Uuid.optional() }), req.body);
    const c = await core.bus.execute(
      grantConsent,
      { subjectPersonId: actor.personId, purpose: body.purpose, ...(body.walletId ? { walletId: body.walletId } : {}) },
      { actor },
    );
    return reply.code(201).send(c);
  });

  app.delete('/me/consents/:id', { preHandler: requireActor }, async (req) => {
    const { id } = parse(z.object({ id: z.string().max(64) }), req.params);
    return core.bus.execute(withdrawConsent, { consentId: id }, { actor: actorOf(req) });
  });

  // ── Documents ─────────────────────────────────────────────────────────────
  // base64 inflates 4/3 (integer maths; float rounding is banned repo-wide) + JSON envelope slack.
  const maxBody = Number((BigInt(DOCUMENT_LIMITS.maxBytes) * 4n + 2n) / 3n) + 64 * 1024;

  app.post('/documents', { preHandler: requireActor, bodyLimit: maxBody }, async (req, reply) => {
    const body = parse(
      z.object({
        class: z.enum(DOCUMENT_CLASSES),
        contentType: z.string().max(100),
        dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
        walletId: Uuid.optional(),
      }),
      req.body,
    );
    const meta = await core.bus.execute(
      core.documents.upload,
      {
        class: body.class,
        contentType: body.contentType,
        data: Buffer.from(body.dataBase64, 'base64'),
        ...(body.walletId ? { walletId: body.walletId } : {}),
      },
      { actor: actorOf(req), ...(stepUpHeader(req) ? { stepUpToken: stepUpHeader(req) as string } : {}) },
    );
    return reply.code(201).send(meta);
  });

  app.get('/documents/:id', { preHandler: requireActor }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().max(64) }), req.params);
    const doc = await core.bus.execute(core.documents.read, { documentId: id }, { actor: actorOf(req) });
    return reply.type(doc.contentType).header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(doc.data);
  });
}
