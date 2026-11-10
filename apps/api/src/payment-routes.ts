// P03 HTTP surface: rails, payments, receipts, provider webhooks, refunds,
// reconciliation. Thin: parse, resolve the session, call PaymentService.
import { AuthenticationError, type Actor, type CoreServices } from '@chema/core';
import type { PaymentService } from '@chema/payments';
import { CURRENCIES, money } from '@chema/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const Uuid = z.uuid();
const Rail = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/);
const MoneyBody = z.object({ minor: z.string().regex(/^[1-9][0-9]{0,15}$/), ccy: z.enum(CURRENCIES) });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/;

/** Money and other bigints leave the API as strings (docs: `{minor: "string", ccy}`). */
function json<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void reply.code(400).send({ error: 'invalid_request' });
    return undefined;
  }
  return r.data;
}

export function registerPaymentRoutes(app: FastifyInstance, core: CoreServices, payments: PaymentService): void {
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

  // Disabled rails are simply not listed (docs/04 §5).
  app.get('/payments/rails', async () => ({ rails: await payments.listRails() }));

  app.post('/payments', { preHandler: requireActor }, async (req, reply) => {
    const keyHeader = req.headers['idempotency-key'];
    const idempotencyKey = typeof keyHeader === 'string' ? keyHeader : '';
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return reply.code(400).send({ error: 'idempotency_key_required' });
    const body = parse(
      z.object({ walletId: Uuid, rail: Rail, amount: MoneyBody, payerMsisdn: z.string().regex(/^\+[1-9][0-9]{6,14}$/).optional() }),
      req.body,
      reply,
    );
    if (!body) return reply;
    const view = await payments.initiate(actorOf(req), {
      walletId: body.walletId,
      rail: body.rail,
      amount: money(BigInt(body.amount.minor), body.amount.ccy),
      idempotencyKey,
      ...(body.payerMsisdn ? { payerMsisdn: body.payerMsisdn } : {}),
    });
    return reply.code(view.replayed ? 200 : 201).send(json(view));
  });

  app.get('/payments/:id', { preHandler: requireActor }, async (req, reply) => {
    const p = parse(z.object({ id: z.string().max(64) }), req.params, reply);
    if (!p) return reply;
    return json(await payments.view(actorOf(req), p.id));
  });

  app.get('/receipts/:id', { preHandler: requireActor }, async (req, reply) => {
    const p = parse(z.object({ id: z.string().max(64) }), req.params, reply);
    if (!p) return reply;
    return reply.header('cache-control', 'no-store').send(json(await payments.receipt(actorOf(req), p.id)));
  });

  app.post('/payments/:id/refunds', { preHandler: requireActor }, async (req, reply) => {
    const p = parse(z.object({ id: z.string().max(64) }), req.params, reply);
    const body = p && parse(z.object({ amount: MoneyBody, reason: z.string().min(3).max(500), approvalId: Uuid.optional() }), req.body, reply);
    if (!p || !body) return reply;
    const out = await payments.requestRefund(actorOf(req), {
      paymentId: p.id,
      amount: money(BigInt(body.amount.minor), body.amount.ccy),
      reason: body.reason,
      ...(body.approvalId ? { approvalId: body.approvalId } : {}),
    });
    return reply.code(202).send(json(out));
  });

  app.post('/recon/runs', { preHandler: requireActor }, async (req, reply) => {
    const body = parse(z.object({ rail: Rail, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body, reply);
    if (!body) return reply;
    return reply.code(201).send(json(await payments.runRecon(actorOf(req), body.rail, body.date)));
  });

  app.get('/recon/exceptions', { preHandler: requireActor }, async (req) => ({
    exceptions: json(await payments.listExceptions(actorOf(req))),
  }));

  // Provider callbacks need the exact bytes for the signature: raw-string JSON parser, this scope only.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/:rail', async (req, reply) => {
      const p = parse(z.object({ rail: Rail }), req.params, reply);
      if (!p) return reply;
      if (typeof req.body !== 'string') return reply.code(400).send({ error: 'invalid_request' });
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const r = await payments.receiveWebhook(p.rail, headers, req.body);
      return reply.code(r.duplicate ? 200 : 202).send({ received: true });
    });
  });
}
