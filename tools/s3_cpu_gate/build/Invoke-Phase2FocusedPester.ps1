[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$ReportDirectory,
    [ValidateSet('main','payload')][string]$ScopeName,
    [Parameter(Mandatory)][string]$FullName,
    [string]$PesterManifestPath = '',
    [string]$ExpectedToolchainModuleRoot = '',
    [string]$RunId = '',
    [string]$ProvenancePath = ''
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
    return (
        $Command.ModuleName -eq 'Pester' -and
        $Command.Module.Version.ToString() -eq '6.0.0' -and
        (Get-NormalizedPath -Path $Command.Module.ModuleBase).Equals(
            (Get-NormalizedPath -Path $LoadedModule.ModuleBase),
            [StringComparison]::OrdinalIgnoreCase
        ) -and
        (Test-PathWithinRoot `
            -Path $Command.Module.ModuleBase `
            -Root $ToolchainRoot)
    )
}

function Write-FocusedProvenance {
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
        [Parameter(Mandatory)][string]$Path
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

    [object[]]$moduleRows = @(
        foreach ($module in @($LoadedModules)) {
            Get-ModuleRecord -Module $module
        }
    )

    $record = [ordered]@{
        schemaVersion = 2
        runId = $RunId
        status = $Status
        scope = $ScopeName
        phase = 'B2-focused'
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

    try {
        $record | ConvertTo-Json -Depth 30 |
            Set-Content -LiteralPath $Path -Encoding UTF8
    }
    catch {
        $emergency = [ordered]@{
            schemaVersion = 2
            runId = $RunId
            status = 'FAIL'
            scope = $ScopeName
            phase = 'B2-focused'
            writerMode = 'EmergencyDirectJson'
            expectedVersion = '6.0.0'
            pesterManifestPath = $PesterManifestPath
            expectedToolchainModuleRoot = $ExpectedToolchainModuleRoot
            pwshPath = [Environment]::ProcessPath
            pwshVersion = $PSVersionTable.PSVersion.ToString()
            psModulePathEntries = [string[]]@($ModulePathEntries)
            loadedModules = [object[]]@()
            commands = [object[]]@()
            errors = [string[]]@(
                @($Errors) +
                "PROVENANCE_WRITER_FAILURE: $($_.Exception.Message)"
            )
            exception = [ordered]@{
                type = $_.Exception.GetType().FullName
                message = $_.Exception.Message
                stack = $_.ScriptStackTrace
            }
            timestampUtc = [DateTime]::UtcNow.ToString('o')
        }
        $emergency | ConvertTo-Json -Depth 20 |
            Set-Content -LiteralPath $Path -Encoding UTF8
        throw
    }
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
        Invoke = $CommandName
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

if ([string]::IsNullOrWhiteSpace($ProvenancePath)) {
    $ProvenancePath = Join-Path `
        $ReportDirectory `
        "PESTER-MODULE-PROVENANCE-$ScopeName.json"
}

[string[]]$provenanceErrors = @()
[object[]]$commandRows = @()
[object[]]$loadedModules = @()
[string[]]$modulePathEntries = @()
$loadedModule = $null

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

    if ([string]::IsNullOrWhiteSpace($PesterManifestPath)) {
        $candidateManifests = @(
            $env:PSModulePath.Split(
                [IO.Path]::PathSeparator,
                [StringSplitOptions]::RemoveEmptyEntries
            ) |
            ForEach-Object {
                Join-Path $_ 'Pester\6.0.0\Pester.psd1'
            } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
        )
        if ($candidateManifests.Count -ne 1) {
            throw "PESTER_MANIFEST_CANDIDATE_COUNT_INVALID: $($candidateManifests.Count)"
        }
        $PesterManifestPath = $candidateManifests[0]
    }

    $resolvedPesterManifest = (Resolve-Path -LiteralPath $PesterManifestPath).Path
    $PesterManifestPath = $resolvedPesterManifest

    if ([string]::IsNullOrWhiteSpace($ExpectedToolchainModuleRoot)) {
        $ExpectedToolchainModuleRoot = Split-Path -Parent (
            Split-Path -Parent (
                Split-Path -Parent $resolvedPesterManifest
            )
        )
    }
    $resolvedToolchainRoot = (
        Resolve-Path -LiteralPath $ExpectedToolchainModuleRoot
    ).Path
    $ExpectedToolchainModuleRoot = $resolvedToolchainRoot

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
        $provenanceErrors += 'PSMODULEPATH_ENTRY_COUNT_INVALID'
    }
    if (-not (Test-PathWithinRoot `
        -Path $resolvedPesterManifest `
        -Root $resolvedToolchainRoot)) {
        $provenanceErrors += 'PESTER_MANIFEST_OUTSIDE_TOOLCHAIN'
    }

    Get-Module Pester -All |
        Remove-Module -Force -ErrorAction SilentlyContinue
    Import-Module -Name $resolvedPesterManifest -Force -ErrorAction Stop

    $loadedModules = @(Get-Module Pester -All)
    if ($loadedModules.Count -ne 1) {
        $provenanceErrors += "PESTER_LOADED_MODULE_COUNT_INVALID: $($loadedModules.Count)"
    }
    else {
        $loadedModule = $loadedModules[0]
        if (
            $loadedModule.Version.ToString() -ne '6.0.0' -or
            -not (Test-PathWithinRoot `
                -Path $loadedModule.ModuleBase `
                -Root $resolvedToolchainRoot)
        ) {
            $provenanceErrors += 'PESTER_LOADED_MODULE_SOURCE_INVALID'
        }
    }

    foreach ($commandName in @(
        'Describe','It','BeforeAll','Mock','Should'
    )) {
        $defaultCommand = Get-Command `
            -Name $commandName `
            -ErrorAction SilentlyContinue
        $allCommands = @(
            Get-Command -Name $commandName -All -ErrorAction SilentlyContinue
        )
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
    Write-FocusedProvenance `
        -Status $provenanceStatus `
        -Errors ([string[]]@($provenanceErrors)) `
        -LoadedModules ([object[]]@($loadedModules)) `
        -Commands ([object[]]@($commandRows)) `
        -ModulePathEntries ([string[]]@($modulePathEntries)) `
        -ExceptionRecord $null `
        -Path $ProvenancePath

    if ($provenanceStatus -ne 'PASS') {
        throw 'PESTER_MODULE_ISOLATION_FAILED'
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
    $config.Filter.FullName = $FullName
    $config.Output.Verbosity = 'Detailed'
    $config.TestResult.Enabled = $true
    $config.TestResult.OutputFormat = 'NUnitXml'
    $config.TestResult.OutputPath = Join-Path $ReportDirectory 'B2-REPAIR.nunit.xml'
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
        $executedCount -eq 1 -and
        [int]$result.PassedCount -eq 1 -and
        [int]$result.FailedCount -eq 0 -and
        [int]$result.SkippedCount -eq 0 -and
        $failedContainerCount -eq 0
    ) {'PASS'} else {'FAIL'}

    [ordered]@{
        schemaVersion = 2
        runId = $RunId
        scope = $ScopeName
        fullNameFilter = $FullName
        status = $status
        expectedExecutedCount = 1
        countSource = 'Pester result object'
        executedCountFormula = 'PassedCount + FailedCount + SkippedCount'
        totalCount = [int]$result.TotalCount
        notRunCount = [int]$result.NotRunCount
        totalCountInformational = $true
        notRunCountInformational = $true
        executedCount = [int]$executedCount
        passedCount = [int]$result.PassedCount
        failedCount = [int]$result.FailedCount
        skippedCount = [int]$result.SkippedCount
        failedContainerCount = [int]$failedContainerCount
        pesterManifestPath = $resolvedPesterManifest
        pesterVersion = $loadedModule.Version.ToString()
        pesterProvenance = $ProvenancePath
        timestampUtc = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 12 |
        Set-Content `
            -LiteralPath (Join-Path $ReportDirectory 'B2-REPAIR.json') `
            -Encoding UTF8

    if ($status -ne 'PASS') {
        exit 1
    }
}
catch {
    $provenanceErrors += [string]$_.Exception.Message
    try {
        Write-FocusedProvenance `
            -Status 'FAIL' `
            -Errors ([string[]]@($provenanceErrors)) `
            -LoadedModules ([object[]]@($loadedModules)) `
            -Commands ([object[]]@($commandRows)) `
            -ModulePathEntries ([string[]]@($modulePathEntries)) `
            -ExceptionRecord $_ `
            -Path $ProvenancePath
    }
    catch {
        Write-Verbose -Message $_.Exception.Message
        # The emergency writer inside Write-FocusedProvenance already made the
        # best possible failure document. Preserve the original failure below.
    }

    if (-not (Test-Path -LiteralPath (Join-Path $ReportDirectory 'B2-REPAIR.json'))) {
        [ordered]@{
            schemaVersion = 2
            runId = $RunId
            scope = $ScopeName
            fullNameFilter = $FullName
            status = 'FAIL'
            expectedExecutedCount = 1
            countSource = 'Unavailable because the focused runner failed before a Pester result object was produced'
            executedCountFormula = 'PassedCount + FailedCount + SkippedCount'
            totalCount = $null
            notRunCount = $null
            totalCountInformational = $true
            notRunCountInformational = $true
            executedCount = 0
            passedCount = 0
            failedCount = 0
            skippedCount = 0
            failedContainerCount = 0
            pesterManifestPath = $PesterManifestPath
            pesterVersion = if ($null -ne $loadedModule) {
                $loadedModule.Version.ToString()
            }
            else {
                ''
            }
            pesterProvenance = $ProvenancePath
            error = [string]$_.Exception.Message
            exceptionType = $_.Exception.GetType().FullName
            stack = [string]$_.ScriptStackTrace
            timestampUtc = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json -Depth 12 |
            Set-Content `
                -LiteralPath (Join-Path $ReportDirectory 'B2-REPAIR.json') `
                -Encoding UTF8
    }
    throw
}
