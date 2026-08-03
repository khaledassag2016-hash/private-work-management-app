from __future__ import annotations

import json
import sqlite3
import unittest

from prototype.s2_local_architecture import (
    ArchitecturePrototype,
    AuthorizationError,
    ConflictError,
)


class S2ArchitecturePrototypeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = ArchitecturePrototype()
        self.app.provision_users("uid-person-1", "uid-person-2")
        self.app.create_client("uid-person-1", "client-001", "عميل وهمي")
        self.app.create_work(
            "uid-person-1", "work-001", "client-001", "عنوان أولي وهمي"
        )

    def tearDown(self) -> None:
        self.app.close()

    def test_both_provisioned_users_can_use_shared_data_at_different_times(self) -> None:
        first = self.app.get_work("uid-person-1", "work-001")
        updated = self.app.update_work_title(
            "uid-person-2", "work-001", first.version, "عنوان محدث وهمي"
        )
        self.assertEqual(updated.updated_by, "uid-person-2")
        self.assertEqual(updated.version, 2)

    def test_unprovisioned_uid_is_denied(self) -> None:
        with self.assertRaises(AuthorizationError):
            self.app.get_work("uid-public-user", "work-001")

    def test_stale_write_is_rejected(self) -> None:
        current = self.app.get_work("uid-person-1", "work-001")
        self.app.update_work_title(
            "uid-person-2", "work-001", current.version, "تعديل أول"
        )
        with self.assertRaises(ConflictError):
            self.app.update_work_title(
                "uid-person-1", "work-001", current.version, "تعديل متعارض"
            )

    def test_audit_log_is_append_only(self) -> None:
        entries = self.app.audit_entries("uid-person-1")
        self.assertGreaterEqual(len(entries), 2)
        with self.assertRaises(sqlite3.IntegrityError):
            self.app.connection.execute(
                "UPDATE audit_log SET action = 'tampered' WHERE id = 1"
            )
        with self.assertRaises(sqlite3.IntegrityError):
            self.app.connection.execute("DELETE FROM audit_log WHERE id = 1")

    def test_json_export_and_restore_round_trip(self) -> None:
        snapshot = self.app.export_json("uid-person-1")
        parsed = json.loads(snapshot)
        self.assertEqual(parsed["schema_version"], 1)
        restored = ArchitecturePrototype.restore_json(snapshot)
        try:
            work = restored.get_work("uid-person-2", "work-001")
            self.assertEqual(work.title, "عنوان أولي وهمي")
            self.assertEqual(
                len(restored.audit_entries("uid-person-1")),
                len(self.app.audit_entries("uid-person-1")),
            )
        finally:
            restored.close()

    def test_sql_export_contains_schema_and_rows(self) -> None:
        dump = self.app.export_sql("uid-person-2")
        self.assertIn("CREATE TABLE", dump)
        self.assertIn("client-001", dump)
        self.assertIn("work-001", dump)

    def test_schema_does_not_store_work_files(self) -> None:
        forbidden = {"file", "files", "attachment", "attachments", "blob", "binary"}
        all_columns = {
            column.lower()
            for columns in self.app.schema_columns().values()
            for column in columns
        }
        self.assertTrue(forbidden.isdisjoint(all_columns))


if __name__ == "__main__":
    unittest.main()
