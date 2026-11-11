// Staff (portal) authentication: password + TOTP in one step, so no staff
// session ever exists without MFA. TOTP steps are single-use (replay), failed
// attempts lock the account. Primary factor sits behind StaffAuthenticator so
// an SSO adapter can replace password later without touching callers.
import { randomUUID } from 'node:crypto';
import type { Queryable, SqlClient } from '@chema/shared';
import type { AuditEvent, AuditSink } from '../audit/sink';
import { isAction, STEP_UP_ACTIONS } from '../authz/matrix';
import type { Actor, StaffRole } from '../authz/types';
import { openString, sealString } from '../crypto';
import { AuthenticationError, ForbiddenError, ValidationError } from '../errors';
import type { Secrets } from '../secrets';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';
import { AUTH_LIMITS, createSession, issueStepUpGrant, type Clock, type IssuedSession, type StepUpTarget } from './sessions';
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp';
import { one } from '../db';

export interface StaffAuthenticator {
  login(input: { login: string; password: string; totp: string; ip?: string; device?: string }): Promise<IssuedSession>;
}

interface StaffRow {
  id: string;
  person_id: string;
  staff_role: StaffRole;
  password_hash: string;
  totp_secret_enc: string;
  totp_last_step: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  disabled_at: Date | null;
}

const totpAad = (staffId: string) => `staff_totp:${staffId}`;

export interface StaffEnrollInput {
  login: string;
  role: StaffRole;
  password: string;
  name?: string;
}

export interface StaffEnrollment {
  staffId: string;
  personId: string;
  totpSecret: string;
  otpauth: string;
}

export class StaffAuthService implements StaffAuthenticator {
  private readonly clock: Clock;

  constructor(
    private readonly deps: { db: SqlClient; secrets: Secrets; audit: AuditSink; clock?: Clock },
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private event(e: Omit<AuditEvent, 'ts'>): AuditEvent {
    return { ...e, ts: this.clock() };
  }

  /**
   * Provision a staff account from code (seed CLI, tests). Returns the TOTP
   * secret ONCE for enrolment. The portal path is the `staff.enroll` bus
   * command (P09, @chema/ops), which calls enrollIn inside its transaction.
   */
  async enroll(input: StaffEnrollInput & { enrolledBy: string }): Promise<StaffEnrollment> {
    return this.deps.db.transaction(async (tx) => {
      const out = await this.enrollIn(tx, input);
      await this.deps.audit.record(
        this.event({
          action: 'staff.enroll',
          actorId: input.enrolledBy,
          actorRole: 'SYSTEM',
          channel: 'SYSTEM',
          subjectType: 'staff_account',
          subjectId: out.staffId,
          authzResult: 'ALLOWED',
          after: { role: input.role, login: input.login },
        }),
        tx,
      );
      return out;
    });
  }

  /** Insert the person, staff account (sealed TOTP secret) and ADMIN binding. No audit: the caller audits. */
  async enrollIn(tx: Queryable, input: StaffEnrollInput): Promise<StaffEnrollment> {
    if (!/^[a-z0-9._@-]{3,64}$/.test(input.login)) throw new ValidationError('invalid login');
    if (input.password.length < 12 || input.password.length > 200) throw new ValidationError('password must be 12-200 characters');
    const { rows: taken } = await tx.query('SELECT 1 FROM staff_account WHERE login = $1', [input.login]);
    if (taken.length > 0) throw new ValidationError('login taken');
    const passwordHash = await hashPassword(input.password);
    const secret = newTotpSecret();
    const { rows: p } = await tx.query<{ id: string }>('INSERT INTO person (name) VALUES ($1) RETURNING id', [input.name ?? null]);
    const personId = one(p, 'person insert').id;
    const staffId = randomUUID();
    await tx.query(
      `INSERT INTO staff_account (id, person_id, login, staff_role, password_hash, totp_secret_enc)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [staffId, personId, input.login, input.role, passwordHash, sealString(this.deps.secrets.dataKey, base32Encode(secret), totpAad(staffId))],
    );
    await tx.query(
      `INSERT INTO identity_binding (person_id, channel, handle, method, verified_at)
       VALUES ($1, 'ADMIN', $2, 'PASSWORD_TOTP', now())`,
      [personId, input.login],
    );
    return { staffId, personId, totpSecret: base32Encode(secret), otpauth: otpauthUri('Chema Wallet', input.login, secret) };
  }

  /**
   * Disable / re-enable a staff account inside the caller's transaction.
   * Disabling also revokes every live session of that person at once.
   */
  async setDisabledIn(tx: Queryable, staffId: string, disabled: boolean): Promise<{ personId: string; changed: boolean }> {
    const { rows } = await tx.query<{ person_id: string; disabled_at: Date | null }>(
      'SELECT person_id, disabled_at FROM staff_account WHERE id = $1 FOR UPDATE',
      [staffId],
    );
    const row = rows[0];
    if (!row) throw new ValidationError('unknown staff account');
    if ((row.disabled_at !== null) === disabled) return { personId: row.person_id, changed: false };
    await tx.query(
      `UPDATE staff_account SET disabled_at = ${disabled ? 'now()' : 'NULL'}, failed_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [staffId],
    );
    if (disabled) {
      await tx.query('UPDATE auth_session SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [staffId]);
    }
    return { personId: row.person_id, changed: true };
  }

  private secretOf(row: StaffRow): Buffer {
    return base32Decode(openString(this.deps.secrets.dataKey, row.totp_secret_enc, totpAad(row.id)));
  }

  private async checkTotp(tx: Queryable, row: StaffRow, code: string): Promise<boolean> {
    const secret = this.secretOf(row);
    const last = row.totp_last_step === null ? null : BigInt(row.totp_last_step);
    const step = verifyTotp(secret, code, this.clock(), last);
    if (step === null) return false;
    await tx.query('UPDATE staff_account SET totp_last_step = $2::bigint, updated_at = now() WHERE id = $1', [
      row.id,
      step.toString(),
    ]);
    return true;
  }

  async login(input: { login: string; password: string; totp: string; ip?: string; device?: string }): Promise<IssuedSession> {
    const now = this.clock();
    type Outcome = { ok: true; session: IssuedSession } | { ok: false; reason: string; staffId?: string };
    const outcome = await this.deps.db.transaction(async (tx): Promise<Outcome> => {
      const { rows } = await tx.query<StaffRow>(
        `SELECT id, person_id, staff_role, password_hash, totp_secret_enc, totp_last_step::text AS totp_last_step,
                failed_attempts, locked_until, disabled_at
           FROM staff_account WHERE login = $1 FOR UPDATE`,
        [input.login],
      );
      const row = rows[0];
      if (!row) {
        await burnPasswordCheck(input.password);
        return { ok: false, reason: 'BAD_CREDENTIALS' };
      }
      if (row.disabled_at) return { ok: false, reason: 'DISABLED', staffId: row.id };
      if (row.locked_until && row.locked_until.getTime() > now.getTime()) return { ok: false, reason: 'LOCKED', staffId: row.id };

      const passOk = await verifyPassword(input.password, row.password_hash);
      const totpOk = passOk && (await this.checkTotp(tx, row, input.totp));
      if (!passOk || !totpOk) {
        const failures = row.failed_attempts + 1;
        const lock = failures >= AUTH_LIMITS.staffMaxFailures ? new Date(now.getTime() + AUTH_LIMITS.staffLockMs) : null;
        await tx.query(
          'UPDATE staff_account SET failed_attempts = $2, locked_until = $3, updated_at = now() WHERE id = $1',
          [row.id, lock ? 0 : failures, lock?.toISOString() ?? null],
        );
        return { ok: false, reason: passOk ? 'BAD_TOTP' : 'BAD_CREDENTIALS', staffId: row.id };
      }
      await tx.query('UPDATE staff_account SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1', [
        row.id,
      ]);
      const session = await createSession(
        tx,
        {
          personId: row.person_id,
          kind: 'STAFF',
          channel: 'ADMIN',
          staffId: row.id,
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.device ? { device: input.device } : {}),
        },
        now,
      );
      await this.deps.audit.record(
        this.event({
          action: 'identity.staff_login',
          actorId: row.person_id,
          actorRole: row.staff_role,
          channel: 'ADMIN',
          sessionRef: session.sessionId,
          subjectType: 'staff_account',
          subjectId: row.id,
          authzResult: 'ALLOWED',
          reasonCode: 'PASSWORD_TOTP_OK',
          ...(input.ip ? { ip: input.ip } : {}),
          ...(input.device ? { device: input.device } : {}),
        }),
        tx,
      );
      return { ok: true, session };
    });

    if (!outcome.ok) {
      await this.deps.audit.record(
        this.event({
          action: 'identity.staff_login',
          actorId: 'anonymous',
          actorRole: 'ANONYMOUS',
          channel: 'ADMIN',
          subjectType: 'staff_account',
          subjectId: outcome.staffId ?? 'unknown',
          authzResult: 'DENIED',
          reasonCode: outcome.reason,
          ...(input.ip ? { ip: input.ip } : {}),
        }),
      );
      throw new AuthenticationError(outcome.reason);
    }
    return outcome.session;
  }

  /** Staff step-up: a fresh TOTP code → single-use grant for one action + subject. */
  async stepUp(actor: Actor, code: string, target: StepUpTarget): Promise<{ stepUpToken: string; expiresAt: Date }> {
    if (actor.kind !== 'STAFF' || !actor.sessionId || !actor.mfa) throw new ForbiddenError('STAFF_SESSION_REQUIRED');
    if (!isAction(target.action) || !STEP_UP_ACTIONS.has(target.action)) throw new ValidationError('action needs no step-up');
    const sessionId = actor.sessionId;
    const grant = await this.deps.db.transaction(async (tx) => {
      const { rows } = await tx.query<StaffRow>(
        `SELECT st.id, st.person_id, st.staff_role, st.password_hash, st.totp_secret_enc,
                st.totp_last_step::text AS totp_last_step, st.failed_attempts, st.locked_until, st.disabled_at
           FROM staff_account st JOIN auth_session s ON s.staff_id = st.id
          WHERE s.id = $1 FOR UPDATE OF st`,
        [sessionId],
      );
      const row = rows[0];
      if (!row || row.disabled_at || !(await this.checkTotp(tx, row, code))) return null;
      const g = await issueStepUpGrant(tx, sessionId, target, this.clock());
      await this.deps.audit.record(
        this.event({
          action: 'identity.step_up',
          actorId: actor.personId,
          actorRole: row.staff_role,
          channel: actor.channel,
          sessionRef: sessionId,
          subjectType: target.subjectType,
          subjectId: target.subjectId,
          authzResult: 'ALLOWED',
          reasonCode: target.action,
        }),
        tx,
      );
      return g;
    });
    if (!grant) {
      await this.deps.audit.record(
        this.event({
          action: 'identity.step_up',
          actorId: actor.personId,
          actorRole: actor.staffRole ?? 'STAFF',
          channel: actor.channel,
          sessionRef: sessionId,
          subjectType: target.subjectType,
          subjectId: target.subjectId,
          authzResult: 'DENIED',
          reasonCode: 'BAD_TOTP',
        }),
      );
      throw new AuthenticationError('BAD_TOTP');
    }
    return grant;
  }
}
