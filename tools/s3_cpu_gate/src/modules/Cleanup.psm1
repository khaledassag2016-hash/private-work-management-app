Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
function Invoke-S3Cleanup {
 param([Parameter(Mandatory)]$Context)
 $result=[ordered]@{
  runId=$Context.RunId
  startedUtc=[DateTime]::UtcNow.ToString('o')
  cloudflare=[ordered]@{status='NOT_ATTEMPTED'}
  firebase=[ordered]@{status='NOT_ATTEMPTED'}
  temp='NOT_ATTEMPTED'
  errors=@()
 }
 try{
  $result.cloudflare=Remove-S3CloudflareResource -Context $Context
 }catch{
  $safe=Protect-S3Text $_.Exception.Message
  $result.cloudflare=[ordered]@{status='FAILED';reason=$safe}
  $result.errors+=$safe
 }
 try{
  $result.firebase=Remove-S3FirebaseProject -Context $Context
 }catch{
  $safe=Protect-S3Text $_.Exception.Message
  $result.firebase=[ordered]@{status='FAILED';reason=$safe}
  $result.errors+=$safe
 }
 try{
  $temp=Join-Path $Context.Root 'temp'
  Get-ChildItem $temp -Force -ErrorAction SilentlyContinue|Remove-Item -Recurse -Force -ErrorAction Stop
  $result.temp='CLEARED'
 }catch{
  $safe=Protect-S3Text $_.Exception.Message
  $result.temp='FAILED'
  $result.errors+=$safe
 }
 try{
  Clear-S3RuntimeSecret -Context $Context
 }catch{
  $result.errors+=Protect-S3Text $_.Exception.Message
 }
 $env:CLOUDFLARE_API_TOKEN=$null
 $env:GOOGLE_APPLICATION_CREDENTIALS=$null
 $env:FIREBASE_TOKEN=$null
 $env:GH_TOKEN=$null
 [GC]::Collect()
 [GC]::WaitForPendingFinalizers()
 $result.finishedUtc=[DateTime]::UtcNow.ToString('o')
 $result.status=$(if($result.errors.Count -eq 0){'PASS'}else{'FAIL'})
 $reports=Join-Path $Context.Root 'reports'
 New-Item -ItemType Directory -Path $reports -Force|Out-Null
 $result|ConvertTo-Json -Depth 20|Set-Content (Join-Path $reports 'resource-destruction.json') -Encoding UTF8
 @(
  '# تقرير حذف الموارد'
  ''
  "- Cloudflare: $($result.cloudflare.status)"
  "- Firebase: $($result.firebase.status)"
  "- Temp: $($result.temp)"
  "- النتيجة: $($result.status)"
 )|Set-Content (Join-Path $reports 'resource-destruction.md') -Encoding UTF8
 return $result
}
Export-ModuleMember -Function *-S3*
