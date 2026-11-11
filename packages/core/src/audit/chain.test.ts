import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqlClient } from '@chema/shared';
import { migratedTestDb } from '@chema/shared/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { anchorHead, FileAnchorSink, parseAnchors, verifyChainWithAnchors } from './anchor';
import { appendAudit, GENESIS_HASH, verifyChain } from './chain';
import { DbAuditSink, type AuditEvent } from './sink';

let db: SqlClient;
beforeAll(async () => {
  db = await migratedTestDb();
});
afterAll(async () => {
  await db.close();
});

// Tamper simulation needs the guard triggers off (superuser in PGlite), then back on.
async function asSuperuser(sql: string): Promise<void> {
  await db.exec(`ALTER TABLE audit_log DISABLE TRIGGER USER; ${sql}; ALTER TABLE audit_log ENABLE TRIGGER USER;`);
}

const ev = (i: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  action: 'test.action',
  actorId: `actor-${i}`,
  actorRole: 'CUSTOMER',
  channel: 'WEB',
  subjectType: 'wallet',
  subjectId: `w-${i}`,
  authzResult: 'ALLOWED',
  ts: new Date(Date.UTC(2026, 10, 10, 8, 0, i, 123)),
  ...over,
});

async function seed(n: number): Promise<void> {
  const sink = new DbAuditSink(db);
  for (let i = 1; i <= n; i++) await sink.record(ev(i, { before: { v: i - 1 }, after: { v: i } }));
}

beforeEach(async () => {
  await asSuperuser('DELETE FROM audit_log');
});

describe('audit hash chain', () => {
  it('empty chain verifies', async () => {
    expect(await verifyChain(db)).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  // >9 rows: seq is selected as text, so ordering must use the bigint column ('10' < '9').
  it('appends link to the previous hash and verify passes (across pages, >9 rows)', async () => {
    await seed(12);
    const report = await verifyChain(db, 5);
    expect(report).toMatchObject({ ok: true, count: 12 });
    const { rows } = await db.query<{ seq: string; prev_hash: string; hash: string }>(
      'SELECT seq::text AS seq, prev_hash, hash FROM audit_log ORDER BY audit_log.seq',
    );
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.hash);
  });

  it('stores before/after as hashes only, never raw values', async () => {
    await new DbAuditSink(db).record(ev(1, { before: { phone: '+263771234567' }, after: { phone: '+263770000000' } }));
    const { rows } = await db.query<Record<string, unknown>>('SELECT * FROM audit_log');
    expect(JSON.stringify(rows)).not.toContain('26377');
    expect(rows[0]!['before_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects an edited field', async () => {
    await seed(5);
    await asSuperuser("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 3");
    expect(await verifyChain(db)).toMatchObject({ ok: false, seq: '3', problem: 'HASH_MISMATCH', count: 2 });
  });

  it('detects a sub-millisecond timestamp edit', async () => {
    await seed(3);
    await asSuperuser("UPDATE audit_log SET ts = ts + interval '1 microsecond' WHERE seq = 2");
    expect(await verifyChain(db)).toMatchObject({ ok: false, seq: '2', problem: 'HASH_MISMATCH' });
  });

  it('detects an edited row whose hash was recomputed (next link breaks)', async () => {
    await seed(4);
    await asSuperuser("UPDATE audit_log SET authz_result = 'DENIED', hash = repeat('a', 64) WHERE seq = 2");
    const report = await verifyChain(db);
    expect(report.ok).toBe(false);
    if (!report.ok) expect(['2', '3']).toContain(report.seq);
  });

  it('detects a deleted row (gap)', async () => {
    await seed(5);
    await asSuperuser('DELETE FROM audit_log WHERE seq = 4');
    expect(await verifyChain(db)).toMatchObject({ ok: false, seq: '4', problem: 'GAP' });
  });

  it('detects a forged row inserted with a wrong prev link', async () => {
    await seed(2);
    await db.query(
      `INSERT INTO audit_log (seq, id, ts, actor_id, actor_role, channel, action, subject_type, subject_id, authz_result, prev_hash, hash)
       VALUES (3, gen_random_uuid(), now(), 'mallory', 'CUSTOMER', 'WEB', 'payout.request', 'wallet', 'w', 'ALLOWED', repeat('b', 64), repeat('c', 64))`,
    );
    expect(await verifyChain(db)).toMatchObject({ ok: false, seq: '3', problem: 'PREV_MISMATCH' });
  });

  it('rejects a fork (two rows claiming the same predecessor)', async () => {
    await seed(2);
    const { rows } = await db.query<{ hash: string }>('SELECT hash FROM audit_log WHERE seq = 1');
    await expect(
      db.query(
        `INSERT INTO audit_log (seq, id, ts, actor_id, actor_role, channel, action, subject_type, subject_id, authz_result, prev_hash, hash)
         VALUES (99, gen_random_uuid(), now(), 'm', 'CUSTOMER', 'WEB', 'x', 'wallet', 'w', 'ALLOWED', $1, repeat('d', 64))`,
        [rows[0]!.hash],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('concurrent appends in separate transactions stay linear', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => db.transaction((tx) => appendAudit(tx, ev(i + 1)))));
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 10 });
  });
});

describe('audit_log is append-only (triggers)', () => {
  beforeEach(async () => {
    await seed(2);
  });

  it('blocks UPDATE', async () => {
    await expect(db.query("UPDATE audit_log SET actor_id = 'x' WHERE seq = 1")).rejects.toThrow(/append-only/);
  });

  it('blocks DELETE', async () => {
    await expect(db.query('DELETE FROM audit_log WHERE seq = 1')).rejects.toThrow(/append-only/);
  });

  it('blocks TRUNCATE', async () => {
    await expect(db.exec('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
  });

  it('a failed business transaction leaves no audit row behind', async () => {
    await expect(
      db.transaction(async (tx) => {
        await appendAudit(tx, ev(3));
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 2 });
  });
});

describe('external anchoring of the chain head (truncation of the newest rows)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'chema-anchor-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const sinkFile = () => new FileAnchorSink(join(dir, `${randomUUID()}.jsonl`));

  it('anchors the head once per change, append-only JSONL', async () => {
    const sink = sinkFile();
    expect(await anchorHead(db, sink, new Date())).toBeNull(); // empty chain: nothing to anchor
    await seed(3);
    const a = await anchorHead(db, sink, new Date('2026-11-11T10:00:00Z'));
    expect(a).toMatchObject({ seq: '3', anchoredAt: '2026-11-11T10:00:00.000Z' });
    expect(await anchorHead(db, sink, new Date())).toBeNull(); // unchanged head
    await seed(1);
    await anchorHead(db, sink, new Date());
    const lines = readFileSync(sink.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((await sink.readAll()).map((x) => x.seq)).toEqual(['3', '4']);
  });

  it('truncating rows after an anchor verifies as a chain, but fails against the anchor', async () => {
    await seed(6);
    const sink = sinkFile();
    await anchorHead(db, sink, new Date());
    await asSuperuser('DELETE FROM audit_log WHERE seq > 4');
    // The shortened chain is internally consistent: verifyChain alone cannot tell.
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 4 });
    expect(await verifyChainWithAnchors(db, await sink.readAll())).toEqual({ ok: false, count: 4, seq: '6', problem: 'TRUNCATED' });
  });

  it('a consistent rewrite of the tail (re-appended rows) disagrees with the anchored hash', async () => {
    await seed(5);
    const sink = sinkFile();
    await anchorHead(db, sink, new Date());
    await asSuperuser('DELETE FROM audit_log WHERE seq >= 4');
    const forger = new DbAuditSink(db);
    await forger.record(ev(40, { actorId: 'mallory' }));
    await forger.record(ev(41, { actorId: 'mallory' }));
    expect(await verifyChain(db)).toMatchObject({ ok: true, count: 5 });
    expect(await verifyChainWithAnchors(db, await sink.readAll())).toMatchObject({ ok: false, seq: '5', problem: 'ANCHOR_MISMATCH' });
  });

  it('edits are still detected (by the chain) when anchors are checked; an intact chain matches every anchor', async () => {
    await seed(3);
    const sink = sinkFile();
    await anchorHead(db, sink, new Date());
    await seed(2);
    await anchorHead(db, sink, new Date());
    expect(await verifyChainWithAnchors(db, await sink.readAll())).toMatchObject({ ok: true, count: 5, anchors: 2 });
    await asSuperuser("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 2");
    expect(await verifyChainWithAnchors(db, await sink.readAll())).toMatchObject({ ok: false, seq: '2', problem: 'HASH_MISMATCH' });
  });

  it('a malformed anchor file is an error, never skipped', () => {
    expect(() => parseAnchors('{"seq":"1","hash":"x","anchoredAt":"t"}\n')).toThrow(/line 1/);
    expect(() => parseAnchors('not json')).toThrow(/line 1/);
    expect(parseAnchors('')).toEqual([]);
  });
});
