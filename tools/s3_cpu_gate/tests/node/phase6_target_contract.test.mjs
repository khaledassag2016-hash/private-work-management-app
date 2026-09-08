import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createInterPartyTransfer,
  createSubscriptionHistory,
  getWorkFinancials,
  listAccountAdminAccounts,
  listAuditLog,
  listInterPartyTransfers,
} from '../../src/worker/src/index.js';

const schema = readFileSync(fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url)), 'utf8');

class D1Statement {
  constructor(db, sql) { this.db = db; this.parameterMap = []; this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; }); this.values = []; }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; return this; }
  first() { return this.db.prepare(this.sql).get(...this.values) || null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Statement(this.db, sql); }
  batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const result = this.db.prepare(statement.sql).run(...statement.values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      this.db.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.db.exec('ROLLBACK');
      return Promise.reject(error);
    }
  }
}
function fixture(target = true) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(schema);
  db.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'phase6');
  db.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'phase6');
  const env = {
    DB: new D1Database(db),
    RUN_MARKER: 'phase6',
    FIREBASE_PROJECT_ID: 'demo-project',
    FIREBASE_ADMIN_ACCESS_TOKEN: 'synthetic-access-token',
    TEST_CONTROLS: 'enabled',
    ...(target ? { PHASE6_ROLE_MAPPING: 'D028_TARGET' } : {}),
  };
  return { db, env };
}
function seedWork(db) {
  db.prepare('INSERT INTO customers(id,name,status,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,?,?,1)')
    .run('phase6-customer', 'Synthetic Phase 6 Customer', 'normal', 'uid-one', '2026-09-08T00:00:00.000Z', 'uid-one', '2026-09-08T00:00:00.000Z');
  db.prepare("INSERT INTO works(id,customer_id,relationship_kind,title,country,status,price_state,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,'IN_PROGRESS','PRICE_UNSET',?,?,?,?,1)")
    .run('phase6-work', 'phase6-customer', 'INDEPENDENT', 'Synthetic Phase 6 Work', 'SA', 'uid-one', '2026-09-08T00:00:00.000Z', 'uid-one', '2026-09-08T00:00:00.000Z');
}

test('D-028 target identity maps Waleed to person_1 30% and Khalid supervisor to person_2 70%', async () => {
  const { db, env } = fixture(true);
  const originalFetch = globalThis.fetch;
  const emails = new Map([['uid-one', 'waleed@example.test'], ['uid-two', 'khalid@example.test']]);
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/accounts:lookup')) {
      const uid = body.localId[0];
      return Response.json({ users: [{ localId: uid, email: emails.get(uid), disabled: false }] });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    seedWork(db);
    const financials = await getWorkFinancials(env, 'phase6-work');
    assert.deepEqual(financials.ratio, { person_1_bps: 3000, person_2_bps: 7000, source: 'DEFAULT_D028_TARGET' });

    const accounts = await listAccountAdminAccounts(env, 'uid-two');
    assert.deepEqual(accounts.map(row => [row.role, row.display_name, row.email]), [
      ['person_1', 'وليد', 'waleed@example.test'],
      ['person_2', 'خالد', 'khalid@example.test'],
    ]);
    await assert.rejects(listAccountAdminAccounts(env, 'uid-one'), /ACCOUNT_ADMIN_FORBIDDEN/);

    await listAuditLog(env, 'uid-two', new URL('https://example.test/api/audit?limit=10'));
    await assert.rejects(listAuditLog(env, 'uid-one', new URL('https://example.test/api/audit?limit=10')), /AUDIT_FORBIDDEN/);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test('D-029 target transfer is Waleed-only and fixed person_1 to person_2 with no direction input required', async () => {
  const { db, env } = fixture(true);
  try {
    const transfer = await createInterPartyTransfer(env, 'uid-one', 'phase6-transfer', {
      amount_riyals: '125.00',
      fee_riyals: '1.00',
      effective_at: '2026-09-08T10:00:00.000Z',
    });
    assert.equal(transfer.from_party, 'person_1');
    assert.equal(transfer.to_party, 'person_2');
    assert.equal(transfer.fee_payer, 'person_1');
    assert.equal((await listInterPartyTransfers(env)).length, 1);

    await assert.rejects(createInterPartyTransfer(env, 'uid-two', 'phase6-transfer-khalid', {
      amount_riyals: '10.00',
      effective_at: '2026-09-08T11:00:00.000Z',
    }), /TRANSFER_FORBIDDEN/);

    await assert.rejects(createInterPartyTransfer(env, 'uid-one', 'phase6-transfer-reverse', {
      amount_riyals: '10.00',
      effective_at: '2026-09-08T12:00:00.000Z',
      from_party: 'person_2',
      to_party: 'person_1',
    }), /TRANSFER_DIRECTION_INVALID/);
  } finally { db.close(); }
});

test('Phase 6 target subscription mutation remains Khalid-only while historical CURRENT mode stays unchanged', async () => {
  const target = fixture(true);
  try {
    const row = await createSubscriptionHistory(target.env, 'uid-two', 'phase6-subscription', {
      aggregate_amount_riyals: '136.50',
      effective_at: '2026-09-08T09:00:00.000Z',
    });
    assert.equal(row.paid_by_uid, 'uid-two');
    await assert.rejects(createSubscriptionHistory(target.env, 'uid-one', 'phase6-subscription-waleed', {
      aggregate_amount_riyals: '136.50',
      effective_at: '2026-09-08T09:30:00.000Z',
    }), /SUBSCRIPTION_PAYER_MUST_BE_PERSON_2/);
  } finally { target.db.close(); }

  const current = fixture(false);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/accounts:lookup')) {
      const uid = body.localId[0];
      return Response.json({ users: [{ localId: uid, email: uid === 'uid-one' ? 'khalid@example.test' : 'waleed@example.test', disabled: false }] });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const accounts = await listAccountAdminAccounts(current.env, 'uid-one');
    assert.deepEqual(accounts.map(row => row.display_name), ['خالد', 'وليد']);
  } finally {
    globalThis.fetch = originalFetch;
    current.db.close();
  }
});
