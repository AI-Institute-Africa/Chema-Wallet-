import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevFileOtpProvider, MockOtpProvider } from '@chema/core';
import { describe, expect, it } from 'vitest';
import { chooseOtpProvider } from './otp';

describe('OTP provider choice', () => {
  it('defaults to the mock (codes go nowhere)', () => {
    expect(chooseOtpProvider({}).provider).toBeInstanceOf(MockOtpProvider);
  });

  it('refuses the dev file provider in production', () => {
    const c = chooseOtpProvider({ CHEMA_DEV_OTP_FILE: '/tmp/x', NODE_ENV: 'production' });
    expect(c.provider).toBeInstanceOf(MockOtpProvider);
    expect(c.warning).toMatch(/ignored/);
  });

  it('dev file provider appends one JSON line per code to the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chema-otp-'));
    const path = join(dir, 'otp.log');
    const c = chooseOtpProvider({ CHEMA_DEV_OTP_FILE: path, NODE_ENV: 'development' });
    expect(c.provider).toBeInstanceOf(DevFileOtpProvider);
    await c.provider.send({ phoneE164: '+263771000001', via: 'SMS' }, '123456');
    await c.provider.send({ phoneE164: '+263771000002', via: 'WHATSAPP' }, '654321');
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { phone: string; code: string });
    expect(lines.map((l) => [l.phone, l.code])).toEqual([
      ['+263771000001', '123456'],
      ['+263771000002', '654321'],
    ]);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
