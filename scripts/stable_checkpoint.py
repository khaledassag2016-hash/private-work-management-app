"""Local-only stable checkpoint verification and recovery testing."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_REF = "stable/2026-08-09-be14a389"
DEFAULT_SHA = "be14a389d7e11f1df9f935999d888e7e2295c8a3"
APPROVED_REQUIREMENTS_RELATIVE_PATH = Path("docs/APPROVED_REQUIREMENTS.docx")
APPROVED_REQUIREMENTS_SIZE = 63710
APPROVED_REQUIREMENTS_SHA256 = "6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b"


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, text=True, capture_output=True, check=False
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout.strip()


def verify_checkpoint(repo: Path, ref: str, sha: str) -> None:
    if len(sha) != 40 or any(char not in "0123456789abcdef" for char in sha.lower()):
        raise ValueError("checkpoint SHA must be a 40-character hexadecimal object id")
    resolved = resolve_ref(repo, ref)
    if resolved != sha.lower():
        raise RuntimeError(f"checkpoint mismatch: {ref} resolves to {resolved}, expected {sha}")
    print(f"CHECKPOINT VERIFIED: {ref} -> {resolved}")


def resolve_ref(repo: Path, ref: str) -> str:
    for candidate in (f"{ref}^{{commit}}", f"refs/remotes/origin/{ref}^{{commit}}"):
        resolved = git(repo, "rev-parse", "--verify", candidate, check=False)
        if resolved:
            return resolved
    raise RuntimeError(f"checkpoint ref not found locally: {ref}")


def ref_for_worktree(repo: Path, ref: str) -> str:
    if git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}", check=False):
        return ref
    remote_ref = f"refs/remotes/origin/{ref}"
    if git(repo, "rev-parse", "--verify", f"{remote_ref}^{{commit}}", check=False):
        return remote_ref
    raise RuntimeError(f"checkpoint ref not found locally: {ref}")


def validation_commands() -> list[list[str]]:
    python = sys.executable
    return [[python, "scripts/validate_foundation.py"], [python, "scripts/validate_s2.py"]]


def reconstruction_command(output: Path) -> list[str]:
    return [sys.executable, "scripts/reconstruct_requirements.py", "--output", str(output)]


def verify_reconstructed_docx(path: Path) -> None:
    if not path.is_file():
        raise RuntimeError(f"reconstructed DOCX missing: {path}")
    data = path.read_bytes()
    actual_sha = hashlib.sha256(data).hexdigest()
    if len(data) != APPROVED_REQUIREMENTS_SIZE:
        raise RuntimeError(
            f"DOCX size mismatch: expected {APPROVED_REQUIREMENTS_SIZE}, got {len(data)}"
        )
    if actual_sha != APPROVED_REQUIREMENTS_SHA256:
        raise RuntimeError(
            f"DOCX SHA-256 mismatch: expected {APPROVED_REQUIREMENTS_SHA256}, got {actual_sha}"
        )
    print(f"DOCX VERIFIED: size={len(data)} SHA-256={actual_sha}")


def run_checked(command: list[str], cwd: Path, environment: dict[str, str]) -> None:
    subprocess.run(command, cwd=cwd, check=True, env=environment)


def validation_environment() -> dict[str, str]:
    environment = os.environ.copy()
    path_entries: list[str] = []
    node_dir = Path(sys.executable).parent.parent / "node" / "bin"
    if (node_dir / "node.exe").exists() or (node_dir / "node").exists():
        path_entries.append(str(node_dir))
    elif shutil.which("node") is None:
        raise RuntimeError("node is required for S2 validation but was not found")
    for openssl_dir in (Path("C:/Program Files/Git/usr/bin"), Path("C:/Program Files/Git/mingw64/bin")):
        if (openssl_dir / "openssl.exe").exists():
            path_entries.append(str(openssl_dir))
    if shutil.which("openssl", path=os.pathsep.join(path_entries + [environment.get("PATH", "")])) is None:
        raise RuntimeError("openssl is required for S2 validation but was not found")
    environment["PATH"] = os.pathsep.join(path_entries + [environment.get("PATH", "")])
    return environment


def run_restore_test(repo: Path, ref: str, sha: str, dry_run: bool = False) -> None:
    verify_checkpoint(repo, ref, sha)
    before_status = git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    stable_ref = ref_for_worktree(repo, ref)
    before_refs = {
        "main": git(repo, "rev-parse", "--verify", "refs/heads/main"),
        "stable": git(repo, "rev-parse", "--verify", f"{stable_ref}^{{commit}}"),
    }
    if dry_run:
        print("DRY RUN: no worktree created and no validation executed")
        print(f"DRY RUN: git worktree add --detach <temporary-worktree> {ref}")
        for command in validation_commands():
            print("DRY RUN:", " ".join(command))
        return

    with tempfile.TemporaryDirectory(prefix="stable-checkpoint-") as temporary:
        worktree = Path(temporary)
        environment = validation_environment()
        git(repo, "worktree", "add", "--detach", str(worktree), stable_ref)
        try:
            recovered = git(worktree, "rev-parse", "HEAD")
            if recovered != sha.lower():
                raise RuntimeError(f"recovered SHA mismatch: {recovered}")
            print(f"RECOVERED SHA: {recovered}")
            print("WORKTREE HEAD MATCH: PASS")
            docx_path = worktree / APPROVED_REQUIREMENTS_RELATIVE_PATH
            command = reconstruction_command(docx_path)
            print("$", " ".join(command))
            run_checked(command, worktree, environment)
            verify_reconstructed_docx(docx_path)
            for command in validation_commands():
                print("$", " ".join(command))
                run_checked(command, worktree, environment)
            print("FOUNDATION PASS")
            print("S2 PASS")
        finally:
            git(repo, "worktree", "remove", "--force", str(worktree), check=False)

    after_status = git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    after_refs = {
        "main": git(repo, "rev-parse", "--verify", "refs/heads/main"),
        "stable": git(repo, "rev-parse", "--verify", f"{stable_ref}^{{commit}}"),
    }
    if before_status != after_status:
        raise RuntimeError("source working tree changed")
    if before_refs != after_refs:
        raise RuntimeError("main or stable ref changed")
    print("SOURCE WORKTREE UNCHANGED: PASS")
    print("MAIN REF UNCHANGED: PASS")
    print("STABLE REF UNCHANGED: PASS")
    print("NO CLOUD WRITE: PASS (local git and validators only)")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("command", choices=["verify", "restore-test"])
    result.add_argument("--repo", type=Path, default=Path.cwd())
    result.add_argument("--ref", default=DEFAULT_REF)
    result.add_argument("--sha", default=DEFAULT_SHA)
    result.add_argument("--dry-run", action="store_true")
    return result


def main() -> int:
    args = parser().parse_args()
    repo = args.repo.resolve()
    if args.command == "verify":
        verify_checkpoint(repo, args.ref, args.sha)
    else:
        run_restore_test(repo, args.ref, args.sha, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
