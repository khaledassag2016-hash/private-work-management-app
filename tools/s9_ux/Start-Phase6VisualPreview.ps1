param(
  [ValidateSet('Waleed','Khalid')]
  [string]$Profile = 'Khalid',

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$ExpectedHead,

  [ValidateRange(1024,65535)]
  [int]$Port = 4186,

  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$repoRoot = (& git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) { throw 'GIT_REPOSITORY_NOT_FOUND' }
Set-Location $repoRoot

$actualHead = (& git rev-parse HEAD).Trim()
if ($actualHead -ne $ExpectedHead) {
  throw "HEAD_MISMATCH: expected $ExpectedHead but found $actualHead"
}

$node = Get-Command node -ErrorAction Stop
$server = Join-Path $repoRoot 'tools/s9_ux/server.mjs'
if (-not (Test-Path -LiteralPath $server)) { throw 'PHASE6_PREVIEW_SERVER_NOT_FOUND' }

$env:PHASE6_VISUAL_PREVIEW_ROLE = $Profile.ToLowerInvariant()
$env:PHASE6_VISUAL_PREVIEW_PORT = [string]$Port
$url = "http://127.0.0.1:$Port/"

Write-Host "PHASE6_VISUAL_PREVIEW_PROFILE = $Profile"
Write-Host "PHASE6_VISUAL_PREVIEW_HEAD = $actualHead"
Write-Host "PHASE6_VISUAL_PREVIEW_URL = $url"
Write-Host 'DATA_MODE = SYNTHETIC_READ_ONLY'
Write-Host 'PRODUCTION_CLOUD_WRITE = NONE'
Write-Host 'Press Ctrl+C to stop the local preview.'

if (-not $NoBrowser) {
  Start-Process $url
}

& $node.Source $server
