import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import worker, {
  createCatalogValue,
  createCustomer,
  createDocumentedFact,
  createWork,
  getCustomerHistory,
  getCustomerWarnings,
  getSimilarWorks,
  listCatalog,
  listCustomers,
  listWorks,
  updateCustomer,
  updateWork,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));

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

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(schemaPath, 'utf8'));
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'run-gate1');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'run-gate1');
  const env = { DB: new D1Database(database), RUN_MARKER: 'run-gate1', FIREBASE_PROJECT_ID: 'demo-project' };
  return { database, env };
}

async function catalogs(env) {
  await createCatalogValue(env, 'uid-one', 'catalog-country-1', 'country', { value_key: 'SA', label: 'Synthetic Saudi Arabia' });
  await createCatalogValue(env, 'uid-one', 'catalog-specialty-1', 'specialty', { value_key: 'IT', label: 'Synthetic Information Technology' });
  await createCatalogValue(env, 'uid-one', 'catalog-worktype-1', 'work_type', { value_key: 'REPORT', label: 'Synthetic Report' });
}

function customerInput() {
  return { name: 'Synthetic Customer', country: 'SA', university: 'Synthetic University', specialty: 'IT', notes: 'Synthetic only' };
}
function workInput(customerId, extra = {}) {
  return { customer_id: customerId, title: 'Synthetic Work', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', subject_or_course_code: 'SYN-101', university: 'Synthetic University', ...extra };
}

test('S4 domain supports catalog, customer, multiple works, PRICE_UNSET, and independent/child relations', async () => {
  const { database, env } = fixture();
  try {
    await catalogs(env);
    const customer = await createCustomer(env, 'uid-one', 'customer-create-1', customerInput());
    const independent = await createWork(env, 'uid-two', 'work-create-1', workInput(customer.id, { title: 'Independent Synthetic Work' }));
    const second = await createWork(env, 'uid-one', 'work-create-2', workInput(customer.id, { title: 'Second Synthetic Work' }));
    const child = await createWork(env, 'uid-two', 'work-create-3', workInput(customer.id, { title: 'Child Synthetic Work', relationship_kind: 'CHILD', parent_work_id: independent.id }));
    assert.equal(independent.price_state, 'PRICE_UNSET');
    assert.equal(independent.price_minor_units, null);
    assert.equal(second.relationship_kind, 'INDEPENDENT');
    assert.equal(child.relationship_kind, 'CHILD');
    assert.equal(child.parent_work_id, independent.id);
    assert.equal((await listWorks(env, { customer_id: customer.id })).length, 3);
    assert.equal((await listCustomers(env)).length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE entity_type IN (\'customer\',\'work\')').get().count, 4);
  } finally { database.close(); }
});

test('S4 distinguishes PRICE_ZERO from PRICE_UNSET and rejects invalid price state', async () => {
  const { database, env } = fixture();
  try {
    await catalogs(env);
    const customer = await createCustomer(env, 'uid-one', 'customer-create-2', customerInput());
    const zero = await createWork(env, 'uid-one', 'work-zero-1', workInput(customer.id, { price_state: 'PRICE_ZERO', price_minor_units: 0 }));
    assert.equal(zero.price_state, 'PRICE_ZERO');
    assert.equal(zero.price_minor_units, 0);
    await assert.rejects(createWork(env, 'uid-one', 'work-zero-2', workInput(customer.id, { price_state: 'PRICE_UNSET', price_minor_units: 0 })), /PRICE_UNSET_VALUE_FORBIDDEN/);
  } finally { database.close(); }
});

test('S4 rejects invalid parent relations and preserves customer scope', async () => {
  const { database, env } = fixture();
  try {
    await catalogs(env);
    const customer = await createCustomer(env, 'uid-one', 'customer-create-3', customerInput());
    const otherCustomer = await createCustomer(env, 'uid-two', 'customer-create-4', { ...customerInput(), name: 'Synthetic Other Customer' });
    await assert.rejects(createWork(env, 'uid-one', 'work-parent-1', workInput(customer.id, { relationship_kind: 'CHILD', parent_work_id: 'work-missing' })), /PARENT_NOT_FOUND/);
    const parent = await createWork(env, 'uid-one', 'work-parent-2', workInput(customer.id));
    const child = await createWork(env, 'uid-one', 'work-parent-3', workInput(customer.id, { relationship_kind: 'CHILD', parent_work_id: parent.id }));
    await assert.rejects(updateWork(env, 'uid-one', 'work-parent-4', parent.id, { version: parent.version, relationship_kind: 'CHILD', parent_work_id: child.id, title: parent.title, country: parent.country }), /PARENT_CYCLE/);
    await assert.rejects(createWork(env, 'uid-two', 'work-parent-5', workInput(otherCustomer.id, { relationship_kind: 'CHILD', parent_work_id: parent.id })), /CROSS_CUSTOMER_PARENT/);
  } finally { database.close(); }
});

test('S4 catalogs are data-driven and facts produce deterministic warnings and history', async () => {
  const { database, env } = fixture();
  try {
    await catalogs(env);
    const catalogRows = await listCatalog(env, 'country');
    assert.equal(catalogRows.length, 1);
    await assert.rejects(createCatalogValue(env, 'uid-one', 'catalog-duplicate-1', 'country', { value_key: 'SA', label: 'Duplicate' }), /CATALOG_DUPLICATE/);
    const customer = await createCustomer(env, 'uid-one', 'customer-create-5', customerInput());
    const work = await createWork(env, 'uid-two', 'work-create-5', workInput(customer.id));
    const fact = await createDocumentedFact(env, 'uid-one', 'fact-create-1', { customer_id: customer.id, work_id: work.id, fact_type: 'NON_PAYMENT', source_ref: 'synthetic-payment-record-1', happened_at: '2026-01-02T00:00:00.000Z', details: { note: 'synthetic unpaid fact' } });
    const history = await getCustomerHistory(env, customer.id);
    const warnings = await getCustomerWarnings(env, customer.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].source_ref, fact.source_ref);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].warning_type, 'NON_PAYMENT');
    assert.equal(warnings[0].fact_id, fact.id);
    assert.throws(() => database.exec("INSERT INTO customer_warning_projection(fact_id,customer_id,warning_type) VALUES ('x','y','manual')"), /view/);
  } finally { database.close(); }
});

test('S4 optimistic version conflict prevents lost update', async () => {
  const { database, env } = fixture();
  try {
    await catalogs(env);
    const customer = await createCustomer(env, 'uid-one', 'customer-create-6', customerInput());
    const updated = await updateCustomer(env, 'uid-two', 'customer-update-1', customer.id, { version: customer.version, name: 'Synthetic Updated Customer' });
    assert.equal(updated.version, 2);
    await assert.rejects(updateCustomer(env, 'uid-one', 'customer-update-2', customer.id, { version: customer.version, name: 'Stale Update' }), /VERSION_CONFLICT/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='customer' AND entity_id=?").get(customer.id).count, 2);
  } finally { database.close(); }
});

test('S4 API rejects missing authentication before accessing private data', async () => {
  const { database, env } = fixture();
  try {
    const response = await worker.fetch(new Request('https://example.test/api/customers'), env);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'TOKEN_MISSING');
  } finally { database.close(); }
});

test('S4 audit is append-only and mutation plus audit are atomic', async () => {
  const { database, env } = fixture();
  try {
    await catalogs(env);
    const customer = await createCustomer(env, 'uid-one', 'customer-create-7', customerInput());
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='customer' AND entity_id=?").get(customer.id).count, 1);
    assert.throws(() => database.exec("UPDATE audit_log SET action='UPDATE'"), /audit log is append only/);
    assert.throws(() => database.exec('DELETE FROM audit_log'), /audit log is append only/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM customers WHERE id=?").get(customer.id).count, 1);
  } finally { database.close(); }
});
