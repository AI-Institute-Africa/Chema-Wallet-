import type { NextConfig } from 'next';

// The Content-Security-Policy is set per request with a nonce in src/proxy.ts
// (one policy only); the static security headers stay here.

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Staff portal: never framed, never cached by intermediaries, no referrer leaks.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default config;
