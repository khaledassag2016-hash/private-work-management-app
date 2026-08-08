[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$ReportDirectory,
    [ValidateSet('main','payload')][string]$ScopeName = 'payload',
    [string]$SettingsPath = '',
    [string]$ExcludedPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$resolvedReports = (Resolve-Path -LiteralPath $ReportDirectory).Path

if ([string]::IsNullOrWhiteSpace($SettingsPath)) {
    $candidate = Join-Path $resolvedRoot 'settings/PSScriptAnalyzerSettings.psd1'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $SettingsPath = $candidate
    }
    else {
        $SettingsPath = Join-Path (Split-Path -Parent $resolvedRoot) 'settings/PSScriptAnalyzerSettings.psd1'
    }
}
$SettingsPath = (Resolve-Path -LiteralPath $SettingsPath).Path

$manifestPath = Join-Path $resolvedRoot 'src/version-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.authoritative -or -not $manifest.policy.singleSource) {
    throw 'VERSION_MANIFEST_NOT_AUTHORITATIVE'
}

$expectedPester = [string]$manifest.tools.pester.version
$expectedAnalyzer = [string]$manifest.tools.psscriptanalyzer.version
Import-Module Pester -RequiredVersion $expectedPester -Force -ErrorAction Stop
Import-Module PSScriptAnalyzer -RequiredVersion $expectedAnalyzer -Force -ErrorAction Stop

$activeVersions = [ordered]@{
    powershell = $PSVersionTable.PSVersion.ToString()
    pester = (Get-Module Pester -ErrorAction Stop).Version.ToString()
    psscriptanalyzer = (Get-Module PSScriptAnalyzer -ErrorAction Stop).Version.ToString()
}
$expectedVersions = [ordered]@{
    powershell = [string]$manifest.tools.powershell.version
    pester = [string]$manifest.tools.pester.version
    psscriptanalyzer = [string]$manifest.tools.psscriptanalyzer.version
}
foreach ($name in $expectedVersions.Keys) {
    if ([string]$activeVersions[$name] -ne [string]$expectedVersions[$name]) {
        throw "TOOL_VERSION_MISMATCH: $name expected=$($expectedVersions[$name]) actual=$($activeVersions[$name])"
    }
}

$files = @(
    Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force -File |
        Where-Object {
            $_.Extension -in @('.ps1','.psm1','.psd1') -and
            ([string]::IsNullOrWhiteSpace($ExcludedPath) -or
             -not $_.FullName.StartsWith($ExcludedPath,[StringComparison]::OrdinalIgnoreCase))
        } |
        Sort-Object FullName
)

$syntaxRows = New-Object System.Collections.Generic.List[object]
$syntaxErrorCount = 0
foreach ($file in $files) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $file.FullName,
        [ref]$tokens,
        [ref]$errors
    )
    $syntaxErrorCount += @($errors).Count
    $syntaxRows.Add([ordered]@{
        file = $file.FullName
        errorCount = @($errors).Count
        errors = @($errors | ForEach-Object {
            [ordered]@{
                message = $_.Message
                line = $_.Extent.StartLineNumber
                column = $_.Extent.StartColumnNumber
                text = $_.Extent.Text
            }
        })
    })
}
$parserStatus = if ($syntaxErrorCount -eq 0) { 'PASS' } else { 'FAIL' }
[ordered]@{
    scope = $ScopeName
    status = $parserStatus
    fileCount = $files.Count
    errorCount = $syntaxErrorCount
    files = $syntaxRows
} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $resolvedReports 'parser.json') -Encoding UTF8

$analysis = New-Object System.Collections.Generic.List[object]
foreach ($file in $files) {
    foreach ($item in @(Invoke-ScriptAnalyzer -Path $file.FullName -Settings $SettingsPath)) {
        $analysis.Add([ordered]@{
            file = [string]$item.ScriptPath
            line = [int]$item.Line
            column = [int]$item.Column
            severity = [string]$item.Severity
            rule = [string]$item.RuleName
            message = [string]$item.Message
        })
    }
}
$blocking = @($analysis | Where-Object { $_.severity -in @('Error','Warning') })
$analyzerStatus = if ($blocking.Count -eq 0) { 'PASS' } else { 'FAIL' }
[ordered]@{
    scope = $ScopeName
    status = $analyzerStatus
    fileCount = $files.Count
    findingCount = $analysis.Count
    warningCount = @($analysis | Where-Object {$_.severity -eq 'Warning'}).Count
    errorCount = @($analysis | Where-Object {$_.severity -eq 'Error'}).Count
    blockingCount = $blocking.Count
    findings = @($analysis | Sort-Object file,line,rule,message)
} | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $resolvedReports 'psscriptanalyzer.json') -Encoding UTF8

$pesterResultPath = Join-Path $resolvedReports 'pester.nunit.xml'
$config = New-PesterConfiguration
$config.Run.Path = Join-Path $resolvedRoot 'tests/pester'
$config.Run.PassThru = $true
$config.Output.Verbosity = 'Detailed'
$config.TestResult.Enabled = $true
$config.TestResult.OutputFormat = 'NUnitXml'
$config.TestResult.OutputPath = $pesterResultPath
$result = Invoke-Pester -Configuration $config
$expectedPesterCount = 221
$pesterStatus = if (
    $result.TotalCount -eq $expectedPesterCount -and
    $result.PassedCount -eq $expectedPesterCount -and
    $result.FailedCount -eq 0 -and
    $result.SkippedCount -eq 0 -and
    $result.NotRunCount -eq 0
) { 'PASS' } else { 'FAIL' }
[ordered]@{
    scope = $ScopeName
    status = $pesterStatus
    total = [int]$result.TotalCount
    passed = [int]$result.PassedCount
    failed = [int]$result.FailedCount
    skipped = [int]$result.SkippedCount
    notRun = [int]$result.NotRunCount
    durationSeconds = [double]$result.Duration.TotalSeconds
    result = [string]$result.Result
    nunitXml = $pesterResultPath
} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $resolvedReports 'pester.json') -Encoding UTF8

$exitCode = if (
    $parserStatus -eq 'PASS' -and
    $analyzerStatus -eq 'PASS' -and
    $pesterStatus -eq 'PASS'
) { 0 } else { 1 }

[ordered]@{
    scope = $ScopeName
    command = $PSCommandPath
    arguments = [ordered]@{
        root = $resolvedRoot
        reportDirectory = $resolvedReports
        settingsPath = $SettingsPath
        excludedPath = $ExcludedPath
    }
    workingDirectory = (Get-Location).Path
    manifestPath = $manifestPath
    expectedVersions = $expectedVersions
    activeVersions = $activeVersions
    parserStatus = $parserStatus
    pesterStatus = $pesterStatus
    psscriptanalyzerStatus = $analyzerStatus
    exitCode = $exitCode
    timestampUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $resolvedReports 'execution.json') -Encoding UTF8

exit $exitCode
