from __future__ import annotations

import argparse
import base64
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
PARTS_DIR = ROOT / "docs" / "source_parts"
EXPECTED_PART_COUNT = 8
EXPECTED_SHA256 = "6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b"
DEFAULT_OUTPUT = ROOT / "docs" / "APPROVED_REQUIREMENTS.docx"


def reconstruct(output: Path) -> str:
    parts = sorted(PARTS_DIR.glob("APPROVED_REQUIREMENTS.docx.b64.part*"))
    if len(parts) != EXPECTED_PART_COUNT:
        raise RuntimeError(
            f"Expected {EXPECTED_PART_COUNT} source parts, found {len(parts)}"
        )

    encoded = "".join(part.read_text(encoding="ascii").strip() for part in parts)
    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise RuntimeError(f"Invalid base64 source: {exc}") from exc

    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != EXPECTED_SHA256:
        raise RuntimeError(
            f"SHA-256 mismatch: expected {EXPECTED_SHA256}, got {actual_sha}"
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return actual_sha


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconstruct the authoritative approved requirements DOCX."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Output DOCX path (default: docs/APPROVED_REQUIREMENTS.docx)",
    )
    args = parser.parse_args()

    try:
        actual_sha = reconstruct(args.output)
    except RuntimeError as exc:
        print(f"RECONSTRUCTION: FAIL\n- {exc}")
        return 1

    print("RECONSTRUCTION: PASS")
    print("Output:", args.output)
    print("SHA-256:", actual_sha)
    return 0


if __name__ == "__main__":
    sys.exit(main())
