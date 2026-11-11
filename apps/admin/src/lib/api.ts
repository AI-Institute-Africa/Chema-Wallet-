'use client';
// Browser-side API client for the staff portal. The session token lives in
// sessionStorage (dies with the tab) and is never put in a URL. The portal
// holds no rules: the API authorises every call and the nav is only a hint.

const KEY = 'chema.staff.session';
export const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:7600';

export function getToken(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(KEY, token);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the person signs in again.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** Human text for an API error code. */
export function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Network error. Try again.';
  if (err.status === 401) return 'Your session has ended. Sign in again.';
  if (err.status === 403) return `Not allowed (${err.code}). Maker and checker must be different people, and your role must permit this.`;
  if (err.status === 404) return 'Not found.';
  if (err.status === 400) return 'Check the form: something is missing or invalid.';
  if (err.status === 409) return `Refused: ${err.code.replace(/_/g, ' ')}.`;
  return 'Something went wrong. Try again.';
}

async function call<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  if (!res.ok) {
    let code = 'error';
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, code);
  }
  if (raw) return (await res.text()) as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  text: (path: string) => call<string>('GET', path, undefined, true),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
};

export interface Me {
  personId: string;
  role: string;
  sections: string[];
}

/** Save text as a file (CSV exports). */
export function download(name: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Minor units (string) → "12.34 USD" for display only. Never used for arithmetic. */
export function fmtMoney(minor: string | null | undefined, ccy: string | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(3, '0');
  return `${neg ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}${ccy ? ` ${ccy}` : ''}`;
}
