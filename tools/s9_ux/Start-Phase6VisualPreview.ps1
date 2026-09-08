param(
  [ValidateSet('Waleed','Khalid')]
  [string]$Profile = 'Khalid',

  [ValidateSet('Demo','Clean')]
  [string]$DataMode = 'Demo',

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedHead,

  [ValidateRange(1024,65535)]
  [int]$Port = 4186,

  [switch]$NoBrowser,

  [switch]$HealthCheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) { throw "GIT_REPOSITORY_NOT_FOUND: $repoRoot" }

$origin = (& git -C $repoRoot remote get-url origin).Trim()
if (-not $origin) { throw 'GIT_ORIGIN_NOT_FOUND' }
$expectedRepository = 'khaledassag2016-hash/private-work-management-app'
if ($origin -notmatch ('github\.com[:/]' + [regex]::Escape($expectedRepository) + '(?:\.git)?$')) { throw "REMOTE_MISMATCH: $origin" }

$actualHead = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($actualHead -ne $ExpectedHead) { throw "HEAD_MISMATCH: expected $ExpectedHead but found $actualHead" }

$node = Get-Command node -ErrorAction Stop
$server = Join-Path $repoRoot 'tools/s9_ux/server.mjs'
$app = Join-Path $repoRoot 'tools/s3_cpu_gate/src/worker/assets/app.js'
$styles = Join-Path $repoRoot 'tools/s3_cpu_gate/src/worker/assets/styles.css'
foreach ($required in @($server,$app,$styles)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "PHASE6_PREVIEW_FILE_NOT_FOUND: $required" }
}

$env:PHASE6_VISUAL_PREVIEW_ROLE = $Profile.ToLowerInvariant()
$env:PHASE6_VISUAL_PREVIEW_DATA_MODE = $DataMode.ToLowerInvariant()
$env:PHASE6_VISUAL_PREVIEW_PORT = [string]$Port
$url = "http://127.0.0.1:$Port/"
$healthUrl = "${url}__preview-health"
$process = $null
try {
  $process = Start-Process -FilePath $node.Source -ArgumentList @($server) -WorkingDirectory $repoRoot -PassThru
  $healthy = $false
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    if ($process.HasExited) { throw "PHASE6_PREVIEW_SERVER_EXITED: $($process.ExitCode)" }
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 1
      if ($response.StatusCode -eq 200 -and $response.Content.Trim() -eq 'ok') { $healthy = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  if (-not $healthy) { throw "PHASE6_PREVIEW_HEALTHCHECK_FAILED: $healthUrl" }

  Write-Host "PHASE6_VISUAL_PREVIEW_URL = $url"
  Write-Host "PROFILE = $Profile"
  Write-Host "DATA_MODE = $($DataMode.ToUpperInvariant())"
  Write-Host "HEAD_SHA = $actualHead"
  Write-Host 'PRODUCTION_CLOUD_WRITE = NONE'
  Write-Host 'PREVIEW_DATA = SYNTHETIC_READ_ONLY'

  if ($HealthCheckOnly) { return }
  if (-not $NoBrowser) { Start-Process $url }
  Write-Host 'Press Ctrl+C to stop the local preview.'
  Wait-Process -Id $process.Id
}
finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
