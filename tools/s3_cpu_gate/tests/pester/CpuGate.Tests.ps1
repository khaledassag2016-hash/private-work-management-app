BeforeAll {
 . (Join-Path $PSScriptRoot 'TestHelper.ps1')
function Get-TestPayload([double]$Hit=2,[double]$Miss=4){
 function Rows([int]$n,[double]$cpu){1..$n|ForEach-Object{@{cpu_ms=$cpu;wall_ms=10;outcome='ok';cache_state='hit'}}}
 @{groups=@{cache_hit_round_1=@(Rows 100 $Hit);cache_hit_round_2=@(Rows 100 $Hit);cache_miss=@(Rows 20 $Miss)};plan_free=$true;billing_absent=$true;telemetry_official=$true;security_reduced=$false;stable=$true;independent_reproducible_cpu_terminations=0;negativeTests=@{uid_not_allowed='PASS';unknown_kid='PASS';modified_signature='PASS';expired='PASS';audience='PASS';issuer='PASS';certificate_fetch='PASS';invalid_cache_metadata='PASS'}}
}
}
Describe 'CPU statistics' {
 It 'calculates median odd' { Get-S3Percentile @(1,2,3) .5 | Should -Be 2 }
 It 'calculates interpolated median even' { Get-S3Percentile @(1,2,3,4) .5 | Should -Be 2.5 }
 It 'calculates p95' { [math]::Round((Get-S3Percentile (1..100) .95),2) | Should -Be 95.05 }
 It 'rejects empty sample' { {Get-S3Percentile @() .5}|Should -Throw }
 It 'counts over 10ms strictly' { (Get-S3Statistic @(10,10.01,11)).over_10ms | Should -Be 2 }
 It 'passes complete healthy payload' { (Test-S3CpuDecision (Get-TestPayload)).status | Should -Be 'PASS' }
 It 'fails incomplete first hit group' { $p=Get-TestPayload;$p.groups.cache_hit_round_1=@($p.groups.cache_hit_round_1|Select-Object -First 99);(Test-S3CpuDecision $p).status|Should -Be 'FAIL' }
 It 'fails missing cache miss group' { $p=Get-TestPayload;$p.groups.cache_miss=@();(Test-S3CpuDecision $p).reasons -join ','|Should -Match 'INCOMPLETE' }
 It 'fails three over limit' { $p=Get-TestPayload;$p.groups.cache_hit_round_1[0].cpu_ms=11;$p.groups.cache_hit_round_1[1].cpu_ms=11;$p.groups.cache_hit_round_1[2].cpu_ms=11;(Test-S3CpuDecision $p).status|Should -Be 'FAIL' }
 It 'fails p95 over limit' { (Test-S3CpuDecision (Get-TestPayload -Hit 11)).reasons -join ','|Should -Match 'P95_OVER_LIMIT' }
 It 'fails one CPU termination' { $p=Get-TestPayload;$p.groups.cache_miss[0].outcome='exceededCpu';(Test-S3CpuDecision $p).status|Should -Be 'FAIL' }
 It 'fails reproducible termination count' { $p=Get-TestPayload;$p.independent_reproducible_cpu_terminations=2;(Test-S3CpuDecision $p).status|Should -Be 'FAIL' }
 It 'fails when free plan unproven' { $p=Get-TestPayload;$p.plan_free=$false;(Test-S3CpuDecision $p).reasons|Should -Contain 'FREE_PLAN_NOT_PROVEN' }
 It 'fails when billing absence unproven' { $p=Get-TestPayload;$p.billing_absent=$false;(Test-S3CpuDecision $p).reasons|Should -Contain 'BILLING_ABSENCE_NOT_PROVEN' }
 It 'fails when official telemetry unproven' { $p=Get-TestPayload;$p.telemetry_official=$false;(Test-S3CpuDecision $p).reasons|Should -Contain 'OFFICIAL_CPU_TELEMETRY_NOT_PROVEN' }
 It 'fails when security reduced' { $p=Get-TestPayload;$p.security_reduced=$true;(Test-S3CpuDecision $p).reasons|Should -Contain 'SECURITY_REDUCED' }
 It 'fails when path unstable' { $p=Get-TestPayload;$p.stable=$false;(Test-S3CpuDecision $p).reasons|Should -Contain 'PATH_NOT_STABLE' }
 It 'fails missing UID rejection test' { $p=Get-TestPayload;$p.negativeTests.uid_not_allowed='FAIL';(Test-S3CpuDecision $p).status|Should -Be 'FAIL' }
 It 'simulation produces PASS' { $c=Get-TestContext;(Invoke-S3CpuGate $c).status|Should -Be 'PASS' }
}

Describe 'Custom public base URI safety gate' {
 It 'accepts only a public HTTPS origin during Live resume at checkpoint 60' {
  $c=Get-TestContext Live;$c.IsResumed=$true;$c.State.currentState='60_CLOUDFLARE_PROVISIONED';$c.State.resources.cloudflare=[ordered]@{url='https://stored.workers.dev'}
  (Resolve-S3PublicBaseUri -Context $c -PublicBaseUri 'https://APP.ASSAGWORK.COM/')|Should -Be 'https://app.assagwork.com'
  (Resolve-S3PublicBaseUri -Context $c)|Should -Be 'https://stored.workers.dev'
  foreach($invalid in @('http://app.assagwork.com','https://app.assagwork.com:8443','https://user@app.assagwork.com','https://app.assagwork.com/path','https://app.assagwork.com/?q=1','https://app.assagwork.com/#fragment','https://127.0.0.1','https://localhost','https://app.invalid')){
   {Resolve-S3PublicBaseUri -Context $c -PublicBaseUri $invalid}|Should -Throw
  }
  $c.Mode='Simulation';{Resolve-S3PublicBaseUri -Context $c -PublicBaseUri 'https://app.assagwork.com'}|Should -Throw '*LIVE_ONLY*'
  $c.Mode='Live';$c.IsResumed=$false;{Resolve-S3PublicBaseUri -Context $c -PublicBaseUri 'https://app.assagwork.com'}|Should -Throw '*RESUME_ONLY*'
  $c.IsResumed=$true;$c.State.currentState='50_FIREBASE_PROVISIONED';{Resolve-S3PublicBaseUri -Context $c -PublicBaseUri 'https://app.assagwork.com'}|Should -Throw '*CHECKPOINT_60_REQUIRED*'
 }
 It 'proves the unauthenticated Worker identity contract without sending a token' {
  Mock Invoke-S3HttpRequest {param($Uri,$Token,$Headers);$Token|Should -BeNullOrEmpty;$Uri|Should -Be 'https://app.assagwork.com/private/ping';[pscustomobject]@{status=401;body=(@{ok=$false;code='TOKEN_MISSING';requestId=$Headers['x-s3-request-id']}|ConvertTo-Json -Compress)}} -ModuleName CpuGate
  (Assert-S3PublicEndpointIdentity -BaseUri 'https://app.assagwork.com').status|Should -Be 'PASS'
  Should -Invoke Invoke-S3HttpRequest -ModuleName CpuGate -Times 1 -Exactly
  Mock Invoke-S3HttpRequest {[pscustomobject]@{status=200;body='{"ok":true}'}} -ModuleName CpuGate
  {Assert-S3PublicEndpointIdentity -BaseUri 'https://app.assagwork.com'}|Should -Throw '*STATUS_MISMATCH*'
 }
 It 'routes the CPU gate to the verified override while keeping state unchanged' {
  $c=Get-TestContext Live;$c.IsResumed=$true;$c.State.currentState='60_CLOUDFLARE_PROVISIONED';$c.State.resources.cloudflare=[ordered]@{url='https://broken.workers.dev';accountId='account-a';worker='worker-a'};$c.RuntimeSecrets.token1='token-one';$c.RuntimeSecrets.token2='token-two';$c.RuntimeSecrets.testResetNonce='nonce';$c.RuntimeSecrets.cloudflareObservabilityToken='observability';$c.RuntimeSecrets.cloudflareToken='management'
  $before=$c.State|ConvertTo-Json -Depth 30 -Compress
  Mock Assert-S3CloudflareCustomDomainBinding {[ordered]@{status='PASS'}} -ModuleName CpuGate
  Mock Assert-S3PublicEndpointIdentity {[ordered]@{status='PASS'}} -ModuleName CpuGate
  Mock Invoke-S3AuditAcceptance {throw 'AUDIT_SENTINEL'} -ModuleName CpuGate
  {Invoke-S3CpuGate -Context $c -PublicBaseUri 'https://app.assagwork.com'}|Should -Throw '*AUDIT_SENTINEL*'
  Should -Invoke Assert-S3CloudflareCustomDomainBinding -ModuleName CpuGate -ParameterFilter {$AccountId -eq 'account-a' -and $WorkerName -eq 'worker-a' -and $PublicBaseUri -eq 'https://app.assagwork.com'} -Times 1 -Exactly
  Should -Invoke Assert-S3PublicEndpointIdentity -ModuleName CpuGate -ParameterFilter {$BaseUri -eq 'https://app.assagwork.com'} -Times 1 -Exactly
  Should -Invoke Invoke-S3AuditAcceptance -ModuleName CpuGate -ParameterFilter {$BaseUri -eq 'https://app.assagwork.com'} -Times 1 -Exactly
  ($c.State|ConvertTo-Json -Depth 30 -Compress)|Should -BeExactly $before
 }
 It 'routes every application request through the override and never calls the stored workers.dev origin' {
  $c=Get-TestContext Live;$c.IsResumed=$true;$c.State.currentState='60_CLOUDFLARE_PROVISIONED';$c.State.resources.cloudflare=[ordered]@{url='https://must-not-run.workers.dev';accountId='account-a';worker='worker-a';freePlan=$true;billingAbsent=$true};$c.RuntimeSecrets.token1='token-one';$c.RuntimeSecrets.token2='token-two';$c.RuntimeSecrets.testResetNonce='nonce';$c.RuntimeSecrets.cloudflareObservabilityToken='observability';$c.RuntimeSecrets.cloudflareToken='management'
  $script:applicationUris=[Collections.Generic.List[string]]::new()
  Mock Assert-S3CloudflareCustomDomainBinding {[ordered]@{status='PASS'}} -ModuleName CpuGate
  Mock Assert-S3PublicEndpointIdentity {[ordered]@{status='PASS'}} -ModuleName CpuGate
  Mock Invoke-S3AuditAcceptance {param($Context,$BaseUri,$Token1,$Token2,$Nonce);[void]$Context;[void]$Token1;[void]$Token2;[void]$Nonce;$script:applicationUris.Add($BaseUri);[ordered]@{status='PASS';dbSide=$true}} -ModuleName CpuGate
  Mock Invoke-S3HttpRequest {param($Uri);$script:applicationUris.Add([string]$Uri);[pscustomobject]@{status=200;body='{"ok":true}'}} -ModuleName CpuGate
  Mock Invoke-S3TrackedRequestGroup {param($Uri);$script:applicationUris.Add([string]$Uri);@()} -ModuleName CpuGate
  Mock Wait-S3WorkersTelemetry {[ordered]@{status='PASS';records=@()}} -ModuleName CpuGate
  Mock Invoke-S3NegativeTest {param($Context,$Uri,$Token1,$Token2);[void]$Context;[void]$Token1;[void]$Token2;$script:applicationUris.Add([string]$Uri);[ordered]@{uid_not_allowed='PASS';unknown_kid='PASS';modified_signature='PASS';expired='PASS';audience='PASS';issuer='PASS';certificate_fetch='PASS';invalid_cache_metadata='PASS'}} -ModuleName CpuGate
  Mock Set-S3WorkerTestVariable {} -ModuleName CpuGate
  $result=Invoke-S3CpuGate -Context $c -PublicBaseUri 'https://app.assagwork.com'
  $result.status|Should -Be 'FAIL'
  $script:applicationUris.Count|Should -Be 25
  @($script:applicationUris|Where-Object{$_ -notin @('https://app.assagwork.com','https://app.assagwork.com/private/ping')}).Count|Should -Be 0
  @($script:applicationUris|Where-Object{$_ -match '(?i)workers\.dev'}).Count|Should -Be 0
  Should -Invoke Invoke-S3HttpRequest -ModuleName CpuGate -ParameterFilter {$Uri -eq 'https://app.assagwork.com/private/ping'} -Times 20 -Exactly
  Should -Invoke Invoke-S3TrackedRequestGroup -ModuleName CpuGate -ParameterFilter {$Uri -eq 'https://app.assagwork.com/private/ping'} -Times 3 -Exactly
  Should -Invoke Invoke-S3NegativeTest -ModuleName CpuGate -ParameterFilter {$Uri -eq 'https://app.assagwork.com/private/ping'} -Times 1 -Exactly
 }
 It 'blocks every authenticated request when custom-domain binding proof fails' {
  $c=Get-TestContext Live;$c.IsResumed=$true;$c.State.currentState='60_CLOUDFLARE_PROVISIONED';$c.State.resources.cloudflare=[ordered]@{url='https://broken.workers.dev';accountId='account-a';worker='worker-a'};$c.RuntimeSecrets.token1='token-one';$c.RuntimeSecrets.token2='token-two';$c.RuntimeSecrets.testResetNonce='nonce';$c.RuntimeSecrets.cloudflareObservabilityToken='observability';$c.RuntimeSecrets.cloudflareToken='management'
  Mock Assert-S3CloudflareCustomDomainBinding {throw 'CUSTOM_DOMAIN_NOT_BOUND_TO_EXPECTED_WORKER'} -ModuleName CpuGate
  Mock Assert-S3PublicEndpointIdentity {throw 'MUST_NOT_RUN'} -ModuleName CpuGate
  Mock Invoke-S3AuditAcceptance {throw 'MUST_NOT_RUN'} -ModuleName CpuGate
  Mock Invoke-S3HttpRequest {throw 'MUST_NOT_RUN'} -ModuleName CpuGate
  {Invoke-S3CpuGate -Context $c -PublicBaseUri 'https://app.assagwork.com'}|Should -Throw '*CUSTOM_DOMAIN_NOT_BOUND_TO_EXPECTED_WORKER*'
  Should -Invoke Assert-S3PublicEndpointIdentity -ModuleName CpuGate -Times 0 -Exactly
  Should -Invoke Invoke-S3AuditAcceptance -ModuleName CpuGate -Times 0 -Exactly
  Should -Invoke Invoke-S3HttpRequest -ModuleName CpuGate -Times 0 -Exactly
 }
}

Describe 'B2 Workers Observability telemetry query' -Tag 'B2' {
 BeforeAll {
  function Get-B2ExpectedFixture([string[]]$Ids,[string]$Scenario='scenario-a'){@($Ids|ForEach-Object{[ordered]@{runId='run-b2';requestId=$_;scenario=$Scenario}})}
  function Get-B2RecordFixture([string]$RequestId,[string]$Scenario='scenario-a',[object]$Cpu=2.5,[object]$Wall=8.0,[string]$Outcome='ok',[string]$RunId='run-b2',[string]$CloudflareRequestId=''){
   if([string]::IsNullOrWhiteSpace($CloudflareRequestId)){$CloudflareRequestId="cf-$RequestId"}
   [ordered]@{runId=$RunId;requestId=$RequestId;scenario=$Scenario;cloudflareRequestId=$CloudflareRequestId;cpu_ms=$Cpu;wall_ms=$Wall;outcome=$Outcome;cache_state='hit';hasCorrelation=$true;hasInvocation=$true;duplicateCorrelation=$false;duplicateInvocation=$false}
  }
  function Get-B2QueryResultFixture([object[]]$Records){[ordered]@{status='PASS';records=$Records;pageCount=1;paginationComplete=$true;truncated=$false;samplingDetected=$false;apiSuccess=$true;errors=@()}}
  function Get-B2OfficialTelemetryEvent([string]$RequestId,[string]$EventId,[double]$Cpu,[double]$Wall){
   [ordered]@{
    '$metadata'=[ordered]@{id=$EventId;requestId="cf-$RequestId";account='account';cloudService='workers'}
    '$workers'=[ordered]@{requestId="cf-$RequestId";cpuTimeMs=$Cpu;wallTimeMs=$Wall;outcome='ok';eventType='fetch';scriptName='s3-worker'}
    dataset='cloudflare-workers';source=[ordered]@{event='s3_correlation';cacheState='hit';s3Correlation=[ordered]@{runId='run-b2';requestId=$RequestId;scenario='scenario-a'}};timestamp=1760000000000
   }
  }
 }
 It 'accepts a complete correlated telemetry response' {$e=Get-B2ExpectedFixture @('a','b');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'),(Get-B2RecordFixture 'b'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).status|Should -Be 'PASS'}
 It 'merges separate custom and invocation events by Cloudflare request ID' {
  $custom=[ordered]@{'$metadata'=[ordered]@{id='custom-a';requestId='cf-a';type='cf-worker'};'$workers'=[ordered]@{requestId='cf-a';eventType='fetch';scriptName='s3-worker'};source=[ordered]@{event='auth_result';cacheState='hit';s3Correlation=[ordered]@{runId='run-b2';requestId='a';scenario='scenario-a'}}}
  $invocation=[ordered]@{'$metadata'=[ordered]@{id='invoke-a';requestId='cf-a';type='cf-worker-event'};'$workers'=[ordered]@{requestId='cf-a';cpuTimeMs=2.5;wallTimeMs=8;outcome='ok';eventType='fetch'}}
  $records=@(Merge-S3WorkerTelemetryEvent -Items @($invocation,$custom) -RunId 'run-b2' -Scenario 'scenario-a');$records.Count|Should -Be 1;$records[0].cpu_ms|Should -Be 2.5;$records[0].cache_state|Should -Be 'hit';$records[0].hasCorrelation|Should -BeTrue;$records[0].hasInvocation|Should -BeTrue;$records[0].duplicateInvocation|Should -BeFalse
 }
 It 'ignores unrelated warmup/reset/audit events' {
  $custom=[ordered]@{'$metadata'=[ordered]@{id='custom-a';requestId='cf-a'};source=[ordered]@{cacheState='hit';s3Correlation=[ordered]@{runId='run-b2';requestId='a';scenario='scenario-a'}}}
  $invocation=[ordered]@{'$metadata'=[ordered]@{id='invoke-a';requestId='cf-a'};'$workers'=[ordered]@{requestId='cf-a';cpuTimeMs=2.5;wallTimeMs=8;outcome='ok';eventType='fetch'}}
  $unrelated=[ordered]@{'$metadata'=[ordered]@{id='warmup';requestId='cf-warmup'};'$workers'=[ordered]@{requestId='cf-warmup';cpuTimeMs=1;wallTimeMs=5;outcome='ok';eventType='fetch'}}
  $q=Get-B2QueryResultFixture @(@(Merge-S3WorkerTelemetryEvent -Items @($unrelated,$invocation,$custom) -RunId 'run-b2' -Scenario 'scenario-a'));$r=Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' (Get-B2ExpectedFixture @('a')) $q;$r.status|Should -Be 'PASS'
 }
 It 'fails a correlated event missing its invocation record' {
  $custom=[ordered]@{'$metadata'=[ordered]@{id='custom-a';requestId='cf-a'};source=[ordered]@{cacheState='hit';s3Correlation=[ordered]@{runId='run-b2';requestId='a';scenario='scenario-a'}}}
  $q=Get-B2QueryResultFixture @(@(Merge-S3WorkerTelemetryEvent -Items @($custom) -RunId 'run-b2' -Scenario 'scenario-a'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' (Get-B2ExpectedFixture @('a')) $q).reasons|Should -Contain 'INVOCATION_RECORD_MISSING:a'
 }
 It 'fails duplicate correlated events for one invocation' {
  $custom1=[ordered]@{'$metadata'=[ordered]@{id='custom-a1';requestId='cf-a'};source=[ordered]@{cacheState='hit';s3Correlation=[ordered]@{runId='run-b2';requestId='a';scenario='scenario-a'}}}
  $custom2=[ordered]@{'$metadata'=[ordered]@{id='custom-a2';requestId='cf-a'};source=[ordered]@{cacheState='hit';s3Correlation=[ordered]@{runId='run-b2';requestId='a';scenario='scenario-a'}}}
  $invocation=[ordered]@{'$metadata'=[ordered]@{id='invoke-a';requestId='cf-a'};'$workers'=[ordered]@{requestId='cf-a';cpuTimeMs=2.5;wallTimeMs=8;outcome='ok';eventType='fetch'}}
  $q=Get-B2QueryResultFixture @(@(Merge-S3WorkerTelemetryEvent -Items @($custom1,$custom2,$invocation) -RunId 'run-b2' -Scenario 'scenario-a'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' (Get-B2ExpectedFixture @('a')) $q).reasons|Should -Contain 'DUPLICATE_CORRELATION:a'
 }
 It 'fails an extra current-run correlated request ID' {
  $a=[ordered]@{runId='run-b2';requestId='a';scenario='scenario-a';cloudflareRequestId='cf-a';cpu_ms=2;wall_ms=8;outcome='ok';cache_state='hit';hasCorrelation=$true;hasInvocation=$true;duplicateCorrelation=$false;duplicateInvocation=$false}
  $extra=[ordered]@{runId='run-b2';requestId='extra';scenario='scenario-a';cloudflareRequestId='cf-extra';cpu_ms=2;wall_ms=8;outcome='ok';cache_state='hit';hasCorrelation=$true;hasInvocation=$true;duplicateCorrelation=$false;duplicateInvocation=$false}
  $q=Get-B2QueryResultFixture @($a,$extra);(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' (Get-B2ExpectedFixture @('a')) $q).reasons|Should -Contain 'EXTRA_REQUEST_ID'
 }
 It 'rejects non-200 or ok=false positive HTTP responses' {
  {Assert-S3HttpPositiveResponse -Response ([pscustomobject]@{status=201;body='{"ok":true}'}) -Name positive}|Should -Throw '*HTTP_POSITIVE_FAILED*'
  {Assert-S3HttpPositiveResponse -Response ([pscustomobject]@{status=200;body='{"ok":false}'}) -Name positive}|Should -Throw '*HTTP_OK_FALSE*'
 }
 It 'fails missing telemetry' {$e=Get-B2ExpectedFixture @('a','b');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'MISSING_REQUEST_ID'}
 It 'fails a duplicate Request ID' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'),(Get-B2RecordFixture 'a' -CloudflareRequestId 'cf-a-2'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'DUPLICATE_REQUEST_ID'}
 It 'fails missing or nonnumeric CPU time' {$e=Get-B2ExpectedFixture @('a','b');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Cpu $null),(Get-B2RecordFixture 'b' -Cpu 'bad'));$r=Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q;@($r.reasons|Where-Object{$_ -match 'CPU_TIME_INVALID'}).Count|Should -Be 2}
 It 'fails missing wall time' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Wall $null));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'WALL_TIME_INVALID'}
 It 'fails missing outcome' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Outcome ''));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'OUTCOME_MISSING'}
 It 'fails missing Cloudflare request ID' {$e=Get-B2ExpectedFixture @('a');$x=Get-B2RecordFixture 'a';$x.cloudflareRequestId='';$q=Get-B2QueryResultFixture @($x);(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'CLOUDFLARE_REQUEST_ID_MISSING'}
 It 'fails truncation' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'));$q.truncated=$true;(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons|Should -Contain 'TELEMETRY_TRUNCATED'}
 It 'fails sampling or unacceptable abr_level' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'));$q.samplingDetected=$true;(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons|Should -Contain 'TELEMETRY_SAMPLING_DETECTED'}
 It 'fails when response statistics report ABR above one' {
  Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{statistics=[pscustomobject]@{abr_level=2};events=[pscustomobject]@{events=@()}}}} -ModuleName Cloudflare
  $q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z');$q.status|Should -Be 'FAIL';$q.samplingDetected|Should -BeTrue;$q.abrLevel|Should -Be 2
 }
 It 'uses the current schema and reads all telemetry pagination pages' {
  $script:page=0
  $script:firstFrom=$null;$script:firstTo=$null
  Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token,$Body)
   [void]$Method;[void]$Uri;[void]$Token
   $Body.queryId | Should -Be 's3cpu-run-b2-scenario-a';[int]$Body.limit | Should -BeLessOrEqual 100;$Body.timeframe.from | Should -BeOfType [long];$Body.timeframe.to | Should -BeGreaterThan $Body.timeframe.from;$Body.dry | Should -BeTrue;$Body.parameters.datasets | Should -Contain 'cloudflare-workers';$Body.parameters.filters.Count | Should -Be 1;$Body.parameters.filters[0].key | Should -Be '$metadata.service';$Body.parameters.filters[0].operation | Should -Be 'eq';$Body.parameters.filters[0].value | Should -Be 's3-worker';$Body.PSObject.Properties.Name | Should -Not -Contain 'page';$Body.PSObject.Properties.Name | Should -Not -Contain 'cursor'
   if($script:page -eq 0){$script:firstFrom=$Body.timeframe.from;$script:firstTo=$Body.timeframe.to}else{$Body.timeframe.from|Should -Be $script:firstFrom;$Body.timeframe.to|Should -Be $script:firstTo}
   $script:page++
   if($script:page -eq 1){[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{count=3;events=@((Get-B2OfficialTelemetryEvent 'a' 'event-a' 2 8),(Get-B2OfficialTelemetryEvent 'b' 'event-b' 3 9))}}}}
   elseif($script:page -eq 2){$Body.offset | Should -Be 'event-b';[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{events=@((Get-B2OfficialTelemetryEvent 'c' 'event-c' 4 10))}}}}
  } -ModuleName Cloudflare
  $q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z');$q.status|Should -Be 'PASS';$q.pageCount|Should -Be 2;$q.records.Count|Should -Be 3;$q.records[0].requestId|Should -Be 'a';$q.records[1].cloudflareRequestId|Should -Be 'cf-b';$q.records[2].scenario|Should -Be 'scenario-a';(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' (Get-B2ExpectedFixture @('a','b','c')) $q).status|Should -Be 'PASS'
 }
 It 'treats events count as the current page count when paginating full pages' {
  $script:page=0
  Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token,$Body);[void]$Method;[void]$Uri;[void]$Token;$Body.limit|Should -Be 2;$script:page++
   if($script:page -eq 1){[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{count=2;events=@((Get-B2OfficialTelemetryEvent 'a' 'event-a' 2 8),(Get-B2OfficialTelemetryEvent 'b' 'event-b' 3 9))}}}}
   elseif($script:page -eq 2){$Body.offset|Should -Be 'event-b';[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{count=1;events=@((Get-B2OfficialTelemetryEvent 'c' 'event-c' 4 10))}}}}
  } -ModuleName Cloudflare
  $q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z') -PageSize 2;$q.status|Should -Be 'PASS';$q.pageCount|Should -Be 2;$q.rawCount|Should -Be 3;$q.records.Count|Should -Be 3
 }
 It 'uses local conservative page size 100 and rejects values above the local cap' {
  $body=Get-S3WorkersObservabilityQueryBody -QueryId q -FromUtc ([DateTime]'2026-08-05T07:59:00Z') -ToUtc ([DateTime]'2026-08-05T08:00:00Z');$body.limit|Should -Be 100
  {Get-S3WorkersObservabilityQueryBody -QueryId q -FromUtc ([DateTime]'2026-08-05T07:59:00Z') -ToUtc ([DateTime]'2026-08-05T08:00:00Z') -Limit 101}|Should -Throw
  {Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z') -PageSize 101}|Should -Throw
 }
 It 'paginates safely when the response exceeds the local page size' {
  $script:page=0
  Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token,$Body);[void]$Method;[void]$Uri;[void]$Token;[int]$Body.limit|Should -Be 100;$script:page++
   if($script:page -eq 1){[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{count=101;events=@(1..100|ForEach-Object{Get-B2OfficialTelemetryEvent "a$_" "event-$_" 2 8})}}}}
   elseif($script:page -eq 2){$Body.offset|Should -Be 'event-100';[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{events=@((Get-B2OfficialTelemetryEvent 'a101' 'event-101' 2 8))}}}}
  } -ModuleName Cloudflare
  $q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z');$q.status|Should -Be 'PASS';$q.pageCount|Should -Be 2;$q.rawCount|Should -Be 101;$q.records.Count|Should -Be 101
 }
 It 'accepts an optional missing event count when the page is short' {Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{events=[pscustomobject]@{events=@()}}}} -ModuleName Cloudflare;$q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z');$q.status|Should -Be 'PASS';$q.paginationComplete|Should -BeTrue;$q.errors.Count|Should -Be 0}
 It 'fails an API error' {Mock Invoke-S3CloudflareRest {throw 'mock api error'} -ModuleName Cloudflare;$q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z');$q.status|Should -Be 'FAIL';$q.apiSuccess|Should -BeFalse}
 It 'fails after the bounded telemetry timeout' {$e=Get-B2ExpectedFixture @('a');Mock Invoke-S3WorkersTelemetryQuery {Get-B2QueryResultFixture @()} -ModuleName CpuGate;$fixed=[DateTime]'2026-08-05T08:00:00Z';$r=Wait-S3WorkersTelemetry -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -ExpectedRequests $e -WorkerName s3-worker -FromUtc ([DateTime]'2026-08-05T07:59:00Z') -TimeoutSeconds 0 -RetryDelaySeconds 0 -Now {$fixed} -Sleep {param($Seconds);[void]$Seconds};$r.status|Should -Be 'FAIL';$r.reasons|Should -Contain 'TELEMETRY_TIMEOUT'}
 It 'fails an invocation termination outcome' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Outcome exceededCpu));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'INVOCATION_TERMINATED'}
 It 'fails additional unrequested Request IDs' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'),(Get-B2RecordFixture extra));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons|Should -Contain 'EXTRA_REQUEST_ID'}
 It 'does not contain a wrangler tail fallback and uses the isolated Observability credential' {$source=Get-Content (Join-Path $SourceRoot 'src\modules\CpuGate.psm1') -Raw;$source|Should -Not -Match '(?i)wrangler.*tail|Start-S3Tail|ConvertFrom-S3TailEvent';$source|Should -Match '/workers/observability/telemetry/query';$source|Should -Match 'cloudflareObservabilityToken';$worker=Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw;$worker|Should -Match 'x-s3-run-id';$worker|Should -Match 'x-s3-request-id';$worker|Should -Match 'x-s3-scenario';$worker|Should -Match 's3Correlation'}
}
