import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlClient } from './client';
import { MigrationError, checksumOf, migrate } from './migrate';
import { MIGRATIONS_DIR } from './paths';
import { createPgliteClient } from './pglite';

let db: SqlClient;
let dir: string;

beforeEach(async () => {
  db = await createPgliteClient();
  dir = await mkdtemp(join(tmpdir(), 'chema-mig-'));
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('migrate', () => {
  it('applies files in version order and records checksums', async () => {
    await writeFile(join(dir, '0002_b.sql'), 'ALTER TABLE t ADD COLUMN b int;');
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t (a int);');
    const { applied } = await migrate(db, dir);
    expect(applied).toEqual(['0001_a', '0002_b']);
    const { rows } = await db.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]?.checksum).toBe(checksumOf('CREATE TABLE t (a int);'));
  });

  it('is idempotent on rerun', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t (a int);');
    await migrate(db, dir);
    expect((await migrate(db, dir)).applied).toEqual([]);
  });

  it('fails hard when an applied migration is edited', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t (a int);');
    await migrate(db, dir);
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t (a int, sneaky int);');
    await expect(migrate(db, dir)).rejects.toThrow(/checksum mismatch/);
  });

  it('treats CRLF and LF checkouts as the same file', () => {
    expect(checksumOf('SELECT 1;\r\nSELECT 2;\r\n')).toBe(checksumOf('SELECT 1;\nSELECT 2;\n'));
    expect(checksumOf(String.fromCharCode(0xfeff) + 'SELECT 1;')).toBe(checksumOf('SELECT 1;'));
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });

  it('rejects gaps in version numbers', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'SELECT 1;');
    await writeFile(join(dir, '0003_c.sql'), 'SELECT 1;');
    await expect(migrate(db, dir)).rejects.toThrow(MigrationError);
  });

  it('rejects badly named files', async () => {
    await writeFile(join(dir, '1_a.sql'), 'SELECT 1;');
    await expect(migrate(db, dir)).rejects.toThrow(/bad migration filename/);
  });

  it('rolls back a failing migration and records nothing for it', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t (a int);');
    await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE u (x int); SELECT broken_syntax FROM;');
    await expect(migrate(db, dir)).rejects.toThrow();
    const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
    expect(rows.map((r) => r.version)).toEqual([1]);
    const { rows: u } = await db.query("SELECT to_regclass('u') AS r");
    expect(u[0]).toEqual({ r: null });
  });

  it('applies the real repo migrations cleanly', async () => {
    const { applied } = await migrate(db, MIGRATIONS_DIR);
    expect(applied[0]).toBe('0001_config_flag');
  });
});
