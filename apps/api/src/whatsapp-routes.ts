// P08 HTTP surface (docs/09): provider webhooks (raw body, signature +
// replay checked by the provider) and the secure hand-off page's calls.
// Thin: parse, call WhatsAppService. Hand-off tokens travel in the POST body
// (the page reads them from the URL fragment), never in a path or query.
import { ForbiddenError, publicActor, type CoreServices } from '@chema/core';
import type { WhatsAppService } from '@chema/whatsapp';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const Token = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
const Provider = z.enum(['simulator', 'meta']);

export function registerWhatsAppRoutes(app: FastifyInstance, core: CoreServices, wa: WhatsAppService, opts: { metaVerifyToken?: string } = {}): void {
  const body = <T>(schema: z.ZodType<T>, req: FastifyRequest): T => {
    const r = schema.safeParse(req.body);
    if (!r.success) throw Object.assign(new Error('invalid_request'), { statusCode: 400 });
    return r.data;
  };

  void app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, raw, done) => done(null, raw));
    scope.post('/webhooks/whatsapp/:provider', async (req, reply) => {
      const p = Provider.safeParse((req.params as { provider?: string }).provider);
      if (!p.success || typeof req.body !== 'string') return reply.code(400).send({ error: 'invalid_request' });
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      try {
        const r = await wa.receiveWebhook(p.data, headers, req.body);
        return reply.code(200).send({ received: true, stored: r.stored.length, duplicates: r.duplicates });
      } catch (err) {
        // Forged / stale: nothing stored.
        if (err instanceof ForbiddenError) return reply.code(401).send({ error: 'webhook_rejected' });
        throw err;
      }
    });
  });

  // Meta subscription handshake (D16): only answers when a verify token is configured.
  app.get('/webhooks/whatsapp/meta', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (!opts.metaVerifyToken || q['hub.mode'] !== 'subscribe' || q['hub.verify_token'] !== opts.metaVerifyToken) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return reply.type('text/plain').send(q['hub.challenge'] ?? '');
  });

  app.post('/handoff/describe', async (req) => wa.describe(body(z.object({ token: Token }), req).token));

  app.post('/handoff/otp', async (req, reply) => {
    const { token } = body(z.object({ token: Token }), req);
    return reply.code(202).send(await wa.startOtp(token));
  });

  app.post('/handoff/confirm', async (req) => {
    const b = body(z.object({ token: Token, challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) }), req);
    return wa.confirm(b.token, b.challengeId, b.code, { ip: req.ip });
  });

  app.post('/handoff/open', async (req) => {
    const { token } = body(z.object({ token: Token }), req);
    const h = req.headers.authorization;
    const session = h?.startsWith('Bearer ') ? await core.auth.authenticate(h.slice(7).trim()) : null;
    return wa.open(token, session ?? publicActor({ channel: 'WEB', ip: req.ip }));
  });
}
