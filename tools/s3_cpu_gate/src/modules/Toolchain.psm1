Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:VersionManifestPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'version-manifest.json'
if (-not (Test-Path -LiteralPath $script:VersionManifestPath -PathType Leaf)) { throw 'VERSION_MANIFEST_MISSING' }
$script:VersionManifest = Get-Content -LiteralPath $script:VersionManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $script:VersionManifest.authoritative) { throw 'VERSION_MANIFEST_NOT_AUTHORITATIVE' }
$tools = $script:VersionManifest.tools
$script:ToolDefinitions = [ordered]@{
 PowerShell = @{ Version=[string]$tools.powershell.version; Purpose='محرك PowerShell المقفل' }
 Python = @{ Version=[string]$tools.python.version; Url=[string]$tools.python.assets.windows_x64.url; Sha256=[string]$tools.python.assets.windows_x64.sha256; ApproxMB=12; Purpose='تحليل النتائج والتقارير محليًا' }
 Node = @{ Version=[string]$tools.node.version; Url=([string]$tools.node.releaseBaseUrl).TrimEnd('/')+'/'+[string]$tools.node.assets.windows_x64; ChecksumUrl=[string]$tools.node.checksumsUrl; Asset=[string]$tools.node.assets.windows_x64; ApproxMB=37; Purpose='تشغيل Firebase CLI وWrangler محليًا' }
 Npm = @{ Version=[string]$tools.npm.version; Purpose='مدير الحزم المحلي المقفل' }
 GoogleCloud = @{ Version=[string]$tools.gcloud.version; Url=[string]$tools.gcloud.url; Sha256=[string]$tools.gcloud.sha256; ApproxMB=85; Purpose='التحقق من Billing وحذف Firebase Project' }
 GitHubCli = @{ Version=[string]$tools.githubCli.version; Repo=[string]$tools.githubCli.repository; Asset=[string]$tools.githubCli.asset; ApproxMB=16; Purpose='الوصول الآمن للمستودع وDraft PR' }
 Git = @{ Version=[string]$tools.git.resolution; Repo=[string]$tools.git.repository; AssetRegex=[string]$tools.git.assetRegex; ApproxMB=65; Purpose='استنساخ المستودع وإنشاء الفرع' }
 FirebaseCli = @{ Version=[string]$tools.firebaseCli.version; Purpose='إنشاء Firebase التجريبية وإعداد Authentication' }
 Wrangler = @{ Version=[string]$tools.wrangler.version; Purpose='إنشاء Worker وD1 وقراءة القياس الرسمي' }
 Pester = @{ Version=[string]$tools.pester.version; Purpose='اختبارات PowerShell' }
 PSScriptAnalyzer = @{ Version=[string]$tools.psscriptanalyzer.version; Purpose='التحليل الساكن لـPowerShell' }
}

function Enable-S3LocalToolPath {
 [CmdletBinding()]param([string]$Root='C:\Users\MC\Desktop\1')
 $paths=@(
  (Join-Path $Root 'tools\git\cmd'),(Join-Path $Root 'tools\git\bin'),
  (Join-Path $Root 'tools\git\usr\bin'),(Join-Path $Root 'tools\git\mingw64\bin'),(Join-Path $Root 'tools\gh\bin'),
  (Join-Path $Root 'tools\node'),(Join-Path $Root 'tools\npm\node_modules\.bin'),
  (Join-Path $Root 'tools\google-cloud-sdk\bin'),(Join-Path $Root 'python'),(Join-Path $Root 'tools\powershell')
 )
 foreach($path in ($paths|Where-Object{Test-Path $_}|Select-Object -Unique)){if(($env:PATH -split ';') -notcontains $path){$env:PATH="$path;$env:PATH"}}
 $modulePath=Join-Path $Root 'tools\psmodules';if(Test-Path $modulePath){if(($env:PSModulePath -split ';') -notcontains $modulePath){$env:PSModulePath="$modulePath;$env:PSModulePath"}}
 $env:CLOUDSDK_CONFIG=Join-Path $Root 'config\gcloud';$env:FIREBASE_CONFIG_DIR=Join-Path $Root 'config\firebase';$env:WRANGLER_HOME=Join-Path $Root 'config\wrangler';$env:npm_config_cache=Join-Path $Root 'temp\npm-cache'
}
function Get-S3FileHashLower {param([string]$Path)(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Invoke-S3VerifiedDownload {
 [CmdletBinding()]param([string]$Url,[string]$Destination,[string]$ExpectedSha256)
 New-Item -ItemType Directory -Path (Split-Path $Destination) -Force|Out-Null
 Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -MaximumRedirection 10
 if(-not [string]::IsNullOrWhiteSpace($ExpectedSha256)){$actual=Get-S3FileHashLower $Destination;if($actual -ne $ExpectedSha256.ToLowerInvariant()){Remove-Item $Destination -Force;throw "CHECKSUM_MISMATCH: $Url"}}
}
function Get-S3GitHubReleaseAsset {
 [CmdletBinding()]param([string]$Repository,[string]$Tag='latest',[string]$AssetName,[string]$AssetRegex)
 $headers=@{'User-Agent'='S3-CPU-Gate-Tooling'};$uri=if($Tag -eq 'latest'){"https://api.github.com/repos/$Repository/releases/latest"}else{"https://api.github.com/repos/$Repository/releases/tags/$Tag"}
 $release=Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 90
 $asset=@($release.assets|Where-Object{($_.name -eq $AssetName) -or ($AssetRegex -and $_.name -match $AssetRegex)}|Select-Object -First 1)
 if($asset.Count -ne 1){throw "تعذر تحديد أصل GitHub الرسمي: $Repository"}
 $digest=[string]$asset[0].digest;if($digest -notmatch '^sha256:[0-9a-fA-F]{64}$'){throw "لا يوجد SHA-256 رسمي للأصل: $($asset[0].name)"}
 [ordered]@{Url=[string]$asset[0].browser_download_url;Sha256=$digest.Substring(7).ToLowerInvariant();Name=[string]$asset[0].name;Version=[string]$release.tag_name}
}
function Install-S3Python {
 param([string]$Root)
 $exe=Join-Path $Root 'python\python.exe';if(Test-Path $exe){return}
 $definition=$script:ToolDefinitions.Python;$zip=Join-Path $Root 'temp\python.zip';Invoke-S3VerifiedDownload $definition.Url $zip $definition.Sha256;New-Item (Split-Path $exe) -ItemType Directory -Force|Out-Null;Expand-Archive $zip (Split-Path $exe) -Force;Remove-Item $zip -Force
}
function Install-S3Node {
 param([string]$Root)
 $exe=Join-Path $Root 'tools\node\node.exe';if(Test-Path $exe){return}
 $definition=$script:ToolDefinitions.Node;$checksums=(Invoke-WebRequest $definition.ChecksumUrl -UseBasicParsing).Content;$match=[regex]::Match($checksums,"(?m)^([0-9a-f]{64})\s+$([regex]::Escape($definition.Asset))$");if(-not $match.Success){throw 'تعذر استخراج Node SHA-256 الرسمي.'}
 $zip=Join-Path $Root 'temp\node.zip';Invoke-S3VerifiedDownload $definition.Url $zip $match.Groups[1].Value;$extract=Join-Path $Root 'temp\node-extract';Expand-Archive $zip $extract -Force;$folder=Get-ChildItem $extract -Directory|Select-Object -First 1;New-Item (Split-Path $exe) -ItemType Directory -Force|Out-Null;Copy-Item "$($folder.FullName)\*" (Split-Path $exe) -Recurse -Force;Remove-Item $zip,$extract -Recurse -Force
}
function Install-S3GitHubCli {
 param([string]$Root)
 $exe=Join-Path $Root 'tools\gh\bin\gh.exe';if(Test-Path $exe){return}
 $definition=$script:ToolDefinitions.GitHubCli;$asset=Get-S3GitHubReleaseAsset -Repository $definition.Repo -Tag "v$($definition.Version)" -AssetName $definition.Asset;$zip=Join-Path $Root 'temp\gh.zip';Invoke-S3VerifiedDownload $asset.Url $zip $asset.Sha256;$extract=Join-Path $Root 'temp\gh-extract';Expand-Archive $zip $extract -Force;$source=Get-ChildItem $extract -Recurse -Filter gh.exe|Select-Object -First 1;New-Item (Split-Path $exe) -ItemType Directory -Force|Out-Null;Copy-Item $source.FullName $exe -Force;Remove-Item $zip,$extract -Recurse -Force
}
function Install-S3PortableGit {
 param([string]$Root)
 $exe=Join-Path $Root 'tools\git\cmd\git.exe';if(Test-Path $exe){return}
 $definition=$script:ToolDefinitions.Git;$asset=Get-S3GitHubReleaseAsset -Repository $definition.Repo -AssetRegex $definition.AssetRegex;$archive=Join-Path $Root 'temp\portable-git.exe';Invoke-S3VerifiedDownload $asset.Url $archive $asset.Sha256;$destination=Join-Path $Root 'tools\git';New-Item $destination -ItemType Directory -Force|Out-Null;$process=Start-Process -FilePath $archive -ArgumentList @('-y',"-o$destination") -Wait -PassThru -NoNewWindow;if($process.ExitCode -ne 0){throw 'فشل استخراج PortableGit.'};Remove-Item $archive -Force
}
function Install-S3GoogleCloud {
 param([string]$Root)
 $command=Join-Path $Root 'tools\google-cloud-sdk\bin\gcloud.cmd';if(Test-Path $command){return}
 $definition=$script:ToolDefinitions.GoogleCloud;$zip=Join-Path $Root 'temp\gcloud.zip';Invoke-S3VerifiedDownload $definition.Url $zip $definition.Sha256;Expand-Archive $zip (Join-Path $Root 'tools') -Force;Remove-Item $zip -Force
}
function Install-S3NpmTool {
 param([string]$Root)
 Enable-S3LocalToolPath -Root $Root;$npm=(Get-Command npm.cmd -ErrorAction Stop).Source;$prefix=Join-Path $Root 'tools\npm';New-Item $prefix -ItemType Directory -Force|Out-Null
 & $npm install --prefix $prefix --no-audit --no-fund --ignore-scripts "npm@$($script:ToolDefinitions.Npm.Version)"
 if($LASTEXITCODE -ne 0){throw 'فشل تثبيت npm المقفل محليًا.'}
 $node=(Get-Command node.exe -ErrorAction Stop).Source;$pinnedNpm=Join-Path $prefix 'node_modules\npm\bin\npm-cli.js'
 & $node $pinnedNpm install --prefix $prefix --no-audit --no-fund --ignore-scripts "firebase-tools@$($script:ToolDefinitions.FirebaseCli.Version)" "wrangler@$($script:ToolDefinitions.Wrangler.Version)"
 if($LASTEXITCODE -ne 0){throw 'فشل تثبيت Firebase CLI أو Wrangler محليًا.'}
}
function Install-S3PowerShellModule {
 param([string]$Root)
 $modulePath=Join-Path $Root 'tools\psmodules';New-Item $modulePath -ItemType Directory -Force|Out-Null
 foreach($name in @('Pester','PSScriptAnalyzer')){$version=$script:ToolDefinitions[$name].Version;if(-not(Test-Path (Join-Path $modulePath "$name\$version"))){Save-Module -Name $name -RequiredVersion $version -Path $modulePath -Repository PSGallery -Force -ErrorAction Stop}}
}
function Get-S3ToolPlan {
 $rows=@()
 foreach($name in $script:ToolDefinitions.Keys){
  $definition=$script:ToolDefinitions[$name]
  if(-not $definition.ContainsKey('Version') -or -not $definition.ContainsKey('Purpose')){throw "TOOL_DEFINITION_INVALID: $name"}
  $approxMb=0
  if($definition.ContainsKey('ApproxMB') -and $null -ne $definition['ApproxMB']){$approxMb=$definition['ApproxMB']}
  $source='PowerShell Gallery/npm official registry'
  if($definition.ContainsKey('Url') -and -not [string]::IsNullOrWhiteSpace([string]$definition['Url'])){$source=[string]$definition['Url']}
  elseif($definition.ContainsKey('Repo') -and -not [string]::IsNullOrWhiteSpace([string]$definition['Repo'])){$source=[string]$definition['Repo']}
  $rows+=[pscustomobject]@{Name=$name;Version=[string]$definition['Version'];ApproxMB=$approxMb;Purpose=[string]$definition['Purpose'];Source=$source}
 }
 return $rows
}
function Initialize-S3LocalToolchain {
 [CmdletBinding()]param([string]$Root='C:\Users\MC\Desktop\1',[switch]$NonInteractive)
 Enable-S3LocalToolPath -Root $Root
 $plan=Get-S3ToolPlan;Write-Information -InformationAction Continue 'الأدوات المحلية المطلوبة:';foreach($row in $plan){Write-Information -InformationAction Continue ("- {0} {1}: {2} (نحو {3} MB)" -f $row.Name,$row.Version,$row.Purpose,$row.ApproxMB)}
 if(-not $NonInteractive){$answer=Read-Host 'اكتب 1 لتنزيل المفقود من المصادر الرسمية أو 2 للإلغاء';if($answer -ne '1'){throw 'ألغى المستخدم تنزيل الأدوات.'}}
 Install-S3Python $Root;Install-S3Node $Root;Enable-S3LocalToolPath $Root;Install-S3GitHubCli $Root;Install-S3PortableGit $Root;Install-S3GoogleCloud $Root;Install-S3NpmTool $Root;Install-S3PowerShellModule $Root;Enable-S3LocalToolPath $Root
 $versions=[ordered]@{}
 $versionCommands=[ordered]@{
  pwsh=@('pwsh','-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()');python=@('python','--version');node=@('node','--version');npm=@('npm','--version');firebase=@('firebase','--version');wrangler=@('wrangler','--version');gcloud=@('gcloud','version','--format=value(core.version)')
 }
 foreach($name in $versionCommands.Keys){$spec=$versionCommands[$name];$command=$spec[0];$resolved=Get-Command $command -ErrorAction SilentlyContinue;if(-not $resolved){throw "TOOL_MISSING: $name"};$output=& $resolved.Source @($spec[1..($spec.Count-1)]) 2>$null|Select-Object -First 1;$versions[$name]=[string]$output}
 $expected=[ordered]@{pwsh=$script:ToolDefinitions.PowerShell.Version;python=$script:ToolDefinitions.Python.Version;node=$script:ToolDefinitions.Node.Version;npm=$script:ToolDefinitions.Npm.Version;firebase=$script:ToolDefinitions.FirebaseCli.Version;wrangler=$script:ToolDefinitions.Wrangler.Version;gcloud=$script:ToolDefinitions.GoogleCloud.Version}
 foreach($name in $expected.Keys){$actual=([string]$versions[$name]).TrimStart('v').Replace('Python ','');if($actual -ne [string]$expected[$name]){throw "TOOL_VERSION_MISMATCH: $name expected=$($expected[$name]) actual=$actual"}}
 $versions|ConvertTo-Json -Depth 5|Set-Content (Join-Path $Root 'reports\toolchain-paths.json') -Encoding UTF8
}
Export-ModuleMember -Function *-S3*,Initialize-S3LocalToolchain
