Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
function Get-S3Percentile { param([double[]]$Values,[double]$Q) if($Values.Count -eq 0){throw 'عينة فارغة'};$sorted=$Values|Sort-Object;$position=($sorted.Count-1)*$Q;$lower=[math]::Floor($position);$upper=[math]::Ceiling($position);if($lower -eq $upper){return [double]$sorted[$lower]};return [double]$sorted[$lower]+([double]$sorted[$upper]-[double]$sorted[$lower])*($position-$lower) }
function Get-S3Statistic { param([double[]]$Values) [ordered]@{count=$Values.Count;median_ms=Get-S3Percentile $Values .5;p95_ms=Get-S3Percentile $Values .95;p99_ms=Get-S3Percentile $Values .99;maximum_ms=($Values|Measure-Object -Maximum).Maximum;over_10ms=@($Values|Where-Object{$_ -gt 10}).Count} }
function Test-S3CpuDecision {
 param([hashtable]$Payload)
 $reasons=[Collections.Generic.List[string]]::new();$summaries=[ordered]@{};$required=[ordered]@{cache_hit_round_1=100;cache_hit_round_2=100;cache_miss=20}
 foreach($name in $required.Keys){
  $rows=@($Payload.groups[$name]);if($rows.Count -ne $required[$name]){$reasons.Add("INCOMPLETE:${name}:$($rows.Count)/$($required[$name])");continue}
  $cpu=@($rows|ForEach-Object{if($null -eq $_.cpu_ms){$null}else{[double]$_.cpu_ms}}|Where-Object{$null -ne $_});if($cpu.Count -ne $required[$name]){$reasons.Add("MISSING_CPU:${name}");continue}
  $stats=Get-S3Statistic $cpu;$terminations=@($rows|Where-Object{$row=$_;$hasTerminated=$false;if($row -is [Collections.IDictionary]){$hasTerminated=$row.Contains('terminated') -and $row['terminated'] -eq $true}elseif($row.PSObject.Properties.Name -contains 'terminated'){$hasTerminated=$row.terminated -eq $true};$row.outcome -in @('exceededCpu','terminated','cpuExceeded') -or $hasTerminated}).Count;$stats.terminations=$terminations;$summaries[$name]=$stats
  if($terminations -gt 0){$reasons.Add("CPU_TERMINATION:${name}:$terminations")};if($stats.over_10ms -ge 3){$reasons.Add("THREE_OR_MORE_OVER_LIMIT:${name}:$($stats.over_10ms)")};if($stats.p95_ms -gt 10){$reasons.Add("P95_OVER_LIMIT:${name}:$($stats.p95_ms)")}
 }
 if([int]$Payload.independent_reproducible_cpu_terminations -ge 2){$reasons.Add('REPRODUCIBLE_CPU_TERMINATION')}
 if($Payload.plan_free -ne $true){$reasons.Add('FREE_PLAN_NOT_PROVEN')};if($Payload.billing_absent -ne $true){$reasons.Add('BILLING_ABSENCE_NOT_PROVEN')};if($Payload.telemetry_official -ne $true){$reasons.Add('OFFICIAL_CPU_TELEMETRY_NOT_PROVEN')};if($Payload.security_reduced -eq $true){$reasons.Add('SECURITY_REDUCED')};if($Payload.stable -ne $true){$reasons.Add('PATH_NOT_STABLE')}
 $requiredNegative=@('uid_not_allowed','unknown_kid','modified_signature','expired','audience','issuer','certificate_fetch','invalid_cache_metadata')
 foreach($negativeName in $requiredNegative){
  $negativeValue=$null
  if($Payload.negativeTests -is [Collections.IDictionary]){
   if($Payload.negativeTests.Contains($negativeName)){$negativeValue=$Payload.negativeTests[$negativeName]}
  }
  elseif($Payload.negativeTests.PSObject.Properties.Name -contains $negativeName){
   $negativeValue=$Payload.negativeTests.$negativeName
  }
  $negativePassed=$false
  if($negativeValue -eq 'PASS'){$negativePassed=$true}
  elseif($negativeValue -is [Collections.IDictionary]){
   $negativePassed=$negativeValue.Contains('pass') -and $negativeValue['pass'] -eq $true
  }
  elseif($null -ne $negativeValue -and $negativeValue.PSObject.Properties.Name -contains 'pass'){
   $negativePassed=$negativeValue.pass -eq $true
  }
  if(-not $negativePassed){$reasons.Add("NEGATIVE_TEST_FAILED:${negativeName}")}
 }
 return [ordered]@{status=$(if($reasons.Count -eq 0){'PASS'}else{'FAIL'});reasons=@($reasons|Select-Object -Unique|Sort-Object);summaries=$summaries}
}
function Invoke-S3HttpRequest {
 param([string]$Uri,[string]$Token,[hashtable]$Headers=@{},[string]$Method='GET',[AllowNull()][string]$Body=$null)
 $handler=[Net.Http.HttpClientHandler]::new();$client=[Net.Http.HttpClient]::new($handler);$client.Timeout=[TimeSpan]::FromSeconds(60)
 try{$request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::$Method,$Uri);if($Token){$request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$Token)};foreach($key in $Headers.Keys){[void]$request.Headers.TryAddWithoutValidation($key,[string]$Headers[$key])};if($null -ne $Body){$request.Content=[Net.Http.StringContent]::new($Body,[Text.Encoding]::UTF8,'application/json')};$stopwatch=[Diagnostics.Stopwatch]::StartNew();$response=$client.Send($request);$stopwatch.Stop();$responseBody=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();[pscustomobject]@{status=[int]$response.StatusCode;body=Protect-S3Text $responseBody;wall_ms=$stopwatch.Elapsed.TotalMilliseconds}}finally{$client.Dispose();$handler.Dispose()}
}
function Assert-S3HttpPositiveResponse {
 param([Parameter(Mandatory)]$Response,[string]$ExpectedRequestId='', [Parameter(Mandatory)][string]$Name)
 if ($Response.status -ne 200) { throw "HTTP_POSITIVE_FAILED:${Name}:$($Response.status)" }
 try { $payload = $Response.body | ConvertFrom-Json -Depth 20 } catch { throw "HTTP_RESPONSE_INVALID:$Name" }
 if ($payload.ok -ne $true) { throw "HTTP_OK_FALSE:$Name" }
 if (-not [string]::IsNullOrWhiteSpace($ExpectedRequestId) -and [string]$payload.requestId -ne $ExpectedRequestId) { throw "HTTP_REQUEST_ID_MISMATCH:$Name" }
 return $payload
}
function Test-S3NumericTelemetryValue {
 param([AllowNull()][object]$Value)
 if($null -eq $Value){return $false}
 $number=0.0
 return [double]::TryParse([string]$Value,[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture,[ref]$number)
}

function ConvertTo-S3NullableTelemetryNumber {
 param([AllowNull()][object]$Value)
 $number=0.0
 if([double]::TryParse(
  [string]$Value,
  [Globalization.NumberStyles]::Float,
  [Globalization.CultureInfo]::InvariantCulture,
  [ref]$number
 )){
  return [double]$number
 }
 return $null
}

function Test-S3WorkersTelemetryBatch {
 param([string]$RunId,[string]$Scenario,[object[]]$ExpectedRequests,[object]$QueryResult,[string]$ExpectedCacheState='')
 $reasons=[Collections.Generic.List[string]]::new()
 if($QueryResult.apiSuccess -ne $true){$reasons.Add('API_ERROR')}
 if($QueryResult.paginationComplete -ne $true){$reasons.Add('PAGINATION_INCOMPLETE')}
 if($QueryResult.truncated -eq $true){$reasons.Add('TELEMETRY_TRUNCATED')}
 if($QueryResult.samplingDetected -eq $true){$reasons.Add('TELEMETRY_SAMPLING_DETECTED')}
 $expectedIds=@($ExpectedRequests|ForEach-Object{[string]$_.requestId})
 if(@($expectedIds|Select-Object -Unique).Count -ne $expectedIds.Count){$reasons.Add('EXPECTED_REQUEST_ID_DUPLICATE')}
 $records=@($QueryResult.records);$runRecords=@($records|Where-Object{[string]$_.runId -eq $RunId})
 if($runRecords.Count -ne $records.Count){$reasons.Add('RUN_ID_MISMATCH')}
 $scenarioRecords=@($runRecords|Where-Object{[string]$_.scenario -eq $Scenario})
 if($scenarioRecords.Count -ne $runRecords.Count){$reasons.Add('SCENARIO_MISMATCH')}
 $actualIds=@($scenarioRecords|ForEach-Object{[string]$_.requestId})
 if(@($actualIds|Where-Object{$_ -notin $expectedIds}).Count -gt 0){$reasons.Add('EXTRA_REQUEST_ID')}
 foreach($expected in $ExpectedRequests){
  $requestId=[string]$expected.requestId;$matchingRecords=@($scenarioRecords|Where-Object{[string]$_.requestId -eq $requestId})
  if($matchingRecords.Count -eq 0){$reasons.Add("MISSING_REQUEST_ID:$requestId");continue}
  if($matchingRecords.Count -ne 1){$reasons.Add("DUPLICATE_REQUEST_ID:$requestId");continue}
  $record=$matchingRecords[0]
  if($record.hasCorrelation -ne $true){$reasons.Add("CORRELATION_MISSING:$requestId")}
  if($record.hasInvocation -ne $true){$reasons.Add("INVOCATION_RECORD_MISSING:$requestId")}
  if(-not(Test-S3NumericTelemetryValue $record.cpu_ms)){$reasons.Add("CPU_TIME_INVALID:$requestId")}
  if(-not(Test-S3NumericTelemetryValue $record.wall_ms)){$reasons.Add("WALL_TIME_INVALID:$requestId")}
  if([string]::IsNullOrWhiteSpace([string]$record.cloudflareRequestId)){$reasons.Add("CLOUDFLARE_REQUEST_ID_MISSING:$requestId")}
  if([string]::IsNullOrWhiteSpace([string]$record.cache_state)){$reasons.Add("CACHE_STATE_MISSING:$requestId")}
  elseif(-not [string]::IsNullOrWhiteSpace($ExpectedCacheState) -and [string]$record.cache_state -ne $ExpectedCacheState){$reasons.Add("CACHE_STATE_MISMATCH:$requestId")}
  if($record.duplicateCorrelation -eq $true){$reasons.Add("DUPLICATE_CORRELATION:$requestId")}
  if($record.duplicateInvocation -eq $true){$reasons.Add("DUPLICATE_INVOCATION:$requestId")}
  $outcome=[string]$record.outcome;$known=@('ok','success','exception','exceededCpu','canceled','cancelled','terminated','cpuExceeded')
  if([string]::IsNullOrWhiteSpace($outcome)){$reasons.Add("OUTCOME_MISSING:$requestId")}
  elseif($outcome -notin $known){$reasons.Add("OUTCOME_UNKNOWN:$requestId")}
  elseif($outcome -in @('exception','exceededCpu','canceled','cancelled','terminated','cpuExceeded')){$reasons.Add("INVOCATION_TERMINATED:${requestId}:$outcome")}
 }
 if($scenarioRecords.Count -ne $ExpectedRequests.Count){$reasons.Add("INVOCATION_COUNT_MISMATCH:$($scenarioRecords.Count)/$($ExpectedRequests.Count)")}
 $normalized=@($scenarioRecords|ForEach-Object{[ordered]@{cpu_ms=ConvertTo-S3NullableTelemetryNumber -Value $_.cpu_ms;wall_ms=ConvertTo-S3NullableTelemetryNumber -Value $_.wall_ms;outcome=[string]$_.outcome;request_id=[string]$_.requestId;cloudflare_request_id=[string]$_.cloudflareRequestId;scenario=[string]$_.scenario;run_id=[string]$_.runId;cache_state=[string]$_.cache_state;hasCorrelation=($_.hasCorrelation -eq $true);hasInvocation=($_.hasInvocation -eq $true)}})
 return [ordered]@{status=$(if($reasons.Count -eq 0){'PASS'}else{'FAIL'});reasons=@($reasons|Select-Object -Unique|Sort-Object);records=$normalized;expectedCount=$ExpectedRequests.Count;invocationCount=$scenarioRecords.Count}
}
function Wait-S3WorkersTelemetry {
 param([string]$AccountId,[string]$Token,[string]$RunId,[string]$Scenario,[object[]]$ExpectedRequests,[Parameter(Mandatory)][string]$WorkerName,[Parameter(Mandatory)][datetime]$FromUtc,[string]$ExpectedCacheState='',[ValidateRange(0,900)][int]$TimeoutSeconds=120,[ValidateRange(0,30)][int]$RetryDelaySeconds=5,[scriptblock]$Now={[DateTime]::UtcNow},[scriptblock]$Sleep={param($Seconds)Start-Sleep -Seconds $Seconds})
 $deadline=(& $Now).AddSeconds($TimeoutSeconds);$lastValidation=$null;$lastFingerprint=$null;$sameFingerprint=0
 do{
  $query=Invoke-S3WorkersTelemetryQuery -AccountId $AccountId -Token $Token -RunId $RunId -Scenario $Scenario -WorkerName $WorkerName -FromUtc $FromUtc
  $lastValidation=Test-S3WorkersTelemetryBatch -RunId $RunId -Scenario $Scenario -ExpectedRequests $ExpectedRequests -ExpectedCacheState $ExpectedCacheState -QueryResult $query
  if($lastValidation.status -eq 'PASS'){return $lastValidation}
  $deterministic=@($lastValidation.reasons|Where-Object{$_ -match '^(API_ERROR|PAGINATION_INCOMPLETE|TELEMETRY_TRUNCATED|TELEMETRY_SAMPLING_DETECTED|EXPECTED_REQUEST_ID_DUPLICATE|RUN_ID_MISMATCH|SCENARIO_MISMATCH|EXTRA_REQUEST_ID|DUPLICATE_REQUEST_ID|CORRELATION_MISSING|CACHE_STATE_MISSING|CACHE_STATE_MISMATCH|DUPLICATE_CORRELATION|DUPLICATE_INVOCATION|CPU_TIME_INVALID|WALL_TIME_INVALID|OUTCOME_|INVOCATION_TERMINATED|CLOUDFLARE_REQUEST_ID_MISSING)'})
  if($deterministic.Count -gt 0){$lastValidation.reasons=@($lastValidation.reasons);return $lastValidation}
  $fingerprint=((@($lastValidation.reasons)|Sort-Object)-join '|');if($fingerprint -eq $lastFingerprint){$sameFingerprint++}else{$lastFingerprint=$fingerprint;$sameFingerprint=1}
  if($sameFingerprint -ge 3){$lastValidation.reasons=@($lastValidation.reasons)+'TELEMETRY_CIRCUIT_BREAKER';return $lastValidation}
  if((& $Now) -ge $deadline){break}
  & $Sleep $RetryDelaySeconds
 }while((& $Now) -lt $deadline)
 $timeoutReasons=[Collections.Generic.List[string]]::new();$timeoutReasons.Add('TELEMETRY_TIMEOUT');foreach($reason in @($lastValidation.reasons)){$timeoutReasons.Add([string]$reason)}
 return [ordered]@{status='FAIL';reasons=@($timeoutReasons|Select-Object -Unique|Sort-Object);records=@($lastValidation.records);expectedCount=$ExpectedRequests.Count;invocationCount=[int]$lastValidation.invocationCount}
}
function Invoke-S3TrackedRequestGroup {
 param([string]$Uri,[string]$Token,[string]$RunId,[string]$Scenario,[ValidateRange(1,1000)][int]$Count,[hashtable]$ExtraHeaders=@{})
 $expected=[Collections.Generic.List[object]]::new()
 for($index=0;$index -lt $Count;$index++){
  $requestId=[guid]::NewGuid().ToString('N');$headers=@{'x-s3-run-id'=$RunId;'x-s3-request-id'=$requestId;'x-s3-scenario'=$Scenario}
  foreach($key in $ExtraHeaders.Keys){$headers[$key]=[string]$ExtraHeaders[$key]}
  $response=Invoke-S3HttpRequest -Uri $Uri -Token $Token -Headers $headers
  [void](Assert-S3HttpPositiveResponse -Response $response -ExpectedRequestId $requestId -Name $Scenario)
  $expected.Add([ordered]@{runId=$RunId;requestId=$requestId;scenario=$Scenario})
 }
 return @($expected)
}
function Set-S3WorkerTestVariable {
 [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param($Context,[hashtable]$Vars)
 if(-not $PSCmdlet.ShouldProcess([string]$Context.RunId,'Update temporary Worker test variables')){return}
 $configPath=Join-Path $Context.Root 'workspace\worker\wrangler.json';$config=Get-Content $configPath -Raw|ConvertFrom-Json
 foreach($key in $Vars.Keys){if($null -eq $Vars[$key]){$config.vars.PSObject.Properties.Remove($key)}else{$config.vars|Add-Member -NotePropertyName $key -NotePropertyValue ([string]$Vars[$key]) -Force}}
 $config|ConvertTo-Json -Depth 20|Set-Content $configPath -Encoding UTF8;Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('deploy','--config',$configPath) -WorkingDirectory (Split-Path $configPath) -TimeoutSeconds 600|Out-Null
}
function Invoke-S3D1Sql {
 param($Context,[string]$Sql,[switch]$AllowFailure,[switch]$PassThru)
 $sqlFile=Join-Path $Context.Root ('temp\negative-'+[guid]::NewGuid().ToString('N')+'.sql')
 try{Set-Content $sqlFile $Sql -Encoding UTF8;$cloudflareResource=Get-S3MapValue -Map $Context.State.resources -Name 'cloudflare';$database=[string](Get-S3MapValue -Map $cloudflareResource -Name 'd1Name');$config=Join-Path $Context.Root 'workspace\worker\wrangler.json';$result=Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','execute',$database,'--remote','--file',$sqlFile,'--config',$config,'--yes') -TimeoutSeconds 180 -AllowFailure:$AllowFailure;if($PassThru){return $result}}finally{Remove-Item $sqlFile -Force -ErrorAction SilentlyContinue}
}
function Invoke-S3AuditAcceptance {
 param($Context,[string]$BaseUri,[string]$Token1,[string]$Token2,[string]$Nonce)
 if([string]::IsNullOrWhiteSpace($Nonce)){throw 'AUDIT_TEST_NONCE_MISSING'}
 $auditUri="$BaseUri/__test/audit-mutation";$uid1=[string]$Context.RuntimeSecrets.uid1;$uid2=[string]$Context.RuntimeSecrets.uid2
 function InvokeAudit([string]$UseToken,[string]$RequestId,[string]$Value){
  $headers=@{'x-s3-test-reset'=$Nonce;'x-s3-run-id'=$Context.RunId;'x-s3-request-id'=$RequestId;'x-s3-scenario'='audit_acceptance'}
  Invoke-S3HttpRequest -Uri $auditUri -Token $UseToken -Method POST -Headers $headers -Body (@{value=$Value}|ConvertTo-Json -Compress)
 }
 function ReadAudit([object]$Response,[string]$ExpectedRequestId,[string]$ExpectedActor,[string]$ExpectedAction,[AllowNull()][string]$ExpectedBefore,[string]$ExpectedAfter){
  if($Response.status -ne 200){throw "AUDIT_HTTP_FAILED:$($Response.status)"}
  try{$payload=$Response.body|ConvertFrom-Json}catch{throw 'AUDIT_RESPONSE_INVALID'}
  if($payload.ok -ne $true -or [string]$payload.requestId -ne $ExpectedRequestId){throw 'AUDIT_HTTP_CONTRACT_MISMATCH'}
  if([string]$payload.audit.actorUid -ne $ExpectedActor -or [string]$payload.audit.action -ne $ExpectedAction){throw 'AUDIT_ACTOR_OR_ACTION_MISMATCH'}
  $createdAt=$payload.audit.createdAt;$timestamp=[DateTimeOffset]::MinValue
  if($createdAt -is [DateTimeOffset]){$timestamp=[DateTimeOffset]$createdAt}
  elseif($createdAt -is [DateTime]){$timestamp=[DateTimeOffset]([DateTime]$createdAt)}
  elseif(-not[DateTimeOffset]::TryParse([string]$createdAt,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$timestamp)){throw 'AUDIT_TIMESTAMP_INVALID'}
  if([string]::IsNullOrEmpty($ExpectedBefore)){if($null -ne $payload.audit.before){throw 'AUDIT_BEFORE_MISMATCH'}}elseif([string]$payload.audit.before.value -ne $ExpectedBefore){throw 'AUDIT_BEFORE_MISMATCH'}
  if([string]$payload.audit.after.value -ne $ExpectedAfter -or [string]$payload.audit.runId -ne $Context.RunId){throw 'AUDIT_AFTER_OR_RUN_MISMATCH'}
 }
 $probeEntity="acceptance-probe-$($Context.RunId)"
 [void](Invoke-S3D1Sql -Context $Context -Sql "DELETE FROM s3_audit_probe WHERE entity_id='$probeEntity';" -AllowFailure -PassThru)
 $firstRequest=[guid]::NewGuid().ToString('N');$secondRequest=[guid]::NewGuid().ToString('N')
 ReadAudit (InvokeAudit $Token1 $firstRequest 'synthetic-before') $firstRequest $uid1 'CREATE' $null 'synthetic-before'
 ReadAudit (InvokeAudit $Token2 $secondRequest 'synthetic-after') $secondRequest $uid2 'UPDATE' 'synthetic-before' 'synthetic-after'
 $deniedRequest=[guid]::NewGuid().ToString('N')
 try{Invoke-S3D1Sql -Context $Context -Sql "UPDATE app_users SET active=0 WHERE uid='$uid2' AND run_marker='$($Context.RunId)';";$denied=InvokeAudit $Token2 $deniedRequest 'synthetic-denied';if($denied.status -lt 400){throw 'AUDIT_UNAUTHORIZED_MUTATION_ACCEPTED'}}finally{Invoke-S3D1Sql -Context $Context -Sql "UPDATE app_users SET active=1 WHERE uid='$uid2' AND run_marker='$($Context.RunId)';"}
 $dbDeniedRequest='db-denied-'+[guid]::NewGuid().ToString('N')
 $dbDeniedSql="INSERT INTO s3_audit_probe(entity_id,value_json,version,updated_by,changed_at,run_marker,request_id) VALUES ('unauthorized-$($Context.RunId)',json_object('value','synthetic-denied'),1,'uid-unregistered',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'$($Context.RunId)','$dbDeniedRequest');"
 $dbDenied=Invoke-S3D1Sql -Context $Context -Sql $dbDeniedSql -AllowFailure -PassThru
 if($dbDenied.ExitCode -eq 0){throw 'AUDIT_DB_AUTHORIZATION_BYPASSED'}
 $thirdUid='uid-third-'+[guid]::NewGuid().ToString('N')
 $thirdUser=Invoke-S3D1Sql -Context $Context -Sql "INSERT INTO app_users(uid,role,active,run_marker) VALUES ('$thirdUid','person_1',1,'$($Context.RunId)');" -AllowFailure -PassThru
 if($thirdUser.ExitCode -eq 0){throw 'D1_MAX_TWO_BYPASSED'}
 $updateTamper=Invoke-S3D1Sql -Context $Context -Sql "UPDATE audit_log SET action='UPDATE' WHERE run_marker='$($Context.RunId)';" -AllowFailure -PassThru
 if($updateTamper.ExitCode -eq 0){throw 'AUDIT_UPDATE_TAMPER_ACCEPTED'}
 $deleteTamper=Invoke-S3D1Sql -Context $Context -Sql "DELETE FROM audit_log WHERE run_marker='$($Context.RunId)';" -AllowFailure -PassThru
 if($deleteTamper.ExitCode -eq 0){throw 'AUDIT_DELETE_TAMPER_ACCEPTED'}
 return [ordered]@{status='PASS';authorizedActors=2;who=$true;when=$true;before=$true;after=$true;unauthorizedRejected=$true;thirdUserRejected=$true;maxTwo=$true;updateRejected=$true;deleteRejected=$true;dbSide=$true}
}
function Invoke-S3NegativeTest {
 param($Context,[string]$Uri,[string]$Token1,[string]$Token2)
 $results=[ordered]@{}
 function ExpectReject([string]$Name,[string]$UseToken,[string]$TargetUri){$response=Invoke-S3HttpRequest -Uri $TargetUri -Token $UseToken;if($response.status -lt 400){throw "حالة رفض لم تُرفض: $Name"};$results[$Name]=[ordered]@{status=$response.status;pass=$true}}
 $parts=$Token1.Split('.');if($parts.Count -ne 3){throw 'Firebase token غير صالح للاختبار.'};$header=$parts[0];$payload=$parts[1];$signature=$parts[2]
 $unknown=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","kid":"unknown-s3"}')).TrimEnd('=').Replace('+','-').Replace('/','_')+".$payload.$signature";ExpectReject 'unknown_kid' $unknown $Uri
 $signaturePadded=$signature.Replace('-','+').Replace('_','/');$signaturePadded += ('=' * ((4-($signaturePadded.Length % 4)) % 4));$signatureBytes=[Convert]::FromBase64String($signaturePadded);if($signatureBytes.Length -eq 0){throw 'SIGNATURE_BYTES_EMPTY'};$signatureBytes[0]=[byte]($signatureBytes[0] -bxor 1);$mutatedSignature=[Convert]::ToBase64String($signatureBytes).TrimEnd('=').Replace('+','-').Replace('/','_');$mutated=$header+'.'+$payload+'.'+$mutatedSignature;ExpectReject 'modified_signature' $mutated $Uri
 Set-S3WorkerTestVariable -Context $Context -Vars @{EXPECTED_AUDIENCE_OVERRIDE='wrong-audience'};ExpectReject 'audience' $Token1 $Uri;Set-S3WorkerTestVariable -Context $Context -Vars @{EXPECTED_AUDIENCE_OVERRIDE=$null}
 Set-S3WorkerTestVariable -Context $Context -Vars @{EXPECTED_ISSUER_PROJECT_OVERRIDE='wrong-issuer'};ExpectReject 'issuer' $Token1 $Uri;Set-S3WorkerTestVariable -Context $Context -Vars @{EXPECTED_ISSUER_PROJECT_OVERRIDE=$null}
 Set-S3WorkerTestVariable -Context $Context -Vars @{TEST_NOW_OFFSET_SECONDS='7200'};ExpectReject 'expired' $Token1 $Uri;Set-S3WorkerTestVariable -Context $Context -Vars @{TEST_NOW_OFFSET_SECONDS=$null}
 Set-S3WorkerTestVariable -Context $Context -Vars @{CERT_URL_OVERRIDE='https://127.0.0.1.invalid/certs'};ExpectReject 'certificate_fetch' $Token1 $Uri;Set-S3WorkerTestVariable -Context $Context -Vars @{CERT_URL_OVERRIDE=$null}
 Set-S3WorkerTestVariable -Context $Context -Vars @{FORCE_CACHE_METADATA_INVALID='true'};ExpectReject 'invalid_cache_metadata' $Token1 $Uri;Set-S3WorkerTestVariable -Context $Context -Vars @{FORCE_CACHE_METADATA_INVALID=$null}
 $uid2=[string]$Context.RuntimeSecrets.uid2
 try{Invoke-S3D1Sql -Context $Context -Sql "UPDATE app_users SET active=0 WHERE uid='$uid2' AND run_marker='$($Context.RunId)';";ExpectReject 'uid_not_allowed' $Token2 $Uri}finally{Invoke-S3D1Sql -Context $Context -Sql "UPDATE app_users SET active=1 WHERE uid='$uid2' AND run_marker='$($Context.RunId)';"}
 return $results
}
function Resolve-S3PublicBaseUri {
 param([Parameter(Mandatory)]$Context,[string]$PublicBaseUri='')
 $cloudflare=Get-S3MapValue -Map $Context.State.resources -Name 'cloudflare'
 $stored=([string](Get-S3MapValue -Map $cloudflare -Name 'url')).TrimEnd('/')
 if([string]::IsNullOrWhiteSpace($PublicBaseUri)){return $stored}
 if($Context.Mode -ne 'Live'){throw 'PUBLIC_BASE_URI_LIVE_ONLY'}
 if($Context.IsResumed -ne $true){throw 'PUBLIC_BASE_URI_RESUME_ONLY'}
 if([string]$Context.State.currentState -ne '60_CLOUDFLARE_PROVISIONED'){throw 'PUBLIC_BASE_URI_CHECKPOINT_60_REQUIRED'}
 $parsed=$null
 if(-not[Uri]::TryCreate($PublicBaseUri,[UriKind]::Absolute,[ref]$parsed)){throw 'PUBLIC_BASE_URI_INVALID'}
 if($parsed.Scheme -cne 'https'){throw 'PUBLIC_BASE_URI_HTTPS_REQUIRED'}
 if(-not $parsed.IsDefaultPort){throw 'PUBLIC_BASE_URI_DEFAULT_HTTPS_PORT_REQUIRED'}
 if(-not[string]::IsNullOrWhiteSpace($parsed.UserInfo)){throw 'PUBLIC_BASE_URI_USERINFO_FORBIDDEN'}
 if($parsed.AbsolutePath -ne '/' -or -not[string]::IsNullOrWhiteSpace($parsed.Query) -or -not[string]::IsNullOrWhiteSpace($parsed.Fragment)){throw 'PUBLIC_BASE_URI_ORIGIN_ONLY'}
 $hostname=$parsed.IdnHost.ToLowerInvariant()
 if([Uri]::CheckHostName($hostname) -ne [UriHostNameType]::Dns -or $hostname -eq 'localhost' -or $hostname.EndsWith('.localhost') -or $hostname.EndsWith('.local') -or $hostname.EndsWith('.invalid')){throw 'PUBLIC_BASE_URI_PUBLIC_DNS_HOST_REQUIRED'}
 return "https://$hostname"
}
function Assert-S3PublicEndpointIdentity {
 param([Parameter(Mandatory)][string]$BaseUri)
 $requestId='public-endpoint-'+[guid]::NewGuid().ToString('N')
 $response=Invoke-S3HttpRequest -Uri "$BaseUri/private/ping" -Headers @{'x-s3-request-id'=$requestId;'x-s3-scenario'='public_endpoint_identity'}
 if($response.status -ne 401){throw "PUBLIC_ENDPOINT_UNAUTHENTICATED_STATUS_MISMATCH:$($response.status)"}
 try{$payload=$response.body|ConvertFrom-Json -Depth 10}catch{throw 'PUBLIC_ENDPOINT_IDENTITY_RESPONSE_INVALID'}
 if($payload.ok -ne $false -or [string]$payload.code -ne 'TOKEN_MISSING' -or [string]$payload.requestId -ne $requestId){throw 'PUBLIC_ENDPOINT_IDENTITY_CONTRACT_MISMATCH'}
 return [ordered]@{status='PASS';baseUri=$BaseUri;unauthenticatedContract='TOKEN_MISSING';httpsVerified=$true}
}
function Invoke-S3CpuGate {
 param([Parameter(Mandatory)]$Context,[string]$PublicBaseUri='')
 $baseUri=Resolve-S3PublicBaseUri -Context $Context -PublicBaseUri $PublicBaseUri
 if($Context.Mode -eq 'Simulation'){
  function MakeRows([int]$Count,[double]$Base,[string]$Cache){$rows=@();for($index=0;$index -lt $Count;$index++){$rows+=[ordered]@{cpu_ms=$Base+(($index%7)*0.07);wall_ms=20+(($index%5)*0.4);outcome='ok';cache_state=$Cache}};return $rows}
  $payload=[ordered]@{groups=[ordered]@{cache_hit_round_1=MakeRows 100 2.1 'hit';cache_hit_round_2=MakeRows 100 2.2 'hit';cache_miss=MakeRows 20 4.5 'miss'};plan_free=$true;billing_absent=$true;security_reduced=$false;telemetry_official=$true;stable=$true;independent_reproducible_cpu_terminations=0;audit=[ordered]@{status='PASS';dbSide=$true};negativeTests=[ordered]@{uid_not_allowed='PASS';unknown_kid='PASS';modified_signature='PASS';expired='PASS';audience='PASS';issuer='PASS';certificate_fetch='PASS';invalid_cache_metadata='PASS'}}
  $decision=Test-S3CpuDecision -Payload $payload;$payload.decision=$decision;if([string](Get-S3MapValue -Map $decision -Name 'status') -eq 'PASS'){$payload|ConvertTo-Json -Depth 20|Set-Content (Join-Path $Context.Root 'reports\cpu-gate-results.json') -Encoding UTF8};return $decision
 }
 if($Context.Mode -ne 'Live'){return [ordered]@{status='NOT_EXECUTED';reasons=@('PLAN_MODE')}}
 $cloudflare=Get-S3MapValue -Map $Context.State.resources -Name 'cloudflare';$uri="$baseUri/private/ping";$token1=[string]$Context.RuntimeSecrets.token1;$token2=[string]$Context.RuntimeSecrets.token2;$nonce=[string]$Context.RuntimeSecrets.testResetNonce
 if(-not $token1 -or -not $token2 -or -not $nonce){throw 'الأسرار المؤقتة غير موجودة في الذاكرة؛ يجب التنظيف وإعادة تشغيل Live.'}
 $accountId=[string](Get-S3MapValue -Map $cloudflare -Name 'accountId');$workerName=[string](Get-S3MapValue -Map $cloudflare -Name 'worker');$cloudflareObservabilityToken=[string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareObservabilityToken')
 if(-not $cloudflareObservabilityToken -or -not $accountId){throw 'Cloudflare Observability preflight context غير موجود في الذاكرة.'}
 try{
  if(-not[string]::IsNullOrWhiteSpace($PublicBaseUri)){
   $managementToken=[string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareToken')
   if([string]::IsNullOrWhiteSpace($managementToken)){throw 'CUSTOM_DOMAIN_BINDING_VERIFICATION_TOKEN_MISSING'}
   [void](Assert-S3CloudflareCustomDomainBinding -AccountId $accountId -Token $managementToken -WorkerName $workerName -PublicBaseUri $baseUri)
   [void](Assert-S3PublicEndpointIdentity -BaseUri $baseUri)
  }
  $audit=Invoke-S3AuditAcceptance -Context $Context -BaseUri $baseUri -Token1 $token1 -Token2 $token2 -Nonce $nonce
  for($index=0;$index -lt 20;$index++){ $warmup=Invoke-S3HttpRequest -Uri $uri -Token $token1;[void](Assert-S3HttpPositiveResponse -Response $warmup -Name 'warmup') }
  $from1=[DateTime]::UtcNow;$expected1=Invoke-S3TrackedRequestGroup -Uri $uri -Token $token1 -RunId $Context.RunId -Scenario 'cache_hit_round_1' -Count 100
  $telemetry1=Wait-S3WorkersTelemetry -AccountId $accountId -Token $cloudflareObservabilityToken -RunId $Context.RunId -Scenario 'cache_hit_round_1' -ExpectedRequests $expected1 -WorkerName $workerName -FromUtc $from1 -ExpectedCacheState 'hit'
  if($telemetry1.status -ne 'PASS'){throw "B2_TELEMETRY_FAIL:$($telemetry1.reasons -join ',')"}
  $from2=[DateTime]::UtcNow;$expected2=Invoke-S3TrackedRequestGroup -Uri $uri -Token $token1 -RunId $Context.RunId -Scenario 'cache_hit_round_2' -Count 100
  $telemetry2=Wait-S3WorkersTelemetry -AccountId $accountId -Token $cloudflareObservabilityToken -RunId $Context.RunId -Scenario 'cache_hit_round_2' -ExpectedRequests $expected2 -WorkerName $workerName -FromUtc $from2 -ExpectedCacheState 'hit'
  if($telemetry2.status -ne 'PASS'){throw "B2_TELEMETRY_FAIL:$($telemetry2.reasons -join ',')"}
  $fromMiss=[DateTime]::UtcNow;$expectedMisses=Invoke-S3TrackedRequestGroup -Uri $uri -Token $token1 -RunId $Context.RunId -Scenario 'cache_miss' -Count 20 -ExtraHeaders @{'x-s3-test-reset'=$nonce;'x-s3-force-certificate-refresh'='true'}
  $telemetryMiss=Wait-S3WorkersTelemetry -AccountId $accountId -Token $cloudflareObservabilityToken -RunId $Context.RunId -Scenario 'cache_miss' -ExpectedRequests $expectedMisses -WorkerName $workerName -FromUtc $fromMiss -ExpectedCacheState 'miss'
  if($telemetryMiss.status -ne 'PASS'){throw "B2_TELEMETRY_FAIL:$($telemetryMiss.reasons -join ',')"}
  $negative=Invoke-S3NegativeTest -Context $Context -Uri $uri -Token1 $token1 -Token2 $token2
  Set-S3WorkerTestVariable -Context $Context -Vars @{TEST_CONTROLS='disabled';TEST_RESET_NONCE=$null;EXPECTED_AUDIENCE_OVERRIDE=$null;EXPECTED_ISSUER_PROJECT_OVERRIDE=$null;TEST_NOW_OFFSET_SECONDS=$null;CERT_URL_OVERRIDE=$null;FORCE_CACHE_METADATA_INVALID=$null}
  $group1=@($telemetry1.records);$group2=@($telemetry2.records);$misses=@($telemetryMiss.records)
  $payload=[ordered]@{run_id=$Context.RunId;groups=[ordered]@{cache_hit_round_1=$group1;cache_hit_round_2=$group2;cache_miss=$misses};plan_free=(Get-S3MapValue -Map $cloudflare -Name 'freePlan');billing_absent=(Get-S3MapValue -Map $cloudflare -Name 'billingAbsent');security_reduced=$false;telemetry_official=$true;telemetry_endpoint='POST /accounts/{account_id}/workers/observability/telemetry/query';stable=$true;independent_reproducible_cpu_terminations=0;audit=$audit;negativeTests=$negative}
  $decision=Test-S3CpuDecision -Payload $payload;$payload.decision=$decision;if([string](Get-S3MapValue -Map $decision -Name 'status') -eq 'PASS'){$payload|ConvertTo-Json -Depth 30|Set-Content (Join-Path $Context.Root 'reports\cpu-gate-results.json') -Encoding UTF8};return $decision
 }finally{$token1=$null;$token2=$null;$cloudflareObservabilityToken=$null;[GC]::Collect()}
}
Export-ModuleMember -Function *-S3*
