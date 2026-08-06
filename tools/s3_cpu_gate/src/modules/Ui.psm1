Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
function Show-S3Stage {
 param([int]$Number,[int]$Total=9,[string]$Title,[string]$Body)
 try {
  if(-not [Console]::IsOutputRedirected){Clear-Host}
 } catch {
  Write-Verbose ("تعذر مسح الشاشة؛ سيستمر العرض دون مسحها: " + $_.Exception.Message)
 }
 Write-Information -InformationAction Continue "المرحلة $Number من $Total — $Title";Write-Information -InformationAction Continue '';Write-Information -InformationAction Continue $Body;Write-Information -InformationAction Continue ''
}
function Confirm-S3Arabic { param([string]$Title,[string]$Body) Show-S3Stage -Number 5 -Title $Title -Body $Body;while($true){$a=Read-Host 'اكتب 1 للمتابعة أو 2 للإلغاء';if($a -eq '1'){return $true};if($a -eq '2'){return $false};Write-Information -InformationAction Continue 'اختيار غير صحيح.'} }
function Select-S3Mode { Write-Information -InformationAction Continue '1 — خطة فقط (آمن، بلا كتابة)';Write-Information -InformationAction Continue '2 — محاكاة كاملة (بلا حسابات حقيقية)';Write-Information -InformationAction Continue '3 — تشغيل فعلي بعد المراجعة';$a=Read-Host 'اختر';switch($a){'2'{'Simulation'}'3'{'Live'}default{'Plan'}} }
Export-ModuleMember -Function *-S3*
