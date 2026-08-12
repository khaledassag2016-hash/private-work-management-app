-- S7 PR-A additive migration from the final S6 schema.
-- Adds only client payments, governed reversal requests/reversals, indexes, and audit types.
-- All money is INTEGER halalas; there is no multi-Work allocation or settlement scope here.

DROP TRIGGER IF EXISTS trg_audit_probe_insert_log;
DROP TRIGGER IF EXISTS trg_audit_probe_update_log;
DROP TRIGGER IF EXISTS trg_audit_log_no_update;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
DROP INDEX IF EXISTS ix_audit_log_run_entity;
DROP INDEX IF EXISTS ix_audit_log_entity;
ALTER TABLE audit_log RENAME TO audit_log_s6;
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('s3_audit_probe','customer','work','catalog_value','documented_fact','work_event','work_title_history','work_status_history','cancel_archive_request','price_change_request','price_movement','ratio_change_request','ratio_history','client_payment','payment_reversal_request','payment_reversal')),
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
FROM audit_log_s6;
DROP TABLE audit_log_s6;
CREATE INDEX IF NOT EXISTS ix_audit_log_run_entity ON audit_log(run_marker, entity_type, entity_id, id);
CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log(entity_type, entity_id, id);
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append only'); END;
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

CREATE TABLE IF NOT EXISTS client_payments (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas BETWEEN 1 AND 9007199254740991),
  effective_at TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  note TEXT,
  received_by TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  work_version INTEGER NOT NULL CHECK (work_version >= 1),
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (received_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_client_payments_work_effective ON client_payments(work_id, effective_at, id);
CREATE TRIGGER IF NOT EXISTS trg_client_payments_no_update
BEFORE UPDATE ON client_payments
BEGIN SELECT RAISE(ABORT, 'client_payments are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_client_payments_no_delete
BEFORE DELETE ON client_payments
BEGIN SELECT RAISE(ABORT, 'client_payments are append only'); END;

CREATE TABLE IF NOT EXISTS payment_reversal_requests (
  id TEXT PRIMARY KEY NOT NULL,
  payment_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  work_version INTEGER NOT NULL CHECK (work_version >= 1),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED')),
  approved_by TEXT,
  approved_at TEXT,
  approval_request_id TEXT,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (payment_id) REFERENCES client_payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((state = 'PENDING' AND approved_by IS NULL AND approved_at IS NULL AND approval_request_id IS NULL) OR
         (state = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_request_id IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_payment_reversal_requests_work ON payment_reversal_requests(work_id, requested_at, id);
CREATE INDEX IF NOT EXISTS ix_payment_reversal_requests_payment ON payment_reversal_requests(payment_id, requested_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_reversal_approved_payment ON payment_reversal_requests(payment_id) WHERE state = 'APPROVED';
CREATE TRIGGER IF NOT EXISTS trg_payment_reversal_requests_no_delete
BEFORE DELETE ON payment_reversal_requests
BEGIN SELECT RAISE(ABORT, 'payment_reversal_requests are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_payment_reversal_requests_no_update_fields
BEFORE UPDATE OF id, payment_id, work_id, reason, requested_by, requested_at, work_version, request_id ON payment_reversal_requests
BEGIN SELECT RAISE(ABORT, 'payment_reversal_requests immutable fields'); END;
CREATE TRIGGER IF NOT EXISTS trg_payment_reversal_requests_no_double_approve
BEFORE UPDATE ON payment_reversal_requests
WHEN OLD.state = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'payment_reversal_request already finalized'); END;

CREATE TABLE IF NOT EXISTS payment_reversals (
  id TEXT PRIMARY KEY NOT NULL,
  payment_id TEXT NOT NULL UNIQUE,
  reversal_request_id TEXT NOT NULL UNIQUE,
  work_id TEXT NOT NULL,
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas BETWEEN 1 AND 9007199254740991),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (payment_id) REFERENCES client_payments(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (reversal_request_id) REFERENCES payment_reversal_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_payment_reversals_work ON payment_reversals(work_id, approved_at, id);
CREATE TRIGGER IF NOT EXISTS trg_payment_reversals_no_update
BEFORE UPDATE ON payment_reversals
BEGIN SELECT RAISE(ABORT, 'payment_reversals are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_payment_reversals_no_delete
BEFORE DELETE ON payment_reversals
BEGIN SELECT RAISE(ABORT, 'payment_reversals are append only'); END;
