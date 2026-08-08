from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


class S2FoundationIsolatedTests(unittest.TestCase):
    def test_foundation_isolated_sibling_imports(self) -> None:
        """Verify scripts/validate_foundation.py runs successfully in Python isolated mode (-I)."""
        root_dir = Path(__file__).resolve().parents[1]
        script_path = root_dir / "scripts" / "validate_foundation.py"

        # Execute scripts/validate_foundation.py with isolated mode (-I)
        # using the current sys.executable
        result = subprocess.run(
            [sys.executable, "-I", str(script_path)],
            cwd=str(root_dir),  # Ensure CWD is root_dir to mimic usual execution
            capture_output=True,
            text=True,
            check=False,
        )

        # Output diagnostic info if the test fails
        if result.returncode != 0:
            print("STDOUT:", result.stdout)
            print("STDERR:", result.stderr)

        self.assertEqual(
            result.returncode,
            0,
            msg=f"validate_foundation.py failed in isolated mode with stderr: {result.stderr}",
        )
        self.assertIn("FOUNDATION VALIDATION: PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
