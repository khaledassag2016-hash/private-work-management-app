BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'Operational regression coverage' {
 It 'normalizes JSON resume state for mutable resource and result writes' {
  $state=[ordered]@{
   schemaVersion=2;runId='s3cpu-resume-test';mode='Simulation';currentState='40_PRE_CLOUD_GATE'
   completed=@('00_PACKAGE_READY','10_LOCAL_PREREQUISITES','20_REPOSITORY_GATE','30_BRANCH_AND_DRAFT_PR','40_PRE_CLOUD_GATE')
   resources=[ordered]@{};results=[ordered]@{};failure=$null
  }
  $state|ConvertTo-Json -Depth 20|Set-Content (Join-Path $TestDrive 'state.json') -Encoding UTF8
  $loaded=Read-S3State -Root $TestDrive
  {Set-S3MapValue -Map $loaded.resources -Name 'firebase' -Value ([ordered]@{marker='s3cpu-resume-test'});Set-S3MapValue -Map $loaded.results -Name 'firebase' -Value ([ordered]@{status='SIMULATED'})}|Should -Not -Throw
  (Get-S3MapValue -Map $loaded.resources -Name 'firebase').marker|Should -Be 's3cpu-resume-test'
 }
 It 'persists the Simulation Firebase result without a secret-field rejection' {
  $c=Get-TestContext
  $firebase=Invoke-S3FirebaseProvision $c
  Set-S3MapValue -Map $c.State.results -Name 'firebase' -Value $firebase
  {Write-S3State -Root $TestDrive -State $c.State}|Should -Not -Throw
  $firebase.secrets|Should -Be 'MEMORY_ONLY'
  (Get-Content (Join-Path $TestDrive 'state.json') -Raw)|Should -Not -Match '"idTokens"'
 }
 It 'cleans a Firebase-only partial run without treating absent Cloudflare as an error' {
  $c=Get-TestContext
  Invoke-S3FirebaseProvision $c|Out-Null
  $cleanup=Invoke-S3Cleanup $c
  $cleanup.status|Should -Be 'PASS'
  $cleanup.cloudflare.status|Should -Be 'NOT_CREATED'
  $cleanup.firebase.status|Should -Be 'DELETE_REQUESTED'
  Test-Path (Join-Path $TestDrive 'reports\resource-destruction.json')|Should -BeTrue
 }
 It 'writes a complete cleanup report when a resource ownership check fails' {
  $c=Get-TestContext
  Set-S3MapValue -Map $c.State.resources -Name 'cloudflare' -Value ([ordered]@{worker='s3cpu-wrong-worker';d1Name='s3cpu-wrong-d1';marker='wrong'})
  $cleanup=Invoke-S3Cleanup $c
  $cleanup.status|Should -Be 'FAIL'
  $cleanup.cloudflare.status|Should -Be 'FAILED'
  $cleanup.firebase.status|Should -Be 'NOT_CREATED'
  (Get-Content (Join-Path $TestDrive 'reports\resource-destruction.md') -Raw)|Should -Match 'Cloudflare: FAILED'
 }
 It 'preserves the original failure reason when state serialization is rejected' {
  $c=Get-TestContext
  $secretField=('id'+'Token');$unsafe=[ordered]@{};$unsafe[$secretField]='synthetic'
  Set-S3MapValue -Map $c.State.results -Name 'unsafeTestValue' -Value $unsafe
  $evidence=Write-S3FailureEvidence -Context $c -Reason 'ORIGINAL_FAILURE'
  $evidence.stateSaved|Should -BeFalse
  $fallback=Get-Content (Join-Path $TestDrive 'reports\failure-fallback.json') -Raw|ConvertFrom-Json
  $fallback.reason|Should -Be 'ORIGINAL_FAILURE'
 }
 It 'preserves the E2E runtime directory only when a scenario fails' {
  $e2eCandidates=@(
   (Join-Path $SourceRoot '..\validation\Invoke-E2EScenarios.ps1')
   (Join-Path $SourceRoot 'validation\Invoke-E2EScenarios.ps1')
  )
  $e2ePath=$e2eCandidates|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1
  $e2ePath|Should -Not -BeNullOrEmpty
  $text=Get-Content -LiteralPath $e2ePath -Raw
  $text|Should -Match '\[string\]\$FixedRoot'
  $text|Should -Match "\`$result\.status -eq 'PASS'.*\`$RuntimeRoot"
 }
}

Describe 'B5 Cloudflare read-only preflight' -Tag 'B5' {
 It 'selects one correct account only when the ID is explicit' {$a=Select-S3CloudflareAccount -Accounts @([ordered]@{id='account-a'}) -SelectedAccountId account-a;$a.id|Should -Be account-a}
 It 'refuses multiple accounts without selection' {{Select-S3CloudflareAccount -Accounts @([ordered]@{id='a'},[ordered]@{id='b'})}|Should -Throw '*MULTIPLE_CLOUDFLARE_ACCOUNTS*'}
 It 'refuses an Account ID that is not listed' {{Select-S3CloudflareAccount -Accounts @([ordered]@{id='a'}) -SelectedAccountId missing}|Should -Throw '*NOT_FOUND*'}
 It 'fails incomplete account pagination' {Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=@(1..50|ForEach-Object{[ordered]@{id="a$_"}})}} -ModuleName Cloudflare;{Get-S3CloudflareAccounts -Token token}|Should -Throw '*PAGINATION_METADATA_MISSING*'}
 It 'blocks a paid subscription' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='active';price=5})}|Should -Throw '*PAID_SUBSCRIPTION*'}
 It 'blocks a Trial subscription' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='trial'})}|Should -Throw '*TRIAL_SUBSCRIPTION*'}
 It 'blocks AwaitingPayment' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='AwaitingPayment'})}|Should -Throw '*AWAITING_PAYMENT*'}
 It 'blocks an inconclusive Alpha PayGo result' {{Test-S3CloudflarePayGo -PayGoResult ([ordered]@{alpha=$true;status='alpha'})}|Should -Throw '*PAYGO_UNKNOWN*'}
 It 'blocks unknown Workers settings' {{Test-S3WorkersAccountSettings -Settings ([ordered]@{})}|Should -Throw '*WORKERS_SETTINGS_UNKNOWN*'}
 It 'blocks unauthorized Workers Observability' {Mock Invoke-S3CloudflareRest {throw '403 forbidden'} -ModuleName Cloudflare;{Test-S3WorkersObservabilityAuthorization -AccountId account -Token token}|Should -Throw}
 It 'blocks a missing workers.dev subdomain' {{Test-S3WorkersDevSubdomain -SubdomainResult ([ordered]@{subdomain='';enabled=$false})}|Should -Throw '*WORKERS_DEV_SUBDOMAIN_UNAVAILABLE*'}
 It 'stops when the user cancels the Arabic attestation' {$r=Confirm-S3CloudflareBillingAttestation -ReadChoice {'2'};$r.status|Should -Be CANCELLED;$r.accepted|Should -BeFalse}
 It 'accepts only the affirmative Arabic attestation' {$r=Confirm-S3CloudflareBillingAttestation -ReadChoice {'1'};$r.status|Should -Be YES;$r.accepted|Should -BeTrue}
 It 'places the preflight before Firebase and stops failures before it' {$source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw;$preflight=$source.IndexOf('Invoke-S3CloudflareReadOnlyPreflight');$firebase=$source.IndexOf('Invoke-S3FirebaseProvision');$preflight|Should -BeGreaterThan -1;$firebase|Should -BeGreaterThan $preflight;$source|Should -Match "if\(\`$preflight.status -ne 'PASS'\)"}
 It 'rejects every Cloudflare write API call' {Mock Invoke-RestMethod {throw 'must not run'} -ModuleName Cloudflare;{Invoke-S3CloudflareRest -Method POST -Uri 'https://api.cloudflare.com/client/v4/accounts/a/workers/scripts' -Token token -Body @{}}|Should -Throw '*CLOUDFLARE_WRITE_API_FORBIDDEN*';Should -Invoke Invoke-RestMethod -ModuleName Cloudflare -Times 0 -Exactly}
 It 'does not use the deprecated Billing Profile API' {$source=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw;$source|Should -Not -Match '(?i)billing/profile|billing profile api'}
 It 'completes a fully mocked accepted preflight without cloud writes' {
  $c=Get-TestContext Live
  Mock Test-S3CloudflareSession {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Get-S3CloudflareAccounts {[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
  Mock Invoke-S3CloudflarePagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
  Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Invoke-S3CloudflareRest {param($Method,$Uri)[void]$Method;if($Uri -match 'paygo'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}}elseif($Uri -match 'account-settings'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}}}elseif($Uri -match 'subdomain'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}}}else{[pscustomobject]@{success=$true;errors=@();result=@()}}} -ModuleName Cloudflare
  Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare
  $r=Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token token -AttestationChoice {'1'} -SkipOpenBillingPage
  $r.status|Should -Be PASS;$r.attestation|Should -Be YES;$c.State.resources.Count|Should -Be 0
 }
}
