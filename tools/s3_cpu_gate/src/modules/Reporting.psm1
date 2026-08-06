Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
function New-S3BlockerReport {
 [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$Reason)
 if(-not $PSCmdlet.ShouldProcess([string]$Context.RunId,'Create blocker report')){return}
 $safe=Protect-S3Text $Reason;$path=Join-Path $Context.Root 'reports\blocker.md';@('# مانع تشغيل','',"- Run ID: $($Context.RunId)","- المرحلة: $($Context.State.currentState)","- السبب: $safe",'','لم تُعتبر أي بوابة سحابية ناجحة.')|Set-Content $path -Encoding UTF8
 $zip=Join-Path $Context.Root 'artifacts\blocker-report.zip';if(Test-Path $zip){Remove-Item $zip -Force};Compress-Archive -Path $path,(Join-Path $Context.Root 'state.json') -DestinationPath $zip -CompressionLevel Optimal;return $zip
}
function New-S3FinalReport {
 [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)]$CpuDecision,[Parameter(Mandatory)]$CleanupResult)
 if(-not $PSCmdlet.ShouldProcess([string]$Context.RunId,'Create final report artifact')){return}
 $reports=Join-Path $Context.Root 'reports';$artifacts=Join-Path $Context.Root 'artifacts'
 $repo=Get-S3MapValue -Map $Context.State.results -Name 'repository';$pr=Get-S3MapValue -Map $Context.State.results -Name 'branchPr'
 $status=if($CpuDecision.status -eq 'PASS' -and $CleanupResult.status -eq 'PASS'){'PASS'}else{'FAIL'}
 $summary=@('# ملخص بوابة CPU — S3','',"- Run ID: $($Context.RunId)","- الوضع: $($Context.Mode)","- commit البداية: $($repo.commit)","- الفرع: $($pr.branch)","- Draft PR: $($pr.draftPr)","- CPU GATE: $($CpuDecision.status)","- تنظيف الموارد: $($CleanupResult.status)","- النتيجة النهائية: $status",'', 'لا يحتوي هذا التقرير أسرارًا أو بيانات حقيقية.')
 $summary|Set-Content (Join-Path $reports '00-summary-ar.md') -Encoding UTF8
 $meta=[ordered]@{runId=$Context.RunId;mode=$Context.Mode;startCommit=$repo.commit;branch=$pr.branch;draftPr=$pr.draftPr;cpuGate=$CpuDecision;cleanup=$CleanupResult;finalStatus=$status;toolVersions=(Get-S3MapValue -Map $Context.State.results -Name 'tools');risks=@('service API drift','account policy','OAuth failure','CPU telemetry availability')}
 $meta|ConvertTo-Json -Depth 30|Set-Content (Join-Path $reports 'final-result.json') -Encoding UTF8
 Assert-S3NoSecret -Context $Context -Path $reports
 $zip=Join-Path $artifacts 'S3-CPU-GATE-RESULT.zip';if(Test-Path $zip){Remove-Item $zip -Force};Compress-Archive -Path "$reports\*" -DestinationPath $zip -CompressionLevel Optimal
 Assert-S3NoSecret -Context $Context -Path $artifacts
 $hash=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant();@("$hash  S3-CPU-GATE-RESULT.zip")|Set-Content (Join-Path $artifacts 'SHA256SUMS.txt') -Encoding ASCII
 return [ordered]@{status=$status;zip=$zip;sha256=$hash}
}
Export-ModuleMember -Function *-S3*
