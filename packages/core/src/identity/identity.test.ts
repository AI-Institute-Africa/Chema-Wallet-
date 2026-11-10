import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../audit/chain';
import { AuthenticationError, ForbiddenError, RateLimitedError, ValidationError } from '../errors';
import { createHarness, type Harness } from '../test-support';
import { AUTH_LIMITS } from './sessions';
import { base32Decode, hotp, totp, verifyTotp } from './totp';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

async function lastAudit(action: string) {
  const { rows } = await h.db.query<{ authz_result: string; reason_code: string | null; actor_id: string }>(
    'SELECT authz_result, reason_code, actor_id FROM audit_log WHERE action = $1 ORDER BY audit_log.seq DESC LIMIT 1',
    [action],
  );
  return rows[0];
}

describe('TOTP (RFC 6238 / RFC 4226 vectors)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');

  it('HOTP RFC 4226 appendix D', () => {
    const want = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    want.forEach((code, i) => expect(hotp(secret, BigInt(i))).toBe(code));
  });

  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('TOTP SHA1 at T=%i', (t, code) => {
    expect(totp(secret, new Date(t * 1000), 8)).toBe(code);
  });

  it('accepts ±1 step, rejects replay of an already-used step', () => {
    const at = new Date(1_700_000_000_000);
    const code = totp(secret, at);
    const step = verifyTotp(secret, code, at, null);
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, at, step)).toBeNull();
    expect(verifyTotp(secret, code, new Date(at.getTime() + 30_000), null)).toBe(step);
    expect(verifyTotp(secret, code, new Date(at.getTime() + 95_000), null)).toBeNull();
  });
});

describe('customer OTP login', () => {
  it('logs in, binds identity, creates a session, audits', async () => {
    const c = await h.customer('+263771000001');
    expect(c.actor).toMatchObject({ kind: 'CUSTOMER', personId: c.personId, mfa: false, channel: 'WEB' });
    const { rows } = await h.db.query('SELECT channel, handle, method FROM identity_binding WHERE person_id = $1', [c.personId]);
    expect(rows).toEqual([{ channel: 'WEB', handle: '+263771000001', method: 'OTP_SMS' }]);
    expect(await lastAudit('identity.login')).toMatchObject({ authz_result: 'ALLOWED', actor_id: c.personId });
  });

  it('second login for the same phone reuses the person', async () => {
    const a = await h.customer('+263771000002');
    h.advance(1000);
    const b = await h.customer('+263771000002');
    expect(b.personId).toBe(a.personId);
    expect(b.token).not.toBe(a.token);
  });

  it('stores only hashes: no code or token in the database', async () => {
    const { challengeId } = await h.auth.startLogin({ phone: '+263771000003', channel: 'WEB' });
    const code = h.otp.lastCodeFor('+263771000003')!;
    const s = await h.auth.verifyLogin({ challengeId, code });
    const dump = JSON.stringify((await h.db.query('SELECT * FROM otp_challenge')).rows) +
      JSON.stringify((await h.db.query('SELECT * FROM auth_session')).rows);
    expect(dump).not.toContain(s.token);
    expect(dump).not.toMatch(new RegExp(`"${code}"`));
  });

  it('rejects a wrong code and counts the attempt; locks after max attempts', async () => {
    const phone = '+263771000004';
    const { challengeId } = await h.auth.startLogin({ phone, channel: 'WEB' });
    const good = h.otp.lastCodeFor(phone)!;
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < AUTH_LIMITS.otpMaxAttempts; i++) {
      await expect(h.auth.verifyLogin({ challengeId, code: bad })).rejects.toBeInstanceOf(AuthenticationError);
    }
    await expect(h.auth.verifyLogin({ challengeId, code: good })).rejects.toMatchObject({ reason: 'TOO_MANY_ATTEMPTS' });
    expect(await lastAudit('identity.login')).toMatchObject({ authz_result: 'DENIED', reason_code: 'TOO_MANY_ATTEMPTS' });
  });

  it('rejects an expired code', async () => {
    const phone = '+263771000005';
    const { challengeId } = await h.auth.startLogin({ phone, channel: 'WEB' });
    h.advance(AUTH_LIMITS.otpTtlMs + 1);
    await expect(h.auth.verifyLogin({ challengeId, code: h.otp.lastCodeFor(phone)! })).rejects.toMatchObject({
      reason: 'CHALLENGE_EXPIRED',
    });
  });

  it('a code works once', async () => {
    const phone = '+263771000006';
    const { challengeId } = await h.auth.startLogin({ phone, channel: 'WEB' });
    const code = h.otp.lastCodeFor(phone)!;
    await h.auth.verifyLogin({ challengeId, code });
    await expect(h.auth.verifyLogin({ challengeId, code })).rejects.toMatchObject({ reason: 'CHALLENGE_USED' });
  });

  it('rate-limits OTP requests per phone', async () => {
    const phone = '+263771000007';
    for (let i = 0; i < AUTH_LIMITS.otpMaxPerWindow; i++) await h.auth.startLogin({ phone, channel: 'WEB' });
    await expect(h.auth.startLogin({ phone, channel: 'WEB' })).rejects.toBeInstanceOf(RateLimitedError);
    h.advance(AUTH_LIMITS.otpWindowMs + 1);
    await expect(h.auth.startLogin({ phone, channel: 'WEB' })).resolves.toHaveProperty('challengeId');
  });

  it('rejects non-E.164 phones and garbage challenge ids', async () => {
    await expect(h.auth.startLogin({ phone: '0771234567', channel: 'WEB' })).rejects.toBeInstanceOf(ValidationError);
    await expect(h.auth.verifyLogin({ challengeId: "x' OR 1=1 --", code: '123456' })).rejects.toMatchObject({ reason: 'NO_CHALLENGE' });
  });

  it('OTP delivery failure does not break the flow (challenge still issued)', async () => {
    h.otp.failNext = true;
    await expect(h.auth.startLogin({ phone: '+263771000008', channel: 'WEB' })).resolves.toHaveProperty('challengeId');
  });

  it('expired or revoked sessions do not authenticate', async () => {
    const c = await h.customer('+263771000009');
    await h.auth.logout(c.actor);
    expect(await h.auth.authenticate(c.token)).toBeNull();
    const d = await h.customer('+263771000010');
    h.advance(AUTH_LIMITS.customerSessionMs + 1);
    expect(await h.auth.authenticate(d.token)).toBeNull();
    expect(await h.auth.authenticate('not-a-real-token-at-all')).toBeNull();
  });
});

describe('customer step-up', () => {
  const target = { action: 'payout.request' as const, subjectType: 'wallet', subjectId: 'w-1' };

  it('issues a grant bound to session + action + subject, single use', async () => {
    const c = await h.customer('+263772000001');
    const { challengeId } = await h.auth.startStepUp(c.actor, target);
    const { stepUpToken } = await h.auth.verifyStepUp(c.actor, challengeId, h.otp.lastCodeFor('+263772000001')!);

    const grants = (await import('./sessions')).StepUpGrants;
    const g = new grants(h.now);
    const subject = { type: 'wallet', id: 'w-1' };
    // wrong action / wrong subject / other session: refused, grant untouched
    expect(await h.db.transaction((tx) => g.consume(tx, c.actor, stepUpToken, 'wallet.replace_admin', subject))).toBe(false);
    expect(await h.db.transaction((tx) => g.consume(tx, c.actor, stepUpToken, 'payout.request', { type: 'wallet', id: 'w-2' }))).toBe(false);
    const other = await h.customer('+263772000002');
    expect(await h.db.transaction((tx) => g.consume(tx, other.actor, stepUpToken, 'payout.request', subject))).toBe(false);
    // right one: once
    expect(await h.db.transaction((tx) => g.consume(tx, c.actor, stepUpToken, 'payout.request', subject))).toBe(true);
    expect(await h.db.transaction((tx) => g.consume(tx, c.actor, stepUpToken, 'payout.request', subject))).toBe(false);
  });

  it('expires', async () => {
    const c = await h.customer('+263772000003');
    const { challengeId } = await h.auth.startStepUp(c.actor, target);
    const { stepUpToken } = await h.auth.verifyStepUp(c.actor, challengeId, h.otp.lastCodeFor('+263772000003')!);
    h.advance(AUTH_LIMITS.stepUpTtlMs + 1);
    const { StepUpGrants } = await import('./sessions');
    expect(
      await h.db.transaction((tx) => new StepUpGrants(h.now).consume(tx, c.actor, stepUpToken, 'payout.request', { type: 'wallet', id: 'w-1' })),
    ).toBe(false);
  });

  it('a step-up code cannot be redeemed from another session', async () => {
    const c = await h.customer('+263772000004');
    const { challengeId } = await h.auth.startStepUp(c.actor, target);
    const code = h.otp.lastCodeFor('+263772000004')!;
    h.advance(1000);
    const again = await h.customer('+263772000004');
    await expect(h.auth.verifyStepUp(again.actor, challengeId, code)).rejects.toMatchObject({
      reason: 'WRONG_SESSION',
    });
  });

  it('refuses step-up for actions that do not need it', async () => {
    const c = await h.customer('+263772000005');
    await expect(h.auth.startStepUp(c.actor, { action: 'consent.manage', subjectType: 'person', subjectId: c.personId })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('staff auth (password + TOTP)', () => {
  it('logs in with MFA; session carries role + mfa', async () => {
    const s = await h.staff('OPS_FINANCE');
    expect(s.actor).toMatchObject({ kind: 'STAFF', staffRole: 'OPS_FINANCE', mfa: true, channel: 'ADMIN' });
  });

  it('wrong TOTP, wrong password and replayed TOTP are refused', async () => {
    const s = await h.staff('AUDITOR');
    const code = h.totpFor(s.secret);
    await h.staffAuth.login({ login: s.login, password: s.password, totp: code });
    await expect(h.staffAuth.login({ login: s.login, password: s.password, totp: code })).rejects.toMatchObject({ reason: 'BAD_TOTP' });
    await expect(h.staffAuth.login({ login: s.login, password: 'wrong password here', totp: h.totpFor(s.secret) })).rejects.toMatchObject({
      reason: 'BAD_CREDENTIALS',
    });
    await expect(h.staffAuth.login({ login: 'nobody.here', password: s.password, totp: '123456' })).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('locks the account after repeated failures', async () => {
    const s = await h.staff('CLAIMS_OFFICER');
    for (let i = 0; i < AUTH_LIMITS.staffMaxFailures; i++) {
      await expect(h.staffAuth.login({ login: s.login, password: 'definitely wrong!!', totp: '000000' })).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    }
    await expect(h.staffAuth.login({ login: s.login, password: s.password, totp: h.totpFor(s.secret) })).rejects.toMatchObject({
      reason: 'LOCKED',
    });
    h.advance(AUTH_LIMITS.staffLockMs + 1);
    await expect(h.staffAuth.login({ login: s.login, password: s.password, totp: h.totpFor(s.secret) })).resolves.toHaveProperty('token');
  });

  it('TOTP seed is encrypted at rest', async () => {
    const s = await h.staff('FIDELITY_ADMIN');
    const { rows } = await h.db.query<{ totp_secret_enc: string }>('SELECT totp_secret_enc FROM staff_account WHERE login = $1', [s.login]);
    expect(rows[0]!.totp_secret_enc).not.toContain(s.secret);
    expect(base32Decode(s.secret)).toHaveLength(20);
  });

  it('disabled staff sessions stop authenticating immediately', async () => {
    const s = await h.staff('AGENT');
    await h.db.query('UPDATE staff_account SET disabled_at = now() WHERE login = $1', [s.login]);
    expect(await h.auth.authenticate(s.token)).toBeNull();
  });

  it('staff step-up uses a fresh TOTP and is refused for customers', async () => {
    const s = await h.staff('FIDELITY_ADMIN');
    const target = { action: 'wallet.replace_admin' as const, subjectType: 'wallet', subjectId: 'w-9' };
    await expect(h.staffAuth.stepUp(s.actor, h.totpFor(s.secret), target)).resolves.toHaveProperty('stepUpToken');
    const c = await h.customer();
    await expect(h.staffAuth.stepUp(c.actor, '123456', target)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('identity audit trail', () => {
  it('every login/step-up outcome is in an intact chain', async () => {
    expect(await verifyChain(h.db)).toMatchObject({ ok: true });
    const { rows } = await h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'identity.%' AND authz_result = 'DENIED'",
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});
