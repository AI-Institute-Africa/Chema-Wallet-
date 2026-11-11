// Small pure helpers for the WhatsApp channel: keys, sealing, sensitive-input
// redaction, masking and input parsing. No I/O.
import { createHmac } from 'node:crypto';
import { hmacHex, seal, unseal, type Secrets } from '@chema/core';
import { money, type Currency, type Money } from '@chema/shared';

export interface WaKeys {
  /** Keyed hash of E.164 numbers (lookup without plaintext). */
  phone: Buffer;
  /** Seals phone numbers, bodies, conversation data and hand-off context. */
  data: Buffer;
}

const derive = (key: Buffer, label: string) => createHmac('sha256', key).update(`chema:${label}:v1`).digest();

export function waKeys(secrets: Secrets): WaKeys {
  return { phone: derive(secrets.authKey, 'wa-phone'), data: derive(secrets.dataKey, 'wa-data') };
}

export const phoneHashOf = (keys: WaKeys, e164: string) => hmacHex(keys.phone, e164);

export function sealText(keys: WaKeys, value: string, aad: string): string {
  return seal(keys.data, Buffer.from(value, 'utf8'), aad).toString('base64');
}

export function openText(keys: WaKeys, sealed: string, aad: string): string {
  return unseal(keys.data, Buffer.from(sealed, 'base64'), aad).toString('utf8');
}

// ── Sensitive input (docs/09: never ask/store PINs, passwords, card data, OTPs) ──

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Does this message look like a secret? Card-like numbers (13–19 digits,
 * Luhn-valid) and "pin/otp/code/password" followed by a value always do. A bare
 * 4–8 digit message does too, unless the conversation is waiting for an amount
 * (amounts are short numbers; codes and PINs are 4–8 digits).
 */
export function looksSensitive(text: string, expectingAmount: boolean): boolean {
  const t = text.trim();
  const compact = t.replace(/[\s-]/g, '');
  for (const m of compact.matchAll(/\d{13,19}/g)) if (luhn(m[0])) return true;
  // Digits must stand alone (\b both sides): a wallet code like "ab3k…" is not a secret.
  if (/\b(pin|otp|passcode|code|cvv)\b\D{0,12}\b\d{3,8}\b/i.test(t)) return true;
  if (/\b(password|pwd)\b\W{0,3}\S+/i.test(t)) return true;
  // Spaces only: "2026-11-05" is a date, not a code.
  if (!expectingAmount && /^\d{4,8}$/.test(t.replace(/\s/g, ''))) return true;
  return false;
}

// ── Masking + parsing ─────────────────────────────────────────────────────────

/** +263771234567 → +263•••••4567 */
export function maskPhone(e164: string): string {
  return e164.length <= 8 ? '•••' : `${e164.slice(0, 4)}${'•'.repeat(Math.max(3, e164.length - 8))}${e164.slice(-4)}`;
}

/** "12", "12.5", "12.50", "$12", "USD 12" → minor units; null if not a plain positive amount. */
export function parseAmount(text: string, ccy: Currency): Money | null {
  const t = text.trim().replace(/^(usd|zwg|zig|\$)\s*/i, '').replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const minor = BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return minor > 0n ? money(minor, ccy) : null;
}

/** Public wallet slug from a pasted link (…/w/<slug>) or the bare 26-character code. */
export function parseSlug(text: string): string | null {
  const m = /(?:^|\/w\/|\s)([a-z2-7]{26})(?:$|[\s/?#])/.exec(text.trim().toLowerCase());
  return m?.[1] ?? null;
}

export function parseDate(text: string): string | null {
  const t = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? null : t;
}

/** "1".."n" → 0-based index, else null. */
export function pick(text: string, n: number): number | null {
  const t = text.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const i = Number(t) - 1;
  return i >= 0 && i < n ? i : null;
}

export const isYes = (t: string) => /^(1|y|yes|ok|confirm|ehe|yebo)$/i.test(t.trim());
export const isNo = (t: string) => /^(2|n|no|kwete|hatshi)$/i.test(t.trim());
