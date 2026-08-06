[CmdletBinding()]
param([ValidateSet('Interactive','Plan','Simulation','Live')][string]$Mode='Interactive',[switch]$Resume,[switch]$NoOpenFolder,[string]$CloudflareAccountId='')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$moduleRoot=Join-Path $PSScriptRoot 'modules'
foreach($module in @('Toolchain','Common','Ui','Prerequisites','Repository','Firebase','Cloudflare','CpuGate','Cleanup','Reporting')){Import-Module (Join-Path $moduleRoot "$module.psm1") -Force}
Enable-S3LocalToolPath -Root $PSScriptRoot
if($Mode -eq 'Interactive'){$Mode=Select-S3Mode}
$context=$null;$cleanupResult=$null;$cpu=[ordered]@{status='NOT_EXECUTED';reasons=@('NOT_REACHED')};$hadFailure=$false
try{
 $context=New-S3Context -Mode $Mode -Resume:$Resume;Write-S3Log -Context $context -Message "بدء التشغيل $($context.RunId) بوضع $Mode"
 if($Mode -eq 'Live' -and $context.IsResumed -and (Test-S3HasOwnedCloudResource -Context $context)){
  throw 'استؤنف تشغيل Live بعد انقطاع مع موارد موجودة لكن الأسرار كانت في الذاكرة فقط. ستنفذ الحزمة التنظيف الآمن؛ أعد التشغيل بعده للحصول على Run ID جديد.'
 }
 if($context.State.currentState -eq '00_PACKAGE_READY'){Show-S3Stage 1 9 'فحص الجهاز' 'لن يتم إنشاء أي خدمة أو تعديل المستودع.';$prerequisites=Invoke-S3Prerequisite -Context $context;Set-S3MapValue -Map $context.State.results -Name 'tools' -Value $prerequisites.tools;Set-S3Checkpoint $context '10_LOCAL_PREREQUISITES'}
 if($context.State.currentState -eq '10_LOCAL_PREREQUISITES'){Show-S3Stage 2 9 'بوابة المستودع' 'تشغيل تحقق S1 وS2 دون إصلاح تلقائي.';$repository=Invoke-S3RepositoryGate -Context $context;Set-S3MapValue -Map $context.State.results -Name 'repository' -Value $repository;Set-S3Checkpoint $context '20_REPOSITORY_GATE'}
 if($context.State.currentState -eq '20_REPOSITORY_GATE'){Show-S3Stage 3 9 'الفرع وDraft PR' 'في Plan لا كتابة. في Live ينشأ فرع وDraft PR فقط.';$branchPr=Invoke-S3BranchAndDraftPr -Context $context;Set-S3MapValue -Map $context.State.results -Name 'branchPr' -Value $branchPr;Set-S3Checkpoint $context '30_BRANCH_AND_DRAFT_PR'}
 if($Mode -eq 'Plan'){@('# نتيجة Plan','',"- Run ID: $($context.RunId)",'- لا موارد سحابية.','- لا فرع أو PR.','- الخطوة التالية بعد المراجعة: Simulation أو Live.')|Set-Content (Join-Path $context.Root 'reports\plan.md') -Encoding UTF8;Write-Information -InformationAction Continue 'اكتملت الخطة الآمنة دون أي كتابة.';return}
 if($context.State.currentState -eq '30_BRANCH_AND_DRAFT_PR'){
  Show-S3Stage 4 9 'بوابة Cloudflare للقراءة فقط' 'تعمل قبل Firebase وقبل أي كتابة سحابية.';Assert-S3NoSecret -Context $context -Path $context.Root
  $selectedAccountId=$CloudflareAccountId
  if($Mode -eq 'Live' -and [string]::IsNullOrWhiteSpace($selectedAccountId)){$selectedAccountId=Read-Host 'أدخل Cloudflare Account ID الذي اخترته بوضوح من قائمة الحسابات'}
  $preflight=Invoke-S3CloudflareReadOnlyPreflight -Context $context -SelectedAccountId $selectedAccountId
  if($preflight.status -ne 'PASS'){throw 'CLOUDFLARE_READ_ONLY_PREFLIGHT_FAILED'}
  Set-S3MapValue -Map $context.State.results -Name 'cloudflarePreflight' -Value $preflight
  Set-S3Checkpoint $context '40_PRE_CLOUD_GATE'
 }
 if($context.State.currentState -eq '40_PRE_CLOUD_GATE'){Show-S3Stage 5 9 'Firebase التجريبية' 'مشروع Spark مؤقت وحسابان مصطنعان فقط.';$firebase=Invoke-S3FirebaseProvision -Context $context;Set-S3MapValue -Map $context.State.results -Name 'firebase' -Value $firebase;Set-S3Checkpoint $context '50_FIREBASE_PROVISIONED'}
 if($context.State.currentState -eq '50_FIREBASE_PROVISIONED'){Show-S3Stage 6 9 'Cloudflare التجريبية' 'Worker وD1 مؤقتتان على Free وworkers.dev فقط.';$cloudflare=Invoke-S3CloudflareProvision -Context $context;Set-S3MapValue -Map $context.State.results -Name 'cloudflare' -Value $cloudflare;Set-S3Checkpoint $context '60_CLOUDFLARE_PROVISIONED'}
 if($context.State.currentState -eq '60_CLOUDFLARE_PROVISIONED'){Show-S3Stage 7 9 'بوابة CPU' '20 warm-up، جولتان hit، و20 miss، مع قياس CPU رسمي.';$cpu=Invoke-S3CpuGate -Context $context;Set-S3MapValue -Map $context.State.results -Name 'cpu' -Value $cpu;Set-S3Checkpoint $context '70_CPU_GATE_EXECUTED'}
}catch{
 $hadFailure=$true
 $failureReason=Protect-S3Text $_.Exception.Message
 if($null -ne $context){
  [void](Write-S3FailureEvidence -Context $context -Reason $failureReason)
  try{New-S3BlockerReport -Context $context -Reason $failureReason|Out-Null}catch{Write-Verbose ("تعذر إنشاء blocker-report.zip: " + $_.Exception.Message)}
 }
 Write-Information -InformationAction Continue ('توقف آمن: '+$failureReason)
}finally{
 try{
  if($null -ne $context -and $Mode -ne 'Plan' -and (Test-S3HasOwnedCloudResource -Context $context)){
   Show-S3Stage 8 9 'التنظيف الإلزامي' 'سيُحذف فقط ما أنشأته الحزمة ويحمل Run ID.'
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
  if($null -ne $context){[void](Write-S3FailureEvidence -Context $context -Reason $finalizationReason)}
  Write-Information -InformationAction Continue ('توقف آمن أثناء التنظيف أو التقرير: '+$finalizationReason)
 }finally{
  if($null -ne $context){try{Clear-S3RuntimeSecret -Context $context}catch{Write-Verbose ("تعذر المسح النهائي لأسرار الذاكرة: " + $_.Exception.Message)}}
 }
}
if($hadFailure){exit 1}
