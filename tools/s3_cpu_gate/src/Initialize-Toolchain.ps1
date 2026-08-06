[CmdletBinding()]param([switch]$NonInteractive)
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
$root='C:\Users\MC\Desktop\1'
Import-Module (Join-Path $root 'modules\Toolchain.psm1') -Force
Initialize-S3LocalToolchain -Root $root -NonInteractive:$NonInteractive
