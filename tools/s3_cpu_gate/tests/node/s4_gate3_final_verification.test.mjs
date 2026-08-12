import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCustomer, createDocumentedFact, createWork, getCustomer } from '../../src/worker/src/index.js';

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
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('gate3-person-one', 'person_1', 'gate3-synthetic');
  database.prepare('INSERT INTO catalog_values(id,kind,value_key,label,active,created_by,created_at) VALUES (?,?,?,?,1,?,?)').run('gate3-country', 'country', 'SYN_COUNTRY', 'Synthetic Country', 'gate3-person-one', '2026-08-01T00:00:00.000Z');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'gate3-synthetic', FIREBASE_PROJECT_ID: 'synthetic-gate3-project' } };
}

function customerInput(extra = {}) {
  return { name: 'Synthetic Gate 3 Customer', contact: 'synthetic-contact', country: null, university: null, specialty: null, notes: 'synthetic only', ...extra };
}

function workInput(customerId, extra = {}) {
  return { customer_id: customerId, title: 'Synthetic Gate 3 Work', country: 'SYN_COUNTRY', university: null, specialty_key: null, work_type_key: null, subject_or_course_code: null, description: 'Synthetic only', relationship_kind: 'INDEPENDENT', ...extra };
}

test('Gate 3: DELAY remains neutral until a governed frequency rule exists', async () => {
  const { database, env } = fixture();
  try {
    const customer = await createCustomer(env, 'gate3-person-one', 'gate3-delay-customer', customerInput());
    await createDocumentedFact(env, 'gate3-person-one', 'gate3-delay-fact', {
      customer_id: customer.id,
      fact_type: 'DELAY',
      source_ref: 'synthetic-delay-evidence',
      happened_at: '2026-08-02T12:00:00.000Z',
      details: {},
    });
    assert.equal((await getCustomer(env, customer.id)).status, 'normal');
  } finally {
    database.close();
  }
});

test('Gate 3: FR-006 returns soft missing-detail warnings without rejecting a valid work', async () => {
  const { database, env } = fixture();
  try {
    const customer = await createCustomer(env, 'gate3-person-one', 'gate3-soft-warning-customer', customerInput());
    const work = await createWork(env, 'gate3-person-one', 'gate3-soft-warning-work', workInput(customer.id));
    assert.deepEqual(work.soft_warnings, [
      { code: 'WORK_DETAIL_UNIVERSITY_MISSING', field: 'university', severity: 'SOFT_WARNING' },
      { code: 'WORK_DETAIL_SPECIALTY_MISSING', field: 'specialty_key', severity: 'SOFT_WARNING' },
    ]);
    const stored = database.prepare('SELECT university,specialty_key FROM works WHERE id=?').get(work.id);
    assert.equal(stored.university, null);
    assert.equal(stored.specialty_key, null);
    const audit = JSON.parse(database.prepare("SELECT after_json FROM audit_log WHERE entity_type='work' AND entity_id=?").get(work.id).after_json);
    assert.equal(Object.hasOwn(audit, 'soft_warnings'), false);
  } finally {
    database.close();
  }
});

test('Gate 3: duplicate customer names remain distinct records and are never auto-merged', async () => {
  const { database, env } = fixture();
  try {
    const first = await createCustomer(env, 'gate3-person-one', 'gate3-duplicate-first', customerInput({ name: 'Synthetic Duplicate', notes: 'first synthetic record' }));
    const second = await createCustomer(env, 'gate3-person-one', 'gate3-duplicate-second', customerInput({ name: 'Synthetic Duplicate', notes: 'second synthetic record' }));
    assert.notEqual(first.id, second.id);
    const rows = database.prepare('SELECT id,notes FROM customers WHERE name=? ORDER BY created_at,id').all('Synthetic Duplicate');
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.notes)), new Set(['first synthetic record', 'second synthetic record']));
  } finally {
    database.close();
  }
});
