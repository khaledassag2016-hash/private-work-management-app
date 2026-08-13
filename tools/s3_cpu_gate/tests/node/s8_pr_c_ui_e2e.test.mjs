import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => status >= 200 && status < 300 ? { ok: true, data } : { ok: false, code: data?.code || 'INTERNAL_ERROR' } }; }
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
  const active = await worker.createWork(env, 'uid-one', 's8-pr-c-active-work', { customer_id: customer.id, title: 'Current Active Work', country: 'SA', university: 'جامعة الاختبار', specialty_key: 'IT', work_type_key: 'REPORT', status: 'COMPLETED' });
  const archived = await worker.createWork(env, 'uid-one', 's8-pr-c-archived-work', { customer_id: customer.id, title: 'Archived Original Title', country: 'SA', university: 'جامعة الاختبار', specialty_key: 'IT', work_type_key: 'REPORT', status: 'COMPLETED' });
  database.prepare('UPDATE works SET created_at=?, confirmed_at=? WHERE id=?').run('2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', active.id);
  database.prepare('UPDATE works SET created_at=?, confirmed_at=? WHERE id=?').run('2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', archived.id);
  const titleChanged = await worker.changeWorkTitle(env, 'uid-one', 's8-pr-c-title', archived.id, { version: 1, new_title: 'Archived Current Title', reason: 'S8 historical title evidence' });
  const archiveRequest = await worker.createCancelArchiveRequest(env, 'uid-one', 's8-pr-c-archive-request', archived.id, { version: titleChanged.version, action: 'ARCHIVE', reason: 'S8 historical archive evidence' });
  await worker.approveCancelArchiveRequest(env, 'uid-two', 's8-pr-c-archive-approval', archived.id, archiveRequest.id);
  const activePriceRequest = await worker.createPriceChangeRequest(env, 'uid-one', 's8-pr-c-price-active', active.id, { version: 1, movement_type: 'BASE', amount_riyals: '1700.00', reason: 'S8 authoritative price' });
  await worker.approvePriceChangeRequest(env, 'uid-two', 's8-pr-c-price-active-approve', active.id, activePriceRequest.id);
  const archivedAfterArchive = await worker.getWork(env, archived.id); const archivedPriceRequest = await worker.createPriceChangeRequest(env, 'uid-one', 's8-pr-c-price-archived', archived.id, { version: archivedAfterArchive.version, movement_type: 'BASE', amount_riyals: '900.00', reason: 'S8 archived authoritative price' });
  await worker.approvePriceChangeRequest(env, 'uid-two', 's8-pr-c-price-archived-approve', archived.id, archivedPriceRequest.id);
  await worker.createWorkEvent(env, 'uid-one', 's8-pr-c-event', active.id, { event_type: 'FOLLOW_UP', description: '=SUM(1,1)', effective_at: '2026-08-12T00:00:00.000Z' });
  return { database, env, customer, active, archived };
}
function installWorkerAdapter(env, trace) {
  let requestNo = 0;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url); const path = parsed.pathname; const method = options.method || 'GET'; const query = Object.fromEntries(parsed.searchParams.entries()); trace.push({ path, method, query }); const requestId = `s8-pr-c-ui-${++requestNo}`;
    try {
      if (path === '/api/search/works' && method === 'GET') return response(await worker.searchWorksS8(env, query));
      if (path === '/api/analytics' && method === 'GET') return response(await worker.getS8Analytics(env, query));
      if (path === '/api/alerts' && method === 'GET') return response(await worker.getS8Alerts(env, query));
      const work = path.match(/^\/api\/exports\/work\/([^/]+)$/); if (work && method === 'GET') return response(await worker.getS8WorkExportDto(env, decodeURIComponent(work[1])));
      if (path === '/api/exports/month' && method === 'GET') return response(await worker.getS8MonthExportDto(env, query));
      if (path === '/api/exports/follow-up' && method === 'GET') return response(await worker.getS8FollowUpExportDto(env, query));
      const customer = path.match(/^\/api\/exports\/customer\/([^/]+)$/); if (customer && method === 'GET') return response(await worker.getS8CustomerExportDto(env, decodeURIComponent(customer[1]), query));
      if (path === '/api/exports/classification' && method === 'GET') return response(await worker.getS8ClassificationExportDto(env, query));
      throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND', status: 404 });
    } catch (error) { return response({ code: error.code || 'INTERNAL_ERROR' }, error.status || 400); }
  };
}
function setupState(customer) { state.auth = { status: 'signed_in', uid: 'uid-one', email: 'uid-one@test.com', role: 'person_1', tokenProvider: { getToken: async () => 'mock-token' } }; state.busy = false; state.view = 's8'; state.customers = [customer]; state.catalogs = { country: [{ value_key: 'SA', label: 'السعودية', active: true }], specialty: [{ value_key: 'IT', label: 'تقنية المعلومات', active: true }], work_type: [{ value_key: 'REPORT', label: 'تقرير', active: true }] }; state.s8 = { filters: { q: '', period_basis: 'CREATED_AT', month: '08', year: '2026', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: false }, search: { items: [], page: 1, page_size: 25, has_more: false }, analytics: null, alerts: null, export_type: 'WORK', export_work_id: '', export_customer_id: '', loading: false }; }


test('S8 PR-C integrated UI→Worker DTO→real XLSX proves search filters, archive history, analytics, alert fail-closed, and bounded reads', async () => {
  const { database, env, customer, active, archived } = await fixture(); const trace = []; installWorkerAdapter(env, trace); setupState(customer); database.readQueries = 0; database.bindingWidths = [];
  try {
    await ui.loadS8Workspace();
    let html = ui.s8SearchPage(); assert.match(html, /بحث وتحليلات وتصدير S8/); assert.match(html, /Current Active Work/); assert.doesNotMatch(html, /Archived Current Title/); assert.match(html, /Fail-Closed/); assert.match(html, /NO_PRICE \| NO_REPLY \| NO_PAYMENT/); assert.equal(state.s8.alerts.now, null); assert.doesNotMatch(html, /FR-029 PASS/);
    let workTypeGroup = state.s8.analytics.groups.WORK_TYPE.find(row => row.bucket === 'REPORT'); assert.equal(workTypeGroup.work_count, 1); assert.equal(workTypeGroup.active_work_count, 1); assert.equal(workTypeGroup.archived_work_count, 0);
    await ui.s8ApplySearch(form({ q: 'Archived Original Title', period_basis: 'CREATED_AT', month: '08', year: '2026', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: 'on' })); assert.equal(state.s8.search.items.length, 1); assert.equal(state.s8.search.items[0].id, archived.id); assert.equal(state.s8.search.items[0].is_archived, true); html = ui.s8SearchPage(); assert.match(html, /Archived Current Title/); assert.match(html, /تاريخي مؤرشف/); workTypeGroup = state.s8.analytics.groups.WORK_TYPE.find(row => row.bucket === 'REPORT'); assert.equal(workTypeGroup.work_count, 2); assert.equal(workTypeGroup.active_work_count, 1); assert.equal(workTypeGroup.archived_work_count, 1);
    await ui.s8ApplySearch(form({ q: '', period_basis: 'CREATED_AT', month: '08', year: '2026', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: undefined })); assert.equal(state.s8.search.items.length, 1); assert.equal(state.s8.search.items[0].id, active.id); assert.equal(state.s8.search.items.some(row => row.is_archived), false);
    const pageCalls = trace.filter(call => call.path === '/api/search/works'); assert.ok(pageCalls.every(call => call.query.page === '1')); assert.ok(pageCalls.every(call => call.query.page_size === '25'));
    const archiveHistory = await worker.listWorkArchiveHistory(env, archived.id); assert.equal(archiveHistory.length, 1); assert.equal(archiveHistory[0].reason, 'S8 historical archive evidence');
    const exportCases = [
      ['WORK', { work_id: active.id, customer_id: '' }, ['ملخص العمل', 'سجل العناوين', 'سجل الحالة', 'متابعة', 'التحصيل']],
      ['MONTH', { work_id: '', customer_id: '' }, ['أعمال الشهر', 'التحصيل', 'التسوية']],
      ['FOLLOW_UP', { work_id: '', customer_id: '' }, ['سجل المتابعة']],
      ['CUSTOMER', { work_id: '', customer_id: customer.id }, ['تقرير العميل', 'أعمال العميل', 'التحصيل', 'التحذيرات']],
      ['CLASSIFICATION', { work_id: '', customer_id: '' }, ['حسب النوع', 'حسب التخصص', 'حسب الدولة', 'حسب الجامعة', 'حسب الفترة']],
    ];
    for (const [exportType, ids, expectedSheets] of exportCases) { lastBlob = null; lastDownload = null; await ui.submitS8Export(form({ export_type: exportType, ...ids })); assert.ok(lastBlob instanceof Blob, `missing Blob for ${exportType}`); assert.match(lastDownload.download, new RegExp(`^s8-${exportType.toLowerCase()}-.*\\.xlsx$`)); const bytes = new Uint8Array(await lastBlob.arrayBuffer()); const book = assertRealWorkbook(bytes, expectedSheets); assert.ok(book.SheetNames.length > 0); }
    const perInvocationReads = []; for (const call of trace.filter(item => item.path.startsWith('/api/exports/')).slice(-5)) perInvocationReads.push(call.path); assert.ok(perInvocationReads.length >= 5);
    assert.equal(trace.filter(call => call.method === 'POST').length, 0); assert.equal(trace.some(call => call.path === '/api/alerts/settings'), false); assert.ok(database.readQueries < 40); assert.ok(Math.max(...database.bindingWidths, 0) <= 100);
    console.log(`S8_PR_C_D1_MEASUREMENT ui_search_analytics_alert_reads=${trace.filter(call => ['/api/search/works', '/api/analytics', '/api/alerts'].includes(call.path)).length} export_calls=${perInvocationReads.length} total_read_queries=${database.readQueries} max_bind=${Math.max(...database.bindingWidths, 0)} works=2`);
  } finally { database.close(); }
});
