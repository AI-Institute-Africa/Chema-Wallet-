// Transactional outbox (migration 0006). enqueueOutbox runs inside the
// producer's transaction; OutboxRelay moves committed rows to the job queue.
// Queue delivery is at-least-once; jobId = outbox id makes enqueue idempotent,
// and consumers must be idempotent too. Delivery failures never touch the
// producer's state (CLAUDE.md: message failure never affects transactions).
import type { Queryable, SqlClient } from '@chema/shared';
import { one } from '../db';

export async function enqueueOutbox(tx: Queryable, topic: string, payload: Record<string, unknown>): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    'INSERT INTO outbox_event (topic, payload) VALUES ($1, $2::jsonb) RETURNING id',
    [topic, JSON.stringify(payload)],
  );
  return one(rows, 'outbox insert').id;
}

export interface JobQueue {
  /** Must be idempotent per jobId. */
  add(topic: string, payload: unknown, jobId: string): Promise<void>;
}

export class InMemoryJobQueue implements JobQueue {
  readonly jobs = new Map<string, { topic: string; payload: unknown }>();
  failNext = false;
  async add(topic: string, payload: unknown, jobId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('queue unavailable');
    }
    if (!this.jobs.has(jobId)) this.jobs.set(jobId, { topic, payload });
  }
}

export const OUTBOX_MAX_ATTEMPTS = 20;

interface OutboxRow {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
}

export class OutboxRelay {
  constructor(
    private readonly db: SqlClient,
    private readonly queue: JobQueue,
    private readonly batchSize = 100,
  ) {}

  /** Dispatch one batch. Returns how many rows were dispatched. */
  async runOnce(): Promise<{ dispatched: number; failed: number }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, topic, payload, attempts FROM outbox_event
          WHERE status = 'PENDING' ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      let dispatched = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          await this.queue.add(row.topic, row.payload, row.id);
          await tx.query(
            "UPDATE outbox_event SET status = 'DISPATCHED', attempts = attempts + 1, dispatched_at = now(), last_error = NULL WHERE id = $1",
            [row.id],
          );
          dispatched += 1;
        } catch (err) {
          const attempts = row.attempts + 1;
          await tx.query('UPDATE outbox_event SET attempts = $2, status = $3, last_error = $4 WHERE id = $1', [
            row.id,
            attempts,
            attempts >= OUTBOX_MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
            err instanceof Error ? err.message.slice(0, 500) : 'error',
          ]);
          failed += 1;
        }
      }
      return { dispatched, failed };
    });
  }
}
