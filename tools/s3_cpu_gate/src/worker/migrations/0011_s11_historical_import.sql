CREATE TABLE IF NOT EXISTS s11_import_batches (
  id TEXT PRIMARY KEY,
  source_store_id TEXT NOT NULL,
  source_store_sha256 TEXT NOT NULL,
  batch_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('DRY_RUN', 'IMPORT')),
  status TEXT NOT NULL CHECK (status IN ('DRY_RUN', 'IMPORTED', 'DEACTIVATED')),
  plan_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  deactivated_at TEXT,
  UNIQUE (source_store_sha256, batch_key)
);

CREATE TABLE IF NOT EXISTS s11_historical_records (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES s11_import_batches(id),
  source_store_sha256 TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_container TEXT NOT NULL,
  source_location TEXT NOT NULL,
  original_text TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN (
    'WORK', 'CUSTOMER', 'PRICE_OR_PRICE_MOVEMENT', 'PAYMENT_OR_RECEIPT',
    'FOLLOW_UP_EVENT', 'HISTORICAL_SETTLEMENT', 'OPENING_HISTORICAL_BALANCE',
    'SUBSCRIPTION_EXPENSE', 'TRANSFER_FEE', 'OTHER_GOVERNED_EXPENSE',
    'TOTAL_OR_SUMMARY_ROW', 'FREE_NOTE', 'UNKNOWN'
  )),
  review_status TEXT NOT NULL CHECK (review_status IN ('CONFIRMED', 'PENDING_REVIEW', 'UNKNOWN', 'NOT_APPLICABLE', 'REJECTED')),
  import_decision TEXT NOT NULL CHECK (import_decision IN ('ACCEPTED', 'REJECTED', 'PENDING_REVIEW', 'UNKNOWN')),
  decision_reason TEXT NOT NULL,
  reviewer_uid TEXT,
  reviewed_at TEXT,
  date_completeness TEXT NOT NULL CHECK (date_completeness IN ('COMPLETE_DAY', 'COMPLETE_MONTH', 'YEAR_ONLY', 'MISSING_YEAR', 'MISSING')),
  uncertainty_flags_json TEXT NOT NULL,
  customer_mapping_status TEXT NOT NULL CHECK (customer_mapping_status IN ('CONFIRMED', 'PENDING_REVIEW', 'UNKNOWN', 'NOT_APPLICABLE')),
  financial_amount_halalas INTEGER,
  accounting_effect_halalas INTEGER NOT NULL DEFAULT 0,
  financial_activation_state TEXT NOT NULL CHECK (financial_activation_state IN ('NONE', 'PENDING_REVIEW', 'APPROVED', 'REVOKED')),
  operational_effect_halalas INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  staged_at TEXT NOT NULL,
  imported_at TEXT,
  deactivated_at TEXT,
  UNIQUE (source_store_sha256, source_record_id),
  CHECK (accounting_effect_halalas = operational_effect_halalas),
  CHECK (accounting_effect_halalas = 0 OR (
    review_status = 'CONFIRMED' AND import_decision = 'ACCEPTED' AND financial_activation_state = 'APPROVED'
  ))
);

CREATE INDEX IF NOT EXISTS ix_s11_historical_records_batch ON s11_historical_records(batch_id, import_decision, is_active);
CREATE INDEX IF NOT EXISTS ix_s11_historical_records_type ON s11_historical_records(record_type, review_status, is_active);
CREATE INDEX IF NOT EXISTS ix_s11_historical_records_source ON s11_historical_records(source_store_sha256, source_record_id);

CREATE TABLE IF NOT EXISTS s11_financial_activations (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE REFERENCES s11_historical_records(id),
  batch_id TEXT NOT NULL REFERENCES s11_import_batches(id),
  amount_halalas INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approval_reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('APPROVED', 'REVOKED'))
);

CREATE TABLE IF NOT EXISTS s11_import_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES s11_import_batches(id),
  record_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'STAGED', 'IMPORTED', 'DUPLICATE_REPLAY', 'SOURCE_CONFLICT',
    'FINANCIAL_ACTIVATION_APPROVED', 'BATCH_DEACTIVATED'
  )),
  actor_uid TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_s11_historical_source_immutable
BEFORE UPDATE ON s11_historical_records
WHEN OLD.source_store_sha256 <> NEW.source_store_sha256
  OR OLD.source_record_id <> NEW.source_record_id
  OR OLD.source_container <> NEW.source_container
  OR OLD.source_location <> NEW.source_location
  OR OLD.original_text <> NEW.original_text
  OR OLD.normalized_json <> NEW.normalized_json
  OR OLD.record_type <> NEW.record_type
BEGIN
  SELECT RAISE(ABORT, 's11 historical source/provenance is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_s11_historical_no_delete
BEFORE DELETE ON s11_historical_records
BEGIN
  SELECT RAISE(ABORT, 's11 historical records are reversible, not deletable');
END;

CREATE TRIGGER IF NOT EXISTS trg_s11_events_no_update
BEFORE UPDATE ON s11_import_events
BEGIN
  SELECT RAISE(ABORT, 's11 import events are append only');
END;

CREATE TRIGGER IF NOT EXISTS trg_s11_events_no_delete
BEFORE DELETE ON s11_import_events
BEGIN
  SELECT RAISE(ABORT, 's11 import events are append only');
END;

CREATE TRIGGER IF NOT EXISTS trg_s11_activations_no_delete
BEFORE DELETE ON s11_financial_activations
BEGIN
  SELECT RAISE(ABORT, 's11 financial activations require governed revocation');
END;
