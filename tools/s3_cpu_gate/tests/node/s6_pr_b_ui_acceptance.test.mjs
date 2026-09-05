import assert from 'node:assert/strict';
import test from 'node:test';
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
const testApp = window.__PRIVATE_WORK_APP_TEST__;
const state = testApp.getState();

function setup({ uid = 'uid-one', selectedWork = {} } = {}) {
  state.auth = { status: 'signed_in', uid, email: `${uid}@test.com`, role: uid === 'uid-one' ? 'person_1' : 'person_2', tokenProvider: { getToken: async () => 'mock-token' } };
  state.busy = false;
  state.view = 'work';
  state.selectedWork = selectedWork;
}
function response(data, ok = true, code = '') {
  return { ok, status: ok ? 200 : 409, json: async () => ok ? { ok: true, data } : { ok: false, code } };
}
function authoritativeWorkPayload(financials) {
  return {
    id: 'w1', title: 'عمل مالي تجريبي', version: 3, customer_id: 'c1', country: 'SA', work_type_key: 'REPORT', status: 'IN_PROGRESS', relationship_kind: 'INDEPENDENT', pricing_state: financials.price_state, current_price_halalas: financials.current_price_halalas, pricing_source: 'S6_APPROVED_PRICE_MOVEMENTS', price_state: 'PRICE_UNSET', price_minor_units: null,
  };
}
function installOpenWorkFetch(financials) {
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/financials')) return response(financials);
    if (path.endsWith('/similar')) return response([]);
    if (path.endsWith('/events') || path.endsWith('/title-history') || path.endsWith('/status-history') || path.endsWith('/archive-history') || path.endsWith('/requests')) return response([]);
    return response(authoritativeWorkPayload(financials));
  };
}
function financials({ price = 150000, stateValue = 'PRICE_APPROVED', ratio = { person_1_bps: 7000, person_2_bps: 3000, source: 'DEFAULT' }, movements = [], priceRequests = [], ratioRequests = [], ratioHistory = [] } = {}) {
  return {
    work_id: 'w1', price_state: stateValue, current_price_halalas: stateValue === 'PRICE_UNSET' ? null : price, ratio,
    shares: stateValue === 'PRICE_UNSET' ? { person_1_halalas: null, person_2_halalas: null } : { person_1_halalas: Math.round(price * ratio.person_1_bps / 10000), person_2_halalas: Math.round(price * ratio.person_2_bps / 10000) },
    remaining_halalas: stateValue === 'PRICE_UNSET' ? null : price, remaining_projection: 'PRE_S7_APPROVED_PAYMENTS_ZERO', movements, price_requests: priceRequests, ratio_requests: ratioRequests, ratio_history: ratioHistory,
  };
}

test('S6 UI detail shows authoritative price/ratio/shares and previous-new approved history, never legacy sentinel as current truth', () => {
  setup({ selectedWork: {
    id: 'w1', version: 3, title: 'عمل مالي تجريبي', status: 'IN_PROGRESS', price_state: 'PRICE_UNSET', price_minor_units: null,
    pricing_state: 'PRICE_APPROVED', current_price_halalas: 170000,
    financials: financials({ price: 170000, movements: [{ movement_type: 'BASE', amount_halalas: 150000, previous_price_halalas: null, new_price_halalas: 150000, reason: 'BASE', effective_at: '2026-08-10T12:00:00.000Z', requested_by: 'uid-one', approved_by: 'uid-two', approved_at: '2026-08-12T12:00:00.000Z' }, { movement_type: 'INCREASE', amount_halalas: 20000, previous_price_halalas: 150000, new_price_halalas: 170000, reason: 'Increase', effective_at: '2026-08-01T12:00:00.000Z', requested_by: 'uid-two', approved_by: 'uid-one', approved_at: '2026-08-12T12:01:00.000Z' }], priceRequests: [{ id: 'pending-1', state: 'PENDING', movement_type: 'DISCOUNT', amount_halalas: -10000, reason: 'Pending discount', requested_by: 'uid-one', requested_at: '2026-08-12T12:02:00.000Z', effective_at: '2026-08-01T12:00:00.000Z' }], ratioHistory: [{ old_person_1_bps: 3000, old_person_2_bps: 7000, new_person_1_bps: 5000, new_person_2_bps: 5000, reason: 'Exception', requested_at: '2026-08-12T12:00:00.000Z', approved_at: '2026-08-12T12:01:00.000Z' }] }),
    similar: [{ title: 'عمل مشابه', pricing_state: 'PRICE_APPROVED', current_price_halalas: 150000, price_state: 'PRICE_UNSET', created_at: '2026-08-01T00:00:00.000Z', work_type_key: 'REPORT' }],
  }});
  const html = testApp.workPage();
  assert.match(html, /السعر المعتمد/);
  assert.match(html, /1700 ريال/);
  assert.match(html, /خالد/);
  assert.match(html, /السابق: 1500 ريال/);
  assert.match(html, /الجديد: 1700 ريال/);
  assert.match(html, /معلق — لا يغير السعر المعتمد/);
  assert.match(html, /السعر الحالي: 1500 ريال/);
  assert.doesNotMatch(html, /السعر غير محدد<\/strong>/);
});

test('S6 UI keeps pending price/ratio requests separate and blocks self approval', () => {
  setup({ uid: 'uid-one', selectedWork: { id: 'w1', version: 1, title: 'سعر غير محدد', financials: financials({ stateValue: 'PRICE_UNSET', priceRequests: [{ id: 'p1', state: 'PENDING', movement_type: 'BASE', amount_halalas: 150000, reason: 'Base', requested_by: 'uid-one', requested_at: '2026-08-12T12:00:00.000Z' }], ratioRequests: [{ id: 'r1', state: 'PENDING', person_1_bps: 5000, person_2_bps: 5000, reason: 'Ratio', requested_by: 'uid-one', requested_at: '2026-08-12T12:00:00.000Z' }] }) } });
  const html = testApp.workPage();
  assert.match(html, /السعر غير محدد/);
  assert.match(html, /الطلبات المعلقة منفصلة/);
  assert.match(html, /لا يمكنك اعتماد طلبك/);
  assert.doesNotMatch(html, /data-action="approve-price-request" data-request-id="p1"/);
  assert.doesNotMatch(html, /data-action="approve-ratio-request" data-request-id="r1"/);
  assert.match(html, /id="s6-price-form"/);
  assert.match(html, /id="s6-ratio-form"/);
});

test('S6 UI approval actions execute both price directions and both ratio directions through existing api()', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ path: new URL(url).pathname, method: options?.method }); return response({ id: 'w1' }); };
  setup({ uid: 'uid-two', selectedWork: { id: 'w1', version: 2 } });
  await testApp.handleApprovePriceRequest('price-u1-to-u2');
  setup({ uid: 'uid-one', selectedWork: { id: 'w1', version: 2 } });
  await testApp.handleApprovePriceRequest('price-u2-to-u1');
  setup({ uid: 'uid-two', selectedWork: { id: 'w1', version: 2 } });
  await testApp.handleApproveRatioRequest('ratio-u1-to-u2');
  setup({ uid: 'uid-one', selectedWork: { id: 'w1', version: 2 } });
  await testApp.handleApproveRatioRequest('ratio-u2-to-u1');
  const approvalCalls = calls.filter(call => call.method === 'POST');
  assert.deepEqual(approvalCalls.map(call => call.path), [
    '/api/works/w1/price-requests/price-u1-to-u2/approve',
    '/api/works/w1/price-requests/price-u2-to-u1/approve',
    '/api/works/w1/ratio-requests/ratio-u1-to-u2/approve',
    '/api/works/w1/ratio-requests/ratio-u2-to-u1/approve',
  ]);
  assert.ok(approvalCalls.every(call => call.method === 'POST'));
});

test('S6 UI mutation uses request version and verifies authoritative refetch before success', async () => {
  setup({ uid: 'uid-one', selectedWork: { id: 'w1', version: 1 } });
  const calls = [];
  installOpenWorkFetch(financials({ price: 150000 }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });
    if (options?.method === 'POST') return response({ id: 'p1', state: 'PENDING' }, true);
    return originalFetch(url, options);
  };
  globalThis.FormData = class FormData { entries() { return [['movement_type', 'BASE'], ['amount_riyals', '1500.00'], ['effective_at', '2026-08-10T12:00'], ['reason', 'Base request']]; } };
  await testApp.submitPriceChange({ preventDefault: () => {}, currentTarget: {} });
  assert.equal(calls[0].path, '/api/works/w1/price-requests');
  assert.equal(calls[0].body.version, 1);
  assert.equal(calls[0].body.amount_riyals, '1500.00');
  assert.equal(calls[0].body.effective_at, '2026-08-10T09:00:00.000Z');
  assert.ok(calls.some(call => call.path === '/api/works/w1/financials' && call.method === undefined));
  assert.equal(state.busy, false);
});

test('S6 UI exposes negative-price fail-closed error without changing authoritative state', async () => {
  setup({ uid: 'uid-two', selectedWork: { id: 'w1', version: 2, current_price_halalas: 150000, financials: financials({ price: 150000 }) } });
  assert.equal(testApp.errorMessage('S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED'), 'لا يمكن اعتماد هذه الحركة لأنها تجعل السعر النهائي سالبًا. لم يتغير السعر الحالي.');
  globalThis.fetch = async () => response(null, false, 'S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED');
  await testApp.handleApprovePriceRequest('p-negative');
  assert.equal(state.selectedWork.current_price_halalas, 150000);
  assert.equal(state.busy, false);
});

test('S6 UI reload/reopen consumes the latest authoritative financial payload', async () => {
  setup({ uid: 'uid-one', selectedWork: null });
  installOpenWorkFetch(financials({ price: 170000 }));
  await testApp.openWork('w1');
  assert.equal(state.selectedWork.financials.current_price_halalas, 170000);
  assert.match(testApp.workPage(), /1700 ريال/);
});
