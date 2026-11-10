// Keys and capabilities for contributions. Every key is derived from the
// platform secrets with its own label, so one key never serves two purposes.
import { hmacHex, safeEqual, type Secrets } from '@chema/core';
import { createHmac } from 'node:crypto';

export interface ContributionKeys {
  /** Signs contribution links (receipt / status / tribute management). */
  link: Buffer;
  /** Keyed hash of payer phone numbers (AML lookups without plaintext). */
  phone: Buffer;
  /** Seals KYC + contact data (AES-256-GCM). */
  data: Buffer;
}

const derive = (key: Buffer, label: string) => createHmac('sha256', key).update(`chema:${label}:v1`).digest();

export function contributionKeys(secrets: Secrets): ContributionKeys {
  return {
    link: derive(secrets.authKey, 'contribution-link'),
    phone: derive(secrets.authKey, 'contribution-phone'),
    data: derive(secrets.dataKey, 'contribution-data'),
  };
}

/**
 * Capability for one contribution: HMAC over its id. It is never stored, so a
 * database leak gives no links. Carried in the URL fragment (`/c/<id>#t=…`),
 * which browsers never send to a server or put in a Referer.
 */
export function linkToken(keys: ContributionKeys, contributionId: string): string {
  return createHmac('sha256', keys.link).update(`contribution:${contributionId}`).digest('base64url');
}

export function linkTokenValid(keys: ContributionKeys, contributionId: string, token: string | undefined): boolean {
  if (!token || token.length > 100) return false;
  return safeEqual(linkToken(keys, contributionId), token);
}

export function phoneHash(keys: ContributionKeys, e164: string): string {
  return hmacHex(keys.phone, e164);
}
