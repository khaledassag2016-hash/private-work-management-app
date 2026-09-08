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
function nav(page, id) {
  return page.locator(`.nav-list [data-nav="${id}"]`);
}

// ... rest of file unchanged
