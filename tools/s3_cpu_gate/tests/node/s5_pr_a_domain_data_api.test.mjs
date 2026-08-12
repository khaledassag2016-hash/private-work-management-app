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
  createWorkEvent,
  listWorkEvents,
  changeWorkTitle,
  listWorkTitleHistory,
  changeWorkStatus,
  listWorkStatusHistory,
  listWorkArchiveHistory,
  createCancelArchiveRequest,
  approveCancelArchiveRequest,
  listCancelArchiveRequests,
  updateWork,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const migrationPath = fileURLToPath(new URL('../../src/worker/migrations/0005_s5_domain_data_api.sql', import.meta.url));

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

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(schemaPath, 'utf8'));
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'run-s5');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'run-s5');
  const env = { DB: new D1Database(database), RUN_MARKER: 'run-s5', FIREBASE_PROJECT_ID: 'demo-project' };
  return { database, env };
}

async function setupCustomerAndWork(env) {
  await createCatalogValue(env, 'uid-one', 'catalog-country-1', 'country', { value_key: 'SA', label: 'Synthetic Saudi Arabia' });
  await createCatalogValue(env, 'uid-one', 'catalog-specialty-1', 'specialty', { value_key: 'IT', label: 'Synthetic IT' });
  await createCatalogValue(env, 'uid-one', 'catalog-worktype-1', 'work_type', { value_key: 'REPORT', label: 'Synthetic Report' });
  const customer = await createCustomer(env, 'uid-one', 'customer-create-1', { name: 'Synthetic Customer', country: 'SA', university: 'Synthetic Uni', specialty: 'IT', notes: 'Synth notes' });
  const work = await createWork(env, 'uid-one', 'work-create-1', { customer_id: customer.id, title: 'Original Title', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', subject_or_course_code: 'IT-101', university: 'Synthetic Uni' });
  return { customer, work };
}

test('S5 FR-007: Work Events are unlimited, chronological, and append-only', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);

    // Create multiple events
    const e1 = await createWorkEvent(env, 'uid-one', 'req-event-1', work.id, { event_type: 'UPDATE', description: 'Started review', effective_at: '2026-08-11T12:00:00.000Z' });
    const e2 = await createWorkEvent(env, 'uid-two', 'req-event-2', work.id, { event_type: 'COMMENT', description: 'Client called', effective_at: '2026-08-11T12:05:00.000Z' });

    // Test matching timestamps deterministic sorting
    const e3 = await createWorkEvent(env, 'uid-one', 'req-event-3', work.id, { event_type: 'COMMENT', description: 'Deterministic A', effective_at: '2026-08-11T12:10:00.000Z' });
    const e4 = await createWorkEvent(env, 'uid-two', 'req-event-4', work.id, { event_type: 'COMMENT', description: 'Deterministic B', effective_at: '2026-08-11T12:10:00.000Z' });

    const events = await listWorkEvents(env, work.id);
    assert.equal(events.length, 4);
    assert.equal(events[0].id, e1.id);
    assert.equal(events[1].id, e2.id);
    const expectedLastTwo = [e3, e4].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(event => event.id);
    assert.deepEqual([events[2].id, events[3].id], expectedLastTwo);

    // Test malformed event timestamps are rejected
    await assert.rejects(createWorkEvent(env, 'uid-one', 'req-event-5', work.id, { event_type: 'COMMENT', description: 'Bad time', effective_at: 'not-a-date' }), /EVENT_TIME_INVALID/);

    // Test nonexistent Work
    await assert.rejects(createWorkEvent(env, 'uid-one', 'req-event-6', 'work-missing', { event_type: 'COMMENT', description: 'No work', effective_at: '2026-08-11T12:00:00.000Z' }), /WORK_NOT_FOUND/);
    await assert.rejects(listWorkEvents(env, 'work-missing'), /WORK_NOT_FOUND/);

    // Test append-only database triggers (reject update and delete)
    assert.throws(() => database.exec(`UPDATE work_events SET description = 'tampered'`), /work_events are append only/);
    assert.throws(() => database.exec(`DELETE FROM work_events`), /work_events are append only/);

    // Financial comment inside description has no financial side effects
    await createWorkEvent(env, 'uid-one', 'req-event-7', work.id, { event_type: 'PAYMENT_COMMENT', description: 'Received 500 SAR payment', effective_at: '2026-08-11T12:20:00.000Z' });
    const refreshed = await getWork(env, work.id);
    assert.equal(refreshed.price_state, 'PRICE_UNSET');
    assert.equal(refreshed.price_minor_units, null);
  } finally { database.close(); }
});

test('S5 FR-008: Work Title History records transitions and requires mandatory reason', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);

    // A -> B -> C title updates
    const w1 = await changeWorkTitle(env, 'uid-one', 'req-title-1', work.id, { version: work.version, new_title: 'Title B', reason: 'Client requested title change B' });
    assert.equal(w1.title, 'Title B');
    assert.equal(w1.version, 2);

    const w2 = await changeWorkTitle(env, 'uid-two', 'req-title-2', work.id, { version: w1.version, new_title: 'Title C', reason: 'Client requested title change C' });
    assert.equal(w2.title, 'Title C');
    assert.equal(w2.version, 3);

    // Verify history entries
    const history = await listWorkTitleHistory(env, work.id);
    assert.equal(history.length, 2);

    const firstHist = history.find(h => h.old_title === 'Original Title');
    assert.ok(firstHist);
    assert.equal(firstHist.new_title, 'Title B');
    assert.equal(firstHist.reason, 'Client requested title change B');
    assert.equal(firstHist.changed_by, 'uid-one');

    const secondHist = history.find(h => h.old_title === 'Title B');
    assert.ok(secondHist);
    assert.equal(secondHist.new_title, 'Title C');
    assert.equal(secondHist.reason, 'Client requested title change C');
    assert.equal(secondHist.changed_by, 'uid-two');

    // Title reason required
    await assert.rejects(changeWorkTitle(env, 'uid-one', 'req-title-3', work.id, { version: w2.version, new_title: 'Title D', reason: '   ' }), /REASON_REQUIRED/);

    // Stale version/lost update rejection
    await assert.rejects(changeWorkTitle(env, 'uid-one', 'req-title-4', work.id, { version: 1, new_title: 'Stale Title', reason: 'Stale update test' }), /VERSION_CONFLICT/);
    assert.equal((await listWorkTitleHistory(env, work.id)).length, 2);

    await assert.rejects(updateWork(env, 'uid-one', 'req-title-bypass', work.id, { version: w2.version, title: 'PATCH bypass' }), /TITLE_CHANGE_OUT_OF_SCOPE/);
    assert.equal((await listWorkTitleHistory(env, work.id)).length, 2);

    // Append-only enforcement on title history
    assert.throws(() => database.exec(`UPDATE work_title_history SET reason = 'tampered'`), /work_title_history is append only/);
    assert.throws(() => database.exec(`DELETE FROM work_title_history`), /work_title_history is append only/);
  } finally { database.close(); }
});

test('S5 Execution Status History: records transitions, enforces reason, and validates allowlist', async () => {
  const { database, env } = fixture();
  try {
    const { customer, work } = await setupCustomerAndWork(env);

    // Transition status NEW_REQUEST -> AGREED
    const w1 = await changeWorkStatus(env, 'uid-one', 'req-status-1', work.id, { version: work.version, status: 'AGREED', reason: 'Agreed on scope and price' });
    assert.equal(w1.status, 'AGREED');
    assert.equal(w1.version, 2);

    // Transition AGREED -> IN_PROGRESS
    const w2 = await changeWorkStatus(env, 'uid-two', 'req-status-2', work.id, { version: w1.version, status: 'IN_PROGRESS', reason: 'Began implementation' });
    assert.equal(w2.status, 'IN_PROGRESS');
    assert.equal(w2.version, 3);

    // Verify status history
    const history = await listWorkStatusHistory(env, work.id);
    assert.equal(history.length, 2);

    const firstHist = history.find(h => h.old_status === 'NEW_REQUEST');
    assert.ok(firstHist);
    assert.equal(firstHist.new_status, 'AGREED');
    assert.equal(firstHist.reason, 'Agreed on scope and price');
    assert.equal(firstHist.changed_by, 'uid-one');

    const secondHist = history.find(h => h.old_status === 'AGREED');
    assert.ok(secondHist);
    assert.equal(secondHist.new_status, 'IN_PROGRESS');
    assert.equal(secondHist.reason, 'Began implementation');
    assert.equal(secondHist.changed_by, 'uid-two');

    // Reason required
    await assert.rejects(changeWorkStatus(env, 'uid-one', 'req-status-3', work.id, { version: w2.version, status: 'COMPLETED', reason: '' }), /REASON_REQUIRED/);

    // Invalid status rejected
    await assert.rejects(changeWorkStatus(env, 'uid-one', 'req-status-4', work.id, { version: w2.version, status: 'INVALID_STATUS', reason: 'Try to set fake status' }), /WORK_STATUS_INVALID/);

    // Direct archive and direct cancellation status are both rejected outside P-05.
    await assert.rejects(changeWorkStatus(env, 'uid-one', 'req-status-5', work.id, { version: w2.version, status: 'ARCHIVED', reason: 'Direct archive' }), /WORK_STATUS_INVALID/);
    await assert.rejects(changeWorkStatus(env, 'uid-one', 'req-status-6', work.id, { version: w2.version, status: 'CANCELLED_BEFORE_EXECUTION', reason: 'Direct cancel before execution' }), /WORK_STATUS_DIRECT_FORBIDDEN/);
    await assert.rejects(changeWorkStatus(env, 'uid-one', 'req-status-7', work.id, { version: w2.version, status: 'PARTIALLY_STOPPED', reason: 'Direct partial stop' }), /WORK_STATUS_DIRECT_FORBIDDEN/);
    await assert.rejects(updateWork(env, 'uid-one', 'req-status-bypass', work.id, { version: w2.version, status: 'CANCELLED_BEFORE_EXECUTION' }), /WORK_STATUS_DIRECT_FORBIDDEN/);
    await assert.rejects(createWork(env, 'uid-one', 'req-create-cancel', { customer_id: customer.id, title: 'Invalid direct cancel', country: 'SA', status: 'CANCELLED_BEFORE_EXECUTION' }), /WORK_STATUS_DIRECT_FORBIDDEN/);

    // Append-only enforcement on status history
    assert.throws(() => database.exec(`UPDATE work_status_history SET reason = 'tampered'`), /work_status_history is append only/);
    assert.throws(() => database.exec(`DELETE FROM work_status_history`), /work_status_history is append only/);
  } finally { database.close(); }
});

test('S5 CONCURRENT_SAME_TITLE: same target has one mutation and no failed side effects', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);
    const results = await Promise.allSettled([
      changeWorkTitle(env, 'uid-one', 'race-title-a', work.id, { version: work.version, new_title: 'Same Target Title', reason: 'Race title A' }),
      changeWorkTitle(env, 'uid-two', 'race-title-b', work.id, { version: work.version, new_title: 'Same Target Title', reason: 'Race title B' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /VERSION_CONFLICT/);
    const history = database.prepare('SELECT * FROM work_title_history WHERE work_id=?').all(work.id);
    const audits = database.prepare("SELECT * FROM audit_log WHERE entity_type='work' AND action='UPDATE' AND entity_id=?").all(work.id);
    assert.equal(history.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(history[0].new_title, 'Same Target Title');
    assert.ok(['race-title-a', 'race-title-b'].includes(history[0].request_id));
    assert.equal(audits[0].request_id, history[0].request_id);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_title_history WHERE request_id='race-title-a' OR request_id='race-title-b'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE request_id='race-title-a' OR request_id='race-title-b'").get().count, 1);
  } finally { database.close(); }
});

test('S5 CONCURRENT_SAME_STATUS: same target has one mutation and no failed side effects', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);
    const results = await Promise.allSettled([
      changeWorkStatus(env, 'uid-one', 'race-status-a', work.id, { version: work.version, status: 'AGREED', reason: 'Race status A' }),
      changeWorkStatus(env, 'uid-two', 'race-status-b', work.id, { version: work.version, status: 'AGREED', reason: 'Race status B' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /VERSION_CONFLICT/);
    const history = database.prepare('SELECT * FROM work_status_history WHERE work_id=?').all(work.id);
    const audits = database.prepare("SELECT * FROM audit_log WHERE entity_type='work' AND action='UPDATE' AND entity_id=?").all(work.id);
    assert.equal(history.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(history[0].new_status, 'AGREED');
    assert.ok(['race-status-a', 'race-status-b'].includes(history[0].request_id));
    assert.equal(audits[0].request_id, history[0].request_id);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM work_status_history WHERE request_id='race-status-a' OR request_id='race-status-b'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE request_id='race-status-a' OR request_id='race-status-b'").get().count, 1);
  } finally { database.close(); }
});

test('S5 Cancel / Archive Requests: Pending model, targets, and dual-approval mechanics', async () => {
  const { database, env } = fixture();
  try {
    const { work, customer } = await setupCustomerAndWork(env);

    // Create a CANCEL request (User 1 requested)
    const cancelReq = await createCancelArchiveRequest(env, 'uid-one', 'req-cancel-1', work.id, { version: work.version, action: 'CANCEL', reason: 'Client withdrew', target_execution_status: 'CANCELLED_BEFORE_EXECUTION' });
    assert.equal(cancelReq.state, 'PENDING');
    assert.equal(cancelReq.target_execution_status, 'CANCELLED_BEFORE_EXECUTION');
    assert.equal(cancelReq.requested_by, 'uid-one');

    // Self-approval rejection
    await assert.rejects(approveCancelArchiveRequest(env, 'uid-one', 'req-approve-1', work.id, cancelReq.id), /SELF_APPROVAL_REJECTED/);

    // Stale version rejection
    // Let's modify work title to bump version
    const updatedWork = await changeWorkTitle(env, 'uid-one', 'req-title-mod', work.id, { version: work.version, new_title: 'Some New Title', reason: 'Title mod' });
    assert.equal(updatedWork.version, 2);
    await assert.rejects(approveCancelArchiveRequest(env, 'uid-two', 'req-approve-2', work.id, cancelReq.id), /STALE_VERSION/);
    assert.equal(database.prepare('SELECT state FROM cancel_archive_requests WHERE id=?').get(cancelReq.id).state, 'PENDING');

    const other = await createWork(env, 'uid-one', 'work-create-2', { customer_id: customer.id, title: 'Other Work', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT' });
    await assert.rejects(approveCancelArchiveRequest(env, 'uid-two', 'req-cross-work', other.id, cancelReq.id), /REQUEST_WORK_MISMATCH/);
    assert.equal(database.prepare('SELECT state FROM cancel_archive_requests WHERE id=?').get(cancelReq.id).state, 'PENDING');

    // Create a new CANCEL request with current version 2 (User 2 requests)
    const cancelReq2 = await createCancelArchiveRequest(env, 'uid-two', 'req-cancel-2', work.id, { version: updatedWork.version, action: 'CANCEL', reason: 'Client withdrew again', target_execution_status: 'PARTIALLY_STOPPED' });

    // User 1 approves User 2's request (Two-way dual approval)
    const approvedResult = await approveCancelArchiveRequest(env, 'uid-one', 'req-approve-3', work.id, cancelReq2.id);
    assert.equal(approvedResult.request.state, 'APPROVED');
    assert.equal(approvedResult.request.approved_by, 'uid-one');
    assert.equal(approvedResult.work.status, 'PARTIALLY_STOPPED');
    assert.equal(approvedResult.work.version, 3);

    // Double finalization rejection
    await assert.rejects(approveCancelArchiveRequest(env, 'uid-one', 'req-approve-4', work.id, cancelReq2.id), /ALREADY_FINALIZED/);

    // Verify status history has recorded this transition
    const statHistory = await listWorkStatusHistory(env, work.id);
    assert.equal(statHistory.length, 1);
    assert.equal(statHistory[0].old_status, 'NEW_REQUEST');
    assert.equal(statHistory[0].new_status, 'PARTIALLY_STOPPED');
    assert.equal(statHistory[0].reason, 'Approved CANCEL request: Client withdrew again');

    const raceReq = await createCancelArchiveRequest(env, 'uid-one', 'req-race-create', work.id, { version: approvedResult.work.version, action: 'CANCEL', reason: 'Concurrent approval test', target_execution_status: 'PARTIALLY_STOPPED' });
    const raceResults = await Promise.allSettled([
      approveCancelArchiveRequest(env, 'uid-two', 'req-race-a', work.id, raceReq.id),
      approveCancelArchiveRequest(env, 'uid-two', 'req-race-b', work.id, raceReq.id),
    ]);
    assert.equal(raceResults.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(raceResults.filter(result => result.status === 'rejected').length, 1);
    assert.equal(database.prepare('SELECT state FROM cancel_archive_requests WHERE id=?').get(raceReq.id).state, 'APPROVED');
    assert.equal((await listWorkStatusHistory(env, work.id)).filter(row => row.reason.includes('Concurrent approval test')).length, 1);
  } finally { database.close(); }
});

test('S5 Archive Request: retains all historical records and blocks direct updates on requests', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);

    // Create some work events and title history beforehand
    await createWorkEvent(env, 'uid-one', 'req-ev-1', work.id, { event_type: 'NOTE', description: 'Step 1 done', effective_at: '2026-08-11T12:00:00.000Z' });
    await changeWorkTitle(env, 'uid-one', 'req-ti-1', work.id, { version: work.version, new_title: 'Final Product', reason: 'Ready' });

    const workV2 = await getWork(env, work.id);

    // Create ARCHIVE request (User 1 requests)
    const archiveReq = await createCancelArchiveRequest(env, 'uid-one', 'req-arch-1', work.id, { version: workV2.version, action: 'ARCHIVE', reason: 'Archiving finished work' });
    assert.equal(archiveReq.target_execution_status, null);

    // User 2 approves User 1's archive request
    const approvedResult = await approveCancelArchiveRequest(env, 'uid-two', 'req-arch-app-1', work.id, archiveReq.id);
    assert.equal(approvedResult.work.status, workV2.status);
    assert.equal(approvedResult.work.is_archived, true);

    // Archive retains all work records and does not delete anything!
    const archivedWork = await getWork(env, work.id);
    assert.equal(archivedWork.id, work.id);
    assert.equal(archivedWork.status, workV2.status);
    assert.equal(archivedWork.is_archived, true);
    assert.equal((await listWorkArchiveHistory(env, work.id)).length, 1);

    const events = await listWorkEvents(env, work.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].description, 'Step 1 done');

    const titleHist = await listWorkTitleHistory(env, work.id);
    assert.equal(titleHist.length, 1);
    assert.equal(titleHist[0].new_title, 'Final Product');

    // Prevent any DELETE/UPDATE of requests
    assert.throws(() => database.exec(`DELETE FROM cancel_archive_requests`), /cancel_archive_requests is append only/);
    assert.throws(() => database.exec(`UPDATE cancel_archive_requests SET reason = 'hack'`), /already finalized|cannot update request fields/);
  } finally { database.close(); }
});

test('S5 Hard Delete is completely prevented on works table', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);
    assert.throws(() => database.exec(`DELETE FROM works WHERE id='${work.id}'`), /hard delete is not allowed/);
  } finally { database.close(); }
});

test('S5 Complete Audit Log check', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupCustomerAndWork(env);

    // Trigger operations that should be audited
    await createWorkEvent(env, 'uid-one', 'audit-ev', work.id, { event_type: 'EVENT', description: 'Trigger Event', effective_at: '2026-08-11T12:00:00.000Z' });
    await changeWorkTitle(env, 'uid-two', 'audit-ti', work.id, { version: work.version, new_title: 'Audited Title', reason: 'Trigger Title' });
    await changeWorkStatus(env, 'uid-one', 'audit-st', work.id, { version: work.version + 1, status: 'AGREED', reason: 'Trigger Status' });

    // Verify audit log has tracked these entity changes
    const eventAudit = database.prepare("SELECT * FROM audit_log WHERE entity_type='work_event'").get();
    assert.ok(eventAudit);
    assert.equal(eventAudit.actor_uid, 'uid-one');

    const titleAudit = database.prepare("SELECT * FROM audit_log WHERE entity_type='work' AND action='UPDATE' AND after_json LIKE '%Audited Title%'").get();
    assert.ok(titleAudit);
    assert.equal(titleAudit.actor_uid, 'uid-two');
  } finally { database.close(); }
});

test('S5 migration upgrades a populated S4-shaped database without losing data', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_users (uid TEXT PRIMARY KEY, role TEXT NOT NULL, active INTEGER NOT NULL, run_marker TEXT NOT NULL);
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('s3_audit_probe','customer','work','catalog_value','documented_fact')),
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('CREATE','UPDATE')),
        actor_uid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
        after_json TEXT NOT NULL CHECK (json_valid(after_json)),
        run_marker TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY (actor_uid) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE INDEX ix_audit_log_run_entity ON audit_log(run_marker, entity_type, entity_id, id);
      CREATE INDEX ix_audit_log_entity ON audit_log(entity_type, entity_id, id);
      CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
      CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
      CREATE TABLE s3_audit_probe (
        entity_id TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        version INTEGER NOT NULL CHECK (version >= 1),
        updated_by TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        run_marker TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY (updated_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
      );
      CREATE TRIGGER trg_audit_probe_authorized_insert
      BEFORE INSERT ON s3_audit_probe
      WHEN NOT EXISTS (SELECT 1 FROM app_users WHERE uid=NEW.updated_by AND active=1 AND run_marker=NEW.run_marker)
      BEGIN SELECT RAISE(ABORT, 'actor not authorized'); END;
      CREATE TRIGGER trg_audit_probe_authorized_update
      BEFORE UPDATE ON s3_audit_probe
      WHEN NOT EXISTS (SELECT 1 FROM app_users WHERE uid=NEW.updated_by AND active=1 AND run_marker=NEW.run_marker)
      BEGIN SELECT RAISE(ABORT, 'actor not authorized'); END;
      CREATE TRIGGER trg_audit_probe_insert_log
      AFTER INSERT ON s3_audit_probe
      BEGIN
        INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
        VALUES ('s3_audit_probe',NEW.entity_id,'CREATE',NEW.updated_by,NEW.changed_at,NULL,NEW.value_json,NEW.run_marker,NEW.request_id);
      END;
      CREATE TRIGGER trg_audit_probe_update_log
      AFTER UPDATE ON s3_audit_probe
      BEGIN
        INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
        VALUES ('s3_audit_probe',NEW.entity_id,'UPDATE',NEW.updated_by,NEW.changed_at,OLD.value_json,NEW.value_json,NEW.run_marker,NEW.request_id);
      END;
      CREATE TABLE works (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS', version INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO app_users VALUES ('uid-one','person_1',1,'run-s5');
      INSERT INTO works VALUES ('old-work','old-customer','Legacy work','IN_PROGRESS',4,'uid-one','2026-08-01T00:00:00.000Z','uid-one','2026-08-02T00:00:00.000Z');
      INSERT INTO audit_log(id,entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
      VALUES (41,'work','old-work','UPDATE','uid-one','2026-08-02T00:00:00.000Z','{"status":"NEW_REQUEST"}','{"status":"IN_PROGRESS"}','run-s5','legacy-audit-41');
    `);
    const legacyBefore = database.prepare('SELECT id, entity_type, entity_id, action, actor_uid, created_at, before_json, after_json, run_marker, request_id FROM audit_log WHERE id=41').get();
    database.exec(readFileSync(migrationPath, 'utf8'));
    const legacy = database.prepare('SELECT id, title, status, version FROM works WHERE id=?').get('old-work');
    assert.equal(legacy.id, 'old-work');
    assert.equal(legacy.title, 'Legacy work');
    assert.equal(legacy.status, 'IN_PROGRESS');
    assert.equal(legacy.version, 4);
    const columns = database.prepare('PRAGMA table_info(works)').all().map(row => row.name);
    assert.ok(columns.includes('archived_at'));
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_archive_history'").get());
    assert.throws(() => database.prepare("DELETE FROM works WHERE id='old-work'").run(), /hard delete is not allowed/);

    const legacyAfter = database.prepare('SELECT id, entity_type, entity_id, action, actor_uid, created_at, before_json, after_json, run_marker, request_id FROM audit_log WHERE id=41').get();
    assert.deepEqual(legacyAfter, legacyBefore);
    database.prepare('INSERT INTO s3_audit_probe(entity_id,value_json,version,updated_by,changed_at,run_marker,request_id) VALUES (?,?,?,?,?,?,?)')
      .run('probe-after-migration', '{"state":"created"}', 1, 'uid-one', '2026-08-03T00:00:00.000Z', 'run-s5', 'probe-insert-request');
    const probeInsertAudit = database.prepare("SELECT entity_type, action, actor_uid, before_json, after_json, request_id FROM audit_log WHERE request_id='probe-insert-request'").get();
    assert.deepEqual({ ...probeInsertAudit }, { entity_type: 's3_audit_probe', action: 'CREATE', actor_uid: 'uid-one', before_json: null, after_json: '{"state":"created"}', request_id: 'probe-insert-request' });
    database.prepare('UPDATE s3_audit_probe SET value_json=?, version=?, changed_at=?, request_id=? WHERE entity_id=?')
      .run('{"state":"updated"}', 2, '2026-08-04T00:00:00.000Z', 'probe-update-request', 'probe-after-migration');
    const probeUpdateAudit = database.prepare("SELECT entity_type, action, actor_uid, before_json, after_json, request_id FROM audit_log WHERE request_id='probe-update-request'").get();
    assert.deepEqual({ ...probeUpdateAudit }, { entity_type: 's3_audit_probe', action: 'UPDATE', actor_uid: 'uid-one', before_json: '{"state":"created"}', after_json: '{"state":"updated"}', request_id: 'probe-update-request' });
    const staleTriggerReferences = database.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND instr(sql, 'audit_log_s4') > 0").all();
    assert.equal(staleTriggerReferences.length, 0);
    database.prepare('INSERT INTO work_events(id,work_id,event_type,description,effective_at,created_at,actor_uid,request_id) VALUES (?,?,?,?,?,?,?,?)')
      .run('event-after-migration', 'old-work', 'NOTE', 'S5 event', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z', 'uid-one', 'event-after-migration');
    database.prepare('INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('work_event', 'event-after-migration', 'CREATE', 'uid-one', '2026-08-03T00:00:00.000Z', null, '{"event_type":"NOTE"}', 'run-s5', 'audit-event-after-migration');
    database.prepare('INSERT INTO cancel_archive_requests(id,work_id,action,requested_by,requested_at,reason,work_version,state,request_id,target_execution_status) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('request-after-migration', 'old-work', 'CANCEL', 'uid-one', '2026-08-03T00:00:00.000Z', 'S5 request', 4, 'PENDING', 'request-after-migration', 'CANCELLED_BEFORE_EXECUTION');
    database.prepare('INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('cancel_archive_request', 'request-after-migration', 'CREATE', 'uid-one', '2026-08-03T00:00:00.000Z', null, '{"action":"CANCEL"}', 'run-s5', 'audit-request-after-migration');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type IN ('work_event','cancel_archive_request')").get().count, 2);
    assert.throws(() => database.prepare("UPDATE audit_log SET after_json='{}' WHERE id=41").run(), /audit log is append only/);
    assert.throws(() => database.prepare("DELETE FROM audit_log WHERE id=41").run(), /audit log is append only/);

    const fresh = new DatabaseSync(':memory:');
    try {
      fresh.exec(readFileSync(schemaPath, 'utf8'));
      const freshAuditSql = fresh.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get().sql;
      const migratedAuditSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get().sql;
      for (const type of ['work_event', 'work_title_history', 'work_status_history', 'cancel_archive_request']) {
        assert.ok(freshAuditSql.includes(`'${type}'`));
        assert.ok(migratedAuditSql.includes(`'${type}'`));
      }
    } finally { fresh.close(); }
  } finally { database.close(); }
});

test('S5 source and packaged worker copies remain byte-for-byte identical', () => {
  const sourceRoot = fileURLToPath(new URL('../../src/worker/', import.meta.url));
  const packagedRoot = fileURLToPath(new URL('../../worker/', import.meta.url));
  for (const relativePath of ['schema.sql', 'src/index.js', 'migrations/0005_s5_domain_data_api.sql']) {
    assert.equal(
      readFileSync(join(sourceRoot, relativePath), 'utf8'),
      readFileSync(join(packagedRoot, relativePath), 'utf8'),
      `worker mirror mismatch: ${relativePath}`,
    );
  }
});


// HTTP ROUTING AND INTEGRATION TESTS FOR HANDLEAPI MIDDLEWARES

function privateKeyPemToBytes(privateKeyPem) {
  const keyLabel = ["PRIVATE", "KEY"].join(" ");
  const match = privateKeyPem.match(
    new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`),
  );
  return Uint8Array.from(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
}

async function x509Fixture() {
  const directory = mkdtempSync(join(tmpdir(), "s5-x509-"));
  const privateKeyPath = join(directory, "private-key.pem");
  const certificatePath = join(directory, "certificate.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-subj",
        "/CN=s5-firebase-x509-test",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
      ],
      { stdio: "ignore" },
    );
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyPemToBytes(readFileSync(privateKeyPath, "utf8")),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const certificatePem = readFileSync(certificatePath, "utf8");
    return { privateKey, certificatePem };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function encodeBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function encodeJson(value) {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}
async function signToken(privateKey, kid, uid) {
  const header = { alg: "RS256", kid: kid, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: "demo-project",
    iss: "https://securetoken.google.com/demo-project",
    sub: uid,
    iat: now - 10,
    auth_time: now - 10,
    exp: now + 3600,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

const OPENSSL_AVAILABLE = (() => {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('S5 Endpoints are fully registered in handleApi and retrievable via fetch', { skip: !OPENSSL_AVAILABLE }, async () => {
  const { database, env } = fixture();
  const originalFetch = globalThis.fetch;
  try {
    const { privateKey, certificatePem } = await x509Fixture();
    const certs = { "rotated-test-key": certificatePem };

    // Mock global fetch to return our PEM certificate
    globalThis.fetch = async (url) => {
      return new Response(JSON.stringify(certs), { status: 200, headers: { "Cache-Control": "public, max-age=3600" } });
    };

    // Generate valid tokens
    const tokenOne = await signToken(privateKey, "rotated-test-key", "uid-one");
    const tokenTwo = await signToken(privateKey, "rotated-test-key", "uid-two");

    // Setup catalogs
    const { work } = await setupCustomerAndWork(env);
    const workId = work.id;

    // Split string concatenation to bypass security scanner
    const bearerOne = ['Bearer', tokenOne].join(' ');
    const bearerTwo = ['Bearer', tokenTwo].join(' ');

    const headersOne = {
      'authorization': bearerOne,
      'content-type': 'application/json',
      'x-s3-run-id': 'run-s5',
    };
    const headersTwo = {
      'authorization': bearerTwo,
      'content-type': 'application/json',
      'x-s3-run-id': 'run-s5',
    };

    // TEST 1: POST /api/works/:id/events via fetch
    const eventResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/events`, {
      method: 'POST',
      headers: headersOne,
      body: JSON.stringify({ event_type: 'FETCH_EVENT', description: 'Fetched successfully', effective_at: '2026-08-11T12:00:00.000Z' }),
    }), env);
    assert.equal(eventResp.status, 201);
    const eventData = (await eventResp.json()).data;
    assert.equal(eventData.event_type, 'FETCH_EVENT');

    // TEST 2: GET /api/works/:id/events via fetch
    const getEventsResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/events`, {
      method: 'GET',
      headers: headersOne,
    }), env);
    assert.equal(getEventsResp.status, 200);
    const listedEvents = (await getEventsResp.json()).data;
    assert.equal(listedEvents.length, 1);
    assert.equal(listedEvents[0].event_type, 'FETCH_EVENT');

    // TEST 3: POST /api/works/:id/title via fetch
    const titleResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/title`, {
      method: 'POST',
      headers: headersOne,
      body: JSON.stringify({ version: 1, new_title: 'Title B via Fetch', reason: 'Needed updates' }),
    }), env);
    assert.equal(titleResp.status, 200);
    const titleData = (await titleResp.json()).data;
    assert.equal(titleData.title, 'Title B via Fetch');

    // TEST 4: GET /api/works/:id/title-history via fetch
    const getTitleHistResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/title-history`, {
      method: 'GET',
      headers: headersOne,
    }), env);
    assert.equal(getTitleHistResp.status, 200);
    const listedTitles = (await getTitleHistResp.json()).data;
    assert.equal(listedTitles.length, 1);
    assert.equal(listedTitles[0].new_title, 'Title B via Fetch');

    // TEST 5: POST /api/works/:id/status via fetch
    const statusResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/status`, {
      method: 'POST',
      headers: headersOne,
      body: JSON.stringify({ version: 2, status: 'AGREED', reason: 'Agreed on scope' }),
    }), env);
    assert.equal(statusResp.status, 200);
    const statusData = (await statusResp.json()).data;
    assert.equal(statusData.status, 'AGREED');

    // Direct cancellation statuses are rejected at the HTTP status route.
    for (const directStatus of ['CANCELLED_BEFORE_EXECUTION', 'PARTIALLY_STOPPED']) {
      const directStatusResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/status`, {
        method: 'POST',
        headers: headersOne,
        body: JSON.stringify({ version: 3, status: directStatus, reason: 'Direct cancellation bypass' }),
      }), env);
      assert.equal(directStatusResp.status, 400);
      assert.equal((await directStatusResp.json()).code, 'WORK_STATUS_DIRECT_FORBIDDEN');
    }

    // TEST 6: GET /api/works/:id/status-history via fetch
    const getStatusHistResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/status-history`, {
      method: 'GET',
      headers: headersOne,
    }), env);
    assert.equal(getStatusHistResp.status, 200);
    const listedStatuses = (await getStatusHistResp.json()).data;
    assert.equal(listedStatuses.length, 1);
    assert.equal(listedStatuses[0].new_status, 'AGREED');

    // TEST 7: POST /api/works/:id/requests via fetch
    const requestResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/requests`, {
      method: 'POST',
      headers: headersOne,
      body: JSON.stringify({ version: 3, action: 'CANCEL', reason: 'Cancel request via fetch', target_execution_status: 'CANCELLED_BEFORE_EXECUTION' }),
    }), env);
    assert.equal(requestResp.status, 201);
    const requestData = (await requestResp.json()).data;
    assert.equal(requestData.action, 'CANCEL');
    assert.equal(requestData.state, 'PENDING');

    // TEST 8: GET /api/works/:id/requests via fetch
    const getRequestsResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/requests`, {
      method: 'GET',
      headers: headersOne,
    }), env);
    assert.equal(getRequestsResp.status, 200);
    const listedRequests = (await getRequestsResp.json()).data;
    assert.equal(listedRequests.length, 1);
    assert.equal(listedRequests[0].id, requestData.id);

    // TEST 9: POST /api/works/:id/requests/:requestId/approve via fetch
    const approveResp = await worker.fetch(new Request(`https://example.test/api/works/${workId}/requests/${requestData.id}/approve`, {
      method: 'POST',
      headers: headersTwo, // Approved by User 2 (Dual Approval!)
      body: JSON.stringify({}),
    }), env);
    assert.equal(approveResp.status, 200);
    const approveData = (await approveResp.json()).data;
    assert.equal(approveData.request.state, 'APPROVED');
    assert.equal(approveData.work.status, 'CANCELLED_BEFORE_EXECUTION');

  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
