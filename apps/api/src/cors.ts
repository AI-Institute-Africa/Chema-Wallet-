// CORS for the web app (apps/web runs on its own origin). Allow-list only:
// an Origin not listed gets no CORS headers, so the browser blocks it. No
// cookies are used (Bearer tokens), so credentials are never allowed.
import type { FastifyInstance } from 'fastify';

const ALLOW_HEADERS = 'authorization, content-type, idempotency-key, x-step-up-token, x-device-id, x-request-id';
const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';

/** "https://a.example, http://localhost:3000" → normalised origins; invalid entries dropped. */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    try {
      const u = new URL(part.trim());
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.origin);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

export function registerCors(app: FastifyInstance, origins: readonly string[]): void {
  if (origins.length === 0) return;
  const allowed = new Set(origins);
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-expose-headers', 'x-request-id');
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', ALLOW_METHODS);
      reply.header('access-control-allow-headers', ALLOW_HEADERS);
      reply.header('access-control-max-age', '600');
      await reply.code(204).send();
    }
  });
}
