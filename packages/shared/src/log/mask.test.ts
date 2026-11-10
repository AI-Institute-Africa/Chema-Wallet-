import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';
import { REDACTED, maskDeep, maskString } from './mask';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('maskString', () => {
  it.each([
    ['call +263771234567 now', 'call ***567 now'],
    ['local 0771234567', 'local ***567'],
    ['spaced +263 77 123 4567', 'spaced ***567'],
    ['card 4111-1111-1111-1111', 'card ***111'],
  ])('masks digit runs: %s', (input, expected) => {
    expect(maskString(input)).toBe(expected);
  });

  it('masks emails keeping first char and domain', () => {
    expect(maskString('mail tino.moyo@example.co.zw')).toBe('mail t***@example.co.zw');
  });

  it('masks bearer tokens', () => {
    expect(maskString('Authorization: Bearer abc.def.ghi')).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('leaves uuids, short numbers and ordinary text alone', () => {
    const s = 'req 0b9e2f1a-1234-5678-9abc-123456789012 took 1234 ms';
    expect(maskString(s)).toBe(s);
  });
});

describe('maskDeep', () => {
  it('redacts sensitive keys at any depth', () => {
    expect(maskDeep({ user: { pin: '1234', otp: '998877', name: 'Tino' }, password: 'x' })).toEqual({
      user: { pin: REDACTED, otp: REDACTED, name: 'Tino' },
      password: REDACTED,
    });
  });

  it('redacts P01 auth fields (OTP codes, session/step-up tokens, TOTP, key material)', () => {
    const input = {
      otpCode: '123456',
      totp: '654321',
      sessionToken: 'abc',
      stepUpToken: 'def',
      totpSecret: 'JBSWY3DP',
      newPassword: 'pw',
      code_hash: 'h',
      key_wrap: 'k',
      dataBase64: 'JVBERi0',
      challengeId: 'c-1',
      authzResult: 'ALLOWED',
    };
    expect(maskDeep(input)).toEqual({
      otpCode: REDACTED,
      totp: REDACTED,
      sessionToken: REDACTED,
      stepUpToken: REDACTED,
      totpSecret: REDACTED,
      newPassword: REDACTED,
      code_hash: REDACTED,
      key_wrap: REDACTED,
      dataBase64: REDACTED,
      challengeId: 'c-1',
      authzResult: 'ALLOWED',
    });
  });
});

describe('logger', () => {
  it('never writes raw phone, email or secrets', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.info({ phone: '+263771234567', contact: 'tino@example.com', otp: '123456' }, 'sent to +263771234567');
    const out = lines.join('');
    expect(out).not.toContain('771234567');
    expect(out).not.toContain('tino@example.com');
    expect(out).not.toContain('123456');
    expect(out).toContain('***567');
  });

  it('masks PII inside error messages', () => {
    const { lines, stream } = capture();
    createLogger('info', stream).error({ err: new Error('send to tino@example.com failed') }, 'boom');
    const out = lines.join('');
    expect(out).not.toContain('tino@example.com');
    expect(out).toContain('t***@example.com');
  });

  it('serializes request-like class instances without losing getters', () => {
    class Req {
      id = 'r1';
      get method() {
        return 'POST';
      }
      get url() {
        return '/x?msisdn=263771234567';
      }
    }
    const { lines, stream } = capture();
    createLogger('info', stream).info({ req: new Req() }, 'incoming');
    const out = lines.join('');
    expect(out).toContain('"method":"POST"');
    expect(out).toContain('"url":"/x?msisdn=[REDACTED]"');
  });
});
