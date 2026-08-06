BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'Safety guards and simulation' {
 It 'simulation prerequisites do not call network' { $c=Get-TestContext;Mock Invoke-WebRequest {throw 'network'};(Invoke-S3Prerequisite $c).internet|Should -BeTrue;Mock Clear-Host {throw 'redirected host'} -ModuleName Ui;{Show-S3Stage -Number 1 -Title 'test' -Body 'test'}|Should -Not -Throw }
 It 'simulation repository gate reports expected hash' { $c=Get-TestContext;(Invoke-S3RepositoryGate $c).sha256|Should -Be '6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b' }
 It 'simulation repository gate reports 23 tests' { $c=Get-TestContext;(Invoke-S3RepositoryGate $c).s2Tests|Should -Be '23/23' }
 It 'plan branch stage has no PR' { $c=Get-TestContext 'Plan';(Invoke-S3BranchAndDraftPr $c).draftPr|Should -BeNullOrEmpty }
 It 'simulation branch stage is draft placeholder only' { $c=Get-TestContext;(Invoke-S3BranchAndDraftPr $c).status|Should -Be 'SIMULATED' }
 It 'simulation Firebase has exactly two users' { $c=Get-TestContext;(Invoke-S3FirebaseProvision $c).users|Should -Be 2 }
 It 'simulation Firebase marks secrets memory only' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;$c.State.results.Keys|Should -Not -Contain 'firebaseRuntime' }
 It 'simulation Cloudflare creates one Worker and one D1' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;$result=Invoke-S3CloudflareProvision $c;$result.worker|Should -Match '^s3cpu-';$result.d1|Should -Match '^s3cpu-' }
 It 'simulation cleanup requests Firebase deletion' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;(Remove-S3FirebaseProject $c).status|Should -Be 'DELETE_REQUESTED' }
 It 'simulation cleanup deletes Cloudflare mock' { $c=Get-TestContext;Invoke-S3FirebaseProvision $c|Out-Null;Invoke-S3CloudflareProvision $c|Out-Null;(Remove-S3CloudflareResource $c).status|Should -Be 'DELETED' }
 It 'Firebase delete refuses marker mismatch' { $c=Get-TestContext;$c.State.resources.firebase=@{projectId="$($c.RunId)-fb";marker='other'};{Remove-S3FirebaseProject $c}|Should -Throw }
 It 'Cloudflare delete refuses marker mismatch' { $c=Get-TestContext;$c.State.resources.cloudflare=@{worker="$($c.RunId)-worker";d1Name="$($c.RunId)-d1";marker='other'};{Remove-S3CloudflareResource $c}|Should -Throw }
 It 'synthetic passwords are strong and distinct' { $a=Get-S3SyntheticPassword;$b=Get-S3SyntheticPassword;$a.Length|Should -BeGreaterThan 30;$a|Should -Not -Be $b }
 It 'wrangler config uses workers.dev' { (Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw)|Should -Match 'workers_dev=\$true' }
 It 'wrangler config has only D1 binding' { $text=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw;$text|Should -Not -Match 'durable_objects|kv_namespaces|r2_buckets|queues' }
 It 'source forbids Zero Trust' { (Get-MainSourceFile|Get-Content -Raw) -join "`n" | Should -Not -Match 'cloudflared tunnel|zero.?trust create' }
 It 'orchestrator never merges PR' { (Get-Content (Join-Path $SourceRoot 'src\modules\Repository.psm1') -Raw)|Should -Not -Match "gh.*pr.*merge" }
 It 'PR body never closes Issue 2' { (Get-Content (Join-Path $SourceRoot 'src\modules\Repository.psm1') -Raw)|Should -Not -Match '(?i)(closes|fixes|resolves) #2' }
 It 'Firebase passwords never appear in command arguments' { (Get-Content (Join-Path $SourceRoot 'src\modules\Firebase.psm1') -Raw)|Should -Not -Match "ArgumentList.*password" }
 It 'state writer has a secret-field guard' { (Get-Content (Join-Path $SourceRoot 'src\modules\Common.psm1') -Raw)|Should -Match 'رفض حفظ state.json' }
 It 'B2 telemetry uses official Cloudflare fields and OTel names' { $text=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw;foreach($field in @('$workers.cpuTimeMs','$workers.wallTimeMs','$workers.outcome','$workers.requestId','$metadata.requestId','cloudflare.cpu_time_ms','cloudflare.wall_time_ms','cloudflare.outcome','cloudflare.ray_id')){$text|Should -Match ([regex]::Escape($field))} }
 It 'B5 preflight never logs billing-sensitive values' { $text=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw;$text|Should -Not -Match '(?i)card_number|paypal|payment_nonce|cookie';$text|Should -Match 'Get-S3RedactedAccountId' }

}
