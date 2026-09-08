import { test, expect } from '@playwright/test';
import { installHarness, openApp, openWork, work } from './fixtures.mjs';

const waleed = { uid: 'uid-one', role: 'person_1', identityMode: 'D028_TARGET', email: 'waleed@example.test' };
const khalid = { uid: 'uid-two', role: 'person_2', identityMode: 'D028_TARGET', email: 'khalid@example.test' };

function captures(testInfo) {
  return ['level-b-chromium-390x844', 'level-b-chromium-1280x720'].includes(testInfo.project.name);
}
async function shot(page, testInfo, name) {
  if (captures(testInfo)) await page.screenshot({ path: testInfo.outputPath(`phase6-${name}.png`), fullPage: true });
}
async function expectTopLevelWorkDetailsClosed(page) {
  const details = page.locator('[data-work-disclosure]');
  await expect(details).toHaveCount(5);
  for (let index = 0; index < 5; index += 1) await expect(details.nth(index)).not.toHaveAttribute('open', '');
}

test('Waleed Demo uses compact Arabic hierarchy and fixed Waleed to Khalid transfer', async ({ page }, testInfo) => {
  await installHarness(page, { ...waleed, dataMode: 'DEMO', visualPreview: true });
  await openApp(page);

  await expect(page.locator('[data-preview-banner]')).toContainText('بيانات معاينة تجريبية');
  await expect(page.locator('.identity')).toContainText('وليد');
  await expect(page.locator('[data-nav="audit"]')).toHaveCount(0);
  for (const label of ['نظرة عامة','العملاء','الأعمال','التحصيل والتسويات','البحث والتحليلات','التصنيفات']) {
    await expect(page.locator('.nav-list')).toContainText(label);
  }
  await expect(page.locator('[data-dashboard-compact]')).toContainText('أعمال الشهر');
  await expect(page.locator('[data-dashboard-compact]')).not.toContainText('30%');
  await shot(page, testInfo, 'waleed-demo-dashboard');

  await page.locator('[data-nav="works"]').click();
  const worksTable = page.locator('.table-wrap table').first();
  for (const label of ['حالة التنفيذ','حالة الأرشفة','السعر','المدفوع','المتبقي']) await expect(worksTable).toContainText(label);
  await expect(worksTable).not.toContainText('النسبة');
  await shot(page, testInfo, 'waleed-demo-works');

  await openWork(page);
  await expect(page.locator('[data-work-summary]')).toBeVisible();
  await expect(page.locator('[data-work-summary]')).toContainText('عميل اختباري');
  await expect(page.locator('[data-work-summary]')).not.toContainText('30%');
  await expect(page.locator('[data-work-summary]')).not.toContainText('70%');
  await expectTopLevelWorkDetailsClosed(page);
  await expect(page.locator('[data-work-attention]')).toBeVisible();
  await expect(page.locator('[data-financial-request="price-request-1"]')).toHaveCount(1);
  await expect(page.locator('[data-financial-request="ratio-request-1"]')).toHaveCount(1);
  await expect(page.locator('[data-pending-reversal="reversal-1"]')).toHaveCount(1);
  await expect(page.locator('[data-pending-work-request="request-1"]')).toHaveCount(1);
  await expect(page.locator('#s6-price-form')).toHaveCount(0);
  await expect(page.locator('#s7-payment-form')).toHaveCount(0);
  await shot(page, testInfo, 'waleed-demo-work-compact');

  const price = page.locator('[data-work-disclosure="financial-details"]');
  await price.locator('summary').click();
  await expect(price.locator('[data-action="open-price-action"]')).toBeVisible();
  await price.locator('[data-action="open-ratio-action"]').click();
  await expect(page.locator('.dialog #s6-ratio-form')).toBeVisible();
  await page.locator('.dialog [data-action="close-modal"]').last().click();

  const collection = page.locator('[data-work-disclosure="collection-details"]');
  await collection.locator('summary').click();
  await expect(collection.locator('[data-action="open-payment-action"]')).toBeVisible();
  await collection.locator('[data-action="open-payment-action"]').click();
  await expect(page.locator('.dialog #s7-payment-form')).toBeVisible();
  await page.locator('.dialog [data-action="close-modal"]').last().click();

  await page.locator('[data-nav="financial"]').click();
  const settlement = page.locator('[data-settlement-summary]');
  for (const label of ['إجمالي الأسعار المسجلة للأعمال','إجمالي المقبوض فعليًا من العملاء','حصة خالد','حصة وليد','ما استلمه خالد فعليًا','ما استلمه وليد فعليًا','الاشتراكات','رسوم التحويل','الرصيد المرحل','التحويلات الفعلية','الرصيد النهائي الحالي']) {
    await expect(settlement).toContainText(label);
  }
  await expect(page.locator('[data-subscription-readonly]')).toBeVisible();
  await page.locator('[data-action="open-transfer-action"]').click();
  await expect(page.locator('.dialog #s7-transfer-form')).toBeVisible();
  await expect(page.locator('.dialog #s7-transfer-form select[name="from_party"]')).toHaveCount(0);
  await expect(page.locator('.dialog #s7-transfer-form select[name="to_party"]')).toHaveCount(0);
  await expect(page.locator('.dialog')).toContainText('وليد هو المرسل وخالد هو المستلم');
  await page.locator('.dialog [data-action="close-modal"]').last().click();
  await shot(page, testInfo, 'waleed-demo-settlements');

  await page.locator('[data-nav="s8"]').click();
  await expect(page.locator('[data-s8-results]')).toContainText('حالة التنفيذ');
  await expect(page.locator('[data-s8-results]')).toContainText('حالة الأرشفة');
  await shot(page, testInfo, 'waleed-demo-search');
});

test('Khalid Demo exposes account administration then human-readable audit', async ({ page }, testInfo) => {
  await installHarness(page, { ...khalid, dataMode: 'DEMO', visualPreview: true });
  await openApp(page);
  await expect(page.locator('.identity')).toContainText('خالد');
  await expect(page.locator('[data-nav="audit"]')).toContainText('التدقيق وإدارة الحسابات');

  await page.locator('[data-nav="financial"]').click();
  await expect(page.locator('[data-action="open-transfer-action"]')).toHaveCount(0);
  await expect(page.locator('[data-transfer-readonly]')).toContainText('تسجيل التحويل متاح لوليد فقط');
  await page.locator('[data-action="open-subscription-action"]').click();
  await expect(page.locator('.dialog #s7-subscription-form')).toBeVisible();
  await expect(page.locator('.dialog')).toContainText('خالد هو الدافع الفعلي');
  await page.locator('.dialog [data-action="close-modal"]').last().click();

  await page.locator('[data-nav="audit"]').click();
  const order = await page.locator('[data-account-admin], [data-audit-log]').evaluateAll(elements => elements.map(element => element.hasAttribute('data-account-admin') ? 'admin' : 'audit'));
  expect(order).toEqual(['admin', 'audit']);
  await expect(page.locator('.account-admin-row[data-role="person_1"]')).toContainText('وليد');
  await expect(page.locator('.account-admin-row[data-role="person_2"]')).toContainText('خالد');
  await expect(page.locator('[data-audit-log]')).toContainText('وليد عدّل حالة العمل');
  const details = page.locator('.audit-disclosure').first();
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await shot(page, testInfo, 'khalid-demo-audit');
});

for (const [name, identity] of [['Waleed', waleed], ['Khalid', khalid]]) {
  test(`${name} Clean Start has zero operating history and an explicit simulation banner`, async ({ page }, testInfo) => {
    await installHarness(page, { ...identity, dataMode: 'CLEAN', visualPreview: true });
    await openApp(page);
    await expect(page.locator('[data-preview-banner]')).toContainText('بداية نظيفة');
    await expect(page.locator('[data-preview-banner]')).toContainText('ليست عملية تصفير فعلية');
    await page.locator('[data-nav="customers"]').click();
    await expect(page.getByText('لا يوجد عملاء بعد.')).toBeVisible();
    await page.locator('[data-nav="works"]').click();
    await expect(page.getByText(/لا توجد أعمال/)).toBeVisible();
    await page.locator('[data-nav="financial"]').click();
    await expect(page.locator('[data-settlement-summary]')).toContainText('0 ريال');
    if (name === 'Khalid') {
      await page.locator('[data-nav="audit"]').click();
      await expect(page.locator('[data-account-admin]')).toBeVisible();
      await expect(page.getByText('لا توجد سجلات تدقيق متاحة.')).toBeVisible();
    } else {
      await expect(page.locator('[data-nav="audit"]')).toHaveCount(0);
    }
    await shot(page, testInfo, `${name.toLowerCase()}-clean`);
  });
}

test('critical Phase 6 surfaces keep controls inside the viewport and Work Details closed by default', async ({ page }) => {
  await installHarness(page, { ...khalid, dataMode: 'DEMO', visualPreview: true });
  await openApp(page);
  for (const route of ['dashboard','customers','works','financial','s8','catalogs','audit']) {
    await page.locator(`[data-nav="${route}"]`).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${route} horizontal overflow`).toBeLessThanOrEqual(1);
    const escapes = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.filter(element => {
      if (element.closest('.table-wrap, .nav-list')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1;
    }).length);
    expect(escapes, `${route} controls outside viewport`).toBe(0);
  }
  await page.locator('[data-nav="works"]').click();
  await page.locator(`[data-work="${work.id}"]`).click();
  await expectTopLevelWorkDetailsClosed(page);
});
