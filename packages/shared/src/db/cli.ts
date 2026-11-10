// `pnpm db:migrate` — applies db/migrations to DATABASE_URL.
import { migrate } from './migrate';
import { MIGRATIONS_DIR } from './paths';
import { createPgClient } from './pg';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createPgClient(url, 1);
try {
  const { applied } = await migrate(db, MIGRATIONS_DIR);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.close();
}
