// HTTP hardening (P10, docs/10 "secure API + webhook controls"): response
// security headers on every reply and a per-client rate limit.
//
// The limiter is an in-process fixed window. One API instance is the MVP
// deployment; several instances would each allow the full budget, so a
// shared store (Redis) is needed before scaling out (PROGRESS.md, Assumptions).
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** JSON API: nothing is rendered, framed, sniffed or cached by intermediaries. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    // Anything tied to a session or token is private to that caller.
    if (req.headers.authorization || req.headers['x-contribution-token'] || req.url.startsWith('/handoff')) {
      reply.header('cache-control', 'no-store');
    }
  });
}

export interface RateLimitRule {
  /** Bucket name (shows up in logs). */
  name: string;
  /** Requests allowed per window per client. */
  max: number;
  windowMs: number;
  match(req: FastifyRequest): boolean;
}

export interface RateLimitOptions {
  rules: readonly RateLimitRule[];
  now?: () => number;
  /** Bound on tracked keys; the oldest windows are dropped first. */
  maxKeys?: number;
}

const POST = (req: FastifyRequest) => req.method === 'POST';
const path = (req: FastifyRequest) => req.url.split('?')[0] ?? '';

/**
 * Defaults sized well above a person's use and well below scripted abuse.
 * Provider webhooks are exempt: they are signed + replay-protected, and
 * throttling a provider retry would delay a confirmed credit.
 */
export function defaultRateLimitRules(env: NodeJS.ProcessEnv = process.env): RateLimitRule[] {
  const n = (name: string, d: number) => {
    const v = Number.parseInt(env[name] ?? '', 10);
    return Number.isSafeInteger(v) && v > 0 ? v : d;
  };
  const minute = 60_000;
  return [
    {
      name: 'auth',
      max: n('CHEMA_RATE_AUTH_PER_MIN', 20),
      windowMs: minute,
      match: (req) => POST(req) && /^\/(auth|staff|handoff)\//.test(path(req)),
    },
    {
      name: 'contribute',
      max: n('CHEMA_RATE_CONTRIBUTE_PER_MIN', 30),
      windowMs: minute,
      match: (req) => POST(req) && /^\/public\//.test(path(req)),
    },
    {
      name: 'global',
      max: n('CHEMA_RATE_GLOBAL_PER_MIN', 600),
      windowMs: minute,
      match: (req) => !/^\/(webhooks|health|fidelity\/webhooks)(\/|$)/.test(path(req)),
    },
  ];
}

export function registerRateLimit(app: FastifyInstance, opts: RateLimitOptions): void {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 100_000;
  const windows = new Map<string, { start: number; count: number }>();

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    const t = now();
    for (const rule of opts.rules) {
      if (!rule.match(req)) continue;
      const key = `${rule.name}|${req.ip}`;
      let w = windows.get(key);
      if (!w || t - w.start >= rule.windowMs) {
        windows.delete(key);
        if (windows.size >= maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > rule.max) {
        const retry = Math.max(1, Math.trunc((w.start + rule.windowMs - t + 999) / 1000)); // whole seconds, rounded up
        req.log.warn({ bucket: rule.name }, 'rate limited');
        return reply.code(429).header('retry-after', String(retry)).send({ error: 'rate_limited' });
      }
    }
  });
}
