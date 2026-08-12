-- S7 PR-B additive migration: transfers, subscriptions, expenses, settlement core, and D-011 reopen history.
-- All monetary fields are INTEGER halalas. No generic expense allocation is invented.

DROP TRIGGER IF EXISTS trg_audit_probe_insert_log;
DROP TRIGGER IF EXISTS trg_audit_probe_update_log;
DROP TRIGGER IF EXISTS trg_audit_log_no_update;
DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
DROP INDEX IF EXISTS ix_audit_log_run_entity;
DROP INDEX IF EXISTS ix_audit_log_entity;
ALTER TABLE audit_log RENAME TO audit_log_s7_pr_a;
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('s3_audit_probe','customer','work','catalog_value','documented_fact','work_event','work_title_history','work_status_history','cancel_archive_request','price_change_request','price_movement','ratio_change_request','ratio_history','client_payment','payment_reversal_request','payment_reversal','inter_party_transfer','subscription_history','common_expense','settlement_snapshot','settlement_reopen_request','settlement_reopen_history')),
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
SELECT id,entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id FROM audit_log_s7_pr_a;
DROP TABLE audit_log_s7_pr_a;
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
