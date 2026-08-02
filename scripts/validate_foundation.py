from pathlib import Path
import re
import hashlib
import sys

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = [
    "README.md",
    "PROJECT_STATE.md",
    ".gitignore",
    "docs/APPROVED_REQUIREMENTS.docx",
    "docs/REQUIREMENTS.md",
    "docs/PROJECT_RULES.md",
    "docs/DEFINITION_OF_DONE.md",
    "docs/ROADMAP.md",
    "docs/DECISION_LOG.md",
    "docs/DATA_SECURITY.md",
    "docs/QUALITY_ASSURANCE_PLAN.md",
    "docs/SESSION_HANDOFF_TEMPLATE.md",
    "docs/TRACEABILITY_MATRIX.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
]
EXPECTED_DOCX_SHA = "6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b"

errors = []
for relative_path in REQUIRED:
    file_path = ROOT / relative_path
    if not file_path.exists():
        errors.append(f"MISSING: {relative_path}")
    elif file_path.stat().st_size == 0:
        errors.append(f"EMPTY: {relative_path}")

requirements = (ROOT / "docs/REQUIREMENTS.md").read_text(encoding="utf-8")
traceability = (ROOT / "docs/TRACEABILITY_MATRIX.md").read_text(encoding="utf-8")

for prefix, count, width in [("FR", 30, 3), ("AC", 14, 2), ("P", 7, 2)]:
    expected = {f"{prefix}-{number:0{width}d}" for number in range(1, count + 1)}
    in_requirements = set(re.findall(rf"\b{prefix}-\d{{{width}}}\b", requirements))
    in_traceability = set(re.findall(rf"\b{prefix}-\d{{{width}}}\b", traceability))
    if in_requirements != expected:
        errors.append(
            f"{prefix} requirements mismatch: "
            f"missing={sorted(expected - in_requirements)} "
            f"extra={sorted(in_requirements - expected)}"
        )
    if in_traceability != expected:
        errors.append(
            f"{prefix} trace mismatch: "
            f"missing={sorted(expected - in_traceability)} "
            f"extra={sorted(in_traceability - expected)}"
        )

for file_path in ROOT.rglob("*"):
    if file_path.is_file() and file_path.suffix.lower() in {".md", ".py", ".txt", ".yml", ".yaml", ".json"}:
        text = file_path.read_text(encoding="utf-8", errors="ignore")
        secret_pattern = (
            r"(?i)(api[_-]?key\s*[=:]\s*[\"']?[A-Za-z0-9_-]{16,}"
            r"|password\s*[=:]\s*[^\s]+"
            r"|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)"
        )
        if re.search(secret_pattern, text):
            errors.append(f"POSSIBLE SECRET: {file_path.relative_to(ROOT)}")
        if file_path.name != "validate_foundation.py" and re.search(r"\b(TODO|TBD|FIXME)\b", text):
            errors.append(f"UNOWNED PLACEHOLDER: {file_path.relative_to(ROOT)}")

approved_docx = ROOT / "docs/APPROVED_REQUIREMENTS.docx"
if approved_docx.exists():
    actual_sha = hashlib.sha256(approved_docx.read_bytes()).hexdigest()
    if actual_sha != EXPECTED_DOCX_SHA:
        errors.append(f"DOCX SHA mismatch: {actual_sha}")

if errors:
    print("FOUNDATION VALIDATION: FAIL")
    for error in errors:
        print("-", error)
    sys.exit(1)

print("FOUNDATION VALIDATION: PASS")
print("Coverage: FR 30/30, AC 14/14, P 7/7")
print("Required files:", len(REQUIRED), "present and non-empty")
print("Approved requirements SHA-256:", EXPECTED_DOCX_SHA)
