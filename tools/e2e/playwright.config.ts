// Browser click-through of the built apps (`next start`) with the Chema API
// MOCKED in the browser (page.route on the API origin): no Postgres, Redis or
// API process needed. Build both apps first (`pnpm --filter @chema/web build`,
// `pnpm --filter @chema/admin build`), then `pnpm --filter @chema/e2e test`.
import { defineConfig } from '@playwright/test';

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 1,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, trace: 'off' },
  webServer: [
    { command: 'pnpm --filter @chema/web start', cwd: root, url: 'http://localhost:3000/h', reuseExistingServer: false, timeout: 60_000 },
    { command: 'pnpm --filter @chema/admin start', cwd: root, url: 'http://localhost:3001/login', reuseExistingServer: false, timeout: 60_000 },
  ],
});
