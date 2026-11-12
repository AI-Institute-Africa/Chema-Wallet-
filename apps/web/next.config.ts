import type { NextConfig } from 'next';

// The Content-Security-Policy is set per request with a nonce in src/proxy.ts
// (one policy only); the static security headers stay here.

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
