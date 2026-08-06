#!/usr/bin/env python3
from __future__ import annotations
import argparse, importlib.util, inspect, json, sys, tempfile, time, traceback
from pathlib import Path


def load_module(path: Path, index: int):
    name = f"local_validation_test_{index}_{path.stem}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run(source_root: Path):
    tests_dir = source_root / "tests" / "python"
    files = sorted(tests_dir.glob("test_*.py"))
    results = []
    started = time.perf_counter()
    for index, path in enumerate(files):
        try:
            module = load_module(path, index)
        except Exception as exc:
            results.append({"file": str(path.relative_to(source_root)), "test": "<module-import>", "status": "FAILED", "error": f"{type(exc).__name__}: {exc}"})
            continue
        for name, function in sorted(inspect.getmembers(module, inspect.isfunction)):
            if not name.startswith("test_"):
                continue
            t0 = time.perf_counter()
            try:
                params = inspect.signature(function).parameters
                if not params:
                    function()
                elif list(params) == ["tmp_path"]:
                    with tempfile.TemporaryDirectory(prefix="s3cpu-pytest-") as temp:
                        function(Path(temp))
                else:
                    raise RuntimeError(f"Unsupported fixture parameters: {list(params)}")
                results.append({"file": str(path.relative_to(source_root)), "test": name, "status": "PASSED", "durationSeconds": time.perf_counter() - t0})
            except Exception as exc:
                results.append({"file": str(path.relative_to(source_root)), "test": name, "status": "FAILED", "durationSeconds": time.perf_counter() - t0, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(limit=8)})
    passed = sum(r["status"] == "PASSED" for r in results)
    failed = sum(r["status"] == "FAILED" for r in results)
    return {
        "runner": "stdlib-function-test-harness",
        "files": [str(p.relative_to(source_root)) for p in files],
        "total": len(results),
        "passed": passed,
        "failed": failed,
        "skipped": 0,
        "durationSeconds": time.perf_counter() - started,
        "results": results,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = run(args.source_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PYTHON TESTS: {payload['passed']}/{payload['total']} PASS")
    return 0 if payload["failed"] == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
