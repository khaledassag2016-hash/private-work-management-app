from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "src"
FILES = sorted(
    p
    for p in list(SOURCE_ROOT.rglob("*.ps1")) + list(SOURCE_ROOT.rglob("*.psm1"))
    if not p.relative_to(SOURCE_ROOT).parts or p.relative_to(SOURCE_ROOT).parts[0] != "repository_payload"
)

SUSPICIOUS = [
    re.compile(r"-not\$"),
    re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*-(?:eq|ne|lt|le|gt|ge)\b", re.I),
    re.compile(r"\b(?:if|while|foreach|for)\([^\n]*\{[^\n]*$"),
]


def strip_strings_and_comments(text: str) -> str:
    out: list[str] = []
    i = 0
    quote: str | None = None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "`" and i + 1 < len(text):
                out.extend("  ")
                i += 2
                continue
            if ch == quote:
                quote = None
            out.append(" ")
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            out.append(" ")
            i += 1
            continue
        if ch == "#":
            while i < len(text) and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def scan(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    cleaned = strip_strings_and_comments(text)
    errors: list[str] = []
    stack: list[tuple[str, int]] = []
    pairs = {')': '(', ']': '[', '}': '{'}
    for pos, ch in enumerate(cleaned):
        if ch in "([{":
            stack.append((ch, pos))
        elif ch in ")]}":
            if not stack or stack[-1][0] != pairs[ch]:
                errors.append(f"unmatched {ch} at offset {pos}")
            else:
                stack.pop()
    for ch, pos in stack:
        errors.append(f"unclosed {ch} at offset {pos}")
    for pattern in SUSPICIOUS[:2]:
        for match in pattern.finditer(cleaned):
            errors.append(f"suspicious token {match.group(0)!r} at offset {match.start()}")
    if "Set-StrictMode -Version Latest" not in text:
        errors.append("missing strict mode")
    if "$ErrorActionPreference" not in text or "'Stop'" not in text:
        errors.append("missing Stop error preference")
    return errors


def main() -> int:
    all_errors: list[str] = []
    for path in FILES:
        for error in scan(path):
            all_errors.append(f"{path.relative_to(ROOT)}: {error}")
    if all_errors:
        print("POWERSHELL HEURISTIC SCAN: FAIL")
        print("\n".join(all_errors))
        return 1
    print(f"POWERSHELL HEURISTIC SCAN: PASS ({len(FILES)} files)")
    print("This is not a replacement for the PowerShell parser or PSScriptAnalyzer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
