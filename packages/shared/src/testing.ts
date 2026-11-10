// Test-only helpers. Never import from runtime code.
import type { SqlClient } from './db/client';
import { migrate } from './db/migrate';
import { MIGRATIONS_DIR } from './db/paths';
import { createPgliteClient } from './db/pglite';

export { createPgliteClient };

/** Fresh in-process Postgres with all repo migrations applied. */
export async function migratedTestDb(): Promise<SqlClient> {
  const db = await createPgliteClient();
  await migrate(db, MIGRATIONS_DIR);
  return db;
}
