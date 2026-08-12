import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, {
  createCatalogValue,
  createCustomer,
  createWork,
  getWork,
  getWorkFinancials,
  createPriceChangeRequest,
  approvePriceChangeRequest,
  createRatioChangeRequest,
  approveRatioChangeRequest,
  listPriceMovements,
  listPriceChangeRequests,
  listRatioHistory,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const migrationPath = fileURLToPath(new URL('../../src/worker/migrations/0006_s6_financial_core.sql', import.meta.url));
const sourceWorkerPath = fileURLToPath(new URL('../../src/worker/src/index.js', import.meta.url));
const packagedRoot = fileURLToPath(new URL('../../worker/', import.meta.url));
const MAX_SAFE_HALALAS = Number.MAX_SAFE_INTEGER;

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

function fixture({ schema = readFileSync(schemaPath, 'utf8') } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'run-s6');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'run-s6');
  const env = { DB: new D1Database(database), RUN_MARKER: 'run-s6', FIREBASE_PROJECT_ID: 'demo-project' };
  return { database, env };
}

async function setupWork(env, { title = 'Synthetic S6 Work' } = {}) {
  await createCatalogValue(env, 'uid-one', `country-${title}`, 'country', { value_key: 'SA', label: 'Synthetic Saudi Arabia' });
  await createCatalogValue(env, 'uid-one', `specialty-${title}`, 'specialty', { value_key: 'IT', label: 'Synthetic IT' });
  await createCatalogValue(env, 'uid-one', `worktype-${title}`, 'work_type', { value_key: 'REPORT', label: 'Synthetic Report' });
  const customer = await createCustomer(env, 'uid-one', `customer-${title}`, { name: 'Synthetic Customer', country: 'SA', university: 'Synthetic University', specialty: 'IT' });
  const work = await createWork(env, 'uid-one', `work-${title}`, { customer_id: customer.id, title, country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University' });
  return { customer, work };
}

async function approvePrice(env, workId, request, actorUid, requestId) {
  return approvePriceChangeRequest(env, actorUid, requestId, workId, request.id);
}

async function approveRatio(env, workId, request, actorUid, requestId) {
  return approveRatioChangeRequest(env, actorUid, requestId, workId, request.id);
}

test('S6 MONEY parser rejects malformed, >2 decimals, and unsafe values before DB mutation', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    const before = database.prepare('SELECT COUNT(*) AS count FROM price_change_requests').get().count;
    for (const amount of ['1.001', '1.', '.50', 'abc', 1500, '90071992547409.92']) {
      await assert.rejects(createPriceChangeRequest(env, 'uid-one', `money-${String(amount).replace(/\W/g, '')}`, work.id, { version: 1, movement_type: 'BASE', amount_riyals: amount, reason: 'Synthetic invalid amount' }));
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM price_change_requests').get().count, before);
    const valid = await createPriceChangeRequest(env, 'uid-one', 'money-valid', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '0.00', reason: 'Synthetic zero base' });
    assert.equal(valid.amount_halalas, 0);
    assert.equal(MAX_SAFE_HALALAS, 9007199254740991);
  } finally { database.close(); }
});

test('S6 AC-02 computes 1500 + 200 + 100 and later -100 with retained history', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    let financials = await getWorkFinancials(env, work.id);
    assert.equal(financials.price_state, 'PRICE_UNSET');
    assert.equal(financials.current_price_halalas, null);
    assert.equal(financials.remaining_halalas, null);

    let request = await createPriceChangeRequest(env, 'uid-one', 'price-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'Synthetic base agreement' });
    financials = await getWorkFinancials(env, work.id);
    assert.equal(financials.price_requests[0].state, 'PENDING');
    assert.equal(financials.current_price_halalas, null);
    const approvedBase = await approvePrice(env, work.id, request, 'uid-two', 'price-base-approval');
    assert.equal(approvedBase.financials.current_price_halalas, 150000);
    assert.deepEqual(approvedBase.financials.shares, { person_1_halalas: 45000, person_2_halalas: 105000 });

    const workV2 = await getWork(env, work.id);
    request = await createPriceChangeRequest(env, 'uid-two', 'price-increase-1-request', work.id, { version: workV2.version, movement_type: 'INCREASE', amount_riyals: '200.00', reason: 'Synthetic survey outside agreement' });
    await approvePrice(env, work.id, request, 'uid-one', 'price-increase-1-approval');
    const workV3 = await getWork(env, work.id);
    request = await createPriceChangeRequest(env, 'uid-one', 'price-increase-2-request', work.id, { version: workV3.version, movement_type: 'INCREASE', amount_riyals: '100.00', reason: 'Synthetic additional scope' });
    await approvePrice(env, work.id, request, 'uid-two', 'price-increase-2-approval');
    const workV4 = await getWork(env, work.id);
    request = await createPriceChangeRequest(env, 'uid-two', 'price-discount-request', work.id, { version: workV4.version, movement_type: 'DISCOUNT', amount_riyals: '-100.00', reason: 'Synthetic documented discount' });
    await approvePrice(env, work.id, request, 'uid-one', 'price-discount-approval');

    financials = await getWorkFinancials(env, work.id);
    assert.equal(financials.current_price_halalas, 170000);
    assert.deepEqual(financials.shares, { person_1_halalas: 51000, person_2_halalas: 119000 });
    assert.equal(financials.remaining_halalas, 170000);
    assert.equal(financials.approved_payments_total_halalas, 0);
    assert.equal(financials.remaining_projection, 'PRE_S7_APPROVED_PAYMENTS_ZERO');
    assert.deepEqual(financials.movements.map(item => item.amount_halalas), [150000, 20000, 10000, -10000]);
    assert.equal((await listPriceMovements(env, work.id)).length, 4);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM price_movements WHERE work_id=?').get(work.id).count, 4);
  } finally { database.close(); }
});

test('S6 price approval works in both directions and rejects self approval server-side', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    const base = await createPriceChangeRequest(env, 'uid-one', 'both-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'Base from person one' });
    await assert.rejects(approvePrice(env, work.id, base, 'uid-one', 'both-base-self'), /SELF_APPROVAL_REJECTED/);
    await approvePrice(env, work.id, base, 'uid-two', 'both-base-approval');
    const workV2 = await getWork(env, work.id);
    const increase = await createPriceChangeRequest(env, 'uid-two', 'both-increase-request', work.id, { version: workV2.version, movement_type: 'INCREASE', amount_riyals: '200.00', reason: 'Increase from person two' });
    await assert.rejects(approvePrice(env, work.id, increase, 'uid-two', 'both-increase-self'), /SELF_APPROVAL_REJECTED/);
    const approved = await approvePrice(env, work.id, increase, 'uid-one', 'both-increase-approval');
    assert.equal(approved.financials.current_price_halalas, 170000);
    assert.equal((await listPriceChangeRequests(env, work.id)).filter(item => item.state === 'APPROVED').length, 2);
  } finally { database.close(); }
});

test('S6 approval races produce exactly one business success and one movement/audit', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    const base = await createPriceChangeRequest(env, 'uid-one', 'race-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'Race base' });
    await approvePrice(env, work.id, base, 'uid-two', 'race-base-approval');
    const current = await getWork(env, work.id);
    const request = await createPriceChangeRequest(env, 'uid-one', 'race-increase-request', work.id, { version: current.version, movement_type: 'INCREASE', amount_riyals: '200.00', reason: 'Race increase' });
    const results = await Promise.allSettled([
      approvePrice(env, work.id, request, 'uid-two', 'race-approval-a'),
      approvePrice(env, work.id, request, 'uid-two', 'race-approval-b'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM price_movements WHERE price_request_id=?').get(request.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='price_movement' AND entity_id IN (SELECT id FROM price_movements WHERE price_request_id=?)").get(request.id).count, 1);
    assert.equal((await getWorkFinancials(env, work.id)).current_price_halalas, 170000);
  } finally { database.close(); }
});

test('S6 ratio exception is pending then approved by other account with retained history', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    const base = await createPriceChangeRequest(env, 'uid-one', 'ratio-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1700.00', reason: 'Ratio base' });
    await approvePrice(env, work.id, base, 'uid-two', 'ratio-base-approval');
    const current = await getWork(env, work.id);
    const ratioRequest = await createRatioChangeRequest(env, 'uid-one', 'ratio-request', work.id, { version: current.version, person_1_bps: 5000, person_2_bps: 5000, reason: 'Synthetic exceptional equal share' });
    let financials = await getWorkFinancials(env, work.id);
    assert.deepEqual(financials.ratio, { person_1_bps: 3000, person_2_bps: 7000, source: 'DEFAULT' });
    assert.deepEqual(financials.shares, { person_1_halalas: 51000, person_2_halalas: 119000 });
    await assert.rejects(approveRatio(env, work.id, ratioRequest, 'uid-one', 'ratio-self'), /SELF_APPROVAL_REJECTED/);
    const approved = await approveRatio(env, work.id, ratioRequest, 'uid-two', 'ratio-approval');
    assert.deepEqual(approved.financials.ratio, { person_1_bps: 5000, person_2_bps: 5000, source: 'APPROVED_HISTORY' });
    assert.deepEqual(approved.financials.shares, { person_1_halalas: 85000, person_2_halalas: 85000 });
    const history = await listRatioHistory(env, work.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].old_person_1_bps, 3000);
    assert.equal(history[0].new_person_1_bps, 5000);
  } finally { database.close(); }
});

test('S6 shares use independent half-up rounding without residual rebalance', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, { title: 'Rounding Work' });
    const base = await createPriceChangeRequest(env, 'uid-one', 'round-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '0.01', reason: 'One halalah synthetic base' });
    await approvePrice(env, work.id, base, 'uid-two', 'round-base-approval');
    const current = await getWork(env, work.id);
    const ratioRequest = await createRatioChangeRequest(env, 'uid-two', 'round-ratio-request', work.id, { version: current.version, person_1_bps: 5000, person_2_bps: 5000, reason: 'Tie rounding test' });
    const approved = await approveRatio(env, work.id, ratioRequest, 'uid-one', 'round-ratio-approval');
    assert.deepEqual(approved.financials.shares, { person_1_halalas: 1, person_2_halalas: 1 });
    assert.equal(approved.financials.current_price_halalas, 1);
    assert.equal(approved.financials.remaining_halalas, 1);
  } finally { database.close(); }
});

test('S6 financial audit is append-only, integer-only, and preserves before/after actor/request data', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    const request = await createPriceChangeRequest(env, 'uid-one', 'audit-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'Audit base' });
    await approvePrice(env, work.id, request, 'uid-two', 'audit-base-approval');
    const auditRows = database.prepare("SELECT entity_type, actor_uid, before_json, after_json, request_id FROM audit_log WHERE entity_type IN ('price_change_request','price_movement') ORDER BY id").all();
    assert.equal(auditRows.length, 3);
    assert.equal(auditRows[0].actor_uid, 'uid-one');
    assert.equal(JSON.parse(auditRows[0].after_json).amount_halalas, 150000);
    assert.equal(auditRows[1].actor_uid, 'uid-two');
    assert.equal(JSON.parse(auditRows[1].after_json).state, 'APPROVED');
    assert.equal(auditRows[2].actor_uid, 'uid-two');
    assert.equal(JSON.parse(auditRows[2].after_json).resulting_price_halalas, 150000);
    assert.throws(() => database.exec("UPDATE price_movements SET amount_halalas=1"), /price_movements are append only/);
    assert.throws(() => database.exec("DELETE FROM price_change_requests"), /price_change_requests are append only/);
    database.prepare(`INSERT INTO ratio_change_requests(id,work_id,person_1_bps,person_2_bps,reason,requested_by,requested_at,work_version,state,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run('ratio-request-test', work.id, 5000, 5000, 'Trigger fixture', 'uid-one', '2026-08-11T12:00:00.000Z', 2, 'PENDING', 'ratio-request-test');
    database.prepare(`INSERT INTO ratio_history(id,work_id,old_person_1_bps,old_person_2_bps,new_person_1_bps,new_person_2_bps,reason,requested_by,approved_by,requested_at,approved_at,ratio_request_id,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('ratio-hist-test', work.id, 3000, 7000, 5000, 5000, 'Trigger fixture', 'uid-one', 'uid-two', '2026-08-11T12:00:00.000Z', '2026-08-11T12:01:00.000Z', 'ratio-request-test', 'ratio-request-test');
    assert.throws(() => database.exec("UPDATE ratio_history SET reason='tampered'"), /ratio_history is append only/);
  } finally { database.close(); }
});

test('S6 migration preserves S5 rows and installs financial tables and audit types', async () => {
  const fullSchema = readFileSync(schemaPath, 'utf8');
  const marker = '\n-- S6 PR-A Financial Core additive schema.';
  const oldSchema = fullSchema.slice(0, fullSchema.indexOf(marker)).replace(", 'price_change_request','price_movement','ratio_change_request','ratio_history'", '');
  const { database, env } = fixture({ schema: oldSchema });
  try {
    const { customer, work } = await setupWork(env);
    const beforeWork = database.prepare('SELECT id,title FROM works WHERE id=?').get(work.id);
    database.exec(readFileSync(migrationPath, 'utf8'));
    assert.deepEqual(database.prepare('SELECT id,title FROM works WHERE id=?').get(work.id), beforeWork);
    for (const table of ['price_change_requests', 'price_movements', 'ratio_change_requests', 'ratio_history']) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    const auditSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get().sql;
    assert.match(auditSql, /price_change_request/);
    assert.throws(() => database.exec("DELETE FROM works WHERE id='" + work.id + "'"), /hard delete is not allowed/);
    assert.equal(customer.id, database.prepare('SELECT id FROM customers WHERE id=?').get(customer.id).id);
  } finally { database.close(); }
});

test('S6 stale, duplicate, and negative-final-price attempts fail closed without financial side effects', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, { title: 'Adversarial Work' });
    const base = await createPriceChangeRequest(env, 'uid-one', 'adv-base-request', work.id, { version: 1, movement_type: 'BASE', amount_riyals: '1500.00', reason: 'Adversarial base' });
    await approvePrice(env, work.id, base, 'uid-two', 'adv-base-approval');
    await assert.rejects(createPriceChangeRequest(env, 'uid-one', 'adv-stale-request', work.id, { version: 1, movement_type: 'INCREASE', amount_riyals: '10.00', reason: 'Stale request' }), /VERSION_CONFLICT/);
    await assert.rejects(approvePrice(env, work.id, base, 'uid-two', 'adv-duplicate-approval'), /ALREADY_FINALIZED/);
    const current = await getWork(env, work.id);
    const negative = await createPriceChangeRequest(env, 'uid-one', 'adv-negative-request', work.id, { version: current.version, movement_type: 'DECREASE', amount_riyals: '-1600.00', reason: 'Adversarial negative final price' });
    await assert.rejects(approvePrice(env, work.id, negative, 'uid-two', 'adv-negative-approval'), /S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED/);
    assert.equal((await getWorkFinancials(env, work.id)).current_price_halalas, 150000);
    assert.equal(database.prepare('SELECT state FROM price_change_requests WHERE id=?').get(negative.id).state, 'PENDING');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM price_movements WHERE work_id=?').get(work.id).count, 1);
    assert.equal((await getWork(env, work.id)).version, current.version);
  } finally { database.close(); }
});

test('S6 API envelope is consumed by the existing private Worker route', { skip: !(() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })() }, async () => {
  const { database, env } = fixture();
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), 's6-x509-'));
  const privateKeyPath = join(directory, 'private-key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=s6-firebase-x509-test', '-keyout', privateKeyPath, '-out', certificatePath], { stdio: 'ignore' });
    const keyPem = readFileSync(privateKeyPath, 'utf8');
    const keyLabel = ['PRIVATE', 'KEY'].join(' ');
    const match = keyPem.match(new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`));
    const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(match[1].replace(/\s+/g, ''), 'base64')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const certificatePem = readFileSync(certificatePath, 'utf8');
    globalThis.fetch = async () => new Response(JSON.stringify({ s6test: certificatePem }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
    const b64 = bytes => Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const json = value => b64(new TextEncoder().encode(JSON.stringify(value)));
    const now = Math.floor(Date.now() / 1000);
    const signingInput = `${json({ alg: 'RS256', kid: 's6test', typ: 'JWT' })}.${json({ aud: 'demo-project', iss: 'https://securetoken.google.com/demo-project', sub: 'uid-one', iat: now - 10, auth_time: now - 10, exp: now + 3600 })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));
    const token = `${signingInput}.${b64(new Uint8Array(signature))}`;
    const { work } = await setupWork(env);
    const response = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/financials`, { headers: { authorization: `Bearer ${token}`, 'x-s3-run-id': 'run-s6' } }), env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.ok(payload.requestId);
    assert.equal(payload.data.price_state, 'PRICE_UNSET');
    assert.equal(payload.data.remaining_projection, 'PRE_S7_APPROVED_PAYMENTS_ZERO');
    const malformed = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/price-requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-s3-run-id': 'run-s6', 'x-s3-request-id': 's6-malformed-json' }, body: '{' }), env);
    assert.equal(malformed.status, 400);
    const malformedPayload = await malformed.json();
    assert.deepEqual(malformedPayload, { ok: false, code: 'JSON_INVALID', requestId: 's6-malformed-json' });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
    database.close();
  }
});

test('S6 source/package parity and no S7 payment tables/routes', () => {
  for (const relativePath of ['schema.sql', 'schema_s6.sql', 'src/index.js', 'migrations/0006_s6_financial_core.sql']) {
    const sourcePath = join(fileURLToPath(new URL('../../src/worker/', import.meta.url)), relativePath);
    const packagedPath = join(packagedRoot, relativePath);
    assert.equal(readFileSync(sourcePath, 'utf8'), readFileSync(packagedPath, 'utf8'), `worker mirror mismatch: ${relativePath}`);
  }
  const schema = readFileSync(schemaPath, 'utf8');
  const source = readFileSync(sourceWorkerPath, 'utf8');
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS (payment|payments|settlements|subscriptions)/i);
  assert.doesNotMatch(source, /\/api\/payments|\/api\/settlements|\/api\/subscriptions/);
});
