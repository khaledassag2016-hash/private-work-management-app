-- S7 supervisory addendum: D-014 confirmation month, D-015 receipt-role totals, and D-016 subscription activation support.
ALTER TABLE works ADD COLUMN confirmed_at TEXT;
ALTER TABLE settlement_snapshots ADD COLUMN approved_receipts_person_1_halalas INTEGER NOT NULL DEFAULT 0 CHECK (approved_receipts_person_1_halalas >= 0);
ALTER TABLE settlement_snapshots ADD COLUMN approved_receipts_person_2_halalas INTEGER NOT NULL DEFAULT 0 CHECK (approved_receipts_person_2_halalas >= 0);
CREATE INDEX IF NOT EXISTS ix_works_confirmed_at ON works(confirmed_at,id);
