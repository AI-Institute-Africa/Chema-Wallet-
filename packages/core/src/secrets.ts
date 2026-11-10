// Runtime secrets. Production reads them from the secrets manager into env at
// deploy time (docs/10); nothing real is ever committed. Missing ⇒ fail loudly.
import { randomBytes } from 'node:crypto';

export interface Secrets {
  /** HMAC key for OTP codes. */
  readonly authKey: Buffer;
  /** Master key: wraps document data keys and encrypts TOTP seeds. */
  readonly dataKey: Buffer;
}

export class MissingSecretError extends Error {
  constructor(name: string, why: string) {
    super(`secret ${name} ${why} (expect base64 of 32 random bytes)`);
    this.name = 'MissingSecretError';
  }
}

function key32(env: Record<string, string | undefined>, name: string): Buffer {
  const raw = env[name];
  if (!raw) throw new MissingSecretError(name, 'is not set');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new MissingSecretError(name, 'is not 32 bytes');
  return buf;
}

export function loadSecrets(env: Record<string, string | undefined> = process.env): Secrets {
  return { authKey: key32(env, 'CHEMA_AUTH_SECRET'), dataKey: key32(env, 'CHEMA_DATA_KEY') };
}

/** Fresh random secrets for tests and local throwaway runs. */
export function ephemeralSecrets(): Secrets {
  return { authKey: randomBytes(32), dataKey: randomBytes(32) };
}
