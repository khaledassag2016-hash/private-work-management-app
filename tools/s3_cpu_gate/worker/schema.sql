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

CREATE TABLE IF NOT EXISTS account_admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_uid TEXT NOT NULL,
  target_uid TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('CHANGE_EMAIL','SEND_PASSWORD_RESET')),
  created_at TEXT NOT NULL,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (actor_uid) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (target_uid) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS trg_account_admin_audit_no_update BEFORE UPDATE ON account_admin_audit
BEGIN SELECT RAISE(ABORT, 'account_admin_audit is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_account_admin_audit_no_delete BEFORE DELETE ON account_admin_audit
BEGIN SELECT RAISE(ABORT, 'account_admin_audit is append only'); END;

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('s3_audit_probe','customer','work','catalog_value','documented_fact','work_event','work_title_history','work_status_history','cancel_archive_request','price_change_request','price_movement','ratio_change_request','ratio_history','client_payment','payment_reversal_request','payment_reversal','inter_party_transfer','subscription_history','common_expense','settlement_snapshot','settlement_reopen_request','settlement_reopen_history','s8_alert_setting')),
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

CREATE TABLE IF NOT EXISTS s8_alert_settings (
  alert_type TEXT PRIMARY KEY CHECK (alert_type IN ('NO_PRICE','NO_REPLY','NO_PAYMENT')),
  threshold_days INTEGER NOT NULL CHECK (threshold_days > 0 AND threshold_days <= 36500),
  updated_by TEXT NOT NULL REFERENCES app_users(uid),
  updated_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_s8_alert_settings_updated_at ON s8_alert_settings(updated_at,alert_type);
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
  confirmed_at TEXT,
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
-- S6 PR-A Financial Core additive schema.
-- All money is integer halalas; S7 payment/collection tables are intentionally absent.

CREATE TABLE IF NOT EXISTS price_change_requests (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('BASE','INCREASE','DECREASE','DISCOUNT')),
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas BETWEEN -9007199254740991 AND 9007199254740991),
  reason TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  work_version INTEGER NOT NULL CHECK (work_version >= 1),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED')),
  approved_by TEXT,
  approved_at TEXT,
  approval_request_id TEXT,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((movement_type IN ('BASE','INCREASE') AND amount_halalas >= 0) OR (movement_type IN ('DECREASE','DISCOUNT') AND amount_halalas <= 0)),
  CHECK ((state = 'PENDING' AND approved_by IS NULL AND approved_at IS NULL AND approval_request_id IS NULL) OR
         (state = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_request_id IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_price_change_requests_work ON price_change_requests(work_id, requested_at, id);
CREATE TRIGGER IF NOT EXISTS trg_price_change_requests_no_delete
BEFORE DELETE ON price_change_requests
BEGIN SELECT RAISE(ABORT, 'price_change_requests are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_price_change_requests_no_update_fields
BEFORE UPDATE OF id, work_id, movement_type, amount_halalas, reason, effective_at, requested_by, requested_at, work_version, request_id ON price_change_requests
BEGIN SELECT RAISE(ABORT, 'price_change_requests immutable fields'); END;
CREATE TRIGGER IF NOT EXISTS trg_price_change_requests_no_double_approve
BEFORE UPDATE ON price_change_requests
WHEN OLD.state = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'price_change_request already finalized'); END;

CREATE TABLE IF NOT EXISTS price_movements (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  price_request_id TEXT NOT NULL UNIQUE,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('BASE','INCREASE','DECREASE','DISCOUNT')),
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas BETWEEN -9007199254740991 AND 9007199254740991),
  reason TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  resulting_price_halalas INTEGER NOT NULL CHECK (resulting_price_halalas BETWEEN 0 AND 9007199254740991),
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (price_request_id) REFERENCES price_change_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_price_movements_work ON price_movements(work_id, effective_at, id);
CREATE TRIGGER IF NOT EXISTS trg_price_movements_no_update
BEFORE UPDATE ON price_movements
BEGIN SELECT RAISE(ABORT, 'price_movements are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_price_movements_no_delete
BEFORE DELETE ON price_movements
BEGIN SELECT RAISE(ABORT, 'price_movements are append only'); END;

CREATE TABLE IF NOT EXISTS ratio_change_requests (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  person_1_bps INTEGER NOT NULL CHECK (person_1_bps BETWEEN 0 AND 10000),
  person_2_bps INTEGER NOT NULL CHECK (person_2_bps BETWEEN 0 AND 10000),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  work_version INTEGER NOT NULL CHECK (work_version >= 1),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED')),
  approved_by TEXT,
  approved_at TEXT,
  approval_request_id TEXT,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (person_1_bps + person_2_bps = 10000),
  CHECK ((state = 'PENDING' AND approved_by IS NULL AND approved_at IS NULL AND approval_request_id IS NULL) OR
         (state = 'APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_request_id IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_ratio_change_requests_work ON ratio_change_requests(work_id, requested_at, id);
CREATE TRIGGER IF NOT EXISTS trg_ratio_change_requests_no_delete
BEFORE DELETE ON ratio_change_requests
BEGIN SELECT RAISE(ABORT, 'ratio_change_requests are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_ratio_change_requests_no_update_fields
BEFORE UPDATE OF id, work_id, person_1_bps, person_2_bps, reason, requested_by, requested_at, work_version, request_id ON ratio_change_requests
BEGIN SELECT RAISE(ABORT, 'ratio_change_requests immutable fields'); END;
CREATE TRIGGER IF NOT EXISTS trg_ratio_change_requests_no_double_approve
BEFORE UPDATE ON ratio_change_requests
WHEN OLD.state = 'APPROVED'
BEGIN SELECT RAISE(ABORT, 'ratio_change_request already finalized'); END;

CREATE TABLE IF NOT EXISTS ratio_history (
  id TEXT PRIMARY KEY NOT NULL,
  work_id TEXT NOT NULL,
  old_person_1_bps INTEGER NOT NULL CHECK (old_person_1_bps BETWEEN 0 AND 10000),
  old_person_2_bps INTEGER NOT NULL CHECK (old_person_2_bps BETWEEN 0 AND 10000),
  new_person_1_bps INTEGER NOT NULL CHECK (new_person_1_bps BETWEEN 0 AND 10000),
  new_person_2_bps INTEGER NOT NULL CHECK (new_person_2_bps BETWEEN 0 AND 10000),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  ratio_request_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (ratio_request_id) REFERENCES ratio_change_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (old_person_1_bps + old_person_2_bps = 10000),
  CHECK (new_person_1_bps + new_person_2_bps = 10000),
  CHECK (approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_ratio_history_work ON ratio_history(work_id, approved_at, id);
CREATE TRIGGER IF NOT EXISTS trg_ratio_history_no_update
BEFORE UPDATE ON ratio_history
BEGIN SELECT RAISE(ABORT, 'ratio_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_ratio_history_no_delete
BEFORE DELETE ON ratio_history
BEGIN SELECT RAISE(ABORT, 'ratio_history is append only'); END;

-- S7 PR-A Payments / Collections / Reversal Core.
-- All money is INTEGER halalas; one ordinary payment belongs to one Work.
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

-- S7 PR-B Transfers / Subscriptions / Expenses / Settlement Core.
CREATE TABLE IF NOT EXISTS inter_party_transfers (
  id TEXT PRIMARY KEY NOT NULL,
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas BETWEEN 1 AND 9007199254740991),
  effective_at TEXT NOT NULL,
  from_party TEXT NOT NULL CHECK (from_party IN ('person_1','person_2')),
  to_party TEXT NOT NULL CHECK (to_party IN ('person_1','person_2')),
  fee_halalas INTEGER NOT NULL CHECK (fee_halalas BETWEEN 0 AND 9007199254740991),
  fee_payer TEXT NOT NULL CHECK (fee_payer = 'person_1'),
  note TEXT,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (recorded_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (from_party <> to_party)
);
CREATE INDEX IF NOT EXISTS ix_inter_party_transfers_effective ON inter_party_transfers(effective_at,id);
CREATE TRIGGER IF NOT EXISTS trg_inter_party_transfers_no_update BEFORE UPDATE ON inter_party_transfers BEGIN SELECT RAISE(ABORT,'inter_party_transfers are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_inter_party_transfers_no_delete BEFORE DELETE ON inter_party_transfers BEGIN SELECT RAISE(ABORT,'inter_party_transfers are append only'); END;

CREATE TABLE IF NOT EXISTS subscription_history (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_count INTEGER NOT NULL CHECK (subscription_count = 2),
  aggregate_amount_halalas INTEGER NOT NULL CHECK (aggregate_amount_halalas BETWEEN 0 AND 9007199254740991),
  effective_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','CANCELLED')),
  paid_by_uid TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (paid_by_uid) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_subscription_history_effective ON subscription_history(effective_at,id);
CREATE TRIGGER IF NOT EXISTS trg_subscription_history_no_update BEFORE UPDATE ON subscription_history BEGIN SELECT RAISE(ABORT,'subscription_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_subscription_history_no_delete BEFORE DELETE ON subscription_history BEGIN SELECT RAISE(ABORT,'subscription_history is append only'); END;

CREATE TABLE IF NOT EXISTS common_expenses (
  id TEXT PRIMARY KEY NOT NULL,
  amount_halalas INTEGER NOT NULL CHECK (amount_halalas BETWEEN 1 AND 9007199254740991),
  effective_at TEXT NOT NULL,
  category TEXT NOT NULL,
  paid_by_uid TEXT NOT NULL,
  allocation_policy TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK (allocation_policy = 'UNRESOLVED'),
  note TEXT,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (paid_by_uid) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_common_expenses_effective ON common_expenses(effective_at,id);
CREATE TRIGGER IF NOT EXISTS trg_common_expenses_no_update BEFORE UPDATE ON common_expenses BEGIN SELECT RAISE(ABORT,'common_expenses are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_common_expenses_no_delete BEFORE DELETE ON common_expenses BEGIN SELECT RAISE(ABORT,'common_expenses are append only'); END;

CREATE TABLE IF NOT EXISTS settlement_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  period_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  period_basis TEXT NOT NULL,
  balance_formula TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED')),
  work_count INTEGER NOT NULL CHECK (work_count >= 0),
  cumulative_work_count INTEGER NOT NULL CHECK (cumulative_work_count >= 0),
  total_work_value_halalas INTEGER NOT NULL CHECK (total_work_value_halalas >= 0),
  person_1_work_share_halalas INTEGER NOT NULL CHECK (person_1_work_share_halalas >= 0),
  person_2_work_share_halalas INTEGER NOT NULL CHECK (person_2_work_share_halalas >= 0),
  approved_receipts_halalas INTEGER NOT NULL CHECK (approved_receipts_halalas >= 0),
  approved_receipts_person_1_halalas INTEGER NOT NULL CHECK (approved_receipts_person_1_halalas >= 0),
  approved_receipts_person_2_halalas INTEGER NOT NULL CHECK (approved_receipts_person_2_halalas >= 0),
  transfer_amount_halalas INTEGER NOT NULL CHECK (transfer_amount_halalas >= 0),
  transfer_fee_halalas INTEGER NOT NULL CHECK (transfer_fee_halalas >= 0),
  subscription_total_halalas INTEGER NOT NULL CHECK (subscription_total_halalas >= 0),
  subscription_effect_person_1_halalas INTEGER NOT NULL,
  subscription_effect_person_2_halalas INTEGER NOT NULL,
  governed_expense_total_halalas INTEGER NOT NULL CHECK (governed_expense_total_halalas >= 0),
  prior_balance_halalas INTEGER NOT NULL,
  final_balance_halalas INTEGER,
  unresolved_code TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (created_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_snapshots_period_version ON settlement_snapshots(period_key,version);
CREATE INDEX IF NOT EXISTS ix_settlement_snapshots_period ON settlement_snapshots(period_key,state,created_at,id);
CREATE TRIGGER IF NOT EXISTS trg_settlement_snapshots_no_update BEFORE UPDATE ON settlement_snapshots BEGIN SELECT RAISE(ABORT,'settlement_snapshots are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_settlement_snapshots_no_delete BEFORE DELETE ON settlement_snapshots BEGIN SELECT RAISE(ABORT,'settlement_snapshots are append only'); END;

CREATE TABLE IF NOT EXISTS settlement_reopen_requests (
  id TEXT PRIMARY KEY NOT NULL,
  period_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED')),
  approved_by TEXT,
  approved_at TEXT,
  approval_request_id TEXT,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK ((state='PENDING' AND approved_by IS NULL AND approved_at IS NULL AND approval_request_id IS NULL) OR (state='APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_request_id IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX IF NOT EXISTS ix_settlement_reopen_requests_period ON settlement_reopen_requests(period_key,requested_at,id);
CREATE TRIGGER IF NOT EXISTS trg_settlement_reopen_requests_no_delete BEFORE DELETE ON settlement_reopen_requests BEGIN SELECT RAISE(ABORT,'settlement_reopen_requests are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_settlement_reopen_requests_no_update_fields BEFORE UPDATE OF id,period_key,reason,requested_by,requested_at,request_id ON settlement_reopen_requests BEGIN SELECT RAISE(ABORT,'settlement_reopen_requests immutable fields'); END;
CREATE TRIGGER IF NOT EXISTS trg_settlement_reopen_requests_no_double_approve BEFORE UPDATE ON settlement_reopen_requests WHEN OLD.state='APPROVED' BEGIN SELECT RAISE(ABORT,'settlement_reopen_request already finalized'); END;

CREATE TABLE IF NOT EXISTS settlement_reopen_history (
  id TEXT PRIMARY KEY NOT NULL,
  period_key TEXT NOT NULL,
  reopen_request_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (reopen_request_id) REFERENCES settlement_reopen_requests(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (requested_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (approved_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (requested_by <> approved_by)
);
CREATE INDEX IF NOT EXISTS ix_settlement_reopen_history_period ON settlement_reopen_history(period_key,approved_at,id);
CREATE TRIGGER IF NOT EXISTS trg_settlement_reopen_history_no_update BEFORE UPDATE ON settlement_reopen_history BEGIN SELECT RAISE(ABORT,'settlement_reopen_history is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_settlement_reopen_history_no_delete BEFORE DELETE ON settlement_reopen_history BEGIN SELECT RAISE(ABORT,'settlement_reopen_history is append only'); END;
