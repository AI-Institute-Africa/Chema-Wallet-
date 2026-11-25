// Transactions (2026-11-25): the family statement — what came in and where the money went.
import { expect, test } from '@playwright/test';
import { W, WEB, expectClean, guard, mockApi, open, signInWeb } from './support';
import { txFixture } from './tx-fixture';

const SHOTS = process.env['SHOT_DIR'];
const csv = 'date,status,direction\r\n2026-11-21,POSTED,OUT\r\n';

test.beforeEach(async ({ page }) => signInWeb(page));

test('family statement: summaries per source, real names, payee + purpose + note, filters, details, CSV', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, { [`GET /wallets/${W}/transactions`]: txFixture });
  await page.route(`**/wallets/${W}/transactions/csv`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fallback()
      : route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-disposition', 'content-disposition': 'attachment; filename="chema-sekuru-transactions.csv"' },
      contentType: 'text/csv',
      body: csv,
    }),
  );
  await open(page, `${WEB}/wallets/${W}/transactions`);
  await expect(page.getByRole('heading', { name: 'Transactions', level: 1 })).toBeVisible();

  const sums = page.locator('.tx-sum');
  await expect(sums).toHaveCount(2);
  await expect(page.locator('.tx-sum[data-source=COMMUNITY]')).toContainText('$180');
  await expect(page.locator('.tx-sum[data-source=FIDELITY_BENEFIT]')).toContainText('Verified badge');

  const rows = page.locator('.tx-list').last().locator('.tx-row');
  await expect(rows).toHaveCount(7);
  await expect(page.getByText('Rudo Moyo contributed')).toBeVisible();
  await expect(page.locator('.tx-row', { hasText: 'Rudo Moyo' })).toContainText('Anonymous on the public page');
  const paid = page.locator('.tx-day .tx-row[data-kind=PAYOUT][data-direction=OUT]:not(.struck)');
  await expect(paid).toContainText('Paid Doves Funeral Services (+26377•••4567)');
  await expect(paid).toContainText('Funeral parlour');
  await expect(paid).toContainText('Coffin and hearse');
  await expect(page.getByText('Returned by the provider: Doves Funeral Services (+26377•••4567)')).toBeVisible();
  await expect(page.getByText('Refund to Farai Katsande')).toBeVisible();
  await expect(page.getByText('Fidelity benefit received')).toBeVisible();

  // Waiting section.
  await expect(page.getByRole('heading', { name: 'Waiting' })).toBeVisible();
  await expect(page.getByText('Payout to Doves Funeral Services (+26377•••4567)')).toBeVisible();
  await expect(page.getByText('Tendai Late is paying')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tx-shot-light-desktop.png`, fullPage: true });

  // Filters.
  await page.getByRole('radio', { name: 'Money out' }).click();
  await expect(page.locator('.tx-list .tx-row[data-direction=IN]')).toHaveCount(0);
  await page.getByRole('radio', { name: /Waiting/ }).click();
  await expect(page.getByText('Rudo Moyo contributed')).toHaveCount(0);
  await expect(page.getByText('Tendai Late is paying')).toBeVisible();
  await page.getByRole('radio', { name: 'All' }).click();

  // Details expand.
  await page.locator('.tx-row', { hasText: 'Rudo Moyo' }).getByRole('button').click();
  await expect(page.locator('.tx-row', { hasText: 'Rudo Moyo' }).locator('.tx-details')).toContainText('Sympathetic Friend');

  // CSV download with the session header.
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  expect((await dl).suggestedFilename()).toBe('chema-sekuru-transactions.csv');

  await expectClean(page, g, mock);
});

test('dark mode and phone width render the statement', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, { [`GET /wallets/${W}/transactions`]: txFixture });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, `${WEB}/wallets/${W}/transactions`);
  await expect(page.locator('.tx-row').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tx-shot-dark-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tx-shot-dark-desktop.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tx-shot-light-mobile.png`, fullPage: true });
  await expectClean(page, g, mock);
});

test('nav reaches Transactions from the family screens', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    [`GET /wallets/${W}/funds`]: { walletId: W, lines: [], benefit: { status: 'NOT_LINKED', reason: null, statusUpdating: false } },
    [`GET /wallets/${W}/transactions`]: txFixture,
  });
  await open(page, `${WEB}/wallets/${W}/funds`);
  await page.getByRole('link', { name: 'Transactions' }).click();
  await expect(page).toHaveURL(`${WEB}/wallets/${W}/transactions`);
  await expect(page.locator('.tx-row').first()).toBeVisible();
  await expectClean(page, g, mock);
});
