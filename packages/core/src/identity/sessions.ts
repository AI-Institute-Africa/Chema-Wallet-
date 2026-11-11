// Sessions and step-up grants. Tokens are random 256-bit strings returned once;
// only their sha256 is stored. Step-up grants are bound to one session, one
// action and one subject, expire quickly and are consumed exactly once.
import type { Queryable } from '@chema/shared';
import type { Action } from '../authz/matrix';
import type { Actor, Channel, StaffRole, Subject } from '../authz/types';
import { randomToken, sha256Hex } from '../crypto';
import type { StepUpConsumer } from '../command/bus';
import { one } from '../db';

/** Not in spec — safest reasonable defaults; see PROGRESS.md Assumptions. */
export const AUTH_LIMITS = {
  otpTtlMs: 5 * 60_000,
  otpMaxAttempts: 5,
  otpWindowMs: 15 * 60_000,
  otpMaxPerWindow: 3,
  customerSessionMs: 12 * 60 * 60_000,
  staffSessionMs: 8 * 60 * 60_000,
  stepUpTtlMs: 5 * 60_000,
  staffMaxFailures: 5,
  staffLockMs: 15 * 60_000,
} as const;

export type Clock = () => Date;

export interface NewSession {
  personId: string;
  kind: 'CUSTOMER' | 'STAFF';
  channel: Exclude<Channel, 'SYSTEM'>;
  staffId?: string;
  ip?: string;
  device?: string;
}

export interface IssuedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

export async function createSession(tx: Queryable, s: NewSession, now: Date): Promise<IssuedSession> {
  const token = randomToken();
  const ttl = s.kind === 'STAFF' ? AUTH_LIMITS.staffSessionMs : AUTH_LIMITS.customerSessionMs;
  const expiresAt = new Date(now.getTime() + ttl);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO auth_session (token_hash, person_id, staff_id, kind, channel, device_ref, ip, mfa_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      sha256Hex(token),
      s.personId,
      s.staffId ?? null,
      s.kind,
      s.channel,
      s.device ?? null,
      s.ip ?? null,
      s.kind === 'STAFF' ? now.toISOString() : null,
      expiresAt.toISOString(),
    ],
  );
  return { sessionId: one(rows, 'session insert').id, token, expiresAt };
}

interface SessionRow {
  id: string;
  person_id: string;
  kind: 'CUSTOMER' | 'STAFF';
  channel: Exclude<Channel, 'SYSTEM'>;
  mfa_at: Date | null;
  ip: string | null;
  device_ref: string | null;
  staff_role: StaffRole | null;
  staff_disabled_at: Date | null;
}

const SESSION_SELECT = `SELECT s.id, s.person_id, s.kind, s.channel, s.mfa_at, s.ip, s.device_ref,
            st.staff_role, st.disabled_at AS staff_disabled_at
       FROM auth_session s LEFT JOIN staff_account st ON st.id = s.staff_id`;

/** Bearer token → Actor, or null if unknown/expired/revoked/disabled. */
export async function sessionActor(q: Queryable, token: string, now: Date): Promise<Actor | null> {
  if (token.length < 16 || token.length > 128) return null;
  const { rows } = await q.query<SessionRow>(
    `${SESSION_SELECT} WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz`,
    [sha256Hex(token), now.toISOString()],
  );
  return actorOf(rows[0]);
}

/**
 * Session id → Actor, same checks as a bearer token. Only for server-held
 * references (a WhatsApp conversation bound after an OTP login): never accept
 * a session id from a client.
 */
export async function sessionActorById(q: Queryable, sessionId: string, now: Date): Promise<Actor | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const { rows } = await q.query<SessionRow>(
    `${SESSION_SELECT} WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz`,
    [sessionId, now.toISOString()],
  );
  return actorOf(rows[0]);
}

function actorOf(row: SessionRow | undefined): Actor | null {
  if (!row) return null;
  if (row.kind === 'STAFF' && (row.staff_role === null || row.staff_disabled_at !== null)) return null;
  return {
    kind: row.kind,
    personId: row.person_id,
    ...(row.kind === 'STAFF' && row.staff_role ? { staffRole: row.staff_role } : {}),
    mfa: row.kind === 'STAFF' && row.mfa_at !== null,
    channel: row.channel,
    sessionId: row.id,
    ...(row.ip ? { ip: row.ip } : {}),
    ...(row.device_ref ? { device: row.device_ref } : {}),
  };
}

export async function revokeSession(q: Queryable, sessionId: string, now: Date): Promise<void> {
  await q.query('UPDATE auth_session SET revoked_at = $2, updated_at = now() WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
    now.toISOString(),
  ]);
}

export interface StepUpTarget {
  action: Action;
  subjectType: string;
  subjectId: string;
}

export async function issueStepUpGrant(
  tx: Queryable,
  sessionId: string,
  target: StepUpTarget,
  now: Date,
): Promise<{ stepUpToken: string; expiresAt: Date }> {
  const stepUpToken = randomToken();
  const expiresAt = new Date(now.getTime() + AUTH_LIMITS.stepUpTtlMs);
  await tx.query(
    `INSERT INTO step_up_grant (token_hash, session_id, action, subject_type, subject_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sha256Hex(stepUpToken), sessionId, target.action, target.subjectType, target.subjectId, expiresAt.toISOString()],
  );
  return { stepUpToken, expiresAt };
}

export class StepUpGrants implements StepUpConsumer {
  constructor(private readonly clock: Clock = () => new Date()) {}

  async consume(tx: Queryable, actor: Actor, token: string, action: Action, subject: Subject): Promise<boolean> {
    if (!actor.sessionId) return false;
    const now = this.clock().toISOString();
    const { rows } = await tx.query(
      `UPDATE step_up_grant SET consumed_at = $6::timestamptz
        WHERE token_hash = $1 AND session_id = $2 AND action = $3 AND subject_type = $4 AND subject_id = $5
          AND consumed_at IS NULL AND expires_at > $6::timestamptz
        RETURNING id`,
      [sha256Hex(token), actor.sessionId, action, subject.type, subject.id, now],
    );
    return rows.length === 1;
  }
}
