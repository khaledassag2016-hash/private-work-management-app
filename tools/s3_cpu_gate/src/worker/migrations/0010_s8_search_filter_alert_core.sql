-- S8 PR-A: bounded search/filter read support and auditable alert-threshold configuration.
-- Rebuild audit_log only to extend its constrained entity types; preserve all final S7 rows and guards.
DROP TRIGGER IF EXISTS trg_audit_probe_insert_log;
DROP TRIGGER IF EXISTS trg_audit_probe_update_log;
DROP TRIGGER IF EXISTS trg_audit_log_no_update;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
DROP INDEX IF EXISTS ix_audit_log_run_entity;
DROP INDEX IF EXISTS ix_audit_log_entity;
ALTER TABLE audit_log RENAME TO audit_log_s7_final;
CREATE TABLE audit_log (
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
INSERT INTO audit_log(id,entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
SELECT id,entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id FROM audit_log_s7_final;
DROP TABLE audit_log_s7_final;
CREATE INDEX IF NOT EXISTS ix_audit_log_run_entity ON audit_log(run_marker,entity_type,entity_id,id);
CREATE INDEX IF NOT EXISTS ix_audit_log_entity ON audit_log(entity_type,entity_id,id);
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_probe_insert_log AFTER INSERT ON s3_audit_probe BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
  VALUES ('s3_audit_probe',NEW.entity_id,'CREATE',NEW.updated_by,NEW.changed_at,NULL,NEW.value_json,NEW.run_marker,NEW.request_id);
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_probe_update_log AFTER UPDATE ON s3_audit_probe BEGIN
  INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
  VALUES ('s3_audit_probe',NEW.entity_id,'UPDATE',NEW.updated_by,NEW.changed_at,OLD.value_json,NEW.value_json,NEW.run_marker,NEW.request_id);
END;

CREATE TABLE s8_alert_settings (
  alert_type TEXT PRIMARY KEY CHECK (alert_type IN ('NO_PRICE','NO_REPLY','NO_PAYMENT')),
  threshold_days INTEGER NOT NULL CHECK (threshold_days > 0 AND threshold_days <= 36500),
  updated_by TEXT NOT NULL REFERENCES app_users(uid),
  updated_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_s8_alert_settings_updated_at ON s8_alert_settings(updated_at,alert_type);
