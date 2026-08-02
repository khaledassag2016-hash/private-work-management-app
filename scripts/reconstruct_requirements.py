from __future__ import annotations

import argparse
import base64
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SHA256 = "6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b"
EXPECTED_BYTE_SIZE = 63710
EXPECTED_BASE64_LENGTH = 84948
DEFAULT_OUTPUT = ROOT / "docs" / "APPROVED_REQUIREMENTS.docx"

# Explicit ordering prevents glob ordering, duplicate files, or obsolete damaged
# parts from silently changing the authoritative artifact.
SOURCE_FILES = (
    "docs/source_parts/APPROVED_REQUIREMENTS.docx.b64.part01",
    "docs/source_parts/APPROVED_REQUIREMENTS.docx.b64.part02",
    "docs/source_parts/APPROVED_REQUIREMENTS.docx.b64.part03",
    "docs/source_parts/APPROVED_REQUIREMENTS.docx.b64.part04",
    "docs/source_parts_v2/APPROVED_REQUIREMENTS.docx.b64.part05a",
    "docs/source_parts_v2/APPROVED_REQUIREMENTS.docx.b64.part05b",
    "docs/source_parts_v2/APPROVED_REQUIREMENTS.docx.b64.part06a",
    "docs/source_parts_v2/APPROVED_REQUIREMENTS.docx.b64.part06b",
    "docs/source_parts_v2/APPROVED_REQUIREMENTS.docx.b64.part07a",
    "docs/source_parts_v2/APPROVED_REQUIREMENTS.docx.b64.part07b",
    "docs/source_parts/APPROVED_REQUIREMENTS.docx.b64.part08",
)


def load_authoritative_bytes() -> bytes:
    missing = [path for path in SOURCE_FILES if not (ROOT / path).is_file()]
    if missing:
        raise RuntimeError("Missing authoritative source files: " + ", ".join(missing))

    encoded = "".join(
        (ROOT / relative_path).read_text(encoding="ascii").strip()
        for relative_path in SOURCE_FILES
    )
    if len(encoded) != EXPECTED_BASE64_LENGTH:
        raise RuntimeError(
            "Base64 length mismatch: "
            f"expected {EXPECTED_BASE64_LENGTH}, got {len(encoded)}"
        )

    try:
        data = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise RuntimeError(f"Invalid Base64 source: {exc}") from exc

    if len(data) != EXPECTED_BYTE_SIZE:
        raise RuntimeError(
            f"Byte-size mismatch: expected {EXPECTED_BYTE_SIZE}, got {len(data)}"
        )

    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != EXPECTED_SHA256:
        raise RuntimeError(
            f"SHA-256 mismatch: expected {EXPECTED_SHA256}, got {actual_sha}"
        )
    return data


def reconstruct(output: Path) -> str:
    data = load_authoritative_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reconstruct and verify the authoritative approved requirements DOCX."
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
    print("Byte size:", EXPECTED_BYTE_SIZE)
    print("SHA-256:", actual_sha)
    return 0


if __name__ == "__main__":
    sys.exit(main())
