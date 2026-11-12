// HTTP hardening (P10, docs/10 "secure API + webhook controls"): response
// security headers on every reply and a per-client rate limit.
//
// The limiter is a fixed window over a pluggable store: in-process by default
// (one API instance), Redis when REDIS_URL is set so every instance draws on
// the same budget. A store failure falls back to the in-process window for
// that request (still limited, per instance) and is logged.
import { createHash } from 'node:crypto';
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

/** One fixed-window counter per key. */
export interface RateLimitStore {
  /** Count one hit on `key`; returns hits so far in the current window and ms until it resets. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }>;
}

/** In-process windows (the default). Bounded: the oldest windows are dropped first. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  async hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    return { count: w.count, resetMs: w.start + windowMs - t };
  }
}

/** The slice of an ioredis client the Redis store needs. */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// INCR + PEXPIRE in one atomic script: the first hit of a window sets its
// expiry; a key that somehow lost its TTL gets one again (never immortal).
const HIT_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); t = tonumber(ARGV[1]) end
return {c, t}`;

/** Shared windows in Redis. Keys are hashed, so client addresses are not stored in Redis. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: RedisEvalClient,
    private readonly prefix = 'chema:rl:',
  ) {}

  async hit(key: string, windowMs: number): Promise<{ count: number; resetMs: number }> {
    const k = `${this.prefix}${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
    const out = await this.client.eval(HIT_SCRIPT, 1, k, Math.max(1, Math.trunc(windowMs)));
    if (!Array.isArray(out) || out.length !== 2) throw new Error('unexpected rate-limit script reply');
    return { count: Number(out[0]), resetMs: Number(out[1]) };
  }
}

export interface RateLimitOptions {
  rules: readonly RateLimitRule[];
  now?: () => number;
  /** Bound on tracked keys of the in-process store; the oldest windows are dropped first. */
  maxKeys?: number;
  /** Shared store (Redis). Default: in-process. */
  store?: RateLimitStore;
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
  const local = new MemoryRateLimitStore(opts.now ?? Date.now, opts.maxKeys ?? 100_000);
  const store = opts.store ?? local;

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    for (const rule of opts.rules) {
      if (!rule.match(req)) continue;
      const key = `${rule.name}|${req.ip}`;
      let w: { count: number; resetMs: number };
      try {
        w = await store.hit(key, rule.windowMs);
      } catch (err) {
        req.log.warn({ err, bucket: rule.name }, 'rate-limit store unavailable; using the in-process window');
        w = await local.hit(key, rule.windowMs);
      }
      if (w.count > rule.max) {
        const retry = Math.max(1, Math.trunc((w.resetMs + 999) / 1000)); // whole seconds, rounded up
        req.log.warn({ bucket: rule.name }, 'rate limited');
        return reply.code(429).header('retry-after', String(retry)).send({ error: 'rate_limited' });
      }
    }
  });
}
