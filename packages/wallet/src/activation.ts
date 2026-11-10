// Public activation (docs/05): unguessable slug, QR, localised share text, badge.
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { base32Encode, sha256Hex } from '@chema/core';
import { t, type Locale } from '@chema/shared';
import type { Badge, ShareLinks } from './types';

/** 128 random bits, base32 lowercase (26 chars). Never derived from wallet data. */
export function newPublicSlug(): string {
  return base32Encode(randomBytes(16)).toLowerCase();
}

export const SLUG_PATTERN = /^[a-z2-7]{26}$/;

export function publicUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/w/${slug}`;
}

export function badgeFor(locale: Locale = 'en'): Badge {
  return { label: t('badge.verified.label', {}, locale), tooltip: t('badge.verified.tooltip', {}, locale) };
}

export function shareLinks(deceasedName: string, url: string, locale: Locale = 'en'): ShareLinks {
  const text = t('share.message', { name: deceasedName, link: url }, locale);
  const enc = encodeURIComponent;
  return {
    text,
    url,
    whatsapp: `https://wa.me/?text=${enc(text)}`,
    sms: `sms:?body=${enc(text)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    copy: url,
  };
}

/** QR code for the public link as standalone SVG (generated on demand, not stored). */
export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}

/** Hash of a normalised certificate number: lets us match duplicates without storing it. */
export function certificateNumberHash(raw: string): string {
  const norm = raw.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (norm.length < 3) throw new RangeError('certificate number too short');
  return sha256Hex(`death-cert:${norm}`);
}
