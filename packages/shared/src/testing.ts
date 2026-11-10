// Test-only helpers. Never import from runtime code.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Queryable, SqlClient } from './db/client';
import { migrate } from './db/migrate';
import { MIGRATIONS_DIR } from './db/paths';
import { createPgClient } from './db/pg';
import { createPgliteClient } from './db/pglite';

export { createPgliteClient };

/** Fresh in-process Postgres with all repo migrations applied. */
export async function migratedTestDb(): Promise<SqlClient> {
  const db = await createPgliteClient();
  await migrate(db, MIGRATIONS_DIR);
  return db;
}

/**
 * Raw-SQL fixture: a DRAFT wallet row with this id (no-op if it exists), so
 * tests below the wallet package can satisfy the wallet(id) foreign keys.
 * Runtime code creates wallets only through the wallet.create_draft command.
 */
export async function insertTestWallet(q: Queryable, id: string, currency: 'USD' | 'ZWG' = 'USD'): Promise<string> {
  const { rows } = await q.query<{ id: string }>("INSERT INTO person (name) VALUES ('fixture-wallet-admin') RETURNING id");
  const person = rows[0]?.id;
  await q.query(
    `INSERT INTO wallet (id, deceased_name, deceased_name_norm, date_of_death, funeral_location, funeral_location_norm,
                         currency, admin_person, created_by, created_by_kind, source_channel)
     VALUES ($1, 'Fixture', 'fixture', DATE '2026-11-01', 'Harare', 'harare', $2, $3, $3, 'CUSTOMER', 'WEB')
     ON CONFLICT (id) DO NOTHING`,
    [id, currency, person],
  );
  return id;
}

async function asAdmin(adminUrl: string, sql: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

/**
 * A throwaway database on a REAL Postgres server, migrated, with a connection
 * pool — for tests that need true concurrency (PGlite has one connection, so
 * its transactions never overlap). `adminUrl` must be allowed to CREATE
 * DATABASE; close() drops the database again.
 */
export async function realPgTestDb(adminUrl: string, maxConnections = 10): Promise<SqlClient> {
  const name = `chema_test_${randomBytes(6).toString('hex')}`;
  await asAdmin(adminUrl, `CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = createPgClient(url.toString(), maxConnections);
  try {
    await migrate(db, MIGRATIONS_DIR);
  } catch (err) {
    await db.close();
    await asAdmin(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    throw err;
  }
  return {
    ...db,
    async close(): Promise<void> {
      await db.close();
      await asAdmin(adminUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}
