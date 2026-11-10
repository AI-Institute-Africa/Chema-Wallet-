// Plain-SQL migration runner: ordered NNNN_name.sql files, sha256-verified.
// - Versions must be contiguous from 0001; duplicates/gaps/bad names fail.
// - An already-applied file whose checksum changed fails hard (never edit an
//   applied migration; add a new one).
// - Each file runs in its own transaction under a transaction-scoped advisory
//   lock, so concurrent runners apply each migration exactly once.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqlClient } from './client';

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const LOCK_KEY = 72_430_001; // arbitrary, stable

export interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Normalise line endings + BOM so checksums match across Windows/Linux checkouts. */
export function checksumOf(sql: string): string {
  const noBom = sql.charCodeAt(0) === 0xfeff ? sql.slice(1) : sql;
  const normalised = noBom.replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const file of entries) {
    const m = FILE_RE.exec(file);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new MigrationError(`bad migration filename: ${file} (want NNNN_snake_name.sql)`);
    }
    const sql = await readFile(join(dir, file), 'utf8');
    files.push({ version: Number(m[1]), name: m[2], checksum: checksumOf(sql), sql });
  }
  files.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new MigrationError(
        `migration versions must be contiguous from 0001; found ${String(f.version).padStart(4, '0')} at position ${i + 1}`,
      );
    }
  });
  return files;
}

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  name        text        NOT NULL,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);`;

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

export async function migrate(db: SqlClient, dir: string): Promise<{ applied: string[] }> {
  const files = await loadMigrations(dir);
  await db.exec(BOOTSTRAP);

  const { rows: applied } = await db.query<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  const byVersion = new Map(applied.map((r) => [r.version, r]));
  for (const row of applied) {
    const file = files.find((f) => f.version === row.version);
    if (!file) {
      throw new MigrationError(`applied migration ${row.version}_${row.name} is missing from ${dir}`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `checksum mismatch for applied migration ${row.version}_${row.name}; never edit applied migrations`,
      );
    }
  }

  const done: string[] = [];
  for (const file of files) {
    if (byVersion.has(file.version)) continue;
    const ran = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      const { rows } = await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file.version]);
      if (rows.length > 0) return false; // another runner got there first
      await tx.exec(file.sql);
      await tx.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        file.version,
        file.name,
        file.checksum,
      ]);
      return true;
    });
    if (ran) done.push(`${String(file.version).padStart(4, '0')}_${file.name}`);
  }
  return { applied: done };
}
