import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createCustomer,
  createDocumentedFact,
  createWork,
  getCustomer,
  getCustomerWarnings,
  getWork,
  listWorks,
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
  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const prepared = this.database.prepare(statement.sql);
        if (/^\s*SELECT\b/i.test(statement.sql)) return { success: true, results: prepared.all(...statement.values), meta: { changes: 0 } };
        const result = prepared.run(...statement.values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(schemaPath, 'utf8'));
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('final-repair-person-one', 'person_1', 'final-repair-synthetic');
  database.prepare('INSERT INTO catalog_values(id,kind,value_key,label,active,created_by,created_at) VALUES (?,?,?,?,1,?,?)').run('final-repair-country', 'country', 'SYN_COUNTRY', 'Synthetic Country', 'final-repair-person-one', '2026-08-01T00:00:00.000Z');
  database.prepare('INSERT INTO catalog_values(id,kind,value_key,label,active,created_by,created_at) VALUES (?,?,?,?,1,?,?)').run('final-repair-specialty', 'specialty', 'SYN_SPECIALTY', 'Synthetic Specialty', 'final-repair-person-one', '2026-08-01T00:00:00.000Z');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'final-repair-synthetic', FIREBASE_PROJECT_ID: 'synthetic-final-repair-project' } };
}

function customerInput(extra = {}) {
  return { name: 'Synthetic Final Repair Customer', contact: 'synthetic-contact', country: null, university: null, specialty: null, notes: 'synthetic only', ...extra };
}

function workInput(customerId, extra = {}) {
  return { customer_id: customerId, title: 'Synthetic Final Repair Work', country: 'SYN_COUNTRY', university: null, specialty_key: null, work_type_key: null, subject_or_course_code: null, description: 'synthetic only', relationship_kind: 'INDEPENDENT', ...extra };
}

async function addFact(env, customerId, requestId, factType, sourceRef, happenedAt) {
  return createDocumentedFact(env, 'final-repair-person-one', requestId, {
    customer_id: customerId,
    fact_type: factType,
    source_ref: sourceRef,
    happened_at: happenedAt,
    details: {},
  });
}

test('final repair: documented facts and warning projection preserve earlier warnings without latest-fact scalar overwrite', async () => {
  const { database, env } = fixture();
  try {
    await assert.rejects(
      createCustomer(env, 'final-repair-person-one', 'final-repair-manual-factual-status', customerInput({ status: 'unpaid' })),
      { code: 'CUSTOMER_STATUS_DERIVED' },
    );

    const customer = await createCustomer(env, 'final-repair-person-one', 'final-repair-non-payment-customer', customerInput());
    await addFact(env, customer.id, 'final-repair-non-payment', 'NON_PAYMENT', 'synthetic-non-payment', '2026-08-01T12:00:00.000Z');
    assert.deepEqual((await getCustomerWarnings(env, customer.id)).map(item => item.warning_type), ['NON_PAYMENT']);
    assert.equal((await getCustomer(env, customer.id)).status, 'normal');

    await addFact(env, customer.id, 'final-repair-delay-after-non-payment', 'DELAY', 'synthetic-delay-after', '2026-08-02T12:00:00.000Z');
    const warningsAfterDelay = await getCustomerWarnings(env, customer.id);
    assert.deepEqual(warningsAfterDelay.map(item => item.warning_type), ['NON_PAYMENT', 'DELAY']);
    assert.equal(warningsAfterDelay.some(item => item.warning_type === 'NON_PAYMENT' && item.source_ref === 'synthetic-non-payment'), true);
    assert.equal((await getCustomer(env, customer.id)).status, 'normal');

    const multipleFactsCustomer = await createCustomer(env, 'final-repair-person-one', 'final-repair-multiple-facts-customer', customerInput({ name: 'Synthetic Multiple Facts' }));
    await addFact(env, multipleFactsCustomer.id, 'final-repair-blocked', 'BLOCKED', 'synthetic-blocked', '2026-08-03T12:00:00.000Z');
    await addFact(env, multipleFactsCustomer.id, 'final-repair-dispute', 'DISPUTE', 'synthetic-dispute', '2026-08-04T12:00:00.000Z');
    const multipleWarnings = await getCustomerWarnings(env, multipleFactsCustomer.id);
    assert.deepEqual(multipleWarnings.map(item => item.warning_type), ['BLOCKED', 'DISPUTE']);
    assert.equal((await getCustomer(env, multipleFactsCustomer.id)).status, 'normal');

    const delayOnlyCustomer = await createCustomer(env, 'final-repair-person-one', 'final-repair-delay-only-customer', customerInput({ name: 'Synthetic Delay Only' }));
    await addFact(env, delayOnlyCustomer.id, 'final-repair-delay-only', 'DELAY', 'synthetic-delay-only', '2026-08-05T12:00:00.000Z');
    assert.equal((await getCustomer(env, delayOnlyCustomer.id)).status, 'normal');
    assert.equal(database.prepare('SELECT status FROM customers WHERE id=?').get(delayOnlyCustomer.id).status, 'normal');
  } finally {
    database.close();
  }
});

test('final repair: FR-006 soft warnings are read projections, persist after reload, and disappear after details are supplied', async () => {
  const { database, env } = fixture();
  try {
    const customer = await createCustomer(env, 'final-repair-person-one', 'final-repair-soft-warning-customer', customerInput());
    const created = await createWork(env, 'final-repair-person-one', 'final-repair-soft-warning-create', workInput(customer.id));
    const expectedWarnings = [
      { code: 'WORK_DETAIL_UNIVERSITY_MISSING', field: 'university', severity: 'SOFT_WARNING' },
      { code: 'WORK_DETAIL_SPECIALTY_MISSING', field: 'specialty_key', severity: 'SOFT_WARNING' },
    ];
    assert.deepEqual(created.soft_warnings, expectedWarnings);
    assert.deepEqual((await getWork(env, created.id)).soft_warnings, expectedWarnings);
    assert.deepEqual((await listWorks(env, { customer_id: customer.id }))[0].soft_warnings, expectedWarnings);

    const auditRowsBeforeCompletion = database.prepare("SELECT after_json FROM audit_log WHERE entity_type='work' AND entity_id=? ORDER BY id").all(created.id);
    assert.equal(auditRowsBeforeCompletion.every(row => Object.hasOwn(JSON.parse(row.after_json), 'soft_warnings') === false), true);
    assert.equal((await getCustomerWarnings(env, customer.id)).length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM documented_facts WHERE customer_id=?').get(customer.id).count, 0);

    const completed = await updateWork(env, 'final-repair-person-one', 'final-repair-soft-warning-complete', created.id, {
      version: created.version,
      university: 'Synthetic University',
      specialty_key: 'SYN_SPECIALTY',
    });
    assert.deepEqual(completed.soft_warnings, []);
    assert.deepEqual((await getWork(env, created.id)).soft_warnings, []);
    assert.deepEqual((await listWorks(env, { customer_id: customer.id }))[0].soft_warnings, []);

    const auditRows = database.prepare("SELECT after_json FROM audit_log WHERE entity_type='work' AND entity_id=? ORDER BY id").all(created.id);
    assert.equal(auditRows.every(row => Object.hasOwn(JSON.parse(row.after_json), 'soft_warnings') === false), true);
  } finally {
    database.close();
  }
});
