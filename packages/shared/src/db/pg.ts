import pg from 'pg';
import type { Queryable, QueryResult, SqlClient } from './client';

function wrap(target: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const res = await target.query(sql, params as unknown[]);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string): Promise<void> {
      await target.query(sql);
    },
  };
}

export function createPgClient(
  connectionString: string,
  max = 10,
  onIdleError: (err: Error) => void = () => undefined,
): SqlClient {
  const pool = new pg.Pool({ connectionString, max });
  // An idle pooled connection can die at any time (server restart, failover,
  // pg_terminate_backend, DROP DATABASE ... WITH (FORCE)). pg re-emits that on
  // the pool; with no listener Node treats it as an unhandled 'error' and the
  // process crashes. The pool has already discarded the dead client and the
  // next query opens a fresh one, so the error only needs reporting.
  pool.on('error', onIdleError);
  const base = wrap(pool);
  return {
    ...base,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const result = await fn(wrap(conn));
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
