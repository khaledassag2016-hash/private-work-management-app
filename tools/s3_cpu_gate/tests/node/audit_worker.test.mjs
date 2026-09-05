import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import worker, { applyAuditMutation, handleApi } from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const sourceWorkerRoot = fileURLToPath(new URL('../../src/worker/', import.meta.url));
const packagedWorkerRoot = fileURLToPath(new URL('../../worker/', import.meta.url));

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.parameterMap = [];
    this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; });
    this.values = [];
  }
  bind(...values) {
    this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values;
    return this;
  }
  first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }
  all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }
  prepare(sql) {
    return new D1Statement(this.database, sql);
  }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const prepared = this.database.prepare(statement.sql);
        if (/^\s*SELECT\b/i.test(statement.sql)) {
          return { success: true, results: prepared.all(...statement.values), meta: { changes: 0 } };
        }
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
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'run-test');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'run-test');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'run-test' } };
}

function insertAudit(database, id, action, actorUid, before, after) {
  database.prepare('INSERT INTO audit_log(id,entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'work', `work-${id}`, action, actorUid, `2026-09-02T00:00:${String(id).padStart(2, '0')}.000Z`, before === null ? null : JSON.stringify(before), JSON.stringify(after), 'run-test', `audit-api-${id}`);
}

test('authorized operational mutations produce immutable who/when/before/after evidence', async () => {
  const { database, env } = fixture();
  try {
    const created = await applyAuditMutation(env, 'uid-one', 'request-0001', 'synthetic-before');
    assert.equal(created.action, 'CREATE');
    assert.equal(created.actorUid, 'uid-one');
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(created.before, null);
    assert.deepEqual(created.after, { value: 'synthetic-before' });

    const updated = await applyAuditMutation(env, 'uid-two', 'request-0002', 'synthetic-after');
    assert.equal(updated.action, 'UPDATE');
    assert.equal(updated.actorUid, 'uid-two');
    assert.match(updated.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(updated.before, { value: 'synthetic-before' });
    assert.deepEqual(updated.after, { value: 'synthetic-after' });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, 2);
  } finally {
    database.close();
  }
});

test('database rejects unauthorized mutation and preserves the maximum-two invariant', async () => {
  const { database, env } = fixture();
  try {
    await assert.rejects(
      applyAuditMutation(env, 'uid-unregistered', 'request-0003', 'synthetic-denied'),
      /actor not authorized/
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, 0);
    assert.throws(
      () => database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-three', 'person_1', 'run-test'),
      /maximum two active users/
    );
  } finally {
    database.close();
  }
});

test('database rejects audit UPDATE and DELETE tampering', async () => {
  const { database, env } = fixture();
  try {
    await applyAuditMutation(env, 'uid-one', 'request-0004', 'synthetic-evidence');
    assert.throws(() => database.exec("UPDATE audit_log SET action='UPDATE'"), /audit log is append only/);
    assert.throws(() => database.exec('DELETE FROM audit_log'), /audit log is append only/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, 1);
  } finally {
    database.close();
  }
});

test('GET /api/audit is authenticated, read-only, bounded, deterministic, and JSON-normalized', async () => {
  const { database, env } = fixture();
  try {
    insertAudit(database, 1, 'CREATE', 'uid-one', null, { name: 'A' });
    insertAudit(database, 2, 'UPDATE', 'uid-two', { name: 'A' }, { name: 'B' });
    for (let id = 3; id <= 101; id += 1) insertAudit(database, id, 'CREATE', 'uid-one', null, { index: id });

    const missing = await worker.fetch(new Request('https://example.test/api/audit'), env);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).code, 'TOKEN_MISSING');

    const response = await handleApi(new Request('https://example.test/api/audit?limit=1000'), env, 'audit-api-read', '', { uid: 'uid-one', role: 'person_1' });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.requestId, 'audit-api-read');
    assert.equal(payload.data.length, 100);
    assert.deepEqual(payload.data.map(row => row.id), [...Array(100).keys()].map(index => 101 - index));
    assert.equal(payload.data[0].before, null);
    assert.deepEqual(payload.data[0].after, { index: 101 });
    const update = payload.data.find(row => row.id === 2);
    assert.deepEqual({ action: update.action, actor_uid: update.actor_uid, actor_role: update.actor_role, before: update.before, after: update.after }, { action: 'UPDATE', actor_uid: 'uid-two', actor_role: 'person_2', before: { name: 'A' }, after: { name: 'B' } });

    const defaultLimit = await handleApi(new Request('https://example.test/api/audit'), env, 'audit-api-default', '', { uid: 'uid-one', role: 'person_1' });
    assert.equal((await defaultLimit.json()).data.length, 50);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await assert.rejects(
        handleApi(new Request('https://example.test/api/audit', { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' || method === 'PATCH' ? '{}' : undefined }), env, `audit-api-${method.toLowerCase()}`, '', { uid: 'uid-one', role: 'person_1' }),
        error => error.code === 'METHOD_NOT_ALLOWED' && error.status === 405,
        method,
      );
    }
    assert.throws(() => database.exec("UPDATE audit_log SET action='UPDATE'"), /audit log is append only/);
    assert.throws(() => database.exec('DELETE FROM audit_log'), /audit log is append only/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_log').get().count, 101);
  } finally {
    database.close();
  }
});

test('audit UI and packaged Worker mirror expose only the required read-only surface', () => {
  const app = readFileSync(join(sourceWorkerRoot, 'assets/app.js'), 'utf8');
  const styles = readFileSync(join(sourceWorkerRoot, 'assets/styles.css'), 'utf8');
  assert.match(app, /\['audit', 'سجل التدقيق'\]/);
  assert.match(app, /\/api\/audit\?limit=50/);
  assert.match(app, /data-audit-log/);
  assert.match(app, /actor_role/);
  assert.match(app, /auditValueMarkup\(row\.before, row\)/);
  assert.match(app, /auditValueMarkup\(row\.after, row\)/);
  assert.match(app, /requested_by: 'مقدم الطلب'/);
  assert.match(app, /approved_by: 'معتمد الطلب'/);
  assert.match(app, /person_1_bps: 'نسبة الطرف الأول'/);
  assert.match(app, /event_type: 'نوع المتابعة'/);
  assert.match(app, /amount_halalas: 'المبلغ'/);
  assert.match(app, /fee_halalas: 'الرسوم'/);
  assert.match(app, /aggregate_amount_halalas: 'إجمالي الاشتراك'/);
  assert.match(app, /recorded_by: 'سُجلت بواسطة'/);
  assert.doesNotMatch(app, /endsWith\('_halalas'\).*قيمة مالية|return 'قيمة مالية'/);
  assert.match(app, /return 'الحساب الآخر المصرح'/);
  assert.match(styles, /\.audit-values/);
  assert.doesNotMatch(app, /auditValueLabel\(value\).*JSON\.stringify/);
  assert.doesNotMatch(app, /data-audit-id=/);
  assert.doesNotMatch(app, /auditValueMarkup\(row\.(before|after)\)\b/);
  assert.doesNotMatch(styles, /\.audit-json/);
  for (const relativePath of ['src/index.js', 'assets/app.js', 'assets/styles.css']) {
    assert.equal(readFileSync(join(sourceWorkerRoot, relativePath), 'utf8'), readFileSync(join(packagedWorkerRoot, relativePath), 'utf8'), `worker mirror mismatch: ${relativePath}`);
  }
});

test('audit transfer rendering uses distinct business labels and hides raw identifiers', () => {
  const app = readFileSync(join(sourceWorkerRoot, 'assets/app.js'), 'utf8');
  const executable = app.replace(/authenticateExistingSession\(\);\s*$/, '');
  const documentStub = { querySelector() { return null; } };
  const windowStub = { __PRIVATE_WORK_APP_CONFIG__: {}, __PRIVATE_WORK_APP_TEST__: null };
  const { auditValueMarkup } = new Function('document', 'window', `${executable}\nreturn { auditValueMarkup };`)(documentStub, windowStub);
  const rawUid = 'uid-one-secret';
  const rendered = auditValueMarkup({
    id: 'transfer-secret-id',
    request_id: 'request-secret-id',
    version: 7,
    value_key: 'internal-value-key',
    amount_halalas: 10000,
    fee_halalas: 250,
    from_party: 'person_1',
    to_party: 'person_2',
    recorded_by: rawUid,
  }, { actor_uid: rawUid, actor_role: 'person_1' });

  assert.match(rendered, /<dt>المبلغ<\/dt><dd>100 ريال<\/dd>/);
  assert.match(rendered, /<dt>الرسوم<\/dt><dd>2\.50 ريال<\/dd>/);
  assert.match(rendered, /<dt>سُجلت بواسطة<\/dt><dd>خالد<\/dd>/);
  assert.doesNotMatch(rendered, /uid-one-secret|transfer-secret-id|request-secret-id|internal-value-key|version/);
});

test('certificate cache is shared across separate Worker isolates in one data-center cache', async () => {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  const entries = new Map();
  globalThis.caches = { default: {
    async match(request) { const response = entries.get(request.url); return response?.clone(); },
    async put(request, response) { entries.set(request.url, response.clone()); },
    async delete(request) { return entries.delete(request.url); },
  } };
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ testKey: 'test-certificate' }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
  };
  try {
    const moduleUrl = new URL('../../src/worker/src/index.js', import.meta.url).href;
    const isolateOne = await import(`${moduleUrl}?isolate=one`);
    const isolateTwo = await import(`${moduleUrl}?isolate=two`);
    const env = { CERT_URL_OVERRIDE: 'https://certificates.example.test/firebase-x509' };
    assert.equal((await isolateOne.getCertificates(env)).state, 'miss');
    assert.equal((await isolateTwo.getCertificates(env)).state, 'hit');
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});
