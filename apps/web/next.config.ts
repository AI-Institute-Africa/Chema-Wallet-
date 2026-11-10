import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Shared message catalogue (TypeScript source in the workspace).
  transpilePackages: ['@chema/shared'],
};

export default config;
