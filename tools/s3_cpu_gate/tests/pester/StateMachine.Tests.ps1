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


# S3-R human-triggered final-head CI marker; no test behavior change.
Describe 'S3-R preserved-run recovery invariants' {
 It 'accepts only closed checkpoints for Resume' {
  $c=Get-TestContext; $c.State.currentState='60_CLOUDFLARE_PROVISIONED'; $c.State.completed=@('00_PACKAGE_READY','60_CLOUDFLARE_PROVISIONED')
  Assert-S3ResumeCheckpointSafe -State $c.State | Should -BeTrue
  $c.State.currentState='30_BRANCH_AND_DRAFT_PR'; {Assert-S3ResumeCheckpointSafe -State $c.State}|Should -Throw '*RESUME_REQUIRES_CLOSED_CHECKPOINT*'
 }
 It 'rehydrates exactly the preserved two UIDs in Simulation without provisioning' {
  $c=Get-TestContext; $c.Mode='Simulation'; $c.State.resources.firebase=[ordered]@{projectId='preserved';uid1='uid-one';uid2='uid-two'}
  $r=Invoke-S3FirebaseRuntimeRehydration -Context $c -ExpectedUids @('uid-one','uid-two') -CredentialProvider { param($project,$uids) [void]$project;[void]$uids;@() }
  $r.status|Should -Be 'SIMULATED';$r.sameUids|Should -BeTrue;$r.provisioningSkipped|Should -BeTrue;$r.secrets|Should -Be 'MEMORY_ONLY'
  $c.RuntimeSecrets.uid1|Should -Be 'uid-one';$c.State.results|ConvertTo-Json -Depth 20|Should -Not -Match 'mock-rehydrated-token'
 }
 It 'restores the Worker config after a successful action' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'workspace\worker') -Force|Out-Null;$path=Join-Path $TestDrive 'workspace\worker\wrangler.json';Set-Content $path '{"vars":{"TEST_CONTROLS":"enabled"}}'
  Invoke-S3WithWorkerStateRestore -Context $c -Action { Set-Content $path '{"vars":{"TEST_CONTROLS":"changed"}}';'ok' } -Restore { param($snapshot) [void]$snapshot;$script:restoreCalled=$true } | Should -Be 'ok'
  (Get-Content $path -Raw)|Should -Match 'TEST_CONTROLS';$script:restoreCalled|Should -BeTrue
 }
 It 'restores the Worker config when the action fails' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'workspace\worker') -Force|Out-Null;$path=Join-Path $TestDrive 'workspace\worker\wrangler.json';Set-Content $path '{"vars":{"TEST_CONTROLS":"enabled"}}'
  {Invoke-S3WithWorkerStateRestore -Context $c -Action { Set-Content $path '{"vars":{"TEST_CONTROLS":"changed"}}';throw 'CPU_GATE_FAILED' } -Restore { param($snapshot) [void]$snapshot;$script:restoreCalledOnFailure=$true }}|Should -Throw '*CPU_GATE_FAILED*'
  (Get-Content $path -Raw)|Should -Match 'TEST_CONTROLS';$script:restoreCalledOnFailure|Should -BeTrue
 }
}
