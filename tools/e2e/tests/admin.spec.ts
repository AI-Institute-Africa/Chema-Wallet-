import { expect, test } from '@playwright/test';
import { A1, ADMIN, C1, D1, M1, ME, W, expectClean, guard, open, mockApi, signInStaff, usd } from './support';

const me = { personId: ME, role: 'OPS_FINANCE', sections: ['approvals', 'cases', 'recon', 'holds', 'failures', 'support'] };
const PO = '88888888-8888-4888-8888-888888888888';

test.beforeEach(async ({ page }) => signInStaff(page));

test('cases queue → case detail: assign to me, note, resolve', async ({ page }) => {
  const g = guard(page);
  const c = {
    id: C1, type: 'PAYMENT_DISPUTE', walletId: W, status: 'OPEN', severity: 'MEDIUM', summary: 'Contribution missing', assigneeId: null, slaDueAt: '2026-11-12T00:00:00Z',
    escalationLevel: 0, source: 'COMMUNITY', amount: usd('1000'), payoutRequestId: null, holds: [], outcome: null, openedAt: '2026-11-10T00:00:00Z', closedAt: null,
  };
  const mock = await mockApi(page, {
    'GET /admin/me': me,
    'GET /cases': [c],
    [`GET /cases/${C1}`]: c,
    [`POST /cases/${C1}/assign`]: { ...c, status: 'ASSIGNED', assigneeId: ME },
    [`POST /cases/${C1}/update`]: c,
    [`POST /cases/${C1}/resolve`]: { ...c, status: 'RESOLVED' },
  });
  await open(page, `${ADMIN}/q/cases`);
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(`${ADMIN}/cases/${C1}`);
  await expect(page.getByText('10.00 USD')).toBeVisible();
  await page.getByRole('button', { name: 'Assign to me' }).click();
  await expect(page.getByRole('status')).toHaveText('Assigned to you.');
  await page.getByLabel('Note (3+ characters)').fill('Called the family');
  await page.getByRole('button', { name: 'Save update' }).click();
  await expect(page.getByRole('status')).toHaveText('Note added.');
  await page.getByLabel('Written reason (10+ characters)').fill('Provider confirmed the payment was credited');
  await page.getByRole('button', { name: 'Resolve case' }).click();
  await expect(page.getByRole('status')).toHaveText('Case resolved.');
  expect(mock.calls.find((x) => x.path === `/cases/${C1}/assign`)?.body).toEqual({ assigneePersonId: ME });
  expect(mock.calls.find((x) => x.path === `/cases/${C1}/resolve`)?.body).toEqual({ outcome: 'UPHELD', note: 'Provider confirmed the payment was credited' });
  if (process.env['SHOT_DIR']) await page.screenshot({ path: `${process.env['SHOT_DIR']}/mem-shot-admin-cases-light.png`, fullPage: true });
  await expectClean(page, g, mock);
});

test('failures → RAIL_DOWN payout → override: upload evidence, request, execute', async ({ page }) => {
  const g = guard(page);
  let status = 'RAIL_DOWN';
  const view = () => ({
    id: PO, walletId: W, planId: 'pl', payeeId: 'pe', purpose: 'PARLOUR', source: 'COMMUNITY', amount: usd('3000'), rail: 'ECOCASH', status,
    approvalId: null, attempts: 5, providerRef: null, lastError: 'RAIL_UNAVAILABLE', blockedBy: null, requestedAt: '2026-11-10T00:00:00Z', confirmedAt: null,
  });
  const mock = await mockApi(page, {
    'GET /admin/me': me,
    'GET /admin/queues/failures': {
      notifications: [{ id: 'n1', template: 'notify.receipt', channel: 'SMS', walletId: W, attempts: 5, lastError: 'timeout', updatedAt: '2026-11-10T00:00:00Z' }],
      fidelity: [],
      whatsapp: [{ id: 'wa1', provider: 'simulator', status: 'FAILED', outcome: 'ERROR', attempts: 3, receivedAt: '2026-11-10T00:00:00Z' }],
      payouts: [{ id: PO, walletId: W, status: 'RAIL_DOWN', rail: 'ECOCASH', amountMinor: '3000', currency: 'USD', attempts: 5, lastError: 'RAIL_UNAVAILABLE', updatedAt: '2026-11-10T00:00:00Z' }],
    },
    [`GET /payouts/${PO}`]: view,
    'POST /documents': { status: 201, json: { id: D1 } },
    [`POST /payouts/${PO}/override`]: (_r: unknown, body: { approvalId?: string }) => {
      status = body.approvalId ? 'CONFIRMED' : 'OVERRIDE_PENDING';
      return body.approvalId ? { status: 'CONFIRMED', approvalId: A1 } : { status: 'OVERRIDE_PENDING', approvalId: A1 };
    },
  });
  await open(page, `${ADMIN}/failures`);
  await expect(page.getByRole('heading', { name: /WhatsApp messages not processed \(FAILED \/ IGNORED\) \(1\)/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Undelivered notifications \(DEAD\) \(1\)/ })).toBeVisible();
  await page.getByRole('link', { name: 'Override' }).click();
  await expect(page).toHaveURL(`${ADMIN}/payouts/${PO}`);
  await page.getByLabel('External payment reference').fill('MANUAL-TT-55102');
  await page.getByLabel('Evidence document (proof of the outside payment)').setInputFiles({ name: 'proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 proof') });
  await page.getByRole('button', { name: 'Upload evidence' }).click();
  await expect(page.getByRole('status')).toContainText(`Evidence uploaded (${D1})`);
  await page.getByRole('button', { name: '1. Request override (maker)' }).click();
  await expect(page.getByRole('status')).toContainText(`Approval ${A1} now waits for a different ops/finance checker.`);
  await page.getByRole('button', { name: '2. Execute approved override' }).click();
  await expect(page.getByRole('status')).toHaveText('Override booked: payout CONFIRMED.');
  const upload = mock.calls.find((x) => x.path === '/documents')?.body as Record<string, string>;
  expect(upload['walletId']).toBe(W);
  expect(upload['class']).toBe('OTHER');
  const overrides = mock.calls.filter((x) => x.path === `/payouts/${PO}/override`).map((x) => x.body);
  expect(overrides).toEqual([
    { externalRef: 'MANUAL-TT-55102', documentId: D1 },
    { externalRef: 'MANUAL-TT-55102', documentId: D1, approvalId: A1 },
  ]);
  await expectClean(page, g, mock);
});

test('mandate queue → change → verifier rejects with a note', async ({ page }) => {
  const g = guard(page);
  const change = { id: M1, walletId: W, kind: 'REPLACE_ADMIN', status: 'PENDING', approvalId: A1, approval: 'PENDING', verifier: 'PENDING', newAdminPerson: 'np', approverPerson: null, requestedBy: 'rq' };
  const mock = await mockApi(page, {
    'GET /admin/me': me,
    'GET /admin/queues/approvals': [
      { id: A1, action: 'wallet.replace_admin', subjectType: 'mandate_change', subjectId: M1, walletId: W, makerRole: 'ADMIN', createdAt: '2026-11-10T00:00:00Z', escalatedTo: null, canDecide: false },
      { id: 'other', action: 'hold.release', subjectType: 'hold', subjectId: 'h', walletId: W, makerRole: 'OPS_FINANCE', createdAt: '2026-11-10T00:00:00Z', escalatedTo: null, canDecide: true },
    ],
    [`GET /mandate-changes/${M1}`]: change,
    [`POST /mandate-changes/${M1}/verify`]: { ...change, verifier: 'REJECTED', status: 'REJECTED' },
  });
  await open(page, `${ADMIN}/mandate`);
  await expect(page.getByRole('row')).toHaveCount(2); // header + the one mandate approval
  await page.getByRole('link', { name: 'Open' }).click();
  await page.getByLabel('Outcome').selectOption('REJECTED');
  await expect(page.getByLabel('Reason code').locator('option', { hasText: 'AUTHORITY_SHOWN' })).toHaveCount(0);
  await page.getByLabel('Reason code').selectOption('IDENTITY_MISMATCH');
  await expect(page.getByRole('button', { name: 'Record verification' })).toBeDisabled();
  await page.getByLabel(/^Note/).fill('ID document does not match the new admin');
  await page.getByRole('button', { name: 'Record verification' }).click();
  await expect(page.getByRole('status')).toHaveText('Verification recorded: REJECTED.');
  expect(mock.calls.find((x) => x.path === `/mandate-changes/${M1}/verify`)?.body).toEqual({ outcome: 'REJECTED', reasonCode: 'IDENTITY_MISMATCH', note: 'ID document does not match the new admin' });
  await expectClean(page, g, mock);
});

test('closure checks: pick a wallet, blockers listed, finalise when clear', async ({ page }) => {
  const g = guard(page);
  let blockers = ['OPEN_CASES'];
  const mock = await mockApi(page, {
    'GET /admin/me': me,
    [`GET /wallets/${W}/closure`]: () => ({ walletId: W, status: 'CLOSING', blockers, residual: [] }),
    [`GET /wallets/${W}/statements`]: [],
    [`POST /wallets/${W}/close/finalise`]: { status: 'CLOSED', statements: { family: 's1', auditPack: 's2' } },
  });
  await open(page, `${ADMIN}/closure`);
  await page.getByLabel('Wallet id').fill(W);
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('OPEN_CASES')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finalise closure' })).toBeDisabled();
  blockers = [];
  await page.getByRole('button', { name: 'Re-check' }).click();
  await expect(page.getByText('No blockers: the wallet can be finalised.')).toBeVisible();
  await page.getByRole('button', { name: 'Finalise closure' }).click();
  await expect(page.getByRole('status')).toHaveText('Wallet closed; statements generated.');
  await expectClean(page, g, mock);
});

test('support hand-offs (open WhatsApp escalations) render', async ({ page }) => {
  const g = guard(page);
  const mock = await mockApi(page, {
    'GET /admin/me': me,
    'GET /admin/queues/support': [{ id: 'e1', ref: 'WA-ABCDEFGH', reason: 'USER', status: 'OPEN', createdAt: '2026-11-10T00:00:00Z', lastInboundAt: null, signedIn: false, wallets: [] }],
  });
  await open(page, `${ADMIN}/q/support`);
  await expect(page.getByText('WA-ABCDEFGH')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
  await expectClean(page, g, mock);
});
