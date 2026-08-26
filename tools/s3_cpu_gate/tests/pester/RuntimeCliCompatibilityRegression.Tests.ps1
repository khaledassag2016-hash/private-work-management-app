BeforeAll {
 . (Join-Path $PSScriptRoot 'TestHelper.ps1')
}

Describe 'Runtime CLI compatibility regressions' {
 It 'resolves Windows command shims before creating ProcessStartInfo' {
  $commonSource=Get-Content -Raw (Join-Path $ModuleRoot 'Common.psm1')
  $commonSource | Should -Match '\$resolvedFilePath=\$FilePath'
  $commonSource | Should -Match 'Get-Command \(\$FilePath \+ ''\.cmd''\)'
  $commonSource | Should -Match '\$psi\.FileName=\$resolvedFilePath'
 }

 It 'uses a fail-closed DIRECT proxy fallback when the default proxy is absent' {
  $prerequisitesSource=Get-Content -Raw (Join-Path $ModuleRoot 'Prerequisites.psm1')
  $prerequisitesSource | Should -Match '\$proxy=''DIRECT'''
  $prerequisitesSource | Should -Match '\$null -ne \$defaultProxy'
  $prerequisitesSource | Should -Match '\$null -ne \$proxyUri'
 $prerequisitesSource | Should -Not -Match 'DefaultWebProxy\.GetProxy\([^\r\n]+\)\.AbsoluteUri'
 }

 It 'ignores closed historical PRs when looking for an existing Draft PR' {
  $repositorySource=Get-Content -Raw (Join-Path $ModuleRoot 'Repository.psm1')
  $repositorySource | Should -Match "'--state','open'"
  $repositorySource | Should -Not -Match "'--state','all'"
 }

 It 'adds bundled Portable Git OpenSSL directories to the process PATH' {
  $toolchainModule=Join-Path $ModuleRoot 'Toolchain.psm1'
  $runtimeRoot=Join-Path $TestDrive 'runtime'
  $usrBin=Join-Path $runtimeRoot 'tools\git\usr\bin'
  $mingwBin=Join-Path $runtimeRoot 'tools\git\mingw64\bin'
  New-Item -ItemType Directory -Path $usrBin,$mingwBin -Force | Out-Null
  $originalPath=$env:PATH
  try {
   $env:PATH='S3_PATH_SENTINEL'
   Import-Module $toolchainModule -Force
   Enable-S3LocalToolPath -Root $runtimeRoot
   $pathEntries=@($env:PATH -split ';')
   $pathEntries | Should -Contain $usrBin
   $pathEntries | Should -Contain $mingwBin
   $pathEntries | Should -Contain 'S3_PATH_SENTINEL'
  }
  finally {
   $env:PATH=$originalPath
   Remove-Module Toolchain -Force -ErrorAction SilentlyContinue
  }
 }

 It 'parses the official gcloud SDK version output deterministically' {
  $toolchainModule=Join-Path $ModuleRoot 'Toolchain.psm1'
  Import-Module $toolchainModule -Force
  ConvertFrom-S3GcloudVersionOutput -Output @('Google Cloud SDK 577.0.0','bq 2.1.0') | Should -Be '577.0.0'
  { ConvertFrom-S3GcloudVersionOutput -Output @('gcloud unavailable') } | Should -Throw '*GCLOUD_VERSION_OUTPUT_INVALID*'
  (Get-Content -Raw $toolchainModule) | Should -Match "gcloud=@\('gcloud','--version'\)"
  (Get-Content -Raw $toolchainModule) | Should -Match 'TOOL_VERSION_COMMAND_FAILED'
  Remove-Module Toolchain -Force -ErrorAction SilentlyContinue
 }
}
