// RFC 4226 HOTP / RFC 6238 TOTP over node:crypto (no dependency).
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgo = 'sha1' | 'sha256' | 'sha512';

export function hotp(secret: Buffer, counter: bigint, digits = 6, algo: TotpAlgo = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algo, secret).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export const TOTP_STEP_SECONDS = 30;

export function totpStep(at: Date): bigint {
  return BigInt(at.getTime()) / 1000n / BigInt(TOTP_STEP_SECONDS);
}

export function totp(secret: Buffer, at: Date, digits = 6, algo: TotpAlgo = 'sha1'): string {
  return hotp(secret, totpStep(at), digits, algo);
}

/**
 * Accepts the current step ±1 (clock drift). Returns the matched step, or null.
 * Callers must reject steps ≤ the last accepted step (replay protection).
 */
export function verifyTotp(secret: Buffer, code: string, at: Date, afterStep: bigint | null): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(at);
  for (const step of [now - 1n, now, now + 1n]) {
    if (afterStep !== null && step <= afterStep) continue;
    if (safeEqual(hotp(secret, step), code)) return step;
  }
  return null;
}

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

/** otpauth:// URI for authenticator-app enrolment (secret shown once). */
export function otpauthUri(issuer: string, account: string, secret: Buffer): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&period=${TOTP_STEP_SECONDS}&digits=6`;
}
