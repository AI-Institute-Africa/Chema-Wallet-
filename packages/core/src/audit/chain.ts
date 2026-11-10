// Hash chain over audit_log (migration 0004).
// hash(n) = sha256(prev_hash ‖ "\n" ‖ canonicalJson(fields(n))), prev of row 1 = GENESIS.
// Appends serialise on a transaction-scoped advisory lock, so the chain is
// linear even with many API/worker processes. ts is hashed in microsecond form
// exactly as Postgres renders it, so sub-millisecond tampering is caught too.
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@chema/shared';
import { canonicalJson, sha256Hex, valueHash } from '../crypto';
import type { AuditEvent } from './sink';

export const GENESIS_HASH = '0'.repeat(64);
const LOCK_KEY = 72_430_002; // arbitrary, stable; distinct from the migration lock

interface AuditFields {
  seq: string;
  id: string;
  ts: string;
  actor_id: string;
  actor_role: string;
  channel: string;
  session_ref: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  authz_result: string;
  approval_ref: string | null;
  txn_ref: string | null;
  before_hash: string | null;
  after_hash: string | null;
  ip: string | null;
  device: string | null;
  reason_code: string | null;
}

interface AuditRow extends AuditFields {
  prev_hash: string;
  hash: string;
}

/** JS Date (ms) → the 6-digit-fraction UTC form `to_char(... .US)` yields. */
function tsCanonical(d: Date): string {
  return d.toISOString().replace(/Z$/, '000Z');
}

export function auditHash(prevHash: string, fields: AuditFields): string {
  return sha256Hex(`${prevHash}\n${canonicalJson(fields)}`);
}

export async function appendAudit(tx: Queryable, ev: AuditEvent): Promise<{ seq: bigint; hash: string }> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
  const { rows } = await tx.query<{ seq: string; hash: string }>(
    'SELECT seq::text AS seq, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1',
  );
  const tail = rows[0];
  const seq = tail ? BigInt(tail.seq) + 1n : 1n;
  const prevHash = tail?.hash ?? GENESIS_HASH;

  const fields: AuditFields = {
    seq: seq.toString(),
    id: randomUUID(),
    ts: tsCanonical(ev.ts),
    actor_id: ev.actorId,
    actor_role: ev.actorRole,
    channel: ev.channel,
    session_ref: ev.sessionRef ?? null,
    action: ev.action,
    subject_type: ev.subjectType,
    subject_id: ev.subjectId,
    authz_result: ev.authzResult,
    approval_ref: ev.approvalRef ?? null,
    txn_ref: ev.txnRef ?? null,
    before_hash: valueHash(ev.before),
    after_hash: valueHash(ev.after),
    ip: ev.ip ?? null,
    device: ev.device ?? null,
    reason_code: ev.reasonCode ?? null,
  };
  const hash = auditHash(prevHash, fields);

  await tx.query(
    `INSERT INTO audit_log (seq, id, ts, actor_id, actor_role, channel, session_ref, action, subject_type,
       subject_id, authz_result, approval_ref, txn_ref, before_hash, after_hash, ip, device, reason_code,
       prev_hash, hash)
     VALUES ($1::bigint, $2, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
      fields.seq, fields.id, ev.ts.toISOString(), fields.actor_id, fields.actor_role, fields.channel,
      fields.session_ref, fields.action, fields.subject_type, fields.subject_id, fields.authz_result,
      fields.approval_ref, fields.txn_ref, fields.before_hash, fields.after_hash, fields.ip, fields.device,
      fields.reason_code, prevHash, hash,
    ],
  );
  return { seq, hash };
}

export type ChainProblem = 'GAP' | 'PREV_MISMATCH' | 'HASH_MISMATCH';

export type ChainReport =
  | { ok: true; count: number; head: string }
  | { ok: false; count: number; seq: string; problem: ChainProblem };

const SELECT_PAGE = `
  SELECT seq::text AS seq, id::text AS id,
         to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts,
         actor_id, actor_role, channel, session_ref, action, subject_type, subject_id, authz_result,
         approval_ref, txn_ref, before_hash, after_hash, ip, device, reason_code, prev_hash, hash
    FROM audit_log WHERE audit_log.seq > $1::bigint ORDER BY audit_log.seq LIMIT $2`;

/**
 * Walks the whole chain from GENESIS. Detects edited rows (hash), deleted or
 * inserted-out-of-order rows (gap / prev mismatch). Truncating the newest rows
 * is only detectable against an externally anchored head (see PROGRESS.md).
 */
export async function verifyChain(q: Queryable, pageSize = 1000): Promise<ChainReport> {
  let expected = 1n;
  let prev = GENESIS_HASH;
  let count = 0;
  for (;;) {
    const { rows } = await q.query<AuditRow>(SELECT_PAGE, [(expected - 1n).toString(), pageSize]);
    for (const row of rows) {
      if (BigInt(row.seq) !== expected) return { ok: false, count, seq: expected.toString(), problem: 'GAP' };
      if (row.prev_hash !== prev) return { ok: false, count, seq: row.seq, problem: 'PREV_MISMATCH' };
      const fields: Partial<AuditRow> = { ...row };
      delete fields.prev_hash;
      delete fields.hash;
      if (auditHash(prev, fields as AuditFields) !== row.hash) {
        return { ok: false, count, seq: row.seq, problem: 'HASH_MISMATCH' };
      }
      prev = row.hash;
      expected += 1n;
      count += 1;
    }
    if (rows.length < pageSize) return { ok: true, count, head: prev };
  }
}
