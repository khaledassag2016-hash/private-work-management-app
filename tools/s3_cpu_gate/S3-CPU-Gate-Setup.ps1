[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RuntimeRoot = 'C:\Users\MC\Desktop\1'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourceRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$allowedFiles = @(
    @{ Source = 'src\Bootstrap.ps1'; Target = 'Bootstrap.ps1' },
    @{ Source = 'src\Initialize-Toolchain.ps1'; Target = 'Initialize-Toolchain.ps1' },
    @{ Source = 'src\S3-CpuGate-Orchestrator.ps1'; Target = 'S3-CpuGate-Orchestrator.ps1' },
    @{ Source = 'src\START.cmd'; Target = 'START.cmd' },
    @{ Source = 'src\version-manifest.json'; Target = 'version-manifest.json' },
    @{ Source = 'package-manifest.json'; Target = 'config\package-manifest.json' }
)
$allowedTrees = @(
    @{ Source = 'src\modules'; Target = 'modules' },
    @{ Source = 'src\python'; Target = 'python' },
    @{ Source = 'src\worker'; Target = 'worker' }
)

function Assert-S3SafePath {
    param([Parameter(Mandatory)][string]$RelativePath)
    if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "UNSAFE_STAGING_PATH: $RelativePath"
    }
}

function Assert-S3RegularFile {
    param([Parameter(Mandatory)][IO.FileInfo]$File)
    if ($File.LinkType) { throw "REPARSE_POINT_NOT_ALLOWED: $($File.FullName)" }
    $name = $File.Name.ToLowerInvariant()
    if ($name -in @('.env', '.env.local', 'credentials.json', 'token.json', 'auth.json') -or
        $name -match '(^|[._-])(credential|token|password|private-key)([._-]|$)') {
        throw "SECRET_FILE_NOT_ALLOWED: $($File.FullName)"
    }
    if ($File.Extension.ToLowerInvariant() -in @('.pyc', '.pyo', '.tmp', '.bak', '.swp')) {
        throw "TEMP_FILE_NOT_ALLOWED: $($File.FullName)"
    }
}

function Copy-S3FileToStage {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target
    )
    Assert-S3SafePath -RelativePath $Source
    Assert-S3SafePath -RelativePath $Target
    $sourceFile = Get-Item -LiteralPath (Join-Path $sourceRoot $Source) -ErrorAction Stop
    if ($sourceFile -isnot [IO.FileInfo]) { throw "STAGING_SOURCE_NOT_FILE: $Source" }
    Assert-S3RegularFile -File $sourceFile
    $targetFile = Join-Path $stageRoot $Target
    New-Item -ItemType Directory -Path (Split-Path -Parent $targetFile) -Force | Out-Null
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetFile -Force
}

function Copy-S3TreeToStage {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Target
    )
    Assert-S3SafePath -RelativePath $Source
    Assert-S3SafePath -RelativePath $Target
    $sourceDirectory = Get-Item -LiteralPath (Join-Path $sourceRoot $Source) -ErrorAction Stop
    if ($sourceDirectory -isnot [IO.DirectoryInfo]) { throw "STAGING_SOURCE_NOT_DIRECTORY: $Source" }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory.FullName -Recurse -File -Force) {
        $relative = $file.FullName.Substring($sourceDirectory.FullName.Length).TrimStart('\','/')
        $relative = $relative -replace '\\','/'
        Assert-S3SafePath -RelativePath $relative
        Assert-S3RegularFile -File $file
        $destination = Join-Path $stageRoot ($Target + '\' + $relative)
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
}

function Copy-S3ManifestPayloadToStage {
    $manifestPath = Join-Path $sourceRoot 'package-manifest.json'
    $packageManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifestFiles = @($packageManifest.files | ForEach-Object { [string]$_ })
    if ($manifestFiles.Count -eq 0) { throw 'PACKAGE_MANIFEST_EMPTY' }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($relativePath in $manifestFiles) {
        Assert-S3SafePath -RelativePath $relativePath
        if (-not $seen.Add($relativePath)) { throw "PACKAGE_MANIFEST_DUPLICATE: $relativePath" }
        $sourceFile = Get-Item -LiteralPath (Join-Path $sourceRoot ($relativePath -replace '/', '\')) -ErrorAction Stop
        if ($sourceFile -isnot [IO.FileInfo]) { throw "PACKAGE_MANIFEST_NOT_FILE: $relativePath" }
        Assert-S3RegularFile -File $sourceFile
        $target = Join-Path $stageRoot ('workspace\repository_payload\tools\s3_cpu_gate\' + ($relativePath -replace '/', '\'))
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile.FullName -Destination $target -Force
    }
}

if ($RuntimeRoot -ne 'C:\Users\MC\Desktop\1') { throw 'RUNTIME_ROOT_NOT_AUTHORIZED' }
if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
}

$statePath = Join-Path $RuntimeRoot 'state.json'
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $current = [string]$state.currentState
    if ($current -notin @('80_RESOURCES_DESTROYED','90_REPORT_READY')) {
        throw 'ACTIVE_OR_UNCLEAN_STATE_PRESENT'
    }
}

$stageRoot = Join-Path $RuntimeRoot ('.s3-runtime-staging-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    foreach ($entry in $allowedFiles) { Copy-S3FileToStage -Source $entry.Source -Target $entry.Target }
    foreach ($entry in $allowedTrees) { Copy-S3TreeToStage -Source $entry.Source -Target $entry.Target }
    Copy-S3ManifestPayloadToStage

    foreach ($required in @('Bootstrap.ps1','Initialize-Toolchain.ps1','S3-CpuGate-Orchestrator.ps1','START.cmd','version-manifest.json','modules','python','worker','workspace\repository_payload\tools\s3_cpu_gate')) {
        if (-not (Test-Path -LiteralPath (Join-Path $stageRoot $required))) { throw "STAGING_REQUIRED_MISSING: $required" }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $stageRoot 'version-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.authoritative -ne $true) { throw 'VERSION_MANIFEST_NOT_AUTHORITATIVE' }

    if ($PSCmdlet.ShouldProcess($RuntimeRoot, 'Promote verified S3 runtime')) {
        foreach ($entry in $allowedFiles) {
            $destination = Join-Path $RuntimeRoot $entry.Target
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $stageRoot $entry.Target) -Destination $destination -Force
        }
        foreach ($entry in $allowedTrees) {
            $destination = Join-Path $RuntimeRoot $entry.Target
            New-Item -ItemType Directory -Path $destination -Force | Out-Null
            foreach ($file in Get-ChildItem -LiteralPath (Join-Path $stageRoot $entry.Target) -Recurse -File -Force) {
                $relative = $file.FullName.Substring((Join-Path $stageRoot $entry.Target).Length).TrimStart('\','/')
                $target = Join-Path $destination $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
                Copy-Item -LiteralPath $file.FullName -Destination $target -Force
            }
        }
        $payloadStage = Join-Path $stageRoot 'workspace\repository_payload\tools\s3_cpu_gate'
        $payloadDestination = Join-Path $RuntimeRoot 'workspace\repository_payload\tools\s3_cpu_gate'
        if (Test-Path -LiteralPath $payloadDestination) {
            Remove-Item -LiteralPath $payloadDestination -Recurse -Force
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $payloadDestination) -Force | Out-Null
        Copy-Item -LiteralPath $payloadStage -Destination $payloadDestination -Recurse -Force
        [ordered]@{ status = 'PASS'; sourceRoot = $sourceRoot; runtimeRoot = $RuntimeRoot; stagedAtUtc = [DateTime]::UtcNow.ToString('o'); statePreserved = $true } |
            ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'config\runtime-staging.json') -Encoding UTF8
    }
}
finally {
    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
