// Customer authentication: phone OTP login and OTP step-up.
// - Same response whether or not the phone is known (no enumeration).
// - Codes are HMACed with the auth secret; never stored, logged or returned.
// - Delivery happens after commit; a delivery failure changes no state.
// - Every outcome (success and failure) is audited.
import { randomUUID } from 'node:crypto';
import type { Queryable, SqlClient } from '@chema/shared';
import { z } from 'zod';
import type { AuditEvent, AuditSink } from '../audit/sink';
import { isAction, STEP_UP_ACTIONS, type Action } from '../authz/matrix';
import type { Actor } from '../authz/types';
import { hmacHex, safeEqual } from '../crypto';
import { AuthenticationError, ForbiddenError, RateLimitedError, ValidationError } from '../errors';
import type { Secrets } from '../secrets';
import { newOtpCode, type OtpDelivery, type OtpProvider } from './otp';
import {
  AUTH_LIMITS,
  createSession,
  issueStepUpGrant,
  revokeSession,
  sessionActor,
  type Clock,
  type IssuedSession,
  type StepUpTarget,
} from './sessions';
import { one } from '../db';

export const PhoneE164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'phone must be E.164, e.g. +263771234567');
const Uuid = z.uuid();

export type LoginChannel = 'WEB' | 'WHATSAPP';

export interface AuthServiceDeps {
  db: SqlClient;
  otp: OtpProvider;
  secrets: Secrets;
  audit: AuditSink;
  clock?: Clock;
}

interface ChallengeRow {
  id: string;
  phone_e164: string;
  channel: LoginChannel;
  code_hash: string;
  session_id: string | null;
  action: string | null;
  subject_type: string | null;
  subject_id: string | null;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

type CheckResult = { ok: true; row: ChallengeRow } | { ok: false; reason: string };

export class AuthService {
  private readonly clock: Clock;

  constructor(private readonly deps: AuthServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private codeHash(challengeId: string, code: string): string {
    return hmacHex(this.deps.secrets.authKey, `${challengeId}:${code}`);
  }

  private async newChallenge(
    tx: Queryable,
    c: { purpose: 'LOGIN' | 'STEP_UP'; phone: string; channel: LoginChannel; sessionId?: string; target?: StepUpTarget },
  ): Promise<{ challengeId: string; code: string }> {
    const now = this.clock();
    const since = new Date(now.getTime() - AUTH_LIMITS.otpWindowMs).toISOString();
    const { rows: recent } = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM otp_challenge WHERE phone_e164 = $1 AND purpose = $2 AND created_at > $3::timestamptz',
      [c.phone, c.purpose, since],
    );
    if ((recent[0]?.n ?? 0) >= AUTH_LIMITS.otpMaxPerWindow) throw new RateLimitedError();

    const code = newOtpCode();
    const challengeId = randomUUID();
    await tx.query(
      `INSERT INTO otp_challenge (id, purpose, phone_e164, channel, code_hash, session_id, action, subject_type, subject_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        challengeId,
        c.purpose,
        c.phone,
        c.channel,
        this.codeHash(challengeId, code),
        c.sessionId ?? null,
        c.target?.action ?? null,
        c.target?.subjectType ?? null,
        c.target?.subjectId ?? null,
        new Date(now.getTime() + AUTH_LIMITS.otpTtlMs).toISOString(),
        now.toISOString(),
      ],
    );
    return { challengeId, code };
  }

  private async deliver(phone: string, channel: LoginChannel, code: string): Promise<void> {
    const via: OtpDelivery = channel === 'WHATSAPP' ? 'WHATSAPP' : 'SMS';
    try {
      await this.deps.otp.send({ phoneE164: phone, via }, code);
    } catch {
      // Delivery failure never affects state; the user simply asks for a new code.
    }
  }

  /** Check a code against a challenge, counting the attempt. Commits the attempt counter. */
  private async checkCode(
    challengeId: string,
    code: string,
    purpose: 'LOGIN' | 'STEP_UP',
    onSuccess: (tx: Queryable, row: ChallengeRow) => Promise<void>,
  ): Promise<CheckResult> {
    if (!Uuid.safeParse(challengeId).success) return { ok: false, reason: 'NO_CHALLENGE' };
    const now = this.clock();
    return this.deps.db.transaction(async (tx): Promise<CheckResult> => {
      const { rows } = await tx.query<ChallengeRow>(
        `SELECT id, phone_e164, channel, code_hash, session_id, action, subject_type, subject_id, attempts, expires_at, consumed_at
           FROM otp_challenge WHERE id = $1 AND purpose = $2 FOR UPDATE`,
        [challengeId, purpose],
      );
      const row = rows[0];
      if (!row) return { ok: false, reason: 'NO_CHALLENGE' };
      if (row.consumed_at) return { ok: false, reason: 'CHALLENGE_USED' };
      if (row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'CHALLENGE_EXPIRED' };
      if (row.attempts >= AUTH_LIMITS.otpMaxAttempts) return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
      if (!/^\d{6}$/.test(code) || !safeEqual(this.codeHash(row.id, code), row.code_hash)) {
        await tx.query('UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = $1', [row.id]);
        return { ok: false, reason: 'BAD_CODE' };
      }
      await tx.query('UPDATE otp_challenge SET consumed_at = $2::timestamptz WHERE id = $1', [row.id, now.toISOString()]);
      await onSuccess(tx, row);
      return { ok: true, row };
    });
  }

  private event(e: Omit<AuditEvent, 'ts'>): AuditEvent {
    return { ...e, ts: this.clock() };
  }

  // ── Login ────────────────────────────────────────────────────────────────

  async startLogin(input: { phone: string; channel: LoginChannel }): Promise<{ challengeId: string }> {
    const phone = PhoneE164.safeParse(input.phone);
    if (!phone.success) throw new ValidationError('invalid phone number');
    const { challengeId, code } = await this.deps.db.transaction((tx) =>
      this.newChallenge(tx, { purpose: 'LOGIN', phone: phone.data, channel: input.channel }),
    );
    await this.deliver(phone.data, input.channel, code);
    return { challengeId };
  }

  async verifyLogin(input: {
    challengeId: string;
    code: string;
    ip?: string;
    device?: string;
  }): Promise<IssuedSession & { personId: string }> {
    let issued: (IssuedSession & { personId: string }) | undefined;
    const result = await this.checkCode(input.challengeId, input.code, 'LOGIN', async (tx, row) => {
      const personId = await this.findOrCreatePerson(tx, row.phone_e164, row.channel);
      const session = await createSession(
        tx,
        {
          personId,
          kind: 'CUSTOMER',
          channel: row.channel,
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.device ? { device: input.device } : {}),
        },
        this.clock(),
      );
      issued = { ...session, personId };
      await this.deps.audit.record(
        this.event({
          action: 'identity.login',
          actorId: personId,
          actorRole: 'CUSTOMER',
          channel: row.channel,
          sessionRef: session.sessionId,
          subjectType: 'person',
          subjectId: personId,
          authzResult: 'ALLOWED',
          reasonCode: 'OTP_OK',
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.device ? { device: input.device } : {}),
        }),
        tx,
      );
    });
    if (!result.ok || !issued) {
      const reason = result.ok ? 'INTERNAL' : result.reason;
      await this.deps.audit.record(
        this.event({
          action: 'identity.login',
          actorId: 'anonymous',
          actorRole: 'ANONYMOUS',
          channel: 'WEB',
          subjectType: 'otp_challenge',
          subjectId: Uuid.safeParse(input.challengeId).success ? input.challengeId : 'invalid',
          authzResult: 'DENIED',
          reasonCode: reason,
          ...(input.ip ? { ip: input.ip } : {}),
        }),
      );
      throw new AuthenticationError(reason);
    }
    return issued;
  }

  private async findOrCreatePerson(tx: Queryable, phone: string, channel: LoginChannel): Promise<string> {
    await tx.query('INSERT INTO person (phone_e164) VALUES ($1) ON CONFLICT (phone_e164) DO NOTHING', [phone]);
    const { rows } = await tx.query<{ id: string }>('SELECT id FROM person WHERE phone_e164 = $1', [phone]);
    const personId = one(rows, 'person lookup').id;
    await tx.query(
      `INSERT INTO identity_binding (person_id, channel, handle, method, verified_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (channel, handle) WHERE revoked_at IS NULL DO NOTHING`,
      [personId, channel, phone, channel === 'WHATSAPP' ? 'OTP_WHATSAPP' : 'OTP_SMS'],
    );
    return personId;
  }

  async authenticate(token: string): Promise<Actor | null> {
    return sessionActor(this.deps.db, token, this.clock());
  }

  async logout(actor: Actor): Promise<void> {
    if (!actor.sessionId) return;
    const sessionId = actor.sessionId;
    await this.deps.db.transaction(async (tx) => {
      await revokeSession(tx, sessionId, this.clock());
      await this.deps.audit.record(
        this.event({
          action: 'identity.logout',
          actorId: actor.personId,
          actorRole: actor.kind,
          channel: actor.channel,
          sessionRef: sessionId,
          subjectType: 'auth_session',
          subjectId: sessionId,
          authzResult: 'ALLOWED',
        }),
        tx,
      );
    });
  }

  // ── Step-up (customer, OTP to the bound phone) ───────────────────────────

  async startStepUp(actor: Actor, target: StepUpTarget): Promise<{ challengeId: string }> {
    if (actor.kind !== 'CUSTOMER' || !actor.sessionId) throw new ForbiddenError('CUSTOMER_SESSION_REQUIRED');
    if (!isAction(target.action) || !STEP_UP_ACTIONS.has(target.action)) throw new ValidationError('action needs no step-up');
    const sessionId = actor.sessionId;
    const { rows } = await this.deps.db.query<{ phone_e164: string | null }>(
      'SELECT phone_e164 FROM person WHERE id = $1',
      [actor.personId],
    );
    const phone = rows[0]?.phone_e164;
    if (!phone) throw new ForbiddenError('NO_BOUND_PHONE');
    const channel: LoginChannel = actor.channel === 'WHATSAPP' ? 'WHATSAPP' : 'WEB';
    const { challengeId, code } = await this.deps.db.transaction((tx) =>
      this.newChallenge(tx, { purpose: 'STEP_UP', phone, channel, sessionId, target }),
    );
    await this.deliver(phone, channel, code);
    return { challengeId };
  }

  async verifyStepUp(actor: Actor, challengeId: string, code: string): Promise<{ stepUpToken: string; expiresAt: Date }> {
    let grant: { stepUpToken: string; expiresAt: Date } | undefined;
    let wrongSession = false;
    const result = await this.checkCode(challengeId, code, 'STEP_UP', async (tx, row) => {
      if (row.session_id !== actor.sessionId || !row.action || !row.subject_type || !row.subject_id) {
        wrongSession = true;
        return;
      }
      const action = row.action as Action;
      grant = await issueStepUpGrant(
        tx,
        row.session_id,
        { action, subjectType: row.subject_type, subjectId: row.subject_id },
        this.clock(),
      );
      await this.deps.audit.record(
        this.event({
          action: 'identity.step_up',
          actorId: actor.personId,
          actorRole: actor.kind,
          channel: actor.channel,
          sessionRef: row.session_id,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          authzResult: 'ALLOWED',
          reasonCode: action,
        }),
        tx,
      );
    });
    if (!result.ok || !grant || wrongSession) {
      const reason = wrongSession ? 'WRONG_SESSION' : result.ok ? 'INTERNAL' : result.reason;
      await this.deps.audit.record(
        this.event({
          action: 'identity.step_up',
          actorId: actor.personId,
          actorRole: actor.kind,
          channel: actor.channel,
          ...(actor.sessionId ? { sessionRef: actor.sessionId } : {}),
          subjectType: 'otp_challenge',
          subjectId: Uuid.safeParse(challengeId).success ? challengeId : 'invalid',
          authzResult: 'DENIED',
          reasonCode: reason,
        }),
      );
      throw new AuthenticationError(reason);
    }
    return grant;
  }
}
