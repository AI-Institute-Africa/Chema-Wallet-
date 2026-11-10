// Public surface (docs/05 Public activation): read-only, no login, ACTIVE only.
// Every other status — and an unknown slug — is the same NotFoundError (404).
import type { Locale, Queryable } from '@chema/shared';
import { badgeFor, publicUrl, qrSvg, shareLinks } from './activation';
import { loadPublicWallet } from './commands';
import type { PublicWalletView } from './types';

export async function publicWalletView(q: Queryable, slug: string, baseUrl: string, locale: Locale = 'en'): Promise<PublicWalletView> {
  const w = await loadPublicWallet(q, slug);
  const url = publicUrl(baseUrl, slug);
  return {
    slug,
    deceasedName: w.deceased_name,
    funeralDate: w.funeral_date,
    badge: badgeFor(locale),
    share: shareLinks(w.deceased_name, url, locale),
  };
}

export async function publicWalletQr(q: Queryable, slug: string, baseUrl: string): Promise<string> {
  await loadPublicWallet(q, slug);
  return qrSvg(publicUrl(baseUrl, slug));
}
