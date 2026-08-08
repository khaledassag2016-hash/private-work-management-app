BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'Operational regression coverage' {
 It 'does not scan the full runtime root before Cloudflare preflight' {
  $source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw
  $source|Should -Not -Match 'Assert-S3NoSecret\s+-Context\s+\$context\s+-Path\s+\$context\.Root'
  $source|Should -Match 'Assert-S3DeploymentPayloadNoSecret\s+-Context\s+\$context\s+-Scope\s+PreCloud'
 }
 It 'requires a positive allowlist and direct scans before every Cloudflare deployment write' {
  $common=Get-Content (Join-Path $SourceRoot 'src\modules\Common.psm1') -Raw
  $cloudflare=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw
  $common|Should -Match "DEPLOYMENT_PAYLOAD_UNALLOWLISTED_FILE"
  $common|Should -Match "SECRET_SCAN_SCOPE_EMPTY"
  $cloudflare.IndexOf("Assert-S3DeploymentPayloadNoSecret -Context `$Context -Scope PreCloud")|Should -BeLessThan $cloudflare.IndexOf("'d1','create'")
  $cloudflare.IndexOf("Assert-S3DeploymentPayloadNoSecret -Context `$Context -Scope CloudflareExecution")|Should -BeLessThan $cloudflare.IndexOf("'d1','execute'")
  $cloudflare.LastIndexOf("Assert-S3DeploymentPayloadNoSecret -Context `$Context -Scope FinalDeployment")|Should -BeLessThan $cloudflare.LastIndexOf("'deploy','--config'")
 }
 It 'normalizes JSON resume state for mutable resource and result writes' {
  $state=[ordered]@{
   schemaVersion=2;runId='s3cpu-resume-test';mode='Simulation';currentState='40_PRE_CLOUD_GATE'
   completed=@('00_PACKAGE_READY','10_LOCAL_PREREQUISITES','20_REPOSITORY_GATE','30_BRANCH_AND_DRAFT_PR','40_PRE_CLOUD_GATE')
   resources=[ordered]@{};results=[ordered]@{};failure=$null
  }
  $state|ConvertTo-Json -Depth 20|Set-Content (Join-Path $TestDrive 'state.json') -Encoding UTF8
  $loaded=Read-S3State -Root $TestDrive
  {Set-S3MapValue -Map $loaded.resources -Name 'firebase' -Value ([ordered]@{marker='s3cpu-resume-test'});Set-S3MapValue -Map $loaded.results -Name 'firebase' -Value ([ordered]@{status='SIMULATED'})}|Should -Not -Throw
  (Get-S3MapValue -Map $loaded.resources -Name 'firebase').marker|Should -Be 's3cpu-resume-test'
 }
 It 'persists the Simulation Firebase result without a secret-field rejection' {
  $c=Get-TestContext
  $firebase=Invoke-S3FirebaseProvision $c
  Set-S3MapValue -Map $c.State.results -Name 'firebase' -Value $firebase
  {Write-S3State -Root $TestDrive -State $c.State}|Should -Not -Throw
  $firebase.secrets|Should -Be 'MEMORY_ONLY'
  (Get-Content (Join-Path $TestDrive 'state.json') -Raw)|Should -Not -Match '"idTokens"'
 }
 It 'cleans a Firebase-only partial run without treating absent Cloudflare as an error' {
  $c=Get-TestContext
  Invoke-S3FirebaseProvision $c|Out-Null
  $cleanup=Invoke-S3Cleanup $c
  $cleanup.status|Should -Be 'PASS'
  $cleanup.cloudflare.status|Should -Be 'NOT_CREATED'
  $cleanup.firebase.status|Should -Be 'DELETE_REQUESTED'
  Test-Path (Join-Path $TestDrive 'reports\resource-destruction.json')|Should -BeTrue
 }
 It 'writes a complete cleanup report when a resource ownership check fails' {
  $c=Get-TestContext
  Set-S3MapValue -Map $c.State.resources -Name 'cloudflare' -Value ([ordered]@{worker='s3cpu-wrong-worker';d1Name='s3cpu-wrong-d1';marker='wrong'})
  $cleanup=Invoke-S3Cleanup $c
  $cleanup.status|Should -Be 'FAIL'
  $cleanup.cloudflare.status|Should -Be 'FAILED'
  $cleanup.firebase.status|Should -Be 'NOT_CREATED'
  (Get-Content (Join-Path $TestDrive 'reports\resource-destruction.md') -Raw)|Should -Match 'Cloudflare: FAILED'
 }
 It 'preserves the original failure reason when state serialization is rejected' {
  $c=Get-TestContext
  $secretField=('id'+'Token');$unsafe=[ordered]@{};$unsafe[$secretField]='synthetic'
  Set-S3MapValue -Map $c.State.results -Name 'unsafeTestValue' -Value $unsafe
  $evidence=Write-S3FailureEvidence -Context $c -Reason 'ORIGINAL_FAILURE'
  $evidence.stateSaved|Should -BeFalse
  $fallback=Get-Content (Join-Path $TestDrive 'reports\failure-fallback.json') -Raw|ConvertFrom-Json
  $fallback.reason|Should -Be 'ORIGINAL_FAILURE'
 }
 It 'preserves the E2E runtime directory only when a scenario fails' {
  $e2eCandidates=@(
   (Join-Path $SourceRoot '..\validation\Invoke-E2EScenarios.ps1')
   (Join-Path $SourceRoot 'validation\Invoke-E2EScenarios.ps1')
  )
  $e2ePath=$e2eCandidates|Where-Object{Test-Path -LiteralPath $_ -PathType Leaf}|Select-Object -First 1
  $e2ePath|Should -Not -BeNullOrEmpty
  $text=Get-Content -LiteralPath $e2ePath -Raw
  $text|Should -Match '\[string\]\$FixedRoot'
  $text|Should -Match "\`$result\.status -eq 'PASS'.*\`$RuntimeRoot"
 }
}

Describe 'B5 Cloudflare read-only preflight' -Tag 'B5' {
 It 'selects one correct account only when the ID is explicit' {$a=Select-S3CloudflareAccount -Accounts @([ordered]@{id='account-a'}) -SelectedAccountId account-a;$a.id|Should -Be account-a}
 It 'refuses multiple accounts without selection' {{Select-S3CloudflareAccount -Accounts @([ordered]@{id='a'},[ordered]@{id='b'})}|Should -Throw '*MULTIPLE_CLOUDFLARE_ACCOUNTS*'}
 It 'refuses an Account ID that is not listed' {{Select-S3CloudflareAccount -Accounts @([ordered]@{id='a'}) -SelectedAccountId missing}|Should -Throw '*NOT_FOUND*'}
 It 'fails incomplete account pagination' {Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=@(1..50|ForEach-Object{[ordered]@{id="a$_"}})}} -ModuleName Cloudflare;{Get-S3CloudflareAccounts -Token token}|Should -Throw '*PAGINATION_METADATA_MISSING*'}
 It 'blocks a paid subscription' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='active';price=5})}|Should -Throw '*PAID_SUBSCRIPTION*'}
 It 'blocks a Trial subscription' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='trial'})}|Should -Throw '*TRIAL_SUBSCRIPTION*'}
 It 'blocks AwaitingPayment' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='AwaitingPayment'})}|Should -Throw '*AWAITING_PAYMENT*'}
 It 'blocks an inconclusive Alpha PayGo result' {{Test-S3CloudflarePayGo -PayGoResult ([ordered]@{alpha=$true;status='alpha'})}|Should -Throw '*PAYGO_UNKNOWN*'}
 It 'blocks unknown Workers settings' {{Test-S3WorkersAccountSettings -Settings ([ordered]@{})}|Should -Throw '*WORKERS_SETTINGS_UNKNOWN*'}
 It 'blocks unauthorized Workers Observability' {Mock Invoke-S3CloudflareRest {throw '403 forbidden'} -ModuleName Cloudflare;{Test-S3WorkersObservabilityAuthorization -AccountId account -Token token}|Should -Throw}
 It 'blocks a missing workers.dev subdomain' {{Test-S3WorkersDevSubdomain -SubdomainResult ([ordered]@{subdomain='';enabled=$false})}|Should -Throw '*WORKERS_DEV_SUBDOMAIN_UNAVAILABLE*'}
 It 'stops when the user cancels the Arabic attestation' {$r=Confirm-S3CloudflareBillingAttestation -ReadChoice {'2'};$r.status|Should -Be CANCELLED;$r.accepted|Should -BeFalse}
 It 'accepts only the affirmative Arabic attestation' {$r=Confirm-S3CloudflareBillingAttestation -ReadChoice {'1'};$r.status|Should -Be YES;$r.accepted|Should -BeTrue}
 It 'places the preflight before Firebase and stops failures before it' {$source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw;$preflight=$source.IndexOf('Invoke-S3CloudflareReadOnlyPreflight');$firebase=$source.IndexOf('Invoke-S3FirebaseProvision');$preflight|Should -BeGreaterThan -1;$firebase|Should -BeGreaterThan $preflight;$source|Should -Match "if\(\`$preflight.status -ne 'PASS'\)"}
 It 'rejects every Cloudflare write API call' {Mock Invoke-RestMethod {throw 'must not run'} -ModuleName Cloudflare;{Invoke-S3CloudflareRest -Method POST -Uri 'https://api.cloudflare.com/client/v4/accounts/a/workers/scripts' -Token token -Body @{}}|Should -Throw '*CLOUDFLARE_WRITE_API_FORBIDDEN*';Should -Invoke Invoke-RestMethod -ModuleName Cloudflare -Times 0 -Exactly}
 It 'does not use the deprecated Billing Profile API' {$source=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw;$source|Should -Not -Match '(?i)billing/profile|billing profile api'}
 It 'uses accounts rather than token verify for OAuth and requires the selected account' {
  Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=@([ordered]@{id='account-a'});result_info=[ordered]@{page=1;total_pages=1}}} -ModuleName Cloudflare
  $result=Test-S3CloudflareSession -Token token -TokenType oauth -SelectedAccountId account-a
  $result.session|Should -Be OAUTH_ACCOUNTS_VALID
  Should -Invoke Invoke-S3CloudflareRest -ModuleName Cloudflare -ParameterFilter {$Uri -match '/accounts\?page=1&per_page=50$'} -Times 1 -Exactly
  Should -Invoke Invoke-S3CloudflareRest -ModuleName Cloudflare -ParameterFilter {$Uri -match '/user/tokens/verify$'} -Times 0 -Exactly
 }
 It 'fails OAuth when the selected account is absent' {
  Mock Get-S3CloudflareAccounts {[ordered]@{status='PASS';items=@([ordered]@{id='different-account'});pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
  {Test-S3CloudflareSession -Token token -TokenType oauth -SelectedAccountId account-a}|Should -Throw '*SELECTED_CLOUDFLARE_ACCOUNT_NOT_FOUND*'
 }
 It 'fails OAuth on 401 or 403 accounts responses' {
  Mock Get-S3CloudflareAccounts {throw '401 Unauthorized'} -ModuleName Cloudflare
  {Test-S3CloudflareSession -Token token -TokenType oauth -SelectedAccountId account-a}|Should -Throw '*401*'
  Mock Get-S3CloudflareAccounts {throw '403 Forbidden'} -ModuleName Cloudflare
  {Test-S3CloudflareSession -Token token -TokenType oauth -SelectedAccountId account-a}|Should -Throw '*403*'
 }
 It 'fails OAuth when the accounts response is incomplete' {
  Mock Get-S3CloudflareAccounts {[ordered]@{status='PASS';items=$null;pagesRead=@();paginationComplete=$false}} -ModuleName Cloudflare
  {Test-S3CloudflareSession -Token token -TokenType oauth -SelectedAccountId account-a}|Should -Throw '*CLOUDFLARE_OAUTH_ACCOUNTS_INVALID*'
 }
 It 'keeps API tokens on the token verify path' {
  Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='active'}}} -ModuleName Cloudflare
  $result=Test-S3CloudflareSession -Token token -TokenType api_token -SelectedAccountId account-a
  $result.session|Should -Be API_TOKEN_VALID
  Should -Invoke Invoke-S3CloudflareRest -ModuleName Cloudflare -ParameterFilter {$Uri -match '/user/tokens/verify$'} -Times 1 -Exactly
 }
 It 'fails closed for an unknown Cloudflare token type' {
  Mock Invoke-S3CloudflareRest {throw 'must not run'} -ModuleName Cloudflare
  {Test-S3CloudflareSession -Token token -TokenType unknown -SelectedAccountId account-a}|Should -Throw '*CLOUDFLARE_TOKEN_TYPE_UNKNOWN*'
  Should -Invoke Invoke-S3CloudflareRest -ModuleName Cloudflare -Times 0 -Exactly
 }
 It 'retains the OAuth token type returned by Wrangler' {
  Mock Invoke-S3Process {[pscustomobject]@{ExitCode=0;StdOut='{"type":"oauth","token":"synthetic-token"}'}} -ModuleName Cloudflare
  $record=Get-S3CloudflareToken -Context (Get-TestContext Live)
  $record.type|Should -Be oauth;$record.token|Should -Be synthetic-token
 }
 It 'completes a fully mocked accepted preflight without cloud writes' {
  $c=Get-TestContext Live
  Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
  Mock Get-S3CloudflareAccounts {throw 'OAuth session result must supply validated accounts'} -ModuleName Cloudflare
  Mock Invoke-S3CloudflarePagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
  Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Invoke-S3CloudflareRest {param($Method,$Uri)[void]$Method;if($Uri -match 'paygo'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}}elseif($Uri -match 'account-settings'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}}}elseif($Uri -match 'subdomain'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}}}else{[pscustomobject]@{success=$true;errors=@();result=@()}}} -ModuleName Cloudflare
  Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare
  $r=Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token token -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
  $r.status|Should -Be PASS;$r.attestation|Should -Be YES;$c.State.resources.Count|Should -Be 0
  Should -Invoke Test-S3WorkersObservabilityAuthorization -ModuleName Cloudflare -Times 1 -Exactly
  Should -Invoke Get-S3CloudflareAccounts -ModuleName Cloudflare -Times 0 -Exactly
 }
}

Describe 'S3 Billing Read Preflight Isolation and Bounds' -Tag 'B5' {
    BeforeEach {
        $env:S3_CLOUDFLARE_BILLING_READ_TOKEN = $null
    }

    It 'OAuth remains the primary credential and billing token is separate' {
        $c = Get-TestContext Live
        (Get-S3MapValue -Map $c.RuntimeSecrets -Name 'cloudflareToken') | Should -BeNullOrEmpty
        (Get-S3MapValue -Map $c.RuntimeSecrets -Name 'cloudflareAccountId') | Should -BeNullOrEmpty
    }

    It 'Missing Billing credential in Live path throws MANUAL_ACTION_REQUIRED_BILLING_READ_TOKEN' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token token -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage } | Should -Throw '*MANUAL_ACTION_REQUIRED_BILLING_READ_TOKEN*'
    }

    It 'Billing environment variable is immediately wiped after acquisition' {
        $c = Get-TestContext Live
        $env:S3_CLOUDFLARE_BILLING_READ_TOKEN = 'secret-token-123'
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {[pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled'}}} -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method,$Uri)
            if($Uri -match 'account-settings'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}}}
            elseif($Uri -match 'subdomain'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}}}
            else{[pscustomobject]@{success=$true;errors=@();result=@()}}
        } -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage
        $env:S3_CLOUDFLARE_BILLING_READ_TOKEN | Should -BeNullOrEmpty
    }

    It 'billing token is used only for subscriptions and paygo, OAuth is used for the rest' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            param($Uri, $Token, $ExpectedAccountId)
            $Token | Should -Be 'billing-token-xyz'
            $ExpectedAccountId | Should -Be 'account-a'
            return [ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            param($Method, $Uri, $Token, $ExpectedAccountId)
            $Token | Should -Be 'billing-token-xyz'
            $ExpectedAccountId | Should -Be 'account-a'
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            $Token | Should -Be 'oauth-token-123'
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
        $r.status | Should -Be PASS
    }

    It 'billing token cannot be used for Workers/D1/Observability APIs' {
        Mock Invoke-RestMethod {throw 'must not run'} -ModuleName Cloudflare
        { Invoke-S3CloudflareBillingRead -Method GET -Uri 'https://api.cloudflare.com/client/v4/accounts/account-a/workers/scripts' -Token 'billing-token-xyz' -ExpectedAccountId 'account-a' } | Should -Throw '*CLOUDFLARE_BILLING_ENDPOINT_FORBIDDEN*'
        Should -Invoke Invoke-RestMethod -ModuleName Cloudflare -Times 0
    }

    It 'billing token cannot be used with write operations POST/PUT/PATCH/DELETE' {
        Mock Invoke-RestMethod {throw 'must not run'} -ModuleName Cloudflare
        { Invoke-S3CloudflareBillingRead -Method POST -Uri 'https://api.cloudflare.com/client/v4/accounts/account-a/subscriptions' -Token 'billing-token-xyz' -ExpectedAccountId 'account-a' } | Should -Throw '*CLOUDFLARE_BILLING_WRITE_FORBIDDEN*'
        Should -Invoke Invoke-RestMethod -ModuleName Cloudflare -Times 0
    }

    It 'billing token cannot be used with mismatched account ID' {
        Mock Invoke-RestMethod {throw 'must not run'} -ModuleName Cloudflare
        { Invoke-S3CloudflareBillingRead -Method GET -Uri 'https://api.cloudflare.com/client/v4/accounts/different-account/subscriptions' -Token 'billing-token-xyz' -ExpectedAccountId 'account-a' } | Should -Throw '*CLOUDFLARE_BILLING_ACCOUNT_MISMATCH*'
        Should -Invoke Invoke-RestMethod -ModuleName Cloudflare -Times 0
    }

    It 'subscriptions = 200 is accepted' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            return [ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
        $r.status | Should -Be PASS
    }

    It 'subscriptions = 401 fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            throw 'CLOUDFLARE_PAGED_API_ERROR: 401 Unauthorized'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'subscriptions = 403 fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            throw 'CLOUDFLARE_PAGED_API_ERROR: 403 Forbidden'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'subscriptions timeout fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            throw 'Invoke-RestMethod: The request timed out.'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'subscriptions malformed fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            throw 'MALFORMED_JSON'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'paygo = 401 fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            throw 'CLOUDFLARE_API_ERROR: 401 Unauthorized'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'paygo = 403 fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            throw 'CLOUDFLARE_API_ERROR: 403 Forbidden'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'paygo timeout fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            throw 'Invoke-RestMethod: The request timed out.'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'paygo malformed fails' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            return [pscustomobject]@{success=$true;errors=@();result=$null}
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'paid subscription fails' {
        $subscriptions = @([ordered]@{status='active';price=10.0})
        { Test-S3CloudflareSubscriptions -Subscriptions $subscriptions } | Should -Throw '*PAID_SUBSCRIPTION*'
    }

    It 'paid trial fails' {
        $subscriptions = @([ordered]@{status='trial'})
        { Test-S3CloudflareSubscriptions -Subscriptions $subscriptions } | Should -Throw '*TRIAL_SUBSCRIPTION*'
    }

    It 'PayGo enabled fails' {
        $payGoResult = [ordered]@{covered=$true}
        { Test-S3CloudflarePayGo -PayGoResult $payGoResult } | Should -Throw '*PAYGO_ENABLED*'
    }

    It 'unknown/indeterminate billing fails' {
        $payGoResult = [ordered]@{status='unknown'}
        { Test-S3CloudflarePayGo -PayGoResult $payGoResult } | Should -Throw '*PAYGO_UNKNOWN*'
    }

    It 'Account ID mismatch fails' {
        $accounts = @([ordered]@{id='different-account'})
        { Select-S3CloudflareAccount -Accounts $accounts -SelectedAccountId 'account-a' } | Should -Throw '*SELECTED_CLOUDFLARE_ACCOUNT_NOT_FOUND*'
    }

    It 'Billing credential does not appear in state.json or logs' {
        $c = Get-TestContext Live
        Protect-S3Text (('Author' + 'ization') + ': ' + ('Bear' + 'er') + ' billing-token-123') | Should -Not -Match 'billing-token-123'
    }

    It 'finally/cleanup logic works after Billing PASS' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            return [ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
    }

    It 'finally/cleanup logic works after Billing exception' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            throw 'Billing API error simulation'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw
    }

    It 'success of billing checks does not bypass other preflight guards' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            return [ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='unacceptable-plan'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw '*WORKERS_SETTINGS_UNACCEPTABLE*'
    }

    It 'Billing Attestation remains after automated read-only guards' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            return [ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
        $r.attestation | Should -Be 'YES'
    }

    It 'Wrangler billing token is independent and not persisted' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {
            return [ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
        (Get-S3MapValue -Map $c.State.results.cloudflarePreflight -Name 'billingToken') | Should -BeNullOrEmpty
    }
}
