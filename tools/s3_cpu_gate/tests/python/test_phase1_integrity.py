from __future__ import annotations
import json
import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
REQUIRED_TOOLS = {"powershell","pester","psscriptanalyzer","python","node","npm","wrangler","firebaseCli","gcloud"}
FORBIDDEN = {".".join(x) for x in (("7","6","4"),("24","19","0"),("3","14","2"),("22","16","0"),("3","13","5"))}


def load_manifest():
    return json.loads((ROOT / "src/version-manifest.json").read_text(encoding="utf-8-sig"))


def test_version_manifest_is_authoritative():
    data=load_manifest(); assert data["authoritative"] is True; assert REQUIRED_TOOLS <= set(data["tools"])


def test_required_versions_are_exact():
    tools=load_manifest()["tools"]
    assert tools["powershell"]["version"]=="7.6.3"
    assert tools["pester"]["version"]=="6.0.0"
    assert tools["psscriptanalyzer"]["version"]=="1.25.0"
    assert tools["python"]["version"]=="3.13.14"
    assert tools["node"]["version"]=="22.23.1"
    assert tools["npm"]["version"]=="10.9.2"
    assert tools["wrangler"]["version"]=="4.118.0"
    assert tools["firebaseCli"]["version"]=="15.25.1"
    assert tools["gcloud"]["version"]=="577.0.0"


def test_package_manifest_delegates_versions():
    package=json.loads((ROOT.parent / "package-manifest.json").read_text(encoding="utf-8-sig")) if (ROOT.parent / "package-manifest.json").exists() else None
    if package is not None:
        assert package["versionManifest"]=="source/src/version-manifest.json"; assert "tools" not in package


def test_operational_package_manifest_is_allowlist():
    package = json.loads((ROOT / "package-manifest.json").read_text(encoding="utf-8"))
    assert package["versionManifest"] == "src/version-manifest.json"
    assert package["integrityAlgorithm"] == "sha256"
    assert len(package["files"]) == len(set(package["files"]))
    assert all(".." not in Path(p).parts and "\\" not in p for p in package["files"])


def test_operational_integrity_rejects_unallowlisted_and_forbidden_files(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("phase1_integrity", ROOT / "build/phase1_integrity.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    manifest = json.loads((ROOT / "package-manifest.json").read_text(encoding="utf-8"))
    (tmp_path / "package-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (tmp_path / "src").mkdir(); (tmp_path / "src/version-manifest.json").write_text('{"authoritative": true}', encoding="utf-8")
    (tmp_path / "__pycache__").mkdir(); (tmp_path / "__pycache__/bad.pyc").write_bytes(b"x")
    errors = module.validate(tmp_path)
    assert any(e.startswith("UNALLOWLISTED:") for e in errors)
    assert any(e.startswith("FORBIDDEN_FILE:") for e in errors)


def test_zip_safety_rejects_absolute_and_traversal_entries(tmp_path):
    import zipfile
    spec = __import__("importlib.util").util.spec_from_file_location("phase1_integrity", ROOT / "build/phase1_integrity.py")
    module = __import__("importlib.util").util.module_from_spec(spec); spec.loader.exec_module(module)
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("/absolute.txt", "x")
        z.writestr("C:/drive.txt", "x")
        z.writestr("../traversal.txt", "x")
    errors = module.zip_safety(archive)
    assert len(errors) == 3


def _phase1_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("phase1_integrity", ROOT / "build/phase1_integrity.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def _write_manifest(root, files):
    manifest = json.loads((ROOT / "package-manifest.json").read_text(encoding="utf-8"))
    manifest["files"] = files
    (root / "package-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_main_does_not_build_zip_after_validation_failure(tmp_path):
    module = _phase1_module(); package_root = tmp_path / "package"; package_root.mkdir()
    (tmp_path / "outside.txt").write_text("outside", encoding="utf-8")
    _write_manifest(package_root, ["../outside.txt"])
    report = tmp_path / "report.json"; archive = tmp_path / "payload.zip"
    called = False
    def forbidden_make_zip(*_args):
        nonlocal called; called = True; raise AssertionError("make_zip must not run")
    import sys
    original_make_zip = module.make_zip; original_argv = sys.argv
    module.make_zip = forbidden_make_zip
    sys.argv = ["phase1_integrity.py", "--root", str(package_root), "--report", str(report), "--zip-out", str(archive)]
    try:
        try: module.main()
        except SystemExit as exc: assert exc.code == 1
    finally:
        module.make_zip = original_make_zip; sys.argv = original_argv
    assert not called and not archive.exists()
    assert json.loads(report.read_text(encoding="utf-8"))["status"] == "FAIL"


def test_make_zip_rejects_traversal_and_absolute_entries_before_read(tmp_path):
    module = _phase1_module(); package_root = tmp_path / "package"; package_root.mkdir()
    (tmp_path / "outside.txt").write_text("outside", encoding="utf-8")
    for entry in ("../outside.txt", "/outside.txt", "C:/outside.txt"):
        _write_manifest(package_root, [entry]); archive = tmp_path / (entry.replace("/", "_").replace(":", "_") + ".zip")
        try: module.make_zip(package_root, archive)
        except ValueError as exc: assert "UNSAFE_MANIFEST_PATH" in str(exc)
        else: raise AssertionError("unsafe entry was accepted")
        assert not archive.exists()


def test_make_zip_builds_valid_allowlisted_package(tmp_path):
    module = _phase1_module(); archive = tmp_path / "valid.zip"
    module.make_zip(ROOT, archive)
    assert archive.is_file() and module.zip_safety(archive) == []


def test_executable_files_have_no_rejected_conflicting_versions():
    suffixes={".ps1",".psm1",".yml",".yaml"}
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in suffixes: continue
        text=path.read_text(encoding="utf-8-sig",errors="ignore")
        assert not (FORBIDDEN & set(re.findall(r"\b\d+\.\d+\.\d+\b",text))), path


def test_payload_has_complete_pester_support():
    required=["tests/pester/TestHelper.ps1","tests/pester/CpuGate.Tests.ps1","src/modules/Common.psm1","src/modules/CpuGate.psm1","src/S3-CpuGate-Orchestrator.ps1"]
    for rel in required: assert (ROOT/rel).is_file(), rel


def test_all_testhelper_dot_sources_resolve():
    for path in (ROOT/"tests/pester").glob("*.Tests.ps1"):
        text=path.read_text(encoding="utf-8-sig")
        if "TestHelper.ps1" in text: assert (path.parent/"TestHelper.ps1").is_file()


def test_testhelper_module_imports_resolve():
    helper=(ROOT/"tests/pester/TestHelper.ps1").read_text(encoding="utf-8-sig")
    match=re.search(r"foreach\(\$name in @\((.*?)\)\)",helper,re.S); assert match
    names=re.findall(r"'([^']+)'",match.group(1)); assert names
    for name in names: assert (ROOT/f"src/modules/{name}.psm1").is_file(), name


def test_payload_python_tests_have_runtime_modules():
    assert (ROOT/"src/python").is_dir(); assert len(list((ROOT/"tests/python").glob("test_*.py"))) >= 7


def test_ci_runs_governance_and_regressions():
    candidates=[ROOT/"src/repository_payload/.github/workflows/s3-cpu-gate-static.yml",(ROOT/"../../.github/workflows/s3-cpu-gate-static.yml").resolve()]
    workflow=next(p for p in candidates if p.is_file()).read_text(encoding="utf-8")
    ps=(ROOT/"build/Invoke-Phase1PowerShellValidation.ps1").read_text(encoding="utf-8-sig")
    combined=workflow+"\n"+ps
    for token in ("reconstruct_requirements.py","validate_foundation.py","validate_s2.py","Invoke-Pester","Invoke-ScriptAnalyzer","secret_scan.py","phase1_integrity.py","node --check"):
        assert token in combined, token


def test_toolchain_consumers_reference_manifest():
    validation=(ROOT.parent/"validation/Invoke-LocalValidation.ps1") if (ROOT.parent/"validation/Invoke-LocalValidation.ps1").is_file() else (ROOT/"validation/Invoke-LocalValidation.ps1")
    paths=[ROOT/"src/Bootstrap.ps1",ROOT/"src/modules/Toolchain.psm1",validation]
    for path in paths:
        text=path.read_text(encoding="utf-8-sig")
        assert ("version-manifest.json" in text) or ("PackageManifest.versionManifest" in text), path
