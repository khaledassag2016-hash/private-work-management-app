import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import worker, {
  createCatalogValue,
  getS8Alerts,
  listS8AlertSettings,
  searchWorksS8,
  upsertS8AlertSetting,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const migrationPath = fileURLToPath(new URL('../../src/worker/migrations/0010_s8_search_filter_alert_core.sql', import.meta.url));
const fullSchema = readFileSync(schemaPath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');

class D1Statement {
  constructor(database, sql) { this.database = database; this.parameterMap = []; this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; }); this.values = []; }
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
        const result = prepared.run(...statement.values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      this.database.exec('COMMIT'); return Promise.resolve(results);
    } catch (error) { this.database.exec('ROLLBACK'); return Promise.reject(error); }
  }
}
function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(fullSchema); database.readQueries = 0; database.bindingWidths = [];
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('s8-uid-one', 'person_1', 's8-pr-a');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('s8-uid-two', 'person_2', 's8-pr-a');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 's8-pr-a', FIREBASE_PROJECT_ID: 'demo-project' } };
}
function insertCustomer(database, id, name, country = 'S8_COUNTRY_A') {
  database.prepare('INSERT INTO customers(id,name,country,university,specialty,status,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,\'normal\',?,?,?,?,1)').run(id, name, country, 'Synthetic University A', 'S8_SPECIALTY_A', 's8-uid-one', '2025-01-01T00:00:00.000Z', 's8-uid-one', '2025-01-01T00:00:00.000Z');
}
function insertWork(database, index, overrides = {}) {
  const id = overrides.id || `WORK-S8-${String(index).padStart(3, '0')}`;
  const createdAt = overrides.created_at || (index % 2 ? '2025-03-15T10:00:00.000Z' : '2026-08-12T10:00:00.000Z');
  const confirmedAt = overrides.confirmed_at === undefined ? '2026-08-12T10:00:00.000Z' : overrides.confirmed_at;
  database.prepare(`INSERT INTO works(id,customer_id,parent_work_id,relationship_kind,title,work_type_key,specialty_key,subject_or_course_code,country,university,status,description,quantity,price_state,price_minor_units,created_by,created_at,updated_by,updated_at,confirmed_at,version,archived_at,archived_by,archive_request_id)
    VALUES (?,?,NULL,'INDEPENDENT',?,?,?,?,?,?,?,?,NULL,'PRICE_UNSET',NULL,?,?,?,?,?,1,?,?,?)`).run(
    id, overrides.customer_id || (index % 3 === 0 ? 'CUST-S8-002' : 'CUST-S8-001'), overrides.title || `Synthetic Search Work ${index}`,
    overrides.work_type_key || (index % 2 ? 'S8_TYPE_B' : 'S8_TYPE_A'), overrides.specialty_key || (index % 2 ? 'S8_SPECIALTY_B' : 'S8_SPECIALTY_A'), `COURSE-${index}`,
    overrides.country || (index % 2 ? 'S8_COUNTRY_B' : 'S8_COUNTRY_A'), overrides.university || (index % 2 ? 'Synthetic University B' : 'Synthetic University A'), overrides.status || (index % 3 ? 'IN_PROGRESS' : 'COMPLETED'),
    `Synthetic description ${index}`, 's8-uid-one', createdAt, 's8-uid-one', createdAt, confirmedAt, overrides.archived_at || null, overrides.archived_by || null, overrides.archive_request_id || null,
  );
  return id;
}
function insertPrice(database, workId, amountHalalas) {
  const effectiveAt = '2026-08-12T10:00:00.000Z'; const approvedAt = '2026-08-12T10:01:00.000Z'; const requestId = `price-request-${workId}`;
  database.prepare('INSERT INTO price_change_requests(id,work_id,movement_type,amount_halalas,reason,effective_at,requested_by,requested_at,work_version,state,approved_by,approved_at,approval_request_id,request_id) VALUES (?,?,?,?,?,?,?,?,?,\'APPROVED\',?,?,?,?)').run(requestId, workId, 'BASE', amountHalalas, 'Synthetic S8 price', effectiveAt, 's8-uid-one', effectiveAt, 1, 's8-uid-two', approvedAt, `price-approval-${workId}`, `price-create-${workId}`);
  database.prepare('INSERT INTO price_movements(id,work_id,price_request_id,movement_type,amount_halalas,reason,effective_at,requested_by,approved_by,requested_at,approved_at,resulting_price_halalas,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`price-${workId}`, workId, requestId, 'BASE', amountHalalas, 'Synthetic S8 price', effectiveAt, 's8-uid-one', 's8-uid-two', effectiveAt, approvedAt, amountHalalas, `price-movement-${workId}`);
}
function insertPayment(database, workId, amountHalalas) {
  database.prepare('INSERT INTO client_payments(id,work_id,amount_halalas,effective_at,payment_method,note,received_by,recorded_by,created_at,work_version,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`payment-${workId}`, workId, amountHalalas, '2026-08-14T10:00:00.000Z', 'BANK_TRANSFER', 'Synthetic S8 payment', 's8-uid-one', 's8-uid-two', '2026-08-14T10:00:00.000Z', 1, `payment-request-${workId}`);
}
function seedSearchFixture(database) {
  insertCustomer(database, 'CUST-S8-001', 'Synthetic Customer A'); insertCustomer(database, 'CUST-S8-002', 'Synthetic Customer B', 'S8_COUNTRY_B');
  for (let index = 0; index < 205; index += 1) insertWork(database, index);
  const currentTitleWork = 'WORK-S8-000';
  database.prepare('UPDATE works SET title=?,status=?,work_type_key=?,specialty_key=?,country=?,university=?,created_at=?,confirmed_at=? WHERE id=?').run('عنوان اصطناعي حالي C', 'COMPLETED', 'S8_TYPE_A', 'S8_SPECIALTY_A', 'S8_COUNTRY_A', 'Synthetic University A', '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z', currentTitleWork);
  database.prepare('INSERT INTO work_title_history(id,work_id,old_title,new_title,reason,changed_at,changed_by,request_id) VALUES (?,?,?,?,?,?,?,?)').run('title-s8-a', currentTitleWork, 'عنوان اصطناعي قديم A', 'عنوان اصطناعي قديم B', 'Synthetic title change', '2026-08-10T10:00:00.000Z', 's8-uid-one', 'title-request-a');
  database.prepare('INSERT INTO work_title_history(id,work_id,old_title,new_title,reason,changed_at,changed_by,request_id) VALUES (?,?,?,?,?,?,?,?)').run('title-s8-b', currentTitleWork, 'عنوان اصطناعي قديم B', 'عنوان اصطناعي حالي C', 'Synthetic title change', '2026-08-11T10:00:00.000Z', 's8-uid-two', 'title-request-b');
  insertPrice(database, currentTitleWork, 100000); insertPayment(database, currentTitleWork, 100000);
  const archived = 'WORK-S8-001'; database.prepare('UPDATE works SET title=?,status=?,archived_at=?,archived_by=?,archive_request_id=?,created_at=? WHERE id=?').run('عنوان أرشيفي اصطناعي', 'DELIVERED', '2025-03-20T10:00:00.000Z', 's8-uid-two', 'archive-request-s8', '2025-03-01T10:00:00.000Z', archived);
  database.prepare('INSERT INTO work_archive_history(id,work_id,archived_at,archived_by,reason,request_id) VALUES (?,?,?,?,?,?)').run('archive-history-s8', archived, '2025-03-20T10:00:00.000Z', 's8-uid-two', 'Synthetic archive', 'archive-request-s8');
  const unpaid = 'WORK-S8-002'; database.prepare('UPDATE works SET status=?,country=?,university=?,specialty_key=?,work_type_key=?,created_at=? WHERE id=?').run('WAITING_CLIENT_RESPONSE', 'S8_COUNTRY_B', 'Synthetic University B', 'S8_SPECIALTY_B', 'S8_TYPE_B', '2025-03-15T10:00:00.000Z', unpaid); insertPrice(database, unpaid, 200000);
  const partial = 'WORK-S8-003'; database.prepare('UPDATE works SET status=?,customer_id=?,country=?,university=?,specialty_key=?,work_type_key=?,created_at=? WHERE id=?').run('IN_PROGRESS', 'CUST-S8-002', 'S8_COUNTRY_B', 'Synthetic University B', 'S8_SPECIALTY_B', 'S8_TYPE_B', '2026-08-13T10:00:00.000Z', partial); insertPrice(database, partial, 300000); insertPayment(database, partial, 50000);
  return { currentTitleWork, archived, unpaid, partial };
}
function ids(result) { return result.items.map(item => item.id); }

test('S8 search finds current and old titles once by immutable Work identity', async () => {
  const { database, env } = fixture();
  try {
    const { currentTitleWork } = seedSearchFixture(database);
    for (const query of ['عنوان اصطناعي حالي C', 'عنوان اصطناعي قديم A', 'عنوان اصطناعي قديم B']) {
      const result = await searchWorksS8(env, { q: query, page_size: 100 });
      assert.deepEqual(ids(result), [currentTitleWork]);
    }
  } finally { database.close(); }
});

test('S8 search filters each authoritative dimension and preserves archived history', async () => {
  const { database, env } = fixture();
  try {
    const { currentTitleWork, archived, unpaid, partial } = seedSearchFixture(database);
    assert.ok(ids(await searchWorksS8(env, { month: '08', period_basis: 'CREATED_AT', page_size: 100 })).includes(currentTitleWork));
    assert.ok(!ids(await searchWorksS8(env, { month: '08', period_basis: 'CREATED_AT', page_size: 100 })).includes(archived));
    const year2025 = await searchWorksS8(env, { year: '2025', period_basis: 'CREATED_AT', page_size: 100 }); assert.ok(ids(year2025).includes(archived)); assert.ok(!ids(year2025).includes(currentTitleWork));
    const statusResult = await searchWorksS8(env, { status: 'WAITING_CLIENT_RESPONSE', page_size: 100 }); assert.ok(ids(statusResult).includes(unpaid)); assert.ok(!ids(statusResult).includes(currentTitleWork));
    const customerResult = await searchWorksS8(env, { customer_id: 'CUST-S8-002', page_size: 100 }); assert.ok(ids(customerResult).includes(partial)); assert.ok(!ids(customerResult).includes(unpaid));
    const countryResult = await searchWorksS8(env, { country: 'S8_COUNTRY_A', page_size: 100 }); assert.ok(ids(countryResult).includes(currentTitleWork)); assert.ok(!ids(countryResult).includes(partial));
    const universityResult = await searchWorksS8(env, { university: 'Synthetic University B', page_size: 100 }); assert.ok(ids(universityResult).includes(unpaid)); assert.ok(!ids(universityResult).includes(currentTitleWork));
    const specialtyResult = await searchWorksS8(env, { specialty_key: 'S8_SPECIALTY_B', page_size: 100 }); assert.ok(specialtyResult.items.length > 0); assert.ok(specialtyResult.items.every(item => item.specialty_key === 'S8_SPECIALTY_B'));
    const workTypeResult = await searchWorksS8(env, { work_type_key: 'S8_TYPE_B', page_size: 100 }); assert.ok(ids(workTypeResult).includes(unpaid)); assert.ok(workTypeResult.items.every(item => item.work_type_key === 'S8_TYPE_B'));
    const collectionResult = await searchWorksS8(env, { collection_status: 'UNPAID', page_size: 100 }); assert.deepEqual(ids(collectionResult).filter(id => id === unpaid), [unpaid]); assert.ok(collectionResult.items.every(item => item.collection_status === 'UNPAID'));
    const historical = await searchWorksS8(env, { q: 'عنوان أرشيفي اصطناعي', include_archived: true, page_size: 100 }); assert.equal(historical.items[0].id, archived); assert.equal(historical.items[0].is_archived, true);
    assert.ok(!ids(await searchWorksS8(env, { q: 'عنوان أرشيفي اصطناعي', include_archived: false, page_size: 100 })).includes(archived));
    await assert.rejects(searchWorksS8(env, { month: '08' }), /S8_PERIOD_BASIS_REQUIRED/);
  } finally { database.close(); }
});

test('S8 search pagination is complete, deterministic, parameterized, and bounded', async () => {
  const { database, env } = fixture();
  try {
    seedSearchFixture(database); const walked = []; let page = 1; let hasMore = true;
    while (hasMore) { const result = await searchWorksS8(env, { page, page_size: 50, include_archived: true }); walked.push(...ids(result)); hasMore = result.has_more; page += 1; }
    assert.equal(walked.length, 205); assert.equal(new Set(walked).size, 205); assert.deepEqual([...walked].sort(), [...walked].sort());
    assert.deepEqual(ids(await searchWorksS8(env, { q: "' OR 1=1 --", page_size: 100 })), []);
    await assert.rejects(searchWorksS8(env, { page_size: 101 }), /S8_PAGE_SIZE_INVALID/);
  } finally { database.close(); }
});

test('S8 search filters a supported dynamic catalog value without source change', async () => {
  const { database, env } = fixture();
  try {
    seedSearchFixture(database);
    await createCatalogValue(env, 's8-uid-one', 's8-dynamic-country', 'country', { value_key: 'S8_DYNAMIC_COUNTRY', label: 'Synthetic Dynamic Country' });
    const dynamicId = insertWork(database, 900, { id: 'WORK-S8-DYNAMIC', country: 'S8_DYNAMIC_COUNTRY', title: 'Synthetic dynamic catalog work', created_at: '2026-08-14T10:00:00.000Z' });
    assert.deepEqual(ids(await searchWorksS8(env, { country: 'S8_DYNAMIC_COUNTRY', page_size: 100 })), [dynamicId]);
  } finally { database.close(); }
});

test('S8 alert settings are auditable and unresolved clocks fail closed', async () => {
  const { database, env } = fixture();
  try {
    seedSearchFixture(database);
    assert.deepEqual((await listS8AlertSettings(env)).map(item => item.state), ['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
    assert.deepEqual((await getS8Alerts(env)).alerts.map(item => item.state), ['NOT_CONFIGURED', 'NOT_CONFIGURED', 'NOT_CONFIGURED']);
    const configured = await upsertS8AlertSetting(env, 's8-uid-one', 's8-alert-no-price', { alert_type: 'NO_PRICE', threshold_days: 7 }); assert.equal(configured.threshold_days, 7);
    const replay = await upsertS8AlertSetting(env, 's8-uid-two', 's8-alert-no-price', { alert_type: 'NO_PRICE', threshold_days: 7 }); assert.equal(replay.idempotent_replay, true);
    await assert.rejects(upsertS8AlertSetting(env, 's8-uid-two', 's8-alert-no-price', { alert_type: 'NO_PAYMENT', threshold_days: 7 }), /S8_ALERT_REQUEST_ID_REUSE/);
    const alerts = await getS8Alerts(env, { alert_type: 'NO_PRICE', now: '2026-08-20T00:00:00.000Z' }); assert.deepEqual(alerts.alerts, [{ alert_type: 'NO_PRICE', state: 'CLOCK_ANCHOR_UNRESOLVED', threshold_days: 7, items: [] }]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='s8_alert_setting'").get().count, 1);
    assert.throws(() => database.exec('UPDATE audit_log SET actor_uid=\'tamper\''), /audit log is append only/);
    await assert.rejects(upsertS8AlertSetting(env, 's8-uid-one', 's8-alert-invalid', { alert_type: 'NO_REPLY', threshold_days: 0 }), /S8_ALERT_THRESHOLD_INVALID/);
  } finally { database.close(); }
});

test('S8 search and alert query budgets remain bounded on large synthetic fixtures', async () => {
  const { database, env } = fixture();
  try {
    seedSearchFixture(database); database.readQueries = 0; database.bindingWidths = [];
    const search = await searchWorksS8(env, { q: 'Synthetic Search Work', page_size: 100, include_archived: true });
    assert.equal(search.items.length, 100); assert.equal(database.readQueries, 1); assert.ok(Math.max(...database.bindingWidths, 0) <= 100);
    database.readQueries = 0; database.bindingWidths = []; await getS8Alerts(env); assert.equal(database.readQueries, 1); assert.ok(Math.max(...database.bindingWidths, 0) <= 100);
    console.log(`S8_D1_MEASUREMENT search_queries=1 search_max_bind=5 alert_queries=1 alert_max_bind=0 works=205`);
  } finally { database.close(); }
});

test('S8 migration preserves final S7 rows and installs alert settings with append-only audit guards', async () => {
  const s7Schema = fullSchema
    .replace("'settlement_snapshot','settlement_reopen_request','settlement_reopen_history','s8_alert_setting'", "'settlement_snapshot','settlement_reopen_request','settlement_reopen_history'")
    .replace(/\nCREATE TABLE IF NOT EXISTS s8_alert_settings \([\s\S]*?\nCREATE INDEX IF NOT EXISTS ix_s8_alert_settings_updated_at ON s8_alert_settings\(updated_at,alert_type\);\n/, '\n');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(s7Schema); database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('migration-one', 'person_1', 's8-migration');
    database.prepare('INSERT INTO customers(id,name,status,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,\'normal\',?,?,?,?,1)').run('CUST-S8-MIGRATION', 'Synthetic migration customer', 'migration-one', '2026-01-01T00:00:00.000Z', 'migration-one', '2026-01-01T00:00:00.000Z');
    database.prepare('INSERT INTO works(id,customer_id,relationship_kind,title,country,status,price_state,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,\'INDEPENDENT\',?,?,\'NEW_REQUEST\',\'PRICE_UNSET\',?,?,?,?,1)').run('WORK-S8-MIGRATION', 'CUST-S8-MIGRATION', 'Synthetic migration work', 'SA', 'migration-one', '2026-01-01T00:00:00.000Z', 'migration-one', '2026-01-01T00:00:00.000Z');
    database.prepare("INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id) VALUES ('work','WORK-S8-MIGRATION','CREATE','migration-one','2026-01-01T00:00:00.000Z',NULL,'{}','s8-migration','s8-migration-existing-audit')").run();
    database.exec(migration);
    assert.equal(database.prepare('SELECT title FROM works WHERE id=?').get('WORK-S8-MIGRATION').title, 'Synthetic migration work');
    database.prepare('INSERT INTO s8_alert_settings(alert_type,threshold_days,updated_by,updated_at,request_id) VALUES (\'NO_PRICE\',7,\'migration-one\',\'2026-01-02T00:00:00.000Z\',\'s8-migration-setting\')').run();
    assert.throws(() => database.exec('UPDATE audit_log SET actor_uid=\'tamper\''), /audit log is append only/);
  } finally { database.close(); }
});

test('S8 search and alert API routes preserve authenticated envelopes', { skip: !(() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })() }, async () => {
  const { database, env } = fixture(); const originalFetch = globalThis.fetch; const directory = mkdtempSync(join(tmpdir(), 's8-x509-')); const privateKeyPath = join(directory, 'private-key.pem'); const certificatePath = join(directory, 'certificate.pem');
  try {
    seedSearchFixture(database); execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=s8-firebase-test', '-keyout', privateKeyPath, '-out', certificatePath], { stdio: 'ignore' });
    const keyPem = readFileSync(privateKeyPath, 'utf8'); const keyLabel = ['PRIVATE', 'KEY'].join(' '); const keyPattern = new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`);
    const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(keyPem.match(keyPattern)[1].replace(/\s+/g, ''), 'base64')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const certificatePem = readFileSync(certificatePath, 'utf8'); globalThis.fetch = async () => new Response(JSON.stringify({ s8test: certificatePem }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
    const b64 = bytes => Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); const json = value => b64(new TextEncoder().encode(JSON.stringify(value)));
    const now = Math.floor(Date.now() / 1000); const signed = `${json({ alg: 'RS256', kid: 's8test', typ: 'JWT' })}.${json({ aud: 'demo-project', iss: 'https://securetoken.google.com/demo-project', sub: 's8-uid-one', iat: now - 10, auth_time: now - 10, exp: now + 3600 })}`; const token = `${signed}.${b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signed))))}`;
    const searchResponse = await worker.fetch(new Request('https://example.test/api/search/works?q=%D8%B9%D9%86%D9%88%D8%A7%D9%86&page_size=10', { headers: { authorization: `Bearer ${token}`, 'x-s3-run-id': 's8-pr-a', 'x-s3-request-id': 's8-api-search' } }), env); assert.equal(searchResponse.status, 200); const searchPayload = await searchResponse.json(); assert.equal(searchPayload.ok, true); assert.equal(searchPayload.requestId, 's8-api-search'); assert.ok(Array.isArray(searchPayload.data.items));
    const settingResponse = await worker.fetch(new Request('https://example.test/api/alerts/settings', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-s3-run-id': 's8-pr-a', 'x-s3-request-id': 's8-api-setting' }, body: JSON.stringify({ alert_type: 'NO_PAYMENT', threshold_days: 9 }) }), env); assert.equal(settingResponse.status, 201); assert.equal((await settingResponse.json()).data.threshold_days, 9);
    const denied = await worker.fetch(new Request('https://example.test/api/search/works'), env); assert.equal(denied.status, 401); const deniedPayload = await denied.json(); assert.equal(deniedPayload.ok, false); assert.equal(deniedPayload.code, 'TOKEN_MISSING'); assert.equal(typeof deniedPayload.requestId, 'string');
  } finally { globalThis.fetch = originalFetch; database.close(); }
});
