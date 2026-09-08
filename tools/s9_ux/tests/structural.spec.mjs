import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installHarness, openApp, openWork, work } from './fixtures.mjs';

test.beforeEach(async ({ page }) => {
  await installHarness(page);
  await openApp(page);
});

async function openWorkDisclosure(page, name) {
  const disclosure = page.locator(`[data-work-disclosure="${name}"]`);
  if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator('summary').click();
  await expect.poll(() => disclosure.evaluate(element => element.open)).toBe(true);
}

test('RTL, responsive containment, navigation reachability, and state clarity', async ({ page }) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await page.locator('html').evaluate(element => getComputedStyle(element).direction)).toBe('rtl');
  const routes = ['dashboard', 'customers', 'works', 'financial', 's8', 'catalogs'];
  for (const route of routes) {
    await page.locator(`[data-nav="${route}"]`).click();
    await expect(page.locator(`[data-nav="${route}"]`)).toHaveAttribute('aria-current', 'page');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${route} has global horizontal overflow`).toBeLessThanOrEqual(1);
    const horizontalEscapes = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.filter(element => {
      if (element.closest('.table-wrap, .nav-list')) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1;
    }).map(element => element.outerHTML.slice(0, 180)));
    expect(horizontalEscapes, `${route} has controls outside the viewport`).toEqual([]);
  }
  await openWork(page);
  await expect(page.locator('[data-work-summary]')).toHaveCount(1);
  await expect(page.locator('[data-work-summary]')).toBeVisible();
  await expect(page.locator('.detail-header')).toHaveCount(0);
  await expect(page.locator('[data-work-primary-title]')).toHaveText(work.title);
  await expect(page.locator('[data-work-summary] [data-action="edit-work"]')).toBeVisible();
  await expect(page.locator('[data-work-archive-state]')).toContainText('غير مؤرشف');
  await expect(page.locator('[data-work-attention]')).toBeVisible();
  await expect(page.locator('#s5-event-form')).toBeHidden();
  await expect(page.locator('[data-work-execution-state]')).toBeVisible();
  await expect(page.locator('[data-work-archive-state]')).toBeVisible();
  await expect(page.locator('[data-authoritative-price]:visible')).toHaveText('1700 ريال');
  await expect(page.locator('[data-approved-payments]:visible')).toHaveText('1000 ريال');
  await expect(page.locator('[data-remaining]:visible')).toHaveText('700 ريال');
  await openWorkDisclosure(page, 'financial-details');
  await expect(page.locator('[data-action="open-price-action"]')).toBeVisible();
  await expect(page.locator('[data-financial-request]').first()).toBeVisible();
  await expect(page.locator('[data-financial-request="price-request-1"]')).toHaveCount(1);
  const criticalClipping = await page.locator('[data-work-execution-state], [data-work-archive-state], [data-authoritative-price], [data-approved-payments], [data-remaining], [data-action="open-price-action"]').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.left < -1 || rect.right > document.documentElement.clientWidth + 1 || element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
  }).map(element => element.outerHTML.slice(0, 180)));
  expect(criticalClipping, 'critical state or financial truth is clipped').toEqual([]);
  const overlaps = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => {
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    const controls = elements.filter(element => !element.closest('.nav-list, .table-wrap')).map(element => ({ element, rect: element.getBoundingClientRect() })).filter(item => item.rect.right > 0 && item.rect.left < viewport.width && item.rect.bottom > 0 && item.rect.top < viewport.height);
    const found = [];
    for (let left = 0; left < controls.length; left += 1) for (let right = left + 1; right < controls.length; right += 1) {
      const a = controls[left].rect; const b = controls[right].rect;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) found.push([controls[left].element.outerHTML.slice(0, 100), controls[right].element.outerHTML.slice(0, 100)]);
    }
    return found;
  });
  expect(overlaps, 'interactive controls overlap').toEqual([]);
});

test('work disclosure groups open by keyboard and touch', async ({ page }, testInfo) => {
  await openWork(page);
  const financial = page.locator('[data-work-disclosure="financial-details"]');
  await financial.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => financial.evaluate(element => element.open)).toBe(true);
  const collection = page.locator('[data-work-disclosure="collection-details"]');
  if (testInfo.project.metadata.width < 600) await collection.locator('summary').tap();
  else await collection.locator('summary').click();
  await expect(collection).toHaveAttribute('open', '');
});

test('keyboard dialog focus is contained and restored', async ({ page }) => {
  await page.locator('[data-nav="customers"]').click();
  const trigger = page.locator('[data-action="new-customer"]');
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(dialogBounds).not.toBeNull();
  expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.y).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(dialogBounds.y + dialogBounds.height).toBeLessThanOrEqual(viewport.height);
  await expect(dialog.locator('input[name="name"]')).toBeFocused();
  const focusStayedInside = async () => expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await page.keyboard.press('Shift+Tab'); await focusStayedInside();
  await page.keyboard.press('Tab'); await focusStayedInside();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.locator('[data-nav="works"]').click();
  const newWorkTrigger = page.locator('[data-action="new-work"]');
  await newWorkTrigger.focus();
  await newWorkTrigger.press('Enter');
  const workDialog = page.getByRole('dialog');
  await expect(workDialog).toBeVisible();
  await focusStayedInside();
  await page.keyboard.press('Escape');
  await expect(workDialog).toBeHidden();
  await expect(newWorkTrigger).toBeFocused();
});

test('automated accessibility gate has no critical or serious violations', async ({ page }) => {
  const dashboard = await new AxeBuilder({ page }).include('.shell').analyze();
  expect(dashboard.violations.filter(item => ['critical', 'serious'].includes(item.impact))).toEqual([]);
  await page.locator('[data-nav="customers"]').click();
  await page.locator('[data-action="new-customer"]').click();
  const dialog = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(dialog.violations.filter(item => ['critical', 'serious'].includes(item.impact))).toEqual([]);
  const unlabeled = await page.locator('[role="dialog"] input:not([type="hidden"]), [role="dialog"] select, [role="dialog"] textarea').evaluateAll(elements => elements.filter(element => !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby')).map(element => element.outerHTML));
  expect(unlabeled).toEqual([]);
  const unnamedCriticalControls = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.filter(element => !((element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.labels?.[0]?.textContent || element.textContent || element.getAttribute('title') || '').trim())).map(element => element.outerHTML));
  expect(unnamedCriticalControls).toEqual([]);
});

test('touch targets for visible critical controls are at least 44 CSS pixels', async ({ page }, testInfo) => {
  test.skip(testInfo.project.metadata.width >= 600);
  await openWork(page);
  const undersized = await page.locator('button:visible, input:visible, select:visible, textarea:visible').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect();
    return rect.width < 44 || rect.height < 44;
  }).map(element => ({ tag: element.tagName, text: element.textContent?.trim().slice(0, 60), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  expect(undersized).toEqual([]);
});
