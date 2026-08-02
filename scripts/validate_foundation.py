from __future__ import annotations

from pathlib import Path
import base64
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
EXPECTED_DOCX_SHA = "6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b"
EXPECTED_DOCX_SIZE = 63710
EXPECTED_PART_COUNT = 8
PARTS_GLOB = "APPROVED_REQUIREMENTS.docx.b64.part*"

REQUIRED = [
    "README.md",
    "PROJECT_STATE.md",
    ".gitignore",
    "FOUNDATION_MANIFEST.json",
    "docs/REQUIREMENTS.md",
    "docs/PROJECT_RULES.md",
    "docs/DEFINITION_OF_DONE.md",
    "docs/ROADMAP.md",
    "docs/DECISION_LOG.md",
    "docs/DATA_SECURITY.md",
    "docs/QUALITY_ASSURANCE_PLAN.md",
    "docs/SESSION_HANDOFF_TEMPLATE.md",
    "docs/TRACEABILITY_MATRIX.md",
    "docs/ISSUE_INDEX.md",
    "docs/SCENARIOS_AND_EXCEPTIONS.md",
    "docs/CLASSIFICATION_CATALOG.md",
    "docs/HISTORICAL_DATA_RULES.md",
    "docs/SEARCH_ANALYTICS_EXPORT.md",
    "docs/SOURCE_NOTES.md",
    "docs/STAGE_1_VALIDATION_REPORT.md",
    "scripts/reconstruct_requirements.py",
    "scripts/validate_foundation.py",
    ".github/PULL_REQUEST_TEMPLATE.md",
]

EXPECTED_ISSUES = {f"S{stage}": stage - 1 for stage in range(2, 12)}
EXPECTED_COVERAGE = {
    "functional_requirements": "30/30",
    "acceptance_criteria": "14/14",
    "approved_decisions": "7/7",
    "approved_scenarios": "14/14",
}
EXPECTED_OPEN_DECISIONS = {"Q-001", "Q-002", "Q-003"}


def expected_stage_map() -> dict[str, str]:
    mapping: dict[str, str] = {}
    for number in range(1, 7):
        mapping[f"FR-{number:03d}"] = "S4"
    for number in range(7, 9):
        mapping[f"FR-{number:03d}"] = "S5"
    for number in range(9, 11):
        mapping[f"FR-{number:03d}"] = "S6"
    for number in range(11, 14):
        mapping[f"FR-{number:03d}"] = "S7"
    for number in range(14, 17):
        mapping[f"FR-{number:03d}"] = "S4"
    mapping["FR-017"] = "S6"
    for number in range(18, 22):
        mapping[f"FR-{number:03d}"] = "S7"
    mapping.update(
        {
            "FR-022": "S8",
            "FR-023": "S5",
            "FR-024": "S8",
            "FR-025": "S8",
            "FR-026": "S3",
            "FR-027": "S2",
            "FR-028": "S4",
            "FR-029": "S8",
            "FR-030": "S8",
        }
    )

    mapping.update(
        {
            "AC-01": "S4",
            "AC-02": "S6",
            "AC-03": "S5",
            "AC-04": "S4",
            "AC-05": "S7",
            "AC-06": "S7",
            "AC-07": "S4",
            "AC-08": "S8",
            "AC-09": "S8",
            "AC-10": "S8",
            "AC-11": "S3",
            "AC-12": "S5",
            "AC-13": "S4",
            "AC-14": "S11",
            "P-01": "S7",
            "P-02": "S7",
            "P-03": "S7",
            "P-04": "S7",
            "P-05": "S5/S6",
            "P-06": "S4",
            "P-07": "S11",
            "S-01": "S6",
            "S-02": "S5/S6",
            "S-03": "S4/S5",
            "S-04": "S4",
            "S-05": "S4/S8",
            "S-06": "S5",
            "S-07": "S5/S7",
            "S-08": "S7",
            "S-09": "S7",
            "S-10": "S6",
            "S-11": "S5/S6",
            "S-12": "S4",
            "S-13": "S4",
            "S-14": "S4/S11",
        }
    )
    return mapping


def read_text(relative_path: str) -> str:
    path = ROOT / relative_path
    return path.read_text(encoding="utf-8") if path.exists() else ""


errors: list[str] = []

for relative_path in REQUIRED:
    file_path = ROOT / relative_path
    if not file_path.exists():
        errors.append(f"MISSING: {relative_path}")
    elif file_path.stat().st_size == 0:
        errors.append(f"EMPTY: {relative_path}")

parts = sorted((ROOT / "docs" / "source_parts").glob(PARTS_GLOB))
if len(parts) != EXPECTED_PART_COUNT:
    errors.append(
        f"SOURCE PART COUNT: expected {EXPECTED_PART_COUNT}, found {len(parts)}"
    )
else:
    try:
        encoded = "".join(part.read_text(encoding="ascii").strip() for part in parts)
        reconstructed = base64.b64decode(encoded, validate=True)
        actual_sha = hashlib.sha256(reconstructed).hexdigest()
        if len(reconstructed) != EXPECTED_DOCX_SIZE:
            errors.append(
                f"DOCX size mismatch: expected {EXPECTED_DOCX_SIZE}, got {len(reconstructed)}"
            )
        if actual_sha != EXPECTED_DOCX_SHA:
            errors.append(f"DOCX SHA mismatch: {actual_sha}")
    except Exception as exc:
        errors.append(f"DOCX reconstruction failed: {exc}")

manifest_path = ROOT / "FOUNDATION_MANIFEST.json"
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception as exc:
    manifest = {}
    errors.append(f"MANIFEST invalid JSON: {exc}")

if manifest:
    source = manifest.get("authoritative_source", {})
    expected_source = {
        "logical_path": "docs/APPROVED_REQUIREMENTS.docx",
        "stored_as": "docs/source_parts/APPROVED_REQUIREMENTS.docx.b64.part01..part08",
        "reconstruction_script": "scripts/reconstruct_requirements.py",
        "sha256": EXPECTED_DOCX_SHA,
        "byte_size": EXPECTED_DOCX_SIZE,
        "part_count": EXPECTED_PART_COUNT,
    }
    if manifest.get("stage") != "S1":
        errors.append(f"MANIFEST stage mismatch: {manifest.get('stage')}")
    if source != expected_source:
        errors.append("MANIFEST authoritative_source mismatch")
    if manifest.get("required_files") != REQUIRED:
        errors.append("MANIFEST required_files differs from validator REQUIRED list")
    if manifest.get("coverage") != EXPECTED_COVERAGE:
        errors.append("MANIFEST coverage mismatch")
    if manifest.get("implementation_issues") != EXPECTED_ISSUES:
        errors.append("MANIFEST implementation_issues mismatch")
    if set(manifest.get("open_decisions", {})) != EXPECTED_OPEN_DECISIONS:
        errors.append("MANIFEST open_decisions mismatch")

requirements = read_text("docs/REQUIREMENTS.md")
traceability = read_text("docs/TRACEABILITY_MATRIX.md")

for prefix, count, width in [("FR", 30, 3), ("AC", 14, 2), ("P", 7, 2)]:
    expected = {f"{prefix}-{number:0{width}d}" for number in range(1, count + 1)}
    in_requirements = set(re.findall(rf"\b{prefix}-\d{{{width}}}\b", requirements))
    in_traceability = set(re.findall(rf"\b{prefix}-\d{{{width}}}\b", traceability))
    if in_requirements != expected:
        errors.append(
            f"{prefix} requirements mismatch: missing={sorted(expected - in_requirements)} "
            f"extra={sorted(in_requirements - expected)}"
        )
    if in_traceability != expected:
        errors.append(
            f"{prefix} trace mismatch: missing={sorted(expected - in_traceability)} "
            f"extra={sorted(in_traceability - expected)}"
        )

scenario_text = read_text("docs/SCENARIOS_AND_EXCEPTIONS.md")
expected_scenarios = {f"S-{number:02d}" for number in range(1, 15)}
in_scenarios = set(re.findall(r"\bS-\d{2}\b", scenario_text))
in_trace_scenarios = set(re.findall(r"\bS-\d{2}\b", traceability))
if in_scenarios != expected_scenarios:
    errors.append(
        f"Scenario document mismatch: missing={sorted(expected_scenarios - in_scenarios)} "
        f"extra={sorted(in_scenarios - expected_scenarios)}"
    )
if in_trace_scenarios != expected_scenarios:
    errors.append(
        f"Scenario trace mismatch: missing={sorted(expected_scenarios - in_trace_scenarios)} "
        f"extra={sorted(in_trace_scenarios - expected_scenarios)}"
    )

stage_rows = {
    match.group(1): re.sub(r"\s+", "", match.group(2))
    for match in re.finditer(
        r"^\|\s*(FR-\d{3}|AC-\d{2}|P-\d{2}|S-\d{2})\s*\|\s*[^|]+\|\s*([^|]+?)\s*\|",
        traceability,
        flags=re.MULTILINE,
    )
}
for identifier, expected_stage in expected_stage_map().items():
    actual_stage = stage_rows.get(identifier)
    if actual_stage != expected_stage:
        errors.append(
            f"TRACE STAGE {identifier}: expected {expected_stage}, got {actual_stage}"
        )

issue_index = read_text("docs/ISSUE_INDEX.md")
issue_rows = {
    match.group(1): int(match.group(2))
    for match in re.finditer(
        r"^\|\s*(S\d+)\s*\|\s*#(\d+)\s*\|", issue_index, flags=re.MULTILINE
    )
}
if issue_rows != EXPECTED_ISSUES:
    errors.append(f"ISSUE INDEX mismatch: {issue_rows}")

decision_log = read_text("docs/DECISION_LOG.md")
approved_decisions = set(re.findall(r"\bD-\d{3}\b", decision_log))
open_decisions = set(re.findall(r"\bQ-\d{3}\b", decision_log))
if approved_decisions != {f"D-{number:03d}" for number in range(1, 6)}:
    errors.append(f"DECISION LOG approved IDs mismatch: {sorted(approved_decisions)}")
if open_decisions != EXPECTED_OPEN_DECISIONS:
    errors.append(f"DECISION LOG open IDs mismatch: {sorted(open_decisions)}")

source_notes = read_text("docs/SOURCE_NOTES.md")
for required_phrase in [
    "مسودة",
    "بانتظار الاعتماد",
    "القسم 16",
    "لا تُستخدم أي نسخة أقدم",
]:
    if required_phrase not in source_notes:
        errors.append(f"SOURCE NOTES missing phrase: {required_phrase}")

project_rules = read_text("docs/PROJECT_RULES.md")
for identifier in sorted(EXPECTED_OPEN_DECISIONS):
    if identifier not in project_rules:
        errors.append(f"PROJECT RULES missing unresolved-decision guard: {identifier}")

text_extensions = {".md", ".py", ".txt", ".yml", ".yaml", ".json"}
for file_path in ROOT.rglob("*"):
    if not file_path.is_file() or file_path.suffix.lower() not in text_extensions:
        continue
    text = file_path.read_text(encoding="utf-8", errors="ignore")
    secret_pattern = (
        r"(?i)(api[_-]?key\s*[=:]\s*[\"']?[A-Za-z0-9_-]{16,}"
        r"|password\s*[=:]\s*[^\s]+"
        r"|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY)"
    )
    if re.search(secret_pattern, text):
        errors.append(f"POSSIBLE SECRET: {file_path.relative_to(ROOT)}")
    if file_path.name != "validate_foundation.py" and re.search(
        r"\b(TODO|TBD|FIXME)\b", text
    ):
        errors.append(f"UNOWNED PLACEHOLDER: {file_path.relative_to(ROOT)}")

if errors:
    print("FOUNDATION VALIDATION: FAIL")
    for error in errors:
        print("-", error)
    sys.exit(1)

print("FOUNDATION VALIDATION: PASS")
print("Coverage: FR 30/30, AC 14/14, P 7/7, scenarios 14/14")
print("Trace stage assignments: PASS")
print("Manifest and issue index: PASS")
print("Open decisions recorded: Q-001, Q-002, Q-003")
print("Required governance files:", len(REQUIRED), "present and non-empty")
print("Approved source parts:", EXPECTED_PART_COUNT, "present")
print("Approved requirements bytes:", EXPECTED_DOCX_SIZE)
print("Approved requirements SHA-256:", EXPECTED_DOCX_SHA)
