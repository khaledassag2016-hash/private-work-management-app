BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'Package policy' {
 It 'uses strict mode in every PowerShell file' { foreach($file in Get-MainSourceFile -Extension @('.ps1','.psm1')){(Get-Content $file -Raw)|Should -Match 'Set-StrictMode -Version Latest'} }
 It 'uses stop error preference in every PowerShell file' { foreach($file in Get-MainSourceFile -Extension @('.ps1','.psm1')){(Get-Content $file -Raw)|Should -Match "ErrorActionPreference='Stop'|ErrorActionPreference = 'Stop'"} }
 It 'does not permanently alter execution policy' { (Get-MainSourceFile|Get-Content -Raw)-join "`n"|Should -Not -Match 'Set-ExecutionPolicy' }
 It 'does not permanently alter machine PATH' { (Get-Content (Join-Path $SourceRoot 'src\modules\Toolchain.psm1') -Raw)|Should -Not -Match 'EnvironmentVariableTarget\]::Machine|setx' }
 It 'contains no service-account JSON' { @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File|Where-Object{-not $_.FullName.StartsWith($NestedPayloadRoot,[StringComparison]::OrdinalIgnoreCase) -and $_.Name -match 'service.?account.*json'}).Count|Should -Be 0 }
 It 'contains no env files' { @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -Force -File|Where-Object{-not $_.FullName.StartsWith($NestedPayloadRoot,[StringComparison]::OrdinalIgnoreCase) -and $_.Name -match '^\.env'}).Count|Should -Be 0 }
 It 'worker is fail closed' { $worker=Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw;$worker|Should -Match 'TOKEN_MISSING';$worker|Should -Match 'UID_NOT_ALLOWED' }
 It 'worker validates RS256' { (Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw)|Should -Match "header.alg !== 'RS256'" }
 It 'worker validates audience and issuer separately' { $worker=Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw;$worker|Should -Match 'AUD_INVALID';$worker|Should -Match 'ISS_INVALID' }
 It 'worker checks auth time and subject' { $worker=Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw;$worker|Should -Match 'AUTH_TIME_INVALID';$worker|Should -Match 'SUB_INVALID' }
 It 'worker D1 access is parameterized' { (Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw)|Should -Match '\.bind\(uid\)' }
 It 'test control requires nonce' { (Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw)|Should -Match 'TEST_RESET_NONCE' }
 It 'test controls are disabled after measurements' { (Get-Content (Join-Path $SourceRoot 'src\modules\CpuGate.psm1') -Raw)|Should -Match "TEST_CONTROLS='disabled'" }
 It 'package uses only fixed workspace root' { (Get-Content (Join-Path $SourceRoot 'src\Bootstrap.ps1') -Raw)|Should -Match ([regex]::Escape('C:\Users\MC\Desktop\1')) }
 It 'START uses process-only bypass' { (Get-Content (Join-Path $SourceRoot 'src\START.cmd') -Raw)|Should -Match 'ExecutionPolicy Bypass' }
}
