from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


class S3RepositoryGateIsolatedTests(unittest.TestCase):
    def test_foundation_isolated_sibling_imports(self) -> None:
        root_dir = Path(__file__).resolve().parents[1]
        script_path = root_dir / "scripts" / "validate_foundation.py"
        result = subprocess.run(
            [sys.executable, "-I", str(script_path)],
            cwd=str(root_dir),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(
            result.returncode,
            0,
            msg=(
                "isolated foundation validation failed\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            ),
        )
        self.assertIn("FOUNDATION VALIDATION: PASS", result.stdout)

    def test_s2_architecture_discovery_has_repository_root_in_isolated_mode(self) -> None:
        root_dir = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-t",
                ".",
                "-p",
                "test_s2_architecture_prototype.py",
                "-v",
            ],
            cwd=str(root_dir),
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(
            result.returncode,
            0,
            msg=(
                "isolated S2 architecture discovery failed\n"
                f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
            ),
        )
        self.assertNotIn("ModuleNotFoundError", result.stderr)
        self.assertIn("OK", result.stderr)


if __name__ == "__main__":
    unittest.main()
