import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tools/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // PGlite instances are ~100 MB each; cap parallelism on this RAM-bound box.
    maxWorkers: 2,
    testTimeout: 20_000,
  },
});
