#!/usr/bin/env python3
"""Deterministic CPU gate statistics and decision logic."""
from __future__ import annotations
import argparse, json, math
from pathlib import Path
from typing import Iterable, Any

LIMIT_MS = 10.0

def percentile(values: Iterable[float], q: float) -> float:
    xs = sorted(float(x) for x in values)
    if not xs:
        raise ValueError("empty sample")
    if not 0 <= q <= 1:
        raise ValueError("q outside [0,1]")
    pos = (len(xs) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return xs[lo]
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)

def summarize(values: Iterable[float]) -> dict[str, float | int]:
    xs = [float(x) for x in values]
    if not xs:
        raise ValueError("empty sample")
    return {
        "count": len(xs),
        "median_ms": percentile(xs, .50),
        "p95_ms": percentile(xs, .95),
        "p99_ms": percentile(xs, .99),
        "maximum_ms": max(xs),
        "over_10ms": sum(x > LIMIT_MS for x in xs),
    }

def evaluate(payload: dict[str, Any]) -> dict[str, Any]:
    groups = payload.get("groups") or {}
    required = {"cache_hit_round_1":100, "cache_hit_round_2":100, "cache_miss":20}
    reasons: list[str] = []
    summaries: dict[str, Any] = {}
    for name, expected in required.items():
        rows = groups.get(name)
        if not isinstance(rows, list) or len(rows) != expected:
            reasons.append(f"INCOMPLETE:{name}:{0 if not isinstance(rows,list) else len(rows)}/{expected}")
            continue
        cpu = []
        terminations = 0
        for row in rows:
            if row.get("cpu_ms") is None:
                reasons.append(f"MISSING_CPU:{name}")
                continue
            cpu.append(float(row["cpu_ms"]))
            if row.get("outcome") in {"exceededCpu", "terminated"} or row.get("terminated") is True:
                terminations += 1
        if len(cpu) != expected:
            reasons.append(f"INCOMPLETE_CPU:{name}:{len(cpu)}/{expected}")
            continue
        s = summarize(cpu); s["terminations"] = terminations; summaries[name] = s
        if terminations:
            reasons.append(f"CPU_TERMINATION:{name}:{terminations}")
        if s["over_10ms"] >= 3:
            reasons.append(f"THREE_OR_MORE_OVER_LIMIT:{name}:{s['over_10ms']}")
        if s["p95_ms"] > LIMIT_MS:
            reasons.append(f"P95_OVER_LIMIT:{name}:{s['p95_ms']:.6f}")
    repeated_termination = payload.get("independent_reproducible_cpu_terminations", 0)
    if int(repeated_termination) >= 2:
        reasons.append("REPRODUCIBLE_CPU_TERMINATION")
    if payload.get("plan_free") is not True:
        reasons.append("FREE_PLAN_NOT_PROVEN")
    if payload.get("billing_absent") is not True:
        reasons.append("BILLING_ABSENCE_NOT_PROVEN")
    if payload.get("security_reduced") is True:
        reasons.append("SECURITY_REDUCED")
    if payload.get("telemetry_official") is not True:
        reasons.append("OFFICIAL_CPU_TELEMETRY_NOT_PROVEN")
    if payload.get("stable") is not True:
        reasons.append("PATH_NOT_STABLE")
    negative = payload.get("negativeTests") or {}
    for name in ("uid_not_allowed", "unknown_kid", "modified_signature", "expired", "audience", "issuer", "certificate_fetch", "invalid_cache_metadata"):
        value = negative.get(name)
        passed = value == "PASS" or (isinstance(value, dict) and value.get("pass") is True)
        if not passed:
            reasons.append(f"NEGATIVE_TEST_FAILED:{name}")
    return {"status":"PASS" if not reasons else "FAIL", "reasons":sorted(set(reasons)), "summaries":summaries}

def main() -> int:
    p=argparse.ArgumentParser(); p.add_argument("input", type=Path); p.add_argument("output", type=Path)
    a=p.parse_args(); result=evaluate(json.loads(a.input.read_text(encoding="utf-8")))
    a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(result["status"]); return 0 if result["status"]=="PASS" else 2
if __name__ == "__main__": raise SystemExit(main())
