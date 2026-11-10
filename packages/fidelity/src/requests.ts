// Outbound call queue + outbox events of the claim path (docs/07 Resilience).
import { randomUUID } from 'node:crypto';
import { enqueueOutbox } from '@chema/core';
import type { Queryable } from '@chema/shared';
import type { LinkRow } from './store';

export type RequestKind = 'LINK_CLAIM' | 'SUBMIT_EVIDENCE' | 'SYNC';

/** Retry policy for calls to Fidelity: 1 min doubling, 8 attempts (~4 h), then DEAD (ops sees it). */
export const FIDELITY_RETRY = { maxAttempts: 8, firstDelayMs: 60_000, leaseMs: 5 * 60_000 } as const;
/** Open claims are re-read from Fidelity at least this often, even without callbacks. */
export const SYNC_INTERVAL_MS = 6 * 3_600_000;

/** Outbox topics (docs/07 Events out + the family-facing route changes). Logged by the worker until P08/P09. */
export const CLAIM_TOPICS = [
  'claim.linked',
  'claim.evidence_submitted',
  'claim.status_changed',
  'benefit.credited',
  'benefit.route_blocked',
  'benefit.route_unblocked',
] as const;
export type ClaimTopic = (typeof CLAIM_TOPICS)[number];

export async function emit(tx: Queryable, topic: ClaimTopic, payload: { walletId: string; linkId: string } & Record<string, unknown>): Promise<void> {
  await enqueueOutbox(tx, topic, payload);
}

/**
 * Queue a call. LINK_CLAIM and SYNC collapse into the open request of the same
 * kind for the link (partial unique index), so the returned id may be an
 * existing one.
 */
export async function enqueueRequest(
  tx: Queryable,
  r: { linkId: string; walletId: string; kind: RequestKind; dedupeKey: string; payload?: Record<string, unknown>; now: Date },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO fidelity_request (link_id, wallet_id, kind, dedupe_key, payload, status, next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'QUEUED', $6, $6, $6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [r.linkId, r.walletId, r.kind, r.dedupeKey, JSON.stringify(r.payload ?? {}), r.now.toISOString()],
  );
  if (rows[0]) return rows[0].id;
  const { rows: open } = await tx.query<{ id: string }>(
    `SELECT id FROM fidelity_request WHERE (link_id = $1 AND kind = $2 AND status IN ('QUEUED', 'RETRY')) OR dedupe_key = $3
      ORDER BY created_at DESC LIMIT 1`,
    [r.linkId, r.kind, r.dedupeKey],
  );
  const id = open[0]?.id;
  if (!id) throw new Error('fidelity request could not be queued');
  return id;
}

/** Re-read the claim from Fidelity (after a callback, an unblock, or on the poller's schedule). */
export function enqueueSync(tx: Queryable, link: Pick<LinkRow, 'id' | 'wallet_id'>, now: Date): Promise<string> {
  return enqueueRequest(tx, { linkId: link.id, walletId: link.wallet_id, kind: 'SYNC', dedupeKey: `sync:${link.id}:${randomUUID()}`, now });
}
