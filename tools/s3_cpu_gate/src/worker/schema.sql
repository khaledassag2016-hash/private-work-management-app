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

CREATE TABLE IF NOT EXISTS audit_log (
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
CREATE INDEX IF NOT EXISTS ix_audit_log_run_entity ON audit_log(run_marker, entity_type, entity_id, id);
CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log(entity_type, entity_id, id);
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;

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

CREATE TABLE IF NOT EXISTS catalog_values (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('country','specialty','work_type')),
  value_key TEXT NOT NULL,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_catalog_kind_key ON catalog_values(kind, value_key);
CREATE INDEX IF NOT EXISTS ix_catalog_kind_active ON catalog_values(kind, active, label);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  contact TEXT,
  country TEXT,
  university TEXT,
  specialty TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','needs_caution','frequent_delay','partial_payment','unpaid','blocked','dispute','discontinued')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (created_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS ix_customers_country_specialty ON customers(country, specialty);

CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  parent_work_id TEXT,
  relationship_kind TEXT NOT NULL DEFAULT 'INDEPENDENT' CHECK (relationship_kind IN ('INDEPENDENT','CHILD')),
  title TEXT NOT NULL,
  work_type_key TEXT,
  specialty_key TEXT,
  subject_or_course_code TEXT,
  country TEXT NOT NULL,
  university TEXT,
  status TEXT NOT NULL DEFAULT 'NEW_REQUEST' CHECK (status IN ('NEW_REQUEST','REQUIREMENT_REVIEW','NEEDS_PRICING','WAITING_CLIENT_RESPONSE','NEEDS_FOLLOW_UP','AGREED','IN_PROGRESS','WAITING_CUSTOMER_INFO','WAITING_REVIEW','REVISION_REQUIRED','PAUSED','CANCELLED_BEFORE_EXECUTION','PARTIALLY_STOPPED','COMPLETED','DELIVERED')),
  description TEXT,
  quantity INTEGER CHECK (quantity IS NULL OR quantity >= 1),
  price_state TEXT NOT NULL DEFAULT 'PRICE_UNSET' CHECK (price_state IN ('PRICE_UNSET','PRICE_ZERO')),
  price_minor_units INTEGER CHECK (price_minor_units IS NULL OR price_minor_units = 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at TEXT,
  archived_by TEXT,
  archive_request_id TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (parent_work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (updated_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((relationship_kind = 'INDEPENDENT' AND parent_work_id IS NULL) OR (relationship_kind = 'CHILD' AND parent_work_id IS NOT NULL)),
  CHECK ((price_state = 'PRICE_UNSET' AND price_minor_units IS NULL) OR (price_state = 'PRICE_ZERO' AND price_minor_units = 0))
);
CREATE INDEX IF NOT EXISTS ix_works_customer ON works(customer_id, created_at);
CREATE INDEX IF NOT EXISTS ix_works_parent ON works(parent_work_id);
CREATE INDEX IF NOT EXISTS ix_works_lookup ON works(work_type_key, specialty_key, country, university);

CREATE TABLE IF NOT EXISTS documented_facts (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL,
  work_id TEXT,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('NON_PAYMENT','DELAY','BLOCKED','DISPUTE')),
  source_ref TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  happened_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_documented_facts_customer ON documented_facts(customer_id, happened_at, id);
CREATE INDEX IF NOT EXISTS ix_documented_facts_work ON documented_facts(work_id, happened_at, id);

CREATE VIEW IF NOT EXISTS customer_warning_projection AS
SELECT
  id AS fact_id,
  customer_id,
  work_id,
  fact_type AS warning_type,
  source_ref,
  happened_at,
  details_json
FROM documented_facts;

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
CREATE TRIGGER IF NOT EXISTS trg_work_events_no_update
BEFORE UPDATE ON work_events
BEGIN SELECT RAISE(ABORT, 'work_events are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_events_no_delete
BEFORE DELETE ON work_events
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
CREATE TRIGGER IF NOT EXISTS trg_work_title_history_no_update
BEFORE UPDATE ON work_title_history
BEGIN SELECT RAISE(ABORT, 'work_title_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_title_history_no_delete
BEFORE DELETE ON work_title_history
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
CREATE TRIGGER IF NOT EXISTS trg_work_status_history_no_update
BEFORE UPDATE ON work_status_history
BEGIN SELECT RAISE(ABORT, 'work_status_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_status_history_no_delete
BEFORE DELETE ON work_status_history
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
CREATE TRIGGER IF NOT EXISTS trg_work_archive_history_no_update
BEFORE UPDATE ON work_archive_history
BEGIN SELECT RAISE(ABORT, 'work_archive_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_work_archive_history_no_delete
BEFORE DELETE ON work_archive_history
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
CREATE TRIGGER IF NOT EXISTS trg_cancel_archive_requests_no_delete
BEFORE DELETE ON cancel_archive_requests
BEGIN SELECT RAISE(ABORT, 'cancel_archive_requests is append only'); END;

CREATE TRIGGER IF NOT EXISTS trg_cancel_archive_requests_no_update
BEFORE UPDATE OF id, work_id, action, requested_by, requested_at, reason, work_version, target_execution_status ON cancel_archive_requests
BEGIN SELECT RAISE(ABORT, 'cannot update request fields'); END;

CREATE TRIGGER IF NOT EXISTS trg_cancel_archive_requests_no_double_approve
BEFORE UPDATE ON cancel_archive_requests
WHEN OLD.state = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'already finalized'); END;

CREATE TRIGGER IF NOT EXISTS trg_works_no_delete
BEFORE DELETE ON works
BEGIN SELECT RAISE(ABORT, 'hard delete is not allowed'); END;
