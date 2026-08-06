#!/usr/bin/env python3
"""Offline end-to-end model. It never opens network connections or cloud accounts."""
from __future__ import annotations
import argparse, json, uuid
from pathlib import Path
from cpu_stats import evaluate
from secret_scan import scan

STATES=("00_PACKAGE_READY","10_LOCAL_PREREQUISITES","20_REPOSITORY_GATE","30_BRANCH_AND_DRAFT_PR","40_PRE_CLOUD_GATE","50_FIREBASE_PROVISIONED","60_CLOUDFLARE_PROVISIONED","70_CPU_GATE_EXECUTED","80_RESOURCES_DESTROYED","90_REPORT_READY")

def rows(count:int,base:float,cache:str):
    return [{"cpu_ms":base+(i%7)*.07,"wall_ms":20+(i%5)*.4,"outcome":"ok","cache_state":cache} for i in range(count)]

def simulate(root:Path, fail_at:str|None=None)->dict:
    run_id=f"s3cpu-simulation-{uuid.uuid4().hex[:8]}"
    state={"runId":run_id,"mode":"Simulation","currentState":STATES[0],"completed":[STATES[0]],"resources":{},"results":{},"failure":None}
    reports=root/"reports";artifacts=root/"artifacts";temp=root/"temp"
    for path in (reports,artifacts,temp):path.mkdir(parents=True,exist_ok=True)
    def advance(target:str):
        current=STATES.index(state["currentState"]);future=STATES.index(target)
        if future!=current+1:raise RuntimeError("INVALID_TRANSITION")
        state["currentState"]=target;state["completed"].append(target)
        if fail_at==target:raise RuntimeError(f"SIMULATED_FAILURE:{target}")
    try:
        state["results"]["tools"]={"status":"SIMULATED"};advance("10_LOCAL_PREREQUISITES")
        state["results"]["repository"]={"status":"PASS","commit":"f4951b9bc28bcf6547294174377d10b1fc7a6439","s1":"PASS","s2":"23/23 PASS"};advance("20_REPOSITORY_GATE")
        state["resources"]["branch"]={"name":"stage-3/identity-database-audit","marker":run_id};state["resources"]["draftPr"]={"number":999,"marker":run_id};advance("30_BRANCH_AND_DRAFT_PR")
        advance("40_PRE_CLOUD_GATE")
        state["resources"]["firebase"]={"projectId":f"{run_id}-firebase","marker":run_id,"billing":False,"users":2};advance("50_FIREBASE_PROVISIONED")
        state["resources"]["cloudflare"]={"worker":f"{run_id}-worker","d1Name":f"{run_id}-d1","marker":run_id,"billing":False};advance("60_CLOUDFLARE_PROVISIONED")
        negatives={name:"PASS" for name in ("uid_not_allowed","unknown_kid","modified_signature","expired","audience","issuer","certificate_fetch","invalid_cache_metadata")}
        payload={"groups":{"cache_hit_round_1":rows(100,2.1,"hit"),"cache_hit_round_2":rows(100,2.2,"hit"),"cache_miss":rows(20,4.5,"miss")},"plan_free":True,"billing_absent":True,"security_reduced":False,"telemetry_official":True,"stable":True,"independent_reproducible_cpu_terminations":0,"negativeTests":negatives}
        decision=evaluate(payload);state["results"]["cpu"]=decision;advance("70_CPU_GATE_EXECUTED")
    except Exception as exc:
        state["failure"]=str(exc)
    finally:
        # cleanup is unconditional for resources owned by this run
        for key in ("cloudflare","firebase"):
            resource=state["resources"].get(key)
            if resource and resource.get("marker")==run_id:resource["deleted"]=True
        if state["currentState"]=="70_CPU_GATE_EXECUTED" and not state["failure"]:advance("80_RESOURCES_DESTROYED")
        for item in temp.iterdir():
            if item.is_file():item.unlink()
    if state["currentState"]=="80_RESOURCES_DESTROYED":
        (reports/"simulation.json").write_text(json.dumps(state,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
        if scan(reports):raise RuntimeError("SECRET_SCAN_FAILED")
        advance("90_REPORT_READY")
    return state

def main()->int:
    parser=argparse.ArgumentParser();parser.add_argument("root",type=Path);parser.add_argument("--fail-at");args=parser.parse_args()
    result=simulate(args.root,args.fail_at);print(json.dumps(result,ensure_ascii=False,indent=2));return 0 if result["currentState"]=="90_REPORT_READY" else 2
if __name__=="__main__":raise SystemExit(main())
