-- S5 PR-A upgrade from the approved S4 schema.
-- Apply this migration once before deploying the S5 schema-backed Worker.
-- The three ALTER statements are intentionally additive; the migration smoke
-- test applies them to a populated S4 database and verifies data retention.

DROP TRIGGER IF EXISTS trg_audit_log_no_update;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
DROP INDEX IF EXISTS ix_audit_log_run_entity;
DROP INDEX IF EXISTS ix_audit_log_entity;
ALTER TABLE audit_log RENAME TO audit_log_s4;
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('s3_audit_probe','customer','work','catalog_value','documented_fact','work_event','work_title_history','work_status_history','cancel_archive_request')),
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
INSERT INTO audit_log(id, entity_type, entity_id, action, actor_uid, created_at, before_json, after_json, run_marker, request_id)
SELECT id, entity_type, entity_id, action, actor_uid, created_at, before_json, after_json, run_marker, request_id
FROM audit_log_s4;
DROP TABLE audit_log_s4;
CREATE INDEX IF NOT EXISTS ix_audit_log_run_entity ON audit_log(run_marker, entity_type, entity_id, id);
CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log(entity_type, entity_id, id);
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;

ALTER TABLE works ADD COLUMN archived_at TEXT;
ALTER TABLE works ADD COLUMN archived_by TEXT;
ALTER TABLE works ADD COLUMN archive_request_id TEXT;

CREATE TABLE IF NOT EXISTS work_events (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_uid TEXT NOT NULL,
  request_id TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (actor_uid) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS trg_work_events_no_update BEFORE UPDATE ON work_events
BEGIN SELECT RAISE(ABORT, 'work_events are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_events_no_delete BEFORE DELETE ON work_events
BEGIN SELECT RAISE(ABORT, 'work_events are append only'); END;

CREATE TABLE IF NOT EXISTS work_title_history (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  old_title TEXT NOT NULL,
  new_title TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  request_id TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changed_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS trg_work_title_history_no_update BEFORE UPDATE ON work_title_history
BEGIN SELECT RAISE(ABORT, 'work_title_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_title_history_no_delete BEFORE DELETE ON work_title_history
BEGIN SELECT RAISE(ABORT, 'work_title_history is append only'); END;

CREATE TABLE IF NOT EXISTS work_status_history (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  request_id TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (changed_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS trg_work_status_history_no_update BEFORE UPDATE ON work_status_history
BEGIN SELECT RAISE(ABORT, 'work_status_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_status_history_no_delete BEFORE DELETE ON work_status_history
BEGIN SELECT RAISE(ABORT, 'work_status_history is append only'); END;

CREATE TABLE IF NOT EXISTS work_archive_history (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  archived_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_id TEXT NOT NULL,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (archived_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS trg_work_archive_history_no_update BEFORE UPDATE ON work_archive_history
BEGIN SELECT RAISE(ABORT, 'work_archive_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_archive_history_no_delete BEFORE DELETE ON work_archive_history
BEGIN SELECT RAISE(ABORT, 'work_archive_history is append only'); END;

CREATE TABLE IF NOT EXISTS cancel_archive_requests (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CANCEL', 'ARCHIVE')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  work_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'APPROVED')),
  approved_by TEXT,
  approved_at TEXT,
  approval_request_id TEXT,
  request_id TEXT NOT NULL,
  target_execution_status TEXT CHECK (
    (action = 'CANCEL' AND target_execution_status IN ('CANCELLED_BEFORE_EXECUTION', 'PARTIALLY_STOPPED')) OR
    (action = 'ARCHIVE' AND target_execution_status IS NULL)
  ),
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS trg_cancel_archive_requests_no_delete BEFORE DELETE ON cancel_archive_requests
BEGIN SELECT RAISE(ABORT, 'cancel_archive_requests is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_cancel_archive_requests_no_update
BEFORE UPDATE OF id, work_id, action, requested_by, requested_at, reason, work_version, target_execution_status ON cancel_archive_requests
BEGIN SELECT RAISE(ABORT, 'cannot update request fields'); END;
CREATE TRIGGER IF NOT EXISTS trg_cancel_archive_requests_no_double_approve
BEFORE UPDATE ON cancel_archive_requests WHEN OLD.state = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'already finalized'); END;

CREATE TRIGGER IF NOT EXISTS trg_works_no_delete BEFORE DELETE ON works
BEGIN SELECT RAISE(ABORT, 'hard delete is not allowed'); END;
