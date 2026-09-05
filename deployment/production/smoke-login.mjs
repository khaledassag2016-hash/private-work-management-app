import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const playwrightEntry = path.join(repositoryRoot, 'tools', 's9_ux', 'node_modules', 'playwright', 'index.mjs');

function invariant(condition, message) {
  if (!condition) throw new Error(`DEPLOYMENT_SMOKE_FAILED: ${message}`);
}

export async function verifyLogin(manifest, candidateVersion = '') {
  const { chromium } = await import(pathToFileURL(playwrightEntry).href);
  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext();
    if (candidateVersion) {
      await context.route(`${manifest.worker.customDomain}/**`, async (route) => {
        await route.continue({
          headers: {
            ...route.request().headers(),
            'Cloudflare-Workers-Version-Overrides': `${manifest.worker.name}="${candidateVersion}"`,
          },
        });
      });
    }
    const page = await context.newPage();
    await page.goto(`${manifest.worker.customDomain}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#login-form').waitFor({ state: 'visible', timeout: 30000 });
    invariant(await page.locator('#email').isVisible(), 'email field is not visible');
    invariant(await page.locator('#password').isVisible(), 'password field is not visible');
    invariant(await page.getByText('تحتاج الواجهة إلى تهيئة تسجيل الدخول من إعدادات النشر قبل الاستخدام.').count() === 0, 'Firebase configuration warning is visible');
    const runtime = await page.evaluate(() => ({
      configured: Boolean(window.__PRIVATE_WORK_APP_CONFIG__?.firebaseConfig),
      projectId: window.__PRIVATE_WORK_APP_CONFIG__?.firebaseConfig?.projectId || '',
    }));
    invariant(runtime.configured, 'Firebase runtime config is absent');
    invariant(runtime.projectId === manifest.firebase.projectId, 'Firebase runtime project differs from the manifest');
    await context.close();
  } finally {
    await browser.close();
  }
  console.log(`LOGIN_SMOKE: PASS${candidateVersion ? ' (Version Override)' : ''}`);
}
