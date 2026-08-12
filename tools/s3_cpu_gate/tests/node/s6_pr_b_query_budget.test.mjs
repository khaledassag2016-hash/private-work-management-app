import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createCatalogValue,
  createCustomer,
  createWork,
  getSimilarWorks,
  listWorks,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.parameterMap = [];
    this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; });
    this.values = [];
  }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; this.database.bindingWidths.push(this.values.length); return this; }
  first() { this.database.readQueries += 1; return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { this.database.readQueries += 1; return { results: this.database.prepare(this.sql).all(...this.values) }; }
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
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 's6-query-budget');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 's6-query-budget');
  database.readQueries = 0;
  database.bindingWidths = [];
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 's6-query-budget', FIREBASE_PROJECT_ID: 'synthetic-query-budget' } };
}

async function seedCatalogs(env) {
  await createCatalogValue(env, 'uid-one', 'budget-country-request', 'country', { value_key: 'BUDGET_COUNTRY', label: 'Budget Country' });
  await createCatalogValue(env, 'uid-one', 'budget-specialty-request', 'specialty', { value_key: 'BUDGET_SPECIALTY', label: 'Budget Specialty' });
  await createCatalogValue(env, 'uid-one', 'budget-work-type-request', 'work_type', { value_key: 'BUDGET_REPORT', label: 'Budget Report' });
}

function workPayload(customerId, title) {
  return { customer_id: customerId, title, country: 'BUDGET_COUNTRY', university: 'Budget University', specialty_key: 'BUDGET_SPECIALTY', work_type_key: 'BUDGET_REPORT', subject_or_course_code: 'BUDGET-001', description: 'Synthetic query budget fixture' };
}
function fixtureTimestamp(index, minuteOffset) {
  return new Date(Date.UTC(2026, 7, 1, 0, minuteOffset, index)).toISOString();
}

async function seedLargePricingFixture(env, database) {
  await seedCatalogs(env);
  const customer = await createCustomer(env, 'uid-one', 'budget-customer-request', { name: 'Budget Customer', country: 'BUDGET_COUNTRY', university: 'Budget University', specialty: 'BUDGET_SPECIALTY' });
  const works = [];
  const expectedPrices = new Map();
  for (let index = 0; index < 200; index += 1) {
    const work = await createWork(env, index % 2 === 0 ? 'uid-one' : 'uid-two', `budget-work-create-${index}`, workPayload(customer.id, `Budget Work ${index}`));
    works.push(work);
    const amountHalalas = 100000 + index;
    expectedPrices.set(work.id, amountHalalas);
    const requestedAt = fixtureTimestamp(index, 0);
    const approvedAt = fixtureTimestamp(index, 1);
    database.prepare(`INSERT INTO price_change_requests(id,work_id,movement_type,amount_halalas,reason,effective_at,requested_by,requested_at,work_version,state,approved_by,approved_at,approval_request_id,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,'APPROVED',?,?,?,?)`).run(`budget-price-req-${index}`, work.id, 'BASE', amountHalalas, 'Synthetic query budget base', requestedAt, 'uid-one', requestedAt, 1, 'uid-two', approvedAt, `budget-approval-${index}`, `budget-request-${index}`);
    database.prepare(`INSERT INTO price_movements(id,work_id,price_request_id,movement_type,amount_halalas,reason,effective_at,requested_by,approved_by,requested_at,approved_at,resulting_price_halalas,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`budget-price-movement-${index}`, work.id, `budget-price-req-${index}`, 'BASE', amountHalalas, 'Synthetic query budget base', requestedAt, 'uid-one', 'uid-two', requestedAt, approvedAt, amountHalalas, `budget-movement-${index}`);
  }
  return { customer, works, expectedPrices };
}

test('S6 PR-B query budget keeps listWorks bulk and authoritative for 200 works', async () => {
  const { database, env } = fixture();
  try {
    const { works, expectedPrices } = await seedLargePricingFixture(env, database);
    database.readQueries = 0;
    database.bindingWidths = [];
    const listed = await listWorks(env);
    assert.equal(listed.length, 200);
    assert.equal(database.readQueries, 3, `listWorks should use one works query plus two bulk queries, got ${database.readQueries}`);
    assert.deepEqual(database.bindingWidths, [0, 100, 100]);
    assert.ok(database.bindingWidths.every(width => width <= 100), `listWorks exceeded binding limit: ${database.bindingWidths}`);
    for (const work of listed) {
      assert.equal(work.pricing_state, 'PRICE_APPROVED');
      assert.equal(work.current_price_halalas, expectedPrices.get(work.id));
      assert.equal(work.pricing_source, 'S6_APPROVED_PRICE_MOVEMENTS');
      assert.equal(work.price_state, 'PRICE_UNSET');
      assert.equal(work.price_minor_units, null);
    }
  } finally { database.close(); }
});

test('S6 PR-B query budget keeps similar-work authoritative and under D1 free limit for 50 similar works', async () => {
  const { database, env } = fixture();
  try {
    const { works, expectedPrices } = await seedLargePricingFixture(env, database);
    database.readQueries = 0;
    database.bindingWidths = [];
    const similar = await getSimilarWorks(env, works[0].id);
    assert.equal(similar.length, 50);
    assert.equal(database.readQueries, 3, `getSimilarWorks should use target, similar, and one bulk query, got ${database.readQueries}`);
    assert.deepEqual(database.bindingWidths, [1, 6, 50]);
    assert.ok(database.bindingWidths.every(width => width <= 100), `getSimilarWorks exceeded binding limit: ${database.bindingWidths}`);
    for (const work of similar) {
      assert.equal(work.pricing_state, 'PRICE_APPROVED');
      assert.equal(work.current_price_halalas, expectedPrices.get(work.id));
      assert.equal(work.pricing_source, 'S6_APPROVED_PRICE_MOVEMENTS');
      assert.equal(work.price_state, 'PRICE_UNSET');
      assert.equal(work.price_minor_units, null);
    }
  } finally { database.close(); }
});
