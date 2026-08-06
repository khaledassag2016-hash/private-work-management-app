[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateRoot,
    [Parameter(Mandatory)][ValidateSet('x64','arm64')][string]$Architecture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$FixedRoot = 'C:\Users\MC\Desktop\1'
$ToolsRoot = Join-Path $FixedRoot 'tools'
$ModulesRoot = Join-Path $FixedRoot 'modules'
$ReportsRoot = Join-Path $FixedRoot 'reports'
$ArtifactsRoot = Join-Path $FixedRoot 'artifacts'
$TempRoot = Join-Path $FixedRoot 'temp'
$RunId = 'local-validation-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$RunReports = Join-Path $ReportsRoot $RunId
$ExecutionLog = Join-Path $RunReports 'execution-log-redacted.txt'
$PackageManifest = Get-Content -LiteralPath (Join-Path $CandidateRoot 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$VersionManifest = Get-Content -LiteralPath (Join-Path $CandidateRoot ([string]$PackageManifest.versionManifest)) -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $VersionManifest.authoritative) { throw 'VERSION_MANIFEST_NOT_AUTHORITATIVE' }
$PwshPath = Join-Path $ToolsRoot 'pwsh\pwsh.exe'
$PythonPath = Join-Path $ToolsRoot 'python\python.exe'
$NodePath = Join-Path $ToolsRoot 'node\node.exe'
$GateResults = [ordered]@{}

function Protect-LvText {
    [CmdletBinding()]
    param([AllowNull()][string]$Text)
    if ($null -eq $Text) { return '' }
    $safe = $Text
    $patterns = @(
        '(?is)-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
        '(?i)(Authorization\s*[:=]\s*Bearer\s+)[^\s"'']+',
        '(?i)(password\s*[:=]\s*)[^,\s}\]]+',
        '(?i)((?:access|refresh|id|oauth)[_-]?token\s*[:=]\s*)[^,\s}\]]+',
        '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'
    )
    foreach ($pattern in $patterns) {
        if ($pattern -match '^\(\?i\)\(') { $safe = [regex]::Replace($safe, $pattern, '$1[REDACTED]') }
        else { $safe = [regex]::Replace($safe, $pattern, '[REDACTED]') }
    }
    return $safe
}

function Write-LvLog {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Message,[ValidateSet('INFO','WARN','ERROR')][string]$Level='INFO')
    $line = '{0} [{1}] {2}' -f ([DateTime]::UtcNow.ToString('o')), $Level, (Protect-LvText $Message)
    Add-Content -LiteralPath $ExecutionLog -Value $line -Encoding UTF8
    Write-Information -InformationAction Continue (Protect-LvText $Message)
}

function Invoke-LvDownload {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Uri,[Parameter(Mandatory)][string]$Destination)
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Write-LvLog "تنزيل أداة رسمية: $Uri"
    Invoke-WebRequest -Uri $Uri -OutFile $Destination -MaximumRedirection 10 -TimeoutSec 300
}

function Install-LvPython {
    [CmdletBinding()]
    param()
    $definition = $VersionManifest.tools.python
    $version = [string]$definition.version
    if (Test-Path -LiteralPath $PythonPath) {
        $existing = (& $PythonPath -c 'import sys; print(".".join(map(str,sys.version_info[:3])))' 2>$null | Select-Object -First 1)
        if ([string]$existing -eq $version) { return }
        $backup = Join-Path $FixedRoot ('local-validation\backups\python-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Move-Item -LiteralPath (Split-Path -Parent $PythonPath) -Destination $backup
    }
    $assetKey = 'windows_' + $Architecture
    $assetProperty = $definition.assets.PSObject.Properties[$assetKey]
    if ($null -eq $assetProperty) { throw "لا يوجد أصل Python للمعمارية $Architecture." }
    $asset = $assetProperty.Value
    $url = [string]$asset.url
    $expected = [string]$asset.sha256
    $zip = Join-Path $TempRoot ('python-' + $Architecture + '.zip')
    Invoke-LvDownload -Uri $url -Destination $zip
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected.ToLowerInvariant()) { throw 'فشل SHA-256 لحزمة Python الرسمية.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $PythonPath) -Force | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath (Split-Path -Parent $PythonPath) -Force
    Remove-Item -LiteralPath $zip -Force
    if (-not (Test-Path -LiteralPath $PythonPath)) { throw 'لم يظهر python.exe بعد فك الحزمة.' }
}

function Install-LvNode {
    [CmdletBinding()]
    param()
    $definition = $VersionManifest.tools.node
    $version = [string]$definition.version
    if (Test-Path -LiteralPath $NodePath) {
        $existing = (& $NodePath --version 2>$null | Select-Object -First 1).TrimStart('v')
        if ([string]$existing -eq $version) { return }
        $backup = Join-Path $FixedRoot ('local-validation\backups\node-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Move-Item -LiteralPath (Split-Path -Parent $NodePath) -Destination $backup
    }
    $assetKey = 'windows_' + $Architecture
    $assetProperty = $definition.assets.PSObject.Properties[$assetKey]
    if ($null -eq $assetProperty) { throw "لا يوجد أصل Node.js للمعمارية $Architecture." }
    $asset = [string]$assetProperty.Value
    $base = [string]$definition.releaseBaseUrl
    $checksumsUrl = [string]$definition.checksumsUrl
    $checksumsFile = Join-Path $TempRoot 'node-SHASUMS256.txt'
    $zip = Join-Path $TempRoot $asset
    Invoke-LvDownload -Uri $checksumsUrl -Destination $checksumsFile
    $match = [regex]::Match((Get-Content -LiteralPath $checksumsFile -Raw), ('(?im)^([0-9a-f]{64})\s+\*?' + [regex]::Escape($asset) + '\s*$'))
    if (-not $match.Success) { throw 'تعذر استخراج بصمة Node.js الرسمية.' }
    Invoke-LvDownload -Uri ($base + '/' + $asset) -Destination $zip
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $match.Groups[1].Value.ToLowerInvariant()) { throw 'فشل SHA-256 لحزمة Node.js الرسمية.' }
    $extract = Join-Path $TempRoot ('node-extract-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
    $folder = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
    if ($null -eq $folder) { throw 'بنية حزمة Node.js غير متوقعة.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $NodePath) -Force | Out-Null
    Copy-Item -Path (Join-Path $folder.FullName '*') -Destination (Split-Path -Parent $NodePath) -Recurse -Force
    Remove-Item -LiteralPath $zip,$checksumsFile,$extract -Recurse -Force
    if (-not (Test-Path -LiteralPath $NodePath)) { throw 'لم يظهر node.exe بعد فك الحزمة.' }
}

function Install-LvModule {
    [CmdletBinding()]
    param()
    $gallery = Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue
    if ($null -eq $gallery -or [string]$gallery.SourceLocation -notmatch '^https://www\.powershellgallery\.com/api/v2/?$') {
        throw 'PowerShell Gallery الرسمية غير مسجلة بالعنوان المتوقع. لم تُعدّل إعدادات النظام.'
    }
    foreach ($name in @('Pester','PSScriptAnalyzer')) {
        $moduleVersionProperty = $VersionManifest.tools.PSObject.Properties[$name.ToLowerInvariant()]
        if ($null -eq $moduleVersionProperty) { throw "إصدار الوحدة $name غير موجود في manifest." }
        $version = [string]$moduleVersionProperty.Value.version
        $modulePath = Join-Path $ModulesRoot ($name + '\' + $version)
        if (-not (Test-Path -LiteralPath $modulePath)) {
            Write-LvLog "تنزيل $name $version إلى مجلد محلي فقط."
            Save-Module -Name $name -RequiredVersion $version -Path $ModulesRoot -Repository PSGallery -Force -AcceptLicense -ErrorAction Stop
        }
        $manifestPath = Get-ChildItem -LiteralPath $modulePath -Filter ($name + '.psd1') -File -Recurse | Select-Object -First 1
        if ($null -eq $manifestPath) { throw "تعذر العثور على manifest للوحدة $name." }
        Import-Module -Name $manifestPath.FullName -RequiredVersion $version -Force -ErrorAction Stop
        $loaded = Get-Module -Name $name | Where-Object { $_.Version.ToString() -eq $version } | Select-Object -First 1
        if ($null -eq $loaded) { throw "لم تُحمّل الوحدة $name بالإصدار المقيد." }
    }
    $env:PSModulePath = "$ModulesRoot;$env:PSModulePath"
    $hashRows = foreach ($file in Get-ChildItem -LiteralPath $ModulesRoot -Recurse -File) {
        [ordered]@{path=$file.FullName;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $hashRows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunReports 'module-file-hashes.json') -Encoding UTF8
}

function Invoke-LvSyntaxValidation {
    [CmdletBinding()]
    param()
    $rows = @()
    $files = Get-ChildItem -LiteralPath $CandidateRoot -Recurse -File | Where-Object { $_.Extension -in @('.ps1','.psm1','.psd1') }
    foreach ($file in $files) {
        $tokens = $null
        $errors = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
        $rows += [ordered]@{
            file = $file.FullName.Substring($CandidateRoot.Length + 1)
            errorCount = @($errors).Count
            errors = @($errors | ForEach-Object { [ordered]@{message=$_.Message;line=$_.Extent.StartLineNumber;column=$_.Extent.StartColumnNumber} })
        }
    }
    $payload = [ordered]@{fileCount=$files.Count;errorCount=(@($rows | ForEach-Object {$_.errorCount} | Measure-Object -Sum).Sum);files=$rows}
    $payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $RunReports 'powershell-syntax-results.json') -Encoding UTF8
    return $payload
}

function Invoke-LvPSScriptAnalyzer {
    [CmdletBinding()]
    param()
    $settings = Join-Path $CandidateRoot 'settings\PSScriptAnalyzerSettings.psd1'
    $raw = @(Invoke-ScriptAnalyzer -Path $CandidateRoot -Recurse -Settings $settings)
    $rows = @(foreach ($item in $raw) {
        $severity = [string]$item.Severity
        $rule = [string]$item.RuleName
        $allowedReason = $null
        $blocking = ($severity -eq 'Error') -or ($severity -eq 'Warning')
        [ordered]@{
            severity=$severity;rule=$rule;message=[string]$item.Message
            file=[string]$item.ScriptPath;line=[int]$item.Line;column=[int]$item.Column
            blocking=$blocking;acceptedReason=$allowedReason
        }
    })
    $payload = [ordered]@{
        total=$rows.Count
        errors=@($rows | Where-Object {$_.severity -eq 'Error'}).Count
        warnings=@($rows | Where-Object {$_.severity -eq 'Warning'}).Count
        information=@($rows | Where-Object {$_.severity -eq 'Information'}).Count
        blocking=@($rows | Where-Object {$_.blocking}).Count
        results=@($rows)
    }
    $payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $RunReports 'psscriptanalyzer-results.json') -Encoding UTF8
    return $payload
}

function Invoke-LvPester {
    [CmdletBinding()]
    param()
    $resultPath = Join-Path $RunReports 'pester-results.xml'
    $config = New-PesterConfiguration
    $config.Run.Path = Join-Path $CandidateRoot 'source\tests\pester'
    $config.Run.PassThru = $true
    $config.Output.Verbosity = 'Detailed'
    $config.TestResult.Enabled = $true
    $config.TestResult.OutputFormat = 'NUnitXml'
    $config.TestResult.OutputPath = $resultPath
    $result = Invoke-Pester -Configuration $config
    $summary = [ordered]@{
        discovered=[int]$result.TotalCount
        passed=[int]$result.PassedCount
        failed=[int]$result.FailedCount
        skipped=[int]$result.SkippedCount
        notRun=[int]$result.NotRunCount
        durationSeconds=[double]$result.Duration.TotalSeconds
        result=[string]$result.Result
        pesterVersion=(Get-Module Pester).Version.ToString()
        powershellVersion=$PSVersionTable.PSVersion.ToString()
        exitCode=if ($result.FailedCount -eq 0 -and $result.SkippedCount -eq 0 -and $result.NotRunCount -eq 0) {0} else {1}
        files=@(Get-ChildItem -LiteralPath (Join-Path $CandidateRoot 'source\tests\pester') -Filter '*.Tests.ps1' | ForEach-Object {$_.Name})
    }
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $RunReports 'pester-summary.json') -Encoding UTF8
    return $summary
}

function Invoke-LvPythonTest {
    [CmdletBinding()]
    param()
    $output = Join-Path $RunReports 'python-test-results.json'
    & $PythonPath (Join-Path $CandidateRoot 'validation\run_python_tests.py') --source-root (Join-Path $CandidateRoot 'source') --output $output
    $exitCode = $LASTEXITCODE
    $payload = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
    $payload | Add-Member -NotePropertyName exitCode -NotePropertyValue $exitCode -Force
    $payload | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $output -Encoding UTF8
    return $payload
}

function Invoke-LvNodeValidation {
    [CmdletBinding()]
    param()
    $worker = Join-Path $CandidateRoot 'source\src\worker\src\index.js'
    $syntaxOutput = & $NodePath --check $worker 2>&1
    $syntaxExit = $LASTEXITCODE
    $testFiles = @(Get-ChildItem -LiteralPath (Join-Path $CandidateRoot 'source') -Recurse -File | Where-Object { $_.Name -match '(^test_.*\.(mjs|js)$|.*\.test\.(mjs|js)$)' })
    $testsExit = 0
    $testsOutput = @()
    if ($testFiles.Count -gt 0) {
        $arguments = @('--test') + @($testFiles.FullName)
        $testsOutput = & $NodePath @arguments 2>&1
        $testsExit = $LASTEXITCODE
    }
    $payload = [ordered]@{
        nodeVersion=(& $NodePath --version | Select-Object -First 1)
        workerSyntax=[ordered]@{exitCode=$syntaxExit;status=if($syntaxExit -eq 0){'PASS'}else{'FAIL'};output=@($syntaxOutput | ForEach-Object {Protect-LvText ([string]$_)})}
        tests=[ordered]@{count=$testFiles.Count;files=@($testFiles.FullName);exitCode=$testsExit;status=if($testsExit -eq 0){'PASS'}else{'FAIL'};output=@($testsOutput | ForEach-Object {Protect-LvText ([string]$_)})}
    }
    $payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $RunReports 'node-validation-results.json') -Encoding UTF8
    return $payload
}

function Invoke-LvSecretScan {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Output)
    & $PythonPath (Join-Path $CandidateRoot 'validation\secret_scan_candidate.py') $Path --output $Output
    $code = $LASTEXITCODE
    $payload = Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json
    $payload | Add-Member -NotePropertyName exitCode -NotePropertyValue $code -Force
    $payload | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Output -Encoding UTF8
    return $payload
}

function New-LvChecksum {
  [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)][string]$Directory)
 if(-not $PSCmdlet.ShouldProcess($Directory,'Create SHA256SUMS.txt')){return}
    $lines = foreach ($file in Get-ChildItem -LiteralPath $Directory -Recurse -File | Where-Object {$_.Name -ne 'SHA256SUMS.txt'} | Sort-Object FullName) {
        $relative = $file.FullName.Substring($Directory.Length + 1).Replace('\','/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash *$relative"
    }
    $lines | Set-Content -LiteralPath (Join-Path $Directory 'SHA256SUMS.txt') -Encoding ASCII
}

function New-LvArtifact {
  [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)][bool]$Success,[Parameter(Mandatory)][string]$Reason)
 if(-not $PSCmdlet.ShouldProcess($RunId,'Create local validation artifact')){return}
    $stage = Join-Path $TempRoot ($RunId + '-artifact')
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    $required = @(
        'LOCAL-VALIDATION-SUMMARY-AR.md','environment.json','tool-versions.json','powershell-syntax-results.json',
        'pester-results.xml','pester-summary.json','psscriptanalyzer-results.json','powershell-e2e-simulation.json',
        'python-test-results.json','node-validation-results.json','secret-scan-results.json','execution-log-redacted.txt','module-file-hashes.json'
    )
    foreach ($name in $required) {
        $source = Join-Path $RunReports $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $stage -Force }
    }
    Copy-Item -LiteralPath (Join-Path $CandidateRoot 'package-manifest.json') -Destination $stage -Force
    if (-not $Success) {
        $safeReason = Protect-LvText $Reason
        @(
            '# مانع التحقق المحلي', '',
            '- التصنيف: UNAPPROVED — LOCAL VALIDATION ONLY',
            '- المرحلة: Local Validation', "- السبب المنقح: $safeReason", '- Exit code: 1',
            '', 'الخطوات الآلية المنفذة موثقة في execution-log-redacted.txt والتقارير المتاحة.',
            'التوصية: لا تُصلح المصدر يدويًا. ارفع هذا الملف إلى جلسة Tooling.'
        ) | Set-Content -LiteralPath (Join-Path $stage 'LOCAL-VALIDATION-BLOCKER-AR.md') -Encoding UTF8
        [ordered]@{
            stage='Local Validation';status='BLOCKED';exitCode=1;message=$safeReason
            gateResults=$GateResults;toolVersions=if (Test-Path (Join-Path $RunReports 'tool-versions.json')) { Get-Content (Join-Path $RunReports 'tool-versions.json') -Raw | ConvertFrom-Json } else { $null }
            recommendation='Return this ZIP to the Tooling session; do not modify source or run repair commands.'
        } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $stage 'blocker.json') -Encoding UTF8
    }
    New-LvChecksum -Directory $stage
    $preZipScan = Invoke-LvSecretScan -Path $stage -Output (Join-Path $stage 'pre-zip-secret-scan.json')
    if ($preZipScan.findingCount -ne 0) { throw 'رفض إنشاء ZIP: كشف فحص ما قبل الضغط مادة حساسة.' }
    New-LvChecksum -Directory $stage
    $fileName = if ($Success) {'S3-CPU-Gate-LOCAL-VALIDATION-RESULT.zip'} else {'S3-CPU-Gate-LOCAL-VALIDATION-BLOCKER.zip'}
    $zip = Join-Path $ArtifactsRoot $fileName
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
    return $zip
}

try {
    foreach ($path in @($ToolsRoot,$ModulesRoot,$ReportsRoot,$ArtifactsRoot,$TempRoot,$RunReports)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
    Set-Content -LiteralPath $ExecutionLog -Value '' -Encoding UTF8
    Write-LvLog 'بدء التحقق المحلي. لن يُطلب تسجيل دخول، ولن تُنشأ موارد سحابية.'

    Write-LvLog 'المرحلة 1 من 8 — تجهيز Python وNode.js المحمولين من المصادر الرسمية.'
    Install-LvPython
    Install-LvNode

    Write-LvLog 'المرحلة 2 من 8 — تنزيل Pester وPSScriptAnalyzer محليًا من PowerShell Gallery.'
    Install-LvModule

    $environment = [ordered]@{
        runId=$RunId;classification='UNAPPROVED — LOCAL VALIDATION ONLY';timestampUtc=[DateTime]::UtcNow.ToString('o')
        os=[Environment]::OSVersion.VersionString;architecture=$Architecture;is64BitOperatingSystem=[Environment]::Is64BitOperatingSystem
        fixedRoot=$FixedRoot;candidateRoot=$CandidateRoot;adminRequired=$false
    }
    $environment | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $RunReports 'environment.json') -Encoding UTF8
    $toolVersions = [ordered]@{
        powershell=$PSVersionTable.PSVersion.ToString();pester=(Get-Module Pester).Version.ToString();psscriptanalyzer=(Get-Module PSScriptAnalyzer).Version.ToString()
        python=(& $PythonPath -c 'import sys; print(sys.version.split()[0])' | Select-Object -First 1)
        node=(& $NodePath --version | Select-Object -First 1)
    }
    $toolVersions | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RunReports 'tool-versions.json') -Encoding UTF8
    $expectedVersions = [ordered]@{powershell=[string]$VersionManifest.tools.powershell.version;pester=[string]$VersionManifest.tools.pester.version;psscriptanalyzer=[string]$VersionManifest.tools.psscriptanalyzer.version;python=[string]$VersionManifest.tools.python.version;node=[string]$VersionManifest.tools.node.version}
    foreach ($name in $expectedVersions.Keys) { $actual=([string]$toolVersions[$name]).TrimStart('v'); if ($actual -ne [string]$expectedVersions[$name]) { throw "TOOL_VERSION_MISMATCH: $name expected=$($expectedVersions[$name]) actual=$actual" } }

    Write-LvLog 'المرحلة 3 من 8 — فحص صياغة جميع ملفات PowerShell فعليًا.'
    $syntax = Invoke-LvSyntaxValidation
    $GateResults.syntax = ($syntax.errorCount -eq 0)

    Write-LvLog 'المرحلة 4 من 8 — تشغيل PSScriptAnalyzer على جميع ملفات PowerShell.'
    $analyzer = Invoke-LvPSScriptAnalyzer
    $GateResults.psscriptanalyzer = ($analyzer.blocking -eq 0)

    Write-LvLog ("المرحلة 5 من 8 — تشغيل اختبارات Pester الـ{0} كاملة." -f [int]$PackageManifest.tests.pester_expected)
    $pester = Invoke-LvPester
    $expectedPester = [int]$PackageManifest.tests.pester_expected
    $GateResults.pester = ($pester.discovered -eq $expectedPester -and $pester.failed -eq 0 -and $pester.skipped -eq 0 -and $pester.notRun -eq 0)

    Write-LvLog 'المرحلة 6 من 8 — تشغيل المحاكاة الكاملة لمنسق PowerShell وحالات الاستئناف والفشل والتنظيف.'
    $e2ePath = Join-Path $RunReports 'powershell-e2e-simulation.json'
    & $PwshPath -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $CandidateRoot 'validation\Invoke-E2EScenarios.ps1') -CandidateRoot $CandidateRoot -PwshPath $PwshPath -OutputPath $e2ePath
    $e2eCode = $LASTEXITCODE
    $e2e = Get-Content -LiteralPath $e2ePath -Raw | ConvertFrom-Json
    $GateResults.e2e = ($e2eCode -eq 0 -and $e2e.status -eq 'PASS')

    Write-LvLog 'المرحلة 7 من 8 — تشغيل جميع اختبارات Python وفحص Worker بواسطة Node.js.'
    $python = Invoke-LvPythonTest
    $expectedPython = [int]$PackageManifest.tests.python_expected
    $GateResults.python = ($python.total -eq $expectedPython -and $python.failed -eq 0 -and $python.skipped -eq 0)
    $node = Invoke-LvNodeValidation
    $GateResults.node = ($node.workerSyntax.status -eq 'PASS' -and $node.tests.status -eq 'PASS')

    Write-LvLog 'المرحلة 8 من 8 — فحص الأسرار وبناء التقرير المنقح.'
    $secret = Invoke-LvSecretScan -Path $CandidateRoot -Output (Join-Path $RunReports 'secret-scan-results.json')
    $GateResults.secrets = ($secret.findingCount -eq 0)

    $success = @($GateResults.Values | Where-Object { -not $_ }).Count -eq 0
    $summary = @(
        '# ملخص التحقق المحلي — S3 CPU Gate Tooling', '',
        '- التصنيف: UNAPPROVED — LOCAL VALIDATION ONLY',
        "- Run ID: $RunId", "- PowerShell: $($toolVersions.powershell)", "- Pester: $($toolVersions.pester)", "- PSScriptAnalyzer: $($toolVersions.psscriptanalyzer)",
        "- PowerShell syntax: $(if($GateResults.syntax){'PASS'}else{'FAIL'})",
        "- Pester: $($pester.passed)/$($pester.discovered) PASS; Failed=$($pester.failed); Skipped=$($pester.skipped); NotRun=$($pester.notRun)",
        "- PSScriptAnalyzer blocking findings: $($analyzer.blocking)",
        "- PowerShell E2E simulation: $(if($GateResults.e2e){'PASS'}else{'FAIL'})",
        "- Python: $($python.passed)/$($python.total) PASS",
        "- Node.js: $(if($GateResults.node){'PASS'}else{'FAIL'})",
        "- Secret scan: $(if($GateResults.secrets){'PASS'}else{'FAIL'})", '',
        "- النتيجة: $(if($success){'PASS'}else{'BLOCKED — LOCAL VALIDATION FAILED'})",
        '', 'لم تُنشأ موارد Firebase أو Cloudflare أو GitHub، ولم يُطلب تسجيل دخول.'
    )
    $summary | Set-Content -LiteralPath (Join-Path $RunReports 'LOCAL-VALIDATION-SUMMARY-AR.md') -Encoding UTF8
    $zip = New-LvArtifact -Success:$success -Reason 'فشل واحد أو أكثر من بوابات التحقق المحلي. راجع التقارير داخل ملف المانع.'
    Write-LvLog "اكتمل إنشاء التقرير: $zip"
    Start-Process explorer.exe $ArtifactsRoot
    if (-not $success) { exit 1 }
    exit 0
} catch {
    $reason = Protect-LvText $_.Exception.Message
    Write-LvLog $reason 'ERROR'
    if (-not (Test-Path -LiteralPath (Join-Path $RunReports 'LOCAL-VALIDATION-SUMMARY-AR.md'))) {
        @('# ملخص التحقق المحلي','', '- النتيجة: BLOCKED — LOCAL VALIDATION FAILED', "- السبب: $reason") | Set-Content -LiteralPath (Join-Path $RunReports 'LOCAL-VALIDATION-SUMMARY-AR.md') -Encoding UTF8
    }
    $zip = New-LvArtifact -Success:$false -Reason $reason
    Write-Information -InformationAction Continue "توقف آمن. ملف المانع: $zip"
    Start-Process explorer.exe $ArtifactsRoot -ErrorAction SilentlyContinue
    exit 1
} finally {
    Get-ChildItem -LiteralPath $TempRoot -Directory -Filter ($RunId + '*') -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
