import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listAccountAdminAccounts, changeAccountEmail, sendAccountPasswordReset, uatResetPolicy } from '../../src/worker/src/index.js';

const schema = readFileSync(fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url)), 'utf8');
class D1Statement { constructor(db, sql) { this.db = db; this.sql = sql.replace(/\?(\d+)/g, '?'); this.values = []; } bind(...values) { this.values = values; return this; } first() { return this.db.prepare(this.sql).get(...this.values) || null; } all() { return { results: this.db.prepare(this.sql).all(...this.values) }; } }
class D1Database { constructor(db) { this.db = db; } prepare(sql) { return new D1Statement(this.db, sql); } batch(statements) { this.db.exec('BEGIN IMMEDIATE'); try { const out = statements.map(statement => { const result = this.db.prepare(statement.sql).run(...statement.values); return { meta: { changes: Number(result.changes) } }; }); this.db.exec('COMMIT'); return Promise.resolve(out); } catch (error) { this.db.exec('ROLLBACK'); return Promise.reject(error); } } }
function fixture() { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON;'); db.exec(schema); db.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one','person_1','uat'); db.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two','person_2','uat'); return { db, env: { DB: new D1Database(db), RUN_MARKER: 'uat', FIREBASE_PROJECT_ID: 'demo-project', FIREBASE_ADMIN_ACCESS_TOKEN: 'test-access-token', TEST_CONTROLS: 'enabled' } }; }

test('D-025 account admin uses trusted provider email, role targets, audit old/new email, and session cutoff', async () => {
  const { db, env } = fixture(); const originalFetch = globalThis.fetch; const emails = new Map([['uid-one','khaled@example.test'],['uid-two','waleed@example.test']]); const calls = [];
  globalThis.fetch = async (url, options) => { const body = JSON.parse(options.body); calls.push({ url: String(url), body, authorization: options.headers.Authorization }); if (String(url).endsWith('/accounts:lookup')) { const uid = body.localId[0]; return Response.json({ users: [{ localId: uid, email: emails.get(uid), disabled: false }] }); } if (String(url).endsWith('/accounts:update')) { emails.set(body.localId, body.email); return Response.json({ localId: body.localId, email: body.email }); } if (String(url).endsWith('/accounts:sendOobCode')) return Response.json({ email: body.email }); return new Response('{}', { status: 404 }); };
  try {
    const accounts = await listAccountAdminAccounts(env, 'uid-one');
    assert.deepEqual(accounts.map(row => [row.role,row.display_name,row.email]), [['person_1','خالد','khaled@example.test'],['person_2','وليد','waleed@example.test']]);
    assert.equal(Object.hasOwn(accounts[0], 'uid'), false);
    await assert.rejects(listAccountAdminAccounts(env, 'uid-two'), /ACCOUNT_ADMIN_FORBIDDEN/);
    const reset = await sendAccountPasswordReset(env, 'uid-one', 'uat-reset', 'person_2');
    assert.equal(reset.email, 'waleed@example.test');
    const resetCall = calls.find(call => call.url.endsWith('/accounts:sendOobCode'));
    assert.equal(resetCall.body.email, 'waleed@example.test'); assert.equal(Object.hasOwn(resetCall.body, 'password'), false);
    const changed = await changeAccountEmail(env, 'uid-one', 'uat-email', 'person_2', { email: 'waleed.new@example.test' });
    assert.equal(changed.sessions_revoked, true);
    const updateCall = calls.find(call => call.url.endsWith('/accounts:update'));
    assert.equal(updateCall.body.localId, 'uid-two'); assert.equal(updateCall.body.email, 'waleed.new@example.test'); assert.ok(Number(updateCall.body.validSince) > 0);
    assert.ok(calls.every(call => call.url.includes('/v1/projects/demo-project/')));
    assert.ok(calls.every(call => call.authorization === 'Bearer test-access-token'));
    const audit = db.prepare("SELECT before_json,after_json FROM account_admin_audit WHERE action='CHANGE_EMAIL'").get();
    assert.equal(JSON.parse(audit.before_json).email, 'waleed@example.test'); assert.equal(JSON.parse(audit.after_json).email, 'waleed.new@example.test'); assert.equal(JSON.parse(audit.after_json).sessions_revoked, true);
    assert.ok(db.prepare("SELECT auth_valid_since FROM app_users WHERE uid='uid-two'").get().auth_valid_since > 0);
    assert.throws(() => db.exec('DELETE FROM account_admin_audit'), /append only/);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('UAT reset remains fail-closed outside explicit UAT', () => {
  assert.equal(uatResetPolicy({ APP_ENVIRONMENT: 'production', ALLOW_UAT_RESET: 'true', UAT_RESET_NONCE: '1234567890123456' }).allowed, false);
  assert.equal(uatResetPolicy({ APP_ENVIRONMENT: 'uat', ALLOW_UAT_RESET: 'true', UAT_RESET_NONCE: 'short' }).allowed, false);
  assert.equal(uatResetPolicy({ APP_ENVIRONMENT: 'uat', ALLOW_UAT_RESET: 'true', UAT_RESET_NONCE: '1234567890123456' }).allowed, true);
});
