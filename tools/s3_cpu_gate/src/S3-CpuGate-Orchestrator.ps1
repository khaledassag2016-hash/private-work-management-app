[CmdletBinding()]
param([ValidateSet('Interactive','Plan','Simulation','Live')][string]$Mode='Interactive',[switch]$Resume,[switch]$NoOpenFolder,[switch]$AutoRehydrateProviders,[string]$CloudflareAccountId='',[string]$PublicBaseUri='',[scriptblock]$FirebaseCredentialProvider=$null,[scriptblock]$CloudflareObservabilityTokenProvider=$null)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$moduleRoot=Join-Path $PSScriptRoot 'modules'
foreach($module in @('Toolchain','Common','Ui','Prerequisites','Repository','Firebase','Cloudflare','CpuGate','Cleanup','Reporting')){Import-Module (Join-Path $moduleRoot "$module.psm1") -Force}
Enable-S3LocalToolPath -Root $PSScriptRoot
if($Mode -eq 'Interactive'){$Mode=Select-S3Mode}
$context=$null;$cleanupResult=$null;$cpu=[ordered]@{status='NOT_EXECUTED';reasons=@('NOT_REACHED')};$hadFailure=$false;$cpuDecisionFailed=$false
try{
 $context=New-S3Context -Mode $Mode -Resume:$Resume
 if($AutoRehydrateProviders -and $context.IsResumed -and $context.State.currentState -eq '60_CLOUDFLARE_PROVISIONED'){
  if($null -eq $FirebaseCredentialProvider){$FirebaseCredentialProvider=New-S3FirebaseCredentialProvider -Context $context}
  if($null -eq $CloudflareObservabilityTokenProvider){$CloudflareObservabilityTokenProvider=New-S3CloudflareObservabilityTokenProvider -Context $context}
 }
 Write-S3Log -Context $context -Message "بدء التشغيل $($context.RunId) بوضع $Mode"
 if($null -eq (Get-S3MapValue -Map $context.State.results -Name 'cliSessions')){[void](Initialize-S3CliSessionInventory -Context $context)}
 if($context.IsResumed){
  [void](Assert-S3ResumeCheckpointSafe -State $context.State)
  if($context.State.currentState -in @('40_PRE_CLOUD_GATE','50_FIREBASE_PROVISIONED')){throw 'PRESERVED_STATE_REQUIRES_CLOUDFLARE_CHECKPOINT'}
  if($context.State.currentState -eq '60_CLOUDFLARE_PROVISIONED'){
   $firebaseResource=Get-S3MapValue -Map $context.State.resources -Name 'firebase';$cloudflareResource=Get-S3MapValue -Map $context.State.resources -Name 'cloudflare'
   $expectedUids=@((Get-S3MapValue -Map $firebaseResource -Name 'uid1'),(Get-S3MapValue -Map $firebaseResource -Name 'uid2')) | Where-Object {-not [string]::IsNullOrWhiteSpace([string]$_)}
   if($null -eq $FirebaseCredentialProvider){throw 'FIREBASE_REHYDRATION_CREDENTIAL_PROVIDER_REQUIRED'}
   if($null -eq $CloudflareObservabilityTokenProvider){throw 'CLOUDFLARE_OBSERVABILITY_PROVIDER_REQUIRED'}
   $cleanupCredential=Restore-S3CloudflareCleanupCredential -Context $context
   if($cleanupCredential.status -notin @('RUNTIME_PRESENT','RECOVERED')){throw 'CLOUDFLARE_REHYDRATION_SESSION_REQUIRED'}
   $workerRehydration=Invoke-S3CloudflareRuntimeRehydration -Context $context -AccountId ([string](Get-S3MapValue -Map $cloudflareResource -Name 'accountId')) -WorkerName ([string](Get-S3MapValue -Map $cloudflareResource -Name 'worker')) -Token ([string](Get-S3MapValue -Map $context.RuntimeSecrets -Name 'cloudflareToken')) -ObservabilityTokenProvider $CloudflareObservabilityTokenProvider
   $rehydration=Invoke-S3FirebaseRuntimeRehydration -Context $context -ExpectedUids $expectedUids -CredentialProvider $FirebaseCredentialProvider
   Set-S3MapValue -Map $context.State.results -Name 'firebaseRehydration' -Value ([ordered]@{status=$rehydration.status;sameUids=$rehydration.sameUids;provisioningSkipped=$rehydration.provisioningSkipped;secrets='MEMORY_ONLY'})
   Set-S3MapValue -Map $context.State.results -Name 'cloudflareRehydration' -Value ([ordered]@{status=$workerRehydration.status;nonce=$workerRehydration.nonce;nonceType=$workerRehydration.nonceType;observability=$workerRehydration.observability;secrets='MEMORY_ONLY'})
   Write-S3State -Root $context.Root -State $context.State
  }
  if($context.State.currentState -eq '70_CPU_GATE_EXECUTED'){
   $cpu=Get-S3MapValue -Map $context.State.results -Name 'cpu'
   if($null -eq $cpu -or [string](Get-S3MapValue -Map $cpu -Name 'status') -ne 'PASS'){throw 'RESUME_CPU_RESULT_NOT_PASS'}
  }
 }
 if($context.State.currentState -eq '00_PACKAGE_READY'){Show-S3Stage 1 9 'فحص الجهاز' 'لن يتم إنشاء أي خدمة أو تعديل المستودع.';$prerequisites=Invoke-S3Prerequisite -Context $context;Set-S3MapValue -Map $context.State.results -Name 'tools' -Value $prerequisites.tools;Set-S3Checkpoint $context '10_LOCAL_PREREQUISITES'}
 if($context.State.currentState -eq '10_LOCAL_PREREQUISITES'){Show-S3Stage 2 9 'بوابة المستودع' 'تشغيل تحقق S1 وS2 دون إصلاح تلقائي.';$repository=Invoke-S3RepositoryGate -Context $context;Set-S3MapValue -Map $context.State.results -Name 'repository' -Value $repository;Set-S3Checkpoint $context '20_REPOSITORY_GATE'}
 if($context.State.currentState -eq '20_REPOSITORY_GATE'){Show-S3Stage 3 9 'الفرع وDraft PR' 'في Plan لا كتابة. في Live ينشأ فرع وDraft PR فقط.';$branchPr=Invoke-S3BranchAndDraftPr -Context $context;Set-S3MapValue -Map $context.State.results -Name 'branchPr' -Value $branchPr;Set-S3Checkpoint $context '30_BRANCH_AND_DRAFT_PR'}
 if($Mode -eq 'Plan'){@('# نتيجة Plan','',"- Run ID: $($context.RunId)",'- لا موارد سحابية.','- لا فرع أو PR.','- الخطوة التالية بعد المراجعة: Simulation أو Live.')|Set-Content (Join-Path $context.Root 'reports\plan.md') -Encoding UTF8;Write-Information -InformationAction Continue 'اكتملت الخطة الآمنة دون أي كتابة.';return}
 if($context.State.currentState -eq '30_BRANCH_AND_DRAFT_PR'){
  Show-S3Stage 4 9 'بوابة Cloudflare للقراءة فقط' 'تعمل قبل Firebase وقبل أي كتابة سحابية.';[void](Assert-S3DeploymentPayloadNoSecret -Context $context -Scope PreCloud)
  $selectedAccountId=$CloudflareAccountId
  if($Mode -eq 'Live' -and [string]::IsNullOrWhiteSpace($selectedAccountId)){$selectedAccountId=Read-Host 'أدخل Cloudflare Account ID الذي اخترته بوضوح من قائمة الحسابات'}
  $preflight=Invoke-S3CloudflareReadOnlyPreflight -Context $context -SelectedAccountId $selectedAccountId
  if($preflight.status -ne 'PASS'){throw 'CLOUDFLARE_READ_ONLY_PREFLIGHT_FAILED'}
  Set-S3MapValue -Map $context.State.results -Name 'cloudflarePreflight' -Value $preflight
  Set-S3Checkpoint $context '40_PRE_CLOUD_GATE'
 }
 if($context.State.currentState -eq '40_PRE_CLOUD_GATE' -and -not $context.IsResumed){Show-S3Stage 5 9 'Firebase التجريبية' 'مشروع Spark مؤقت وحسابان مصطنعان فقط.';$firebase=Invoke-S3FirebaseProvision -Context $context;Set-S3MapValue -Map $context.State.results -Name 'firebase' -Value $firebase;Set-S3Checkpoint $context '50_FIREBASE_PROVISIONED'}
 if($context.State.currentState -eq '50_FIREBASE_PROVISIONED' -and -not $context.IsResumed){Show-S3Stage 6 9 'Cloudflare التجريبية' 'Worker وD1 مؤقتتان على Free وworkers.dev فقط.';$cloudflare=Invoke-S3CloudflareProvision -Context $context;Set-S3MapValue -Map $context.State.results -Name 'cloudflare' -Value $cloudflare;Set-S3Checkpoint $context '60_CLOUDFLARE_PROVISIONED'}
 if($context.State.currentState -eq '60_CLOUDFLARE_PROVISIONED'){
  Show-S3Stage 7 9 'بوابة CPU' '20 warm-up، جولتان hit، و20 miss، مع قياس CPU رسمي.'
  if($context.Mode -eq 'Live'){
   $cloudflareResource=Get-S3MapValue -Map $context.State.resources -Name 'cloudflare';$workerName=[string](Get-S3MapValue -Map $cloudflareResource -Name 'worker');$accountId=[string](Get-S3MapValue -Map $cloudflareResource -Name 'accountId');$workerToken=[string](Get-S3MapValue -Map $context.RuntimeSecrets -Name 'cloudflareToken')
   $cpu=Invoke-S3WithWorkerStateRestore -Context $context -Snapshot { Get-S3CloudflareWorkerRemoteSnapshot -Context $context -AccountId $accountId -WorkerName $workerName -Token $workerToken } -Action { Invoke-S3CpuGate -Context $context -PublicBaseUri $PublicBaseUri } -Restore { param($snapshot) $versionId=[string](Get-S3CloudflareValue -InputObject $snapshot.public.deployment -Name 'activeVersionId');if([string]::IsNullOrWhiteSpace($versionId)){throw 'REMOTE_WORKER_ACTIVE_VERSION_MISSING'};$restore=Invoke-S3Process -Context $context -FilePath 'wrangler' -ArgumentList @('versions','deploy',$versionId,'--name',$workerName,'--yes') -WorkingDirectory (Join-Path $context.Root 'workspace\worker') -TimeoutSeconds 600;if($restore.ExitCode -ne 0){throw 'REMOTE_WORKER_VERSION_RESTORE_FAILED'} } -Verify { param($snapshot) $after=Get-S3CloudflareWorkerRemoteSnapshot -Context $context -AccountId $accountId -WorkerName $workerName -Token $workerToken;Test-S3CloudflareWorkerRemoteSnapshot -Before $snapshot -After $after }
   Set-S3MapValue -Map $cpu -Name 'REMOTE_WORKER_RESTORE_VERIFIED' -Value $true;Set-S3MapValue -Map $cpu -Name 'REMOTE_WORKER_EFFECTIVE_STATE_RESTORED' -Value $true
  }else{$cpu=Invoke-S3CpuGate -Context $context -PublicBaseUri $PublicBaseUri}
  Complete-S3CpuGateDecision -Context $context -CpuDecision $cpu | Out-Null
 }
 if($context.State.currentState -eq '70_CPU_GATE_EXECUTED' -and $context.IsResumed){$cpu=Get-S3MapValue -Map $context.State.results -Name 'cpu'}
}catch{
 $hadFailure=$true
 $failureReason=Protect-S3Text $_.Exception.Message
 $cpuDecisionFailed=($failureReason -eq 'CPU_GATE_DECISION_FAILED')
 if($null -ne $context){
  [void](Write-S3FailureEvidence -Context $context -Reason $failureReason -FailureRecord $_ -Operation 'orchestrator.main')
  if(-not $cpuDecisionFailed){try{New-S3BlockerReport -Context $context -Reason $failureReason|Out-Null}catch{Write-Verbose ("تعذر إنشاء blocker-report.zip: " + $_.Exception.Message)}}
 }
 Write-Information -InformationAction Continue ('توقف آمن: '+$failureReason)
}finally{
 try{
   $hasOwnedCloudResource=$false;if($null -ne $context){$hasOwnedCloudResource=Test-S3HasOwnedCloudResource -Context $context}
   $resumedSuccess=($null -ne $context -and $context.IsResumed -and $context.State.currentState -eq '70_CPU_GATE_EXECUTED' -and $null -ne $cpu -and [string](Get-S3MapValue -Map $cpu -Name 'status') -eq 'PASS' -and -not $hadFailure)
   if($null -ne $context -and $Mode -ne 'Plan' -and $hasOwnedCloudResource -and (-not $cpuDecisionFailed) -and (-not $context.IsResumed -or $resumedSuccess)){
   Show-S3Stage 8 9 'التنظيف الإلزامي' 'سيُحذف فقط ما أنشأته الحزمة ويحمل Run ID، وستُحفظ جلسات المستخدم السابقة.'
   $cleanupResult=Invoke-S3Cleanup -Context $context
   if($context.State.currentState -eq '70_CPU_GATE_EXECUTED' -and $cleanupResult.status -eq 'PASS'){Set-S3Checkpoint $context '80_RESOURCES_DESTROYED'}
   elseif($cleanupResult.status -ne 'PASS'){$hadFailure=$true}
  }
  if($null -ne $context -and $context.State.currentState -eq '80_RESOURCES_DESTROYED'){
   Show-S3Stage 9 9 'التقرير النهائي' 'إنشاء ZIP منقح جاهز للرفع.'
   $final=New-S3FinalReport -Context $context -CpuDecision $cpu -CleanupResult $cleanupResult
   Set-S3MapValue -Map $context.State.results -Name 'final' -Value $final
   Set-S3Checkpoint $context '90_REPORT_READY'
   Write-Information -InformationAction Continue "CPU GATE: $($cpu.status)"
   Write-Information -InformationAction Continue "التقرير: $($final.zip)"
   if(-not $NoOpenFolder){Start-Process explorer.exe (Join-Path $context.Root 'artifacts')}
  }
 }catch{
  $hadFailure=$true
  $finalizationReason=Protect-S3Text $_.Exception.Message
  if($null -ne $context){[void](Write-S3FailureEvidence -Context $context -Reason $finalizationReason -FailureRecord $_ -Operation 'orchestrator.finalization')}
  Write-Information -InformationAction Continue ('توقف آمن أثناء التنظيف أو التقرير: '+$finalizationReason)
 }finally{
  if($null -ne $context -and $context.RuntimeSecrets.Count -ne 0){
   try{Clear-S3RuntimeSecret -Context $context}
   catch{
    $hadFailure=$true
    $clearReason=Protect-S3Text $_.Exception.Message
    [void](Write-S3FailureEvidence -Context $context -Reason $clearReason -FailureRecord $_ -Operation 'orchestrator.secret-cleanup')
   }
  }
 }
}
if($hadFailure){exit 1}
