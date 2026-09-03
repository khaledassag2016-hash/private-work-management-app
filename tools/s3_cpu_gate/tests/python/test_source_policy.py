from pathlib import Path
ROOT=Path(__file__).parents[2]

def text(rel): return (ROOT/rel).read_text(encoding='utf-8')
def all_ps(): return [p for p in list((ROOT/'src').rglob('*.ps1'))+list((ROOT/'src').rglob('*.psm1')) if 'repository_payload' not in p.parts]
def test_all_powershell_strict(): assert all('Set-StrictMode -Version Latest' in p.read_text(encoding='utf-8') for p in all_ps())
def test_no_set_execution_policy(): assert all('Set-ExecutionPolicy' not in p.read_text(encoding='utf-8') for p in all_ps())
def test_no_force_push(): assert 'force-push' not in text('src/modules/Repository.psm1') and "'--force'" not in text('src/modules/Repository.psm1')
def test_no_merge_command(): assert "'merge'" not in text('src/modules/Repository.psm1')
def test_no_close_issue_command(): assert "issue','close" not in text('src/modules/Repository.psm1')
def test_draft_pr_required(): assert "'--draft'" in text('src/modules/Repository.psm1')
def test_fixed_branch(): assert 'stage-3/identity-database-audit' in text('src/modules/Repository.psm1')
def test_fixed_repo(): assert 'khaledassag2016-hash/private-work-management-app' in text('src/modules/Repository.psm1')
def test_worker_rs256(): assert "header.alg !== 'RS256'" in text('src/worker/src/index.js')
def test_worker_kid(): assert 'KID_UNKNOWN' in text('src/worker/src/index.js')
def test_worker_audience(): assert 'AUD_INVALID' in text('src/worker/src/index.js')
def test_worker_issuer(): assert 'ISS_INVALID' in text('src/worker/src/index.js')
def test_worker_exp(): assert 'EXP_INVALID' in text('src/worker/src/index.js')
def test_worker_iat(): assert 'IAT_INVALID' in text('src/worker/src/index.js')
def test_worker_auth_time(): assert 'AUTH_TIME_INVALID' in text('src/worker/src/index.js')
def test_worker_sub(): assert 'SUB_INVALID' in text('src/worker/src/index.js')
def test_worker_d1_allowlist(): assert 'SELECT uid, role, auth_valid_since FROM app_users WHERE uid = ?1 AND active = 1' in text('src/worker/src/index.js')
def test_worker_no_guest(): assert 'guest' not in text('src/worker/src/index.js').lower()
def test_worker_no_token_log():
 lines=[line.lower() for line in text('src/worker/src/index.js').splitlines() if 'console.log' in line]
 assert all('auth.slice' not in line and 'token' not in line for line in lines)
def test_cloudflare_no_zero_trust(): assert 'zero trust' not in text('src/modules/Cloudflare.psm1').lower()
def test_cloudflare_no_paid_services():
 s=text('src/modules/Cloudflare.psm1').lower();assert all(x not in s for x in ('durable_objects','kv_namespaces','r2_buckets','queues'))
def test_firebase_memory_only(): assert 'RuntimeSecrets' in text('src/modules/Firebase.psm1') and 'firebaseRuntime' not in text('src/modules/Firebase.psm1')
def test_cleanup_unconditional_hook(): assert 'Test-S3HasOwnedCloudResource' in text('src/S3-CpuGate-Orchestrator.ps1')
def test_state_rejects_secret_fields(): assert 'رفض حفظ state.json' in text('src/modules/Common.psm1')
def test_setup_has_process_only_bypass(): assert 'ExecutionPolicy Bypass' in text('src/START.cmd')
def test_no_env_file(): assert not any(p.name.startswith('.env') for p in ROOT.rglob('*') if p.is_file())
def test_no_service_account_json(): assert not any('service' in p.name.lower() and 'account' in p.name.lower() and p.suffix=='.json' for p in ROOT.rglob('*'))
def test_required_docs_exist():
 for name in ('CAPABILITY-MATRIX.md','SOURCE-VERIFICATION.md','ARCHITECTURE.md','SECURITY-REVIEW.md','USER-GUIDE-AR.md','KNOWN-LIMITATIONS.md'):assert (ROOT/'docs'/name).is_file()
