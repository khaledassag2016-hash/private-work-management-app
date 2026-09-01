import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installHarness, openApp, openWork, work } from './fixtures.mjs';

const capabilityMatrix = JSON.parse(readFileSync(new URL('../capability-matrix.json', import.meta.url), 'utf8'));

let api;
test.beforeEach(async ({ page }) => {
  api = await installHarness(page);
  await openApp(page);
});

function handleNextDialog(page, action, pattern = /تأكيد إجراء حساس/) {
  page.once('dialog', async dialog => { expect(dialog.message()).toMatch(pattern); await dialog[action](); });
}

async function submitConfirmed(page, form, path) {
  const before = api.count('POST', path);
  handleNextDialog(page, 'accept');
  await page.locator(`${form} button[type="submit"]`).click();
  await expect.poll(() => api.count('POST', path)).toBe(before + 1);
}

test('A-M capability matrix is reachable with identical mobile and desktop functions', async ({ page }) => {
  expect(capabilityMatrix.capabilities.map(item => item.id)).toEqual('ABCDEFGHIJKLM'.split(''));
  expect(capabilityMatrix.capabilities.every(item => item.mobile === 'required' && item.desktop === 'required')).toBe(true);
  await expect(page.locator('.nav-item')).toHaveCount(6);
  await page.locator('[data-nav="customers"]').click();
  await expect(page.locator(`[data-customer="customer-1"]`)).toBeVisible();
  await page.locator('[data-action="new-customer"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await openWork(page);
  for (const selector of ['#s5-event-form', '#s5-title-form', '#s5-status-form', '#s5-cancel-form', '#s5-archive-form', '#s6-price-form', '#s6-ratio-form', '#s7-payment-form']) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('[data-action="approve-request"]')).toBeVisible();
  await expect(page.locator('[data-action="approve-price-request"]')).toBeVisible();
  await expect(page.locator('[data-action="approve-ratio-request"]')).toBeVisible();
  await expect(page.locator('[data-action="request-payment-reversal"]')).toBeVisible();
  await expect(page.locator('[data-action="approve-payment-reversal"]')).toBeVisible();
  await page.locator('[data-nav="financial"]').click();
  for (const selector of ['#s7-transfer-form', '#s7-subscription-form', '#s7-expense-form', '#s7-settlement-close-form', '#s7-reopen-form']) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('[data-action="approve-settlement-reopen"]')).toBeVisible();
  await page.locator('[data-nav="s8"]').click();
  await expect(page.locator('#s8-search-form')).toBeVisible();
  await expect(page.locator('[data-s8-results-panel]')).toContainText(work.title);
  await expect(page.locator('[data-s8-analytics]')).toBeVisible();
  await expect(page.locator('#s8-alert-settings-form')).toBeVisible();
  await expect(page.locator('#s8-export-form select[name="export_type"] option')).toHaveCount(5);
});

test('sensitive actions cancel with zero requests and confirm exactly once', async ({ page }) => {
  await openWork(page);
  await page.locator('#s5-archive-form input[name="reason"]').fill('سبب أرشفة اصطناعي');
  const archivePath = `/api/works/${work.id}/requests`;
  const archiveBefore = api.count('POST', archivePath);
  handleNextDialog(page, 'dismiss');
  await page.locator('#s5-archive-form button[type="submit"]').click();
  expect(api.count('POST', archivePath)).toBe(archiveBefore);
  await submitConfirmed(page, '#s5-archive-form', archivePath);

  await page.locator('#s6-price-form input[name="amount_riyals"]').fill('100.00');
  await page.locator('#s6-price-form input[name="reason"]').fill('زيادة اصطناعية');
  await submitConfirmed(page, '#s6-price-form', `/api/works/${work.id}/price-requests`);
  await page.locator('#s6-ratio-form input[name="reason"]').fill('استثناء اصطناعي');
  await submitConfirmed(page, '#s6-ratio-form', `/api/works/${work.id}/ratio-requests`);

  for (const [selector, path] of [
    ['[data-action="approve-request"]', `/api/works/${work.id}/requests/request-1/approve`],
    ['[data-action="approve-price-request"]', `/api/works/${work.id}/price-requests/price-request-1/approve`],
    ['[data-action="approve-ratio-request"]', `/api/works/${work.id}/ratio-requests/ratio-request-1/approve`],
    ['[data-action="approve-payment-reversal"]', `/api/works/${work.id}/payment-reversal-requests/reversal-1/approve`],
  ]) {
    const before = api.count('POST', path); handleNextDialog(page, 'accept'); await page.locator(selector).click(); await expect.poll(() => api.count('POST', path)).toBe(before + 1);
  }

  await page.locator('[data-action="request-payment-reversal"]').click();
  await page.locator('#payment-reversal-form input[name="reason"]').fill('تصحيح اصطناعي');
  await submitConfirmed(page, '#payment-reversal-form', `/api/works/${work.id}/payment-reversal-requests`);

  await page.locator('[data-nav="financial"]').click();
  const settlementPeriod = await page.locator('#s7-settlement-period-form input[name="period_key"]').inputValue();
  await page.locator('#s7-transfer-form input[name="amount_riyals"]').fill('20.00');
  await page.locator('#s7-transfer-form input[name="effective_at"]').fill('2026-08-13T12:00');
  await submitConfirmed(page, '#s7-transfer-form', '/api/transfers');
  await page.locator('#s7-subscription-form input[name="effective_at"]').fill('2026-08-13T12:00');
  await submitConfirmed(page, '#s7-subscription-form', '/api/subscriptions');
  await page.locator('#s7-expense-form input[name="amount_riyals"]').fill('10.00');
  await page.locator('#s7-expense-form input[name="category"]').fill('مصروف اصطناعي');
  await page.locator('#s7-expense-form input[name="effective_at"]').fill('2026-08-13T12:00');
  await submitConfirmed(page, '#s7-expense-form', '/api/expenses');
  await submitConfirmed(page, '#s7-settlement-close-form', `/api/settlements/${settlementPeriod}/close`);
  await page.locator('#s7-reopen-form input[name="reason"]').fill('إعادة فتح اصطناعية');
  await submitConfirmed(page, '#s7-reopen-form', `/api/settlements/${settlementPeriod}/reopen-requests`);
  const reopenApprove = `/api/settlements/${settlementPeriod}/reopen-requests/reopen-1/approve`;
  const beforeApprove = api.count('POST', reopenApprove); handleNextDialog(page, 'accept'); await page.locator('[data-action="approve-settlement-reopen"]').click(); await expect.poll(() => api.count('POST', reopenApprove)).toBe(beforeApprove + 1);
});

test('double click, double tap, repeated Enter, and click while pending send one mutation', async ({ page }, testInfo) => {
  await openWork(page);
  const form = page.locator('#s7-payment-form');
  await form.locator('input[name="amount_riyals"]').fill('100.00');
  await form.locator('input[name="effective_at"]').fill('2026-08-13T12:00');
  const path = `/api/works/${work.id}/payments`;
  const release = api.holdNext('POST', path);
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => { const formElement = document.querySelector('#s7-payment-form'); formElement.requestSubmit(); formElement.requestSubmit(); });
  await expect.poll(() => api.count('POST', path)).toBe(1);
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await expect(form.locator('button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  if (testInfo.project.metadata.width < 600) await form.locator('button[type="submit"]').tap({ force: true });
  else await form.locator('button[type="submit"]').click({ force: true });
  await form.locator('input[name="amount_riyals"]').press('Enter');
  expect(api.count('POST', path)).toBe(1);
  release();
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
});

test('400/401/403/409/fail-closed/500/network errors are visible, recoverable, and preserve input', async ({ page }) => {
  await openWork(page);
  const form = page.locator('#s5-event-form');
  await form.locator('input[name="event_type"]').fill('FOLLOW_UP');
  await form.locator('input[name="description"]').fill('نص يجب ألا يضيع');
  await form.locator('input[name="effective_at"]').fill('2026-08-13T12:00');
  const path = `/api/works/${work.id}/events`;
  const cases = [[400, 'HTTP_400'], [401, 'HTTP_401'], [403, 'HTTP_403'], [409, 'VERSION_CONFLICT'], [409, 'S7_OVERPAYMENT_POLICY_UNRESOLVED'], [500, 'HTTP_500']];
  for (const [status, code] of cases) {
    api.failNext(status, code, path);
    await form.locator('button[type="submit"]').click();
    await expect(page.getByRole('alert').last()).toBeVisible();
    await expect(form.locator('input[name="description"]')).toHaveValue('نص يجب ألا يضيع');
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
  }
  api.abortNext(path);
  await form.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert').last()).toContainText('الاتصال');
  await expect(form.locator('input[name="description"]')).toHaveValue('نص يجب ألا يضيع');
  const before = api.count('POST', path);
  await form.locator('button[type="submit"]').click();
  await expect.poll(() => api.count('POST', path)).toBe(before + 1);
});

test('D-017 confirmation and all five local XLSX triggers complete', async ({ page }) => {
  await page.locator('[data-nav="s8"]').click();
  const alertPath = '/api/alerts/settings';
  const alertBefore = api.count('POST', alertPath);
  handleNextDialog(page, 'dismiss');
  await page.locator('#s8-alert-settings-form button[type="submit"]').click();
  expect(api.count('POST', alertPath)).toBe(alertBefore);
  handleNextDialog(page, 'accept');
  await page.locator('#s8-alert-settings-form button[type="submit"]').click();
  await expect.poll(() => api.count('POST', alertPath)).toBe(alertBefore + 3);

  const exportForm = page.locator('#s8-export-form');
  await exportForm.locator('input[name="work_id"]').fill(work.id);
  await exportForm.locator('input[name="customer_id"]').fill('customer-1');
  for (const type of ['WORK', 'MONTH', 'FOLLOW_UP', 'CUSTOMER', 'CLASSIFICATION']) {
    await exportForm.locator('select[name="export_type"]').selectOption(type);
    const downloadPromise = page.waitForEvent('download');
    await exportForm.locator('button[type="submit"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^s8-${type.toLowerCase()}-.*\\.xlsx$`));
  }
});
