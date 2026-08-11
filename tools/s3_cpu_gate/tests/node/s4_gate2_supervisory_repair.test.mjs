import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCustomer, createDocumentedFact, createWork, getCustomer, getCustomerHistory, updateCustomer, updateWork } from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const appPath = fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url));
const appSource = readFileSync(appPath, 'utf8');

function createUiHarness(fetchImpl) {
  const root = { innerHTML: '', parentNode: null };
  const document = {
    body: { append() {} },
    createElement() { return { className: '', textContent: '', parentNode: null, append() {}, remove() {}, addEventListener() {} }; },
    querySelector(selector) { return selector === '#app' ? root : null; },
    querySelectorAll() { return []; },
  };
  const window = { __PRIVATE_WORK_APP_CONFIG__: {}, __PRIVATE_WORK_APP_TEST__: {}, setTimeout() {} };
  const context = createContext({
    window,
    document,
    crypto: webcrypto,
    fetch: fetchImpl,
    Headers,
    Response,
    URL,
    URLSearchParams,
    Intl,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout() {},
    clearTimeout() {},
  });
  runInContext(appSource, context, { filename: appPath });
  return { root, testApi: window.__PRIVATE_WORK_APP_TEST__ };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test('supervisory UI behavior: optional customer name and controlled work status', async () => {
  const { testApi } = createUiHarness(async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await settle();
  const customerMarkup = testApi.customerForm({});
  assert.doesNotMatch(customerMarkup, /name="name"[^>]*required/);
  assert.match(customerMarkup, /اسم العميل \(عند توفره\)/);
  assert.match(customerMarkup, /يمكن حفظ السجل دون اسم/);

  const workMarkup = testApi.workForm({});
  assert.match(workMarkup, /name="status"[^>]*data-controlled-work-status/);
  assert.match(workMarkup, /NEEDS_FOLLOW_UP/);
  assert.doesNotMatch(workMarkup, /name="status" value=/);
});

test('supervisory UI behavior: AC-07 warning is visible before submit and absent without a fact', async () => {
  const calls = [];
  const { root, testApi } = createUiHarness(async (url) => {
    calls.push(String(url));
    const data = String(url).endsWith('/customer-with-warning/warnings')
      ? [{ warning_type: 'NON_PAYMENT', source_ref: 'synthetic-before-agreement', happened_at: '2026-08-01T12:00:00.000Z' }]
      : [];
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await settle();
  const state = testApi.getState();
  state.auth.status = 'signed_in';
  state.auth.tokenProvider = { getToken: async () => 'synthetic-token' };

  await testApi.openNewWork('customer-with-warning');
  assert.equal(calls.some(url => url.endsWith('/api/customers/customer-with-warning/warnings')), true);
  assert.match(root.innerHTML, /data-pre-agreement-warning="present"/);
  assert.match(root.innerHTML, /synthetic-before-agreement/);
  assert.match(root.innerHTML, /قبل إنشاء العمل/);

  await testApi.openNewWork('customer-without-warning');
  assert.match(root.innerHTML, /data-pre-agreement-warning="none"/);
  assert.doesNotMatch(root.innerHTML, /synthetic-before-agreement/);
});

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.parameterMap = [];
    this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; });
    this.values = [];
  }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; return this; }
  first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const prepared = this.database.prepare(statement.sql);
        if (/^\s*SELECT\b/i.test(statement.sql)) return { success: true, results: prepared.all(...statement.values), meta: { changes: 0 } };
        const result = prepared.run(...statement.values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      this.database.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  }
}
function domainFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(schemaPath, 'utf8'));
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('repair-person-one', 'person_1', 'repair-run');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('repair-person-two', 'person_2', 'repair-run');
  database.prepare('INSERT INTO catalog_values(id,kind,value_key,label,active,created_by,created_at) VALUES (?,?,?,?,1,?,?)').run('repair-country', 'country', 'SYN_COUNTRY', 'Synthetic Country', 'repair-person-one', '2026-08-01T00:00:00.000Z');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'repair-run', FIREBASE_PROJECT_ID: 'synthetic-repair-project' } };
}
function customerInput(extra = {}) { return { contact: 'synthetic-contact', country: null, university: 'Synthetic University', specialty: null, notes: 'Synthetic repair fixture', ...extra }; }
function workInput(customerId, extra = {}) { return { customer_id: customerId, title: 'Synthetic repair work', country: 'SYN_COUNTRY', university: null, specialty_key: null, work_type_key: null, subject_or_course_code: null, description: 'Synthetic only', relationship_kind: 'INDEPENDENT', ...extra }; }

test('supervisory domain: customer factual statuses cannot be invented and derive from documented facts', async () => {
  const { database, env } = domainFixture();
  try {
    for (const status of ['unpaid', 'dispute', 'blocked', 'frequent_delay']) {
      await assert.rejects(createCustomer(env, 'repair-person-one', `repair-customer-${status}`, customerInput({ status })), { code: 'CUSTOMER_STATUS_DERIVED' });
    }
    const customer = await createCustomer(env, 'repair-person-one', 'repair-customer-derived', customerInput({ name: '   ' }));
    assert.equal(customer.name, null);
    await assert.rejects(updateCustomer(env, 'repair-person-one', 'repair-customer-status-update', customer.id, { version: 1, status: 'blocked' }), { code: 'CUSTOMER_STATUS_DERIVED' });
    assert.equal((await getCustomer(env, customer.id)).status, 'normal');
    await createDocumentedFact(env, 'repair-person-one', 'repair-fact-derived', { customer_id: customer.id, fact_type: 'NON_PAYMENT', source_ref: 'synthetic-status-evidence', happened_at: '2026-08-03T12:00:00.000Z', details: {} });
    assert.equal((await getCustomer(env, customer.id)).status, 'unpaid');
    assert.equal(database.prepare('SELECT status FROM customers WHERE id=?').get(customer.id).status, 'normal');
  } finally { database.close(); }
});

test('supervisory domain: Work status accepts only the basic S4 allowlist', async () => {
  const { database, env } = domainFixture();
  try {
    const customer = await createCustomer(env, 'repair-person-one', 'repair-work-customer', customerInput());
    const valid = await createWork(env, 'repair-person-one', 'repair-work-valid', workInput(customer.id, { status: 'NEEDS_FOLLOW_UP' }));
    assert.equal(valid.status, 'NEEDS_FOLLOW_UP');
    assert.throws(() => database.prepare('UPDATE works SET status=? WHERE id=?').run('PAYMENT_PENDING', valid.id), /CHECK constraint failed/);
    for (const status of ['PAYMENT_PENDING', 'SETTLED', 'ARCHIVED', 'TIMELINE_EVENT']) {
      await assert.rejects(createWork(env, 'repair-person-one', `repair-work-${status.toLowerCase()}`, workInput(customer.id, { status })), { code: 'WORK_STATUS_INVALID' });
    }
    await assert.rejects(updateWork(env, 'repair-person-one', 'repair-work-invalid-update', valid.id, { version: 1, status: 'PAID', title: valid.title, country: valid.country, relationship_kind: 'INDEPENDENT' }), { code: 'WORK_STATUS_INVALID' });
  } finally { database.close(); }
});

test('supervisory domain: happened_at is canonical, invalid dates are rejected, and history remains chronological', async () => {
  const { database, env } = domainFixture();
  try {
    const customer = await createCustomer(env, 'repair-person-one', 'repair-time-customer', customerInput());
    for (const happenedAt of ['abc', '2026-02-30T12:00:00.000Z', 'NaN', '2026-08-01T12:00:00Z']) {
      await assert.rejects(createDocumentedFact(env, 'repair-person-one', `repair-time-${happenedAt.slice(0, 4)}`, { customer_id: customer.id, fact_type: 'DELAY', source_ref: 'synthetic-invalid-time', happened_at: happenedAt, details: {} }), { code: 'FACT_TIME_INVALID' });
    }
    const later = await createDocumentedFact(env, 'repair-person-one', 'repair-time-later', { customer_id: customer.id, fact_type: 'DELAY', source_ref: 'synthetic-later', happened_at: '2026-08-03T12:00:00.000Z', details: {} });
    const earlier = await createDocumentedFact(env, 'repair-person-one', 'repair-time-earlier', { customer_id: customer.id, fact_type: 'NON_PAYMENT', source_ref: 'synthetic-earlier', happened_at: '2026-08-01T12:00:00.000Z', details: {} });
    assert.equal(later.happened_at, '2026-08-03T12:00:00.000Z');
    assert.equal(earlier.happened_at, '2026-08-01T12:00:00.000Z');
    const history = await getCustomerHistory(env, customer.id);
    assert.deepEqual(history.map(item => item.happened_at), ['2026-08-01T12:00:00.000Z', '2026-08-03T12:00:00.000Z']);
  } finally { database.close(); }
});

test('supervisory UI behavior: warning read failure is explicit and never rendered as no-warning', async () => {
  const { root, testApi } = createUiHarness(async () => new Response(JSON.stringify({ ok: false, code: 'HTTP_503' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await settle();
  const state = testApi.getState();
  state.auth.status = 'signed_in';
  state.auth.tokenProvider = { getToken: async () => 'synthetic-token' };
  await testApi.openNewWork('customer-warning-fetch-fails');
  assert.match(root.innerHTML, /data-pre-agreement-warning="error"/);
  assert.doesNotMatch(root.innerHTML, /data-pre-agreement-warning="none"/);
  assert.match(root.innerHTML, /تعذر تحميل الوقائع الموثقة/);
});
