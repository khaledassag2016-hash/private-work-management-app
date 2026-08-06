PRAGMA foreign_keys = ON;
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
