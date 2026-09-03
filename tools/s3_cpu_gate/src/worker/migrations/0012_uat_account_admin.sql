-- UAT remediation: append-only evidence for the Khaled-only account administration surface.
-- No UID, role, account creation, account deletion, or password value is stored here.
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
