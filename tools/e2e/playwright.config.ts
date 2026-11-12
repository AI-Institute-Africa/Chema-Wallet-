// Browser click-through of the built apps (`next start`) with the Chema API
// MOCKED in the browser (page.route on the API origin): no Postgres, Redis or
// API process needed. Build both apps first (`pnpm --filter @chema/web build`,
// `pnpm --filter @chema/admin build`), then `pnpm --filter @chema/e2e test`.
// Ports 3100/3101 (3000/3001 are left for a manual stack). The API origin the
// builds call (default :7600) is intercepted in the browser and never reached.
import { defineConfig } from '@playwright/test';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, trace: 'off' },
  webServer: [
    // Server-side API stand-in for the server-rendered public memorial page.
    { command: 'node tools/e2e/mock-api-server.mjs', cwd: root, url: 'http://127.0.0.1:3199/health', reuseExistingServer: false, timeout: 20_000 },
    {
      command: 'pnpm --filter @chema/web exec next start -p 3100',
      cwd: root,
      url: 'http://localhost:3100/h',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { CHEMA_API_INTERNAL_URL: 'http://127.0.0.1:3199' },
    },
    { command: 'pnpm --filter @chema/admin exec next start -p 3101', cwd: root, url: 'http://localhost:3101/login', reuseExistingServer: false, timeout: 60_000 },
  ],
});
