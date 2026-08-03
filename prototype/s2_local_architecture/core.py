from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


class AuthorizationError(PermissionError):
    """Raised when a UID is not one of the two provisioned application users."""


class ConflictError(RuntimeError):
    """Raised when optimistic concurrency detects a stale client write."""


class ProvisioningError(RuntimeError):
    """Raised when an existing two-user provisioning would be replaced unsafely."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SCHEMA_PATH = Path(__file__).with_name("schema.sql")
SCHEMA_SQL = SCHEMA_PATH.read_text(encoding="utf-8")


@dataclass(frozen=True)
class WorkItem:
    id: str
    client_id: str
    title: str
    status: str
    version: int
    updated_by: str
    updated_at: str


class ArchitecturePrototype:
    """A local SQLite proof of the accepted D1-style relational core.

    Authentication tokens are intentionally not implemented here. Tests pass a
    mocked, pre-provisioned UID to prove the exact-two-user allowlist and audit
    boundary. JWT verification is exercised separately with Web Crypto.
    """

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self.connection = sqlite3.connect(str(db_path))
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.executescript(SCHEMA_SQL)

    def close(self) -> None:
        self.connection.close()

    def provision_users(self, person_1_uid: str, person_2_uid: str) -> None:
        if not person_1_uid or not person_2_uid or person_1_uid == person_2_uid:
            raise ValueError("Two distinct non-empty UIDs are required")

        desired = {
            "person_1": person_1_uid,
            "person_2": person_2_uid,
        }
        with self.transaction() as conn:
            existing = {
                row["role"]: row["uid"]
                for row in conn.execute(
                    "SELECT uid, role FROM app_users WHERE active = 1 ORDER BY role"
                )
            }
            inactive_count = conn.execute(
                "SELECT COUNT(*) FROM app_users WHERE active = 0"
            ).fetchone()[0]

            if existing or inactive_count:
                if existing == desired and inactive_count == 0:
                    return
                raise ProvisioningError(
                    "Existing app_users provisioning cannot be replaced; "
                    "use an explicitly reviewed migration"
                )

            conn.executemany(
                "INSERT INTO app_users(uid, role, active) VALUES (?, ?, 1)",
                [
                    (person_1_uid, "person_1"),
                    (person_2_uid, "person_2"),
                ],
            )

    def authorize(self, actor_uid: str) -> None:
        row = self.connection.execute(
            "SELECT active FROM app_users WHERE uid = ?", (actor_uid,)
        ).fetchone()
        if row is None or row["active"] != 1:
            raise AuthorizationError("UID is not provisioned for this private app")

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            yield self.connection
        except Exception:
            self.connection.rollback()
            raise
        else:
            self.connection.commit()

    def create_client(self, actor_uid: str, client_id: str, name: str) -> None:
        self.authorize(actor_uid)
        timestamp = utc_now()
        payload = {"id": client_id, "name": name}
        with self.transaction() as conn:
            conn.execute(
                "INSERT INTO clients(id, name, created_by, created_at) VALUES (?, ?, ?, ?)",
                (client_id, name, actor_uid, timestamp),
            )
            self._append_audit(
                conn, "client", client_id, "create", actor_uid, None, payload, timestamp
            )

    def create_work(
        self,
        actor_uid: str,
        work_id: str,
        client_id: str,
        title: str,
        status: str = "new",
    ) -> WorkItem:
        self.authorize(actor_uid)
        timestamp = utc_now()
        payload = {
            "id": work_id,
            "client_id": client_id,
            "title": title,
            "status": status,
            "version": 1,
        }
        with self.transaction() as conn:
            conn.execute(
                """INSERT INTO work_items
                   (id, client_id, title, status, version, updated_by, updated_at)
                   VALUES (?, ?, ?, ?, 1, ?, ?)""",
                (work_id, client_id, title, status, actor_uid, timestamp),
            )
            self._append_audit(
                conn, "work", work_id, "create", actor_uid, None, payload, timestamp
            )
        return self.get_work(actor_uid, work_id)

    def update_work_title(
        self, actor_uid: str, work_id: str, expected_version: int, new_title: str
    ) -> WorkItem:
        self.authorize(actor_uid)
        timestamp = utc_now()
        with self.transaction() as conn:
            current = conn.execute(
                "SELECT * FROM work_items WHERE id = ?", (work_id,)
            ).fetchone()
            if current is None:
                raise KeyError(work_id)
            old = dict(current)
            cursor = conn.execute(
                """UPDATE work_items
                   SET title = ?, version = version + 1, updated_by = ?, updated_at = ?
                   WHERE id = ? AND version = ?""",
                (new_title, actor_uid, timestamp, work_id, expected_version),
            )
            if cursor.rowcount != 1:
                raise ConflictError("stale version; reload before writing")
            updated = dict(
                conn.execute(
                    "SELECT * FROM work_items WHERE id = ?", (work_id,)
                ).fetchone()
            )
            self._append_audit(
                conn, "work", work_id, "update_title", actor_uid, old, updated, timestamp
            )
        return self.get_work(actor_uid, work_id)

    def get_work(self, actor_uid: str, work_id: str) -> WorkItem:
        self.authorize(actor_uid)
        row = self.connection.execute(
            "SELECT * FROM work_items WHERE id = ?", (work_id,)
        ).fetchone()
        if row is None:
            raise KeyError(work_id)
        return WorkItem(**dict(row))

    def audit_entries(self, actor_uid: str) -> list[dict[str, Any]]:
        self.authorize(actor_uid)
        return [
            dict(row)
            for row in self.connection.execute("SELECT * FROM audit_log ORDER BY id")
        ]

    def export_json(self, actor_uid: str) -> str:
        self.authorize(actor_uid)
        tables = ("app_users", "clients", "work_items", "audit_log")
        snapshot: dict[str, Any] = {
            "schema_version": 1,
            "exported_at": utc_now(),
            "tables": {},
        }
        for table in tables:
            snapshot["tables"][table] = [
                dict(row)
                for row in self.connection.execute(f"SELECT * FROM {table} ORDER BY 1")
            ]
        return json.dumps(snapshot, ensure_ascii=False, sort_keys=True, indent=2)

    def export_sql(self, actor_uid: str) -> str:
        self.authorize(actor_uid)
        return "\n".join(self.connection.iterdump()) + "\n"

    @classmethod
    def restore_json(
        cls, snapshot_text: str, db_path: str | Path = ":memory:"
    ) -> "ArchitecturePrototype":
        snapshot = json.loads(snapshot_text)
        if snapshot.get("schema_version") != 1:
            raise ValueError("Unsupported schema version")
        restored = cls(db_path)
        tables = snapshot["tables"]
        with restored.connection:
            for row in tables["app_users"]:
                restored.connection.execute(
                    "INSERT INTO app_users(uid, role, active) VALUES (:uid, :role, :active)",
                    row,
                )
            for row in tables["clients"]:
                restored.connection.execute(
                    """INSERT INTO clients(id, name, created_by, created_at)
                       VALUES (:id, :name, :created_by, :created_at)""",
                    row,
                )
            for row in tables["work_items"]:
                restored.connection.execute(
                    """INSERT INTO work_items
                       (id, client_id, title, status, version, updated_by, updated_at)
                       VALUES (:id, :client_id, :title, :status, :version, :updated_by, :updated_at)""",
                    row,
                )
            for row in tables["audit_log"]:
                restored.connection.execute(
                    """INSERT INTO audit_log
                       (id, entity_type, entity_id, action, actor_uid, old_json, new_json, created_at)
                       VALUES (:id, :entity_type, :entity_id, :action, :actor_uid, :old_json, :new_json, :created_at)""",
                    row,
                )
        return restored

    def schema_columns(self) -> dict[str, list[str]]:
        result: dict[str, list[str]] = {}
        for table in ("app_users", "clients", "work_items", "audit_log"):
            result[table] = [
                row["name"]
                for row in self.connection.execute(f"PRAGMA table_info({table})")
            ]
        return result

    @staticmethod
    def _append_audit(
        conn: sqlite3.Connection,
        entity_type: str,
        entity_id: str,
        action: str,
        actor_uid: str,
        old: dict[str, Any] | None,
        new: dict[str, Any] | None,
        timestamp: str,
    ) -> None:
        conn.execute(
            """INSERT INTO audit_log
               (entity_type, entity_id, action, actor_uid, old_json, new_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                entity_type,
                entity_id,
                action,
                actor_uid,
                None
                if old is None
                else json.dumps(old, ensure_ascii=False, sort_keys=True),
                None
                if new is None
                else json.dumps(new, ensure_ascii=False, sort_keys=True),
                timestamp,
            ),
        )
