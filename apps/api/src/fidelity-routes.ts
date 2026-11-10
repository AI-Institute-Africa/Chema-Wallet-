// P06 HTTP surface: Fidelity policy lookup, claim link, evidence, claim view,
// the family funds view, beneficiary-mismatch unblock (staff), benefit recon
// and the signed Fidelity callback. Thin: parse, resolve the session, call
// ClaimsService. With `fidelity.claims_link` off every claim route is 404.
import { AuthenticationError, type Actor, type CoreServices } from '@chema/core';
import type { ClaimsService } from '@chema/fidelity';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const Uuid = z.uuid();
const Ident = z.string().min(1).max(64);

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

export function registerFidelityRoutes(app: FastifyInstance, core: CoreServices, claims: ClaimsService): void {
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
  const walletId = (req: FastifyRequest, reply: FastifyReply) => parse(z.object({ id: Uuid }), req.params, reply)?.id;

  app.post('/wallets/:id/claim/lookup', { preHandler: requireActor }, async (req, reply) => {
    const id = walletId(req, reply);
    const b = parse(z.object({ policyNo: Ident.optional(), nationalId: Ident.optional() }).strict(), req.body ?? {}, reply);
    if (!id || !b) return reply;
    const ident = { ...(b.policyNo ? { policyNo: b.policyNo } : {}), ...(b.nationalId ? { nationalId: b.nationalId } : {}) };
    return json(await claims.lookupPolicy(actorOf(req), id, ident));
  });

  app.post('/wallets/:id/claim', { preHandler: requireActor }, async (req, reply) => {
    const id = walletId(req, reply);
    const b = parse(z.object({ recipientPersonId: Uuid, recipientIdNumber: z.string().min(4).max(40) }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return reply.code(202).send(json(await claims.linkClaim(actorOf(req), { walletId: id, ...b })));
  });

  app.post('/wallets/:id/claim/evidence', { preHandler: requireActor }, async (req, reply) => {
    const id = walletId(req, reply);
    const b = parse(z.object({ documentIds: z.array(Uuid).min(1).max(20) }).strict(), req.body, reply);
    if (!id || !b) return reply;
    return reply.code(202).send(await claims.submitEvidence(actorOf(req), id, b.documentIds));
  });

  app.get('/wallets/:id/claim', { preHandler: requireActor }, async (req, reply) => {
    const id = walletId(req, reply);
    if (!id) return reply;
    return json(await claims.view(actorOf(req), id));
  });

  // Family "one wallet" view: source-labelled community / group / Fidelity benefit lines.
  app.get('/wallets/:id/funds', { preHandler: requireActor }, async (req, reply) => {
    const id = walletId(req, reply);
    if (!id) return reply;
    return json(await claims.funds(actorOf(req), id));
  });

  app.post('/wallets/:id/claim/route/unblock', { preHandler: requireActor }, async (req, reply) => {
    const id = walletId(req, reply);
    const b = parse(
      z.object({ externalApprovalRef: z.string().min(3).max(128), documentId: Uuid, recipientPersonId: Uuid, approvalId: Uuid.optional() }).strict(),
      req.body,
      reply,
    );
    if (!id || !b) return reply;
    const { approvalId, ...rest } = b;
    return json(await claims.unblockRoute(actorOf(req), { walletId: id, ...rest, ...(approvalId ? { approvalId } : {}) }));
  });

  app.post('/recon/fidelity', { preHandler: requireActor }, async (req, reply) => {
    const b = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body, reply);
    if (!b) return reply;
    return reply.code(201).send(await claims.runRecon(actorOf(req), b.date));
  });

  // Fidelity callbacks need the exact bytes for the signature.
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/fidelity/webhooks', async (req, reply) => {
      if (typeof req.body !== 'string') return reply.code(400).send({ error: 'invalid_request' });
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      const r = await claims.receiveWebhook(headers, req.body);
      return reply.code(r.duplicate ? 200 : 202).send({ received: true });
    });
  });
}
