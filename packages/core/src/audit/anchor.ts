// External anchoring of the audit chain head (docs/10 tamper-evident audit).
// The chain (./chain) catches edited, deleted or re-ordered rows, but not the
// NEWEST rows being cut off: a shorter chain still verifies. The worker
// therefore copies the head (seq, hash, ts) to a sink OUTSIDE the main
// database at intervals; `pnpm audit:verify --anchors <file>` then fails when
// the database chain is shorter than, or disagrees with, any anchored head.
//
// Default sink: an append-only JSONL file (CHEMA_AUDIT_ANCHOR_FILE). In
// production point it at write-once storage the database operators cannot
// rewrite (object storage with object lock / WORM retention, or a separate
// account's bucket); a file on the database host only proves something
// against someone who cannot also edit that file.
import { appendFile, readFile } from 'node:fs/promises';
import type { Queryable } from '@chema/shared';
import { verifyChain, type ChainProblem } from './chain';

export interface AuditAnchor {
  /** audit_log.seq of the head, as a decimal string. */
  seq: string;
  hash: string;
  /** When the anchor was taken (ISO). */
  anchoredAt: string;
}

export interface AnchorSink {
  append(anchor: AuditAnchor): Promise<void>;
  readAll(): Promise<AuditAnchor[]>;
}

const ANCHOR_SHAPE = (a: unknown): a is AuditAnchor =>
  typeof a === 'object' &&
  a !== null &&
  typeof (a as AuditAnchor).seq === 'string' &&
  /^[1-9][0-9]*$/.test((a as AuditAnchor).seq) &&
  typeof (a as AuditAnchor).hash === 'string' &&
  /^[0-9a-f]{64}$/.test((a as AuditAnchor).hash) &&
  typeof (a as AuditAnchor).anchoredAt === 'string';

/** One JSON object per line, appended only ('a' flag: never rewritten by this code). */
export class FileAnchorSink implements AnchorSink {
  constructor(readonly path: string) {}

  async append(anchor: AuditAnchor): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(anchor)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  async readAll(): Promise<AuditAnchor[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return parseAnchors(raw);
  }
}

/** Parse JSONL anchors. A malformed line is an error (an anchor file is evidence: never skip silently). */
export function parseAnchors(raw: string): AuditAnchor[] {
  const out: AuditAnchor[] = [];
  raw.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new Error(`anchor file line ${i + 1} is not JSON`);
    }
    if (!ANCHOR_SHAPE(v)) throw new Error(`anchor file line ${i + 1} is not an anchor`);
    out.push({ seq: v.seq, hash: v.hash, anchoredAt: v.anchoredAt });
  });
  return out;
}

/** Current chain head, or null for an empty chain. */
export async function chainHead(q: Queryable): Promise<{ seq: string; hash: string } | null> {
  const { rows } = await q.query<{ seq: string; hash: string }>(
    'SELECT seq::text AS seq, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1',
  );
  return rows[0] ?? null;
}

/**
 * Anchor the current head unless it is the one anchored last. Returns the
 * anchor written, or null when there was nothing new.
 */
export async function anchorHead(q: Queryable, sink: AnchorSink, now: Date, last?: AuditAnchor | null): Promise<AuditAnchor | null> {
  const head = await chainHead(q);
  if (!head) return null;
  const previous = last === undefined ? (await sink.readAll()).at(-1) ?? null : last;
  if (previous && previous.seq === head.seq && previous.hash === head.hash) return null;
  const anchor = { seq: head.seq, hash: head.hash, anchoredAt: now.toISOString() };
  await sink.append(anchor);
  return anchor;
}

export type AnchorProblem = 'TRUNCATED' | 'ANCHOR_MISMATCH';

export type AnchoredReport =
  | { ok: true; count: number; head: string; anchors: number }
  | { ok: false; count: number; seq: string; problem: ChainProblem | AnchorProblem };

/**
 * verifyChain + every anchor: an anchored seq beyond the chain ⇒ TRUNCATED;
 * an anchored seq whose row hash differs ⇒ ANCHOR_MISMATCH (rows rewritten
 * consistently from that point). With the chain intact from genesis, a
 * matching anchored hash proves every row up to it is the original.
 */
export async function verifyChainWithAnchors(q: Queryable, anchors: readonly AuditAnchor[]): Promise<AnchoredReport> {
  const chain = await verifyChain(q);
  if (!chain.ok) return chain;
  const sorted = [...anchors].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
  for (const a of sorted) {
    if (BigInt(a.seq) > BigInt(chain.count)) return { ok: false, count: chain.count, seq: a.seq, problem: 'TRUNCATED' };
    const { rows } = await q.query<{ hash: string }>('SELECT hash FROM audit_log WHERE audit_log.seq = $1::bigint', [a.seq]);
    if (rows[0]?.hash !== a.hash) return { ok: false, count: chain.count, seq: a.seq, problem: 'ANCHOR_MISMATCH' };
  }
  return { ok: true, count: chain.count, head: chain.head, anchors: sorted.length };
}
