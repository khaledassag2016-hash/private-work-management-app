Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:S3States = @(
 '00_PACKAGE_READY','10_LOCAL_PREREQUISITES','20_REPOSITORY_GATE','30_BRANCH_AND_DRAFT_PR',
 '40_PRE_CLOUD_GATE','50_FIREBASE_PROVISIONED','60_CLOUDFLARE_PROVISIONED',
 '70_CPU_GATE_EXECUTED','80_RESOURCES_DESTROYED','90_REPORT_READY'
)

function Get-S3FixedRoot { 'C:\Users\MC\Desktop\1' }

function Protect-S3Text {
 [CmdletBinding()] param([AllowNull()][string]$Text)
 if ($null -eq $Text) { return '' }
 $out = $Text
 $replacementPatterns = @(
  '(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
  '(?i)(Authorization\s*[:=]\s*Bearer\s+)[^\s"'']+',
  '(?i)(password\s*[:=]\s*)[^,\s}\]]+',
  '(?i)((?:access|refresh|id|oauth)[_-]?token\s*[:=]\s*)[^,\s}\]]+',
  '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'
 )
 foreach ($pattern in $replacementPatterns) {
  if ($pattern -match '^\(\?i\)\(') { $out = [regex]::Replace($out,$pattern,'$1[REDACTED]') }
  else { $out = [regex]::Replace($out,$pattern,'[REDACTED]') }
 }
 return $out
}

function Initialize-S3Directory {
 [CmdletBinding()] param([Parameter(Mandatory)][string]$Root)
 if ($Root -ne (Get-S3FixedRoot)) { throw "المسار غير معتمد: $Root" }
 $dirs = 'tools','modules','python','workspace','repository','config','tests','logs','reports','artifacts','temp','backups','docs'
 New-Item -ItemType Directory -Path $Root -Force | Out-Null
 foreach ($d in $dirs) { New-Item -ItemType Directory -Path (Join-Path $Root $d) -Force | Out-Null }
}

function Get-S3RunId { 's3cpu-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([guid]::NewGuid().ToString('N').Substring(0,8)) }

function Get-S3MapValue {
 [CmdletBinding()] param([AllowNull()]$Map,[Parameter(Mandatory)][string]$Name)
 if($null -eq $Map){return $null}
 if($Map -is [Collections.IDictionary]){
  if($Map.Contains($Name)){return $Map[$Name]}
  return $null
 }
 $property=$Map.PSObject.Properties[$Name]
 if($null -eq $property){return $null}
 return $property.Value
}

function Set-S3MapValue {
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)]$Map,[Parameter(Mandatory)][string]$Name,[AllowNull()]$Value)
 if(-not $PSCmdlet.ShouldProcess($Name,'Set map value')){return}
 if($Map -is [Collections.IDictionary]){
  $Map[$Name]=$Value
  return
 }
 $Map|Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function ConvertTo-S3NormalizedState {
 [CmdletBinding()] param([Parameter(Mandatory)]$State)
 $resources=Get-S3MapValue -Map $State -Name 'resources'
 if($null -eq $resources){$resources=[ordered]@{};Set-S3MapValue -Map $State -Name 'resources' -Value $resources}
 $results=Get-S3MapValue -Map $State -Name 'results'
 if($null -eq $results){$results=[ordered]@{};Set-S3MapValue -Map $State -Name 'results' -Value $results}
 foreach($name in @('firebase','cloudflare','branch','draftPr')){
  if($null -eq (Get-S3MapValue -Map $resources -Name $name)){Set-S3MapValue -Map $resources -Name $name -Value $null}
 }
 foreach($name in @('tools','repository','branchPr','firebase','firebaseGuard','cloudflare','cloudflareGuard','cpu','final')){
  if($null -eq (Get-S3MapValue -Map $results -Name $name)){Set-S3MapValue -Map $results -Name $name -Value $null}
 }
 if($null -eq (Get-S3MapValue -Map $State -Name 'failure')){Set-S3MapValue -Map $State -Name 'failure' -Value $null}
 return $State
}

function Read-S3State {
 [CmdletBinding()] param([Parameter(Mandatory)][string]$Root)
 $path = Join-Path $Root 'state.json'
 if (-not (Test-Path -LiteralPath $path)) { return $null }
 try {
  $state=Get-Content -LiteralPath $path -Raw -Encoding UTF8|ConvertFrom-Json
  return ConvertTo-S3NormalizedState -State $state
 }
 catch { throw 'state.json غير صالح. لا تحذفه؛ ارفع blocker-report.zip.' }
}

function Write-S3State {
 [CmdletBinding()] param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)]$State)
 $serialized = $State | ConvertTo-Json -Depth 25
 if ($serialized -match '(?i)password|refreshToken|idToken|accessToken|apiKey|Authorization') { throw 'رفض حفظ state.json: احتوى حقلًا حساسًا.' }
 $path = Join-Path $Root 'state.json'
 $tmp = '{0}.{1}.{2}.tmp' -f $path,$PID,[guid]::NewGuid().ToString('N')
 try {
  [IO.File]::WriteAllText($tmp,$serialized,[Text.UTF8Encoding]::new($false))
  for($attempt=1;$attempt -le 40;$attempt++){
   try { Move-Item -LiteralPath $tmp -Destination $path -Force -ErrorAction Stop; return }
   catch [IO.IOException] {
    if($attempt -eq 40){throw}
    Start-Sleep -Milliseconds 50
   }
  }
 } finally {
  if(Test-Path -LiteralPath $tmp -PathType Leaf){Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue}
 }
}

function New-S3Context {
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([ValidateSet('Plan','Simulation','Live')][string]$Mode='Plan',[switch]$Resume)
 $root=Get-S3FixedRoot
 if(-not $PSCmdlet.ShouldProcess($root,'Create or resume S3 context')){return}
 Initialize-S3Directory -Root $root
 $existing=Read-S3State -Root $root
 if ($Resume -and $null -ne $existing) {
  if ($existing.mode -ne $Mode) { throw 'لا يمكن استئناف تشغيل بوضع مختلف.' }
  return [pscustomobject]@{ Root=$root; Mode=$Mode; RunId=$existing.runId; State=$existing; RuntimeSecrets=[ordered]@{}; IsResumed=$true }
 }
 $run=Get-S3RunId
 $state=[ordered]@{schemaVersion=2;runId=$run;mode=$Mode;currentState='00_PACKAGE_READY';completed=@('00_PACKAGE_READY');startedUtc=[DateTime]::UtcNow.ToString('o');updatedUtc=[DateTime]::UtcNow.ToString('o');resources=[ordered]@{};results=[ordered]@{};failure=$null}
 Write-S3State -Root $root -State $state
 [pscustomobject]@{Root=$root;Mode=$Mode;RunId=$run;State=$state;RuntimeSecrets=[ordered]@{};IsResumed=$false}
}

function Set-S3Checkpoint {
[CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][ValidateSet('00_PACKAGE_READY','10_LOCAL_PREREQUISITES','20_REPOSITORY_GATE','30_BRANCH_AND_DRAFT_PR','40_PRE_CLOUD_GATE','50_FIREBASE_PROVISIONED','60_CLOUDFLARE_PROVISIONED','70_CPU_GATE_EXECUTED','80_RESOURCES_DESTROYED','90_REPORT_READY')][string]$State)
 if(-not $PSCmdlet.ShouldProcess([string]$Context.RunId,('Set checkpoint to ' + $State))){return}
 $current=[string]$Context.State.currentState
 $ci=[array]::IndexOf($script:S3States,$current); $ni=[array]::IndexOf($script:S3States,$State)
 if ($ni -ne ($ci+1) -and $State -ne $current) { throw "انتقال غير مسموح: $current -> $State" }
 if ($State -ne $current) { $Context.State.completed += $State }
 $Context.State.currentState=$State; $Context.State.updatedUtc=[DateTime]::UtcNow.ToString('o')
 Write-S3State -Root $Context.Root -State $Context.State
}

function Write-S3Log {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[ValidateSet('INFO','WARN','ERROR')][string]$Level='INFO',[Parameter(Mandatory)][string]$Message)
 $safe=Protect-S3Text $Message; $line="{0} [{1}] {2}" -f ([DateTime]::UtcNow.ToString('o')),$Level,$safe
 Add-Content -LiteralPath (Join-Path $Context.Root "logs\$($Context.RunId).log") -Value $line -Encoding UTF8
}

function Invoke-S3Process {
 [CmdletBinding()] param(
  [Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$FilePath,[string[]]$ArgumentList=@(),
  [int]$TimeoutSeconds=300,[string]$WorkingDirectory=$Context.Root,[switch]$AllowFailure,[hashtable]$Environment=@{},[switch]$SensitiveOutput
 )
 $resolvedFilePath=$FilePath
 if($IsWindows -and $FilePath -notmatch '[\\/.]'){
  $candidate=Get-Command ($FilePath + '.cmd') -ErrorAction SilentlyContinue | Select-Object -First 1
  if($null -ne $candidate){$resolvedFilePath=$candidate.Source}
 }
 $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$resolvedFilePath;$psi.WorkingDirectory=$WorkingDirectory;$psi.UseShellExecute=$false;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.CreateNoWindow=$true
 foreach($arg in $ArgumentList){[void]$psi.ArgumentList.Add($arg)}
 foreach($k in $Environment.Keys){$psi.Environment[$k]=[string]$Environment[$k]}
 $p=[Diagnostics.Process]::new();$p.StartInfo=$psi
 try {
  if(-not $p.Start()){throw "تعذر تشغيل $FilePath"}
  $stdoutTask=$p.StandardOutput.ReadToEndAsync();$stderrTask=$p.StandardError.ReadToEndAsync()
  if(-not $p.WaitForExit($TimeoutSeconds*1000)){try{$p.Kill($true)}catch{Write-Verbose ("تعذر إنهاء العملية بعد انتهاء المهلة: " + $_.Exception.Message)};throw "انتهت مهلة $FilePath"}
  $stdoutRaw=$stdoutTask.Result;$stderrRaw=$stderrTask.Result
  $stdout=$(if($SensitiveOutput){$stdoutRaw}else{Protect-S3Text $stdoutRaw});$stderr=Protect-S3Text $stderrRaw
  if($p.ExitCode -ne 0 -and -not $AllowFailure){throw "فشل $FilePath برمز $($p.ExitCode): $stderr"}
  [pscustomobject]@{ExitCode=$p.ExitCode;StdOut=$stdout;StdErr=$stderr}
 } finally {$p.Dispose()}
}

function Assert-S3NoSecret {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string[]]$Path)
 if(@($Path).Count -eq 0){throw 'SECRET_SCAN_SCOPE_EMPTY'}
 foreach($candidate in $Path){if(-not(Test-Path -LiteralPath $candidate)){throw "SECRET_SCAN_PATH_MISSING: $candidate"}}
 $pythonPath=Join-Path $Context.Root 'python\python.exe'
 if(-not (Test-Path $pythonPath)){
  $pythonCommand=Get-Command python -ErrorAction SilentlyContinue
  $pythonPath=if($null -ne $pythonCommand){$pythonCommand.Source}else{$null}
 }
 $scanner=Join-Path $Context.Root 'python\secret_scan.py'
 if($pythonPath -and (Test-Path $scanner)){Invoke-S3Process -Context $Context -FilePath $pythonPath -ArgumentList (@($scanner)+@($Path)) -TimeoutSeconds 120 | Out-Null;return}
 $bad=@(foreach($candidate in $Path){
  $item=Get-Item -LiteralPath $candidate -Force
  if($item -is [IO.FileInfo]){$item}else{Get-ChildItem -LiteralPath $candidate -Recurse -File -ErrorAction SilentlyContinue}
 }) | Where-Object{$_.Name -match '^\.env|service.?account|private.?key'}
 if($bad){throw 'كشف ملفات أسرار ممنوعة.'}
}

function Get-S3PayloadFile {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][ValidateSet('PreCloud','CloudflareExecution','FinalDeployment','D1Seed')][string]$Scope)
 $root=[IO.Path]::GetFullPath([string]$Context.Root)
 $workerRoot=Join-Path $root 'worker'
 $deploymentRoot=Join-Path $root 'workspace\worker'
 $schema=Join-Path $workerRoot 'schema.sql'
 $source=Join-Path $workerRoot 'src'
 $assets=Join-Path $workerRoot 'assets'
 $deploymentAssets=Join-Path $deploymentRoot 'assets'
 $config=Join-Path $deploymentRoot 'wrangler.json'
 $seed=Join-Path $root 'temp\allowlist.sql'
 $preCloudRequiredFiles=@(
  'worker\schema.sql',
  'worker\schema_s6.sql',
  'worker\migrations\0005_s5_domain_data_api.sql',
  'worker\migrations\0006_s6_financial_core.sql',
  'worker\migrations\0007_s7_payments_collections_reversals.sql',
  'worker\migrations\0008_s7_pr_b_settlement_core.sql',
  'worker\migrations\0009_s7_d014_d016_authoritative_settlement.sql',
  'worker\migrations\0010_s8_search_filter_alert_core.sql',
  'worker\migrations\0011_s11_historical_import.sql'
 )
 $paths=switch($Scope){
  'PreCloud' {@($source)+@($preCloudRequiredFiles|ForEach-Object{Join-Path $root $_})}
  'CloudflareExecution' {@((Join-Path $deploymentRoot 'src'),$config,$schema)}
  'FinalDeployment' {@((Join-Path $deploymentRoot 'src'),$config)}
  'D1Seed' {@($seed)}
 }
 if($Scope -eq 'PreCloud' -and (Test-Path -LiteralPath $assets -PathType Container)){$paths += $assets}
 if($Scope -in @('CloudflareExecution','FinalDeployment') -and (Test-Path -LiteralPath $deploymentAssets -PathType Container)){$paths += $deploymentAssets}
 foreach($path in $paths){if(-not(Test-Path -LiteralPath $path)){throw "DEPLOYMENT_PAYLOAD_REQUIRED_PATH_MISSING: $path"}}
 $files=[Collections.Generic.List[IO.FileInfo]]::new()
 foreach($path in $paths){
  $item=Get-Item -LiteralPath $path -Force
  if($item -is [IO.FileInfo]){$files.Add($item)}else{foreach($file in Get-ChildItem -LiteralPath $path -Recurse -File -Force){$files.Add($file)}}
 }
 if($files.Count -eq 0){throw 'DEPLOYMENT_PAYLOAD_EMPTY'}
 $allowed=@()
 if($Scope -eq 'PreCloud'){$allowed=@('worker\src\','worker\assets\')+@($preCloudRequiredFiles)}
 elseif($Scope -in @('CloudflareExecution','FinalDeployment')){$allowed=@('workspace\worker\wrangler.json','workspace\worker\src\','workspace\worker\assets\')}
 elseif($Scope -eq 'D1Seed'){$allowed=@('temp\allowlist.sql')}
 $allCandidates=switch($Scope){
  'PreCloud' {Get-ChildItem -LiteralPath $workerRoot -Recurse -File -Force}
  'CloudflareExecution' {Get-ChildItem -LiteralPath $deploymentRoot -Recurse -File -Force}
  'FinalDeployment' {Get-ChildItem -LiteralPath $deploymentRoot -Recurse -File -Force}
  'D1Seed' {@(Get-Item -LiteralPath $seed -Force)}
 }
 foreach($file in @($allCandidates)){
  if($file.LinkType){throw "DEPLOYMENT_PAYLOAD_REPARSE_POINT: $($file.FullName)"}
  $relative=$file.FullName.Substring($root.Length).TrimStart('\','/') -replace '/','\'
  $permitted=$false
  foreach($entry in $allowed){if($entry.EndsWith('\')){$permitted=$permitted -or $relative.StartsWith($entry,[StringComparison]::OrdinalIgnoreCase)}else{$permitted=$permitted -or $relative.Equals($entry,[StringComparison]::OrdinalIgnoreCase)}}
  if(-not $permitted){throw "DEPLOYMENT_PAYLOAD_UNALLOWLISTED_FILE: $relative"}
 }
 return @($files|Sort-Object FullName)
}

function Assert-S3DeploymentPayloadNoSecret {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][ValidateSet('PreCloud','CloudflareExecution','FinalDeployment','D1Seed')][string]$Scope)
 $files=Get-S3PayloadFile -Context $Context -Scope $Scope
 Assert-S3NoSecret -Context $Context -Path @($files|ForEach-Object FullName)
 $root=[IO.Path]::GetFullPath([string]$Context.Root)
 $entries=@($files|ForEach-Object{
  $relative=$_.FullName.Substring($root.Length).TrimStart('\','/') -replace '/','\'
  [ordered]@{path=$relative;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant();length=$_.Length}
 })
 $canonical=($entries|ConvertTo-Json -Depth 5 -Compress)
 $bytes=[Text.Encoding]::UTF8.GetBytes($canonical)
 $payloadHash=([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)|ForEach-Object ToString x2)-join ''
 $record=[ordered]@{runId=$Context.RunId;scope=$Scope;scannedAtUtc=[DateTime]::UtcNow.ToString('o');fileCount=$entries.Count;files=$entries;payloadSha256=$payloadHash;status='PASS'}
 $report=Join-Path $Context.Root ("reports\secret-scan-$Scope.json")
 $record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $report -Encoding UTF8
 Set-S3MapValue -Map $Context.State.results -Name ("secretScan$Scope") -Value ([ordered]@{status='PASS';fileCount=$entries.Count;payloadSha256=$payloadHash;report=$report})
 return $record
}

function Test-S3OwnedResource {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$Name,[Parameter(Mandatory)][string]$Marker)
 return ($Name -like "*$($Context.RunId)*" -and $Marker -eq $Context.RunId)
}

function Test-S3HasOwnedCloudResource {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context)
 $resources=Get-S3MapValue -Map $Context.State -Name 'resources'
 foreach($name in @('firebase','cloudflare')){
  $resource=Get-S3MapValue -Map $resources -Name $name
  if($null -ne $resource -and [string](Get-S3MapValue -Map $resource -Name 'marker') -eq [string]$Context.RunId){return $true}
 }
 return $false
}

function Get-S3FailureMetadataRecord {
 [CmdletBinding()] param([AllowNull()][System.Management.Automation.ErrorRecord]$FailureRecord,[Parameter(Mandatory)][string]$Operation,[Parameter(Mandatory)][string]$SafeReason)
 $exceptionType='System.Exception';$scriptName='UNAVAILABLE';$function='UNAVAILABLE';$lineNumber=0;$position='UNAVAILABLE'
 if($null -ne $FailureRecord){
  if($null -ne $FailureRecord.Exception){$exceptionType=$FailureRecord.Exception.GetType().FullName}
  if($null -ne $FailureRecord.InvocationInfo){
   if(-not [string]::IsNullOrWhiteSpace([string]$FailureRecord.InvocationInfo.ScriptName)){$scriptName=[IO.Path]::GetFileName([string]$FailureRecord.InvocationInfo.ScriptName)}
   $command=$FailureRecord.InvocationInfo.MyCommand
   if($null -ne $command -and -not [string]::IsNullOrWhiteSpace([string]$command.Name)){$function=[string]$command.Name}
   $lineNumber=[int]$FailureRecord.InvocationInfo.ScriptLineNumber
   $position=Protect-S3Text ([string]$FailureRecord.InvocationInfo.PositionMessage)
  }
 }
 $fingerprint=Get-S3StableHash ("$exceptionType|$scriptName|$function|$lineNumber|$Operation|$SafeReason")
 return [ordered]@{exceptionType=$exceptionType;script=$scriptName;function=$function;lineNumber=$lineNumber;operation=$Operation;position=$position;fingerprint=$fingerprint}
}

function Write-S3FailureEvidence {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$Reason,[AllowNull()][System.Management.Automation.ErrorRecord]$FailureRecord=$null,[string]$Operation='UNKNOWN')
 $safe=Protect-S3Text $Reason
 $metadata=Get-S3FailureMetadataRecord -FailureRecord $FailureRecord -Operation $Operation -SafeReason $safe
 $stateSaved=$false
 try {
  Set-S3MapValue -Map $Context.State -Name 'failure' -Value ([ordered]@{reason=$safe;metadata=$metadata})
  Write-S3State -Root $Context.Root -State $Context.State
  $stateSaved=$true
 } catch {
  $reports=Join-Path $Context.Root 'reports'
  New-Item -ItemType Directory -Path $reports -Force|Out-Null
  [ordered]@{
   runId=[string]$Context.RunId
   currentState=[string](Get-S3MapValue -Map $Context.State -Name 'currentState')
   reason=$safe
   metadata=$metadata
   stateSaveError=Protect-S3Text $_.Exception.Message
  }|ConvertTo-Json -Depth 12|Set-Content (Join-Path $reports 'failure-fallback.json') -Encoding UTF8
 }
 try{Write-S3Log -Context $Context -Level ERROR -Message $safe}catch{Write-Verbose ("تعذر كتابة سجل الخطأ: " + $_.Exception.Message)}
 return [ordered]@{reason=$safe;metadata=$metadata;stateSaved=$stateSaved}
}

function Clear-S3RuntimeSecret {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context)
 foreach($key in @($Context.RuntimeSecrets.Keys)){
  $value=$Context.RuntimeSecrets[$key]
  if($value -is [byte[]]){[Array]::Clear($value,0,$value.Length)}
  elseif($value -is [char[]]){[Array]::Clear($value,0,$value.Length)}
  $Context.RuntimeSecrets[$key]=$null
 }
 $Context.RuntimeSecrets.Clear();[GC]::Collect();[GC]::WaitForPendingFinalizers()
}

function Get-S3StableHash {
 [CmdletBinding()] param([AllowNull()][string]$Value)
 if($null -eq $Value){$Value=''}
 $bytes=[Text.Encoding]::UTF8.GetBytes($Value);$digest=[Security.Cryptography.SHA256]::HashData($bytes)
 return ([BitConverter]::ToString($digest) -replace '-','').ToLowerInvariant()
}

function Assert-S3ResumeCheckpointSafe {
 [CmdletBinding()] param([Parameter(Mandatory)]$State)
 $current=[string](Get-S3MapValue -Map $State -Name 'currentState')
 if($current -notin @('40_PRE_CLOUD_GATE','50_FIREBASE_PROVISIONED','60_CLOUDFLARE_PROVISIONED','70_CPU_GATE_EXECUTED')){
  throw 'RESUME_REQUIRES_CLOSED_CHECKPOINT'
 }
 $completed=@(Get-S3MapValue -Map $State -Name 'completed')
 if($completed.Count -eq 0 -or $current -notin $completed){throw 'RESUME_CHECKPOINT_INCONSISTENT'}
 return $true
}

function Complete-S3CpuGateDecision {
 [CmdletBinding()] param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)]$CpuDecision)
 Set-S3MapValue -Map $Context.State.results -Name 'cpu' -Value $CpuDecision
 if([string](Get-S3MapValue -Map $CpuDecision -Name 'status') -ne 'PASS'){throw 'CPU_GATE_DECISION_FAILED'}
 Set-S3Checkpoint $Context '70_CPU_GATE_EXECUTED'
 return $CpuDecision
}

function Invoke-S3WithWorkerStateRestore {
 [CmdletBinding()] param(
  [Parameter(Mandatory)]$Context,
  [Parameter(Mandatory)][scriptblock]$Action,
  [Parameter(Mandatory)][scriptblock]$Restore,
  [scriptblock]$Snapshot=$null,
  [scriptblock]$Verify=$null
 )
  $remoteSnapshot=$null
  if($null -ne $Snapshot){$remoteSnapshot=& $Snapshot;if($null -eq $remoteSnapshot){throw 'REMOTE_WORKER_SNAPSHOT_UNAVAILABLE'}}
  $snapshotPath=Join-Path $Context.Root 'backups\worker-wrangler-before-cpu.json'
 $configPath=Join-Path $Context.Root 'workspace\worker\wrangler.json'
 if(-not (Test-Path -LiteralPath $configPath -PathType Leaf)){throw 'WORKER_STATE_SNAPSHOT_SOURCE_MISSING'}
 New-Item -ItemType Directory -Path (Split-Path $snapshotPath) -Force|Out-Null
 Copy-Item -LiteralPath $configPath -Destination $snapshotPath -Force
 $actionError=$null;$restoreError=$null;$result=$null
 try{$result=& $Action}catch{$actionError=$_.Exception}
 finally{
  try{Copy-Item -LiteralPath $snapshotPath -Destination $configPath -Force;& $Restore $remoteSnapshot;if($null -ne $Verify){$verification=& $Verify $remoteSnapshot;if($verification -ne $true){throw 'REMOTE_WORKER_RESTORE_VERIFICATION_FAILED'}}}catch{$restoreError=$_.Exception}
 }
 if($null -ne $restoreError){throw ('WORKER_STATE_RESTORE_FAILED:'+ (Protect-S3Text $restoreError.Message))}
 if($null -ne $actionError){throw $actionError}
 return $result
}

Export-ModuleMember -Function *-S3*
