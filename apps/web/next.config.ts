import type { NextConfig } from 'next';

// Content-Security-Policy: same-origin assets plus the Chema API (fetch + QR/photo
// images). Next.js inlines bootstrap scripts, so 'unsafe-inline' stays until a
// nonce middleware lands; dev mode additionally needs 'unsafe-eval' for HMR.
const api = new URL(process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:7600').origin;
const dev = process.env['NODE_ENV'] !== 'production';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${api}`,
  `connect-src 'self' ${api}${dev ? ' ws:' : ''}`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Shared message catalogue (TypeScript source in the workspace).
  transpilePackages: ['@chema/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      // Secure hand-off links carry a token in the fragment; never cache or leak the page.
      { source: '/h', headers: [{ key: 'Cache-Control', value: 'no-store' }, { key: 'Referrer-Policy', value: 'no-referrer' }] },
    ];
  },
};

export default config;
