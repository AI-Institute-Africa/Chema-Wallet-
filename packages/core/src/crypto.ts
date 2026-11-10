// Small crypto helpers over node:crypto. No secrets are ever logged or returned
// from here except the values callers explicitly ask for.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** URL-safe random token (default 32 bytes ⇒ 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of two equal-format strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Deterministic JSON: object keys sorted, undefined dropped, bigint as decimal
 * string, Date as ISO-8601. Used wherever a hash must be reproducible.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map((v) => normalise(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = normalise(v);
    }
    return out;
  }
  return value;
}

/** Hash of an arbitrary value for audit before/after fields (null stays null). */
export function valueHash(value: unknown): string | null {
  return value === undefined ? null : sha256Hex(canonicalJson(value));
}

// ── AES-256-GCM ────────────────────────────────────────────────────────────
// Format: base64(iv[12] ‖ tag[16] ‖ ciphertext). aad binds the ciphertext to
// its context (e.g. a document id) so blobs cannot be swapped between rows.

const IV_LEN = 12;
const TAG_LEN = 16;

export function assertKey(key: Buffer, name = 'key'): void {
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes`);
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  assertKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  assertKey(key);
  if (sealed.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
}

export function sealString(key: Buffer, plaintext: string, aad: string): string {
  return seal(key, Buffer.from(plaintext, 'utf8'), aad).toString('base64');
}

export function openString(key: Buffer, sealed: string, aad: string): string {
  return open(key, Buffer.from(sealed, 'base64'), aad).toString('utf8');
}

export function newDataKey(): Buffer {
  return randomBytes(32);
}
