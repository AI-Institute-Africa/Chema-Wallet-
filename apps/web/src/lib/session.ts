'use client';
// Browser-side wiring: API base URL + the session token (sessionStorage, so it
// dies with the tab). The token is never put in a URL.
import { createApiClient } from './api';

const KEY = 'chema.session';

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
    // Storage unavailable (private mode): the user signs in again next time.
  }
}

export const api = createApiClient({
  baseUrl: process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:7600',
  token: getToken,
});
