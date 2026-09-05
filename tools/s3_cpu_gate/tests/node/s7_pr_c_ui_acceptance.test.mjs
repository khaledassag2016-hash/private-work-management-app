import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as worker from '../../src/worker/src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// datetime-local values are interpreted in the product's configured Riyadh timezone.
process.env.TZ = 'Asia/Riyadh';

const appPath = fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url));
const appContent = readFileSync(appPath, 'utf8');
const appRoot = { _html: '', set innerHTML(value) { this._html = value; }, get innerHTML() { return this._html; } };

globalThis.window = {
  __PRIVATE_WORK_APP_CONFIG__: { apiBaseUrl: 'https://api.test' },
  __PRIVATE_WORK_APP_TEST__: {},
  setTimeout: callback => callback(),
};
globalThis.document = {
  body: { append: () => {} },
  querySelector: selector => {
    if (selector === '#app') return appRoot;
    if (selector === '.toast-region') return null;
    return { addEventListener: () => {}, remove: () => {}, append: () => {}, parentNode: { append: () => {} } };
  },
  querySelectorAll: () => [],
  createElement: () => ({ className: '', append: () => {}, remove: () => {}, textContent: '', parentNode: { append: () => {} } }),
};
globalThis.Headers = class Headers {
  constructor(init) { this.map = new Map(Object.entries(init || {})); }
  set(key, value) { this.map.set(key, value); }
};

eval(appContent);
const ui = window.__PRIVATE_WORK_APP_TEST__;
const state = ui.getState();

function response(data, ok = true, code = '') {
  return { ok, status: ok ? 200 : 409, json: async () => ok ? { ok: true, data } : { ok: false, code } };
}
function form(values) {
  globalThis.FormData = class FormData { entries() { return Object.entries(values); } };
  return { preventDefault: () => {}, currentTarget: {} };
}
function setup({ uid = 'uid-one', role = 'person_1', work = null } = {}) {
  state.auth = { status: 'signed_in', uid, email: `${uid}@test.com`, role, tokenProvider: { getToken: async () => 'mock-token' } };
  state.busy = false;
  state.view = 'work';
  state.selectedWork = work;
  state.financial = { periodKey: '2026-08', preview: null, snapshots: [], reopenRequests: [], transfers: [], subscriptions: [], expenses: [] };
}
function financials({ price = 170000, paid = 0, collection = 'UNPAID', payments = [] } = {}) {
  return {
    work_id: 'w1', price_state: 'PRICE_APPROVED', current_price_halalas: price,
    approved_payments_total_halalas: paid, remaining_halalas: price - paid, collection_status: collection,
    remaining_projection: paid ? 'S7_APPROVED_PAYMENTS_LEDGER' : 'PRE_S7_APPROVED_PAYMENTS_ZERO',
    shares: { person_1_halalas: 119000, person_2_halalas: 51000 }, ratio: { person_1_bps: 7000, person_2_bps: 3000, source: 'DEFAULT' },
    movements: [], price_requests: [], ratio_requests: [], ratio_history: [], payments,
  };
}
function workPayload(financial = financials()) {
  return { id: 'w1', title: 'عمل مالي تجريبي', version: 4, customer_id: 'c1', country: 'SA', work_type_key: 'REPORT', status: 'COMPLETED', relationship_kind: 'INDEPENDENT', pricing_state: financial.price_state, current_price_halalas: financial.current_price_halalas, financials: financial, similar: [], events: [], titleHistory: [], statusHistory: [], archiveHistory: [], requests: [], payments: financial.payments, reversalRequests: [] };
}
function preview({ unresolved_code = null, prior = 0 } = {}) {
  return { period_key: '2026-08', work_count: 1, cumulative_work_count: 1, total_work_value_halalas: 170000, person_1_work_share_halalas: 119000, person_2_work_share_halalas: 51000, approved_receipts_halalas: 100000, transfer_amount_halalas: 5000, transfer_fee_halalas: 100, subscription_total_halalas: 13650, governed_expense_total_halalas: 0, prior_balance_halalas: prior, final_balance_halalas: 26000 + prior, unresolved_code };
}
function installWorkFetch(financial = financials(), reversalRequests = []) {
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') return response({ id: 'created' });
    if (path.endsWith('/financials')) return response(financial);
    if (path.endsWith('/payments')) return response(financial.payments || []);
    if (path.endsWith('/payment-reversal-requests')) return response(reversalRequests);
    if (path.endsWith('/similar') || path.endsWith('/events') || path.endsWith('/title-history') || path.endsWith('/status-history') || path.endsWith('/archive-history') || path.endsWith('/requests')) return response([]);
    return response(workPayload(financial));
  };
}
function installFinancialFetch({ previewValue = preview(), reopenRequests = [] } = {}) {
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') return response({ id: 'created' });
    if (path === '/api/settlements/preview') return response(previewValue);
    if (path === '/api/settlements') return response([]);
    if (path.endsWith('/reopen-requests')) return response(reopenRequests);
    if (path === '/api/transfers' || path === '/api/subscriptions' || path === '/api/expenses') return response([]);
    return response({});
  };
}

test('S7 PR-C Work UI shows authoritative collection truth separately from execution and keeps a pending self-request unapplied', () => {
  const payment = { id: 'pay-1', amount_halalas: 100000, payment_method: 'BANK_TRANSFER', effective_at: '2026-08-12T00:00:00.000Z', received_by: 'uid-one', recorded_by: 'uid-one', reversal_state: 'PENDING', reversal_request_id: 'rev-1', reversal_requested_by: 'uid-one', reversal_requested_at: '2026-08-13T00:00:00.000Z' };
  setup({ work: workPayload(financials({ paid: 100000, collection: 'PARTIALLY_COLLECTED', payments: [payment] })) });
  state.selectedWork.reversalRequests = [{ id: 'rev-1', amount_halalas: 100000, state: 'PENDING', reason: 'تصحيح تجريبي', requested_by: 'uid-one' }];
  const html = ui.workPage();
  assert.match(html, /إجمالي التحصيل المعتمد/);
  assert.match(html, /1000 ريال/);
  assert.match(html, /700 ريال/);
  assert.match(html, /تحصيل جزئي/);
  assert.match(html, /حالة التنفيذ/);
  assert.match(html, /طلب تصحيح معلق — لا يغير التحصيل/);
  assert.match(html, /لا يمكنك اعتماد طلبك/);
  assert.doesNotMatch(html, /data-action="approve-payment-reversal" data-request-id="rev-1"/);
});

test('S7 PR-C payment and reversal handlers post governed payloads then refetch authoritative Work financial state', async () => {
  setup({ work: workPayload() });
  const calls = [];
  installWorkFetch(financials({ paid: 100000, collection: 'PARTIALLY_COLLECTED' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    return originalFetch(url, options);
  };
  await ui.submitPayment(form({ amount_riyals: '1000.00', effective_at: '2026-08-12T12:00', payment_method: 'BANK_TRANSFER', note: 'دفعة تجريبية' }));
  await ui.submitPaymentReversalRequest(form({ payment_id: 'pay-1', reason: 'سبب موثق' }));
  await ui.handleApprovePaymentReversal('rev-1');
  const posts = calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.slice(0, 3).map(call => call.path), ['/api/works/w1/payments', '/api/works/w1/payment-reversal-requests', '/api/works/w1/payment-reversal-requests/rev-1/approve']);
  assert.equal(posts[0].body.version, 4);
  assert.equal(posts[0].body.amount_riyals, '1000.00');
  assert.equal(posts[1].body.reason, 'سبب موثق');
  assert.ok(calls.filter(call => call.path === '/api/works/w1/financials' && call.method === undefined).length >= 3);
  assert.equal(state.busy, false);
});

test('S7 PR-C financial workspace keeps full details while Wave 2 summary and period actions follow the current state', () => {
  setup({ uid: 'uid-one' });
  state.view = 'financial';
  const common = { periodKey: '2026-08', preview: preview({ unresolved_code: 'S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED' }), transfers: [{ amount_halalas: 5000, from_party: 'person_1', to_party: 'person_2', fee_halalas: 100, effective_at: '2026-08-15T00:00:00.000Z' }], subscriptions: [{ state: 'ACTIVE', aggregate_amount_halalas: 13650, effective_at: '2026-08-01T00:00:00.000Z', paid_by_uid: 'uid-two' }], expenses: [{ amount_halalas: 2000, category: 'مصروف تجريبي', paid_by_uid: 'uid-one', effective_at: '2026-08-20T00:00:00.000Z' }] };

  const historicalRequest = { id: 'reopen-other', state: 'PENDING', reason: 'سبب تاريخي للمراجعة', requested_by: 'uid-two', requested_at: '2026-08-30T00:00:00.000Z' };
  state.financial = { ...common, snapshots: [{ version: 1, state: 'CLOSED', final_balance_halalas: 26000, created_at: '2026-08-31T00:00:00.000Z' }], reopenRequests: [historicalRequest] };
  const closedHtml = ui.financialPage();
  assert.match(closedHtml, /data-settlement-summary/);
  for (const label of ['إجمالي قيمة أعمال الشهر', 'حصة خالد', 'حصة وليد', 'إجمالي الاشتراكات', 'رسوم التحويل']) assert.match(closedHtml, new RegExp(label));
  assert.match(closedHtml, /عدد الأعمال/);
  assert.match(closedHtml, /المتحصل من العميل/);
  assert.match(closedHtml, /الرصيد السابق/);
  assert.match(closedHtml, /الرصيد النهائي/);
  assert.match(closedHtml, /التسوية تحتاج مراجعة قبل الإقفال/);
  assert.match(closedHtml, /حالة الفترة: مغلقة/);
  assert.doesNotMatch(closedHtml, /id="s7-settlement-close-form"/);
  assert.match(closedHtml, /id="s7-reopen-form"/);
  assert.match(closedHtml, /سبب تاريخي للمراجعة/);
  assert.match(closedHtml, /data-action="approve-settlement-reopen" data-request-id="reopen-other"/);
  assert.match(closedHtml, /يسري من تسوية .*سبتمبر/);
  assert.doesNotMatch(closedHtml, /2026-09|September 2026|سلطوية بالهللات|الحالة السلطوية|الخادم|لا تفترض الواجهة|لا تنشئ الواجهة/);

  state.financial = { ...common, preview: preview(), snapshots: [], reopenRequests: [historicalRequest] };
  const openHtml = ui.financialPage();
  assert.match(openHtml, /حالة الفترة: مفتوحة/);
  assert.match(openHtml, /id="s7-settlement-close-form"/);
  assert.doesNotMatch(openHtml, /id="s7-reopen-form"/);
  assert.match(openHtml, /سبب تاريخي للمراجعة/);
  assert.doesNotMatch(openHtml, /data-action="approve-settlement-reopen"/);
});

test('S7 PR-C transfer, subscription, expense, settlement close and reopen workflows call only authoritative APIs and refetch workspace state', async () => {
  setup({ uid: 'uid-two', role: 'person_2' });
  const calls = [];
  installFinancialFetch({ previewValue: preview(), reopenRequests: [] });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => { calls.push({ path: new URL(url).pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null }); return originalFetch(url, options); };
  await ui.loadFinancialWorkspace('2026-08');
  await ui.submitTransfer(form({ amount_riyals: '50.00', fee_riyals: '1.00', effective_at: '2026-08-12T12:00', from_party: 'person_1', to_party: 'person_2' }));
  await ui.submitSubscription(form({ state: 'ACTIVE', aggregate_amount_riyals: '136.50', effective_at: '2026-09-01T00:00' }));
  await ui.submitExpense(form({ amount_riyals: '20.00', category: 'مصروف تجريبي', paid_by_uid: 'uid-two', effective_at: '2026-08-13T00:00' }));
  await ui.submitSettlementClose(form({}));
  await ui.submitSettlementReopen(form({ reason: 'تصحيح مصرح' }));
  await ui.handleApproveSettlementReopen('reopen-u1');
  const posts = calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(call => call.path), ['/api/transfers', '/api/subscriptions', '/api/expenses', '/api/settlements/2026-08/close', '/api/settlements/2026-08/reopen-requests', '/api/settlements/2026-08/reopen-requests/reopen-u1/approve']);
  assert.equal(posts[0].body.fee_payer, 'person_1');
  assert.equal(posts[1].body.aggregate_amount_riyals, '136.50');
  assert.equal(posts[3].body.prior_balance_riyals, undefined);
  assert.ok(calls.filter(call => call.path === '/api/settlements/preview' && call.method === undefined).length >= 6);
  assert.equal(state.busy, false);
});

test('S7 PR-C reload/reopen consumes payments and reversal requests from authoritative endpoints without local storage or direct D1 access', async () => {
  const payment = { id: 'pay-reload', amount_halalas: 170000, payment_method: 'CASH', effective_at: '2026-08-12T00:00:00.000Z', received_by: 'uid-one', recorded_by: 'uid-one', reversal_state: 'APPROVED', reversal_amount_halalas: 170000 };
  setup(); installWorkFetch(financials({ paid: 0, collection: 'UNPAID', payments: [payment] }), [{ id: 'rev-reload', state: 'APPROVED', amount_halalas: 170000, requested_by: 'uid-one', approved_by: 'uid-two', reason: 'تصحيح' }]);
  await ui.openWork('w1');
  assert.equal(state.selectedWork.payments[0].id, 'pay-reload');
  assert.equal(state.selectedWork.reversalRequests[0].id, 'rev-reload');
  assert.match(ui.workPage(), /تم التصحيح بسجل عكسي معتمد/);
  assert.doesNotMatch(appContent, /localStorage|sessionStorage|D1Database|\.prepare\(/);
});

test('S7 PR-C collection display keeps completed execution independent across zero, full, PRICE_UNSET, and zero-price financial truth', () => {
  setup({ work: workPayload(financials({ paid: 0, collection: 'UNPAID' })) });
  let html = ui.workPage();
  assert.match(html, /مكتمل/); assert.match(html, /غير محصل/); assert.match(html, /1700 ريال/);
  setup({ work: workPayload(financials({ paid: 170000, collection: 'FINANCIALLY_CLOSED' })) });
  html = ui.workPage();
  assert.match(html, /مغلق ماليًا/); assert.match(html, /0 ريال/);
  const unset = financials(); unset.price_state = 'PRICE_UNSET'; unset.current_price_halalas = null; unset.remaining_halalas = null; unset.collection_status = 'PRICE_UNSET';
  setup({ work: workPayload(unset) }); html = ui.workPage();
  assert.match(html, /لا يمكن إدخال دفعة لأن السعر المعتمد غير محدد/); assert.doesNotMatch(html, /id="s7-payment-form"/);
  const zero = financials({ price: 0, paid: 0, collection: 'FINANCIALLY_CLOSED' });
  setup({ work: workPayload(zero) }); html = ui.workPage();
  assert.match(html, /هذا العمل بسعر معتمد صفر؛ لا تُدخل دفعة موجبة/); assert.doesNotMatch(html, /id="s7-payment-form"/);
  assert.match(ui.errorMessage('CLOSED_PERIOD_MUTATION_FORBIDDEN'), /إعادة فتح معتمدة/);
});

test('S7 PR-C executes both reopen approval directions through the same authoritative endpoint', async () => {
  const calls = [];
  installFinancialFetch();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => { calls.push({ path: new URL(url).pathname, method: options.method }); return originalFetch(url, options); };
  setup({ uid: 'uid-two', role: 'person_2' }); await ui.loadFinancialWorkspace('2026-08'); await ui.handleApproveSettlementReopen('u1-to-u2');
  setup({ uid: 'uid-one', role: 'person_1' }); await ui.loadFinancialWorkspace('2026-08'); await ui.handleApproveSettlementReopen('u2-to-u1');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/api/settlements/2026-08/reopen-requests/u1-to-u2/approve', '/api/settlements/2026-08/reopen-requests/u2-to-u1/approve']);
});

class IntegratedStatement {
  constructor(database, sql) { this.database = database; this.parameterMap = []; this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; }); this.values = []; }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; this.database.bindingWidths.push(this.values.length); return this; }
  first() { this.database.readQueries += 1; return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { this.database.readQueries += 1; return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
class IntegratedD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new IntegratedStatement(this.database, sql); }
  batch(statements) { this.database.exec('BEGIN IMMEDIATE'); try { const results = statements.map(statement => { const result = this.database.prepare(statement.sql).run(...statement.values); return { success: true, results: [], meta: { changes: Number(result.changes) } }; }); this.database.exec('COMMIT'); return Promise.resolve(results); } catch (error) { this.database.exec('ROLLBACK'); return Promise.reject(error); } }
}
const integratedSchemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const integratedSchema = readFileSync(integratedSchemaPath, 'utf8');
function integratedResponse(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => ({ ok: status >= 200 && status < 300, data }) }; }
function integratedError(error) { return { ok: false, status: error?.status || 400, json: async () => ({ ok: false, code: error?.code || 'INTERNAL_ERROR' }) }; }
function integratedForm(values) { globalThis.FormData = class FormData { entries() { return Object.entries(values); } }; return { preventDefault: () => {}, currentTarget: {} }; }
async function integratedCatalog(env, kind, key, label) { return worker.createCatalogValue(env, 'uid-one', `integrated-${kind}-${key}`, kind, { value_key: key, label }); }
async function integratedFixture() {
  const database = new DatabaseSync(':memory:'); database.exec(integratedSchema); database.readQueries = 0; database.bindingWidths = [];
  const env = { DB: new IntegratedD1(database), RUN_MARKER: 'pr-c-integrated', FIREBASE_PROJECT_ID: 'demo-project' };
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'pr-c-integrated');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'pr-c-integrated');
  await integratedCatalog(env, 'country', 'SA', 'Saudi Arabia'); await integratedCatalog(env, 'specialty', 'IT', 'Information Technology'); await integratedCatalog(env, 'work_type', 'REPORT', 'Report');
  const customer = await worker.createCustomer(env, 'uid-one', 'integrated-customer', { name: 'Integrated Customer', country: 'SA', university: 'Integrated University', specialty: 'IT' });
  const work = await worker.createWork(env, 'uid-one', 'integrated-work-unconfirmed', { customer_id: customer.id, title: 'Integrated S7 Work', country: 'SA', university: 'Integrated University', specialty_key: 'IT', work_type_key: 'REPORT' });
  return { database, env, customer, work };
}
function installIntegratedWorkerAdapter(env, database, trace) {
  let requestNo = 0;
  const jsonBody = options => options?.body ? JSON.parse(options.body) : {};
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url); const path = parsed.pathname; const method = options.method || 'GET'; const body = jsonBody(options); const requestId = `pr-c-ui-api-${++requestNo}`; trace.push({ path, method });
    const actor = state.auth.uid;
    try {
      if (path === '/api/participants' && method === 'GET') return integratedResponse(await worker.listActiveParticipants(env));
      if (path === '/api/customers' && method === 'GET') return integratedResponse([await worker.getCustomer(env, [...database.prepare('SELECT id FROM customers').all()][0].id)]);
      if (path === '/api/works' && method === 'GET') return integratedResponse((await worker.listWorks(env, {})).items || await worker.listWorks(env, {}));
      if (path === '/api/transfers') return integratedResponse(method === 'GET' ? await worker.listInterPartyTransfers(env) : await worker.createInterPartyTransfer(env, actor, requestId, body), method === 'GET' ? 200 : 201);
      if (path === '/api/subscriptions') return integratedResponse(method === 'GET' ? await worker.listSubscriptionHistory(env) : await worker.createSubscriptionHistory(env, actor, requestId, body), method === 'GET' ? 200 : 201);
      if (path === '/api/expenses') return integratedResponse(method === 'GET' ? await worker.listCommonExpenses(env) : await worker.createCommonExpense(env, actor, requestId, body), method === 'GET' ? 200 : 201);
      if (path === '/api/settlements/preview') return integratedResponse(await worker.getSettlementPreview(env, parsed.searchParams.get('period_key'), Object.fromEntries(parsed.searchParams.entries())));
      if (path === '/api/settlements' && method === 'GET') return integratedResponse(await worker.listSettlementSnapshots(env, parsed.searchParams.get('period_key')));
      const settlement = path.match(/^\/api\/settlements\/([^/]+)(?:\/(close|reopen-requests)(?:\/([^/]+)\/approve)?)?$/);
      if (settlement) { const [, period, action, request] = settlement; if (action === 'close' && method === 'POST') return integratedResponse(await worker.closeSettlement(env, actor, requestId, period, body), 201); if (action === 'reopen-requests' && !request) return integratedResponse(method === 'GET' ? await worker.listSettlementReopenRequests(env, period) : await worker.createSettlementReopenRequest(env, actor, requestId, period, body), method === 'GET' ? 200 : 201); if (action === 'reopen-requests' && request && method === 'POST') return integratedResponse(await worker.approveSettlementReopenRequest(env, actor, requestId, period, request), 201); }
      const workRoute = path.match(/^\/api\/works\/([^/]+)(?:\/(.*))?$/);
      if (workRoute) { const [, workId, tail = ''] = workRoute; if (!tail && method === 'GET') return integratedResponse(await worker.getWork(env, workId)); if (!tail && method === 'PATCH') return integratedResponse(await worker.updateWork(env, actor, requestId, workId, body)); if (tail === 'financials') return integratedResponse(await worker.getWorkFinancials(env, workId)); if (tail === 'payments') return integratedResponse(method === 'GET' ? await worker.listClientPayments(env, workId) : await worker.createClientPayment(env, actor, requestId, workId, body), method === 'GET' ? 200 : 201); if (tail === 'payment-reversal-requests') return integratedResponse(method === 'GET' ? await worker.listPaymentReversalRequests(env, workId) : await worker.createPaymentReversalRequest(env, actor, requestId, workId, body), method === 'GET' ? 200 : 201); const approve = tail.match(/^payment-reversal-requests\/([^/]+)\/approve$/); if (approve && method === 'POST') return integratedResponse(await worker.approvePaymentReversalRequest(env, actor, requestId, workId, approve[1]), 201); if (['similar', 'events', 'title-history', 'status-history', 'archive-history', 'requests'].includes(tail)) return integratedResponse([]); }
      throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND', status: 404 });
    } catch (error) { return integratedError(error); }
  };
}

test('S7 PR-C integrated UI plus Worker/DB acceptance covers confirmation, C/F/H/I/K/L/M/O without local financial truth', async () => {
  const { database, env, customer, work } = await integratedFixture(); const trace = [];
  try {
    setup({ uid: 'uid-one', role: 'person_1', work: await worker.getWork(env, work.id) }); state.works = [state.selectedWork]; state.customers = [customer]; installIntegratedWorkerAdapter(env, database, trace);
    await ui.submitWork(integratedForm({ id: work.id, version: 1, customer_id: customer.id, title: 'Integrated S7 Work', country: 'SA', university: 'Integrated University', specialty_key: 'IT', work_type_key: 'REPORT', subject_or_course_code: '', status: 'NEW_REQUEST', quantity: '', relationship_kind: 'INDEPENDENT', parent_work_id: '', description: '', confirmed_at: '12/08/2026 10:00' }));
    const confirmed = await worker.getWork(env, work.id); assert.equal(confirmed.confirmed_at, '2026-08-12T07:00:00.000Z'); assert.equal((await worker.getSettlementPreview(env, '2026-08', {})).work_count, 1); assert.match(ui.workPage(), /تاريخ التأكيد/);
    const priceRequest = await worker.createPriceChangeRequest(env, 'uid-one', 'integrated-price-request', work.id, { version: confirmed.version, movement_type: 'BASE', amount_riyals: '1700.00', reason: 'Integrated price', effective_at: '2026-08-12T10:00:00.000Z' }); await worker.approvePriceChangeRequest(env, 'uid-two', 'integrated-price-approve', work.id, priceRequest.id); await ui.openWork(work.id);
    await ui.loadFinancialWorkspace('2026-08'); assert.match(ui.s7WorkFinancialMarkup(state.selectedWork), /name="received_by"/); assert.match(ui.settlementPreviewMarkup(state.financial.preview), /استلام خالد/);
    await ui.submitPayment(integratedForm({ amount_riyals: '1000.00', effective_at: '2026-08-12T12:00', payment_method: 'BANK_TRANSFER', received_by: 'uid-two', note: 'first irregular installment' }));
    await ui.submitPayment(integratedForm({ amount_riyals: '700.00', effective_at: '2026-08-15T12:00', payment_method: 'CASH', received_by: 'uid-one', note: 'second irregular installment' }));
    let financial = await worker.getWorkFinancials(env, work.id); assert.equal(financial.remaining_halalas, 0); assert.equal(financial.payments.length, 2); assert.equal(financial.payments[0].recorded_by, 'uid-one'); assert.equal(financial.payments[0].received_by, 'uid-two'); assert.notEqual(state.selectedWork.payments[0].received_by, state.selectedWork.payments[0].recorded_by); assert.match(ui.workPage(), /استلمها:/); assert.match(ui.workPage(), /سُجلت بواسطة:/);
    const firstPayment = financial.payments[0]; await ui.submitPaymentReversalRequest(integratedForm({ payment_id: firstPayment.id, reason: 'Integrated correction' })); assert.equal((await worker.getWorkFinancials(env, work.id)).approved_payments_total_halalas, 170000); state.auth.uid = 'uid-two'; state.auth.role = 'person_2'; await ui.handleApprovePaymentReversal(state.selectedWork.reversalRequests[0].id); financial = await worker.getWorkFinancials(env, work.id); assert.equal(financial.approved_payments_total_halalas, 70000); await ui.submitPayment(integratedForm({ amount_riyals: '1000.00', effective_at: '2026-08-16T12:00', payment_method: 'BANK_TRANSFER', received_by: 'uid-one', note: 'corrected new payment' })); assert.equal((await worker.getWorkFinancials(env, work.id)).remaining_halalas, 0);
    state.auth.uid = 'uid-one'; state.auth.role = 'person_1'; await ui.loadFinancialWorkspace('2026-08'); const beforeTransfer = state.financial.preview.final_balance_halalas; await ui.submitTransfer(integratedForm({ amount_riyals: '100.00', fee_riyals: '1.01', effective_at: '2026-08-18T10:00', from_party: 'person_1', to_party: 'person_2' })); assert.notEqual(state.financial.preview.final_balance_halalas, beforeTransfer); assert.equal(state.financial.preview.transfer_fee_halalas, 101);
    state.auth.uid = 'uid-two'; state.auth.role = 'person_2'; await ui.submitSubscription(integratedForm({ state: 'ACTIVE', aggregate_amount_riyals: '200.00', effective_at: '2026-08-20T10:00' })); await ui.loadFinancialWorkspace('2026-08'); assert.equal(state.financial.preview.subscription_total_halalas, 13650); await ui.loadFinancialWorkspace('2026-09'); assert.equal(state.financial.preview.subscription_total_halalas, 20000); assert.match(ui.financialPage(), /يسري التغيير من تسوية الشهر التالي/); await ui.submitSubscription(integratedForm({ state: 'CANCELLED', aggregate_amount_riyals: '', effective_at: '2026-09-20T10:00' })); await ui.loadFinancialWorkspace('2026-09'); assert.equal(state.financial.preview.subscription_total_halalas, 20000); await ui.loadFinancialWorkspace('2026-10'); assert.equal(state.financial.preview.subscription_total_halalas, 0);
    state.auth.uid = 'uid-one'; state.auth.role = 'person_1'; await ui.loadFinancialWorkspace('2026-08'); await ui.submitSettlementClose(integratedForm({})); const closedWork = await worker.getWork(env, work.id); const confirmedBeforeBlockedRemoval = closedWork.confirmed_at; await ui.submitWork(integratedForm({ id: work.id, version: closedWork.version, customer_id: customer.id, title: closedWork.title, country: closedWork.country, university: closedWork.university, specialty_key: closedWork.specialty_key, work_type_key: closedWork.work_type_key, subject_or_course_code: closedWork.subject_or_course_code || '', status: closedWork.status, quantity: closedWork.quantity || '', relationship_kind: closedWork.relationship_kind, parent_work_id: closedWork.parent_work_id || '', description: closedWork.description || '', confirmed_at: '' })); assert.equal((await worker.getWork(env, work.id)).confirmed_at, confirmedBeforeBlockedRemoval); assert.match(ui.errorMessage('CLOSED_PERIOD_MUTATION_FORBIDDEN'), /إعادة فتح معتمدة/); const transferCountBeforeBlocked = (await worker.listInterPartyTransfers(env)).length; await ui.submitTransfer(integratedForm({ amount_riyals: '1.00', fee_riyals: '0.00', effective_at: '2026-08-20T10:00', from_party: 'person_1', to_party: 'person_2' })); assert.equal((await worker.listInterPartyTransfers(env)).length, transferCountBeforeBlocked);
    await ui.submitSettlementReopen(integratedForm({ reason: 'Integrated U1 to U2 reopen' })); state.auth.uid = 'uid-two'; state.auth.role = 'person_2'; await ui.handleApproveSettlementReopen(state.financial.reopenRequests[0].id); await ui.submitTransfer(integratedForm({ amount_riyals: '1.00', fee_riyals: '0.00', effective_at: '2026-08-20T10:00', from_party: 'person_1', to_party: 'person_2' })); await ui.submitSettlementClose(integratedForm({})); state.auth.uid = 'uid-two'; await ui.submitSettlementReopen(integratedForm({ reason: 'Integrated U2 to U1 reopen' })); state.auth.uid = 'uid-one'; state.auth.role = 'person_1'; await ui.handleApproveSettlementReopen(state.financial.reopenRequests.filter(item => item.state === 'PENDING')[0].id); await ui.submitTransfer(integratedForm({ amount_riyals: '2.00', fee_riyals: '0.00', effective_at: '2026-08-21T10:00', from_party: 'person_1', to_party: 'person_2' })); await ui.submitSettlementClose(integratedForm({}));
    state.selectedWork = null; state.financial = { periodKey: '2026-08', preview: null, snapshots: [], reopenRequests: [], transfers: [], subscriptions: [], expenses: [], participants: [] }; trace.length = 0; await ui.openWork(work.id); trace.length = 0; database.readQueries = 0; database.bindingWidths = []; await ui.loadFinancialWorkspace('2026-08'); const snapshots = await worker.listSettlementSnapshots(env, '2026-08'); const reopenHistory = await worker.listSettlementReopenRequests(env, '2026-08'); assert.equal(snapshots.length, 3); assert.equal(reopenHistory.filter(item => item.state === 'APPROVED').length, 2); assert.equal(ui.settlementPeriodState(snapshots, reopenHistory), 'CLOSED'); assert.match(ui.financialPage(), /نسخة الإقفال/); assert.match(ui.workPage(), /طلبات تصحيح الدفعات/); assert.ok(trace.every(call => !/^\/api\/works\//.test(call.path))); assert.equal(trace.length, 7); assert.ok(database.readQueries <= 40); assert.ok(Math.max(...database.bindingWidths, 0) <= 100);
  } finally { database.close(); }
});

// The route is behaviorally exercised by the workspace fetch above; this guards its authenticated API contract surface.
test('S7 PR-C settlement snapshot read route remains period-scoped and uses the existing authoritative snapshot list function', () => {
  const workerPath = fileURLToPath(new URL('../../src/worker/src/index.js', import.meta.url));
  const worker = readFileSync(workerPath, 'utf8');
  assert.match(worker, /parts\.length === 2 && method === 'GET'.{0,180}listSettlementSnapshots\(env, url\.searchParams\.get\('period_key'\)/s);
});
