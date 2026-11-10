// In-process Postgres (WASM) for tests. Not exported from the package index:
// runtime code always uses createPgClient.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Queryable, QueryResult, SqlClient } from './client';

function wrap(target: PGlite | Transaction): Queryable {
  return {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const res = await target.query<T>(sql, params as unknown[]);
      return { rows: res.rows };
    },
    async exec(sql: string): Promise<void> {
      await target.exec(sql);
    },
  };
}

export async function createPgliteClient(): Promise<SqlClient> {
  const db = await PGlite.create();
  const base = wrap(db);
  return {
    ...base,
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return db.transaction((tx) => fn(wrap(tx)));
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
