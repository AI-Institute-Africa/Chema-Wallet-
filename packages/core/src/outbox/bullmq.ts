// BullMQ adapter for the outbox. One queue; job name = outbox topic.
// BullMQ 6 treats ioredis as an optional peer and, under native ESM, needs an
// already-constructed client — so this module owns the ioredis clients and
// closes them itself (BullMQ never closes a client it was handed).
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { JobQueue } from './outbox';

export const OUTBOX_QUEUE = 'chema-outbox';

export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
}

export function redisOptions(url: string): RedisConnection {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    // Required by BullMQ workers (blocking commands must not be abandoned).
    maxRetriesPerRequest: null,
  };
}

export function createRedis(url: string): Redis {
  return new Redis(redisOptions(url));
}

/**
 * A client for request-path use (e.g. the API rate limiter): fails fast while
 * Redis is down instead of queueing commands, so a request never hangs on it.
 */
export function createFastFailRedis(url: string): Redis {
  return new Redis({ ...redisOptions(url), maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000, commandTimeout: 500 });
}

export class BullMqJobQueue implements JobQueue {
  readonly queue: Queue;
  private readonly client: Redis;

  constructor(redisUrl: string) {
    this.client = createRedis(redisUrl);
    this.queue = new Queue(OUTBOX_QUEUE, { connection: this.client });
  }

  async add(topic: string, payload: unknown, jobId: string): Promise<void> {
    await this.queue.add(topic, payload, {
      jobId,
      attempts: 8,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: 1_000,
      removeOnFail: false,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.client.quit();
  }
}

export type TopicHandler = (payload: unknown, jobId: string) => Promise<void>;

export interface OutboxWorker {
  readonly worker: Worker;
  close(): Promise<void>;
}

/** Unknown topics fail the job (kept for inspection) rather than being dropped. */
export function createOutboxWorker(redisUrl: string, handlers: Record<string, TopicHandler>): OutboxWorker {
  const client = createRedis(redisUrl);
  const worker = new Worker(
    OUTBOX_QUEUE,
    async (job: Job) => {
      const handler = handlers[job.name];
      if (!handler) throw new Error(`no handler for topic ${job.name}`);
      await handler(job.data, job.id ?? '');
    },
    { connection: client, concurrency: 4 },
  );
  return {
    worker,
    async close(): Promise<void> {
      await worker.close();
      await client.quit();
    },
  };
}
