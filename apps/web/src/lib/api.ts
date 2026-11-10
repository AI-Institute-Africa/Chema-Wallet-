// Thin typed client for the Chema API. No business rules here: the server
// decides status, badge and share data; the web app only displays them.

export type WalletStatus =
  | 'DRAFT'
  | 'PENDING_VERIFICATION'
  | 'ACTIVE'
  | 'VERIFICATION_REJECTED'
  | 'SUSPENDED'
  | 'CLOSING'
  | 'CLOSED';

export type EvidenceType = 'DEATH_CERTIFICATE' | 'PARLOUR_CONFIRMATION' | 'BURIAL_ORDER' | 'ADMIN_ID' | 'MANDATE' | 'OTHER';

export interface Badge {
  label: string;
  tooltip: string;
}

export interface ShareLinks {
  text: string;
  url: string;
  whatsapp: string;
  sms: string;
  facebook: string;
  copy: string;
}

export interface WalletView {
  id: string;
  status: WalletStatus;
  deceasedName: string;
  dateOfDeath: string;
  funeralDate: string | null;
  funeralLocation: string;
  currency: 'USD' | 'ZWG';
  targetMinor: string | null;
  verifiedAt: string | null;
  badge: Badge | null;
  publicSlug: string | null;
  share: ShareLinks | null;
  evidence: { id: string; documentId: string; evidenceType: EvidenceType; scan: 'PENDING' | 'CLEAN' | 'INFECTED'; addedAt: string }[];
  latestCase: { id: string; outcome: 'APPROVED' | 'REJECTED' | 'MORE_INFO' | null; reasonCode: string | null; decidedAt: string | null } | null;
  canAppeal: boolean;
}

export interface DraftForm {
  deceasedName: string;
  dateOfDeath: string;
  funeralDate?: string;
  funeralLocation: string;
  familyContactPhone?: string;
  /** Major units as typed, e.g. "1500" or "1500.50"; converted to minor units without floats. */
  target?: string;
  currency: 'USD' | 'ZWG';
  policyNo?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly missing: readonly string[] = [],
  ) {
    super(`api ${status}: ${code}`);
    this.name = 'ApiError';
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  token?: () => string | null;
  fetch?: Fetch;
}

/** "1500.5" → 150050n. Strings only, so no float ever touches money. */
export function majorToMinor(value: string): bigint {
  const v = value.trim();
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) throw new RangeError('amount must look like 1500 or 1500.50');
  const cents = (m[2] ?? '').padEnd(2, '0');
  return BigInt(m[1] ?? '0') * 100n + BigInt(cents);
}

/** Request body for POST /wallets from the form (drops blanks). */
export function draftBody(form: DraftForm): Record<string, unknown> {
  const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  const target = opt(form.target);
  const body: Record<string, unknown> = {
    deceasedName: form.deceasedName.trim(),
    dateOfDeath: form.dateOfDeath,
    funeralLocation: form.funeralLocation.trim(),
    currency: form.currency,
  };
  const funeralDate = opt(form.funeralDate);
  if (funeralDate) body['funeralDate'] = funeralDate;
  const phone = opt(form.familyContactPhone);
  if (phone) body['familyContactPhone'] = phone;
  if (target) body['targetMinor'] = majorToMinor(target).toString();
  const policyNo = opt(form.policyNo);
  if (policyNo) body['fidelity'] = { policyNo };
  return body;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function createApiClient(opts: ApiClientOptions) {
  const doFetch: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = opts.baseUrl.replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const token = opts.token?.();
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await doFetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (json ?? {}) as { error?: string; missing?: string[] };
      throw new ApiError(res.status, err.error ?? 'error', err.missing ?? []);
    }
    return json as T;
  }

  return {
    startOtp: (phone: string) => call<{ challengeId: string }>('POST', '/auth/otp/start', { phone, channel: 'WEB' }),
    verifyOtp: (challengeId: string, code: string) => call<{ token: string; expiresAt: string }>('POST', '/auth/otp/verify', { challengeId, code }),
    createDraft: (form: DraftForm) => call<WalletView>('POST', '/wallets', draftBody(form)),
    wallet: (id: string) => call<WalletView>('GET', `/wallets/${encodeURIComponent(id)}`),
    addEvidence: (id: string, evidenceType: EvidenceType, contentType: string, bytes: Uint8Array, certificateNumber?: string) =>
      call<{ id: string }>('POST', `/wallets/${encodeURIComponent(id)}/evidence`, {
        evidenceType,
        contentType,
        dataBase64: bytesToBase64(bytes),
        ...(certificateNumber ? { certificateNumber } : {}),
      }),
    submit: (id: string) => call<{ caseId: string; status: WalletStatus }>('POST', `/wallets/${encodeURIComponent(id)}/submit`),
    appeal: (id: string, reason: string) => call<{ caseId: string; status: WalletStatus }>('POST', `/wallets/${encodeURIComponent(id)}/appeal`, { reason }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
