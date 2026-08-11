PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS app_users (
  uid TEXT PRIMARY KEY NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('person_1','person_2')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  run_marker TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_users_active_role ON app_users(role) WHERE active = 1;
CREATE TRIGGER IF NOT EXISTS trg_app_users_max_two_active_insert
BEFORE INSERT ON app_users WHEN NEW.active = 1 AND (SELECT COUNT(*) FROM app_users WHERE active = 1) >= 2
BEGIN SELECT RAISE(ABORT, 'maximum two active users'); END;
CREATE TRIGGER IF NOT EXISTS trg_app_users_max_two_active_update
BEFORE UPDATE OF active ON app_users WHEN NEW.active = 1 AND OLD.active = 0 AND (SELECT COUNT(*) FROM app_users WHERE active = 1) >= 2
BEGIN SELECT RAISE(ABORT, 'maximum two active users'); END;

CREATE TABLE IF NOT EXISTS s3_audit_probe (
  entity_id TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  run_marker TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (updated_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type = 's3_audit_probe'),
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

CREATE INDEX IF NOT EXISTS ix_audit_log_run_entity ON audit_log(run_marker, entity_type, entity_id, id);

CREATE TRIGGER IF NOT EXISTS trg_audit_probe_authorized_insert
BEFORE INSERT ON s3_audit_probe
WHEN NOT EXISTS (
  SELECT 1 FROM app_users
  WHERE uid = NEW.updated_by AND active = 1 AND run_marker = NEW.run_marker
)
BEGIN SELECT RAISE(ABORT, 'actor not authorized'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_probe_authorized_update
BEFORE UPDATE ON s3_audit_probe
WHEN NOT EXISTS (
  SELECT 1 FROM app_users
  WHERE uid = NEW.updated_by AND active = 1 AND run_marker = NEW.run_marker
)
BEGIN SELECT RAISE(ABORT, 'actor not authorized'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_probe_insert_log
AFTER INSERT ON s3_audit_probe
BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
  VALUES ('s3_audit_probe',NEW.entity_id,'CREATE',NEW.updated_by,NEW.changed_at,NULL,NEW.value_json,NEW.run_marker,NEW.request_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_probe_update_log
AFTER UPDATE ON s3_audit_probe
BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
  VALUES ('s3_audit_probe',NEW.entity_id,'UPDATE',NEW.updated_by,NEW.changed_at,OLD.value_json,NEW.value_json,NEW.run_marker,NEW.request_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
