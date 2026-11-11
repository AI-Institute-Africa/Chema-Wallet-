// Display helpers for the memorial page (UI redesign 2026-11-11). Pure, no
// floats: money stays in minor-unit strings / bigint end to end.
import { t } from '@chema/shared/i18n';
import type { MoneyJSON } from './public';

/** "145000" USD → "$1,450"; "145050" → "$1,450.50"; ZWG → "ZiG 1,450". Display only. */
export function moneyShort(m: MoneyJSON): string {
  const neg = m.minor.startsWith('-');
  const digits = m.minor.replace(/^-/, '').padStart(3, '0');
  const major = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
  const cents = digits.slice(-2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = cents === '00' ? grouped : `${grouped}.${cents}`;
  return `${neg ? '-' : ''}${m.ccy === 'USD' ? '$' : 'ZiG '}${body}`;
}

/** Remaining to target, or null once reached. */
export function toGo(raised: MoneyJSON, target: MoneyJSON): MoneyJSON | null {
  const left = BigInt(target.minor) - BigInt(raised.minor);
  return left > 0n ? { minor: left.toString(), ccy: target.ccy } : null;
}

/** Quick amounts (product decision 2026-11-11, overrides docs/06), in minor units. */
export const QUICK_AMOUNTS: Record<'USD' | 'ZWG', readonly bigint[]> = {
  USD: [5_00n, 10_00n, 20_00n, 50_00n],
  ZWG: [100_00n, 250_00n, 500_00n, 1_000_00n],
};

/** Chips the wallet actually accepts (server min/max). */
export function quickAmounts(ccy: 'USD' | 'ZWG', min: MoneyJSON, max: MoneyJSON | null): bigint[] {
  const lo = BigInt(min.minor);
  const hi = max ? BigInt(max.minor) : null;
  return QUICK_AMOUNTS[ccy].filter((v) => v >= lo && (hi === null || v <= hi));
}

/** 2000n → "20"; 1050n → "10.50" (for the amount box). */
export function minorToInput(minor: bigint): string {
  const s = minor.toString().padStart(3, '0');
  const cents = s.slice(-2);
  const major = s.slice(0, -2).replace(/^0+(?=\d)/, '');
  return cents === '00' ? major : `${major}.${cents}`;
}

/** "Chipo & Family" → "CF"; "Sympathetic Friend" → "SF". */
export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts).map((p) => (p ?? '').charAt(0).toUpperCase());
  return letters.join('') || '•';
}

/** "15 min ago" from ISO time; dates older than a week show as the date. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const sec = Math.trunc((now.getTime() - at.getTime()) / 1000);
  if (Number.isNaN(sec)) return '';
  if (sec < 60) return t('time.just_now');
  const min = Math.trunc(sec / 60);
  if (min < 60) return t('time.minutes', { n: String(min) });
  const h = Math.trunc(min / 60);
  if (h < 24) return t('time.hours', { n: String(h) });
  const d = Math.trunc(h / 24);
  if (d < 7) return t('time.days', { n: String(d) });
  return at.toISOString().slice(0, 10);
}

export const RAIL_NAMES: Record<string, string> = { ECOCASH: 'EcoCash', ONEMONEY: 'OneMoney', CARD: 'Card' };
export const railName = (r: string) => RAIL_NAMES[r] ?? r;

const RAIL_ORDER = ['ECOCASH', 'ONEMONEY', 'CARD'];
/** Mobile money first (most contributors), then card; unknown rails last. Only rails the API returned. */
export function orderRails(rails: readonly string[]): string[] {
  const rank = (r: string) => (RAIL_ORDER.includes(r) ? RAIL_ORDER.indexOf(r) : RAIL_ORDER.length);
  return [...rails].sort((a, b) => rank(a) - rank(b));
}
