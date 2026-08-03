PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_users (
    uid TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('person_1', 'person_2')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_one_active_user_per_role
ON app_users(role)
WHERE active = 1;

CREATE TRIGGER IF NOT EXISTS app_users_max_two_active_insert
BEFORE INSERT ON app_users
WHEN NEW.active = 1
 AND (SELECT COUNT(*) FROM app_users WHERE active = 1) >= 2
BEGIN
    SELECT RAISE(ABORT, 'app_users allows at most two active users');
END;

CREATE TRIGGER IF NOT EXISTS app_users_max_two_active_update
BEFORE UPDATE OF active, role ON app_users
WHEN NEW.active = 1
 AND (SELECT COUNT(*) FROM app_users WHERE active = 1 AND uid <> OLD.uid) >= 2
BEGIN
    SELECT RAISE(ABORT, 'app_users allows at most two active users');
END;

CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES app_users(uid),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_by TEXT NOT NULL REFERENCES app_users(uid),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_uid TEXT NOT NULL REFERENCES app_users(uid),
    old_json TEXT,
    new_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;
