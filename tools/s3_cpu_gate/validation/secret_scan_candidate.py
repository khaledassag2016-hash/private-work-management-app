#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, re
from pathlib import Path

RULES = {
    "PRIVATE_KEY": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "AUTHORIZATION_HEADER": re.compile(r"(?i)authorization\s*:\s*bearer\s+\S+"),
    "JWT": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    "PASSWORD_VALUE": re.compile(r"(?i)[\"']?password[\"']?\s*[:=]\s*[\"'][^\"']{6,}[\"']"),
    "SERVICE_ACCOUNT": re.compile(r"\"type\"\s*:\s*\"service_account\""),
    "ACCESS_TOKEN_VALUE": re.compile(r"(?i)[\"']?(?:access|refresh|id|oauth)[_-]?token[\"']?\s*[:=]\s*[\"'][^\"']{8,}[\"']"),
}
SKIP_NAMES = {"secret_scan.py", "secret_scan_candidate.py", "redaction.py", "test_secret_scan.py"}
SKIP_SUFFIXES = {".zip", ".png", ".jpg", ".jpeg", ".gif", ".exe", ".dll", ".pdb", ".tar", ".gz", ".pyc"}


def scan(root: Path):
    findings = []
    env_files = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if path.name.lower().startswith(".env"):
            env_files.append(str(rel))
        if path.name in SKIP_NAMES or path.suffix.lower() in SKIP_SUFFIXES or ".git" in path.parts or "__pycache__" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for rule, pattern in RULES.items():
            for match in pattern.finditer(text):
                findings.append({"rule": rule, "path": str(rel), "offset": match.start()})
    for rel in env_files:
        findings.append({"rule": "ENV_FILE", "path": rel, "offset": 0})
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    findings = scan(args.root.resolve())
    payload = {"root": str(args.root), "status": "PASS" if not findings else "FAIL", "findingCount": len(findings), "findings": findings}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"SECRET SCAN: {payload['status']}")
    return 0 if not findings else 1

if __name__ == "__main__":
    raise SystemExit(main())
