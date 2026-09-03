import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import worker, { listAccountAdminAccounts, changeAccountEmail, sendAccountPasswordReset, uatResetPolicy } from '../../src/worker/src/index.js';

const schema = readFileSync(fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url)), 'utf8');
class D1Statement { constructor(db, sql) { this.db = db; this.sql = sql.replace(/\?(\d+)/g, '?'); this.values = []; } bind(...values) { this.values = values; return this; } first() { return this.db.prepare(this.sql).get(...this.values) || null; } all() { return { results: this.db.prepare(this.sql).all(...this.values) }; } }
class D1Database { constructor(db) { this.db = db; } prepare(sql) { return new D1Statement(this.db, sql); } batch(statements) { this.db.exec('BEGIN IMMEDIATE'); try { const out = statements.map(statement => { const result = this.db.prepare(statement.sql).run(...statement.values); return { meta: { changes: Number(result.changes) } }; }); this.db.exec('COMMIT'); return Promise.resolve(out); } catch (error) { this.db.exec('ROLLBACK'); return Promise.reject(error); } } }

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(schema);
  db.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'uat');
  db.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'uat');
  return { db, env: { DB: new D1Database(db), RUN_MARKER: 'uat', FIREBASE_ADMIN_ACCESS_TOKEN: 'service-token', FIREBASE_WEB_API_KEY: 'web-key' } };
}

test('UAT contract: only Khaled can administer the two existing accounts and passwords never enter the request', async () => {
  const { db, env } = fixture(); const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return new Response('{}', { status: 200 }); };
  try {
    assert.deepEqual((await listAccountAdminAccounts(env, 'uid-one')).map(row => row.role), ['person_1', 'person_2']);
    await assert.rejects(listAccountAdminAccounts(env, 'uid-two'), /ACCOUNT_ADMIN_FORBIDDEN/);
    await changeAccountEmail(env, 'uid-one', 'uat-admin-email', 'uid-two', { email: 'waleed@example.test' });
    await sendAccountPasswordReset(env, 'uid-one', 'uat-admin-reset', 'uid-two', { email: 'waleed@example.test' });
    assert.equal(calls[0].body.localId, 'uid-two'); assert.equal(calls[0].body.email, 'waleed@example.test');
    assert.equal(calls[1].body.requestType, 'PASSWORD_RESET'); assert.equal(Object.hasOwn(calls[1].body, 'password'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_admin_audit').get().count, 2);
    assert.throws(() => db.exec("DELETE FROM account_admin_audit"), /append only/);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('UAT reset safeguard is exact-environment and fail-closed', () => {
  assert.equal(uatResetPolicy({ APP_ENVIRONMENT: 'production', ALLOW_UAT_RESET: 'true', UAT_RESET_NONCE: '1234567890123456' }).allowed, false);
  assert.equal(uatResetPolicy({ APP_ENVIRONMENT: 'uat', ALLOW_UAT_RESET: 'false', UAT_RESET_NONCE: '1234567890123456' }).allowed, false);
  assert.equal(uatResetPolicy({ APP_ENVIRONMENT: 'uat', ALLOW_UAT_RESET: 'true', UAT_RESET_NONCE: '1234567890123456' }).allowed, true);
});
