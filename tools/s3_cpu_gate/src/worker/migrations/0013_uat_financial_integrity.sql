-- UAT supervisory correction: D-024 settlement adjustments + D-025 immediate session invalidation.
ALTER TABLE app_users ADD COLUMN auth_valid_since INTEGER NOT NULL DEFAULT 0 CHECK (auth_valid_since >= 0);
ALTER TABLE settlement_snapshots ADD COLUMN settlement_adjustment_person_1_halalas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_snapshots ADD COLUMN settlement_adjustment_person_2_halalas INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settlement_adjustments (
  id TEXT PRIMARY KEY NOT NULL,
  period_key TEXT NOT NULL,
  source_period_key TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('CANCELLATION','POST_CANCEL_REVERSAL')),
  source_event_id TEXT NOT NULL UNIQUE,
  person_1_delta_halalas INTEGER NOT NULL CHECK (person_1_delta_halalas BETWEEN -9007199254740991 AND 9007199254740991),
  person_2_delta_halalas INTEGER NOT NULL CHECK (person_2_delta_halalas BETWEEN -9007199254740991 AND 9007199254740991),
  recognized_person_1_before_halalas INTEGER NOT NULL CHECK (recognized_person_1_before_halalas BETWEEN 0 AND 9007199254740991),
  recognized_person_2_before_halalas INTEGER NOT NULL CHECK (recognized_person_2_before_halalas BETWEEN 0 AND 9007199254740991),
  corrected_person_1_after_halalas INTEGER NOT NULL CHECK (corrected_person_1_after_halalas BETWEEN 0 AND 9007199254740991),
  corrected_person_2_after_halalas INTEGER NOT NULL CHECK (corrected_person_2_after_halalas BETWEEN 0 AND 9007199254740991),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (source_snapshot_id) REFERENCES settlement_snapshots(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (work_id) REFERENCES works(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES app_users(uid) ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_settlement_adjustments_period ON settlement_adjustments(period_key,created_at,id);
CREATE INDEX IF NOT EXISTS ix_settlement_adjustments_work ON settlement_adjustments(work_id,created_at,id);
CREATE TRIGGER IF NOT EXISTS trg_settlement_adjustments_no_update BEFORE UPDATE ON settlement_adjustments BEGIN SELECT RAISE(ABORT,'settlement_adjustments are append only'); END;
CREATE TRIGGER IF NOT EXISTS trg_settlement_adjustments_no_delete BEFORE DELETE ON settlement_adjustments BEGIN SELECT RAISE(ABORT,'settlement_adjustments are append only'); END;
