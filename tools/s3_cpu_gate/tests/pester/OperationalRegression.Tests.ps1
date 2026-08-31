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
 It 'proves an exact custom-domain Worker binding with an issued certificate' {
  Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token);$Method|Should -Be 'GET';$Token|Should -Be 'token';$Uri|Should -Be 'https://api.cloudflare.com/client/v4/accounts/account-a/workers/domains?hostname=app.assagwork.com&service=worker-a';[pscustomobject]@{success=$true;errors=@();result=@([ordered]@{hostname='app.assagwork.com';service='worker-a';zone_id='zone-a';zone_name='assagwork.com';cert_id='cert-a'})}} -ModuleName Cloudflare
  $result=Assert-S3CloudflareCustomDomainBinding -AccountId account-a -Token token -WorkerName worker-a -PublicBaseUri 'https://app.assagwork.com'
  $result.status|Should -Be 'PASS';$result.hostname|Should -Be 'app.assagwork.com';$result.certificateIssued|Should -BeTrue
  Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=@([ordered]@{hostname='app.assagwork.com';service='worker-a';zone_id='zone-a';zone_name='assagwork.com';cert_id=''})}} -ModuleName Cloudflare
  {Assert-S3CloudflareCustomDomainBinding -AccountId account-a -Token token -WorkerName worker-a -PublicBaseUri 'https://app.assagwork.com'}|Should -Throw '*CERTIFICATE_NOT_ISSUED*'
 }
 It 'selects one correct account only when the ID is explicit' {$a=Select-S3CloudflareAccount -Accounts @([ordered]@{id='account-a'}) -SelectedAccountId account-a;$a.id|Should -Be account-a}
 It 'refuses multiple accounts without selection' {{Select-S3CloudflareAccount -Accounts @([ordered]@{id='a'},[ordered]@{id='b'})}|Should -Throw '*MULTIPLE_CLOUDFLARE_ACCOUNTS*'}
 It 'refuses an Account ID that is not listed' {{Select-S3CloudflareAccount -Accounts @([ordered]@{id='a'}) -SelectedAccountId missing}|Should -Throw '*NOT_FOUND*'}
 It 'fails incomplete account pagination' {Mock Invoke-S3CloudflareRest {[pscustomobject]@{success=$true;errors=@();result=@(1..50|ForEach-Object{[ordered]@{id="a$_"}})}} -ModuleName Cloudflare;{Get-S3CloudflareAccounts -Token token}|Should -Throw '*PAGINATION_METADATA_MISSING*'}
 It 'blocks a paid subscription' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='active';price=5})}|Should -Throw '*PAID_SUBSCRIPTION*'}
 It 'blocks a Trial subscription' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='trial'})}|Should -Throw '*TRIAL_SUBSCRIPTION*'}
 It 'blocks AwaitingPayment' {{Test-S3CloudflareSubscriptions -Subscriptions @([ordered]@{status='AwaitingPayment'})}|Should -Throw '*AWAITING_PAYMENT*'}
 It 'blocks an inconclusive Alpha PayGo result' {{Test-S3CloudflarePayGo -PayGoResult ([ordered]@{alpha=$true;status='alpha'})}|Should -Throw '*PAYGO_UNKNOWN*'}
 It 'blocks unknown Workers settings' {{Test-S3WorkersAccountSettings -Settings ([ordered]@{})}|Should -Throw '*WORKERS_SETTINGS_UNKNOWN*'}
 It 'uses the current schema and blocks unauthorized Workers Observability' {Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token,$Body);[void]$Uri;[void]$Token;$Method|Should -Be POST;$Body.queryId|Should -Be 's3cpu-preflight';$Body.timeframe.from|Should -BeOfType [long];$Body.timeframe.to|Should -BeGreaterThan $Body.timeframe.from;$Body.dry|Should -BeTrue;$Body.parameters.filterCombination|Should -Be 'and';$Body.parameters.filters.Count|Should -Be 1;$Body.parameters.filters[0].key|Should -Be '$metadata.service';$Body.parameters.filters[0].operation|Should -Be 'eq';$Body.parameters.filters[0].type|Should -Be 'string';$Body.parameters.filters[0].value|Should -Be 'worker-s3';$Body.PSObject.Properties.Name|Should -Not -Contain 'fields';throw '403 forbidden'} -ModuleName Cloudflare;{Test-S3WorkersObservabilityAuthorization -AccountId account -Token token -WorkerName worker-s3}|Should -Throw}
 It 'blocks a missing workers.dev subdomain' {{Test-S3WorkersDevSubdomain -SubdomainResult ([ordered]@{subdomain='';enabled=$false})}|Should -Throw '*WORKERS_DEV_SUBDOMAIN_UNAVAILABLE*'}
 It 'stops when the user cancels the Arabic attestation' {$r=Confirm-S3CloudflareBillingAttestation -ReadChoice {'2'};$r.status|Should -Be CANCELLED;$r.accepted|Should -BeFalse}
 It 'accepts only the affirmative Arabic attestation' {$r=Confirm-S3CloudflareBillingAttestation -ReadChoice {'1'};$r.status|Should -Be YES;$r.accepted|Should -BeTrue}
 It 'uses exact non-interactive restore and cleanup flags' {
  $orchestrator=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw;$cloudflare=Get-Content (Join-Path $SourceRoot 'src\modules\Cloudflare.psm1') -Raw;$cpu=Get-Content (Join-Path $SourceRoot 'src\modules\CpuGate.psm1') -Raw
  $orchestrator.Contains("@('versions','deploy',`$versionId,'--name',`$workerName,'--yes')")|Should -BeTrue;$cloudflare.Contains("'d1','delete',`$owned.d1Name,'--skip-confirmation'")|Should -BeTrue;$cloudflare.Contains("'delete','--name',`$owned.worker")|Should -BeTrue;$cloudflare.Contains("'delete',`$owned.worker,'--force'")|Should -BeFalse;$cpu.Contains('x-s3-force-certificate-refresh')|Should -BeTrue;$cpu.Contains('__test/reset-cache')|Should -BeFalse
 }
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
    It 'keeps Firebase display names deterministic, readable, and within the provider limit' {
        $current = Get-S3FirebaseProjectDisplayName -RunId 's3cpu-20260811-143004-3deecdda'
        $future = Get-S3FirebaseProjectDisplayName -RunId ('s3cpu-' + ('future-segment-' * 20) + 'abcdef12')
        $current | Should -Be (Get-S3FirebaseProjectDisplayName -RunId 's3cpu-20260811-143004-3deecdda')
        $current | Should -BeLike 'S3 CPU *'
        $current.Length | Should -BeLessOrEqual 30
        $future | Should -BeLike 'S3 CPU *abcdef12'
        $future.Length | Should -BeLessOrEqual 30
    }

    It 'passes a provider-safe display name to isolated GCP project create' {
        $c = Get-TestContext Live
        $captured = [Collections.Generic.List[object]]::new()
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [void]$captured.Add(@($ArgumentList))
            [pscustomobject]@{ExitCode=1;StdOut='EXPECTED_STOP';StdErr=''}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*EXPECTED_STOP*'
        $arguments = @($captured[0])
        $displayIndex = [Array]::IndexOf($arguments,'--name')
        $displayIndex | Should -BeGreaterThan -1
        ([string]$arguments[$displayIndex + 1]).Length | Should -BeLessOrEqual 30
    }

    It 'accepts only an expected provider rejection as proof that third signup is disabled' {
        Mock Invoke-RestMethod { throw 'OPERATION_NOT_ALLOWED: signup disabled' } -ModuleName Firebase
        $proof = Assert-S3FirebaseThirdSignupRejected -ApiKey 'synthetic-api-key'
        $proof.status | Should -Be 'PASS'
        $proof.rejected | Should -BeTrue
    }

    It 'fails closed if Firebase accepts a third public signup' {
        Mock Invoke-RestMethod { [pscustomobject]@{localId='unexpected-third'} } -ModuleName Firebase
        { Assert-S3FirebaseThirdSignupRejected -ApiKey 'synthetic-api-key' } | Should -Throw '*FIREBASE_THIRD_SIGNUP_ACCEPTED*'
    }

    It 'defines DB-generated append-only operational audit with active-actor enforcement' {
        $schema = Get-Content (Join-Path $SourceRoot 'src\worker\schema.sql') -Raw
        $schema | Should -Match 'CREATE TABLE IF NOT EXISTS audit_log'
        $schema | Should -Match 'NEW\.updated_by AND active = 1 AND run_marker = NEW\.run_marker'
        $schema | Should -Match 'AFTER INSERT ON s3_audit_probe'
        $schema | Should -Match 'AFTER UPDATE ON s3_audit_probe'
        $schema | Should -Match 'trg_audit_log_no_update'
        $schema | Should -Match 'trg_audit_log_no_delete'
    }

    It 'wires the controlled Worker mutation and live D1 audit acceptance without UI trust' {
        $worker = Get-Content (Join-Path $SourceRoot 'src\worker\src\index.js') -Raw
        $cpu = Get-Content (Join-Path $SourceRoot 'src\modules\CpuGate.psm1') -Raw
        $worker | Should -Match '/__test/audit-mutation'
        $worker | Should -Match 'env\.DB\.batch'
        $worker | Should -Match '\.bind\(entityId, valueJson, actorUid, env\.RUN_MARKER, requestId\)'
        $cpu | Should -Match 'Invoke-S3AuditAcceptance'
        $cpu | Should -Match 'AUDIT_DB_AUTHORIZATION_BYPASSED'
        $cpu | Should -Match 'AUDIT_UPDATE_TAMPER_ACCEPTED'
        $cpu | Should -Match 'AUDIT_DELETE_TAMPER_ACCEPTED'
    }

    It 'executes the live audit harness for both actors and fail-closed D1 probes' {
        $c = Get-TestContext Live
        $c.RuntimeSecrets.uid1 = 'uid-one'
        $c.RuntimeSecrets.uid2 = 'uid-two'
        $c.State.resources.cloudflare = [ordered]@{d1Name='synthetic-d1'}
        Mock Invoke-S3HttpRequest {
            $requestId = [string]$Headers['x-s3-request-id']
            $value = ($Body | ConvertFrom-Json).value
            if ($value -eq 'synthetic-denied') { return [pscustomobject]@{status=403;body='{"ok":false}'} }
            $isBefore = $value -eq 'synthetic-before'
            $audit = [ordered]@{
                action=if($isBefore){'CREATE'}else{'UPDATE'}
                actorUid=if($isBefore){'uid-one'}else{'uid-two'}
                createdAt='2026-08-11T12:00:00.000Z'
                before=if($isBefore){$null}else{[ordered]@{value='synthetic-before'}}
                after=[ordered]@{value=$value}
                runId=$c.RunId
                requestId=$RequestId
            }
            [pscustomobject]@{status=200;body=([ordered]@{ok=$true;requestId=$requestId;audit=$audit}|ConvertTo-Json -Depth 8 -Compress)}
        } -ModuleName CpuGate
        Mock Invoke-S3D1Sql {
            param($Context,$Sql,[switch]$AllowFailure,[switch]$PassThru)
            [void]$Context;[void]$Sql;[void]$AllowFailure
            if ($PassThru) { return [pscustomobject]@{ExitCode=1;StdOut='';StdErr='expected rejection'} }
        } -ModuleName CpuGate
        $result = Invoke-S3AuditAcceptance -Context $c -BaseUri 'https://synthetic.workers.dev' -Token1 'token-one' -Token2 'token-two' -Nonce 'synthetic-nonce'
        $result.status | Should -Be 'PASS'
        $result.authorizedActors | Should -Be 2
        $result.dbSide | Should -BeTrue
        $result.updateRejected | Should -BeTrue
        $result.deleteRejected | Should -BeTrue
        Should -Invoke Invoke-S3HttpRequest -ModuleName CpuGate -Times 3 -Exactly
        Should -Invoke Invoke-S3D1Sql -ModuleName CpuGate -Times 7 -Exactly
    }

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

    It 'persists Firebase project intent before isolated GCP project create' {
        $source = Get-Content (Join-Path $SourceRoot 'src\modules\Firebase.psm1') -Raw
        $pending = $source.IndexOf("provisioningStatus='PROJECT_CREATE_PENDING'")
        $create = $source.IndexOf("'projects','create'")
        $pending | Should -BeGreaterThan -1
        $pending | Should -BeLessThan $create
        $source.IndexOf('Write-S3State -Root $Context.Root -State $Context.State',$pending) | Should -BeGreaterThan $pending
    }

    It 'preserves an isolated GCP create stdout diagnostic when stderr is empty' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Get-S3FirebaseProjectRecord { [ordered]@{status='ABSENT'} } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut='FIREBASE_STDOUT_DIAGNOSTIC';StdErr=''}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED*FIREBASE_STDOUT_DIAGNOSTIC*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 1 -Exactly
    }

    It 'preserves an isolated GCP create stderr diagnostic' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Get-S3FirebaseProjectRecord { [ordered]@{status='ABSENT'} } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut='';StdErr='FIREBASE_STDERR_DIAGNOSTIC'}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED*FIREBASE_STDERR_DIAGNOSTIC*'
    }

    It 'reports a deterministic failure when isolated GCP create has no diagnostic' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Get-S3FirebaseProjectRecord { [ordered]@{status='ABSENT'} } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut='';StdErr=''}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED_NO_DIAGNOSTIC*'
    }

    It 'redacts sensitive-looking isolated GCP create diagnostics before surfacing them' {
        $c = Get-TestContext Live
        $firstValue = 'synthetic' + '-primary'
        $secondValue = 'synthetic' + '-secondary'
        $diagnostic = [string]::Concat(('pass' + 'word'),[char]61,[char]34,$firstValue,[char]34,', ',('access' + 'Token'),[char]61,[char]34,$secondValue,[char]34)
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Get-S3FirebaseProjectRecord { [ordered]@{status='ABSENT'} } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=1;StdOut=$diagnostic;StdErr=''}
        } -ModuleName Firebase
        $message = try { Invoke-S3FirebaseProvision -Context $c } catch { $_.Exception.Message }
        $message | Should -Not -Match [regex]::Escape($firstValue)
        $message | Should -Not -Match [regex]::Escape($secondValue)
        $message | Should -Match '\[REDACTED\]'
    }

    It 'continues normally after separate GCP create and Firebase add results' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Wait-S3FirebaseAddReadiness {
            $c.State.resources.firebase.ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED'
            $c.State.resources.firebase.provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'
            [ordered]@{status='PASS';attempts=2}
        } -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            if ($ArgumentList -contains 'projects:addfirebase') { return [pscustomobject]@{ExitCode=0;StdOut='{"status":"success"}';StdErr=''} }
            throw 'UNEXPECTED_PROCESS'
        } -ModuleName Firebase
        Mock Assert-S3GoogleNoBilling { throw 'STOP_AFTER_FIREBASE_ADD' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*STOP_AFTER_FIREBASE_ADD*'
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

    It 'preserves provider createTime as a UTC instant after PowerShell JSON conversion' {
        $c = Get-TestContext Live
        $c.State.startedUtc = ('{"value":"2026-08-03T14:39:00Z"}' | ConvertFrom-Json).value
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $projectId = "s3cpu-$suffix"
        $displayName = Get-S3FirebaseProjectDisplayName -RunId $c.RunId
        $c.State.resources.firebase = [ordered]@{projectId=$projectId;marker=$c.RunId}
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=0;StdErr='';StdOut=(@{projectId=$projectId;name=$displayName;projectNumber='256040616628';lifecycleState='ACTIVE';createTime='2026-08-03T14:40:00Z'} | ConvertTo-Json -Compress)}
        } -ModuleName Firebase
        $record = Get-S3FirebaseProjectRecord -Context $c -ProjectId $projectId
        $record.createTime | Should -Match 'Z$'
        Test-S3FirebaseRunCreatedProject -Context $c -Resource $c.State.resources.firebase -ProjectRecord $record | Should -BeTrue
    }

    It 'records intent and lets isolated GCP create arbitrate ambiguous permission presence' {
        $c = Get-TestContext Live
        $events = [Collections.Generic.List[string]]::new()
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Get-S3FirebaseProjectRecord { [ordered]@{status='ABSENT'} } -ModuleName Firebase
        Mock Write-S3State { [void]$events.Add("state:$($c.State.resources.firebase.ownershipProof)") } -ModuleName Firebase
        Mock Invoke-S3Process {
            [void]$events.Add(($ArgumentList -join ' '))
            [pscustomobject]@{ExitCode=1;StdOut='';StdErr='PROJECT_ID_UNAVAILABLE'}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_PROJECT_CREATE_FAILED*PROJECT_ID_UNAVAILABLE*'
        $events[0] | Should -Be 'state:PENDING_CREATE_SUCCESS'
        $events[1] | Should -Match 'projects create'
        $c.State.resources.firebase.preCreatePresence | Should -Be 'UNKNOWN'
        $c.State.resources.firebase.preCreateAbsence | Should -Be 'UNVERIFIABLE'
        $c.State.resources.firebase.ownershipProof | Should -Be 'CREATE_FAILED_UNOWNED'
        $c.State.resources.firebase.provisioningStatus | Should -Be 'PROJECT_CREATE_FAILED'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -ParameterFilter { $ArgumentList -contains 'create' -and $ArgumentList -notcontains 'projects:addfirebase' } -Times 1 -Exactly
    }

    It 'retains provider-verified ownership when readiness passes and separate addFirebase fails' {
        $c = Get-TestContext Live
        $c.State.startedUtc = '2026-08-03T14:39:00Z'
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Wait-S3FirebaseAddReadiness {
            $c.State.resources.firebase.ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED'
            $c.State.resources.firebase.provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'
            $c.State.resources.firebase.providerProjectNumber='256040616628'
            $c.State.resources.firebase.providerCreateTimeUtc='2026-08-03T14:40:00Z'
            [ordered]@{status='PASS';attempts=2}
        } -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            [pscustomobject]@{ExitCode=2;StdOut='Failed to add Firebase';StdErr='PERMISSION_DENIED'}
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_ADD_FAILED_AFTER_READINESS*'
        $c.State.resources.firebase.ownershipProof | Should -Be 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
        $c.State.resources.firebase.provisioningStatus | Should -Be 'PROJECT_CREATED_FIREBASE_ADD_FAILED'
        $c.State.resources.firebase.providerProjectNumber | Should -Be '256040616628'
        $c.State.resources.firebase.providerCreateTimeUtc | Should -Be '2026-08-03T14:40:00Z'
    }

    It 'requires both IAM and Firebase availableProjects evidence before readiness passes' {
        $c = Get-TestContext Live
        $c.State.startedUtc = '2026-08-03T14:39:00Z'
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $projectId = "s3cpu-$suffix"
        $resource = [ordered]@{projectId=$projectId;marker=$c.RunId;ownershipProof='PENDING_CREATE_SUCCESS';provisioningStatus='PROJECT_CREATED_AWAITING_PROVIDER_PROOF'}
        $c.State.resources.firebase = $resource
        $script:readinessAttempt = 0
        $script:readinessClock = [datetime]'2026-08-03T14:40:00Z'
        Mock Get-S3FirebaseAddReadiness {
            $script:readinessAttempt++
            $backendReady = $script:readinessAttempt -ge 2
            [ordered]@{
                ready=$backendReady;projectReady=$true;iamReady=$true;firebaseBackendReady=$backendReady
                projectRecord=[ordered]@{status='EXISTS';projectId=$projectId;displayName=(Get-S3FirebaseProjectDisplayName -RunId $c.RunId);projectNumber='256040616628';lifecycleState='ACTIVE';createTime='2026-08-03T14:40:00Z'}
            }
        } -ModuleName Firebase
        Mock Set-S3FirebaseProviderVerifiedOwnership {
            $resource.ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED'
            $resource.provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'
            $true
        } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        $proof = Wait-S3FirebaseAddReadiness -Context $c -Resource $resource -DisplayName (Get-S3FirebaseProjectDisplayName -RunId $c.RunId) -TimeoutSeconds 30 -RetryDelaySeconds 1 -Now {$script:readinessClock} -Sleep {param($Seconds)$script:readinessClock=$script:readinessClock.AddSeconds($Seconds)}
        $proof.status | Should -Be 'PASS'
        $proof.attempts | Should -Be 2
        $resource.ownershipProof | Should -Be 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
        $resource.iamReady | Should -BeTrue
        $resource.firebaseBackendReady | Should -BeTrue
        $resource.readinessStatus | Should -Be 'PASS'
        $resource.initialFirebaseBackendReady | Should -BeFalse
        $resource.firebaseBackendReadyAtAttempt | Should -Be 2
        $resource.iamReadyAtAttempt | Should -Be 1
        Should -Invoke Set-S3FirebaseProviderVerifiedOwnership -ModuleName Firebase -Times 1 -Exactly
    }

    It 'times out fail closed when Firebase backend never lists the new project' {
        $c = Get-TestContext Live
        $resource = [ordered]@{projectId='s3cpu-timeout-test';marker=$c.RunId;ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED';provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'}
        $c.State.resources.firebase = $resource
        $script:timeoutClock = [datetime]'2026-08-03T14:40:00Z'
        $script:timeoutAttempt = 0
        Mock Get-S3FirebaseAddReadiness {
            $script:timeoutAttempt++
            [ordered]@{ready=$false;projectReady=$true;iamReady=$true;firebaseBackendReady=$false;projectCount=$script:timeoutAttempt;projectRecord=[ordered]@{status='EXISTS'}}
        } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        { Wait-S3FirebaseAddReadiness -Context $c -Resource $resource -DisplayName 'S3 CPU timeout' -TimeoutSeconds 2 -RetryDelaySeconds 1 -Now {$script:timeoutClock} -Sleep {param($Seconds)$script:timeoutClock=$script:timeoutClock.AddSeconds($Seconds)} } | Should -Throw '*FIREBASE_ADD_READINESS_TIMEOUT*'
        $resource.readinessStatus | Should -Be 'TIMEOUT'
        $resource.firebaseBackendReady | Should -BeFalse
    }

    It 'opens the readiness circuit breaker after three identical provider failures' {
        $c = Get-TestContext Live
        $resource = [ordered]@{projectId='s3cpu-circuit-test';marker=$c.RunId;ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED';provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'}
        $c.State.resources.firebase = $resource
        $script:circuitClock = [datetime]'2026-08-03T14:40:00Z'
        $script:circuitSleeps = 0
        Mock Get-S3FirebaseAddReadiness {
            [ordered]@{
                ready=$false;projectReady=$true;iamReady=$true;firebaseBackendReady=$false
                iamQueryStatus='PASS';firebaseQueryStatus='RETRYABLE_ERROR';firebaseQueryHttpStatus=403
                projectRecord=[ordered]@{status='EXISTS';lifecycleState='ACTIVE'}
            }
        } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        {
            Wait-S3FirebaseAddReadiness -Context $c -Resource $resource -DisplayName 'S3 CPU circuit' -TimeoutSeconds 30 -RetryDelaySeconds 1 -Now {$script:circuitClock} -Sleep {param($Seconds)$script:circuitSleeps++;$script:circuitClock=$script:circuitClock.AddSeconds($Seconds)}
        } | Should -Throw '*FIREBASE_ADD_READINESS_CIRCUIT_BREAKER*'
        $resource.readinessStatus | Should -Be 'CIRCUIT_BREAKER'
        $resource.readinessAttempts | Should -Be 3
        $resource.identicalReadinessFailureCount | Should -Be 3
        $resource.readinessFailureFingerprint | Should -Match '^[0-9a-f]{64}$'
        $script:circuitSleeps | Should -Be 2
    }

    It 'parses only the safe availableProjects readiness schema' -Tag 'FirebaseQuotaProject' {
        $c = Get-TestContext Live
        $helperSource = Get-Content -LiteralPath (Join-Path $SourceRoot 'src\helpers\firebase_available_project.mjs') -Raw
        $helperSource | Should -Match '"x-goog-user-project": quotaProjectId'
        New-Item -ItemType Directory -Path (Join-Path $TestDrive 'helpers'),(Join-Path $TestDrive 'tools\npm\node_modules\firebase-tools') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $TestDrive 'helpers\firebase_available_project.mjs') -Value '// test placeholder' -Encoding UTF8
        Mock Invoke-S3Process {
            [pscustomobject]@{ExitCode=0;StdErr='normal progress';StdOut='{"status":"PASS","available":true,"displayNameMatch":true,"pagesScanned":2,"projectCount":7}'}
        } -ModuleName Firebase
        $proof = Get-S3FirebaseBackendReadiness -Context $c -ProjectId 's3cpu-readiness-test' -DisplayName 'S3 CPU readiness'
        $proof.ready | Should -BeTrue
        $proof.pagesScanned | Should -Be 2
        $proof.projectCount | Should -Be 7
        Should -Invoke Invoke-S3Process -ModuleName Firebase -ParameterFilter {$SensitiveOutput -and $ArgumentList -contains 's3cpu-readiness-test' -and $ArgumentList -contains 'ultra-function-476817-g5'} -Times 1 -Exactly
    }

    It 'fails structural availableProjects probe errors without retrying them as readiness' {
        $c = Get-TestContext Live
        New-Item -ItemType Directory -Path (Join-Path $TestDrive 'helpers'),(Join-Path $TestDrive 'tools\npm\node_modules\firebase-tools') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $TestDrive 'helpers\firebase_available_project.mjs') -Value '// test placeholder' -Encoding UTF8
        Mock Invoke-S3Process { [pscustomobject]@{ExitCode=20;StdErr='';StdOut='{"status":"ERROR","code":"DISPLAY_NAME_MISMATCH"}'} } -ModuleName Firebase
        { Get-S3FirebaseBackendReadiness -Context $c -ProjectId 's3cpu-readiness-test' -DisplayName 'S3 CPU readiness' } | Should -Throw '*DISPLAY_NAME_MISMATCH*'
    }

    It 'retains only a safe numeric status for retryable availableProjects errors' -Tag 'FirebaseQuotaProject' {
        $c = Get-TestContext Live
        New-Item -ItemType Directory -Path (Join-Path $TestDrive 'helpers'),(Join-Path $TestDrive 'tools\npm\node_modules\firebase-tools') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $TestDrive 'helpers\firebase_available_project.mjs') -Value '// test placeholder' -Encoding UTF8
        Mock Invoke-S3Process { [pscustomobject]@{ExitCode=10;StdErr='provider details must not propagate';StdOut='{"status":"ERROR","code":"AVAILABLE_PROJECTS_QUERY_FAILED","httpStatus":500}'} } -ModuleName Firebase
        $proof = Get-S3FirebaseBackendReadiness -Context $c -ProjectId 's3cpu-readiness-test' -DisplayName 'S3 CPU readiness'
        $proof.queryStatus | Should -Be 'RETRYABLE_ERROR'
        $proof.httpStatus | Should -Be 500
        $proof.ready | Should -BeFalse
        ($proof | ConvertTo-Json -Compress) | Should -Not -Match 'provider details|ultra-function-476817-g5|Bearer'
    }

    It 'never invokes addFirebase when readiness fails' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'ABSENT' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Wait-S3FirebaseAddReadiness { throw 'FIREBASE_ADD_READINESS_TIMEOUT' } -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            throw 'ADD_MUST_NOT_RUN'
        } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*FIREBASE_ADD_READINESS_TIMEOUT*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -ParameterFilter {$ArgumentList -contains 'projects:addfirebase'} -Times 0 -Exactly
    }

    It 'recovers a legacy partial-success state only from exact provider metadata' {
        $c = Get-TestContext Live
        $c.State.startedUtc = '2026-08-03T14:39:00Z'
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $projectId = "s3cpu-$suffix"
        $c.State.resources.firebase = [ordered]@{projectId=$projectId;marker=$c.RunId;provisioningStatus='PROJECT_CREATE_FAILED';preCreatePresence='UNKNOWN';preCreateAbsence='UNVERIFIABLE';ownershipProof='CREATE_FAILED_UNOWNED'}
        Mock Get-S3FirebaseProjectRecord {
            [ordered]@{status='EXISTS';projectId=$projectId;displayName=(Get-S3FirebaseProjectDisplayName -RunId $c.RunId);projectNumber='256040616628';lifecycleState='ACTIVE';createTime='2026-08-03T14:40:00Z'}
        } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'delete') { return [pscustomobject]@{ExitCode=0;StdOut='';StdErr=''} }
            return [pscustomobject]@{ExitCode=0;StdOut='DELETE_REQUESTED';StdErr=''}
        } -ModuleName Firebase
        (Remove-S3FirebaseProject -Context $c).status | Should -Be 'DELETE_REQUESTED'
        $c.State.resources.firebase.ownershipProof | Should -Be 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
        $c.State.resources.firebase.provisioningStatus | Should -Be 'PROJECT_CREATED_FIREBASE_ADD_FAILED'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -ParameterFilter { $ArgumentList -contains 'delete' } -Times 1 -Exactly
    }

    It 'refuses legacy partial-success recovery when provider metadata does not match the run' {
        $c = Get-TestContext Live
        $c.State.startedUtc = '2026-08-03T14:39:00Z'
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $projectId = "s3cpu-$suffix"
        $c.State.resources.firebase = [ordered]@{projectId=$projectId;marker=$c.RunId;provisioningStatus='PROJECT_CREATE_FAILED';preCreatePresence='UNKNOWN';preCreateAbsence='UNVERIFIABLE';ownershipProof='CREATE_FAILED_UNOWNED'}
        Mock Get-S3FirebaseProjectRecord {
            [ordered]@{status='EXISTS';projectId=$projectId;displayName='Different project';projectNumber='256040616628';lifecycleState='ACTIVE';createTime='2026-08-03T14:40:00Z'}
        } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'DELETE_MUST_NOT_RUN' } -ModuleName Firebase
        { Remove-S3FirebaseProject -Context $c } | Should -Throw '*FIREBASE_PROJECT_OWNERSHIP_PROOF_MISSING*'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'treats a legacy failed-create project proven absent as idempotent cleanup' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $projectId = "s3cpu-$suffix"
        $c.State.resources.firebase = [ordered]@{projectId=$projectId;marker=$c.RunId;provisioningStatus='PROJECT_CREATE_FAILED';preCreatePresence='UNKNOWN';preCreateAbsence='UNVERIFIABLE';ownershipProof='CREATE_FAILED_UNOWNED'}
        Mock Get-S3FirebaseProjectRecord { [ordered]@{status='ABSENT'} } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Invoke-S3Process { throw 'DELETE_MUST_NOT_RUN' } -ModuleName Firebase
        (Remove-S3FirebaseProject -Context $c).status | Should -Be 'ALREADY_ABSENT'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'does not mark Firebase cleanup already absent after ambiguous permission failure' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $c.State.resources.firebase = [ordered]@{projectId="s3cpu-$suffix";marker=$c.RunId;provisioningStatus='PROJECT_CREATE_PENDING';preCreateAbsence='PASS';cleanupStatus=$null}
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'FIREBASE_DELETE_MUST_NOT_RUN' } -ModuleName Firebase
        { Remove-S3FirebaseProject -Context $c } | Should -Throw '*FIREBASE_PROJECT_PRESENCE_UNVERIFIABLE*'
        $c.State.resources.firebase.cleanupStatus | Should -BeNullOrEmpty
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'never invokes Firebase project creation when UNKNOWN intent write fails' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Write-S3State { throw 'STATE_WRITE_FAILED' } -ModuleName Firebase
        Mock Invoke-S3Process { throw 'FIREBASE_CREATE_MUST_NOT_RUN' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*STATE_WRITE_FAILED*'
        $c.State.resources.firebase.preCreatePresence | Should -Be 'UNKNOWN'
        $c.State.resources.firebase.ownershipProof | Should -Be 'PENDING_CREATE_SUCCESS'
        Should -Invoke Invoke-S3Process -ModuleName Firebase -Times 0 -Exactly
    }

    It 'persists provider-verified ownership before separate Firebase add' {
        $c = Get-TestContext Live
        $events = [Collections.Generic.List[string]]::new()
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Write-S3State { [void]$events.Add("state:$($c.State.resources.firebase.ownershipProof)") } -ModuleName Firebase
        Mock Wait-S3FirebaseAddReadiness {
            $c.State.resources.firebase.ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED'
            $c.State.resources.firebase.provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'
            [void]$events.Add('readiness:CREATE_SUCCEEDED_PROVIDER_VERIFIED')
            [ordered]@{status='PASS';attempts=2}
        } -ModuleName Firebase
        Mock Invoke-S3Process {
            [void]$events.Add(($ArgumentList -join ' '))
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            if ($ArgumentList -contains 'projects:addfirebase') { return [pscustomobject]@{ExitCode=0;StdOut='{"status":"success"}';StdErr=''} }
            throw 'UNEXPECTED_PROCESS'
        } -ModuleName Firebase
        Mock Assert-S3GoogleNoBilling { throw 'STOP_AFTER_PROJECT_STATE' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*STOP_AFTER_PROJECT_STATE*'
        $events[0] | Should -Be 'state:PENDING_CREATE_SUCCESS'
        ($events -join '|') | Should -Match 'projects create'
        $providerStateIndex = $events.IndexOf('readiness:CREATE_SUCCEEDED_PROVIDER_VERIFIED')
        $addIndex = -1
        for($i=0;$i -lt $events.Count;$i++){if($events[$i] -match 'projects:addfirebase'){$addIndex=$i;break}}
        $providerStateIndex | Should -BeGreaterThan -1
        $addIndex | Should -BeGreaterThan $providerStateIndex
        $c.State.resources.firebase.preCreatePresence | Should -Be 'UNKNOWN'
        $c.State.resources.firebase.preCreateAbsence | Should -Be 'UNVERIFIABLE'
        $c.State.resources.firebase.ownershipProof | Should -Be 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
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

    It 'cleans an exact Firebase project after CREATE_SUCCEEDED ownership proof' {
        $c = Get-TestContext Live
        $suffix = ($c.RunId -replace '[^a-z0-9-]','').ToLowerInvariant();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
        $resource = [ordered]@{
            projectId="s3cpu-$suffix";marker=$c.RunId;provisioningStatus='PROJECT_CREATED'
            preCreatePresence='UNKNOWN';preCreateAbsence='UNVERIFIABLE';ownershipProof='CREATE_SUCCEEDED'
        }
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

    It 'keeps an UNKNOWN-precheck Firebase project cleanup-capable after child provisioning fails' {
        $c = Get-TestContext Live
        Mock Assert-S3PreexistingGoogleCliSession {} -ModuleName Firebase
        Mock Get-S3FirebaseProjectPresence { 'UNKNOWN' } -ModuleName Firebase
        Mock Write-S3State {} -ModuleName Firebase
        Mock Wait-S3FirebaseAddReadiness {
            $c.State.resources.firebase.ownershipProof='CREATE_SUCCEEDED_PROVIDER_VERIFIED'
            $c.State.resources.firebase.provisioningStatus='PROJECT_CREATED_AWAITING_FIREBASE'
            [ordered]@{status='PASS';attempts=2}
        } -ModuleName Firebase
        Mock Invoke-S3Process {
            if ($ArgumentList -contains 'create') { return [pscustomobject]@{ExitCode=0;StdOut='created';StdErr=''} }
            if ($ArgumentList -contains 'projects:addfirebase') { return [pscustomobject]@{ExitCode=0;StdOut='{"status":"success"}';StdErr=''} }
            throw 'UNEXPECTED_PROCESS'
        } -ModuleName Firebase
        Mock Assert-S3GoogleNoBilling { throw 'CHILD_PROVISIONING_FAILED' } -ModuleName Firebase
        { Invoke-S3FirebaseProvision -Context $c } | Should -Throw '*CHILD_PROVISIONING_FAILED*'
        $c.State.resources.firebase.projectId | Should -Match '^s3cpu-'
        $c.State.resources.firebase.marker | Should -Be $c.RunId
        $c.State.resources.firebase.preCreatePresence | Should -Be 'UNKNOWN'
        $c.State.resources.firebase.ownershipProof | Should -Be 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
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


Describe 'S3-R Harness secure rehydration regressions' {
 It 'never provisions Firebase or Cloudflare on a resumed preserved run' {
  $source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw;$bootstrap=Get-Content (Join-Path $SourceRoot 'src\Bootstrap.ps1') -Raw
  $source|Should -Match 'currentState -eq ''40_PRE_CLOUD_GATE'' -and -not \$context\.IsResumed'
  $source|Should -Match 'currentState -eq ''50_FIREBASE_PROVISIONED'' -and -not \$context\.IsResumed'
  $source|Should -Match 'Invoke-S3FirebaseRuntimeRehydration'
  $source|Should -Match '\[string\]\$PublicBaseUri'
  $source|Should -Match 'Invoke-S3CpuGate -Context \$context -PublicBaseUri \$PublicBaseUri'
  $bootstrap|Should -Match '\[string\]\$PublicBaseUri'
  $bootstrap|Should -Match "\`$arguments\+='-PublicBaseUri'"
 }
 It 'enforces checkpoint-60 rehydration ordering before mutation' {
  $orchestrator=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw;$firebase=Get-Content (Join-Path $SourceRoot 'src\modules\Firebase.psm1') -Raw
  $cloudflareIndex=$orchestrator.IndexOf('Invoke-S3CloudflareRuntimeRehydration');$firebaseIndex=$orchestrator.IndexOf('Invoke-S3FirebaseRuntimeRehydration');$cloudflareIndex|Should -BeGreaterThan -1;$firebaseIndex|Should -BeGreaterThan $cloudflareIndex
  $rehydrationStart=$firebase.IndexOf('function Invoke-S3FirebaseRuntimeRehydration');$firebaseBlock=$firebase.Substring($rehydrationStart);$configIndex=$firebaseBlock.IndexOf('Invoke-S3GoogleRest -Method GET -Uri $configurationUri');$passwordIndex=$firebaseBlock.IndexOf('Update-S3FirebaseAdminUserPassword');$tokenIndex=$firebaseBlock.IndexOf('Get-S3FirebaseIdToken');$rehydrationStart|Should -BeGreaterThan -1;$configIndex|Should -BeGreaterThan -1;$passwordIndex|Should -BeGreaterThan $configIndex;$tokenIndex|Should -BeGreaterThan $passwordIndex
 }
 It 'keeps checkpoint 60 and blocks cleanup/report after CPU decision FAIL' {
  $c=Get-TestContext Live;$c.State.currentState='60_CLOUDFLARE_PROVISIONED';$c.State.completed=@('00_PACKAGE_READY','60_CLOUDFLARE_PROVISIONED');$decision=[ordered]@{status='FAIL';reasons=@('CPU_REJECTED')}
  {Complete-S3CpuGateDecision -Context $c -CpuDecision $decision}|Should -Throw '*CPU_GATE_DECISION_FAILED*'
  (Get-S3MapValue -Map $c.State.results -Name 'cpu').status|Should -Be 'FAIL';$c.State.currentState|Should -Be '60_CLOUDFLARE_PROVISIONED'
  $source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw;$source|Should -Match 'Complete-S3CpuGateDecision';$source|Should -Match '-not \$cpuDecisionFailed';$source|Should -Match 'currentState -eq ''80_RESOURCES_DESTROYED'''
 }
 It 'does not run cleanup automatically for a resumed preserved run' {
  $source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw
  $source|Should -Match 'resumedSuccess'
  $source|Should -Match '-not \$context\.IsResumed -or \$resumedSuccess'
 }
 It 'brackets Live CPU Gate with Worker state restoration' {
  $source=Get-Content (Join-Path $SourceRoot 'src\S3-CpuGate-Orchestrator.ps1') -Raw
  $source|Should -Match 'Invoke-S3WithWorkerStateRestore'
  (Get-Content (Join-Path $SourceRoot 'src\modules\Common.psm1') -Raw)|Should -Match 'WORKER_STATE_RESTORE_FAILED'
 }
 It 'keeps rehydration credentials memory-only' {
  $firebase=Get-Content (Join-Path $SourceRoot 'src\modules\Firebase.psm1') -Raw
  $firebase|Should -Match 'secrets=.MEMORY_ONLY.'
  $firebase|Should -Match 'provisioningSkipped=\$true'
 }
}


Describe 'S3-R authoritative runtime rehydration' {
 It 'rehydrates same UIDs from Firebase and D1 evidence without provisioning' {
  $c=Get-TestContext Live;$c.State.resources.firebase=[ordered]@{projectId='preserved-project'};$c.State.resources.cloudflare=[ordered]@{accountId='account';d1Id='d1-id';marker=$c.RunId};$c.RuntimeSecrets.cloudflareToken='management-session'
  $uid1=[guid]::NewGuid().ToString('N');$uid2=[guid]::NewGuid().ToString('N');$apiKey=[guid]::NewGuid().ToString('N');$admin=[guid]::NewGuid().ToString('N')
  Mock Get-S3FirebaseProjectPresence {'EXISTS'} -ModuleName Firebase
  Mock Get-S3FirebaseUser {@([ordered]@{localId=$uid1;providerUserInfo=@([ordered]@{providerId='password'})},[ordered]@{localId=$uid2;providerUserInfo=@([ordered]@{providerId='password'})})} -ModuleName Firebase
  Mock Get-S3CloudflareD1RunUidSet {@($uid1,$uid2)} -ModuleName Firebase
  Mock Get-S3FederatedProviderSnapshot {[ordered]@{verified=$true;enabledCount=0}} -ModuleName Firebase
  Mock Assert-S3FirebaseConfiguration {[ordered]@{verified=$true}} -ModuleName Firebase
  Mock Invoke-S3GoogleRest {[ordered]@{}} -ModuleName Firebase
  Mock New-S3FirebaseAdminUser {throw 'PROVISIONING_MUST_NOT_RUN'} -ModuleName Firebase
  Mock Update-S3FirebaseAdminUserPassword {} -ModuleName Firebase
  Mock Get-S3FirebaseIdToken {param($A,$Email,$S);[void]$A;[void]$S;[pscustomobject]@{IdToken=[guid]::NewGuid().ToString('N');RefreshToken=[guid]::NewGuid().ToString('N');LocalId=($Email -replace '@example.invalid','')}} -ModuleName Firebase
  $provider={param($project,$expected) [void]$project;[void]$expected;[ordered]@{adminToken=$admin;credentials=@([ordered]@{uid=$uid1;email="$uid1@example.invalid";password=([guid]::NewGuid().ToString('N'));apiKey=$apiKey},[ordered]@{uid=$uid2;email="$uid2@example.invalid";password=([guid]::NewGuid().ToString('N'));apiKey=$apiKey})}}
  $r=Invoke-S3FirebaseRuntimeRehydration -Context $c -ExpectedUids @() -CredentialProvider $provider
  $r.status|Should -Be 'PASS';$r.sameUids|Should -BeTrue;$r.provisioningSkipped|Should -BeTrue;$r.secrets|Should -Be 'MEMORY_ONLY'
  Should -Invoke New-S3FirebaseAdminUser -ModuleName Firebase -Times 0 -Exactly;Should -Invoke Update-S3FirebaseAdminUserPassword -ModuleName Firebase -Times 2 -Exactly
  Should -Invoke Get-S3CloudflareD1RunUidSet -ModuleName Firebase -Times 1 -Exactly
  $c.State|ConvertTo-Json -Depth 30|Should -Not -Match ($apiKey+'|'+$admin)
 }
 It 'reads remote Worker settings and compares effective state without returning values' {
  $c=Get-TestContext Live;$nonce=('n'+[guid]::NewGuid().ToString('N'));$responses=@{
   settings=[pscustomobject]@{success=$true;errors=@();result=[ordered]@{observability=[ordered]@{enabled=$true}}}
   versions=[pscustomobject]@{success=$true;errors=@();result=[ordered]@{items=@([ordered]@{id='v1';metadata=[ordered]@{created_on='2026-08-15T00:00:00Z'}})}}
   deployments=[pscustomobject]@{success=$true;errors=@();result=[ordered]@{deployments=@([ordered]@{id='dep1';created_on='2026-08-15T00:00:00Z';versions=@([ordered]@{percentage=100;version_id='v1'})})}}
   version=[pscustomobject]@{success=$true;errors=@();result=[ordered]@{resources=[ordered]@{script_runtime=[ordered]@{compatibility_date='2026-08-01';compatibility_flags=@();usage_model='standard'};bindings=@([ordered]@{name='DB';type='d1';id='d1-id'},[ordered]@{name='TEST_RESET_NONCE';type='plain_text';text=$nonce})}}}
  }
  $calls=[Collections.Generic.List[string]]::new()
  Mock Invoke-S3CloudflareRest {param($Method,$Uri,$Token);[void]$Method;[void]$Token;$calls.Add($Uri);if($Uri -match '/script-settings$'){$responses.settings}elseif($Uri -match '/versions/v1$'){$responses.version}elseif($Uri -match '/versions$'){$responses.versions}else{$responses.deployments}} -ModuleName Cloudflare
  $s=Get-S3CloudflareWorkerRemoteSnapshot -Context $c -AccountId 'account' -WorkerName 'worker' -Token 'token'
  $calls[0] | Should -Match '/workers/scripts/worker/script-settings$';$calls[0] | Should -Not -Match '/workers/scripts/worker/settings$'
  $calls | Should -Contain 'https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/worker/versions/v1'
  $s.public.settings.variables[0].valueNonEmpty|Should -BeTrue;$s.privateVars.TEST_RESET_NONCE|Should -Be $nonce
  (ConvertTo-Json $s.public -Depth 30)|Should -Not -Match $nonce
  Test-S3CloudflareWorkerRemoteSnapshot -Before $s -After $s | Should -BeTrue
 }
}


Describe 'S3-R legacy checkpoint-60 Count root cause' {
 It 'recovers authoritative UIDs when legacy checkpoint has no persisted Firebase UIDs' {
  $c=Get-TestContext Live;$c.State.currentState='60_CLOUDFLARE_PROVISIONED'
  $c.State.resources.firebase=[ordered]@{projectId='preserved-project'};$c.State.resources.cloudflare=[ordered]@{accountId='account';d1Id='d1-id';worker='worker';marker=$c.RunId};$c.RuntimeSecrets.cloudflareToken='management-session'
  $uid1='uid-authoritative-one';$uid2='uid-authoritative-two';$apiKey='synthetic-api-key';$admin='synthetic-admin-token';$calls=[Collections.Generic.List[object]]::new()
  Mock Get-S3FirebaseProjectPresence {'EXISTS'} -ModuleName Firebase
  Mock Get-S3FirebaseUser {@([ordered]@{localId=$uid1;email="$uid1@example.invalid";providerUserInfo=@([ordered]@{providerId='password'})},[ordered]@{localId=$uid2;email="$uid2@example.invalid";providerUserInfo=@([ordered]@{providerId='password'})})} -ModuleName Firebase
  Mock Get-S3CloudflareD1RunUidSet {@($uid1,$uid2)} -ModuleName Firebase
  Mock Get-S3FederatedProviderSnapshot {[ordered]@{verified=$true;enabledCount=0}} -ModuleName Firebase
  Mock Assert-S3FirebaseConfiguration {[ordered]@{verified=$true}} -ModuleName Firebase
  Mock Invoke-S3GoogleRest {[ordered]@{}} -ModuleName Firebase
  Mock Update-S3FirebaseAdminUserPassword {} -ModuleName Firebase
  Mock Get-S3FirebaseIdToken {param($ApiKey,$Email,$Secret);[void]$ApiKey;[void]$Secret;[pscustomobject]@{IdToken=('token-'+($Email -replace '@example.invalid',''));RefreshToken='refresh';LocalId=($Email -replace '@example.invalid','')}} -ModuleName Firebase
  $provider={param($project,$expected);[void]$project;$normalized=@($expected);$calls.Add($normalized);if($normalized.Count -eq 0){return [ordered]@{adminToken=$admin;apiKey=$apiKey;credentials=@()}};return [ordered]@{adminToken=$admin;apiKey=$apiKey;credentials=@([ordered]@{uid=$uid1;email="$uid1@example.invalid";password=([guid]::NewGuid().ToString('N'));apiKey=$apiKey},[ordered]@{uid=$uid2;email="$uid2@example.invalid";password=([guid]::NewGuid().ToString('N'));apiKey=$apiKey})}}
  { Invoke-S3FirebaseRuntimeRehydration -Context $c -ExpectedUids $null -CredentialProvider $provider } | Should -Not -Throw
  $calls.Count | Should -Be 2;$calls[0].Count | Should -Be 0;$calls[1].Count | Should -Be 2
  Should -Invoke Update-S3FirebaseAdminUserPassword -ModuleName Firebase -Times 2 -Exactly
  $c.RuntimeSecrets.uid1 | Should -Be $uid1;$c.RuntimeSecrets.uid2 | Should -Be $uid2
  $c.State | ConvertTo-Json -Depth 30 | Should -Not -Match ($apiKey+'|'+$admin)
 }
 It 'rejects a one-UID legacy input deterministically instead of dereferencing a scalar Count' {
  $c=Get-TestContext Live
  { Invoke-S3FirebaseRuntimeRehydration -Context $c -ExpectedUids @('uid-one') -CredentialProvider { param($ProjectId,$ExpectedUids) [void]$ProjectId;[void]$ExpectedUids } } | Should -Throw '*FIREBASE_REHYDRATION_UID_SET_INVALID*'
 }
 It 'records sanitized exception metadata and a stable fingerprint' {
  $c=Get-TestContext
  try { throw 'SYNTHETIC_FAILURE' } catch { $record=$_ }
  $e=Write-S3FailureEvidence -Context $c -Reason 'SYNTHETIC_FAILURE' -FailureRecord $record -Operation 'test.operation'
  $e.metadata.exceptionType | Should -Be 'System.Management.Automation.RuntimeException'
  $e.metadata.operation | Should -Be 'test.operation'
  $e.metadata.fingerprint | Should -Match '^[0-9a-f]{64}$'
  $state=Get-Content (Join-Path $TestDrive 'state.json') -Raw
  $state | Should -Match 'SYNTHETIC_FAILURE'
  $state | Should -Not -Match '(?i)password|accessToken|refreshToken|apiKey'
 }
}

Describe 'S3-R Firebase Web App discovery' {
 It 'fails closed when the preserved project has zero Web Apps' {
  { Select-S3FirebaseWebApp -Apps @() } | Should -Throw '*FIREBASE_REHYDRATION_WEB_APP_MISSING*'
 }
 It 'selects the only preserved Web App deterministically' {
  $selected=Select-S3FirebaseWebApp -Apps @([ordered]@{appId='web-app-one';platform='WEB'},[ordered]@{appId='android-app-one';platform='ANDROID'})
  $selected.appId | Should -Be 'web-app-one';$selected.platform | Should -Be 'WEB'
 }
 It 'fails closed when multiple preserved Web Apps exist' {
  { Select-S3FirebaseWebApp -Apps @([ordered]@{appId='web-app-one';platform='WEB'},[ordered]@{appId='web-app-two';platform='WEB'}) } | Should -Throw '*FIREBASE_REHYDRATION_WEB_APP_AMBIGUOUS*'
 }
 It 'classifies an invalid Firebase CLI session separately from app and sdkconfig failures' {
  $result=[pscustomobject]@{ExitCode=1;StdOut='';StdErr='not logged in'}
  (Get-S3FirebaseCliFailureCode -Result $result -Operation 'apps-list') | Should -Be 'FIREBASE_REHYDRATION_FIREBASE_SESSION_UNAVAILABLE'
  { Assert-S3FirebaseCliFailure -Result $result -Operation 'apps-list' } | Should -Throw '*FIREBASE_REHYDRATION_FIREBASE_SESSION_UNAVAILABLE*'
 }
 It 'distinguishes inventory API failure from sdkconfig API failure' {
  $result=[pscustomobject]@{ExitCode=1;StdOut='';StdErr='backend unavailable'}
  (Get-S3FirebaseCliFailureCode -Result $result -Operation 'apps-list') | Should -Be 'FIREBASE_REHYDRATION_WEB_APP_INVENTORY_API_FAILURE'
  (Get-S3FirebaseCliFailureCode -Result $result -Operation 'sdkconfig') | Should -Be 'FIREBASE_REHYDRATION_WEB_SDKCONFIG_API_FAILURE'
 }
 It 'parses the raw firebase-tools sdkconfig envelope with status result sdkConfig and apiKey' {
  $payload='{"status":"success","result":{"sdkConfig":{"apiKey":"synthetic-api-key"}}}' | ConvertFrom-Json
  Get-S3FirebaseSdkConfigApiKey -Payload $payload | Should -Be 'synthetic-api-key'
 }
 It 'fails closed for an unexpected firebase-tools sdkconfig envelope' {
  $payload='{"status":"success","result":{"sdkConfig":{"config":{"apiKey":"synthetic-api-key"}}}}' | ConvertFrom-Json
  { Get-S3FirebaseSdkConfigApiKey -Payload $payload } | Should -Throw '*FIREBASE_REHYDRATION_WEB_SDKCONFIG_SHAPE_INVALID*'
 }
 It 'uses the exact single Web App ID for valid sdkconfig rehydration' {
  $c=Get-TestContext Live;$calls=[Collections.Generic.List[object]]::new()
  $process={param([string]$FilePath,[string[]]$Arguments);[void]$calls.Add(@($FilePath,$Arguments));if($Arguments -contains 'print-access-token'){return [pscustomobject]@{ExitCode=0;StdOut='synthetic-admin';StdErr=''}};if($Arguments -contains 'apps:list'){return [pscustomobject]@{ExitCode=0;StdOut='{"result":[{"appId":"web-app-one","platform":"WEB"}]}' ;StdErr=''}};if($Arguments -contains 'apps:sdkconfig'){return [pscustomobject]@{ExitCode=0;StdOut='{"status":"success","result":{"sdkConfig":{"apiKey":"synthetic-api-key"}}}' ;StdErr=''}};throw 'UNEXPECTED_FIREBASE_COMMAND'}
  $users={param([string]$ProjectId,[string]$Token);[void]$ProjectId;[void]$Token;@([ordered]@{localId='uid-one';email='uid-one@example.invalid'})}
  $provider=New-S3FirebaseCredentialProvider -Context $c -ProcessProvider $process -UserProvider $users
  $result=& $provider 'preserved-project' @('uid-one')
  $result.webAppId | Should -Be 'web-app-one';$result.credentials.Count | Should -Be 1
  @($calls[2][1]) | Should -Contain 'web-app-one'
 }
}

Describe 'S3-R D1 failure restoration' {
 It 'restores uid2 authorization in finally when temporary D1 mutation fails' {
  $c=Get-TestContext Live;$c.RuntimeSecrets.uid1='uid-one';$c.RuntimeSecrets.uid2='uid-two';$c.State.resources.cloudflare=[ordered]@{d1Name='synthetic-d1'};$calls=[Collections.Generic.List[string]]::new()
  Mock Invoke-S3HttpRequest { $requestId=[string]$Headers['x-s3-request-id'];$value=($Body|ConvertFrom-Json).value;$isFirst=$value -eq 'synthetic-before';$action=if($isFirst){'CREATE'}else{'UPDATE'};$actor=if($isFirst){'uid-one'}else{'uid-two'};[pscustomobject]@{status=200;body=([ordered]@{ok=$true;requestId=$RequestId;audit=[ordered]@{action=$action;actorUid=$actor;createdAt='2026-08-26T12:00:00.000Z';runId=$c.RunId;requestId=$RequestId;before=$(if($isFirst){$null}else{[ordered]@{value='synthetic-before'}});after=[ordered]@{value=$value}}}|ConvertTo-Json -Compress)} } -ModuleName CpuGate
  Mock Invoke-S3D1Sql { param($Context,$Sql,[switch]$AllowFailure,[switch]$PassThru);[void]$Context;[void]$AllowFailure;if($Sql -match 'DELETE FROM s3_audit_probe'){if($PassThru){return [pscustomobject]@{ExitCode=0;StdOut='';StdErr=''}};return};$calls.Add($Sql);if($calls.Count -eq 1){throw 'TEMP_D1_MUTATION_FAILED'}} -ModuleName CpuGate
  {Invoke-S3AuditAcceptance -Context $c -BaseUri 'https://synthetic.workers.dev' -Token1 'a' -Token2 'b' -Nonce 'n'}|Should -Throw '*TEMP_D1_MUTATION_FAILED*'
  $calls.Count|Should -Be 2;$calls[1]|Should -Match 'active=1'
 }
}
