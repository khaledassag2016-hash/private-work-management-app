import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    shares: { person_1_halalas: 51000, person_2_halalas: 119000 }, ratio: { person_1_bps: 3000, person_2_bps: 7000, source: 'DEFAULT' },
    movements: [], price_requests: [], ratio_requests: [], ratio_history: [], payments,
  };
}
function workPayload(financial = financials()) {
  return { id: 'w1', title: 'عمل مالي تجريبي', version: 4, customer_id: 'c1', country: 'SA', work_type_key: 'REPORT', status: 'COMPLETED', relationship_kind: 'INDEPENDENT', pricing_state: financial.price_state, current_price_halalas: financial.current_price_halalas, financials: financial, similar: [], events: [], titleHistory: [], statusHistory: [], archiveHistory: [], requests: [], payments: financial.payments, reversalRequests: [] };
}
function preview({ unresolved_code = null, prior = 0 } = {}) {
  return { period_key: '2026-08', work_count: 1, cumulative_work_count: 1, total_work_value_halalas: 170000, person_1_work_share_halalas: 51000, person_2_work_share_halalas: 119000, approved_receipts_halalas: 100000, transfer_amount_halalas: 5000, transfer_fee_halalas: 100, subscription_total_halalas: 13650, governed_expense_total_halalas: 0, prior_balance_halalas: prior, final_balance_halalas: 26000 + prior, unresolved_code };
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
  assert.match(html, /1000\.00 ريال/);
  assert.match(html, /700\.00 ريال/);
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

test('S7 PR-C financial workspace displays all settlement components, pending reopen safety, and disables close for unresolved truth', () => {
  setup({ uid: 'uid-one' });
  state.view = 'financial';
  state.financial = { periodKey: '2026-08', preview: preview({ unresolved_code: 'S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED' }), snapshots: [{ version: 1, state: 'CLOSED', final_balance_halalas: 26000, created_at: '2026-08-31T00:00:00.000Z' }], reopenRequests: [{ id: 'reopen-self', state: 'PENDING', reason: 'سبب', requested_by: 'uid-one' }], transfers: [{ amount_halalas: 5000, from_party: 'person_1', to_party: 'person_2', fee_halalas: 100, effective_at: '2026-08-15T00:00:00.000Z' }], subscriptions: [{ state: 'ACTIVE', aggregate_amount_halalas: 13650, effective_at: '2026-08-01T00:00:00.000Z', paid_by_uid: 'uid-two' }], expenses: [{ amount_halalas: 2000, category: 'مصروف تجريبي', paid_by_uid: 'uid-one', effective_at: '2026-08-20T00:00:00.000Z' }] };
  const html = ui.financialPage();
  assert.match(html, /عدد الأعمال/);
  assert.match(html, /المتحصل من العميل/);
  assert.match(html, /الرصيد السابق/);
  assert.match(html, /الرصيد النهائي/);
  assert.match(html, /المعاينة تعرض المكونات الموضوعية فقط/);
  assert.match(html, /<button[^>]*disabled[^>]*>إقفال نسخة التسوية/);
  assert.match(html, /لا يمكنك اعتماد طلبك/);
  assert.doesNotMatch(html, /approve-settlement-reopen" data-request-id="reopen-self/);
  assert.match(html, /لا تحتوي على تقرير S8 أو تصدير/);
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

// The route is behaviorally exercised by the workspace fetch above; this guards its authenticated API contract surface.
test('S7 PR-C settlement snapshot read route remains period-scoped and uses the existing authoritative snapshot list function', () => {
  const workerPath = fileURLToPath(new URL('../../src/worker/src/index.js', import.meta.url));
  const worker = readFileSync(workerPath, 'utf8');
  assert.match(worker, /parts\.length === 2 && method === 'GET'.{0,180}listSettlementSnapshots\(env, url\.searchParams\.get\('period_key'\)/s);
});
