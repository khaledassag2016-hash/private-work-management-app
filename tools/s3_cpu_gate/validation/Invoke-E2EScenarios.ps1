[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateRoot,
    [Parameter(Mandatory)][string]$PwshPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$FixedRoot = 'C:\Users\MC\Desktop\1'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SourceRoot = Join-Path $CandidateRoot 'source'
$SourceSrc = Join-Path $SourceRoot 'src'
$ScenarioRoot = Join-Path $FixedRoot 'local-validation\e2e'
$RuntimeRoot = Join-Path $ScenarioRoot 'runtime'
$GuardRoot = Join-Path $ScenarioRoot 'cloud-command-guard'
$GuardLog = Join-Path $ScenarioRoot 'cloud-command-violations.log'
$ToolsRoot = Split-Path -Parent (Split-Path -Parent $PwshPath)
$OriginalPath = $env:PATH
$OriginalHttpProxy = $env:HTTP_PROXY
$OriginalHttpsProxy = $env:HTTPS_PROXY
$OriginalAllProxy = $env:ALL_PROXY
$OriginalNoProxy = $env:NO_PROXY
$OriginalNoProxyLower = $env:no_proxy
$OriginalGuardLog = $env:S3_LOCAL_VALIDATION_GUARD_LOG
$OriginalRuntimeRoot = $env:S3_LOCAL_VALIDATION_RUNTIME_ROOT
$OriginalLocalValidation = $env:S3_LOCAL_VALIDATION

function Initialize-LvRuntime {
    if (Test-Path -LiteralPath $RuntimeRoot) { Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force }
    foreach ($directory in @('modules','python','workspace','reports','artifacts','logs','temp','repository','config','tests','backups','docs')) {
        New-Item -ItemType Directory -Path (Join-Path $RuntimeRoot $directory) -Force | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $SourceSrc 'S3-CpuGate-Orchestrator.ps1') -Destination (Join-Path $RuntimeRoot 'S3-CpuGate-Orchestrator.ps1') -Force
    Get-ChildItem -LiteralPath (Join-Path $SourceSrc 'modules') -Filter '*.psm1' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RuntimeRoot 'modules') -Force
    }
    Get-ChildItem -LiteralPath (Join-Path $SourceSrc 'python') -Filter '*.py' | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $RuntimeRoot 'python') -Force
    }
    Copy-Item -LiteralPath (Join-Path $SourceSrc 'repository_payload') -Destination (Join-Path $RuntimeRoot 'workspace\repository_payload') -Recurse -Force

    # Test-harness adapter only: preserve the production source in the package, but redirect its fixed root
    # to an isolated directory for this local validation run. All production state-machine logic remains unchanged.
    $commonPath = Join-Path $RuntimeRoot 'modules\Common.psm1'
    $commonText = Get-Content -LiteralPath $commonPath -Raw -Encoding UTF8
    $original = "function Get-S3FixedRoot { 'C:\Users\MC\Desktop\1' }"
    $replacement = "function Get-S3FixedRoot { if (-not [string]::IsNullOrWhiteSpace(`$env:S3_LOCAL_VALIDATION_RUNTIME_ROOT)) { return `$env:S3_LOCAL_VALIDATION_RUNTIME_ROOT }; 'C:\Users\MC\Desktop\1' }"
    if (-not $commonText.Contains($original)) { throw 'تعذر تطبيق محول جذر الاختبار على نسخة التشغيل المؤقتة.' }
    $commonText.Replace($original,$replacement) | Set-Content -LiteralPath $commonPath -Encoding UTF8
}

function New-LvCloudCommandGuard {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
    param()

    if (-not $PSCmdlet.ShouldProcess($GuardRoot, 'Create cloud command guard')) {
        return
    }

    New-Item -ItemType Directory -Path $GuardRoot -Force | Out-Null
    Set-Content -LiteralPath $GuardLog -Value '' -Encoding UTF8
    foreach ($name in @('git','gh','firebase','wrangler','gcloud','curl','cloudflared')) {
        $content = "@echo off`r`necho $name ^| %*>>`"%S3_LOCAL_VALIDATION_GUARD_LOG%`"`r`nexit /b 97`r`n"
        Set-Content -LiteralPath (Join-Path $GuardRoot ($name + '.cmd')) -Value $content -Encoding ASCII
    }
    $env:S3_LOCAL_VALIDATION_GUARD_LOG = $GuardLog
    $env:S3_LOCAL_VALIDATION_RUNTIME_ROOT = $RuntimeRoot
    $env:S3_LOCAL_VALIDATION = '1'
    $env:PATH = "$GuardRoot;$(Join-Path $ToolsRoot 'python');$(Join-Path $ToolsRoot 'node');$OriginalPath"
    $env:HTTP_PROXY = 'http://127.0.0.1:9'
    $env:HTTPS_PROXY = 'http://127.0.0.1:9'
    $env:ALL_PROXY = 'http://127.0.0.1:9'
    $env:NO_PROXY = ''
    $env:no_proxy = ''
}

function Invoke-LvOrchestrator {
    param([switch]$Resume,[Parameter(Mandatory)][string]$Label)
    $stdout = Join-Path $ScenarioRoot ($Label + '-stdout.txt')
    $stderr = Join-Path $ScenarioRoot ($Label + '-stderr.txt')
    $arguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $RuntimeRoot 'S3-CpuGate-Orchestrator.ps1'),'-Mode','Simulation','-NoOpenFolder')
    if ($Resume) { $arguments += '-Resume' }
    $process = Start-Process -FilePath $PwshPath -ArgumentList $arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $statePath = Join-Path $RuntimeRoot 'state.json'
    $state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
    return [ordered]@{
        exitCode = $process.ExitCode
        currentState = if ($null -ne $state) { [string]$state.currentState } else { $null }
        runId = if ($null -ne $state) { [string]$state.runId } else { $null }
        stdout = $stdout
        stderr = $stderr
    }
}

function Invoke-LvInjectedScenario {
    $moduleRoot = Join-Path $SourceSrc 'modules'
    foreach ($module in @('Common','Ui','Prerequisites','Repository','Firebase','Cloudflare','CpuGate','Cleanup','Reporting')) {
        Import-Module (Join-Path $moduleRoot ($module + '.psm1')) -Force
    }
    function New-Context {
        [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
        param([string]$Name)
        $root = Join-Path $ScenarioRoot $Name
        if(-not $PSCmdlet.ShouldProcess($root,'Create E2E test context')){return}
        foreach ($directory in @('reports','artifacts','logs','temp','workspace','repository','python')) {
            New-Item -ItemType Directory -Path (Join-Path $root $directory) -Force | Out-Null
        }
        $run = 's3cpu-local-' + $Name + '-' + [guid]::NewGuid().ToString('N').Substring(0,8)
        return [pscustomobject]@{
            Root = $root; Mode = 'Simulation'; RunId = $run; RuntimeSecrets = [ordered]@{}; IsResumed = $false
            State = [ordered]@{schemaVersion=2;runId=$run;mode='Simulation';currentState='00_PACKAGE_READY';completed=@('00_PACKAGE_READY');resources=[ordered]@{};results=[ordered]@{};failure=$null}
        }
    }
    $rows = @(); for ($i=0; $i -lt 20; $i++) { $rows += [ordered]@{cpu_ms=11.0;wall_ms=12.0;outcome='ok';cache_state='hit'} }
    $failContext = New-Context 'forced-fail'
    Invoke-S3FirebaseProvision -Context $failContext | Out-Null
    Invoke-S3CloudflareProvision -Context $failContext | Out-Null
    $payload = [ordered]@{
        groups=[ordered]@{cache_hit_round_1=$rows;cache_hit_round_2=$rows;cache_miss=$rows}
        plan_free=$true;billing_absent=$true;security_reduced=$false;telemetry_official=$true;stable=$true
        independent_reproducible_cpu_terminations=0
        negativeTests=[ordered]@{uid_not_allowed='PASS';unknown_kid='PASS';modified_signature='PASS';expired='PASS';audience='PASS';issuer='PASS';certificate_fetch='PASS';invalid_cache_metadata='PASS'}
    }
    $failDecision = Test-S3CpuDecision -Payload $payload
    $failCleanup = Invoke-S3Cleanup -Context $failContext

    $exceptionContext = New-Context 'forced-exception'
    $exceptionCaught = $false
    $exceptionCleanup = $null
    try {
        Invoke-S3FirebaseProvision -Context $exceptionContext | Out-Null
        Invoke-S3CloudflareProvision -Context $exceptionContext | Out-Null
        throw 'LOCAL_VALIDATION_INJECTED_EXCEPTION'
    } catch {
        $exceptionCaught = ($_.Exception.Message -eq 'LOCAL_VALIDATION_INJECTED_EXCEPTION')
    } finally {
        $exceptionCleanup = Invoke-S3Cleanup -Context $exceptionContext
    }
    return [ordered]@{
        forcedFail = [ordered]@{decision=$failDecision.status;cleanup=$failCleanup.status;pass=($failDecision.status -eq 'FAIL' -and $failCleanup.status -eq 'PASS')}
        forcedException = [ordered]@{caught=$exceptionCaught;cleanup=$exceptionCleanup.status;runtimeSecretsCleared=($exceptionContext.RuntimeSecrets.Count -eq 0);pass=($exceptionCaught -and $exceptionCleanup.status -eq 'PASS' -and $exceptionContext.RuntimeSecrets.Count -eq 0)}
    }
}

$result = [ordered]@{status='FAIL';runtimeRootAdapter='TEST_ONLY';actualPass=$null;resume=$null;injected=$null;cloudCommandViolations=@();errors=@()}
try {
    New-Item -ItemType Directory -Path $ScenarioRoot -Force | Out-Null
    New-LvCloudCommandGuard

    Initialize-LvRuntime
    $result.actualPass = Invoke-LvOrchestrator -Label 'full-pass'
    $result.actualPass.pass = ($result.actualPass.exitCode -eq 0 -and $result.actualPass.currentState -eq '90_REPORT_READY')

    Initialize-LvRuntime
    $resumeRun = 's3cpu-local-resume-' + [guid]::NewGuid().ToString('N').Substring(0,8)
    $resumeState = [ordered]@{
        schemaVersion=2;runId=$resumeRun;mode='Simulation';currentState='40_PRE_CLOUD_GATE'
        completed=@('00_PACKAGE_READY','10_LOCAL_PREREQUISITES','20_REPOSITORY_GATE','30_BRANCH_AND_DRAFT_PR','40_PRE_CLOUD_GATE')
        startedUtc=[DateTime]::UtcNow.ToString('o');updatedUtc=[DateTime]::UtcNow.ToString('o')
        resources=[ordered]@{};results=[ordered]@{repository=[ordered]@{commit='f4951b9bc28bcf6547294174377d10b1fc7a6439'};branchPr=[ordered]@{branch='stage-3/identity-database-audit';draftPr='SIMULATED'}};failure=$null
    }
    $resumeState | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'state.json') -Encoding UTF8
    $result.resume = Invoke-LvOrchestrator -Resume -Label 'resume-from-40'
    $result.resume.pass = ($result.resume.exitCode -eq 0 -and $result.resume.currentState -eq '90_REPORT_READY')

    $result.injected = Invoke-LvInjectedScenario
    $violations = @()
    if (Test-Path -LiteralPath $GuardLog) { $violations = @(Get-Content -LiteralPath $GuardLog | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) }
    $result.cloudCommandViolations = $violations
    $result.status = if ($result.actualPass.pass -and $result.resume.pass -and $result.injected.forcedFail.pass -and $result.injected.forcedException.pass -and $violations.Count -eq 0) { 'PASS' } else { 'FAIL' }
} catch {
    $result.errors += $_.Exception.Message
    $result.status = 'FAIL'
} finally {
    $env:PATH = $OriginalPath
    $env:HTTP_PROXY = $OriginalHttpProxy
    $env:HTTPS_PROXY = $OriginalHttpsProxy
    $env:ALL_PROXY = $OriginalAllProxy
    $env:NO_PROXY = $OriginalNoProxy
    $env:no_proxy = $OriginalNoProxyLower
    $env:S3_LOCAL_VALIDATION_GUARD_LOG = $OriginalGuardLog
    $env:S3_LOCAL_VALIDATION_RUNTIME_ROOT = $OriginalRuntimeRoot
    $env:S3_LOCAL_VALIDATION = $OriginalLocalValidation
    if ($result.status -eq 'PASS' -and (Test-Path -LiteralPath $RuntimeRoot)) { Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $GuardRoot) { Remove-Item -LiteralPath $GuardRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
$result | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
if ($result.status -ne 'PASS') { exit 1 }
exit 0
