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
}
