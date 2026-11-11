// Integration: the Redis rate-limit store. Runs only when REDIS_URL is set
// (like the BullMQ test); unit runs cover the store interface with the
// in-process store (security.test.ts).
import { randomUUID } from 'node:crypto';
import { createFastFailRedis } from '@chema/core/bullmq';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { defaultRateLimitRules, RedisRateLimitStore } from './security';

const url = process.env['REDIS_URL'];

describe.skipIf(!url)('Redis rate-limit store (needs REDIS_URL)', () => {
  it('counts atomically across concurrent hits, expires the window, and is shared by two app instances', async () => {
    const client = createFastFailRedis(url ?? '');
    // The request-path client never queues commands, so wait for the connection first.
    await new Promise<void>((resolve, reject) => {
      client.once('ready', () => resolve());
      client.once('error', reject);
    });
    try {
      const store = new RedisRateLimitStore(client, `chema:rl:test:${randomUUID()}:`);
      const results = await Promise.all(Array.from({ length: 20 }, () => store.hit('k', 1_000)));
      expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(results.every((r) => r.resetMs > 0 && r.resetMs <= 1_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 1_100));
      expect((await store.hit('k', 1_000)).count).toBe(1);

      const rules = defaultRateLimitRules({ CHEMA_RATE_AUTH_PER_MIN: '2' });
      const [a, b] = [buildApp({ rateLimit: { rules, store } }), buildApp({ rateLimit: { rules, store } })];
      await Promise.all([a.ready(), b.ready()]);
      const hit = (x: typeof a) => x.inject({ method: 'POST', url: '/auth/otp/start', remoteAddress: '10.2.0.1', payload: {} });
      expect((await hit(a)).statusCode).not.toBe(429);
      expect((await hit(b)).statusCode).not.toBe(429);
      expect((await hit(a)).statusCode).toBe(429);
      await Promise.all([a.close(), b.close()]);
    } finally {
      client.disconnect();
    }
  });
});
