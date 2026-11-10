// Integration: runs only when REDIS_URL is set (unit runs skip it).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BullMqJobQueue, createOutboxWorker, redisOptions } from './bullmq';

const url = process.env['REDIS_URL'];

describe.skipIf(!url)('BullMQ outbox adapter (needs REDIS_URL)', () => {
  it('delivers once per jobId even if added twice', async () => {
    const redisUrl = url ?? '';
    const queue = new BullMqJobQueue(redisUrl);
    // Unique topic per run: the shared queue may hold jobs from other runs.
    const topic = `test.bullmq.${randomUUID()}`;
    const jobId = randomUUID();
    const seen: string[] = [];
    let handled: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      handled = resolve;
    });
    const w = createOutboxWorker(redisUrl, {
      [topic]: async (_payload, id) => {
        seen.push(id);
        handled();
      },
    });
    try {
      await queue.add(topic, { n: 1 }, jobId);
      await queue.add(topic, { n: 1 }, jobId);
      await first;
      // Give a (wrong) duplicate delivery time to show up.
      await new Promise((r) => setTimeout(r, 500));
      expect(seen).toEqual([jobId]);
    } finally {
      await w.close();
      await queue.close();
    }
  });
});

describe('redisOptions', () => {
  it('parses host, port, password and db', () => {
    expect(redisOptions('redis://:s3cret@localhost:56379/2')).toMatchObject({
      host: 'localhost',
      port: 56379,
      password: 's3cret',
      db: 2,
      maxRetriesPerRequest: null,
    });
  });
});
