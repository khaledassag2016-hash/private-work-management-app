import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[2]/'src'/'python'))
from cpu_stats import percentile,summarize,evaluate

def rows(n,v=2.0): return [{"cpu_ms":v,"outcome":"ok"} for _ in range(n)]
def good(): return {"groups":{"cache_hit_round_1":rows(100),"cache_hit_round_2":rows(100),"cache_miss":rows(20)},"plan_free":True,"billing_absent":True,"security_reduced":False,"telemetry_official":True,"stable":True,"independent_reproducible_cpu_terminations":0,"negativeTests":{name:"PASS" for name in ("uid_not_allowed","unknown_kid","modified_signature","expired","audience","issuer","certificate_fetch","invalid_cache_metadata")}}
def test_percentile_interpolates(): assert percentile([1,2,3,4],.5)==2.5
def test_summary_fields(): assert summarize([1,2,11])["over_10ms"]==1
def test_pass_complete(): assert evaluate(good())["status"]=="PASS"
def test_incomplete_fails(): p=good();p['groups']['cache_miss']=rows(19);assert evaluate(p)["status"]=="FAIL"
def test_three_over_fails(): p=good();p['groups']['cache_hit_round_1'][-3:]=rows(3,10.1);assert evaluate(p)["status"]=="FAIL"
def test_p95_fails(): p=good();p['groups']['cache_miss']=rows(20,10.01);assert evaluate(p)["status"]=="FAIL"
def test_termination_fails(): p=good();p['groups']['cache_miss'][0]['outcome']='exceededCpu';assert evaluate(p)["status"]=="FAIL"
def test_repeated_termination_fails(): p=good();p['independent_reproducible_cpu_terminations']=2;assert evaluate(p)["status"]=="FAIL"
def test_no_billing_proof_fails(): p=good();p['billing_absent']=False;assert evaluate(p)["status"]=="FAIL"
def test_no_telemetry_fails(): p=good();p['telemetry_official']=False;assert evaluate(p)["status"]=="FAIL"
def test_security_reduction_fails(): p=good();p['security_reduced']=True;assert evaluate(p)["status"]=="FAIL"

def test_missing_negative_fails():
 p=good();p["negativeTests"]["issuer"]="FAIL";assert evaluate(p)["status"]=="FAIL"
