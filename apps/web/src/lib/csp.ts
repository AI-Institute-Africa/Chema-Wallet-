// Nonce-based Content-Security-Policy (Next.js 16 proxy). Scripts run only
// with this request's nonce ('strict-dynamic' lets those load their chunks);
// no 'unsafe-inline' for scripts. 'unsafe-eval' and ws: are dev-only (React
// debugging + HMR). Styles keep 'unsafe-inline' (style attributes cannot carry
// a nonce); they cannot run code.

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildCsp(opts: { nonce: string; apiOrigin: string; dev: boolean }): string {
  const { nonce, apiOrigin, dev } = opts;
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new RangeError('bad nonce');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${apiOrigin}`,
    `connect-src 'self' ${apiOrigin}${dev ? ' ws:' : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function apiOriginOf(url: string | undefined): string {
  return new URL(url ?? 'http://localhost:7600').origin;
}
