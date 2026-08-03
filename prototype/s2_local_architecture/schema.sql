-- Local SQLite proof aligned with Cloudflare D1's SQLite semantics.
-- The executable source of truth for the prototype is SCHEMA_SQL in core.py.
-- This copy is retained for human review and future D1 migration planning.
PRAGMA foreign_keys = ON;
CREATE TABLE app_users (uid TEXT PRIMARY KEY, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES app_users(uid), created_at TEXT NOT NULL);
CREATE TABLE work_items (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL REFERENCES app_users(uid), updated_at TEXT NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL, actor_uid TEXT NOT NULL REFERENCES app_users(uid), old_json TEXT, new_json TEXT, created_at TEXT NOT NULL);
