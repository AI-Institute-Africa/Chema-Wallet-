// Public (no-login) API client: funeral page, quote, contribute, the signed
// contribution link. The link token lives in the URL fragment and is sent as
// the `x-contribution-token` header: never in a query string or a Referer.
import { ApiError, type Badge, type Fetch, type ShareLinks } from './api';

export interface MoneyJSON {
  minor: string;
  ccy: 'USD' | 'ZWG';
}

export interface PublicTribute {
  id: string;
  name: string;
  amount: MoneyJSON | null;
  message: string;
  at: string;
}

export interface PublicPage {
  slug: string;
  deceasedName: string;
  dateOfDeath: string;
  funeralDate: string | null;
  funeralLocation: string;
  badge: Badge;
  share: ShareLinks;
  photoPath: string | null;
  totals: { raised: MoneyJSON; target: MoneyJSON | null } | null;
  closed: boolean;
  usage: { paidOut: MoneyJSON; byPurpose: { purpose: string; amount: MoneyJSON }[] } | null;
  tributes: PublicTribute[] | null;
  contribute: { currency: 'USD' | 'ZWG'; rails: string[]; min: MoneyJSON; max: MoneyJSON | null; groupsEnabled: boolean };
  /** Only when the family chose to show it (privacy showPolicyNumber). A reference, not cover. */
  policy?: { insurer: string; number: string };
}

export interface Disclosure {
  totalCharged: MoneyJSON;
  feePayer: 'CONTRIBUTOR' | 'WALLET' | null;
  providerFee: MoneyJSON;
  fxRate: string | null;
  expectedCredit: MoneyJSON;
}

export type NextAction = { type: 'REDIRECT'; url: string } | { type: 'PROMPT'; message: string };

export interface ContributeResult {
  contributionId: string;
  accessToken: string;
  payment: { id: string; state: string; disclosure: Disclosure; next: NextAction | null };
  replayed: boolean;
}

export interface Receipt {
  receiptNo: string;
  funeralName: string;
  walletRef: string;
  paymentRef: string;
  rail: string;
  amount: MoneyJSON;
  fee: MoneyJSON;
  net: MoneyJSON;
  fxRate: string | null;
  issuedAt: string;
}

export interface ContributionView {
  id: string;
  funeralName: string;
  state: 'INITIATED' | 'PENDING_UNKNOWN' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'CHARGED_BACK';
  disclosure: Disclosure;
  next: NextAction | null;
  anonymous: boolean;
  displayName: string | null;
  tribute: { status: string; message: string | null; flagReasons: string[]; appealed: boolean } | null;
  receipt: Receipt | null;
}

export interface ContributeForm {
  rail: string;
  amount: MoneyJSON;
  payerName: string;
  payerPhone: string;
  anonymous: boolean;
  displayName?: string;
  tribute?: string;
  contact?: { kind: 'PHONE' | 'EMAIL'; value: string };
}

export const PRIVACY_KEYS = ['showTotal', 'showUsageSummary', 'showPhoto', 'showContributorNames', 'showAmounts', 'showTributes', 'showPolicyNumber'] as const;
export type Privacy = Record<(typeof PRIVACY_KEYS)[number], boolean>;

/** Display only: "1050" USD → "10.50 USD". Never parsed back. */
export function formatMoney(m: MoneyJSON): string {
  const digits = 2;
  const abs = m.minor.replace(/^-/, '').padStart(digits + 1, '0');
  return `${m.minor.startsWith('-') ? '-' : ''}${abs.slice(0, -digits)}.${abs.slice(-digits)} ${m.ccy}`;
}

/** Progress as a whole percent, capped at 100. BigInt maths: no float on money. */
export function progressPercent(raised: MoneyJSON, target: MoneyJSON): number {
  const t = BigInt(target.minor);
  if (t <= 0n) return 0;
  const p = (BigInt(raised.minor) * 100n) / t;
  return Number(p > 100n ? 100n : p);
}

/** `#t=<token>` → token. */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{20,100})/.exec(hash);
  return m?.[1] ?? null;
}

export function createPublicClient(opts: { baseUrl: string; fetch?: Fetch; token?: () => string | null }) {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const h: Record<string, string> = { ...headers };
    const session = opts.token?.();
    if (session) h['authorization'] = `Bearer ${session}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, { method, headers: h, cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, ((json ?? {}) as { error?: string }).error ?? 'error');
    return json as T;
  }
  const link = (token: string) => ({ 'x-contribution-token': token });
  const s = encodeURIComponent;

  return {
    page: (slug: string) => call<PublicPage>('GET', `/public/wallets/${s(slug)}`),
    total: (slug: string) => call<{ raised: MoneyJSON; target: MoneyJSON | null }>('GET', `/public/wallets/${s(slug)}/total`),
    quote: (slug: string, rail: string, amount: MoneyJSON) => call<Disclosure>('POST', `/public/wallets/${s(slug)}/quote`, { rail, amount }),
    contribute: (slug: string, form: ContributeForm, idempotencyKey: string) =>
      call<ContributeResult>('POST', `/public/wallets/${s(slug)}/contributions`, form, { 'idempotency-key': idempotencyKey }),
    contribution: (id: string, token: string) => call<ContributionView>('GET', `/public/contributions/${s(id)}`, undefined, link(token)),
    reissue: (id: string, token: string) => call<Receipt>('POST', `/public/contributions/${s(id)}/receipt/reissue`, undefined, link(token)),
    removeTribute: (id: string, token: string) => call<{ status: string }>('POST', `/public/contributions/${s(id)}/tribute/remove`, undefined, link(token)),
    appealTribute: (id: string, token: string, reason: string) =>
      call<{ status: string }>('POST', `/public/contributions/${s(id)}/tribute/appeal`, { reason }, link(token)),
    report: (slug: string, category: string, details?: string) =>
      call<{ received: boolean }>('POST', `/public/wallets/${s(slug)}/report`, { category, ...(details ? { details } : {}) }),
    privacy: (walletId: string) => call<Privacy & { photo: boolean }>('GET', `/wallets/${s(walletId)}/privacy`),
    setPrivacy: (walletId: string, p: Partial<Privacy>) => call<Privacy>('PUT', `/wallets/${s(walletId)}/privacy`, p),
  };
}

export const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:7600';
/** Server components fetch the API over the internal URL when one is set. */
export const SERVER_API_BASE = process.env['CHEMA_API_INTERNAL_URL'] ?? API_BASE;
