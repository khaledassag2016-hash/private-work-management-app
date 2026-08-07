BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }

function global:New-S3ProviderResponseForTest {
    param([string]$Collection,[bool]$Enabled,[string]$Name='projects/p/configs/provider')
    return [pscustomobject]@{$Collection=@([pscustomobject]@{name=$Name;enabled=$Enabled})}
}

function global:New-S3LiveCleanupContextForTest {
    $context = Get-TestContext 'Live'
    $accountId = '1234567890abcdef1234567890abcdef'
    $context.State.resources.cloudflare = [ordered]@{accountId=$accountId;worker="$($context.RunId)-worker";d1Name="$($context.RunId)-d1";d1Id='11111111-2222-3333-4444-555555555555';marker=$context.RunId}
    $context.RuntimeSecrets.cloudflareToken='synthetic-cloudflare-token'
    $context.RuntimeSecrets.cloudflareAccountId=$accountId
    return $context
}

Describe 'B3 Firebase fail-closed' -Tag 'B3' {
    It 'stops when GET for any provider collection fails' {
        Mock Invoke-S3GoogleRest {throw 'GET failed'} -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw
    }
    It 'stops when PATCH to disable a provider fails' {
        Mock Invoke-S3GoogleRest {
            param($Method,$Uri)
            if($Method -eq 'GET'){$collection=((($Uri -split '/')[-1]) -split '\?')[0];return New-S3ProviderResponseForTest -Collection $collection -Enabled $true -Name "projects/p/$collection/x"}
            throw 'PATCH failed'
        } -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw
    }
    It 'stops when one provider remains enabled after reread' {
        Mock Invoke-S3GoogleRest {
            param($Method,$Uri)
            if($Method -eq 'PATCH'){return [pscustomobject]@{}}
            $collection=((($Uri -split '/')[-1]) -split '\?')[0]
            return New-S3ProviderResponseForTest -Collection $collection -Enabled $true -Name "projects/p/$collection/x"
        } -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw '*STILL_ENABLED*'
    }
    It 'fails a missing provider collection property' {
        Mock Invoke-S3GoogleRest {[pscustomobject]@{}} -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw '*REQUIRED_VALUE_MISSING*'
    }
    It 'fails a provider enabled value with an unknown type' {
        Mock Invoke-S3GoogleRest {
            param($Uri)
            $collection=((($Uri -split '/')[-1]) -split '\?')[0]
            return [pscustomobject]@{$collection=@([pscustomobject]@{name='projects/p/configs/x';enabled='false'})}
        } -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw '*RESPONSE_INVALID*'
    }
    It 'succeeds only after all provider collections reread disabled' {
        $script:getCounts=@{}
        Mock Invoke-S3GoogleRest {
            param($Method,$Uri)
            if($Method -eq 'PATCH'){return [pscustomobject]@{}}
            $collection=((($Uri -split '/')[-1]) -split '\?')[0]
            if(-not $script:getCounts.ContainsKey($collection)){$script:getCounts[$collection]=0}
            $script:getCounts[$collection]++
            return New-S3ProviderResponseForTest -Collection $collection -Enabled ($script:getCounts[$collection] -eq 1) -Name "projects/p/$collection/x"
        } -ModuleName Firebase
        $proof=Disable-S3FederatedProvider -ProjectId p -Token token
        $proof.verified | Should -BeTrue
        $proof.enabledCount | Should -Be 0
    }
    It 'rejects an incomplete final Firebase configuration' {
        {Assert-S3FirebaseConfiguration -Configuration ([pscustomobject]@{}) -ProviderProof ([ordered]@{verified=$true;enabledCount=0})} | Should -Throw
    }
    It 'accepts the exact final Firebase configuration and proof' {
        $configuration=[pscustomobject]@{signIn=[pscustomobject]@{email=[pscustomobject]@{enabled=$true;passwordRequired=$true};phoneNumber=[pscustomobject]@{enabled=$false};anonymous=[pscustomobject]@{enabled=$false};allowDuplicateEmails=$false};client=[pscustomobject]@{permissions=[pscustomobject]@{disabledUserSignup=$true;disabledUserDeletion=$true}}}
        $proof=Assert-S3FirebaseConfiguration -Configuration $configuration -ProviderProof ([ordered]@{verified=$true;enabledCount=0})
        $proof.emailPasswordOnly | Should -BeTrue
        $proof.otherProviders | Should -BeFalse
    }
    It 'records firebaseGuard only after independent provider proof' {
        $source=Get-Content (Join-Path $SourceRoot 'src\modules\Firebase.psm1') -Raw
        $proofIndex=$source.IndexOf('$providerProof = Disable-S3FederatedProvider')
        $guardIndex=$source.IndexOf("-Name 'firebaseGuard'")
        $proofIndex | Should -BeGreaterThan -1
        $guardIndex | Should -BeGreaterThan $proofIndex
    }
    It 'does not expose API key or token text when a Google REST call fails' {
        Mock Invoke-RestMethod {throw ('https://example.test?key=SECRET-KEY Author' + 'ization: Bearer SECRET-TOKEN')} -ModuleName Firebase
        $message=''
        try{Invoke-S3GoogleRest -Method GET -Uri 'https://example.test?key=SECRET-KEY' -Token 'SECRET-TOKEN'}catch{$message=$_.Exception.Message}
        $message | Should -Not -Match 'SECRET-KEY|SECRET-TOKEN'
    }
}

Describe 'B4 Cloudflare cleanup fail-closed' -Tag 'B4' {
    It 'does not report DELETED when Worker deletion fails' {
        $c=New-S3LiveCleanupContextForTest
        Mock Invoke-S3Process {param($ArgumentList);if($ArgumentList[0] -eq 'delete'){[pscustomobject]@{ExitCode=1;StdOut='';StdErr='failed'}}else{[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}}} -ModuleName Cloudflare
        Mock Wait-S3CloudflareResourceAbsence {[ordered]@{status='PASS';attempts=1;workerAbsent=$true;d1Absent=$true}} -ModuleName Cloudflare
        (Remove-S3CloudflareResource $c).status | Should -Be 'FAILED'
    }
    It 'does not report DELETED when D1 deletion fails' {
        $c=New-S3LiveCleanupContextForTest
        Mock Invoke-S3Process {param($ArgumentList);if($ArgumentList[0] -eq 'd1'){[pscustomobject]@{ExitCode=1;StdOut='';StdErr='failed'}}else{[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}}} -ModuleName Cloudflare
        Mock Wait-S3CloudflareResourceAbsence {[ordered]@{status='PASS';attempts=1;workerAbsent=$true;d1Absent=$true}} -ModuleName Cloudflare
        (Remove-S3CloudflareResource $c).status | Should -Be 'FAILED'
    }
    It 'does not treat a verification command failure as absence' {
        Mock Get-S3CloudflareResourceAbsenceProof {throw 'list failed'} -ModuleName Cloudflare
        (Wait-S3CloudflareResourceAbsence -AccountId a -Token t -Worker w -D1Name d -D1Id id -DelaySeconds 0).status | Should -Be 'UNKNOWN'
    }
    It 'fails when the Worker remains after deletion' {
        Mock Get-S3CloudflareResourceAbsenceProof {[ordered]@{workerAbsent=$false;d1Absent=$true}} -ModuleName Cloudflare
        $result=Wait-S3CloudflareResourceAbsence -AccountId a -Token t -Worker w -D1Name d -D1Id id -DelaySeconds 0
        $result.status | Should -Be 'PARTIAL'
        $result.workerAbsent | Should -BeFalse
    }
    It 'fails when D1 remains after deletion' {
        Mock Get-S3CloudflareResourceAbsenceProof {[ordered]@{workerAbsent=$true;d1Absent=$false}} -ModuleName Cloudflare
        $result=Wait-S3CloudflareResourceAbsence -AccountId a -Token t -Worker w -D1Name d -D1Id id -DelaySeconds 0
        $result.status | Should -Be 'PARTIAL'
        $result.d1Absent | Should -BeFalse
    }
    It 'reports partial cleanup rather than PASS' {
        $c=New-S3LiveCleanupContextForTest
        Mock Invoke-S3Process {[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}} -ModuleName Cloudflare
        Mock Wait-S3CloudflareResourceAbsence {[ordered]@{status='PARTIAL';attempts=3;workerAbsent=$true;d1Absent=$false}} -ModuleName Cloudflare
        (Remove-S3CloudflareResource $c).status | Should -Be 'PARTIAL'
    }
    It 'reports DELETED only when both deletions and absence proof pass' {
        $c=New-S3LiveCleanupContextForTest
        Mock Invoke-S3Process {[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}} -ModuleName Cloudflare
        Mock Wait-S3CloudflareResourceAbsence {[ordered]@{status='PASS';attempts=2;workerAbsent=$true;d1Absent=$true}} -ModuleName Cloudflare
        $result=Remove-S3CloudflareResource $c
        $result.status | Should -Be 'DELETED'
        $result.attempts | Should -Be 2
    }
    It 'refuses ownership mismatch before any deletion command' {
        $c=New-S3LiveCleanupContextForTest
        $c.State.resources.cloudflare.marker='other-run'
        Mock Invoke-S3Process {throw 'must not run'} -ModuleName Cloudflare
        {Remove-S3CloudflareResource $c} | Should -Throw
        Should -Invoke Invoke-S3Process -ModuleName Cloudflare -Times 0 -Exactly
    }
    It 'prevents checkpoint 80 unless cleanup status is PASS' {
        $source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw
        $source | Should -Match "cleanupResult.status -eq 'PASS'.*80_RESOURCES_DESTROYED"
    }
    It 'never writes a full Cloudflare Account ID to destruction reports' {
        $c=Get-TestContext
        Invoke-S3FirebaseProvision $c|Out-Null
        Invoke-S3CloudflareProvision $c|Out-Null
        $c.State.resources.cloudflare.accountId='1234567890abcdef1234567890abcdef'
        $cleanup=Invoke-S3Cleanup $c
        $cleanup.status | Should -Be 'PASS'
        (Get-Content (Join-Path $TestDrive 'reports\resource-destruction.json') -Raw) | Should -Not -Match '1234567890abcdef1234567890abcdef'
    }
}

Describe 'B8 owned login and temporary credential cleanup' -Tag 'B8' {
    It 'does not automatically call wrangler login when Cloudflare session is absent' {
        (Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw) | Should -Not -Match "wrangler.*login|ArgumentList @\('login'\)"
    }
    It 'preserves preexisting sessions because only owned sessions are cleaned' {
        $c=Get-TestContext
        $c.State.results.cliSessions=[ordered]@{firebase=[ordered]@{status='PREEXISTING'};gcloud=[ordered]@{status='PREEXISTING'};cloudflare=[ordered]@{status='PREEXISTING'}}
        Mock Invoke-S3Process {throw 'logout must not run'} -ModuleName Cleanup
        (Invoke-S3Cleanup $c).status | Should -Be 'PASS'
        Should -Invoke Invoke-S3Process -ModuleName Cleanup -Times 0 -Exactly
    }
    It 'cleans an owned Firebase token session and clears runtime secrets' {
        $c=Get-TestContext
        $c.RuntimeSecrets.ownedFirebaseToken='owned-token'
        Register-S3OwnedCliSession -Context $c -Kind firebase-token -SecretKey ownedFirebaseToken | Out-Null
        Mock Invoke-S3Process {[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}} -ModuleName Cleanup
        $result=Invoke-S3Cleanup $c
        $result.status | Should -Be 'PASS'
        $c.RuntimeSecrets.Count | Should -Be 0
        Should -Invoke Invoke-S3Process -ModuleName Cleanup -Times 1 -Exactly -ParameterFilter {$FilePath -eq 'firebase' -and $ArgumentList[0] -eq 'logout'}
    }
    It 'turns an owned-session logout failure into cleanup FAIL' {
        $c=Get-TestContext
        $c.RuntimeSecrets.ownedFirebaseToken='owned-token'
        Register-S3OwnedCliSession -Context $c -Kind firebase-token -SecretKey ownedFirebaseToken | Out-Null
        Mock Invoke-S3Process {[pscustomobject]@{ExitCode=1;StdOut='';StdErr='failed'}} -ModuleName Cleanup
        (Invoke-S3Cleanup $c).status | Should -Be 'FAIL'
    }
    It 'clears a sensitive environment variable owned by the tool' {
        $c=Get-TestContext
        $name='S3_PHASE3_TEMP_TOKEN'
        [Environment]::SetEnvironmentVariable($name,$null,'Process')
        Register-S3OwnedEnvironmentVariable -Context $c -Name $name
        [Environment]::SetEnvironmentVariable($name,'temporary-secret','Process')
        Invoke-S3Cleanup $c | Out-Null
        [Environment]::GetEnvironmentVariable($name,'Process') | Should -BeNullOrEmpty
    }
    It 'deletes temporary configuration and SQL files' {
        $c=Get-TestContext
        Set-Content (Join-Path $TestDrive 'temp\allowlist.sql') 'synthetic'
        New-Item -ItemType Directory -Path (Join-Path $TestDrive 'temp\firebase-config') -Force|Out-Null
        Set-Content (Join-Path $TestDrive 'temp\firebase-config\session.json') 'synthetic'
        Invoke-S3Cleanup $c | Out-Null
        @(Get-ChildItem (Join-Path $TestDrive 'temp') -Force).Count | Should -Be 0
    }
    It 'does not put token or password canaries in state logs or reports' {
        $c=Get-TestContext
        $c.RuntimeSecrets.password1='PASSWORD-CANARY-123'
        $c.RuntimeSecrets.token1='TOKEN-CANARY-123'
        Invoke-S3Cleanup $c | Out-Null
        $text=(Get-ChildItem $TestDrive -Recurse -File -ErrorAction SilentlyContinue|Get-Content -Raw) -join "`n"
        $text | Should -Not -Match 'PASSWORD-CANARY-123|TOKEN-CANARY-123'
    }
    It 'is idempotent and does not repeat cleanup for an already cleared owned session' {
        $c=Get-TestContext
        $c.RuntimeSecrets.ownedFirebaseToken='owned-token'
        Register-S3OwnedCliSession -Context $c -Kind firebase-token -SecretKey ownedFirebaseToken | Out-Null
        Mock Invoke-S3Process {[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}} -ModuleName Cleanup
        Invoke-S3Cleanup $c | Out-Null
        Invoke-S3Cleanup $c | Out-Null
        Should -Invoke Invoke-S3Process -ModuleName Cleanup -Times 1 -Exactly -ParameterFilter {$FilePath -eq 'firebase'}
    }
    It 'cleans an isolated gcloud configuration created by the tool' {
        $c=Get-TestContext
        $path=Join-Path $TestDrive 'temp\sessions\gcloud'
        New-Item -ItemType Directory -Path $path -Force|Out-Null
        Set-Content (Join-Path $path 'credentials.db') 'synthetic'
        Register-S3OwnedCliSession -Context $c -Kind gcloud-config -ConfigPath $path | Out-Null
        Mock Invoke-S3Process {param($ArgumentList);if($ArgumentList[1] -eq 'list'){[pscustomobject]@{ExitCode=0;StdOut='[]';StdErr=''}}else{[pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}}} -ModuleName Cleanup
        $result=Invoke-S3Cleanup $c
        $result.status | Should -Be 'PASS'
        Test-Path $path | Should -BeFalse
    }
    It 'records CLI inventory without storing returned tokens' {
        $c=Get-TestContext 'Live'
        Mock Invoke-S3Process {
            param($FilePath)
            switch($FilePath){
                'firebase'{[pscustomobject]@{ExitCode=0;StdOut='{"result":[{"user":{"email":"synthetic@example.invalid"}}]}';StdErr=''}}
                'gcloud'{[pscustomobject]@{ExitCode=0;StdOut='[{"account":"synthetic@example.invalid"}]';StdErr=''}}
                'wrangler'{[pscustomobject]@{ExitCode=0;StdOut='{"type":"oauth","token":"TOKEN-CANARY"}';StdErr=''}}
            }
        } -ModuleName Cleanup
        $record=Initialize-S3CliSessionInventory $c
        $record.cloudflare.status | Should -Be 'PREEXISTING'
        ($c.State.results.cliSessions | ConvertTo-Json -Depth 10) | Should -Not -Match 'TOKEN-CANARY|synthetic@example.invalid'
    }
}
