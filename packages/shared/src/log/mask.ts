// PII masking for logs and any text leaving the system boundary.
// Two layers: sensitive KEYS are fully redacted; free-text VALUES have
// emails, phone/account/card-like digit runs and bearer tokens masked.

// Exact names, plus anything ending in token/secret/password (stepUpToken,
// totpSecret, newPassword...) — P01 auth adds many such fields.
const SENSITIVE_KEY =
  /^(password|passwd|pass|pin|otp|totp|otp_?code|cvv|cvc|secret|token|access_token|refresh_token|api_?key|authorization|cookie|set-cookie|card(_?number)?|pan|id_?number|national_?id|code_?hash|password_?hash|totp_?secret_?enc|key_?wrap|data_?base64)$|(token|secret|password)$/i;

export const REDACTED = '[REDACTED]';

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// 8+ digits, optionally with +, spaces or hyphens between (E.164, local ZW
// numbers, card/account numbers). Not touching runs embedded in words/uuids.
const DIGIT_RUN = /(?<![\w-])\+?\d(?:[\s-]?\d){7,}(?![\w-])/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

export function maskString(input: string): string {
  return input
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(DIGIT_RUN, (run) => {
      const digits = run.replace(/\D/g, '');
      return `***${digits.slice(-3)}`;
    });
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Masks strings inside plain objects/arrays. Class instances (requests,
 * responses, errors) are passed through untouched: their dedicated pino
 * serializers produce masked plain objects, and walking them here would drop
 * prototype getters before those serializers run.
 */
export function maskDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH]';
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? REDACTED : maskDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}
