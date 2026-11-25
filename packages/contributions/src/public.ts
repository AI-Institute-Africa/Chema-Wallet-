// Public page (docs/06): read-only, no login, ACTIVE wallets only (anything
// else is the same 404 as an unknown slug). Privacy is applied HERE, on the
// server: a hidden field is never sent to the browser, not even as null-ish
// placeholders the client is trusted to hide.
import { ConflictError, NotFoundError, type FlagService } from '@chema/core';
import { getBalances } from '@chema/ledger';
import { disclosureOf, quoteFees, type FeeDisclosure, type RailRegistry } from '@chema/payments';
import { money, parseMinor, t, type Currency, type Locale, type Money, type Queryable } from '@chema/shared';
import { badgeFor, loadPublicWallet, loadPublicWalletPage, publicUrl, shareLinks, type WalletRow } from '@chema/wallet';
import { privacyOf, type PrivacySettings, type PublicPageView, type PublicTribute } from './types';

export interface PublicDeps {
  flags: FlagService;
  rails: RailRegistry;
  publicBaseUrl: string;
}

interface PublicExtras {
  privacy: unknown;
  photo_doc: string | null;
  photo_consent_id: string | null;
}

async function extras(q: Queryable, walletId: string): Promise<PublicExtras> {
  const { rows } = await q.query<PublicExtras>('SELECT privacy, photo_doc, photo_consent_id FROM wallet WHERE id = $1', [walletId]);
  if (!rows[0]) throw new NotFoundError('wallet', 'public');
  return rows[0];
}

/**
 * Total received, derived from the ledger on every read (never a cached
 * counter): contribution credits to the wallet's community + group
 * sub-ledgers, less refunds and chargebacks. Payouts do not lower it.
 */
export async function raisedTotal(q: Queryable, walletId: string, ccy: Currency): Promise<Money> {
  const { rows } = await q.query<{ raised: string }>(
    `SELECT COALESCE(sum(CASE e.side WHEN 'C' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS raised
       FROM ledger_account a
       JOIN ledger_entry e ON e.account_id = a.id
       JOIN ledger_journal j ON j.id = e.journal_id
      WHERE a.wallet_id = $1 AND a.currency = $2 AND a.kind IN ('COMMUNITY', 'GROUP')
        AND j.kind IN ('CONTRIBUTION', 'REFUND', 'CHARGEBACK')`,
    [walletId, ccy],
  );
  return money(parseMinor(rows[0]?.raised ?? '0'), ccy);
}

async function paidOut(q: Queryable, walletId: string, ccy: Currency): Promise<Money> {
  let total = 0n;
  for (const b of await getBalances(q, walletId)) {
    if (b.account.currency === ccy && (b.account.kind === 'COMMUNITY' || b.account.kind === 'GROUP')) total += b.paid.minor;
  }
  return money(total, ccy);
}

/**
 * Contributor-facing usage summary (docs/08): confirmed payouts from the
 * community/group money, by purpose only — no payee, number or date. Reversed
 * payouts are not counted.
 */
async function usageByPurpose(q: Queryable, walletId: string, ccy: Currency): Promise<{ purpose: string; amount: Money }[]> {
  const { rows } = await q.query<{ purpose: string; total: string }>(
    `SELECT purpose, sum(amount_minor)::text AS total FROM payout_request
      WHERE wallet_id = $1 AND currency = $2 AND status = 'CONFIRMED' AND source_kind IN ('COMMUNITY', 'GROUP')
      GROUP BY purpose ORDER BY purpose`,
    [walletId, ccy],
  );
  return rows.map((r) => ({ purpose: r.purpose, amount: money(parseMinor(r.total), ccy) }));
}

/**
 * Dated list behind the purpose totals ("12 Nov · Funeral parlour · $700"):
 * confirmed community/group payouts, newest first. Purpose, amount and the
 * confirmation date ONLY — never the payee, number or the family's note.
 */
async function usagePayouts(q: Queryable, walletId: string, ccy: Currency): Promise<{ purpose: string; amount: Money; at: string }[]> {
  const { rows } = await q.query<{ purpose: string; amount_minor: string; confirmed_at: Date }>(
    `SELECT purpose, amount_minor::text AS amount_minor, confirmed_at FROM payout_request
      WHERE wallet_id = $1 AND currency = $2 AND status = 'CONFIRMED' AND source_kind IN ('COMMUNITY', 'GROUP')
        AND confirmed_at IS NOT NULL
      ORDER BY confirmed_at DESC LIMIT 50`,
    [walletId, ccy],
  );
  return rows.map((r) => ({ purpose: r.purpose, amount: money(parseMinor(r.amount_minor), ccy), at: new Date(r.confirmed_at).toISOString() }));
}

/** A photo is public only with live consent AND the family's showPhoto toggle. */
export async function photoVisible(q: Queryable, x: PublicExtras, p: PrivacySettings): Promise<boolean> {
  if (!p.showPhoto || !x.photo_doc || !x.photo_consent_id) return false;
  const { rows } = await q.query('SELECT 1 FROM consent_record WHERE id = $1 AND withdrawn_at IS NULL', [x.photo_consent_id]);
  return rows.length > 0;
}

interface TributeRow {
  id: string;
  message: string;
  published_at: Date;
  anonymous: boolean;
  display_name: string | null;
  group_name: string | null;
  fee_payer: 'CONTRIBUTOR' | 'WALLET' | null;
  gross_minor: string | null;
  net_minor: string | null;
  currency: Currency;
}

export async function publicTributes(
  q: Queryable,
  w: Pick<WalletRow, 'id'>,
  p: PrivacySettings,
  opts: { before?: Date; limit?: number; locale?: Locale } = {},
): Promise<PublicTribute[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  // Newest first. Never ordered or filtered by amount (docs/06 Dignity rules).
  const { rows } = await q.query<TributeRow>(
    `SELECT t.id, t.message, t.published_at, c.anonymous, c.display_name, g.name AS group_name,
            p.fee_payer, r.gross_minor::text AS gross_minor, r.net_minor::text AS net_minor, p.currency
       FROM tribute t
       JOIN contribution c ON c.id = t.contribution_id
       JOIN payment p ON p.id = c.payment_id
       LEFT JOIN receipt r ON r.payment_id = p.id
       LEFT JOIN contribution_group g ON g.id = c.group_id
      WHERE t.wallet_id = $1 AND t.status = 'VISIBLE' AND ($2::timestamptz IS NULL OR t.published_at < $2)
      ORDER BY t.published_at DESC, t.id DESC
      LIMIT $3`,
    [w.id, opts.before?.toISOString() ?? null, limit],
  );
  const anon = t('contribution.anonymous_name', {}, opts.locale ?? 'en');
  return rows.map((r) => {
    const name = r.group_name ?? (r.anonymous || !p.showContributorNames || !r.display_name ? anon : r.display_name);
    // The gift as the contributor gave it: net when they paid the fee on top, gross when the wallet bore it.
    const gift = r.gross_minor && r.net_minor ? (r.fee_payer === 'CONTRIBUTOR' ? r.net_minor : r.gross_minor) : null;
    return {
      id: r.id,
      name,
      amount: p.showAmounts && gift ? money(parseMinor(gift), r.currency) : null,
      message: r.message,
      at: new Date(r.published_at).toISOString(),
    };
  });
}

export async function contributionLimits(q: Queryable, flags: FlagService, ccy: Currency): Promise<{ min: Money; max: Money | null }> {
  const min = await flags.getIn(q, ccy === 'USD' ? 'contribution.min_minor.usd' : 'contribution.min_minor.zwg');
  const max = await flags.getIn(q, ccy === 'USD' ? 'contribution.max_minor.usd' : 'contribution.max_minor.zwg');
  return { min: money(min ?? 1n, ccy), max: max === null ? null : money(max, ccy) };
}

export async function publicPage(q: Queryable, deps: PublicDeps, slug: string, locale: Locale = 'en'): Promise<PublicPageView> {
  const w = await loadPublicWalletPage(q, slug);
  const closed = w.status !== 'ACTIVE';
  const x = await extras(q, w.id);
  const p = privacyOf(x.privacy);
  const url = publicUrl(deps.publicBaseUrl, slug);
  const ccy = w.currency;
  const limits = await contributionLimits(q, deps.flags, ccy);
  return {
    slug,
    deceasedName: w.deceased_name,
    dateOfDeath: w.date_of_death,
    funeralDate: w.funeral_date,
    funeralLocation: w.funeral_location,
    badge: badgeFor(locale),
    share: shareLinks(w.deceased_name, url, locale),
    photoPath: (await photoVisible(q, x, p)) ? `/public/wallets/${slug}/photo` : null,
    totals: p.showTotal
      ? { raised: await raisedTotal(q, w.id, ccy), target: w.target_minor ? money(parseMinor(w.target_minor), ccy) : null }
      : null,
    closed,
    usage: p.showUsageSummary
      ? { paidOut: await paidOut(q, w.id, ccy), byPurpose: await usageByPurpose(q, w.id, ccy), payouts: await usagePayouts(q, w.id, ccy) }
      : null,
    tributes: p.showTributes ? await publicTributes(q, w, p, { locale }) : null,
    contribute: {
      currency: ccy,
      // No ceiling agreed ⇒ no rails offered: the page shows that contributions are not open.
      rails: !closed && (await deps.flags.getIn(q, 'contributions.enabled')) && limits.max ? await deps.rails.listCollectable(q) : [],
      min: limits.min,
      max: limits.max,
      groupsEnabled: await deps.flags.getIn(q, 'feature.group_contributions'),
    },
    ...(p.showPolicyNumber ? await policyRef(q, w.id) : {}),
  };
}

/** The policy number the family recorded (draft or claim lookup), as a public reference. */
async function policyRef(q: Queryable, walletId: string): Promise<{ policy?: { insurer: string; number: string } }> {
  const { rows } = await q.query<{ policy_no: string | null }>('SELECT policy_no FROM fidelity_link WHERE wallet_id = $1', [walletId]);
  const number = rows[0]?.policy_no;
  return number ? { policy: { insurer: 'Fidelity Life Assurance', number } } : {};
}

/** Live total endpoint: only when the family shows the total. */
export async function publicTotal(q: Queryable, slug: string): Promise<{ raised: Money; target: Money | null } | null> {
  const w = await loadPublicWallet(q, slug);
  const p = privacyOf((await extras(q, w.id)).privacy);
  if (!p.showTotal) return null;
  return { raised: await raisedTotal(q, w.id, w.currency), target: w.target_minor ? money(parseMinor(w.target_minor), w.currency) : null };
}

/** Document id of the public photo, or NotFound (same 404 for every reason). */
export async function publicPhotoDoc(q: Queryable, slug: string): Promise<string> {
  const w = await loadPublicWallet(q, slug);
  const x = await extras(q, w.id);
  if (!(await photoVisible(q, x, privacyOf(x.privacy))) || !x.photo_doc) throw new NotFoundError('wallet', 'public');
  return x.photo_doc;
}

export async function publicTributesBySlug(q: Queryable, slug: string, opts: { before?: Date; limit?: number } = {}): Promise<PublicTribute[] | null> {
  const w = await loadPublicWallet(q, slug);
  const p = privacyOf((await extras(q, w.id)).privacy);
  return p.showTributes ? publicTributes(q, w, p, opts) : null;
}

/**
 * Pre-payment disclosure (docs/04 §6, docs/06 Contribute 2): total charged,
 * fee payer, fee, FX, expected credit, computed by the same quoteFees the
 * payment will use. Writes nothing.
 */
export async function publicQuote(q: Queryable, deps: PublicDeps, slug: string, rail: string, amount: Money, now: Date): Promise<FeeDisclosure> {
  const w = await loadPublicWallet(q, slug);
  if (amount.ccy !== w.currency) throw new ConflictError('CURRENCY_NOT_ACCEPTED');
  if (!(await deps.rails.collectable(q, rail))) throw new NotFoundError('rail', rail);
  const limits = await contributionLimits(q, deps.flags, w.currency);
  if (limits.max === null) throw new ConflictError('CONTRIBUTION_LIMITS_NOT_CONFIGURED');
  if (amount.minor < limits.min.minor) throw new ConflictError('AMOUNT_BELOW_MINIMUM');
  if (amount.minor > limits.max.minor) throw new ConflictError('AMOUNT_ABOVE_MAXIMUM');
  return disclosureOf(await quoteFees(q, deps.flags, rail, amount, now));
}
