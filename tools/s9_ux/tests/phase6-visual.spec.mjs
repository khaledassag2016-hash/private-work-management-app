import { test, expect } from '@playwright/test';
import { installHarness, openApp, openWork, work } from './fixtures.mjs';

test('Phase 6 target Waleed view uses fixed transfer direction and hides supervisor-only audit/admin', async ({ page }) => {
  await installHarness(page, { uid: 'uid-one', role: 'person_1', identityMode: 'D028_TARGET', email: 'waleed@example.test' });
  await openApp(page);

  await expect(page.locator('.identity')).toContainText('وليد');
  await expect(page.locator('[data-nav="audit"]')).toHaveCount(0);

  await page.locator('[data-nav="works"]').click();
  await expect(page.locator('th')).toContainText(['العنوان', 'العميل', 'النوع', 'حالة التنفيذ', 'حالة الأرشفة', 'السعر']);
  await openWork(page);
  await expect(page.locator('[data-work-summary]')).toBeVisible();
  await expect(page.locator('[data-work-customer]')).toContainText('عميل اختباري');
  await expect(page.locator('[data-work-ratio]')).toContainText('30% وليد');
  await expect(page.locator('[data-work-ratio]')).toContainText('70% خالد');
  await expect(page.locator('[data-work-execution-state]')).toContainText('قيد التنفيذ');
  await expect(page.locator('[data-work-archive-state]')).toContainText('غير مؤرشف');

  await page.locator('[data-nav="financial"]').click();
  await expect(page.locator('#s7-transfer-form')).toBeVisible();
  await expect(page.locator('#s7-transfer-form select[name="from_party"]')).toHaveCount(0);
  await expect(page.locator('#s7-transfer-form select[name="to_party"]')).toHaveCount(0);
  await expect(page.locator('#s7-transfer-form')).toContainText('وليد → خالد');
  await expect(page.locator('[data-subscription-readonly]')).toBeVisible();
  await expect(page.locator('[data-settlement-summary]')).toContainText('المقبوض الفعلي المعتمد');

  await page.locator('[data-nav="s8"]').click();
  await expect(page.locator('[data-s8-results] th')).toContainText(['حالة التنفيذ', 'حالة الأرشفة']);
  await expect(page.locator('[data-s8-work-row]')).toContainText('غير مؤرشف');
  await expect(page.locator('[data-s8-work-row]')).not.toContainText('نشط');
});

test('Phase 6 target Khalid view exposes supervisor audit/admin and keeps transfers read-only', async ({ page }) => {
  await installHarness(page, { uid: 'uid-two', role: 'person_2', identityMode: 'D028_TARGET', email: 'khalid@example.test' });
  await openApp(page);

  await expect(page.locator('.identity')).toContainText('خالد');
  await expect(page.locator('[data-nav="audit"]')).toBeVisible();

  await page.locator('[data-nav="financial"]').click();
  await expect(page.locator('#s7-transfer-form')).toHaveCount(0);
  await expect(page.locator('[data-transfer-readonly]')).toContainText('تسجيل التحويل متاح لوليد فقط');
  await expect(page.locator('#s7-subscription-form')).toBeVisible();

  await page.locator('[data-nav="audit"]').click();
  const admin = page.locator('[data-account-admin]');
  const audit = page.locator('[data-audit-log]');
  await expect(admin).toBeVisible();
  await expect(audit).toBeVisible();
  const order = await page.locator('[data-account-admin], [data-audit-log]').evaluateAll(elements => elements.map(element => element.getAttribute('data-account-admin') !== null ? 'admin' : 'audit'));
  expect(order).toEqual(['admin', 'audit']);
  await expect(admin.locator('[data-role="person_1"]')).toContainText('وليد');
  await expect(admin.locator('[data-role="person_2"]')).toContainText('خالد');

  const details = audit.locator('.audit-disclosure').first();
  await expect(details).not.toHaveAttribute('open', '');
  await expect(audit).toContainText('ملخص موجز افتراضيًا');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details).toContainText('وليد');
  await expect(details).toContainText('خالد');
});

test('Phase 6 target critical surfaces remain contained at the configured mobile and desktop viewport', async ({ page }) => {
  await installHarness(page, { uid: 'uid-two', role: 'person_2', identityMode: 'D028_TARGET', email: 'khalid@example.test' });
  await openApp(page);
  const routes = ['dashboard', 'works', 'financial', 's8', 'audit'];
  for (const route of routes) {
    await page.locator(`[data-nav="${route}"]`).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${route} has global horizontal overflow`).toBeLessThanOrEqual(1);
    const escapes = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.filter(element => {
      if (element.closest('.table-wrap, .nav-list')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1;
    }).map(element => element.outerHTML.slice(0, 160)));
    expect(escapes, `${route} has controls outside viewport`).toEqual([]);
  }
});
