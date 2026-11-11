import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'tools/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // PGlite instances are ~100 MB each; cap parallelism on this RAM-bound box.
    maxWorkers: 2,
    testTimeout: 20_000,
    // Real-Postgres suites create + migrate a throwaway database in beforeAll
    // (~3.5 s alone, measured) and then build a harness (scrypt staff enrolment,
    // PGlite-free but CPU bound). With the other worker busy in PGlite WASM the
    // 10 s default was exceeded; give hooks the same budget as a slow test x3.
    hookTimeout: 60_000,
  },
});
