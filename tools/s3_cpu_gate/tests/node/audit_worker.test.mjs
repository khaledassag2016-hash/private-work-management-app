import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyAuditMutation } from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));

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
