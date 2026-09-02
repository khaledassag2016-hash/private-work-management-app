import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import worker, { handleApi } from '../../src/worker/src/index.js';

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
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; return this; }
  first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
}

class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
}

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(schemaPath, 'utf8'));
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'audit-api');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'audit-api');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'audit-api', FIREBASE_PROJECT_ID: 'demo-project' } };
}

function insertAudit(database, id, action, actorUid, before, after) {
  database.prepare('INSERT INTO audit_log(id,entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'work', `work-${id}`, action, actorUid, `2026-09-02T00:00:${String(id).padStart(2, '0')}.000Z`, before === null ? null : JSON.stringify(before), JSON.stringify(after), 'audit-api', `audit-api-${id}`);
}

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
  assert.match(app, /auditValueLabel\(row\.before\)/);
  assert.match(app, /auditValueLabel\(row\.after\)/);
  assert.match(styles, /\.audit-json/);
  for (const relativePath of ['src/index.js', 'assets/app.js', 'assets/styles.css']) {
    assert.equal(readFileSync(join(sourceWorkerRoot, relativePath), 'utf8'), readFileSync(join(packagedWorkerRoot, relativePath), 'utf8'), `worker mirror mismatch: ${relativePath}`);
  }
});
