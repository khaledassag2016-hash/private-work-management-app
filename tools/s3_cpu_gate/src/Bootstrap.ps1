[CmdletBinding()]param([ValidateSet('Interactive','Plan','Simulation','Live')][string]$Mode='Interactive',[switch]$Resume,[switch]$SkipToolchain,[switch]$SyncRuntime,[string]$SourceRoot='',[string]$ExpectedSourceCommit='',[string]$PublicBaseUri='')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root='C:\Users\MC\Desktop\1'
if($PSScriptRoot -ne $root){throw 'شغّل الحزمة من C:\Users\MC\Desktop\1 فقط.'}
if($SyncRuntime){
 if([string]::IsNullOrWhiteSpace($SourceRoot)){throw 'SOURCE_ROOT_REQUIRED_FOR_RUNTIME_SYNC'}
 $setup=Join-Path $SourceRoot 'tools\s3_cpu_gate\S3-CPU-Gate-Setup.ps1'
 if(-not(Test-Path -LiteralPath $setup -PathType Leaf)){throw 'AUTHORITATIVE_SETUP_NOT_FOUND'}
 & $setup -RuntimeRoot $root -PreserveActiveState -ExpectedSourceCommit $ExpectedSourceCommit -Confirm:$false
 if($LASTEXITCODE -and $LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
$versionManifestPath=Join-Path $PSScriptRoot 'version-manifest.json'
if(-not(Test-Path -LiteralPath $versionManifestPath -PathType Leaf)){throw 'VERSION_MANIFEST_MISSING'}
$versionManifest=Get-Content -LiteralPath $versionManifestPath -Raw -Encoding UTF8|ConvertFrom-Json
if(-not $versionManifest.authoritative){throw 'VERSION_MANIFEST_NOT_AUTHORITATIVE'}
foreach($directory in @('tools','temp','reports','logs','config')){New-Item -ItemType Directory -Path (Join-Path $root $directory) -Force|Out-Null}
$pwshCommand=Get-Command pwsh.exe -ErrorAction SilentlyContinue
$pwsh=if($pwshCommand){$pwshCommand.Source}else{$null}
$requiredPowerShell=[string]$versionManifest.tools.powershell.version
if($pwsh){
 $actualPowerShell=(& $pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'|Select-Object -First 1)
 if([string]$actualPowerShell -ne $requiredPowerShell){$pwsh=$null}
}
if(-not $pwsh){
 $portable=Join-Path $root 'tools\powershell\pwsh.exe'
 if(Test-Path $portable){
  $actualPortable=(& $portable -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'|Select-Object -First 1)
  if([string]$actualPortable -eq $requiredPowerShell){$pwsh=$portable}else{Remove-Item (Split-Path $portable) -Recurse -Force}
 }
 if(-not $pwsh){
  Write-Information -InformationAction Continue "PowerShell $requiredPowerShell غير موجود. سيُنزل الملف الرسمي المحمول داخل مساحة العمل فقط."
  $answer=Read-Host 'اكتب 1 للمتابعة أو 2 للإلغاء';if($answer -ne '1'){exit 2}
  $definition=$versionManifest.tools.powershell
  $asset=$definition.assets.windows_x64
  $url=([string]$definition.releaseBaseUrl).TrimEnd('/')+'/'+[string]$asset.file
  $expected=[string]$asset.sha256
  $zip=Join-Path $root 'temp\powershell.zip';Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  $actual=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant();if($actual -ne $expected.ToLowerInvariant()){Remove-Item $zip -Force;throw 'فشل checksum لـPowerShell.'}
  New-Item (Split-Path $portable) -ItemType Directory -Force|Out-Null;Expand-Archive -LiteralPath $zip -DestinationPath (Split-Path $portable) -Force;Remove-Item $zip -Force;$pwsh=$portable
  $installed=(& $pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'|Select-Object -First 1);if([string]$installed -ne $requiredPowerShell){throw "POWERSHELL_VERSION_MISMATCH: $installed"}
 }
}
if(-not $SkipToolchain){& $pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Initialize-Toolchain.ps1');if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}}
$arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root 'S3-CpuGate-Orchestrator.ps1'),'-Mode',$Mode)
if($Resume){$arguments+='-Resume';$arguments+='-AutoRehydrateProviders'}
if(-not [string]::IsNullOrWhiteSpace($PublicBaseUri)){$arguments+='-PublicBaseUri';$arguments+=$PublicBaseUri}
& $pwsh @arguments
exit $LASTEXITCODE
