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

export function createPgClient(connectionString: string, max = 10): SqlClient {
  const pool = new pg.Pool({ connectionString, max });
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
