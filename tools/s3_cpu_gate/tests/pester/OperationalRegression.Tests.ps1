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
 It 'uses the current schema and blocks unauthorized Workers Observability' {Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token,$Body);[void]$Uri;[void]$Token;$Method|Should -Be POST;$Body.queryId|Should -Be 's3cpu-preflight';$Body.timeframe.from|Should -BeOfType [long];$Body.timeframe.to|Should -BeGreaterThan $Body.timeframe.from;$Body.dry|Should -BeTrue;$Body.parameters.filterCombination|Should -Be 'and';$Body.PSObject.Properties.Name|Should -Not -Contain 'fields';$Body.PSObject.Properties.Name|Should -Not -Contain 'filters';throw '403 forbidden'} -ModuleName Cloudflare;{Test-S3WorkersObservabilityAuthorization -AccountId account -Token token}|Should -Throw}
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
  Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
  Mock Invoke-S3CloudflareBillingRead {[pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}} -ModuleName Cloudflare
  Mock Invoke-RestMethod {
      throw 'UNEXPECTED_NETWORK_CALL'
  } -ModuleName Cloudflare
  Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
  Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare
  $r=Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token token -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' -ObservabilityToken 'observability-token-xyz'
  $r.status|Should -Be PASS;$r.attestation|Should -Be YES;$c.State.resources.Count|Should -Be 0
  Should -Invoke Test-S3WorkersObservabilityAuthorization -ModuleName Cloudflare -Times 1 -Exactly
  Should -Invoke Get-S3CloudflareAccounts -ModuleName Cloudflare -Times 0 -Exactly
  Should -Invoke Invoke-RestMethod -ModuleName Cloudflare -Times 0 -Exactly
 }
}

Describe 'S3 Billing Read Preflight Isolation and Bounds' -Tag 'B5' {
    BeforeEach {
        $env:S3_CLOUDFLARE_BILLING_READ_TOKEN = $null
        $env:S3_CLOUDFLARE_OBSERVABILITY_WRITE_TOKEN = 'test-observability-token'
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

    It 'temporary Billing and Observability environment variables are immediately wiped after acquisition' {
        $c = Get-TestContext Live
        $env:S3_CLOUDFLARE_BILLING_READ_TOKEN = 'secret-token-123'
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {[ordered]@{status='PASS';items=@();pagesRead=@(1);paginationComplete=$true}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {[pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled'}}} -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method,$Uri)
            [void]$Method
            if($Uri -match 'account-settings'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}}}
            elseif($Uri -match 'subdomain'){[pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}}}
            else{[pscustomobject]@{success=$true;errors=@();result=@()}}
        } -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        [void](Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage)
        $env:S3_CLOUDFLARE_BILLING_READ_TOKEN | Should -BeNullOrEmpty
        $env:S3_CLOUDFLARE_OBSERVABILITY_WRITE_TOKEN | Should -BeNullOrEmpty
    }

    It 'billing, OAuth, and Observability credentials remain isolated by endpoint' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingPagedGet {throw 'subscriptions must not use pagination'} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            param($Method, $Uri, $Token, $ExpectedAccountId)
            [void]$Method
            $Token | Should -Be 'billing-token-xyz'
            $ExpectedAccountId | Should -Be 'account-a'
            if ($Uri -match '/subscriptions$') { return [pscustomobject]@{success=$true;errors=@();result=@()} }
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            [void]$Method
            $Token | Should -Be 'oauth-token-123'
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {param($AccountId,$Token);$AccountId|Should -Be 'account-a';$Token|Should -Be 'observability-token-xyz';[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' -ObservabilityToken 'observability-token-xyz'
        $r.status | Should -Be PASS
        (Get-S3MapValue -Map $c.RuntimeSecrets -Name 'cloudflareObservabilityToken') | Should -Be 'observability-token-xyz'
        (Get-S3MapValue -Map $c.State.results.cloudflarePreflight -Name 'observabilityToken') | Should -BeNullOrEmpty
        Should -Invoke Invoke-S3CloudflareBillingPagedGet -ModuleName Cloudflare -Times 0 -Exactly
        Should -Invoke Invoke-S3CloudflareBillingRead -ModuleName Cloudflare -ParameterFilter {$Uri -match '/subscriptions$'} -Times 1 -Exactly
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
        Mock Invoke-S3CloudflareBillingPagedGet {throw 'subscriptions must not use pagination'} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            param($Uri)
            if ($Uri -match '/subscriptions$') { return [pscustomobject]@{success=$true;errors=@();result=@();result_info=[ordered]@{count=0;page=1;per_page=20;total_count=0}} }
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri, $Token)
            [void]$Method
            [void]$Token
            if ($Uri -match 'account-settings') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}} }
            if ($Uri -match 'subdomain') { return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{subdomain='example';enabled=$true}} }
            return [pscustomobject]@{success=$true;errors=@();result=@()}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {param($Subscriptions);$Subscriptions.Count|Should -Be 0;[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersObservabilityAuthorization {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3WorkersDevSubdomain {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Show-S3CloudflarePreflightRecord {'mock.json'} -ModuleName Cloudflare

        $r = Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz'
        $r.status | Should -Be PASS
        Should -Invoke Invoke-S3CloudflareBillingPagedGet -ModuleName Cloudflare -Times 0 -Exactly
        Should -Invoke Invoke-S3CloudflareBillingRead -ModuleName Cloudflare -ParameterFilter {$Uri -match '/subscriptions$' -and $Uri -notmatch 'page=|per_page='} -Times 1 -Exactly
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
            [void]$Method
            [void]$Token
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

        [void](Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz')
    }

    It 'missing Observability credential fails closed after the other read-only guards pass' {
        $c = Get-TestContext Live
        Mock Test-S3CloudflareSession {[ordered]@{status='PASS';accounts=[ordered]@{status='PASS';items=@([ordered]@{id='account-a'});pagesRead=@(1);paginationComplete=$true}}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareBillingRead {
            param($Uri)
            if ($Uri -match '/subscriptions$') { return [pscustomobject]@{success=$true;errors=@();result=@()} }
            return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{status='disabled';covered=$false;subscriptions=@()}}
        } -ModuleName Cloudflare
        Mock Test-S3CloudflareSubscriptions {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Test-S3CloudflarePayGo {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        Mock Invoke-S3CloudflareRest {param($Uri);if($Uri -match 'account-settings'){return [pscustomobject]@{success=$true;errors=@();result=[ordered]@{default_usage_model='bundled'}}};return [pscustomobject]@{success=$true;errors=@();result=@()}} -ModuleName Cloudflare
        Mock Test-S3WorkersAccountSettings {[ordered]@{status='PASS'}} -ModuleName Cloudflare
        $env:S3_CLOUDFLARE_OBSERVABILITY_WRITE_TOKEN = $null
        { Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz' } | Should -Throw '*MANUAL_ACTION_REQUIRED_OBSERVABILITY_WRITE_TOKEN*'
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
            [void]$Method
            [void]$Token
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
            [void]$Method
            [void]$Token
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
            [void]$Method
            [void]$Token
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

        [void](Invoke-S3CloudflareReadOnlyPreflight -Context $c -SelectedAccountId account-a -Token 'oauth-token-123' -TokenType oauth -AttestationChoice {'1'} -SkipOpenBillingPage -BillingToken 'billing-token-xyz')
        (Get-S3MapValue -Map $c.State.results.cloudflarePreflight -Name 'billingToken') | Should -BeNullOrEmpty
    }
}

Describe 'S3 Cloudflare paged get regression and D1 support' -Tag 'B5' {
    It '1. D1 empty result without total_pages terminates immediately after page 1' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @()
                result_info = [ordered]@{ count = 0; page = 1; per_page = 50; total_count = 0 }
            }
        } -ModuleName Cloudflare
        $res = Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token'
        $res.status | Should -Be 'PASS'
        $res.items.Count | Should -Be 0
        $res.pagesRead | Should -Be @(1)
        $res.paginationComplete | Should -BeTrue
    }

    It '2. D1 single-page non-empty result without total_pages' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @(1..5 | ForEach-Object { [ordered]@{ id = "db$_" } })
                result_info = [ordered]@{ count = 5; page = 1; per_page = 50; total_count = 5 }
            }
        } -ModuleName Cloudflare
        $res = Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token'
        $res.status | Should -Be 'PASS'
        $res.items.Count | Should -Be 5
        $res.pagesRead | Should -Be @(1)
    }

    It '3. D1 multi-page result without total_pages' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..50 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 1; per_page = 50; total_count = 105 }
                }
            }
            if ($Uri -match 'page=2') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(51..100 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 2; per_page = 50; total_count = 105 }
                }
            }
            if ($Uri -match 'page=3') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(101..105 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 5; page = 3; per_page = 50; total_count = 105 }
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        $res = Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token'
        $res.status | Should -Be 'PASS'
        $res.items.Count | Should -Be 105
        $res.pagesRead | Should -Be @(1, 2, 3)
    }

    It '4. Existing valid response containing total_pages (Path A)' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @([ordered]@{ id = 'acc-1' })
                result_info = [ordered]@{ page = 1; total_pages = 1 }
            }
        } -ModuleName Cloudflare
        $res = Get-S3CloudflareAccounts -Token 'token'
        $res.status | Should -Be 'PASS'
        $res.items.Count | Should -Be 1
    }

    It '5. Contradictory pagination metadata must fail' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @(1..50 | ForEach-Object { [ordered]@{ id = "item$_" } })
                result_info = [ordered]@{ page = 1; total_pages = 1; per_page = 50; total_count = 105 }
            }
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts' -Token 'token' } | Should -Throw '*PAGINATION_CONTRADICTION*'
    }

    It '6. Missing completion metadata must fail when total_pages is absent' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @([ordered]@{ id = 'item1' })
                result_info = [ordered]@{ page = 1; total_count = 1 }
            }
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts' -Token 'token' } | Should -Throw '*PAGINATION_METADATA_INCOMPLETE*'
    }

    It '7. Intermediate-page completeness must be enforced' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..30 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 30; page = 1; per_page = 50; total_count = 80 }
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_INTERMEDIATE_PAGE_INCOMPLETE*'
    }

    It '8. Exact cumulative count on terminal page must be validated' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..50 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 1; per_page = 50; total_count = 80 }
                }
            }
            if ($Uri -match 'page=2') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(51..79 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 29; page = 2; per_page = 50; total_count = 80 }
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_TOTAL_COUNT_MISMATCH*'
    }

    It '9. Requested page differs from returned page fails' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @([ordered]@{ id = 'db1' })
                result_info = [ordered]@{ page = 2; per_page = 50; total_count = 1 }
            }
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_PAGE_MISMATCH*'
    }

    It '10. result.Count > per_page fails' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @(1..55 | ForEach-Object { [ordered]@{ id = "db$_" } })
                result_info = [ordered]@{ page = 1; per_page = 50; total_count = 55 }
            }
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_RESULT_COUNT_EXCEEDED*'
    }

    It '11. Accounts inventory regression' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @([ordered]@{ id = 'acc-a' })
                result_info = [ordered]@{ page = 1; total_pages = 1 }
            }
        } -ModuleName Cloudflare
        $acc = Get-S3CloudflareAccounts -Token 'token'
        $acc.items[0].id | Should -Be 'acc-a'
    }

    It '12. Workers scripts inventory regression' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @([ordered]@{ id = 'worker-1' })
                result_info = [ordered]@{ page = 1; total_pages = 1 }
            }
        } -ModuleName Cloudflare
        $res = Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts' -Token 'token'
        $res.items[0].id | Should -Be 'worker-1'
    }

    It '13. D1 cleanup absence-proof regression' {
        Mock Invoke-S3CloudflarePagedGet {
            param($Uri)
            if ($Uri -match 'workers/scripts') {
                return [ordered]@{ status = 'PASS'; items = @([ordered]@{ id = 'other-worker' }); pagesRead = @(1); paginationComplete = $true }
            }
            if ($Uri -match 'd1/database') {
                return [ordered]@{ status = 'PASS'; items = @(); pagesRead = @(1); paginationComplete = $true }
            }
            throw "Unexpected $Uri"
        } -ModuleName Cloudflare
        $proof = Get-S3CloudflareResourceAbsenceProof -AccountId 'acc' -Token 'token' -Worker 's3cpu-test-worker' -D1Name 's3cpu-test-d1' -D1Id 'd1-uuid-123'
        $proof.workerAbsent | Should -BeTrue
        $proof.d1Absent | Should -BeTrue
    }

    It '14. result_info.count equals result.Count passes' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @(1..5 | ForEach-Object { [ordered]@{ id = "db$_" } })
                result_info = [ordered]@{ count = 5; page = 1; per_page = 50; total_count = 5 }
            }
        } -ModuleName Cloudflare
        $res = Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token'
        $res.status | Should -Be 'PASS'
    }

    It '15. result_info.count differs from result.Count fails closed' {
        Mock Invoke-S3CloudflareRest {
            [pscustomobject]@{
                success = $true
                errors = @()
                result = @(1..5 | ForEach-Object { [ordered]@{ id = "db$_" } })
                result_info = [ordered]@{ count = 10; page = 1; per_page = 50; total_count = 5 }
            }
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_COUNT_MISMATCH*'
    }

    It '16. D1 total_count changes between page 1 and page 2 fails closed' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..50 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 1; per_page = 50; total_count = 100 }
                }
            }
            if ($Uri -match 'page=2') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(51..100 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 2; per_page = 50; total_count = 120 }
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_METADATA_DRIFT*'
    }

    It '17. D1 per_page changes between page 1 and page 2 fails closed' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..50 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 1; per_page = 50; total_count = 100 }
                }
            }
            if ($Uri -match 'page=2') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(51..100 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 2; per_page = 25; total_count = 100 }
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token' } | Should -Throw '*PAGINATION_METADATA_DRIFT*'
    }

    It '18. total_pages changes between page 1 and page 2 fails closed' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..50 | ForEach-Object { [ordered]@{ id = "item$_" } })
                    result_info = [ordered]@{ page = 1; total_pages = 2 }
                }
            }
            if ($Uri -match 'page=2') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(51..60 | ForEach-Object { [ordered]@{ id = "item$_" } })
                    result_info = [ordered]@{ page = 2; total_pages = 3 }
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        { Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts' -Token 'token' } | Should -Throw '*PAGINATION_METADATA_DRIFT*'
    }

    It '19. missing result_info after pagination continuation fails closed' {
        Mock Invoke-S3CloudflareRest {
            param($Method, $Uri)
            [void]$Method
            if ($Uri -match 'page=1') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @(1..50 | ForEach-Object { [ordered]@{ id = "db$_" } })
                    result_info = [ordered]@{ count = 50; page = 1; per_page = 50; total_count = 100 }
                }
            }
            if ($Uri -match 'page=2') {
                return [pscustomobject]@{
                    success = $true
                    errors = @()
                    result = @([ordered]@{ id = 'db51' })
                }
            }
            throw "Unexpected URI $Uri"
        } -ModuleName Cloudflare
        $result = $null
        $caught = $null
        try {
            $result = Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database' -Token 'token'
        }
        catch {
            $caught = $_
        }
        $caught.Exception.Message | Should -Match 'PAGINATION_METADATA_MISSING'
        $result | Should -BeNullOrEmpty
    }
}

Describe 'S3 recovery safety hardening' -Tag 'RecoverySafety' {
    It 'persists the D1 pending intent before invoking d1 create' {
        $source = Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw
        $pending = $source.IndexOf("provisioningStatus='D1_CREATE_PENDING'")
        $create = $source.IndexOf("'d1','create'")
        $pending | Should -BeGreaterThan -1
        $pending | Should -BeLessThan $create
        $source.IndexOf('Write-S3State -Root $Context.Root -State $Context.State',$pending) | Should -BeGreaterThan $pending
    }

    It 'never invokes D1 create when the pending-state write fails' {
        $c = Get-TestContext Live
        $c.State.results.cloudflarePreflight = [ordered]@{status='PASS'}
        $c.RuntimeSecrets.cloudflareToken = 'token'
        $c.RuntimeSecrets.cloudflareAccountId = 'account-a'
        Mock Assert-S3DeploymentPayloadNoSecret {} -ModuleName Cloudflare
        Mock Get-S3CloudflareD1ExactMatches { @() } -ModuleName Cloudflare
        Mock Write-S3State { throw 'STATE_WRITE_FAILED' } -ModuleName Cloudflare
        Mock Invoke-S3Process { throw 'D1_CREATE_MUST_NOT_RUN' } -ModuleName Cloudflare
        { Invoke-S3CloudflareProvision -Context $c } | Should -Throw '*STATE_WRITE_FAILED*'
        Should -Invoke Invoke-S3Process -ModuleName Cloudflare -Times 0 -Exactly
    }

    It 'persists a parseable D1 UUID before schema execution' {
        $c = Get-TestContext Live
        $c.State.results.cloudflarePreflight = [ordered]@{status='PASS'}
        $c.State.resources.firebase = [ordered]@{projectId='s3cpu-test-firebase'}
        $c.RuntimeSecrets.cloudflareToken = 'token';$c.RuntimeSecrets.cloudflareAccountId = 'account-a'
        $events = [Collections.Generic.List[string]]::new()
        Mock Assert-S3DeploymentPayloadNoSecret {} -ModuleName Cloudflare
        Mock Get-S3CloudflareD1ExactMatches { @() } -ModuleName Cloudflare
        Mock Write-S3State { [void]$events.Add('state') } -ModuleName Cloudflare
        Mock New-S3WranglerConfig { 'config.json' } -ModuleName Cloudflare
        Mock Invoke-S3Process {
            [void]$events.Add(($ArgumentList -join ' '))
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='database_id = "11111111-2222-3333-4444-555555555555"';StdErr=''} }
            throw 'STOP_AFTER_D1_STATE'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareProvision -Context $c } | Should -Throw '*STOP_AFTER_D1_STATE*'
        $events[0] | Should -Be 'state'
        $events[1] | Should -Match 'd1 create'
        $events[2] | Should -Be 'state'
        $c.State.resources.cloudflare.d1Id | Should -Be '11111111-2222-3333-4444-555555555555'
    }

    It 'recovers one exact D1 by name when create output has no UUID' {
        $c = Get-TestContext Live
        $c.State.results.cloudflarePreflight = [ordered]@{status='PASS'}
        $c.State.resources.firebase = [ordered]@{projectId='s3cpu-test-firebase'}
        $c.RuntimeSecrets.cloudflareToken = 'token';$c.RuntimeSecrets.cloudflareAccountId = 'account-a'
        $lookup = [Collections.Generic.List[int]]::new()
        Mock Assert-S3DeploymentPayloadNoSecret {} -ModuleName Cloudflare
        Mock Get-S3CloudflareD1ExactMatches { [void]$lookup.Add(1); if ($lookup.Count -eq 1) { @() } else { @([ordered]@{name='s3cpu-20260803-174000-abcdef12-d1';uuid='11111111-2222-3333-4444-555555555555'}) } } -ModuleName Cloudflare
        Mock Write-S3State {} -ModuleName Cloudflare
        Mock New-S3WranglerConfig { 'config.json' } -ModuleName Cloudflare
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            throw 'STOP_AFTER_RECOVERY'
        } -ModuleName Cloudflare
        { Invoke-S3CloudflareProvision -Context $c } | Should -Throw '*STOP_AFTER_RECOVERY*'
        $c.State.resources.cloudflare.d1Id | Should -Be '11111111-2222-3333-4444-555555555555'
        $lookup.Count | Should -Be 2
    }

    It 'does not invent D1 ownership when exact recovery finds zero matches' {
        $c = Get-TestContext Live
        $c.State.results.cloudflarePreflight = [ordered]@{status='PASS'}
        $c.State.resources.firebase = [ordered]@{projectId='s3cpu-test-firebase'}
        $c.RuntimeSecrets.cloudflareToken = 'token';$c.RuntimeSecrets.cloudflareAccountId = 'account-a'
        Mock Assert-S3DeploymentPayloadNoSecret {} -ModuleName Cloudflare
        Mock Get-S3CloudflareD1ExactMatches { @() } -ModuleName Cloudflare
        Mock Write-S3State {} -ModuleName Cloudflare
        Mock Invoke-S3Process { [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} } -ModuleName Cloudflare
        { Invoke-S3CloudflareProvision -Context $c } | Should -Throw '*D1_CREATE_RESULT_UNRECOVERABLE*'
        $c.State.resources.cloudflare.d1Id | Should -BeNullOrEmpty
    }

    It 'fails closed when exact D1 recovery is ambiguous' {
        $c = Get-TestContext Live
        $c.State.results.cloudflarePreflight = [ordered]@{status='PASS'}
        $c.State.resources.firebase = [ordered]@{projectId='s3cpu-test-firebase'}
        $c.RuntimeSecrets.cloudflareToken = 'token';$c.RuntimeSecrets.cloudflareAccountId = 'account-a'
        $lookup = [Collections.Generic.List[int]]::new()
        Mock Assert-S3DeploymentPayloadNoSecret {} -ModuleName Cloudflare
        Mock Get-S3CloudflareD1ExactMatches { [void]$lookup.Add(1); if ($lookup.Count -eq 1) { @() } else { @([ordered]@{name='same';uuid='one'},[ordered]@{name='same';uuid='two'}) } } -ModuleName Cloudflare
        Mock Write-S3State {} -ModuleName Cloudflare
        Mock Invoke-S3Process { [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} } -ModuleName Cloudflare
        { Invoke-S3CloudflareProvision -Context $c } | Should -Throw '*D1_EXACT_NAME_AMBIGUOUS*'
        $c.State.resources.cloudflare.d1Id | Should -BeNullOrEmpty
    }

    It 'recovers a pending D1 by one exact name match during cleanup preparation' {
        $c = Get-TestContext Live
        $resource = [ordered]@{accountId='account-a';worker="$($c.RunId)-worker";d1Name="$($c.RunId)-d1";d1Id=$null;marker=$c.RunId;provisioningStatus='D1_CREATE_PENDING';preCreateAbsence='PASS'}
        Mock Get-S3CloudflareD1ExactMatches { @([ordered]@{name=$resource.d1Name;uuid='11111111-2222-3333-4444-555555555555'}) } -ModuleName Cloudflare
        Mock Write-S3State {} -ModuleName Cloudflare
        $result = Resolve-S3CloudflarePendingD1 -Context $c -Resource $resource -Token 'token'
        $result.status | Should -Be 'RECOVERED'
        $resource.d1Id | Should -Be '11111111-2222-3333-4444-555555555555'
    }

    It 'treats a pending D1 with no exact match as already absent' {
        $c = Get-TestContext Live
        $resource = [ordered]@{accountId='account-a';worker="$($c.RunId)-worker";d1Name="$($c.RunId)-d1";d1Id=$null;marker=$c.RunId;provisioningStatus='D1_CREATE_PENDING';preCreateAbsence='PASS'}
        Mock Get-S3CloudflareD1ExactMatches { @() } -ModuleName Cloudflare
        Mock Write-S3State {} -ModuleName Cloudflare
        $result = Resolve-S3CloudflarePendingD1 -Context $c -Resource $resource -Token 'token'
        $result.status | Should -Be 'ABSENT'
        $resource.provisioningStatus | Should -Be 'D1_ABSENT'
    }

    It 'fails closed when pending D1 recovery returns multiple exact matches' {
        $c = Get-TestContext Live
        $resource = [ordered]@{accountId='account-a';worker="$($c.RunId)-worker";d1Name="$($c.RunId)-d1";d1Id=$null;marker=$c.RunId;provisioningStatus='D1_CREATE_PENDING';preCreateAbsence='PASS'}
        Mock Get-S3CloudflareD1ExactMatches { @([ordered]@{name=$resource.d1Name;uuid='one'},[ordered]@{name=$resource.d1Name;uuid='two'}) } -ModuleName Cloudflare
        { Resolve-S3CloudflarePendingD1 -Context $c -Resource $resource -Token 'token' } | Should -Throw '*D1_EXACT_NAME_AMBIGUOUS*'
    }

    It 'makes cleanup idempotent when the exact owned Worker and D1 are already absent' {
        $c = Get-TestContext Live
        $resource = [ordered]@{accountId='account-a';worker="$($c.RunId)-worker";d1Name="$($c.RunId)-d1";d1Id='11111111-2222-3333-4444-555555555555';marker=$c.RunId;provisioningStatus='D1_CREATED'}
        $c.State.resources.cloudflare = $resource;$c.RuntimeSecrets.cloudflareToken='token';$c.RuntimeSecrets.cloudflareAccountId='account-a'
        Mock Get-S3CloudflareResourceAbsenceProof { [ordered]@{workerAbsent=$true;d1Absent=$true} } -ModuleName Cloudflare
        Mock Invoke-S3Process { throw 'DELETE_MUST_NOT_RUN' } -ModuleName Cloudflare
        Mock Write-S3State {} -ModuleName Cloudflare
        $result = Remove-S3CloudflareResource -Context $c
        $result.status | Should -Be 'DELETED'
        Should -Invoke Invoke-S3Process -ModuleName Cloudflare -Times 0 -Exactly
    }

    It 'rejects the persistent workers.dev subdomain as a cleanup target' {
        $c = Get-TestContext Live
        $resource = [ordered]@{accountId='account-a';worker='s3cpu-be239c6980';d1Name="$($c.RunId)-d1";d1Id='11111111-2222-3333-4444-555555555555';marker=$c.RunId;provisioningStatus='D1_CREATED'}
        { Test-S3CloudflareCleanupOwnership -Context $c -Resource $resource } | Should -Throw
    }

    It 'does not place secrets in a pending resource state' {
        $c = Get-TestContext Live
        $c.State.resources.cloudflare = [ordered]@{accountId='account-a';worker="$($c.RunId)-worker";d1Name="$($c.RunId)-d1";d1Id=$null;marker=$c.RunId;provisioningStatus='D1_CREATE_PENDING';preCreateAbsence='PASS'}
        $json = $c.State | ConvertTo-Json -Depth 20
        $json | Should -Not -Match '(?i)token|password|refreshToken|idToken|accessToken|apiKey|authorization'
    }

    It 'persists Firebase project intent before projects:create' {
        $source = Get-Content (Join-Path $SourceRoot 'src\modules\Firebase.psm1') -Raw
        $pending = $source.IndexOf("provisioningStatus='PROJECT_CREATE_PENDING'")
        $create = $source.IndexOf("'projects:create'")
        $pending | Should -BeGreaterThan -1
        $pending | Should -BeLessThan $create
        $source.IndexOf('Write-S3State -Root $Context.Root -State $Context.State',$pending) | Should -BeGreaterThan $pending
    }

    It 'preserves a Firebase projects:create stdout diagnostic when stderr is empty' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut='FIREBASE_STDOUT_DIAGNOSTIC';StdErr=''}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED*FIREBASE_STDOUT_DIAGNOSTIC*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 1 -Exactly
    }

    It 'preserves a Firebase projects:create stderr diagnostic' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut='';StdErr='FIREBASE_STDERR_DIAGNOSTIC'}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED*FIREBASE_STDERR_DIAGNOSTIC*'
    }

    It 'reports a deterministic failure when Firebase projects:create has no diagnostic' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut='';StdErr=''}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED_NO_DIAGNOSTIC*'
    }

    It 'redacts sensitive-looking Firebase projects:create diagnostics before surfacing them' {
        $c = Get-TestContext Live
        $syntheticPassword = 'synthetic' + '-password'
        $syntheticToken = 'synthetic' + '-access' + '-token'
        $diagnostic = 'password=' + $syntheticPassword + ', accessToken=' + $syntheticToken
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut=$diagnostic;StdErr=''}
        } -ModuleName Firebase
        $message = try { Invoke-S3FirebaseProvision -Context $c } catch { $_.Exception.Message }
        $message | Should -Not -Match [regex]::Escape($syntheticPassword)
        $message | Should -Not -Match [regex]::Escape($syntheticToken)
        $message | Should -Match '\[REDACTED\]'
    }

    It 'continues normally after a successful Firebase projects:create result' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'projects:create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            throw 'STOP_AFTER_PROJECT_CREATE'
        } -ModuleName Firebase
        Mock Assert-S3GoogleNoBilling { throw 'STOP_AFTER_PROJECT_CREATE' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*STOP_AFTER_PROJECT_CREATE*'
        $c.State.resources.firebase.provisioningStatus | Should -Be 'PROJECT_CREATED'
        Should -Invoke Assert-S3GoogleNoBilling -ModuleName Firebase -Times 1 -Exactly
    }

    It 'treats permission denied may-not-exist as unknown Firebase project presence' {
        $c = Get-TestContext Live
        Mock Invoke-S3Process { [pscustomobject]@{ExitCode=1;StdOut='';StdErr='PERMISSION_DENIED: Permission denied on resource (or it may not exist).'} } -ModuleName Firebase
        Get-S3FirebaseProjectPresence -Context $c -ProjectId 's3cpu-test' | Should -Be 'UNKNOWN'
    }

    It 'treats explicit Firebase project not found as absent' {
        $c = Get-TestContext Live
        Mock Invoke-S3Process { [pscustomobject]@{ExitCode=1;StdOut='';StdErr='NOT_FOUND: Requested entity was not found.'} } -ModuleName Firebase
        Get-S3FirebaseProjectPresence -Context $c -ProjectId 's3cpu-test' | Should -Be 'ABSENT'
    }

    It 'does not permit Firebase project creation after ambiguous permission failure' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'FIREBASE_CREATE_MUST_NOT_RUN' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_ABSENCE_UNVERIFIABLE*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'does not mark Firebase cleanup already absent after ambiguous permission failure' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $c.State.resources.firebase = [ordered]@{projectId="s3cpu-$suffix";marker=$c.RunId;provisioningStatus='PROJECT_CREATE_PENDING';preCreateAbsence='PASS'}
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'FIREBASE_DELETE_MUST_NOT_RUN' } -ModuleName Firebase
        { Remove-S3FirebaseProject -Context $c } | Should -Throw '*FIREBASE_PROJECT_PRESENCE_UNVERIFIABLE*'
        $c.State.resources.firebase.cleanupStatus | Should -BeNullOrEmpty
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'never invokes Firebase project creation when the intent write fails' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State { throw 'STATE_WRITE_FAILED' } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'FIREBASE_CREATE_MUST_NOT_RUN' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*STATE_WRITE_FAILED*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'persists PROJECT_CREATED before Firebase child provisioning' {
        $c = Get-TestContext Live
        $events = [Collections.Generic.List[string]]::new()
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State { [void]$events.Add('state') } -ModuleName Firebase
        Mock Invoke-S3Process {
            [void]$events.Add(($ArgumentList -join ' '))
            if ($ArgumentList -contains 'projects:create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            throw 'STOP_AFTER_PROJECT_STATE'
        } -ModuleName Firebase
        Mock Assert-S3GoogleNoBilling { throw 'STOP_AFTER_PROJECT_STATE' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*STOP_AFTER_PROJECT_STATE*'
        $events[0] | Should -Be 'state'
        $events[1] | Should -Match 'projects:create'
        $events[2] | Should -Be 'state'
        $c.State.resources.firebase.provisioningStatus | Should -Be 'PROJECT_CREATED'
    }

    It 'treats a pending Firebase project proven absent as idempotent cleanup' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $resource = [ordered]@{projectId="s3cpu-$suffix";marker=$c.RunId;provisioningStatus='PROJECT_CREATE_PENDING';preCreateAbsence='PASS'}
        $c.State.resources.firebase = $resource
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process { throw 'DELETE_MUST_NOT_RUN' } -ModuleName Firebase
        $result = Remove-S3FirebaseProject -Context $c
        $result.status | Should -Be 'ALREADY_ABSENT'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'cleans a pending exact Firebase project only with valid intent ownership' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $resource = [ordered]@{projectId="s3cpu-$suffix";marker=$c.RunId;provisioningStatus='PROJECT_CREATE_PENDING';preCreateAbsence='PASS'}
        $c.State.resources.firebase = $resource
        Mock Get-S3FirebaseProjectPresence { 'EXISTS' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'delete') { return [pscustomobject]@{ExitCode=0;StdOut='';StdErr=''} }
            return [pscustomobject]@{ExitCode=0;StdOut='DELETE_REQUESTED';StdErr=''}
        } -ModuleName Firebase
        $result = Remove-S3FirebaseProject -Context $c
        $result.status | Should -Be 'DELETE_REQUESTED'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 2 -Exactly
    }

    It 'fails closed when Firebase pending ownership proof is missing' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $c.State.resources.firebase = [ordered]@{projectId="s3cpu-$suffix";marker=$c.RunId;provisioningStatus='PROJECT_CREATE_PENDING'}
        Mock Get-S3FirebaseProjectPresence { 'EXISTS' } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'DELETE_MUST_NOT_RUN' } -ModuleName Firebase
        { Remove-S3FirebaseProject -Context $c } | Should -Throw '*FIREBASE_PROJECT_OWNERSHIP_PROOF_MISSING*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'keeps a Firebase project cleanup-capable after child provisioning fails' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'projects:create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            throw 'CHILD_PROVISIONING_FAILED'
        } -ModuleName Firebase
        Mock Assert-S3GoogleNoBilling { throw 'CHILD_PROVISIONING_FAILED' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*CHILD_PROVISIONING_FAILED*'
        $c.State.resources.firebase.projectId | Should -Match '^s3cpu-'
        $c.State.resources.firebase.marker | Should -Be $c.RunId
        $c.State.resources.firebase.provisioningStatus | Should -Be 'PROJECT_CREATED'
    }

    It 'does not clean pre-existing CLI sessions as owned sessions' {
        $c = Get-TestContext Live
        $c.RuntimeSecrets.ownedCliSessions = @([ordered]@{kind='gcloud-config';createdByTool=$false;cleaned=$false;configPath=(Join-Path $TestDrive 'temp\gcloud')})
        Mock Invoke-S3Process { throw 'PREEXISTING_SESSION_MUST_NOT_BE_TOUCHED' } -ModuleName Cleanup
        $result = Invoke-S3OwnedCliSessionCleanup -Context $c
        $result.status | Should -Be 'PASS'
        $result.cleaned | Should -Be 0
        Should -Invoke Invoke-S3Process -ModuleName Cleanup -Times 0 -Exactly
    }
}
