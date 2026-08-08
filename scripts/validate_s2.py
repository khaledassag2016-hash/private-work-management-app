from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str]) -> None:
    print("$", " ".join(command))
    completed = subprocess.run(command, cwd=ROOT, check=False)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def main() -> int:
    run(
        [
            sys.executable,
            "-I",
            "-m",
            "unittest",
            "tests.test_s3_repository_gate_s2_isolated",
            "-v",
        ]
    )
    run([sys.executable, "-m", "py_compile", "prototype/s2_local_architecture/core.py"])
    run(
        [
            sys.executable,
            "-m",
            "unittest",
            "discover",
            "-s",
            "tests",
            "-t",
            ".",
            "-p",
            "test_s2_*.py",
            "-v",
        ]
    )
    run(["node", "--test", "tests/test_worker_auth.mjs"])
    print("S2 LOCAL VALIDATION: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
