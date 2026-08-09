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

Describe 'B2 Workers Observability telemetry query' -Tag 'B2' {
 BeforeAll {
  function Get-B2ExpectedFixture([string[]]$Ids,[string]$Scenario='scenario-a'){@($Ids|ForEach-Object{[ordered]@{runId='run-b2';requestId=$_;scenario=$Scenario}})}
  function Get-B2RecordFixture([string]$RequestId,[string]$Scenario='scenario-a',[object]$Cpu=2.5,[object]$Wall=8.0,[string]$Outcome='ok',[string]$RunId='run-b2',[string]$CloudflareRequestId=''){
   if([string]::IsNullOrWhiteSpace($CloudflareRequestId)){$CloudflareRequestId="cf-$RequestId"}
   [ordered]@{runId=$RunId;requestId=$RequestId;scenario=$Scenario;cloudflareRequestId=$CloudflareRequestId;cpu_ms=$Cpu;wall_ms=$Wall;outcome=$Outcome}
  }
  function Get-B2QueryResultFixture([object[]]$Records){[ordered]@{status='PASS';records=$Records;pageCount=1;paginationComplete=$true;truncated=$false;samplingDetected=$false;apiSuccess=$true;errors=@()}}
 }
 It 'accepts a complete correlated telemetry response' {$e=Get-B2ExpectedFixture @('a','b');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'),(Get-B2RecordFixture 'b'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).status|Should -Be 'PASS'}
 It 'fails missing telemetry' {$e=Get-B2ExpectedFixture @('a','b');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'MISSING_REQUEST_ID'}
 It 'fails a duplicate Request ID' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'),(Get-B2RecordFixture 'a' -CloudflareRequestId 'cf-a-2'));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'DUPLICATE_REQUEST_ID'}
 It 'fails missing or nonnumeric CPU time' {$e=Get-B2ExpectedFixture @('a','b');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Cpu $null),(Get-B2RecordFixture 'b' -Cpu 'bad'));$r=Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q;@($r.reasons|Where-Object{$_ -match 'CPU_TIME_INVALID'}).Count|Should -Be 2}
 It 'fails missing wall time' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Wall $null));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'WALL_TIME_INVALID'}
 It 'fails missing outcome' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Outcome ''));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'OUTCOME_MISSING'}
 It 'fails missing Cloudflare request ID' {$e=Get-B2ExpectedFixture @('a');$x=Get-B2RecordFixture 'a';$x.cloudflareRequestId='';$q=Get-B2QueryResultFixture @($x);(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'CLOUDFLARE_REQUEST_ID_MISSING'}
 It 'fails truncation' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'));$q.truncated=$true;(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons|Should -Contain 'TELEMETRY_TRUNCATED'}
 It 'fails sampling or unacceptable abr_level' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'));$q.samplingDetected=$true;(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons|Should -Contain 'TELEMETRY_SAMPLING_DETECTED'}
 It 'reads all telemetry pagination pages' {
  $script:page=0
  Mock Invoke-S3CloudflareRest {$script:page++;if($script:page -eq 1){[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{data=@([ordered]@{'$metadata.runId'='run-b2';'$metadata.requestId'='a';'$metadata.scenario'='scenario-a';'$workers.requestId'='cf-a';'$workers.cpuTimeMs'=2;'$workers.wallTimeMs'=8;'$workers.outcome'='ok'})};result_info=[pscustomobject]@{page=1;total_pages=2}}}else{[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{data=@([ordered]@{'$metadata.runId'='run-b2';'$metadata.requestId'='b';'$metadata.scenario'='scenario-a';'$workers.requestId'='cf-b';'$workers.cpuTimeMs'=3;'$workers.wallTimeMs'=9;'$workers.outcome'='ok'})};result_info=[pscustomobject]@{page=2;total_pages=2}}}} -ModuleName Cloudflare
  $q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a;$q.status|Should -Be 'PASS';$q.pageCount|Should -Be 2;$q.records.Count|Should -Be 2
 }
 It 'fails a missing pagination page' {Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=[pscustomobject]@{data=@();has_more=$true}}} -ModuleName Cloudflare;$q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a;$q.status|Should -Be 'FAIL';$q.errors|Should -Contain 'PAGINATION_NEXT_PAGE_MISSING'}
 It 'fails an API error' {Mock Invoke-S3CloudflareRest {throw 'mock api error'} -ModuleName Cloudflare;$q=Invoke-S3WorkersTelemetryQuery -AccountId account -Token token -RunId run-b2 -Scenario scenario-a;$q.status|Should -Be 'FAIL';$q.apiSuccess|Should -BeFalse}
 It 'fails after the bounded telemetry timeout' {$e=Get-B2ExpectedFixture @('a');Mock Invoke-S3WorkersTelemetryQuery {Get-B2QueryResultFixture @()} -ModuleName CpuGate;$fixed=[DateTime]'2026-08-05T08:00:00Z';$r=Wait-S3WorkersTelemetry -AccountId account -Token token -RunId run-b2 -Scenario scenario-a -ExpectedRequests $e -TimeoutSeconds 0 -RetryDelaySeconds 0 -Now {$fixed} -Sleep {param($Seconds);[void]$Seconds};$r.status|Should -Be 'FAIL';$r.reasons|Should -Contain 'TELEMETRY_TIMEOUT'}
 It 'fails an invocation termination outcome' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a' -Outcome exceededCpu));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons -join ','|Should -Match 'INVOCATION_TERMINATED'}
 It 'fails additional unrequested Request IDs' {$e=Get-B2ExpectedFixture @('a');$q=Get-B2QueryResultFixture @((Get-B2RecordFixture 'a'),(Get-B2RecordFixture extra));(Test-S3WorkersTelemetryBatch 'run-b2' 'scenario-a' $e $q).reasons|Should -Contain 'EXTRA_REQUEST_ID'}
 It 'does not contain a wrangler tail fallback and uses the isolated Observability credential' {$source=Get-Content (Join-Path $SourceRoot 'src\modules\CpuGate.psm1') -Raw;$source|Should -Not -Match '(?i)wrangler.*tail|Start-S3Tail|ConvertFrom-S3TailEvent';$source|Should -Match '/workers/observability/telemetry/query';$source|Should -Match 'cloudflareObservabilityToken'}
}
