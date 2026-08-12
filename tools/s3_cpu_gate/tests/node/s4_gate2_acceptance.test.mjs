import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createCatalogValue,
  createCustomer,
  approvePriceChangeRequest,
  createDocumentedFact,
  createPriceChangeRequest,
  createWork,
  getCustomerHistory,
  getCustomerWarnings,
  getSimilarWorks,
  getWork,
  getWorkFinancials,
  listCatalog,
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
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('ui-person-one', 'person_1', 'ui-gate2-run');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('ui-person-two', 'person_2', 'ui-gate2-run');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'ui-gate2-run', FIREBASE_PROJECT_ID: 'synthetic-ui-project' } };
}

async function seedCatalogs(env) {
  await createCatalogValue(env, 'ui-person-one', 'catalog-country', 'country', { value_key: 'SYN_COUNTRY', label: 'Synthetic Country' });
  await createCatalogValue(env, 'ui-person-one', 'catalog-specialty', 'specialty', { value_key: 'SYN_SPECIALTY', label: 'Synthetic Specialty' });
  await createCatalogValue(env, 'ui-person-one', 'catalog-work-type', 'work_type', { value_key: 'SYN_REPORT', label: 'Synthetic Report' });
}
function customerPayload(extra = {}) {
  return { name: 'Synthetic UI Customer', country: 'SYN_COUNTRY', university: 'Synthetic University', specialty: 'SYN_SPECIALTY', notes: 'Synthetic UI-only note', ...extra };
}
function workPayload(customerId, extra = {}) {
  return { customer_id: customerId, title: 'Synthetic UI Work', country: 'SYN_COUNTRY', university: 'Synthetic University', specialty_key: 'SYN_SPECIALTY', work_type_key: 'SYN_REPORT', subject_or_course_code: 'SYN-201', description: 'Synthetic acceptance description', ...extra };
}

test('AC-01 and AC-04: a UI-compatible flow keeps PRICE_UNSET and multiple independent records for one customer', async () => {
  const { database, env } = fixture();
  try {
    await seedCatalogs(env);
    const customer = await createCustomer(env, 'ui-person-one', 'customer-create-ui-1', customerPayload());
    const first = await createWork(env, 'ui-person-one', 'work-create-ui-1', workPayload(customer.id, { title: 'Synthetic independent A' }));
    const second = await createWork(env, 'ui-person-two', 'work-create-ui-2', workPayload(customer.id, { title: 'Synthetic independent B' }));
    const works = await listWorks(env, { customer_id: customer.id });

    assert.equal(first.price_state, 'PRICE_UNSET');
    assert.equal(first.price_minor_units, null);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.title, second.title);
    assert.equal(first.relationship_kind, 'INDEPENDENT');
    assert.equal(second.relationship_kind, 'INDEPENDENT');
    assert.equal(works.length, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM works WHERE customer_id=?").get(customer.id).count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='work' AND action='CREATE'").get().count, 2);
  } finally { database.close(); }
});

test('AC-07 and AC-13: runtime catalog addition, documented fact, warning projection, history and similar-work read are deterministic', async () => {
  const { database, env } = fixture();
  try {
    await seedCatalogs(env);
    await createCatalogValue(env, 'ui-person-one', 'catalog-country-runtime', 'country', { value_key: 'SYN_NEW_COUNTRY', label: 'Synthetic Added At Runtime' });
    const countries = await listCatalog(env, 'country');
    assert.equal(countries.some(value => value.value_key === 'SYN_NEW_COUNTRY'), true);

    const firstCustomer = await createCustomer(env, 'ui-person-one', 'customer-create-ui-2', customerPayload());
    const secondCustomer = await createCustomer(env, 'ui-person-two', 'customer-create-ui-3', customerPayload({ name: 'Synthetic Similar Customer', country: 'SYN_NEW_COUNTRY' }));
    const firstWork = await createWork(env, 'ui-person-one', 'work-create-ui-3', workPayload(firstCustomer.id));
    const secondWork = await createWork(env, 'ui-person-two', 'work-create-ui-4', workPayload(secondCustomer.id, { country: 'SYN_COUNTRY', title: 'Synthetic Similar Work' }));
    const baseRequest = await createPriceChangeRequest(env, 'ui-person-one', 's6-similar-base-request', firstWork.id, { version: firstWork.version, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'S6 similar authoritative base', effective_at: '2026-08-01T09:00:00.000Z' });
    await approvePriceChangeRequest(env, 'ui-person-two', 's6-similar-base-approval', firstWork.id, baseRequest.id);
    await createDocumentedFact(env, 'ui-person-one', 'fact-create-ui-1', {
      customer_id: firstCustomer.id,
      work_id: firstWork.id,
      fact_type: 'NON_PAYMENT',
      source_ref: 'synthetic-documented-payment-evidence',
      happened_at: '2026-08-01T12:00:00.000Z',
      details: { note: 'Synthetic only' },
    });

    const [warnings, history, similar, authoritativeWork, financials] = await Promise.all([getCustomerWarnings(env, firstCustomer.id), getCustomerHistory(env, firstCustomer.id), getSimilarWorks(env, secondWork.id), getWork(env, firstWork.id), getWorkFinancials(env, firstWork.id)]);
    assert.deepEqual(warnings.map(item => item.warning_type), ['NON_PAYMENT']);
    assert.equal(warnings[0].source_ref, 'synthetic-documented-payment-evidence');
    assert.equal(history.length, 1);
    assert.equal(history[0].fact_type, 'NON_PAYMENT');
    assert.equal(authoritativeWork.pricing_state, 'PRICE_APPROVED');
    assert.equal(authoritativeWork.current_price_halalas, 150000);
    assert.equal(authoritativeWork.price_state, 'PRICE_UNSET');
    assert.equal(authoritativeWork.price_minor_units, null);
    assert.equal(authoritativeWork.pricing_source, 'S6_APPROVED_PRICE_MOVEMENTS');
    assert.equal(financials.current_price_halalas, 150000);
    assert.equal(similar.length, 1);
    assert.equal(similar[0].title, 'Synthetic UI Work');
    assert.equal(similar[0].pricing_state, 'PRICE_APPROVED');
    assert.equal(similar[0].current_price_halalas, 150000);
    assert.equal(similar[0].price_state, 'PRICE_UNSET');
    assert.throws(() => database.exec("INSERT INTO customer_warning_projection(fact_id,customer_id,warning_type) VALUES ('manual','x','MANUAL')"), /view/);
  } finally { database.close(); }
});

test('S6 PR-B backdated effective date preserves approval-order transition and current price', async () => {
  const { database, env } = fixture();
  try {
    await seedCatalogs(env);
    const customer = await createCustomer(env, 'ui-person-one', 's6-backdated-customer', customerPayload({ name: 'Backdated Customer' }));
    const work = await createWork(env, 'ui-person-one', 's6-backdated-work', workPayload(customer.id, { title: 'Backdated Work' }));
    const base = await createPriceChangeRequest(env, 'ui-person-one', 's6-backdated-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'Base approved now', effective_at: '2026-08-10T12:00:00.000Z' });
    const baseApproval = await approvePriceChangeRequest(env, 'ui-person-two', 's6-backdated-base-approval', work.id, base.id);
    const workAfterBase = await getWork(env, work.id);
    const increase = await createPriceChangeRequest(env, 'ui-person-two', 's6-backdated-increase-request', work.id, { version: workAfterBase.version, movement_type: 'INCREASE', amount_riyals: '200.00', reason: 'Backdated scope change', effective_at: '2026-08-01T12:00:00.000Z' });
    const increaseApproval = await approvePriceChangeRequest(env, 'ui-person-one', 's6-backdated-increase-approval', work.id, increase.id);
    const financials = await getWorkFinancials(env, work.id);
    assert.equal(baseApproval.financials.current_price_halalas, 150000);
    assert.equal(increaseApproval.financials.current_price_halalas, 170000);
    assert.deepEqual(financials.movements.map(item => item.previous_price_halalas), [null, 150000]);
    assert.deepEqual(financials.movements.map(item => item.new_price_halalas), [150000, 170000]);
    assert.equal(financials.movements[1].effective_at, '2026-08-01T12:00:00.000Z');
    assert.ok(new Date(financials.movements[0].approved_at).getTime() <= new Date(financials.movements[1].approved_at).getTime());
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM price_movements WHERE work_id=?').get(work.id).count, 2);
  } finally { database.close(); }
});

test('S4 Gate 2 negative UI/API paths preserve backend authority for version conflict, invalid relations, catalog misses, and audit atomicity', async () => {
  const { database, env } = fixture();
  try {
    await seedCatalogs(env);
    const customer = await createCustomer(env, 'ui-person-one', 'customer-create-ui-4', customerPayload());
    const parent = await createWork(env, 'ui-person-one', 'work-create-ui-5', workPayload(customer.id, { title: 'Synthetic parent' }));
    const child = await createWork(env, 'ui-person-two', 'work-create-ui-6', workPayload(customer.id, { title: 'Synthetic child', relationship_kind: 'CHILD', parent_work_id: parent.id }));
    const updated = await updateCustomer(env, 'ui-person-two', 'customer-update-ui-1', customer.id, { version: customer.version, name: 'Synthetic refreshed name' });
    await assert.rejects(updateCustomer(env, 'ui-person-one', 'customer-update-ui-stale', customer.id, { version: customer.version, name: 'Synthetic stale name' }), /VERSION_CONFLICT/);
    await assert.rejects(createWork(env, 'ui-person-one', 'work-create-ui-bad-parent', workPayload(customer.id, { relationship_kind: 'CHILD', parent_work_id: 'synthetic-missing-parent' })), /PARENT_NOT_FOUND/);
    await assert.rejects(updateWork(env, 'ui-person-one', 'work-cycle-ui-1', parent.id, { version: parent.version, relationship_kind: 'CHILD', parent_work_id: child.id, title: parent.title, country: parent.country }), /PARENT_CYCLE/);
    await assert.rejects(createWork(env, 'ui-person-one', 'work-catalog-ui-1', workPayload(customer.id, { country: 'SYN_CATALOG_MISSING' })), /CATALOG_VALUE_INVALID/);
    assert.equal(updated.version, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE request_id='customer-update-ui-stale'").get().count, 0);
    assert.throws(() => database.exec("UPDATE audit_log SET action='TAMPER'"), /audit log is append only/);
  } finally { database.close(); }
});
