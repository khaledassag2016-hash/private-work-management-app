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
