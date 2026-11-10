// An idle pooled connection killed by the server must not crash the process
// (it did: CI run 42796948455 failed on 57P01 from DROP DATABASE ... FORCE).
// Real Postgres only (CHEMA_TEST_DATABASE_URL); PGlite has no server to kill.
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPgClient } from './pg';

const REAL_PG = process.env.CHEMA_TEST_DATABASE_URL;

describe.skipIf(!REAL_PG)('createPgClient on real Postgres', () => {
  it('survives the server terminating an idle connection, and keeps working', async () => {
    const errors: Error[] = [];
    const db = createPgClient(REAL_PG as string, 2, (err) => errors.push(err));
    try {
      const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pid = rows[0]!.pid;
      const admin = new pg.Client({ connectionString: REAL_PG });
      await admin.connect();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await admin.end();
      // Wait until the pool has seen the error on the idle client.
      for (let i = 0; i < 50 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect((errors[0] as Error & { code?: string }).code).toBe('57P01');
      const again = await db.query<{ one: number }>('SELECT 1 AS one');
      expect(again.rows[0]!.one).toBe(1);
    } finally {
      await db.close();
    }
  });
});
