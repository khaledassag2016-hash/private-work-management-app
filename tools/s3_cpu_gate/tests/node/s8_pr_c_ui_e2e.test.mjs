import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as worker from '../../src/worker/src/index.js';
import * as XLSX from '../../src/worker/assets/vendor/xlsx-0.20.3.mjs';

const appPath = fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url));
const exporterPath = fileURLToPath(new URL('../../src/worker/assets/s8-export.mjs', import.meta.url));
const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const appContent = readFileSync(appPath, 'utf8');
const schema = readFileSync(schemaPath, 'utf8');
const appRoot = { _html: '', set innerHTML(value) { this._html = value; }, get innerHTML() { return this._html; } };
let lastBlob = null;
let lastDownload = null;

globalThis.window = { __PRIVATE_WORK_APP_CONFIG__: { apiBaseUrl: 'https://api.test', s8ExportModuleUrl: `file://${exporterPath}` }, __PRIVATE_WORK_APP_TEST__: {}, setTimeout: callback => callback() };
globalThis.document = {
  body: { append: () => {} },
  querySelector: selector => {
    if (selector === '#app') return appRoot;
    if (selector === '.toast-region') return null;
    return { addEventListener: () => {}, remove: () => {}, append: () => {}, parentNode: { append: () => {} }, click: () => {}, disabled: false };
  },
  querySelectorAll: () => [],
  createElement: tag => ({ tagName: tag, className: '', append: () => {}, remove: () => {}, textContent: '', parentNode: { append: () => {} }, click() { lastDownload = this; } }),
};
globalThis.Headers = class Headers { constructor(init) { this.map = new Map(Object.entries(init || {})); } set(key, value) { this.map.set(key, value); } };
globalThis.URL.createObjectURL = blob => { lastBlob = blob; return 'blob:s8-pr-c-test'; };

eval(appContent);
const ui = window.__PRIVATE_WORK_APP_TEST__;
const state = ui.getState();

class D1Statement {
  constructor(database, sql) { this.database = database; this.parameterMap = []; this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; }); this.values = []; }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; this.database.bindingWidths.push(this.values.length); return this; }
  first() { this.database.readQueries += 1; return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { this.database.readQueries += 1; return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { this.database.exec('BEGIN IMMEDIATE'); try { const results = statements.map(statement => { const result = this.database.prepare(statement.sql).run(...statement.values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }); this.database.exec('COMMIT'); return Promise.resolve(results); } catch (error) { this.database.exec('ROLLBACK'); return Promise.reject(error); } }
}
function form(values) { globalThis.FormData = class FormData { entries() { return Object.entries(values); } }; return { preventDefault: () => {}, currentTarget: {} }; }
function rawPart(bytes, path) { const archive = XLSX.CFB.read(bytes, { type: 'buffer' }); const entry = XLSX.CFB.find(archive, `Root Entry/${path}`); assert.ok(entry, `missing OOXML part ${path}`); return new TextDecoder().decode(entry.content); }
function assertRealWorkbook(bytes, names) { assert.ok(bytes instanceof Uint8Array); assert.ok(bytes.length > 2000); const book = XLSX.read(bytes, { type: 'array', cellStyles: true, cellNF: true }); assert.deepEqual(book.SheetNames, names); const workbookXml = rawPart(bytes, 'xl/workbook.xml'); const coreXml = rawPart(bytes, 'docProps/core.xml'); assert.ok(!/(externallinks|vbaproject|activex|externalLink)/i.test(workbookXml)); assert.ok(!/(token|firebase|cloudflare|\/home\/)/i.test(coreXml)); names.forEach((_, index) => { const xml = rawPart(bytes, `xl/worksheets/sheet${index + 1}.xml`); assert.match(xml, /rightToLeft="1"/); assert.match(xml, /<autoFilter /); assert.match(xml, /<cols>/); assert.ok(!/<f(?: |>)/.test(xml)); }); return book; }
async function ensureCatalog(env, requestId, kind, value_key, label) { try { await worker.createCatalogValue(env, 'uid-one', requestId, kind, { value_key, label }); } catch (error) { if (error.code !== 'CATALOG_DUPLICATE') throw error; } }
async function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(schema); database.readQueries = 0; database.bindingWidths = [];
  const env = { DB: new D1Database(database), RUN_MARKER: 's8-pr-c-integrated', FIREBASE_PROJECT_ID: 'demo-project' };
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', env.RUN_MARKER);
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', env.RUN_MARKER);
  await ensureCatalog(env, 's8-pr-c-country', 'country', 'SA', 'السعودية'); await ensureCatalog(env, 's8-pr-c-specialty', 'specialty', 'IT', 'تقنية المعلومات'); await ensureCatalog(env, 's8-pr-c-type', 'work_type', 'REPORT', 'تقرير');
  const customer = await worker.createCustomer(env, 'uid-one', 's8-pr-c-customer', { name: 'عميل S8 E2E', country: 'SA', university: 'جامعة الاختبار', specialty: 'IT' });
  const active = await worker.createWork(env, 'uid-one', 's8-pr-c-active-work', { customer_id: customer.id, title: 'Current Active Work', country: 'SA', university: 'جامعة الاختبار', specialty_key: 'IT', work_type_key: 'REPORT', status: 'COMPLETED', confirmed_at: '2026-08-10T00:00:00.000Z' });
  const archived = await worker.createWork(env, 'uid-one', 's8-pr-c-archived-work', { customer_id: customer.id, title: 'Archived Original Title', country: 'SA', university: 'جامعة الاختبار', specialty_key: 'IT', work_type_key: 'REPORT', status: 'COMPLETED' });
  const noReply = await worker.createWork(env, 'uid-one', 's8-pr-c-no-reply', { customer_id: customer.id, title: 'Waiting Client Reply', country: 'SA', university: 'جامعة الاختبار', specialty_key: 'IT', work_type_key: 'REPORT', status: 'WAITING_CLIENT_RESPONSE' });
  database.prepare('UPDATE works SET created_at=?, confirmed_at=? WHERE id=?').run('2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', active.id);
  database.prepare('UPDATE works SET created_at=?, confirmed_at=? WHERE id=?').run('2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', archived.id);
  database.prepare('UPDATE works SET created_at=? WHERE id=?').run('2026-08-10T00:00:00.000Z', noReply.id);
  const titleChanged = await worker.changeWorkTitle(env, 'uid-one', 's8-pr-c-title', archived.id, { version: 1, new_title: 'Archived Current Title', reason: 'S8 historical title evidence' });
  const archiveRequest = await worker.createCancelArchiveRequest(env, 'uid-one', 's8-pr-c-archive-request', archived.id, { version: titleChanged.version, action: 'ARCHIVE', reason: 'S8 historical archive evidence' });
  await worker.approveCancelArchiveRequest(env, 'uid-two', 's8-pr-c-archive-approval', archived.id, archiveRequest.id);
  const activePriceRequest = await worker.createPriceChangeRequest(env, 'uid-one', 's8-pr-c-price-active', active.id, { version: 1, movement_type: 'BASE', amount_riyals: '1700.00', reason: 'S8 authoritative price' });
  await worker.approvePriceChangeRequest(env, 'uid-two', 's8-pr-c-price-active-approve', active.id, activePriceRequest.id);
  const archivedAfterArchive = await worker.getWork(env, archived.id); const archivedPriceRequest = await worker.createPriceChangeRequest(env, 'uid-one', 's8-pr-c-price-archived', archived.id, { version: archivedAfterArchive.version, movement_type: 'BASE', amount_riyals: '900.00', reason: 'S8 archived authoritative price' });
  await worker.approvePriceChangeRequest(env, 'uid-two', 's8-pr-c-price-archived-approve', archived.id, archivedPriceRequest.id);
  await worker.createWorkEvent(env, 'uid-one', 's8-pr-c-event', active.id, { event_type: 'FOLLOW_UP', description: '=SUM(1,1)', effective_at: '2026-08-12T00:00:00.000Z' });
  return { database, env, customer, active, archived, noReply };
}
function b64url(bytes) { return Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
async function installAuthenticatedWorkerTransport(env, database, trace) {
  const directory = mkdtempSync(join(tmpdir(), 's8-pr-c-auth-')); const privateKeyPath = join(directory, 'private-key.pem'); const certificatePath = join(directory, 'certificate.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=s8-pr-c-test', '-keyout', privateKeyPath, '-out', certificatePath], { stdio: 'ignore' });
  const keyPem = readFileSync(privateKeyPath, 'utf8'); const keyLabel = ['PRIVATE', 'KEY'].join(' '); const keyPattern = new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`); const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(keyPem.match(keyPattern)[1].replace(/\s+/g, ''), 'base64')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const certificatePem = readFileSync(certificatePath, 'utf8'); const now = Math.floor(Date.now() / 1000); const json = value => b64url(new TextEncoder().encode(JSON.stringify(value))); const signed = `${json({ alg: 'RS256', kid: 's8-pr-c-test', typ: 'JWT' })}.${json({ aud: 'demo-project', iss: 'https://securetoken.google.com/demo-project', sub: 'uid-one', iat: now - 10, auth_time: now - 10, exp: now + 3600 })}`; const token = `${signed}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signed))))}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = url instanceof Request ? url.url : String(url);
    if (href.includes('/robot/v1/metadata/x509/')) return new Response(JSON.stringify({ 's8-pr-c-test': certificatePem }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
    const rawHeaders = options.headers?.map ? [...options.headers.map.entries()] : options.headers; const request = url instanceof Request ? url : new Request(href, { ...options, headers: rawHeaders }); const parsed = new URL(request.url); trace.push({ path: parsed.pathname, method: request.method, query: Object.fromEntries(parsed.searchParams.entries()), authorization: request.headers.get('authorization') }); const before = database.readQueries; const response = await worker.default.fetch(request, env); trace.at(-1).read_queries = database.readQueries - before; return response;
  };
  return { token, dispose() { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); } };
}
function setupState(customer, token) { state.auth = { status: 'signed_in', uid: 'uid-one', email: 'uid-one@test.com', role: 'person_1', tokenProvider: { getToken: async () => token } }; state.busy = false; state.view = 's8'; state.customers = [customer]; state.catalogs = { country: [{ value_key: 'SA', label: 'السعودية', active: true }], specialty: [{ value_key: 'IT', label: 'تقنية المعلومات', active: true }], work_type: [{ value_key: 'REPORT', label: 'تقرير', active: true }] }; state.s8 = { filters: { q: '', period_basis: 'CREATED_AT', month: '08', year: '2026', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: false }, search: { items: [], page: 1, page_size: 25, has_more: false }, analytics: null, alerts: null, alertSettings: [], export_type: 'WORK', export_work_id: '', export_customer_id: '', loading: false }; }

test('S8 PR-C authenticates every UI request through Worker, configures D-017 FR-029, proves archive scope, and produces real XLSX from DTOs', { skip: !(() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })() }, async () => {
  const { database, env, customer, active, archived, noReply } = await fixture(); const trace = []; const transport = await installAuthenticatedWorkerTransport(env, database, trace); setupState(customer, transport.token); database.readQueries = 0; database.bindingWidths = [];
  try {
    await ui.loadS8Workspace();
    let html = ui.s8SearchPage(); assert.match(html, /data-s8-search-panel/); assert.match(html, /Current Active Work/); assert.doesNotMatch(html, /Archived Current Title/); assert.match(html, /data-s8-alerts/); assert.doesNotMatch(html, /CLOCK_ANCHOR_UNRESOLVED|FR-029 PASS/); assert.equal(state.s8.alerts.alerts.every(alert => alert.state === 'NOT_CONFIGURED'), true); assert.match(html, /غير مضبوط/);
    await ui.submitS8AlertSettings(form({ threshold_NO_PRICE: '1', threshold_NO_REPLY: '1', threshold_NO_PAYMENT: '1' })); assert.equal(state.s8.alerts.alerts.every(alert => alert.state === 'CONFIGURED'), true); assert.equal(state.s8.alertSettings.every(setting => setting.state === 'CONFIGURED'), true); const alertByType = new Map(state.s8.alerts.alerts.map(alert => [alert.alert_type, alert])); assert.ok(alertByType.get('NO_PRICE').items.some(item => item.work_id === noReply.id)); assert.ok(alertByType.get('NO_REPLY').items.some(item => item.work_id === noReply.id)); assert.ok(alertByType.get('NO_PAYMENT').items.some(item => item.work_id === active.id)); html = ui.s8SearchPage(); assert.match(html, /data-s8-alerts/); assert.match(html, /مضبوط/); assert.match(html, /Waiting Client Reply/); assert.doesNotMatch(html, /Fail-Closed: لا توجد ساعة حاكمة/);
    let workTypeGroup = state.s8.analytics.groups.WORK_TYPE.find(row => row.bucket === 'REPORT'); assert.equal(workTypeGroup.work_count, 2); assert.equal(workTypeGroup.active_work_count, 2); assert.equal(workTypeGroup.archived_work_count, 0);
    await ui.s8ApplySearch(form({ q: 'Archived Original Title', period_basis: 'CREATED_AT', month: '08', year: '2026', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: 'on' })); assert.equal(state.s8.search.items.length, 1); assert.equal(state.s8.search.items[0].id, archived.id); assert.equal(state.s8.search.items[0].is_archived, true); html = ui.s8SearchPage(); assert.match(html, /Archived Current Title/); assert.match(html, /تاريخي مؤرشف/); workTypeGroup = state.s8.analytics.groups.WORK_TYPE.find(row => row.bucket === 'REPORT'); assert.equal(workTypeGroup.work_count, 3); assert.equal(workTypeGroup.active_work_count, 2); assert.equal(workTypeGroup.archived_work_count, 1);
    await ui.s8ApplySearch(form({ q: '', period_basis: 'CREATED_AT', month: '08', year: '2026', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: undefined })); assert.equal(state.s8.search.items.length, 2); assert.equal(state.s8.search.items.some(row => row.is_archived), false);
    const archiveHistory = await worker.listWorkArchiveHistory(env, archived.id); assert.equal(archiveHistory.length, 1); assert.equal(archiveHistory[0].reason, 'S8 historical archive evidence');
    const exportCases = [
      ['WORK', { work_id: active.id, customer_id: '' }, ['ملخص العمل', 'سجل العناوين', 'سجل الحالة', 'متابعة', 'التحصيل']],
      ['MONTH', { work_id: '', customer_id: '' }, ['أعمال الشهر', 'التحصيل', 'التسوية']],
      ['FOLLOW_UP', { work_id: '', customer_id: '' }, ['سجل المتابعة']],
      ['CUSTOMER', { work_id: '', customer_id: customer.id }, ['تقرير العميل', 'أعمال العميل', 'التحصيل', 'التحذيرات']],
      ['CLASSIFICATION', { work_id: '', customer_id: '' }, ['حسب النوع', 'حسب التخصص', 'حسب الدولة', 'حسب الجامعة', 'حسب الفترة']],
    ];
    for (const [exportType, ids, expectedSheets] of exportCases) { lastBlob = null; lastDownload = null; await ui.submitS8Export(form({ export_type: exportType, ...ids })); assert.ok(lastBlob instanceof Blob, `missing Blob for ${exportType}`); assert.match(lastDownload.download, new RegExp(`^s8-${exportType.toLowerCase()}-.*\\.xlsx$`)); const bytes = new Uint8Array(await lastBlob.arrayBuffer()); const book = assertRealWorkbook(bytes, expectedSheets); assert.ok(book.SheetNames.length > 0); }
    const apiCalls = trace.filter(call => call.path.startsWith('/api/')); const protectedCalls = apiCalls.filter(call => call.path !== '/private/ping'); assert.ok(protectedCalls.length >= 20); assert.ok(protectedCalls.every(call => call.authorization === `Bearer ${transport.token}`)); assert.equal(apiCalls.filter(call => call.method === 'POST' && call.path === '/api/alerts/settings').length, 3); assert.equal(apiCalls.filter(call => call.method === 'POST' && call.path !== '/api/alerts/settings').length, 0); assert.ok(apiCalls.some(call => call.path === '/api/alerts/settings' && call.method === 'GET')); assert.ok(apiCalls.some(call => call.path === '/api/alerts' && call.method === 'GET')); const customerExportCalls = apiCalls.filter(call => call.path.startsWith('/api/exports/customer/')); assert.ok(customerExportCalls.length >= 1); assert.ok(customerExportCalls.every(call => call.read_queries <= 5)); assert.ok(Math.max(...database.bindingWidths, 0) <= 100);
    const latestWorkspace = apiCalls.filter(call => ['/api/search/works', '/api/analytics', '/api/alerts', '/api/alerts/settings'].includes(call.path)); const exportCalls = apiCalls.filter(call => call.path.startsWith('/api/exports/')); console.log(`S8_PR_C_D1_MEASUREMENT authenticated_workspace_calls=${latestWorkspace.length} export_calls=${exportCalls.length} customer_export_max_queries=${Math.max(...customerExportCalls.map(call => call.read_queries), 0)} max_bind=${Math.max(...database.bindingWidths, 0)} works=3`);
  } finally { transport.dispose(); database.close(); }
});
