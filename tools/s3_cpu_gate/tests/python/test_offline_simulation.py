import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[2]/'src'/'python'))
from offline_simulation import simulate,STATES

def test_full_simulation_reaches_report(tmp_path): assert simulate(tmp_path)['currentState']=='90_REPORT_READY'
def test_state_order_is_fixed(): assert STATES[0]=='00_PACKAGE_READY' and STATES[-1]=='90_REPORT_READY'
def test_simulation_uses_expected_branch(tmp_path): assert simulate(tmp_path)['resources']['branch']['name']=='stage-3/identity-database-audit'
def test_simulation_uses_draft_pr_placeholder(tmp_path): assert simulate(tmp_path)['resources']['draftPr']['number']==999
def test_simulation_has_two_users(tmp_path): assert simulate(tmp_path)['resources']['firebase']['users']==2
def test_simulation_has_no_billing(tmp_path): assert simulate(tmp_path)['resources']['firebase']['billing'] is False
def test_simulation_cpu_passes(tmp_path): assert simulate(tmp_path)['results']['cpu']['status']=='PASS'
def test_simulation_deletes_firebase(tmp_path): assert simulate(tmp_path)['resources']['firebase']['deleted'] is True
def test_simulation_deletes_cloudflare(tmp_path): assert simulate(tmp_path)['resources']['cloudflare']['deleted'] is True
def test_failure_still_deletes_firebase(tmp_path): assert simulate(tmp_path,'60_CLOUDFLARE_PROVISIONED')['resources']['firebase']['deleted'] is True
def test_failure_still_deletes_cloudflare(tmp_path): assert simulate(tmp_path,'60_CLOUDFLARE_PROVISIONED')['resources']['cloudflare']['deleted'] is True
def test_failure_does_not_claim_report_ready(tmp_path): assert simulate(tmp_path,'60_CLOUDFLARE_PROVISIONED')['currentState']!='90_REPORT_READY'
def test_cpu_decision_fail_preserves_checkpoint_and_blocks_cleanup_report(tmp_path):
    result=simulate(tmp_path,'CPU_GATE_DECISION_FAILED')
    assert result['currentState']=='60_CLOUDFLARE_PROVISIONED'
    assert result['results']['cpu']['status']=='FAIL'
    assert result['failure']=='CPU_GATE_DECISION_FAILED'
    assert 'deleted' not in result['resources']['firebase']
    assert 'deleted' not in result['resources']['cloudflare']
    assert not (tmp_path/'reports'/'simulation.json').exists()
