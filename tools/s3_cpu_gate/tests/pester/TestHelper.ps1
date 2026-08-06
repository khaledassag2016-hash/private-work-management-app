$SourceRoot=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ModuleRoot=Join-Path $SourceRoot 'src\modules'

$MainSourceRoot=Join-Path $SourceRoot 'src'
$NestedPayloadRoot=(Join-Path $MainSourceRoot 'repository_payload')
function Get-MainSourceFile {
 param([string[]]$Extension=@())
 $files=Get-ChildItem -LiteralPath $MainSourceRoot -Recurse -Force -File|Where-Object{
  -not $_.FullName.StartsWith($NestedPayloadRoot,[StringComparison]::OrdinalIgnoreCase)
 }
 if($Extension.Count -gt 0){$files=$files|Where-Object{$_.Extension -in $Extension}}
 return @($files)
}
foreach($name in @('Common','Ui','Prerequisites','Repository','Firebase','Cloudflare','CpuGate','Cleanup','Reporting')){Get-Module -Name $name -All|Remove-Module -Force -ErrorAction SilentlyContinue;Import-Module (Join-Path $ModuleRoot "$name.psm1") -Force}
function Get-TestContext {
 param([string]$Mode='Simulation')
 foreach($directory in @('reports','logs','temp','workspace','repository','artifacts')){
  New-Item -ItemType Directory -Path (Join-Path $TestDrive $directory) -Force | Out-Null
 }
 [pscustomobject]@{
  Root=$TestDrive;Mode=$Mode;RunId='s3cpu-20260803-174000-abcdef12';RuntimeSecrets=[ordered]@{};IsResumed=$false
  State=[ordered]@{schemaVersion=2;runId='s3cpu-20260803-174000-abcdef12';mode=$Mode;currentState='00_PACKAGE_READY';completed=@('00_PACKAGE_READY');resources=[ordered]@{};results=[ordered]@{};failure=$null}
 }
}
