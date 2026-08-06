BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'State machine invariants' {
 BeforeEach { Mock Write-S3State {} }
 It 'permits first transition' { $c=Get-TestContext;Set-S3Checkpoint $c '10_LOCAL_PREREQUISITES';$c.State.currentState|Should -Be '10_LOCAL_PREREQUISITES' }
 It 'rejects skipped transition' { $c=Get-TestContext;{Set-S3Checkpoint $c '20_REPOSITORY_GATE'}|Should -Throw }
 It 'permits idempotent same state' { $c=Get-TestContext;Set-S3Checkpoint $c '00_PACKAGE_READY';$c.State.currentState|Should -Be '00_PACKAGE_READY' }
 It 'records completed checkpoint' { $c=Get-TestContext;Set-S3Checkpoint $c '10_LOCAL_PREREQUISITES';$c.State.completed|Should -Contain '10_LOCAL_PREREQUISITES' }
 It 'does not duplicate same checkpoint' { $c=Get-TestContext;Set-S3Checkpoint $c '00_PACKAGE_READY';@($c.State.completed|Where-Object{$_ -eq '00_PACKAGE_READY'}).Count|Should -Be 1 }
 It 'does not serialize RuntimeSecrets' { $c=Get-TestContext;$c.RuntimeSecrets.token1='secret';($c.State|ConvertTo-Json)|Should -Not -Match 'secret' }
 It 'simulation Firebase writes ownership marker' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;$c.State.resources.firebase.marker|Should -Be $c.RunId }
 It 'simulation Cloudflare writes ownership marker' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;Invoke-S3CloudflareProvision $c|Out-Null;$c.State.resources.cloudflare.marker|Should -Be $c.RunId }
 It 'branch resource writes ownership marker' { $c=Get-TestContext;Invoke-S3BranchAndDraftPr $c|Out-Null;$c.State.resources.branch.marker|Should -Be $c.RunId }
 It 'cleanup clears runtime secrets' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;Invoke-S3CloudflareProvision $c|Out-Null;Invoke-S3Cleanup $c|Out-Null;$c.RuntimeSecrets.Count|Should -Be 0 }
}
