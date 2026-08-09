import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import stable_checkpoint


class StableCheckpointToolTests(unittest.TestCase):
    def test_defaults_match_registered_checkpoint(self):
        self.assertEqual(stable_checkpoint.DEFAULT_REF, "stable/2026-08-09-be14a389")
        self.assertEqual(stable_checkpoint.DEFAULT_SHA, "be14a389d7e11f1df9f935999d888e7e2295c8a3")

    def test_verify_rejects_ref_mismatch(self):
        with mock.patch.object(stable_checkpoint, "git", return_value="0" * 40):
            with self.assertRaisesRegex(RuntimeError, "checkpoint mismatch"):
                stable_checkpoint.verify_checkpoint(
                    Path("."), stable_checkpoint.DEFAULT_REF, stable_checkpoint.DEFAULT_SHA
                )

    def test_verify_accepts_registered_ref(self):
        with mock.patch.object(stable_checkpoint, "git", return_value=stable_checkpoint.DEFAULT_SHA):
            stable_checkpoint.verify_checkpoint(
                Path("."), stable_checkpoint.DEFAULT_REF, stable_checkpoint.DEFAULT_SHA
            )

    def test_reconstructed_docx_checks_size_and_sha(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "APPROVED_REQUIREMENTS.docx"
            path.write_bytes(b"wrong")
            with self.assertRaisesRegex(RuntimeError, "DOCX size mismatch"):
                stable_checkpoint.verify_reconstructed_docx(path)

    def test_reconstruction_produces_exact_artifact(self):
        from scripts.reconstruct_requirements import reconstruct

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "APPROVED_REQUIREMENTS.docx"
            reconstruct(path)
            stable_checkpoint.verify_reconstructed_docx(path)

    def test_failed_reconstruction_or_validator_is_not_swallowed(self):
        with mock.patch.object(
            stable_checkpoint.subprocess,
            "run",
            side_effect=stable_checkpoint.subprocess.CalledProcessError(1, ["validator"]),
        ):
            with self.assertRaises(stable_checkpoint.subprocess.CalledProcessError):
                stable_checkpoint.run_checked(["validator"], Path("."), {})

    def test_required_commands_are_local_and_safe(self):
        rendered = " ".join(
            " ".join(command)
            for command in [
                stable_checkpoint.reconstruction_command(Path("docs/APPROVED_REQUIREMENTS.docx")),
                *stable_checkpoint.validation_commands(),
            ]
        )
        self.assertIn("scripts/reconstruct_requirements.py", rendered)
        self.assertIn("scripts/validate_foundation.py", rendered)
        self.assertIn("scripts/validate_s2.py", rendered)
        self.assertNotIn("wrangler", rendered.lower())
        self.assertNotIn("cloudflare", rendered.lower())
        self.assertNotIn("push", rendered.lower())
        self.assertNotIn("tag", rendered.lower())
        self.assertNotIn("branch-delete", rendered.lower())

    def test_restore_test_cleanup_and_ref_guards_are_implemented(self):
        source = Path(stable_checkpoint.__file__).read_text(encoding="utf-8")
        self.assertIn("TemporaryDirectory", source)
        self.assertIn("SOURCE WORKTREE UNCHANGED", source)
        self.assertIn("MAIN REF UNCHANGED", source)
        self.assertIn("STABLE REF UNCHANGED", source)
        self.assertIn("NO CLOUD WRITE", source)


if __name__ == "__main__":
    unittest.main()
