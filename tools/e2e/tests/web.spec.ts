import { expect, test } from '@playwright/test';
import { C1, P1, P2, W, WEB, expectClean, guard, open, mockApi, signInWeb, usd } from './support';
import { txFixture } from './tx-fixture';

const wallet = {
  id: W,
  status: 'ACTIVE',
  deceasedName: 'Rudo Moyo',
  dateOfDeath: '2026-11-01',
  funeralDate: null,
  funeralLocation: 'Harare',
  currency: 'USD',
  targetMinor: null,
  verifiedAt: '2026-11-02T00:00:00Z',
  badge: { label: 'Verified funeral', tooltip: 'Funeral checks passed. This does not mean insurance cover or claim approval.' },
  publicSlug: 'rudo-moyo',
  share: null,
  evidence: [],
  latestCase: null,
  canAppeal: false,
};
const line = (source: string, available: string) => ({
  source,
  labelKey: `funds.source.${source.toLowerCase()}`,
  groupId: null,
  settled: usd(available),
  pending: usd('0'),
  held: usd('0'),
  available: usd(available),
  paid: usd('0'),
});
const funds = { walletId: W, lines: [line('COMMUNITY', '125000'), line('FIDELITY_BENEFIT', '50000')], benefit: { status: 'CREDITED', reason: null, statusUpdating: false } };
const payees = [
  { id: P1, label: 'Funeral parlour', holderName: 'Doves Ltd', rail: 'ECOCASH', destination: '+26377•••4567', status: 'ACTIVE', verification: 'MATCH', createdAt: '2026-11-03T00:00:00Z' },
  { id: P2, label: 'Transport', holderName: 'T. Moyo', rail: 'ONEMONEY', destination: '+26371•••0001', status: 'PENDING', verification: null, createdAt: '2026-11-04T00:00:00Z' },
];
const payout = { id: 'po-1', planId: 'pl-1', payeeId: P1, purpose: 'PARLOUR', source: 'COMMUNITY', amount: usd('15050'), status: 'AWAITING_APPROVAL', blockedBy: null, requestedAt: '2026-11-05T00:00:00Z', confirmedAt: null };
const stepUp = {
  'POST /auth/step-up/start': { status: 202, json: { challengeId: 'ch-1' } },
  'POST /auth/step-up/verify': { stepUpToken: 'STEPUP-TOKEN', expiresAt: '2026-11-11T10:05:00Z' },
};

test.beforeEach(async ({ page }) => signInWeb(page));

test('wallet status links to the family screens', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    [`GET /wallets/${W}`]: wallet,
    [`GET /wallets/${W}/funds`]: funds,
    [`GET /wallets/${W}/privacy`]: {
      showTotal: false,
      showUsageSummary: false,
      showPhoto: false,
      showContributorNames: false,
      showAmounts: false,
      showTributes: false,
      showPolicyNumber: false,
      photo: false,
    },
    // The owner view loads the real public page (UI redesign); totals hidden by privacy here.
    'GET /public/wallets/rudo-moyo': {
      slug: 'rudo-moyo',
      deceasedName: 'Rudo Moyo',
      dateOfDeath: '2026-11-01',
      funeralDate: null,
      funeralLocation: 'Harare',
      badge: wallet.badge,
      share: { text: '', url: '', whatsapp: '', sms: '', facebook: '', copy: '' },
      photoPath: null,
      totals: null,
      closed: false,
      usage: null,
      tributes: null,
      contribute: { currency: 'USD', rails: ['ECOCASH'], min: usd('100'), max: usd('100000'), groupsEnabled: false },
    },
    'GET /public/wallets/rudo-moyo/qr.svg': {},
    [`GET /wallets/${W}/transactions`]: txFixture,
  });
  await open(page, `${WEB}/wallets/${W}`);
  await expect(page.getByRole('navigation', { name: 'Manage this wallet' })).toBeVisible();
  await page.getByRole('link', { name: 'Money in the wallet' }).click();
  await expect(page).toHaveURL(`${WEB}/wallets/${W}/funds`);
  await expectClean(page, g, mock);
});

test('funds: community and Fidelity benefit shown separately, with the cover/approval disclaimer', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, { [`GET /wallets/${W}/funds`]: funds });
  await open(page, `${WEB}/wallets/${W}/funds`);
  const community = page.getByRole('region', { name: 'Contributions from family and friends' });
  const benefit = page.getByRole('region', { name: 'Fidelity funeral benefit' });
  await expect(community.locator('[data-source=COMMUNITY]')).toContainText('Available to pay out: 1250.00 USD');
  await expect(community.locator('[data-source=FIDELITY_BENEFIT]')).toHaveCount(0);
  await expect(benefit.locator('[data-source=FIDELITY_BENEFIT]')).toContainText('500.00 USD');
  await expect(benefit).toContainText('does not mean insurance cover');
  await expect(benefit).toContainText('does not mean the claim is approved');
  if (process.env['SHOT_DIR']) await page.screenshot({ path: `${process.env['SHOT_DIR']}/mem-shot-family-funds-light.png`, fullPage: true });
  await expectClean(page, g, mock);
});

test('claim: lookup then link', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    [`GET /wallets/${W}/funds`]: { ...funds, benefit: { status: 'NOT_LINKED', reason: null, statusUpdating: false } },
    [`GET /wallets/${W}/claim`]: { walletId: W, linked: false, policyNo: null, lookupOutcome: null, linkState: 'NONE', claimStatus: 'NONE', routeStatus: 'UNSET', benefit: {}, statusUpdating: false },
    [`POST /wallets/${W}/claim/lookup`]: { outcome: 'ELIGIBLE', policyNo: 'FLA-1', linkable: true },
    [`POST /wallets/${W}/claim`]: { status: 202, json: { linked: true } },
  });
  await open(page, `${WEB}/wallets/${W}/claim`);
  await expect(page.getByText('No Fidelity claim is linked to this wallet.')).toBeVisible();
  await page.getByLabel('Policy number', { exact: true }).fill('FLA-1');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText('A policy was found. You can link the claim. Fidelity still decides it.')).toBeVisible();
  await page.getByLabel('Chema reference of the person who should receive the benefit').fill(P1);
  await page.getByLabel('Their national ID number').fill('63-123456A42');
  await page.getByRole('button', { name: 'Link the claim' }).click();
  await expect(page.getByText('The claim link was sent to Fidelity.')).toBeVisible();
  expect(mock.calls.find((c) => c.path === `/wallets/${W}/claim` && c.method === 'POST')?.body).toEqual({ recipientPersonId: P1, recipientIdNumber: '63-123456A42' });
  await expectClean(page, g, mock);
});

test('claim: Fidelity link switched off (404) shows a calm message, community funds unaffected', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    [`GET /wallets/${W}/funds`]: { ...funds, benefit: { status: 'NOT_LINKED', reason: null, statusUpdating: false } },
    [`GET /wallets/${W}/claim`]: { status: 404, json: { error: 'not_found' } },
  });
  await open(page, `${WEB}/wallets/${W}/claim`);
  await expect(page.getByText('This service is not available right now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Look up' })).toHaveCount(0);
  await expectClean(page, g, mock);
});

test('payees: add needs the one-time code (step-up header), list shows masked numbers + status', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, { [`GET /wallets/${W}/payees`]: payees, [`POST /wallets/${W}/payees`]: { status: 201, json: payees[1] }, ...stepUp });
  await open(page, `${WEB}/wallets/${W}/payees`);
  await expect(page.getByText('+26377•••4567')).toBeVisible();
  await expect(page.getByText('Waiting for approval')).toBeVisible();
  await page.getByLabel('What they are paid for (for example "Funeral parlour")').fill('Transport');
  await page.getByLabel('Name on the mobile money account').fill('T. Moyo');
  await page.getByLabel('Mobile money service').selectOption('ONEMONEY');
  await page.getByLabel('Mobile money number (for example +263771234567)').fill('+263710000001');
  await page.getByRole('button', { name: 'Add this person' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.getByLabel('Code we sent you').fill('123456');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('status')).toContainText('second family approver');
  const add = mock.calls.find((c) => c.method === 'POST' && c.path === `/wallets/${W}/payees`);
  expect(add?.headers['x-step-up-token']).toBe('STEPUP-TOKEN');
  expect(add?.body).toEqual({ label: 'Transport', holderName: 'T. Moyo', rail: 'ONEMONEY', destination: '+263710000001' });
  expect(mock.calls.find((c) => c.path === '/auth/step-up/start')?.body).toEqual({ action: 'wallet.change_payout_destination', subjectType: 'wallet', subjectId: W });
  await expectClean(page, g, mock);
});

test('payouts: request with step-up in minor units, then cancel', async ({ page }) => {
  const g = guard(page);
  let list: unknown[] = [];
  const mock = await mockApi(page, {
    [`GET /wallets/${W}`]: wallet,
    [`GET /wallets/${W}/payees`]: payees,
    [`GET /wallets/${W}/payouts`]: () => list,
    [`POST /wallets/${W}/payouts`]: () => {
      list = [payout];
      return { status: 201, json: { planId: 'pl-1', approvalId: 'ap-1', payouts: [payout], replayed: false } };
    },
    'POST /payouts/po-1/cancel': () => {
      list = [{ ...payout, status: 'CANCELLED' }];
      return { status: 'CANCELLED' };
    },
    ...stepUp,
  });
  await open(page, `${WEB}/wallets/${W}/payouts`);
  await expect(page.getByLabel('Pay to').locator('option')).toHaveCount(2); // blank + the one ACTIVE payee
  await page.getByLabel('Pay to').selectOption(P1);
  await page.getByLabel('Amount in USD').fill('150.50');
  await page.getByRole('button', { name: 'Request payout' }).click();
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.getByLabel('Code we sent you').fill('654321');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('status')).toContainText('Payout requested: Waiting for approval.');
  const req = mock.calls.find((c) => c.method === 'POST' && c.path === `/wallets/${W}/payouts`);
  expect(req?.headers['x-step-up-token']).toBe('STEPUP-TOKEN');
  expect((req?.body as { parts: unknown[] }).parts).toEqual([{ payeeId: P1, amountMinor: '15050', purpose: 'PARLOUR' }]);
  await expect(page.getByText('150.50 USD to Funeral parlour for Funeral parlour')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel this payout' }).click();
  await page.getByLabel('Why are you cancelling it?').fill('Paid in person');
  await page.getByRole('button', { name: 'Cancel this payout' }).click();
  await expect(page.getByRole('status')).toContainText('Payout cancelled.');
  await expect(page.getByText('Cancelled', { exact: false }).first()).toBeVisible();
  await expectClean(page, g, mock);
});

test('cases: open a concern and view it', async ({ page }) => {
  const g = guard(page);
  const c = { id: C1, type: 'PAYMENT_DISPUTE', status: 'OPEN', summary: 'A contribution is missing from the total', holds: [], outcome: null, openedAt: '2026-11-06T00:00:00Z', closedAt: null };
  let list: unknown[] = [];
  const mock = await mockApi(page, {
    [`GET /wallets/${W}/cases`]: () => list,
    [`POST /wallets/${W}/cases`]: () => {
      list = [c];
      return { status: 201, json: c };
    },
    [`GET /cases/${C1}`]: { ...c, status: 'RESOLVED', outcome: 'UPHELD', closedAt: '2026-11-07T00:00:00Z' },
  });
  await open(page, `${WEB}/wallets/${W}/cases`);
  await page.getByLabel('Please describe what happened (at least 10 characters)').fill('A contribution is missing from the total');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText('Our team will look into it.');
  await page.getByRole('link', { name: 'View' }).click();
  await expect(page.getByRole('heading', { name: 'Concern details' })).toBeVisible();
  await expect(page.getByText('Outcome: Upheld')).toBeVisible();
  await expectClean(page, g, mock);
});

test('closure: blockers in plain words, thank contributors, statement', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    [`GET /wallets/${W}/closure`]: { walletId: W, status: 'CLOSING', blockers: ['OPEN_PAYOUTS', 'RESIDUAL_POLICY_UNSET'], residual: [{ source: 'W:COMMUNITY', currency: 'USD', amount: usd('2500') }] },
    [`GET /wallets/${W}/statements`]: [
      { kind: 'FAMILY', contentHash: 'h1', generatedAt: '2026-11-08T00:00:00Z', content: { sources: [{ source: 'W:COMMUNITY', settled: usd('125000'), paid: usd('122500') }], payouts: [{ purpose: 'PARLOUR', payee: 'Funeral parlour (+26377•••4567)', source: 'COMMUNITY', amount: usd('122500'), at: '2026-11-07T00:00:00Z' }] } },
    ],
    [`POST /wallets/${W}/thank-contributors`]: { status: 202, json: { queued: 7 } },
  });
  await open(page, `${WEB}/wallets/${W}/closure`);
  await expect(page.getByText('Some payouts are not finished.')).toBeVisible();
  await expect(page.getByText('Still in the wallet (Community contributions): 25.00 USD')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close the wallet now' })).toBeDisabled();
  await page.getByRole('button', { name: 'Thank contributors' }).click();
  await expect(page.getByRole('status')).toContainText('Thank-you messages on their way: 7.');
  await expect(page.getByText('1225.00 USD to Funeral parlour (+26377•••4567) for Funeral parlour')).toBeVisible();
  await expectClean(page, g, mock);
});

test('/h hand-off: token from the fragment only, dropped from the URL, code entered on the page', async ({ page }) => {
  const g = guard(page);
  const token = 'Hx7_kq2LmN9pQr4sTu6vWx8yZa1bC3dE';
  const mock = await mockApi(page, {
    'POST /handoff/describe': { purpose: 'PAYOUT_REQUEST', expiresAt: '2026-11-11T10:15:00Z', summary: { amount: '150.00 USD', payee: 'Funeral parlour', purpose: 'PARLOUR' } },
    'POST /handoff/otp': { status: 202, json: { challengeId: '8a1b2c3d-0000-4000-8000-000000000001' } },
    'POST /handoff/confirm': { purpose: 'PAYOUT_REQUEST', planId: 'pl', approvalId: 'ap', status: 'AWAITING_APPROVAL' },
  });
  const res = await open(page, `${WEB}/h#${token}`);
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
  expect(res.headers()['cache-control']).toContain('no-store');
  await expect(page.getByText('150.00 USD to Funeral parlour for Funeral parlour.')).toBeVisible();
  expect(page.url()).toBe(`${WEB}/h`); // fragment removed from the address bar
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.getByLabel('Code we sent you').fill('123456');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('status')).toContainText('Your payout request was received (Waiting for approval).');
  for (const c of mock.calls) {
    expect(c.path).not.toContain(token);
    expect(c.headers['referer'] ?? '').not.toContain(token);
  }
  expect(mock.calls.map((c) => c.body)).toContainEqual({ token, challengeId: '8a1b2c3d-0000-4000-8000-000000000001', code: '123456' });
  await expectClean(page, g, mock);
});

test('/h: expired link and missing token', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, { 'POST /handoff/describe': { status: 404, json: { error: 'not_found' } } });
  await open(page, `${WEB}/h#Hx7_kq2LmN9pQr4sTu6vWx8yZa1bC3dE`);
  await expect(page.getByText('This link has expired or was already used.')).toBeVisible();
  await expectClean(page, g, mock);
  await open(page, `${WEB}/h`);
  await expect(page.getByText('This page opens from a secure link')).toBeVisible();
});
