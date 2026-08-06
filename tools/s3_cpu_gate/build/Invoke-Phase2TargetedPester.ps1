[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$ReportDirectory,
    [ValidateSet('main','payload')][string]$ScopeName,
    [ValidateSet('B2','B5')][string]$Tag,
    [Parameter(Mandatory)][string]$PesterManifestPath,
    [Parameter(Mandatory)][string]$ExpectedToolchainModuleRoot,
    [Parameter(Mandatory)][string]$ProvenancePath,
    [string]$RunId = '',
    [ValidateSet('TypedArrays','NativeArrays','DirectJson')]
    [string]$ProvenanceWriterMode = 'NativeArrays',
    [switch]$ProvenanceSmokeOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\','/')
}

function Test-PathWithinRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    $fullPath = Get-NormalizedPath -Path $Path
    $fullRoot = Get-NormalizedPath -Path $Root
    return (
        $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith(
            $fullRoot + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase
        )
    )
}

function Get-ModuleRecord {
    [CmdletBinding()]
    param([AllowNull()][object]$Module)

    if ($null -eq $Module) {
        return $null
    }

    return [ordered]@{
        name = [string]$Module.Name
        version = if ($null -ne $Module.Version) {
            $Module.Version.ToString()
        }
        else {
            ''
        }
        moduleBase = [string]$Module.ModuleBase
        path = [string]$Module.Path
    }
}

function Get-CommandRecord {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Command,
        [bool]$Selected = $false
    )

    if ($null -eq $Command) {
        return $null
    }

    $version = ''
    $moduleBase = ''
    if ($null -ne $Command.Module) {
        $moduleBase = [string]$Command.Module.ModuleBase
        if ($null -ne $Command.Module.Version) {
            $version = $Command.Module.Version.ToString()
        }
    }

    return [ordered]@{
        name = [string]$Command.Name
        commandType = [string]$Command.CommandType
        moduleName = [string]$Command.ModuleName
        source = [string]$Command.Source
        version = $version
        moduleBase = $moduleBase
        selected = $Selected
    }
}

function Test-CommandMatchesLoadedPester {
    [CmdletBinding()]
    param(
        [AllowNull()][object]$Command,
        [AllowNull()][object]$LoadedModule,
        [Parameter(Mandatory)][string]$ToolchainRoot
    )

    if ($null -eq $Command -or $null -eq $LoadedModule) {
        return $false
    }
    if ($null -eq $Command.Module) {
        return $false
    }

    $commandVersion = $Command.Module.Version.ToString()
    $commandBase = [string]$Command.Module.ModuleBase
    $loadedBase = [string]$LoadedModule.ModuleBase

    return (
        $Command.ModuleName -eq 'Pester' -and
        $commandVersion -eq '6.0.0' -and
        (Get-NormalizedPath -Path $commandBase).Equals(
            (Get-NormalizedPath -Path $loadedBase),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        (Test-PathWithinRoot -Path $commandBase -Root $ToolchainRoot)
    )
}

function global:Assert-MockCalled {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][string]$CommandName,
        [int]$Times = 1,
        [switch]$Exactly,
        [string]$ModuleName,
        [string]$Scope,
        [scriptblock]$ParameterFilter
    )

    $shouldParameters = @{
        Invoke = $true
        CommandName = $CommandName
        Times = $Times
    }
    if ($Exactly.IsPresent) {
        $shouldParameters.Exactly = $true
    }
    if ($PSBoundParameters.ContainsKey('ModuleName')) {
        $shouldParameters.ModuleName = $ModuleName
    }
    if ($PSBoundParameters.ContainsKey('Scope')) {
        $shouldParameters.Scope = $Scope
    }
    if ($PSBoundParameters.ContainsKey('ParameterFilter')) {
        $shouldParameters.ParameterFilter = $ParameterFilter
    }

    $shouldCommand = Get-Command -Name 'Should' -Module Pester -ErrorAction Stop
    & $shouldCommand @shouldParameters
}

function Write-EmergencyPesterProvenance {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$Errors,
        [AllowNull()][object]$ExceptionRecord,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ModulePathEntries
    )

    $exception = $null
    if ($null -ne $ExceptionRecord) {
        $exception = [ordered]@{
            type = if ($null -ne $ExceptionRecord.Exception) {
                $ExceptionRecord.Exception.GetType().FullName
            }
            else {
                ''
            }
            message = if ($null -ne $ExceptionRecord.Exception) {
                [string]$ExceptionRecord.Exception.Message
            }
            else {
                [string]$ExceptionRecord
            }
            stack = if ($null -ne $ExceptionRecord.ScriptStackTrace) {
                [string]$ExceptionRecord.ScriptStackTrace
            }
            else {
                ''
            }
        }
    }

    $record = [ordered]@{
        schemaVersion = 2
        runId = $RunId
        status = $Status
        scope = $ScopeName
        tag = $Tag
        writerMode = 'EmergencyDirectJson'
        expectedVersion = '6.0.0'
        pesterManifestPath = $PesterManifestPath
        expectedToolchainModuleRoot = $ExpectedToolchainModuleRoot
        pwshPath = [Environment]::ProcessPath
        pwshVersion = $PSVersionTable.PSVersion.ToString()
        psModulePathEntries = [string[]]@($ModulePathEntries)
        loadedModules = [object[]]@()
        commands = [object[]]@()
        errors = [string[]]@($Errors)
        exception = $exception
        timestampUtc = [DateTime]::UtcNow.ToString('o')
    }

    $parent = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $record | ConvertTo-Json -Depth 30 |
        Set-Content -LiteralPath $Path -Encoding UTF8
}

function Write-PesterProvenanceDocument {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Status,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$Errors,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$LoadedModules,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Commands,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ModulePathEntries,
        [AllowNull()][object]$ExceptionRecord,
        [Parameter(Mandatory)][string]$WriterMode,
        [Parameter(Mandatory)][string]$Path
    )

    try {
        [object[]]$moduleRows = @(
            foreach ($module in @($LoadedModules)) {
                Get-ModuleRecord -Module $module
            }
        )

        $exception = $null
        if ($null -ne $ExceptionRecord) {
            $exception = [ordered]@{
                type = if ($null -ne $ExceptionRecord.Exception) {
                    $ExceptionRecord.Exception.GetType().FullName
                }
                else {
                    ''
                }
                message = if ($null -ne $ExceptionRecord.Exception) {
                    [string]$ExceptionRecord.Exception.Message
                }
                else {
                    [string]$ExceptionRecord
                }
                stack = if ($null -ne $ExceptionRecord.ScriptStackTrace) {
                    [string]$ExceptionRecord.ScriptStackTrace
                }
                else {
                    ''
                }
            }
        }

        $record = [ordered]@{
            schemaVersion = 2
            runId = $RunId
            status = $Status
            scope = $ScopeName
            tag = $Tag
            writerMode = $WriterMode
            expectedVersion = '6.0.0'
            pesterManifestPath = $PesterManifestPath
            expectedToolchainModuleRoot = $ExpectedToolchainModuleRoot
            pwshPath = [Environment]::ProcessPath
            pwshVersion = $PSVersionTable.PSVersion.ToString()
            psModulePathEntries = [string[]]@($ModulePathEntries)
            loadedModules = [object[]]@($moduleRows)
            commands = [object[]]@($Commands)
            errors = [string[]]@($Errors)
            exception = $exception
            timestampUtc = [DateTime]::UtcNow.ToString('o')
        }

        $parent = Split-Path -Parent $Path
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
            New-Item -ItemType Directory -Path $parent -Force | Out-Null
        }
        $record | ConvertTo-Json -Depth 30 |
            Set-Content -LiteralPath $Path -Encoding UTF8
    }
    catch {
        [string[]]$emergencyErrors = @($Errors)
        $emergencyErrors += "PROVENANCE_WRITER_FAILURE: $($_.Exception.Message)"
        Write-EmergencyPesterProvenance `
            -Path $Path `
            -Status 'FAIL' `
            -Errors $emergencyErrors `
            -ExceptionRecord $_ `
            -ModulePathEntries ([string[]]@($ModulePathEntries))
        throw
    }
}

function Test-ProvenanceWriterSmoke {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$WriterMode,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [string[]]$ModulePathEntries,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$LoadedModules
    )

    $smokeRoot = Join-Path $ReportDirectory 'harness-smoke'
    New-Item -ItemType Directory -Path $smokeRoot -Force | Out-Null

    $cases = @(
        [ordered]@{
            name = 'EMPTY'
            status = 'PASS'
            errors = [string[]]@()
            commands = [object[]]@()
        },
        [ordered]@{
            name = 'SINGLE'
            status = 'PASS'
            errors = [string[]]@('SMOKE_SINGLE_ERROR')
            commands = [object[]]@(
                [ordered]@{ name = 'SMOKE_SINGLE_COMMAND'; version = '6.0.0' }
            )
        },
        [ordered]@{
            name = 'MULTIPLE'
            status = 'PASS'
            errors = [string[]]@('SMOKE_ERROR_1','SMOKE_ERROR_2')
            commands = [object[]]@(
                [ordered]@{ name = 'SMOKE_COMMAND_1'; version = '6.0.0' },
                [ordered]@{ name = 'SMOKE_COMMAND_2'; version = '6.0.0' }
            )
        },
        [ordered]@{
            name = 'FAILURE'
            status = 'FAIL'
            errors = [string[]]@('SMOKE_SYNTHETIC_FAILURE')
            commands = [object[]]@()
        }
    )

    [string[]]$smokeErrors = @()
    [object[]]$caseRows = @()

    foreach ($case in $cases) {
        $casePath = Join-Path $smokeRoot ("PROVENANCE-$($case.name).json")
        Write-PesterProvenanceDocument `
            -Status $case.status `
            -Errors ([string[]]@($case.errors)) `
            -LoadedModules ([object[]]@($LoadedModules)) `
            -Commands ([object[]]@($case.commands)) `
            -ModulePathEntries ([string[]]@($ModulePathEntries)) `
            -ExceptionRecord $null `
            -WriterMode $WriterMode `
            -Path $casePath

        $record = Get-Content -LiteralPath $casePath -Raw | ConvertFrom-Json
        $casePassed = (
            $record.status -eq $case.status -and
            @($record.errors).Count -eq @($case.errors).Count -and
            @($record.commands).Count -eq @($case.commands).Count
        )
        if (-not $casePassed) {
            $smokeErrors += "PROVENANCE_CASE_FAILED: $($case.name)"
        }
        $caseRows += [ordered]@{
            name = $case.name
            status = if ($casePassed) {'PASS'} else {'FAIL'}
            report = $casePath
        }
    }

    $smokeStatus = if ($smokeErrors.Count -eq 0) {'PASS'} else {'FAIL'}
    [ordered]@{
        schemaVersion = 2
        runId = $RunId
        status = $smokeStatus
        scope = $ScopeName
        writerMode = $WriterMode
        cases = [object[]]@($caseRows)
        errors = [string[]]@($smokeErrors)
        timestampUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 20 |
        Set-Content `
            -LiteralPath (Join-Path $ReportDirectory 'HARNESS-SMOKE-RESULT.json') `
            -Encoding UTF8

    if ($smokeStatus -ne 'PASS') {
        throw 'HARNESS_SMOKE_TEST_FAILED'
    }
}

$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
if ([string]::IsNullOrWhiteSpace($RunId)) {
    if (-not [string]::IsNullOrWhiteSpace($env:S3_PHASE2_RUN_ID)) {
        $RunId = $env:S3_PHASE2_RUN_ID
    }
    else {
        $RunId = Split-Path -Leaf (Resolve-Path -LiteralPath $ReportDirectory).Path
    }
}
$provenanceParent = Split-Path -Parent $ProvenancePath
if (-not [string]::IsNullOrWhiteSpace($provenanceParent)) {
    New-Item -ItemType Directory -Path $provenanceParent -Force | Out-Null
}

[string[]]$provenanceErrors = @()
[object[]]$commandRows = @()
[object[]]$loadedModules = @()
[string[]]$modulePathEntries = @()
$loadedModule = $null
$caughtException = $null

try {
    if ($PSVersionTable.PSVersion.ToString() -ne '7.6.3') {
        throw "PWSH_VERSION_INVALID: $($PSVersionTable.PSVersion)"
    }

    $manifest = Get-Content `
        -LiteralPath (Join-Path $resolvedRoot 'src/version-manifest.json') `
        -Raw | ConvertFrom-Json
    if ([string]$manifest.tools.pester.version -ne '6.0.0') {
        throw 'PESTER_MANIFEST_VERSION_INVALID'
    }

    $resolvedManifest = (Resolve-Path -LiteralPath $PesterManifestPath).Path
    $resolvedToolchainRoot = (
        Resolve-Path -LiteralPath $ExpectedToolchainModuleRoot
    ).Path

    [string[]]$allowedModulePaths = @(
        Get-NormalizedPath -Path $resolvedToolchainRoot
    )
    $psHomeModules = Join-Path $PSHOME 'Modules'
    if (Test-Path -LiteralPath $psHomeModules -PathType Container) {
        $allowedModulePaths += Get-NormalizedPath -Path $psHomeModules
    }
    $allowedModulePaths = [string[]]@(
        $allowedModulePaths | Select-Object -Unique
    )

    # PowerShell 7 can prepend user and machine module paths during startup even
    # when ProcessStartInfo supplied an isolated PSModulePath. Re-apply the exact
    # allowlist inside the child before importing or resolving any module command.
    $env:PSModulePath = [string]::Join(
        [IO.Path]::PathSeparator,
        $allowedModulePaths
    )

    [string[]]$modulePathEntries = @(
        $env:PSModulePath.Split(
            [IO.Path]::PathSeparator,
            [StringSplitOptions]::RemoveEmptyEntries
        ) |
        ForEach-Object { Get-NormalizedPath -Path $_ }
    )

    foreach ($entry in $modulePathEntries) {
        if (
            $entry -match '(?i)WindowsPowerShell[\\/]Modules' -or
            $entry -notin $allowedModulePaths
        ) {
            $provenanceErrors += "FORBIDDEN_PSMODULEPATH_ENTRY: $entry"
        }
    }
    foreach ($allowed in $allowedModulePaths) {
        if ($allowed -notin $modulePathEntries) {
            $provenanceErrors += "REQUIRED_PSMODULEPATH_ENTRY_MISSING: $allowed"
        }
    }
    if ($modulePathEntries.Count -ne $allowedModulePaths.Count) {
        $provenanceErrors += (
            "PSMODULEPATH_ENTRY_COUNT_INVALID: $($modulePathEntries.Count)"
        )
    }

    if (-not (Test-PathWithinRoot `
        -Path $resolvedManifest `
        -Root $resolvedToolchainRoot)) {
        $provenanceErrors += "PESTER_MANIFEST_OUTSIDE_TOOLCHAIN: $resolvedManifest"
    }

    Get-Module Pester -All |
        Remove-Module -Force -ErrorAction SilentlyContinue
    Import-Module -Name $resolvedManifest -Force -ErrorAction Stop

    $loadedModules = @(Get-Module Pester -All)
    if ($loadedModules.Count -ne 1) {
        $provenanceErrors += (
            "PESTER_LOADED_MODULE_COUNT_INVALID: $($loadedModules.Count)"
        )
    }
    else {
        $loadedModule = $loadedModules[0]
        if ($loadedModule.Version.ToString() -ne '6.0.0') {
            $provenanceErrors += "PESTER_VERSION_INVALID: $($loadedModule.Version)"
        }
        if (-not (Test-PathWithinRoot `
            -Path $loadedModule.ModuleBase `
            -Root $resolvedToolchainRoot)) {
            $provenanceErrors += (
                "PESTER_MODULEBASE_OUTSIDE_TOOLCHAIN: $($loadedModule.ModuleBase)"
            )
        }
    }

    # Assert-MockCalled is a legacy Pester command and is not exported by
    # Pester 6.0.0. Pester 6 mock verification is provided through Should -Invoke.
    foreach ($commandName in @(
        'Describe','It','BeforeAll','Mock','Should'
    )) {
        $allCommands = @(
            Get-Command -Name $commandName -All -ErrorAction SilentlyContinue
        )
        $defaultCommand = Get-Command `
            -Name $commandName `
            -ErrorAction SilentlyContinue
        $matchingCommands = @(
            $allCommands | Where-Object {
                Test-CommandMatchesLoadedPester `
                    -Command $_ `
                    -LoadedModule $loadedModule `
                    -ToolchainRoot $resolvedToolchainRoot
            }
        )

        $selectedCommand = $null
        if ($matchingCommands.Count -eq 1) {
            $selectedCommand = $matchingCommands[0]
        }
        else {
            $provenanceErrors += (
                "PESTER_SELECTED_COMMAND_COUNT_INVALID: " +
                "$commandName=$($matchingCommands.Count)"
            )
        }

        if (-not (Test-CommandMatchesLoadedPester `
            -Command $defaultCommand `
            -LoadedModule $loadedModule `
            -ToolchainRoot $resolvedToolchainRoot)) {
            $provenanceErrors += "PESTER_DEFAULT_COMMAND_SOURCE_INVALID: $commandName"
        }

        [object[]]$candidateRows = @(
            foreach ($candidate in $allCommands) {
                $isSelected = $false
                if ($null -ne $selectedCommand) {
                    $isSelected = (
                        [string]$candidate.ModuleName -eq
                            [string]$selectedCommand.ModuleName -and
                        [string]$candidate.Source -eq
                            [string]$selectedCommand.Source -and
                        [string]$candidate.CommandType -eq
                            [string]$selectedCommand.CommandType
                    )
                }
                Get-CommandRecord -Command $candidate -Selected $isSelected
            }
        )

        $commandRows += [ordered]@{
            name = $commandName
            defaultResolution = Get-CommandRecord -Command $defaultCommand
            selected = Get-CommandRecord -Command $selectedCommand -Selected $true
            allCandidates = [object[]]@($candidateRows)
        }
    }

    $provenanceStatus = if ($provenanceErrors.Count -eq 0) {'PASS'} else {'FAIL'}
    Write-PesterProvenanceDocument `
        -Status $provenanceStatus `
        -Errors ([string[]]@($provenanceErrors)) `
        -LoadedModules ([object[]]@($loadedModules)) `
        -Commands ([object[]]@($commandRows)) `
        -ModulePathEntries ([string[]]@($modulePathEntries)) `
        -ExceptionRecord $null `
        -WriterMode $ProvenanceWriterMode `
        -Path $ProvenancePath

    if ($provenanceStatus -ne 'PASS') {
        throw 'PESTER_MODULE_ISOLATION_FAILED'
    }
}
catch {
    $caughtException = $_
    $provenanceErrors += [string]$_.Exception.Message
    try {
        Write-PesterProvenanceDocument `
            -Status 'FAIL' `
            -Errors ([string[]]@($provenanceErrors)) `
            -LoadedModules ([object[]]@($loadedModules)) `
            -Commands ([object[]]@($commandRows)) `
            -ModulePathEntries ([string[]]@($modulePathEntries)) `
            -ExceptionRecord $_ `
            -WriterMode $ProvenanceWriterMode `
            -Path $ProvenancePath
    }
    catch {
        [string[]]$emergencyErrors = @($provenanceErrors)
        $emergencyErrors += "EMERGENCY_PROVENANCE_WRITE_FAILURE: $($_.Exception.Message)"
        Write-EmergencyPesterProvenance `
            -Path $ProvenancePath `
            -Status 'FAIL' `
            -Errors $emergencyErrors `
            -ExceptionRecord $caughtException `
            -ModulePathEntries ([string[]]@($modulePathEntries))
    }
    throw 'PESTER_MODULE_ISOLATION_FAILED'
}

if ($ProvenanceSmokeOnly) {
    Test-ProvenanceWriterSmoke `
        -WriterMode $ProvenanceWriterMode `
        -ModulePathEntries ([string[]]@($modulePathEntries)) `
        -LoadedModules ([object[]]@($loadedModules))
    exit 0
}

$expected = switch ($Tag) {
    'B5' { 17 }
    default {
        throw 'TARGETED_RUNNER_SUPPORTS_B5_ONLY: use Invoke-Phase2FocusedPester.ps1 for B2'
    }
}

$newConfigurationCommand = Get-Command `
    -Name 'New-PesterConfiguration' `
    -Module Pester `
    -ErrorAction Stop
$invokePesterCommand = Get-Command `
    -Name 'Invoke-Pester' `
    -Module Pester `
    -ErrorAction Stop

$config = & $newConfigurationCommand
$config.Run.Path = Join-Path $resolvedRoot 'tests/pester'
$config.Run.PassThru = $true
$config.Filter.Tag = $Tag
$config.Output.Verbosity = 'Detailed'
$config.TestResult.Enabled = $true
$config.TestResult.OutputFormat = 'NUnitXml'
$config.TestResult.OutputPath = Join-Path $ReportDirectory "$Tag.nunit.xml"

$result = & $invokePesterCommand -Configuration $config
$executedCount = (
    [int]$result.PassedCount +
    [int]$result.FailedCount +
    [int]$result.SkippedCount
)

$failedContainerCount = 0
if ($result.PSObject.Properties.Name -contains 'FailedContainersCount') {
    $failedContainerCount = [int]$result.FailedContainersCount
}
elseif ($result.PSObject.Properties.Name -contains 'Containers') {
    $failedContainerCount = @(
        $result.Containers |
        Where-Object { @($_.ErrorRecord).Count -gt 0 }
    ).Count
}

$status = if (
    $executedCount -eq $expected -and
    [int]$result.PassedCount -eq $expected -and
    [int]$result.FailedCount -eq 0 -and
    [int]$result.SkippedCount -eq 0 -and
    $failedContainerCount -eq 0
) {'PASS'} else {'FAIL'}

[ordered]@{
    schemaVersion = 2
    runId = $RunId
    scope = $ScopeName
    tag = $Tag
    status = $status
    expectedExecutedCount = $expected
    countSource = 'Pester result object'
    executedCountFormula = 'PassedCount + FailedCount + SkippedCount'
    executedCount = [int]$executedCount
    passedCount = [int]$result.PassedCount
    failedCount = [int]$result.FailedCount
    skippedCount = [int]$result.SkippedCount
    failedContainerCount = [int]$failedContainerCount
    totalCount = [int]$result.TotalCount
    notRunCount = [int]$result.NotRunCount
    totalCountInformational = $true
    notRunCountInformational = $true
    filter = [ordered]@{ type = 'Tag'; value = $Tag }
    pesterProvenance = $ProvenancePath
    provenanceWriterMode = $ProvenanceWriterMode
    timestampUtc = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Depth 12 |
    Set-Content `
        -LiteralPath (Join-Path $ReportDirectory "$Tag.json") `
        -Encoding UTF8

if ($status -ne 'PASS') {
    exit 1
}
