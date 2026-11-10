import type { SqlClient } from '@chema/shared';
import { migratedTestDb } from '@chema/shared/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueOutbox, InMemoryJobQueue, OUTBOX_MAX_ATTEMPTS, OutboxRelay } from './outbox';

let db: SqlClient;
beforeAll(async () => {
  db = await migratedTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('transactional outbox', () => {
  it('rolled-back producers leave no event', async () => {
    await expect(
      db.transaction(async (tx) => {
        await enqueueOutbox(tx, 'test.rolled_back', { a: 1 });
        throw new Error('producer failed');
      }),
    ).rejects.toThrow();
    const { rows } = await db.query("SELECT 1 FROM outbox_event WHERE topic = 'test.rolled_back'");
    expect(rows).toHaveLength(0);
  });

  it('relay dispatches with jobId = outbox id; re-enqueue is idempotent', async () => {
    const id = await db.transaction((tx) => enqueueOutbox(tx, 'test.dispatch', { n: 1 }));
    const q = new InMemoryJobQueue();
    const relay = new OutboxRelay(db, q);
    expect((await relay.runOnce()).dispatched).toBeGreaterThanOrEqual(1);
    expect(q.jobs.get(id)).toEqual({ topic: 'test.dispatch', payload: { n: 1 } });
    // a second run finds nothing pending
    expect(await relay.runOnce()).toEqual({ dispatched: 0, failed: 0 });
    await q.add('test.dispatch', { n: 2 }, id);
    expect(q.jobs.get(id)).toEqual({ topic: 'test.dispatch', payload: { n: 1 } });
  });

  it('queue failure keeps the event pending with attempts counted, then dispatches later', async () => {
    const id = await db.transaction((tx) => enqueueOutbox(tx, 'test.retry', {}));
    const q = new InMemoryJobQueue();
    q.failNext = true;
    const relay = new OutboxRelay(db, q, 1);
    expect(await relay.runOnce()).toEqual({ dispatched: 0, failed: 1 });
    const { rows } = await db.query<{ status: string; attempts: number; last_error: string }>(
      'SELECT status, attempts, last_error FROM outbox_event WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'queue unavailable' });
    expect(await relay.runOnce()).toEqual({ dispatched: 1, failed: 0 });
  });

  it(`marks FAILED after ${OUTBOX_MAX_ATTEMPTS} attempts (kept, not dropped)`, async () => {
    const id = await db.transaction((tx) => enqueueOutbox(tx, 'test.poison', {}));
    await db.query('UPDATE outbox_event SET attempts = $2 WHERE id = $1', [id, OUTBOX_MAX_ATTEMPTS - 1]);
    const q = new InMemoryJobQueue();
    q.failNext = true;
    await new OutboxRelay(db, q, 1).runOnce();
    const { rows } = await db.query<{ status: string }>('SELECT status FROM outbox_event WHERE id = $1', [id]);
    expect(rows[0]!.status).toBe('FAILED');
  });

  it('payload/topic are immutable, rows cannot be deleted, DISPATCHED is terminal', async () => {
    const id = await db.transaction((tx) => enqueueOutbox(tx, 'test.immutable', { v: 1 }));
    await expect(db.query(`UPDATE outbox_event SET payload = '{"v":2}' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE outbox_event SET topic = 'x' WHERE id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM outbox_event WHERE id = $1', [id])).rejects.toThrow(/append-only/);
    await new OutboxRelay(db, new InMemoryJobQueue()).runOnce();
    await expect(db.query("UPDATE outbox_event SET status = 'PENDING' WHERE id = $1", [id])).rejects.toThrow(/already dispatched/);
  });
});
