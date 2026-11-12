// Next.js 16 proxy: a fresh CSP nonce per request. Next reads the nonce from
// the request's CSP header and stamps it on its own scripts; the same policy
// goes on the response. Static headers (nosniff, frame, referrer) stay in
// next.config.ts; the CSP lives only here so there is exactly one.
import { NextResponse, type NextRequest } from 'next/server';
import { apiOriginOf, buildCsp, newNonce } from './lib/csp';

const apiOrigin = apiOriginOf(process.env['NEXT_PUBLIC_API_URL']);
const dev = process.env['NODE_ENV'] !== 'production';

export function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = buildCsp({ nonce, apiOrigin, dev });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
