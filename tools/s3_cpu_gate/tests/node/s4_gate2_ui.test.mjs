import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import worker from '../../src/worker/src/index.js';

const indexPath = fileURLToPath(new URL('../../src/worker/assets/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url));
const cssPath = fileURLToPath(new URL('../../src/worker/assets/styles.css', import.meta.url));

test('S4 Gate 2 static shell is Arabic RTL and loads only local application assets', () => {
  const html = readFileSync(indexPath, 'utf8');
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /src="\/assets\/app\.js"/);
  assert.match(html, /href="\/assets\/styles\.css"/);
  assert.doesNotMatch(html, /password|token|service.?key/i);
});

test('S4 Gate 2 UI client relies on a bearer token provider and never exposes token storage or direct D1 access', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /Authorization', `Bearer \$\{token\}`/);
  assert.match(source, /\/api\/customers/);
  assert.match(source, /\/api\/works/);
  assert.match(source, /\/api\/catalog/);
  assert.match(source, /\/api\/facts/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\.(log|error|warn)|env\.DB|\.prepare\(|database_id/i);
  assert.doesNotMatch(source, /signUp|createUserWithEmailAndPassword/i);
});

test('S4 Gate 2 UI includes clear PRICE_UNSET, fact-derived warning, and non-blocking missing-details language', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /السعر غير محدد/);
  assert.doesNotMatch(source, /لا تمثل الواجهة السعر غير المحدد برقم صفر/);
  assert.match(source, /عند الإضافة يبدأ العمل بعبارة <strong>السعر غير محدد<\/strong> حتى اعتماد سعر/);
  assert.match(source, /لن يُنشأ تحذير يدوي/);
  assert.match(source, /دون منع حفظ المعلومة المفقودة/);
  assert.match(source, /لم تعرض تفاصيل داخلية/);
  assert.match(source, /DUPLICATE_CUSTOMER_AMBIGUITY/);
  assert.match(source, /confirm_duplicate/);
  assert.match(source, /#work-customer/);
  assert.match(source, /refreshWorkCustomerContext/);
  assert.match(source, /parent_work_id: ''/);
  assert.match(source, /FACT_SOURCE_REQUIRED/);
  assert.match(source, /AUDIT_EVIDENCE_MISSING/);
  assert.doesNotMatch(source, /risk percentage|AI classification|scoring|error\.message/i);
});

test('S4/S6 UI preserves approved catalog/history flows while later Worker-backed S7/S8 reads do not introduce Billing', () => {
  const source = readFileSync(appPath, 'utf8');
  assert.match(source, /\/api\/customers\/\$\{encodeURIComponent\(customerId\)\}\/history/);
  assert.match(source, /\/api\/customers\/\$\{encodeURIComponent\(customerId\)\}\/warnings/);
  assert.match(source, /\/api\/works\/\$\{encodeURIComponent\(workId\)\}\/similar/);
  assert.match(source, /\/api\/works\/\$\{encodeURIComponent\(workId\)\}\/financials/);
  assert.match(source, /price-requests/);
  assert.match(source, /ratio-requests/);
  assert.match(source, /\/api\/catalog\/\$\{encodeURIComponent\(values\.kind\)\}/);
  assert.match(source, /warning projection|واقعة موثقة/);
  assert.match(source, /\/api\/works\/\$\{encodeURIComponent\(state\.selectedWork\.id\)\}\/payments/);
  assert.match(source, /\/api\/settlements\/preview/);
  assert.match(source, /\/api\/transfers/);
  assert.doesNotMatch(source, /billing/i);
});

test('S4 Gate 2 Worker serves only requested static assets before auth while private API remains fail-closed', async () => {
  const env = {
    RUN_MARKER: 'run-gate2',
    ASSETS: { fetch: async request => new Response(`asset:${new URL(request.url).pathname}`, { status: 200 }) },
  };
  const asset = await worker.fetch(new Request('https://example.test/assets/app.js'), env);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'asset:/assets/app.js');

  const privateResponse = await worker.fetch(new Request('https://example.test/api/customers'), env);
  assert.equal(privateResponse.status, 401);
  assert.equal((await privateResponse.json()).code, 'TOKEN_MISSING');
});

test('S4 Gate 2 stylesheet keeps RTL shell usable with responsive and reduced-motion safeguards', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.match(css, /\.shell \{ display: grid/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /text-align: right/);
});
