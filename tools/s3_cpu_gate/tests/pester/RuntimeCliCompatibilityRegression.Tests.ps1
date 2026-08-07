BeforeAll {
 . (Join-Path $PSScriptRoot 'TestHelper.ps1')
 $commonSource=Get-Content -Raw (Join-Path $ModuleRoot 'Common.psm1')
 $prerequisitesSource=Get-Content -Raw (Join-Path $ModuleRoot 'Prerequisites.psm1')
}

Describe 'Runtime CLI compatibility regressions' {
 It 'resolves Windows command shims before creating ProcessStartInfo' {
  $commonSource | Should -Match '\$resolvedFilePath=\$FilePath'
  $commonSource | Should -Match 'Get-Command \(\$FilePath \+ ''\.cmd''\)'
  $commonSource | Should -Match '\$psi\.FileName=\$resolvedFilePath'
 }

 It 'uses a fail-closed DIRECT proxy fallback when the default proxy is absent' {
  $prerequisitesSource | Should -Match '\$proxy=''DIRECT'''
  $prerequisitesSource | Should -Match '\$null -ne \$defaultProxy'
  $prerequisitesSource | Should -Match '\$null -ne \$proxyUri'
  $prerequisitesSource | Should -Not -Match 'DefaultWebProxy\.GetProxy\([^\r\n]+\)\.AbsoluteUri'
 }
}
