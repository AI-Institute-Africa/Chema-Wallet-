// UI redesign (2026-11-11): one memorial page for contributors (/w/[slug]) and
// the family admin (/wallets/[id]); maroon glass theme with a saved light/dark choice.
import { txFixture } from './tx-fixture';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { W, WEB, expectClean, guard, mockApi, open, signInWeb } from './support';

const fixtureText = readFileSync(new URL('./memorial-fixture.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText) as {
  slug: string;
  deceasedName: string;
  dateOfDeath: string;
  funeralDate: string;
  funeralLocation: string;
  totals: unknown;
};
const SLUG = fixture.slug;
const SHOTS = process.env['SHOT_DIR'];

const ownerWallet = {
  id: W,
  status: 'ACTIVE',
  deceasedName: fixture.deceasedName,
  dateOfDeath: fixture.dateOfDeath,
  funeralDate: fixture.funeralDate,
  funeralLocation: fixture.funeralLocation,
  currency: 'USD',
  targetMinor: '200000',
  verifiedAt: '2026-11-05T00:00:00Z',
  badge: { label: 'Verified funeral', tooltip: 'Funeral checks passed. This does not mean insurance cover or claim approval.' },
  publicSlug: SLUG,
  share: null,
  evidence: [],
  latestCase: null,
  canAppeal: false,
};
const privacy = {
  showTotal: true,
  showUsageSummary: false,
  showPhoto: true,
  showContributorNames: true,
  showAmounts: true,
  showTributes: true,
  showPolicyNumber: true,
  photo: false,
};

/** The parts of the memorial both audiences must see identically. */
async function memorialText(page: Page): Promise<string[]> {
  const sel = ['.caption .meta', '.caption .chip', 'h2.m-title', '.badge-note', '[data-testid=policy]', '.desc', '.collected', '.pstats', '.tributes', '.guard'];
  const out: string[] = [];
  for (const s of sel) out.push(`${s}: ${(await page.locator(s).first().innerText()).replace(/\s+/g, ' ').trim()}`);
  return out;
}

const publicMocks = {
  [`GET /public/wallets/${SLUG}/qr.svg`]: {},
  [`GET /public/wallets/${SLUG}/total`]: fixture.totals,
};

test('public memorial page: design layout, policy, tributes, chips within limits, card note, no card fields', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, publicMocks);
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, `${WEB}/w/${SLUG}`);
  await expect(page.locator('[data-testid=memorial]')).toHaveAttribute('data-mode', 'public');
  await expect(page.getByRole('heading', { name: `In loving memory of ${fixture.deceasedName}` })).toBeVisible();
  await expect(page.locator('.caption .chip')).toHaveText('Verified funeral');
  await expect(page.locator('[data-testid=policy]')).toContainText('Policy FLA-2024-9841');
  await expect(page.locator('.collected')).toContainText('$1,450');
  await expect(page.locator('.pstats')).toContainText('72% funded');
  await expect(page.locator('.pstats')).toContainText('$550 to go');
  await expect(page.locator('.tribute')).toHaveCount(3);
  await expect(page.locator('.quick button')).toHaveText(['$5', '$10', '$20', '$50', 'Other']);
  await expect(page.locator('[data-testid=owner-bar]')).toHaveCount(0);
  // Where the money went (Transactions 2026-11-25): purpose + amount + date only, never the payee.
  const usage = page.locator('section.usage');
  await expect(usage.getByRole('heading', { name: 'Where the money went' })).toBeVisible();
  await expect(usage.locator('.u-bars li')).toHaveCount(2);
  await expect(usage.locator('.u-list li').first()).toContainText('2026-11-22');
  await expect(usage.locator('.u-list li').first()).toContainText('$20');
  await expect(usage).not.toContainText('Doves');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mem-shot-public-light-desktop.png`, fullPage: true });
  await page.getByRole('radio', { name: 'CARD' }).click();
  await expect(page.getByText("You will be taken to the card provider's secure page")).toBeVisible();
  await expect(page.locator('input[autocomplete^="cc-"]')).toHaveCount(0);
  await expectClean(page, g, mock);
});

test('contribute from the memorial page: chip, quote, disclosure, pay, receipt page', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    ...publicMocks,
    [`POST /public/wallets/${SLUG}/quote`]: {
      totalCharged: { minor: '2000', ccy: 'USD' },
      feePayer: null,
      providerFee: { minor: '0', ccy: 'USD' },
      fxRate: null,
      expectedCredit: { minor: '2000', ccy: 'USD' },
    },
    [`POST /public/wallets/${SLUG}/contributions`]: {
      status: 201,
      json: {
        contributionId: 'c-1',
        accessToken: ['TOKEN', 'abcdefghijklmnopqrstu'].join('-'), // fixture link token (not a secret)
        replayed: false,
        payment: { id: 'p-1', state: 'INITIATED', disclosure: {}, next: { type: 'PROMPT', message: 'Approve on your phone' } },
      },
    },
    'GET /public/contributions/c-1': { status: 404, json: { error: 'not_found' } },
  });
  await open(page, `${WEB}/w/${SLUG}`);
  await page.locator('.quick button', { hasText: '$20' }).click();
  await page.getByRole('radio', { name: 'ECOCASH' }).click();
  await page.locator('#phone').fill('+263771234567');
  await page.locator('#nm').fill('Tendai Chikore');
  await page.locator('#msg').fill('Rest in peace, Sekuru.');
  await page.getByRole('button', { name: 'Contribute $20' }).click();
  await expect(page.locator('[data-testid=disclosure]')).toBeVisible();
  await page.getByRole('button', { name: 'Pay $20' }).click();
  await expect(page).toHaveURL(/\/c\/c-1#t=/);
  const sent = mock.calls.find((c) => c.path.endsWith('/contributions'));
  expect(sent?.body).toMatchObject({ rail: 'ECOCASH', amount: { minor: '2000', ccy: 'USD' }, payerName: 'Tendai Chikore', anonymous: false });
  expect(sent?.headers['idempotency-key']).toMatch(/^web-/);
  expect(g.errors.filter((e) => !/status of 4\d\d/.test(e))).toEqual([]);
});

test('the family admin sees the same memorial page, plus the owner bar and owner tools', async ({ page }) => {
  const mock1 = await mockApi(page, publicMocks);
  await open(page, `${WEB}/w/${SLUG}`);
  const publicView = await memorialText(page);
  expect(mock1.unmocked).toEqual([]);

  await signInWeb(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const g = guard(page);
  const mock = await mockApi(page, {
    ...publicMocks,
    [`GET /wallets/${W}`]: ownerWallet,
    [`GET /public/wallets/${SLUG}`]: JSON.parse(fixtureText),
    [`GET /wallets/${W}/privacy`]: privacy,
    [`GET /wallets/${W}/transactions`]: txFixture,
    [`PUT /wallets/${W}/target`]: { ...ownerWallet, targetMinor: '250000' },
  });
  await open(page, `${WEB}/wallets/${W}`);
  await expect(page.locator('[data-testid=memorial]')).toHaveAttribute('data-mode', 'owner');
  await expect(page.locator('[data-testid=owner-bar]')).toContainText('This is exactly what contributors see.');
  await expect(page.locator('.collected')).toBeVisible();
  expect(await memorialText(page)).toEqual(publicView);
  await expect(page.getByRole('button', { name: "Add Sekuru Tendai Moyo's photo" })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Manage this wallet' })).toBeVisible();
  // Recent activity (Transactions): the last lines with a link to the full statement.
  await expect(page.locator('[data-testid=recent-activity]')).toContainText('Farai Katsande');
  await expect(page.locator('[data-testid=recent-activity]').getByRole('link', { name: 'See all transactions' })).toHaveAttribute('href', `/wallets/${W}/transactions`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mem-shot-owner-light-desktop.png`, fullPage: true });

  const editor = page.locator('[data-testid=target-view]');
  await editor.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#tIn').fill('2500');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect
    .poll(() => mock.calls.find((c) => c.method === 'PUT' && c.path.endsWith('/target'))?.body)
    .toEqual({ targetMinor: '250000' });
  await expectClean(page, g, mock);
});

test('draft wallet: private preview of the memorial page, contributions disabled, documents listed', async ({ page }) => {
  await signInWeb(page);
  const g = guard(page);
  const mock = await mockApi(page, {
    [`GET /wallets/${W}`]: { ...ownerWallet, status: 'DRAFT', publicSlug: null, badge: null, verifiedAt: null },
    [`GET /wallets/${W}/privacy`]: privacy,
  });
  await open(page, `${WEB}/wallets/${W}`);
  await expect(page.locator('[data-testid=memorial]')).toHaveAttribute('data-mode', 'preview');
  await expect(page.locator('[data-testid=owner-bar]')).toContainText('Not public yet');
  await expect(page.locator('.caption .chip')).toHaveCount(0);
  await expect(page.locator('[data-testid=contribute-form] #amt')).toBeDisabled();
  await expect(page.locator('[data-testid=contribute-form] button[type=submit]')).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Add documents' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mem-shot-owner-preview-light-desktop.png`, fullPage: true });
  await expectClean(page, g, mock);
});

test('theme: toggle switches light/dark and the choice survives a reload; the pre-paint script carries the nonce', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, publicMocks);
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, `${WEB}/w/${SLUG}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await open(page, `${WEB}/w/${SLUG}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(15, 7, 8)');
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/mem-shot-public-dark-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${SHOTS}/mem-shot-public-dark-mobile.png` });
    await page.locator('#themeToggle').click();
    await page.screenshot({ path: `${SHOTS}/mem-shot-public-light-mobile.png` });
  }
  await expectClean(page, g, mock);
});
