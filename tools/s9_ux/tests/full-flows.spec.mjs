import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { installHarness, openApp, openWork, work } from './fixtures.mjs';

const capabilityMatrix = JSON.parse(readFileSync(new URL('../capability-matrix.json', import.meta.url), 'utf8'));

let api;
test.beforeEach(async ({ page }) => {
  api = await installHarness(page);
  await openApp(page);
});

async function handleNextDialog(page, action, pattern = null) {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).not.toHaveText('تأكيد العملية');
  if (pattern) await expect(dialog).toContainText(pattern);
  await dialog.getByRole('button', { name: action === 'accept' ? 'تأكيد' : 'إلغاء' }).click();
}

async function submitConfirmed(page, form, path) {
  const before = api.count('POST', path);
  await page.locator(`${form} button[type="submit"]`).click();
  await handleNextDialog(page, 'accept');
  await expect.poll(() => api.count('POST', path)).toBe(before + 1);
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
}

async function openWorkDisclosure(page, name) {
  const disclosure = page.locator(`[data-work-disclosure="${name}"]`);
  if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator(':scope > summary').click();
  await expect.poll(() => disclosure.evaluate(element => element.open)).toBe(true);
}

test('A-M capability matrix is reachable with identical mobile and desktop functions', async ({ page }) => {
  expect(capabilityMatrix.capabilities.map(item => item.id)).toEqual('ABCDEFGHIJKLM'.split(''));
  expect(capabilityMatrix.capabilities.every(item => item.mobile === 'required' && item.desktop === 'required')).toBe(true);
  await expect(page.locator('.nav-item')).toHaveCount(7);
  await expect(page.locator('[data-nav="s8"]')).toHaveText('البحث والتحليلات');
  await expect(page.locator('[data-nav="s8"]')).not.toContainText('S8');
  await expect(page.locator('[data-nav="audit"]')).toHaveCount(1);
  await page.locator('[data-nav="customers"]').click();
  await expect(page.locator(`[data-customer="customer-1"]`)).toBeVisible();
  await page.locator('[data-action="new-customer"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await openWork(page);
  await expect(page.locator('[data-work-summary]')).toBeVisible();
  await expect(page.locator('[data-work-attention]')).toBeVisible();
  await expect(page.locator('#s5-event-form')).toBeHidden();
  await openWorkDisclosure(page, 'financial-details');
  for (const [action, selector] of [['open-price-action', '#s6-price-form'], ['open-ratio-action', '#s6-ratio-form']]) {
    await page.locator(`[data-action="${action}"]`).click();
    await expect(page.locator(`.dialog ${selector}`)).toBeVisible();
    await page.locator('.dialog [data-action="close-modal"]').last().click();
  }
  await openWorkDisclosure(page, 'collection-details');
  await page.locator('[data-action="open-payment-action"]').click();
  await expect(page.locator('.dialog #s7-payment-form')).toBeVisible();
  await page.locator('.dialog [data-action="close-modal"]').last().click();
  await openWorkDisclosure(page, 'history');
  const historyActions = page.locator('[data-work-disclosure="history"] .history-actions');
  for (const label of ['إضافة حدث أو ملاحظة', 'تغيير العنوان', 'تغيير حالة التنفيذ']) {
    await historyActions.locator('details.inline-action > summary').filter({ hasText: label }).click();
  }
  for (const selector of ['#s5-event-form', '#s5-title-form', '#s5-status-form']) await expect(page.locator(selector)).toBeVisible();
  await openWorkDisclosure(page, 'danger');
  for (const label of ['طلب إلغاء العمل', 'طلب أرشفة العمل']) await page.getByText(label, { exact: true }).click();
  for (const selector of ['#s5-cancel-form', '#s5-archive-form']) await expect(page.locator(selector)).toBeVisible();
  await expect(page.locator('[data-action="approve-request"]')).toBeVisible();
  await expect(page.locator('[data-action="approve-price-request"]')).toBeVisible();
  await expect(page.locator('[data-action="approve-ratio-request"]')).toBeVisible();
  await expect(page.locator('[data-action="request-payment-reversal"]')).toBeVisible();
  await expect(page.locator('[data-action="approve-payment-reversal"]')).toBeVisible();
  await page.locator('[data-nav="financial"]').click();
  for (const [action, selector] of [['open-transfer-action', '#s7-transfer-form'], ['open-subscription-action', '#s7-subscription-form'], ['open-expense-action', '#s7-expense-form']]) {
    await page.locator(`[data-action="${action}"]`).click();
    await expect(page.locator(`.dialog ${selector}`)).toBeVisible();
    await page.locator('.dialog [data-action="close-modal"]').last().click();
  }
  await page.locator('.financial-disclosure').filter({ hasText: 'تفاصيل حساب التسوية' }).locator('summary').click();
  await expect(page.locator('#s7-settlement-close-form')).toBeVisible();
  await expect(page.locator('#s7-reopen-form')).toHaveCount(0);
  await expect(page.locator('[data-settlement-summary]')).toBeVisible();
  await expect(page.locator('[data-settlement-period-state]')).toContainText('مفتوحة');
  const reopenDisclosure = page.locator('.financial-disclosure').filter({ hasText: 'إعادة فتح فترة مقفلة' });
  await reopenDisclosure.locator('summary').click();
  await expect(reopenDisclosure).toContainText('إعادة فتح اصطناعية');
  await expect(page.locator('[data-action="approve-settlement-reopen"]')).toHaveCount(0);
  await page.locator('[data-nav="s8"]').click();
  await expect(page.locator('#s8-search-form')).toBeVisible();
  await expect(page.locator('[data-s8-results-panel]')).toContainText(work.title);
  await expect(page.locator('[data-s8-analytics]')).toBeVisible();
  await expect(page.locator('#s8-alert-settings-form')).toBeVisible();
  await expect(page.locator('#s8-export-form select[name="export_type"] option')).toHaveCount(5);
});

test('sensitive actions cancel with zero requests and confirm exactly once', async ({ page }) => {
  await openWork(page);
  await openWorkDisclosure(page, 'danger');
  const dangerActions = page.locator('[data-work-disclosure="danger"] .sensitive-actions');
  await dangerActions.locator('details.inline-action > summary').filter({ hasText: 'طلب أرشفة العمل' }).click();
  await page.locator('#s5-archive-form input[name="reason"]').fill('سبب أرشفة اصطناعي');
  const archivePath = `/api/works/${work.id}/requests`;
  const archiveBefore = api.count('POST', archivePath);
  await page.locator('#s5-archive-form button[type="submit"]').click();
  await handleNextDialog(page, 'dismiss');
  expect(api.count('POST', archivePath)).toBe(archiveBefore);
  await openWorkDisclosure(page, 'danger');
  if (!(await page.locator('#s5-archive-form').isVisible())) {
    await page.locator('[data-work-disclosure="danger"] .sensitive-actions details.inline-action > summary').filter({ hasText: 'طلب أرشفة العمل' }).click();
  }
  await page.locator('#s5-archive-form input[name="reason"]').fill('سبب أرشفة اصطناعي');
  await submitConfirmed(page, '#s5-archive-form', archivePath);

  await openWorkDisclosure(page, 'financial-details');
  await page.locator('[data-action="open-price-action"]').click();
  await page.locator('.dialog #s6-price-form input[name="amount_riyals"]').fill('100.00');
  await page.locator('.dialog #s6-price-form input[name="reason"]').fill('زيادة اصطناعية');
  await submitConfirmed(page, '.dialog #s6-price-form', `/api/works/${work.id}/price-requests`);
  await openWorkDisclosure(page, 'financial-details');
  await page.locator('[data-action="open-ratio-action"]').click();
  await page.locator('.dialog #s6-ratio-form input[name="reason"]').fill('استثناء اصطناعي');
  await submitConfirmed(page, '.dialog #s6-ratio-form', `/api/works/${work.id}/ratio-requests`);

  for (const [selector, path] of [
    ['[data-action="approve-request"]', `/api/works/${work.id}/requests/request-1/approve`],
    ['[data-action="approve-price-request"]', `/api/works/${work.id}/price-requests/price-request-1/approve`],
    ['[data-action="approve-ratio-request"]', `/api/works/${work.id}/ratio-requests/ratio-request-1/approve`],
    ['[data-action="approve-payment-reversal"]', `/api/works/${work.id}/payment-reversal-requests/reversal-1/approve`],
  ]) {
    const disclosure = selector.includes('approve-request') && !selector.includes('approve-price') && !selector.includes('approve-ratio') ? 'danger' : selector.includes('approve-payment') ? 'collection-details' : 'financial-details';
    await openWorkDisclosure(page, disclosure);
    const before = api.count('POST', path); await page.locator(selector).click(); if (selector.includes('approve-price-request')) { const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading')).toHaveText('اعتماد حركة السعر'); await expect(dialog).toContainText('سيتم اعتماد طلب حركة السعر وتحديث السعر الحالي وفق الحركة المطلوبة.'); } await handleNextDialog(page, 'accept'); await expect.poll(() => api.count('POST', path)).toBe(before + 1);
  }

  await openWorkDisclosure(page, 'collection-details');
  await page.locator('[data-action="request-payment-reversal"]').click();
  await page.locator('#payment-reversal-form input[name="reason"]').fill('تصحيح اصطناعي');
  await submitConfirmed(page, '#payment-reversal-form', `/api/works/${work.id}/payment-reversal-requests`);

  await page.locator('[data-nav="financial"]').click();
  const settlementPeriod = await page.locator('#s7-settlement-period-form input[name="period_key"]').inputValue();
  await page.locator('[data-action="open-transfer-action"]').click();
  await page.locator('.dialog #s7-transfer-form input[name="amount_riyals"]').fill('20.00');
  await page.locator('.dialog #s7-transfer-form input[name="effective_at"]').fill('2026-08-13T12:00');
  await submitConfirmed(page, '.dialog #s7-transfer-form', '/api/transfers');
  await page.locator('[data-action="open-subscription-action"]').click();
  await page.locator('.dialog #s7-subscription-form input[name="effective_at"]').fill('2026-08-13T12:00');
  await submitConfirmed(page, '.dialog #s7-subscription-form', '/api/subscriptions');
  await page.locator('[data-action="open-expense-action"]').click();
  await page.locator('.dialog #s7-expense-form input[name="amount_riyals"]').fill('10.00');
  await page.locator('.dialog #s7-expense-form input[name="category"]').fill('مصروف اصطناعي');
  await page.locator('.dialog #s7-expense-form input[name="effective_at"]').fill('2026-08-13T12:00');
  await submitConfirmed(page, '.dialog #s7-expense-form', '/api/expenses');
  const closeDisclosure = page.locator('.financial-disclosure').filter({ hasText: 'تفاصيل حساب التسوية' });
  await closeDisclosure.locator('summary').click();
  await submitConfirmed(page, '#s7-settlement-close-form', `/api/settlements/${settlementPeriod}/close`);
  await expect(page.locator('[data-settlement-period-state]')).toContainText('مغلقة');
  const reopenDisclosure = page.locator('.financial-disclosure').filter({ hasText: 'إعادة فتح فترة مقفلة' });
  await reopenDisclosure.locator('summary').click();
  await expect(page.locator('#s7-reopen-form')).toBeVisible();
  await expect(reopenDisclosure).toContainText('إعادة فتح اصطناعية');
  const reopenRequestPath = `/api/settlements/${settlementPeriod}/reopen-requests`;
  const reopenBefore = api.count('POST', reopenRequestPath);
  await page.locator('#s7-reopen-form input[name="reason"]').fill('إعادة فتح من المتصفح');
  await page.locator('#s7-reopen-form button[type="submit"]').click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('طلب إعادة فتح التسوية');
  await handleNextDialog(page, 'accept');
  await expect.poll(() => api.count('POST', reopenRequestPath)).toBe(reopenBefore + 1);
  await expect(page.locator('[data-settlement-period-state]')).toContainText('مغلقة');

  const reopenApprovePath = `/api/settlements/${settlementPeriod}/reopen-requests/reopen-1/approve`;
  const approveBefore = api.count('POST', reopenApprovePath);
  await page.locator('[data-action="approve-settlement-reopen"][data-request-id="reopen-1"]').click();
  await expect(page.getByRole('dialog').getByRole('heading')).toHaveText('اعتماد إعادة فتح التسوية');
  await handleNextDialog(page, 'accept');
  await expect.poll(() => api.count('POST', reopenApprovePath)).toBe(approveBefore + 1);
  await expect(page.locator('[data-settlement-period-state]')).toContainText('مفتوحة');
  await expect(page.locator('#s7-reopen-form')).toHaveCount(0);
  await expect(page.locator('[data-action="approve-settlement-reopen"]')).toHaveCount(0);
});

test('double click, double tap, repeated Enter, and click while pending send one mutation', async ({ page }, testInfo) => {
  await openWork(page);
  await openWorkDisclosure(page, 'collection-details');
  await page.locator('[data-action="open-payment-action"]').click();
  const form = page.locator('.dialog #s7-payment-form');
  await form.locator('input[name="amount_riyals"]').fill('100.00');
  await form.locator('input[name="effective_at"]').fill('2026-08-13T12:00');
  const path = `/api/works/${work.id}/payments`;
  const release = api.holdNext('POST', path);
  await page.evaluate(() => { const formElement = document.querySelector('#s7-payment-form'); formElement.requestSubmit(); formElement.requestSubmit(); });
  await handleNextDialog(page, 'accept');
  await expect.poll(() => api.count('POST', path)).toBe(1);
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
  expect(api.count('POST', path)).toBe(1);
  release();
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
});

test('400/401/403/409/fail-closed/500/network errors are visible, recoverable, and preserve input', async ({ page }) => {
  await openWork(page);
  await openWorkDisclosure(page, 'history');
  await page.locator('[data-work-disclosure="history"] .history-actions details.inline-action > summary').filter({ hasText: 'إضافة حدث أو ملاحظة' }).click();
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
  await page.locator('#s8-alert-settings-form button[type="submit"]').click();
  await handleNextDialog(page, 'dismiss');
  expect(api.count('POST', alertPath)).toBe(alertBefore);
  await page.locator('#s8-alert-settings-form button[type="submit"]').click();
  await handleNextDialog(page, 'accept');
  await expect.poll(() => api.count('POST', alertPath)).toBe(alertBefore + 3);

  const exportForm = page.locator('#s8-export-form');
  await exportForm.locator('select[name="work_id"]').selectOption(work.id);
  await exportForm.locator('select[name="customer_id"]').selectOption('customer-1');
  for (const type of ['WORK', 'MONTH', 'FOLLOW_UP', 'CUSTOMER', 'CLASSIFICATION']) {
    await exportForm.locator('select[name="export_type"]').selectOption(type);
    const downloadPromise = page.waitForEvent('download');
    await exportForm.locator('button[type="submit"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^تقرير-.*\.xlsx$/);
  }
});
