// HMAC-SHA256 webhook signatures with a timestamp window (docs/04 §4).
// Signed string = `${timestamp}.${rawBody}`; header `x-chema-signature: v1=<hex>`.
// Real providers each have their own scheme; their adapters implement it and
// reuse only the constant-time compare and the window check.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookRejectedError } from './errors';

export const SIGNATURE_HEADER = 'x-chema-signature';
export const TIMESTAMP_HEADER = 'x-chema-timestamp';
/** Callbacks older or newer than this are refused (replays outside the cache horizon). */
export const WEBHOOK_WINDOW_MS = 5 * 60 * 1000;

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Throws WebhookRejectedError unless the signature is valid and fresh. */
export function verifySignature(
  secret: string,
  headers: Readonly<Record<string, string | undefined>>,
  rawBody: string,
  now: Date,
  windowMs = WEBHOOK_WINDOW_MS,
): void {
  const sig = headers[SIGNATURE_HEADER];
  const ts = headers[TIMESTAMP_HEADER];
  if (!sig || !ts) throw new WebhookRejectedError('MISSING_SIGNATURE');
  // Check the signature first so an attacker learns nothing from timing of the window check.
  if (!constantTimeEqual(sign(secret, ts, rawBody), sig)) throw new WebhookRejectedError('BAD_SIGNATURE');
  if (!/^\d{10,13}$/.test(ts)) throw new WebhookRejectedError('MALFORMED');
  const sentMs = ts.length === 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(now.getTime() - sentMs) > windowMs) throw new WebhookRejectedError('STALE_TIMESTAMP');
}
