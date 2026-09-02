Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-S3CloudflareBillingRead {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$ExpectedAccountId,
        [int]$TimeoutSeconds = 90
    )
    $normalizedMethod = $Method.ToUpperInvariant()
    if ($normalizedMethod -ne 'GET') {
        throw "CLOUDFLARE_BILLING_WRITE_FORBIDDEN: Method $Method is forbidden for billing token"
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedAccountId)) {
        throw "CLOUDFLARE_BILLING_ACCOUNT_MISSING: Expected Account ID is required"
    }
    $match = [regex]::Match($Uri, '(?i)^https://api.cloudflare.com/client/v4/accounts/([^/]+)/(subscriptions|paygo-usage-info)(?:\?.*)?$')
    if (-not $match.Success) {
        throw "CLOUDFLARE_BILLING_ENDPOINT_FORBIDDEN: URI $Uri is not a valid billing endpoint"
    }
    $uriAccountId = $match.Groups[1].Value
    if ($uriAccountId -ne $ExpectedAccountId) {
        throw "CLOUDFLARE_BILLING_ACCOUNT_MISMATCH: Account ID in URI does not match expected $ExpectedAccountId"
    }
    $parameters = @{
        Method = 'GET'
        Uri = $Uri
        Headers = @{ Authorization = "Bearer $Token" }
        TimeoutSec = $TimeoutSeconds
    }
    $response = Invoke-RestMethod @parameters
    if ($response.success -eq $false -or @($response.errors | Where-Object { $null -ne $_ }).Count -gt 0) {
        $safeErrors = Protect-S3Text (@($response.errors) | ConvertTo-Json -Depth 10 -Compress)
        throw "CLOUDFLARE_API_ERROR: $safeErrors"
    }
    return $response
}

function Invoke-S3CloudflareBillingPagedGet {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$ExpectedAccountId,
        [ValidateRange(1,100)][int]$PerPage=50
    )
    $items = [Collections.Generic.List[object]]::new()
    $pagesRead = [Collections.Generic.List[int]]::new()
    $page = 1
    while ($true) {
        $separator = if ($Uri.Contains('?')) {'&'} else {'?'}
        $response = Invoke-S3CloudflareBillingRead -Method GET -Uri "$Uri${separator}page=$page&per_page=$PerPage" -Token $Token -ExpectedAccountId $ExpectedAccountId
        if ($response.success -eq $false -or @($response.errors | Where-Object { $null -ne $_ }).Count -gt 0) { throw "CLOUDFLARE_PAGED_API_ERROR: page=$page" }
        $pagesRead.Add($page)
        foreach ($item in @($response.result)) { $items.Add($item) }
        $resultInfo = Get-S3CloudflareValue -InputObject $response -Name @('result_info')
        if ($null -eq $resultInfo) {
            if (@($response.result).Count -ge $PerPage) { throw "PAGINATION_METADATA_MISSING: page=$page" }
            break
        }
        $reportedPage = Get-S3CloudflareValue -InputObject $resultInfo -Name @('page')
        $totalPages = Get-S3CloudflareValue -InputObject $resultInfo -Name @('total_pages')
        if ($null -eq $reportedPage -or $null -eq $totalPages) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
        if ([int]$reportedPage -ne $page) { throw "PAGINATION_PAGE_MISMATCH: expected=$page actual=$reportedPage" }
        if ([int]$totalPages -lt $page) { throw "PAGINATION_TOTAL_INVALID: page=$page total=$totalPages" }
        if ($page -ge [int]$totalPages) { break }
        $page++
    }
    return [ordered]@{status='PASS';items=@($items);pagesRead=@($pagesRead);paginationComplete=$true}
}

function Get-S3CloudflareValue {
    param([AllowNull()][object]$InputObject,[Parameter(Mandatory)][string[]]$Name)
    if ($null -eq $InputObject) { return $null }
    foreach ($candidate in $Name) {
        if ($InputObject -is [Collections.IDictionary]) {
            if ($InputObject.Contains($candidate)) { return $InputObject[$candidate] }
        }
        else {
            $property = $InputObject.PSObject.Properties[$candidate]
            if ($null -ne $property) { return $property.Value }
        }
    }
    return $null
}

function Get-S3CloudflareToken {
    param($Context)
    $result = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('auth','token','--json') -TimeoutSeconds 60 -AllowFailure
    if ($result.ExitCode -ne 0) { throw 'BLOCKED — لا توجد جلسة Cloudflare صالحة مسبقًا. لن يبدأ تسجيل دخول تلقائي.' }
    $json = $result.StdOut | ConvertFrom-Json
    $token = [string](Get-S3CloudflareValue -InputObject $json -Name @('token','oauth_token','access_token'))
    $type = ([string](Get-S3CloudflareValue -InputObject $json -Name @('type'))).ToLowerInvariant()
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'BLOCKED — تعذر قراءة Cloudflare token من الجلسة الحالية.' }
    if ($type -notin @('oauth','api_token')) { throw 'CLOUDFLARE_TOKEN_TYPE_UNKNOWN' }
    return [ordered]@{token=$token;type=$type}
}

function Test-S3CloudflareReadOnlyMethod {
    param([Parameter(Mandatory)][string]$Method,[Parameter(Mandatory)][string]$Uri,[switch]$AllowReadOnlyD1Query,[switch]$AllowOwnedD1Mutation)
    $normalizedMethod = $Method.ToUpperInvariant()
    if ($normalizedMethod -eq 'GET') { return $true }
    if ($normalizedMethod -eq 'POST' -and $Uri -match '/accounts/[^/]+/workers/observability/telemetry/query$') { return $true }
    if ($normalizedMethod -eq 'POST' -and $AllowReadOnlyD1Query -and $Uri -match '/accounts/[^/]+/d1/database/[^/]+/query$') { return $true }
    if ($normalizedMethod -eq 'POST' -and $AllowOwnedD1Mutation -and $Uri -match '/accounts/[^/]+/d1/database/[^/]+/query$') { return $true }
    throw "CLOUDFLARE_WRITE_API_FORBIDDEN: $normalizedMethod $Uri"
}

function Invoke-S3CloudflareRest {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [AllowNull()][object]$Body = $null,
        [int]$TimeoutSeconds = 90,
        [switch]$AllowReadOnlyD1Query,
        [switch]$AllowOwnedD1Mutation,
        [string]$Operation = ''
    )
    [void](Test-S3CloudflareReadOnlyMethod -Method $Method -Uri $Uri -AllowReadOnlyD1Query:$AllowReadOnlyD1Query -AllowOwnedD1Mutation:$AllowOwnedD1Mutation)
    $parameters = @{Method=$Method;Uri=$Uri;Headers=@{Authorization="Bearer $Token"};TimeoutSec=$TimeoutSeconds}
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 30 -Compress
    }
    try {
        $response = Invoke-RestMethod @parameters
    }
    catch {
        $requestFailure = $_
        $endpoint = $Uri
        try { $endpoint = ([Uri]$Uri).AbsolutePath } catch { $endpoint = $Uri }
        $operationName = if ([string]::IsNullOrWhiteSpace($Operation)) {'unspecified'} else {$Operation}
        $status = 'UNKNOWN'; $requestId = 'UNKNOWN'; $responseObject = $null; $rawProviderBody = ''
        try { $responseObject = $requestFailure.Exception.Response } catch { $responseObject = $null }
        if ($null -ne $responseObject) {
            try { $status = [string][int]$responseObject.StatusCode } catch { $status = 'UNKNOWN' }
            foreach ($headerName in @('cf-ray','x-request-id','request-id')) {
                if ($requestId -ne 'UNKNOWN') { break }
                try {
                    $values = @($responseObject.Headers.GetValues($headerName))
                    if ($values.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace([string]$values[0])) { $requestId = [string]$values[0] }
                }
                catch {
                    try {
                        $value = $responseObject.Headers[$headerName]
                        if (-not [string]::IsNullOrWhiteSpace([string]$value)) { $requestId = [string]$value }
                    }
                    catch { continue }
                }
            }
            try {
                $content = $responseObject.Content
                if ($null -ne $content) { $rawProviderBody = [string]$content.ReadAsStringAsync().GetAwaiter().GetResult() }
            }
            catch { $rawProviderBody = '' }
            if ([string]::IsNullOrWhiteSpace($rawProviderBody)) {
                try { $rawProviderBody = [string]$responseObject.Body } catch { $rawProviderBody = '' }
            }
        }
        if ([string]::IsNullOrWhiteSpace($rawProviderBody)) {
            try { $rawProviderBody = [string]$requestFailure.ErrorDetails.Message } catch { $rawProviderBody = '' }
        }
        $providerErrors = ''
        if (-not [string]::IsNullOrWhiteSpace($rawProviderBody)) {
            try {
                $providerPayload = $rawProviderBody | ConvertFrom-Json -Depth 10
                $errorEntries = @(Get-S3CloudflareValue -InputObject $providerPayload -Name @('errors'))
                $messageEntries = @(Get-S3CloudflareValue -InputObject $providerPayload -Name @('messages'))
                $entries = @($errorEntries + $messageEntries | Where-Object { $null -ne $_ })
                $providerErrors = @($entries | ForEach-Object {
                    $code = [string](Get-S3CloudflareValue -InputObject $_ -Name @('code'))
                    $message = [string](Get-S3CloudflareValue -InputObject $_ -Name @('message'))
                    if ([string]::IsNullOrWhiteSpace($code)) { $message } elseif ([string]::IsNullOrWhiteSpace($message)) { $code } else { "$($code):$message" }
                } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join '|'
            }
            catch { $providerErrors = '' }
        }
        $safeMessage = Protect-S3Text $requestFailure.Exception.Message
        $safeProviderErrors = Protect-S3Text $providerErrors
        throw "CLOUDFLARE_HTTP_FAILURE: operation=$operationName method=$Method endpoint=$endpoint status=$status request_id=$requestId provider_errors=$safeProviderErrors message=$safeMessage"
    }
    if ($response.success -eq $false -or @($response.errors | Where-Object { $null -ne $_ }).Count -gt 0) {
        $safeErrors = Protect-S3Text (@($response.errors) | ConvertTo-Json -Depth 10 -Compress)
        throw "CLOUDFLARE_API_ERROR: $safeErrors"
    }
    return $response
}

function Invoke-S3CloudflareOwnedD1Mutation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Sql,
        [ValidateSet('','actor not authorized','maximum two active users','audit log is append only')][string]$ExpectedFailure = ''
    )
    if ($Context.Mode -ne 'Live' -or [string]$Context.State.currentState -ne '60_CLOUDFLARE_PROVISIONED') { throw 'D1_MUTATION_CHECKPOINT_60_LIVE_REQUIRED' }
    if ([string]::IsNullOrWhiteSpace($Sql)) { throw 'D1_MUTATION_SQL_MISSING' }
    $runId=[string]$Context.RunId
    $resource=Get-S3MapValue -Map $Context.State.resources -Name 'cloudflare'
    $marker=[string](Get-S3MapValue -Map $resource -Name 'marker')
    $databaseName=[string](Get-S3MapValue -Map $resource -Name 'd1Name')
    $databaseId=[string](Get-S3MapValue -Map $resource -Name 'd1Id')
    $accountId=[string](Get-S3MapValue -Map $resource -Name 'accountId')
    $token=[string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareToken')
    if ([string]::IsNullOrWhiteSpace($runId) -or $marker -cne $runId -or $databaseName -cne "s3cpu-$runId-d1") { throw 'D1_MUTATION_OWNERSHIP_MISMATCH' }
    if ([string]::IsNullOrWhiteSpace($databaseId) -or [string]::IsNullOrWhiteSpace($accountId) -or [string]::IsNullOrWhiteSpace($token)) { throw 'D1_MUTATION_RUNTIME_CONTEXT_MISSING' }
    if ($Sql.IndexOf($runId,[StringComparison]::Ordinal) -lt 0) { throw 'D1_MUTATION_RUN_MARKER_MISSING' }
    $uri="https://api.cloudflare.com/client/v4/accounts/$accountId/d1/database/$databaseId/query"
    try {
        $response=Invoke-S3CloudflareRest -Method POST -Uri $uri -Token $token -Body @{sql=$Sql} -TimeoutSeconds 60 -AllowOwnedD1Mutation -Operation 'cpu_gate.d1_mutation'
        $results=@($response.result)
        if ($results.Count -eq 0) { throw 'D1_MUTATION_RESULT_MISSING' }
        $failed=@($results|Where-Object{(Get-S3CloudflareValue -InputObject $_ -Name 'success') -ne $true})
        if ($failed.Count -gt 0) {
            $failureText=Protect-S3Text ($failed|ConvertTo-Json -Depth 10 -Compress)
            throw "D1_MUTATION_RESULT_FAILED: $failureText"
        }
    }
    catch {
        $safeFailure=Protect-S3Text $_.Exception.Message
        if (-not[string]::IsNullOrWhiteSpace($ExpectedFailure) -and $safeFailure -match [regex]::Escape($ExpectedFailure)) {
            return [pscustomobject]@{ExitCode=1;StdOut='';StdErr=$safeFailure;ExpectedFailure=$ExpectedFailure}
        }
        throw
    }
    return [pscustomobject]@{ExitCode=0;StdOut='';StdErr='';ExpectedFailure=$null}
}

function Assert-S3CloudflareCustomDomainBinding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$AccountId,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$WorkerName,
        [Parameter(Mandatory)][string]$PublicBaseUri
    )
    if ([string]::IsNullOrWhiteSpace($AccountId) -or [string]::IsNullOrWhiteSpace($Token) -or [string]::IsNullOrWhiteSpace($WorkerName)) {
        throw 'CUSTOM_DOMAIN_BINDING_CONTEXT_MISSING'
    }
    $parsed=$null
    if (-not [Uri]::TryCreate($PublicBaseUri,[UriKind]::Absolute,[ref]$parsed)) { throw 'PUBLIC_BASE_URI_INVALID' }
    $hostname=$parsed.IdnHost.ToLowerInvariant()
    $encodedHostname=[Uri]::EscapeDataString($hostname)
    $encodedService=[Uri]::EscapeDataString($WorkerName)
    $uri="https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/domains?hostname=$encodedHostname&service=$encodedService"
    $response=Invoke-S3CloudflareRest -Method GET -Uri $uri -Token $Token
    $bindingMatches=@(@(Get-S3CloudflareValue -InputObject $response -Name @('result'))|Where-Object {
        ([string](Get-S3CloudflareValue -InputObject $_ -Name @('hostname'))).ToLowerInvariant() -eq $hostname -and
        [string](Get-S3CloudflareValue -InputObject $_ -Name @('service')) -ceq $WorkerName
    })
    if ($bindingMatches.Count -eq 0) { throw 'CUSTOM_DOMAIN_NOT_BOUND_TO_EXPECTED_WORKER' }
    if ($bindingMatches.Count -ne 1) { throw 'CUSTOM_DOMAIN_BINDING_AMBIGUOUS' }
    $binding=$bindingMatches[0]
    $certificateId=[string](Get-S3CloudflareValue -InputObject $binding -Name @('cert_id','certificate_id'))
    $zoneId=[string](Get-S3CloudflareValue -InputObject $binding -Name @('zone_id'))
    $zoneName=[string](Get-S3CloudflareValue -InputObject $binding -Name @('zone_name'))
    if ([string]::IsNullOrWhiteSpace($certificateId)) { throw 'CUSTOM_DOMAIN_CERTIFICATE_NOT_ISSUED' }
    if ([string]::IsNullOrWhiteSpace($zoneId) -or [string]::IsNullOrWhiteSpace($zoneName)) { throw 'CUSTOM_DOMAIN_ZONE_IDENTITY_MISSING' }
    return [ordered]@{status='PASS';hostname=$hostname;worker=$WorkerName;zone=$zoneName;certificateIssued=$true}
}

function Get-S3CloudflareWorkerRemoteSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$WorkerName,[Parameter(Mandatory)][string]$Token)
    [void]$Context
    $base="https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/scripts/$WorkerName"
    $scriptSettings=(Invoke-S3CloudflareRest -Method GET -Uri "$base/script-settings" -Token $Token -Operation 'worker_snapshot.script_settings').result
    $versions=(Invoke-S3CloudflareRest -Method GET -Uri "$base/versions" -Token $Token -Operation 'worker_snapshot.versions').result
    $deployments=(Invoke-S3CloudflareRest -Method GET -Uri "$base/deployments" -Token $Token -Operation 'worker_snapshot.deployments').result
    $latestVersion=@($versions.items)|Sort-Object {$_.metadata.created_on} -Descending|Select-Object -First 1
    $latestDeployment=@($deployments.deployments)|Sort-Object {$_.created_on} -Descending|Select-Object -First 1
    $activeVersionId=$null
    if($null -ne $latestDeployment){$activeVersion=@($latestDeployment.versions|Where-Object {[int](Get-S3CloudflareValue -InputObject $_ -Name 'percentage') -eq 100}|Select-Object -First 1);if($activeVersion.Count -gt 0){$activeVersionId=[string](Get-S3CloudflareValue -InputObject $activeVersion[0] -Name 'version_id')}}
    if([string]::IsNullOrWhiteSpace($activeVersionId)){throw 'REMOTE_WORKER_ACTIVE_VERSION_MISSING'}
    $activeVersionDetail=(Invoke-S3CloudflareRest -Method GET -Uri "$base/versions/$activeVersionId" -Token $Token -Operation 'worker_snapshot.active_version').result
    $versionResources=Get-S3CloudflareValue -InputObject $activeVersionDetail -Name @('resources')
    if($null -eq $versionResources){throw 'REMOTE_WORKER_VERSION_RESOURCES_MISSING'}
    $runtime=Get-S3CloudflareValue -InputObject $versionResources -Name @('script_runtime','scriptRuntime')
    if($null -eq $runtime){throw 'REMOTE_WORKER_VERSION_RUNTIME_MISSING'}
    $bindingRecords=[Collections.Generic.List[object]]::new();$variableRecords=[Collections.Generic.List[object]]::new();$privateVars=[ordered]@{}
    foreach($binding in @((Get-S3CloudflareValue -InputObject $versionResources -Name @('bindings')))){
        $name=[string](Get-S3CloudflareValue -InputObject $binding -Name @('name'));$type=[string](Get-S3CloudflareValue -InputObject $binding -Name @('type'))
        if([string]::IsNullOrWhiteSpace($name) -or [string]::IsNullOrWhiteSpace($type)){throw 'REMOTE_WORKER_BINDING_METADATA_INVALID'}
        $record=[ordered]@{name=$name;type=$type}
        $databaseId=Get-S3CloudflareValue -InputObject $binding -Name @('database_id','databaseId','id')
        if($type -eq 'd1' -and -not [string]::IsNullOrWhiteSpace([string]$databaseId)){$record.databaseId=[string]$databaseId}
        $bindingRecords.Add($record)
        if($type -eq 'plain_text'){
            $text=[string](Get-S3CloudflareValue -InputObject $binding -Name @('text','value'))
            $privateVars[$name]=$text
            $variableRecords.Add([ordered]@{name=$name;type=$type;valueNonEmpty=(-not [string]::IsNullOrWhiteSpace($text));valueHash=$(if([string]::IsNullOrWhiteSpace($text)){$null}else{Get-S3StableHash $text})})
        }
    }
    return [pscustomobject]@{
        public=[ordered]@{
        scriptName=$WorkerName
        settings=[ordered]@{
            compatibilityDate=[string](Get-S3CloudflareValue -InputObject $runtime -Name @('compatibility_date','compatibilityDate'))
            compatibilityFlags=@(Get-S3CloudflareValue -InputObject $runtime -Name @('compatibility_flags','compatibilityFlags'))
            usageModel=[string](Get-S3CloudflareValue -InputObject $runtime -Name @('usage_model','usageModel'))
            observability=Get-S3CloudflareValue -InputObject $scriptSettings -Name @('observability')
            bindings=@($bindingRecords|Sort-Object name,type)
            variables=@($variableRecords|Sort-Object name)
        }
        deployment=[ordered]@{activeVersionId=$activeVersionId;latestVersionId=$(if($null -ne $latestVersion){[string]$latestVersion.id}else{$null});latestDeploymentId=$(if($null -ne $latestDeployment){[string]$latestDeployment.id}else{$null})}
        }
        privateVars=$privateVars
    }
}

function Restore-S3CloudflareWorkerLocalConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)]$Snapshot)
    $configPath=Join-Path $Context.Root 'workspace\worker\wrangler.json'
    $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
    if($null -eq $config.vars){$config|Add-Member -NotePropertyName vars -NotePropertyValue ([pscustomobject]@{})}
    $privateVars=Get-S3CloudflareValue -InputObject $Snapshot -Name @('privateVars')
    foreach($property in @($config.vars.PSObject.Properties.Name)){$config.vars.PSObject.Properties.Remove($property)}
    foreach($key in @($privateVars.Keys)){$config.vars|Add-Member -NotePropertyName $key -NotePropertyValue ([string]$privateVars[$key]) -Force}
    $config|ConvertTo-Json -Depth 30|Set-Content -LiteralPath $configPath -Encoding UTF8
    return $configPath
}

function New-S3CloudflareObservabilityTokenProvider {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    param([Parameter(Mandatory)]$Context)
    if(-not $PSCmdlet.ShouldProcess([string]$Context.RunId,'Create in-memory Cloudflare observability provider')){return}
    $capturedContext=$Context
    return {
        param([string]$AccountId,[string]$WorkerName)
        [void]$AccountId
        [void]$WorkerName
        $token=[string](Get-S3MapValue -Map $capturedContext.RuntimeSecrets -Name 'cloudflareToken')
        if([string]::IsNullOrWhiteSpace($token)){throw 'CLOUDFLARE_OBSERVABILITY_SESSION_REQUIRED'}
        return $token
    }.GetNewClosure()
}

function Invoke-S3CloudflareRuntimeRehydration {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$WorkerName,[Parameter(Mandatory)][string]$Token,[Parameter(Mandatory)][scriptblock]$ObservabilityTokenProvider)
    $snapshot=Get-S3CloudflareWorkerRemoteSnapshot -Context $Context -AccountId $AccountId -WorkerName $WorkerName -Token $Token
    $variables=@((Get-S3CloudflareValue -InputObject $snapshot.public.settings -Name @('variables')))
    $nonce=@($variables|Where-Object {[string]$_.name -eq 'TEST_RESET_NONCE'})|Select-Object -First 1
    if($null -eq $nonce -or [string]$nonce.type -ne 'plain_text' -or $nonce.valueNonEmpty -ne $true){throw 'WORKER_TEST_RESET_NONCE_INVALID'}
    $newObservabilityToken=[string](& $ObservabilityTokenProvider $AccountId $WorkerName)
    if([string]::IsNullOrWhiteSpace($newObservabilityToken)){throw 'WORKERS_OBSERVABILITY_CREDENTIAL_REQUIRED'}
    [void](Test-S3WorkersObservabilityAuthorization -AccountId $AccountId -Token $newObservabilityToken -WorkerName $WorkerName)
    $Context.RuntimeSecrets.testResetNonce=[string](Get-S3CloudflareValue -InputObject $snapshot.privateVars -Name @('TEST_RESET_NONCE'))
    $Context.RuntimeSecrets.cloudflareObservabilityToken=$newObservabilityToken
    if([string]::IsNullOrWhiteSpace([string]$Context.RuntimeSecrets.testResetNonce)){throw 'WORKER_TEST_RESET_NONCE_READ_FAILED'}
    return [ordered]@{status='PASS';worker=$WorkerName;nonce='PRESENT';nonceType='plain_text';observability='AUTHORIZED';secrets='MEMORY_ONLY';remoteSnapshot=$snapshot.public}
}

function Test-S3CloudflareWorkerRemoteSnapshot {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Before,[Parameter(Mandatory)]$After)
    $beforePublic=Get-S3CloudflareValue -InputObject $Before -Name @('public');if($null -ne $beforePublic){$Before=$beforePublic}
    $afterPublic=Get-S3CloudflareValue -InputObject $After -Name @('public');if($null -ne $afterPublic){$After=$afterPublic}
    if([string](Get-S3CloudflareValue -InputObject $Before -Name @('scriptName')) -ne [string](Get-S3CloudflareValue -InputObject $After -Name @('scriptName'))){return $false}
    $beforeSettings=(Get-S3CloudflareValue -InputObject $Before -Name @('settings')|ConvertTo-Json -Depth 30 -Compress)
    $afterSettings=(Get-S3CloudflareValue -InputObject $After -Name @('settings')|ConvertTo-Json -Depth 30 -Compress)
    return $beforeSettings -eq $afterSettings
}

function Invoke-S3CloudflarePagedGet {
    param([Parameter(Mandatory)][string]$Uri,[Parameter(Mandatory)][string]$Token,[ValidateRange(1,100)][int]$PerPage=50)
    $items = [Collections.Generic.List[object]]::new()
    $pagesRead = [Collections.Generic.List[int]]::new()
    $page = 1
    $maxPages = 1000
    $establishedPerPage = $null
    $establishedTotalCount = $null
    $establishedTotalPages = $null
    $reportedTotalCount = $null
    while ($true) {
        if ($page -gt $maxPages) { throw "PAGINATION_MAX_PAGES_EXCEEDED: page=$page" }
        if ($pagesRead.Contains($page)) { throw "PAGINATION_PAGE_REPEATED: page=$page" }
        $separator = if ($Uri.Contains('?')) {'&'} else {'?'}
        $response = Invoke-S3CloudflareRest -Method GET -Uri "$Uri${separator}page=$page&per_page=$PerPage" -Token $Token
        if ($response.success -eq $false -or @($response.errors | Where-Object { $null -ne $_ }).Count -gt 0) { throw "CLOUDFLARE_PAGED_API_ERROR: page=$page" }
        $pagesRead.Add($page)
        $currentResult = @($response.result)
        $pageCount = $currentResult.Count
        foreach ($item in $currentResult) { $items.Add($item) }
        $resultInfo = Get-S3CloudflareValue -InputObject $response -Name @('result_info')
        if ($null -eq $resultInfo) {
            if ($page -gt 1) { throw "PAGINATION_METADATA_MISSING: page=$page" }
            if ($pageCount -ge $PerPage) { throw "PAGINATION_METADATA_MISSING: page=$page" }
            break
        }
        $reportedPageRaw = Get-S3CloudflareValue -InputObject $resultInfo -Name @('page')
        $totalPagesRaw = Get-S3CloudflareValue -InputObject $resultInfo -Name @('total_pages')
        $perPageRaw = Get-S3CloudflareValue -InputObject $resultInfo -Name @('per_page')
        $totalCountRaw = Get-S3CloudflareValue -InputObject $resultInfo -Name @('total_count')
        $countRaw = Get-S3CloudflareValue -InputObject $resultInfo -Name @('count')

        $reportedPage = $null
        if ($null -ne $reportedPageRaw) {
            $parsedPage = 0
            if (-not [int]::TryParse([string]$reportedPageRaw, [ref]$parsedPage) -or $parsedPage -lt 1) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            $reportedPage = $parsedPage
        }
        $reportedTotalPages = $null
        if ($null -ne $totalPagesRaw) {
            $parsedTotalPages = 0
            if (-not [int]::TryParse([string]$totalPagesRaw, [ref]$parsedTotalPages) -or $parsedTotalPages -lt 0) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            $reportedTotalPages = $parsedTotalPages
            if ($null -eq $establishedTotalPages) { $establishedTotalPages = $reportedTotalPages }
            elseif ($reportedTotalPages -ne $establishedTotalPages) { throw "PAGINATION_METADATA_DRIFT: total_pages changed from $establishedTotalPages to $reportedTotalPages" }
        }
        $reportedPerPage = $null
        if ($null -ne $perPageRaw) {
            $parsedPerPage = 0
            if (-not [int]::TryParse([string]$perPageRaw, [ref]$parsedPerPage) -or $parsedPerPage -lt 1) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            $reportedPerPage = $parsedPerPage
            if ($null -eq $establishedPerPage) { $establishedPerPage = $reportedPerPage }
            elseif ($reportedPerPage -ne $establishedPerPage) { throw "PAGINATION_METADATA_DRIFT: per_page changed from $establishedPerPage to $reportedPerPage" }
        }
        $reportedTotalCount = $null
        if ($null -ne $totalCountRaw) {
            $parsedTotalCount = 0L
            if (-not [long]::TryParse([string]$totalCountRaw, [ref]$parsedTotalCount) -or $parsedTotalCount -lt 0) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            $reportedTotalCount = $parsedTotalCount
            if ($null -eq $establishedTotalCount) { $establishedTotalCount = $reportedTotalCount }
            elseif ($reportedTotalCount -ne $establishedTotalCount) { throw "PAGINATION_METADATA_DRIFT: total_count changed from $establishedTotalCount to $reportedTotalCount" }
        }
        if ($null -ne $countRaw) {
            $parsedCount = 0
            if (-not [int]::TryParse([string]$countRaw, [ref]$parsedCount) -or $parsedCount -lt 0) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            if ($parsedCount -ne $pageCount) { throw "PAGINATION_COUNT_MISMATCH: expected=$pageCount actual=$parsedCount" }
        }

        if ($null -ne $reportedPage -and $reportedPage -ne $page) { throw "PAGINATION_PAGE_MISMATCH: expected=$page actual=$reportedPage" }
        $effectivePerPage = if ($null -ne $reportedPerPage) { $reportedPerPage } else { $PerPage }
        if ($pageCount -gt $effectivePerPage) { throw "PAGINATION_RESULT_COUNT_EXCEEDED: page=$page count=$pageCount per_page=$effectivePerPage" }

        $effectiveTotalPages = 0
        if ($null -eq $reportedTotalPages) {
            if ($null -eq $reportedPage -or $null -eq $reportedPerPage -or $null -eq $reportedTotalCount) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            if ($reportedTotalCount -eq 0) {
                if ($reportedPage -ne 1) { throw "PAGINATION_PAGE_MISMATCH: expected=1 actual=$reportedPage" }
                if ($pageCount -ne 0) { throw "PAGINATION_CONTRADICTION: total_count=0 count=$pageCount" }
                break
            }
            $effectiveTotalPages = [int][Math]::Ceiling([double]$reportedTotalCount / [double]$effectivePerPage)
        }
        else {
            if ($null -eq $reportedPage) { throw "PAGINATION_METADATA_INCOMPLETE: page=$page" }
            if ($reportedTotalPages -lt $page -and -not ($reportedTotalPages -eq 0 -and $page -eq 1 -and $pageCount -eq 0)) {
                throw "PAGINATION_TOTAL_INVALID: page=$page total=$reportedTotalPages"
            }
            if ($null -ne $reportedTotalCount -and $null -ne $reportedPerPage) {
                if ($reportedTotalCount -eq 0) {
                    if ($reportedTotalPages -notin @(0, 1)) { throw "PAGINATION_CONTRADICTION: total_count=0 total_pages=$reportedTotalPages" }
                    if ($pageCount -ne 0) { throw "PAGINATION_CONTRADICTION: total_count=0 count=$pageCount" }
                }
                else {
                    $derivedTotalPages = [int][Math]::Ceiling([double]$reportedTotalCount / [double]$effectivePerPage)
                    if ($reportedTotalPages -ne $derivedTotalPages) { throw "PAGINATION_CONTRADICTION: total_pages=$reportedTotalPages derived=$derivedTotalPages" }
                }
            }
            elseif ($null -ne $reportedTotalCount) {
                if ($reportedTotalCount -eq 0 -and ($reportedTotalPages -notin @(0, 1) -or $pageCount -ne 0)) { throw "PAGINATION_CONTRADICTION: total_count=0 total_pages=$reportedTotalPages" }
            }
            $effectiveTotalPages = $reportedTotalPages
        }

        if ($page -lt $effectiveTotalPages) {
            if ($pageCount -lt $effectivePerPage) { throw "PAGINATION_INTERMEDIATE_PAGE_INCOMPLETE: page=$page count=$pageCount expected=$effectivePerPage" }
        }

        if ($page -ge $effectiveTotalPages) {
            if ($null -ne $reportedTotalCount -and $items.Count -ne $reportedTotalCount) { throw "PAGINATION_TOTAL_COUNT_MISMATCH: collected=$($items.Count) expected=$reportedTotalCount" }
            break
        }
        $page++
    }
    if ($null -ne $reportedTotalCount -and $items.Count -ne $reportedTotalCount) { throw "PAGINATION_TOTAL_COUNT_MISMATCH: collected=$($items.Count) expected=$reportedTotalCount" }
    return [ordered]@{status='PASS';items=@($items);pagesRead=@($pagesRead);paginationComplete=$true}
}

function Test-S3CloudflareSession {
    param([Parameter(Mandatory)][string]$Token,[Parameter(Mandatory)][string]$TokenType,[Parameter(Mandatory)][string]$SelectedAccountId)
    if ($TokenType -eq 'oauth') {
        $accounts = Get-S3CloudflareAccounts -Token $Token
        if ($null -eq $accounts -or $accounts.status -ne 'PASS' -or $accounts.paginationComplete -ne $true -or $null -eq $accounts.items) { throw 'CLOUDFLARE_OAUTH_ACCOUNTS_INVALID' }
        [void](Select-S3CloudflareAccount -Accounts @($accounts.items) -SelectedAccountId $SelectedAccountId)
        return [ordered]@{status='PASS';session='OAUTH_ACCOUNTS_VALID';accounts=$accounts}
    }
    if ($TokenType -ne 'api_token') { throw 'CLOUDFLARE_TOKEN_TYPE_UNKNOWN' }
    $response = Invoke-S3CloudflareRest -Method GET -Uri 'https://api.cloudflare.com/client/v4/user/tokens/verify' -Token $Token
    $status = [string](Get-S3CloudflareValue -InputObject $response.result -Name @('status'))
    if ($status -notin @('active','valid')) { throw "CLOUDFLARE_SESSION_INVALID: $status" }
    return [ordered]@{status='PASS';session='API_TOKEN_VALID'}
}

function Get-S3CloudflareAccounts {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns','Get-S3CloudflareAccounts',Justification='Established command returns an account collection.')]
    param([Parameter(Mandatory)][string]$Token)
    return Invoke-S3CloudflarePagedGet -Uri 'https://api.cloudflare.com/client/v4/accounts' -Token $Token
}

function Select-S3CloudflareAccount {
    param([Parameter(Mandatory)][object[]]$Accounts,[string]$SelectedAccountId)
    if ([string]::IsNullOrWhiteSpace($SelectedAccountId)) {
        if ($Accounts.Count -gt 1) { throw 'MULTIPLE_CLOUDFLARE_ACCOUNTS_REQUIRE_EXPLICIT_SELECTION' }
        throw 'CLOUDFLARE_ACCOUNT_ID_SELECTION_REQUIRED'
    }
    $matchingAccounts = @($Accounts | Where-Object {[string](Get-S3CloudflareValue -InputObject $_ -Name @('id')) -eq $SelectedAccountId})
    if ($matchingAccounts.Count -ne 1) { throw 'SELECTED_CLOUDFLARE_ACCOUNT_NOT_FOUND' }
    return $matchingAccounts[0]
}

function Get-S3RedactedAccountId {
    param([Parameter(Mandatory)][string]$AccountId)
    if ($AccountId.Length -le 10) { return '***' }
    return "$($AccountId.Substring(0,6))***$($AccountId.Substring($AccountId.Length-4))"
}

function Test-S3CloudflareSubscriptions {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns','Test-S3CloudflareSubscriptions',Justification='Established command validates a subscription collection.')]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Subscriptions
    )
    $failures = [Collections.Generic.List[string]]::new()
    foreach ($subscription in $Subscriptions) {
        $text = $subscription | ConvertTo-Json -Depth 20 -Compress
        $status = [string](Get-S3CloudflareValue -InputObject $subscription -Name @('status','state'))
        $price = Get-S3CloudflareValue -InputObject $subscription -Name @('price','amount')
        if ($status -match '(?i)trial') { $failures.Add('TRIAL_SUBSCRIPTION') }
        if ($status -match '(?i)awaiting.?payment') { $failures.Add('AWAITING_PAYMENT_SUBSCRIPTION') }
        if ($text -match '(?i)workers.?paid|workers.?standard|pay.?as.?you.?go|enterprise|paid_plan') { $failures.Add('PAID_SUBSCRIPTION') }
        if ($null -ne $price) {
            $numericPrice = 0.0
            if ([double]::TryParse([string]$price,[ref]$numericPrice) -and $numericPrice -gt 0) { $failures.Add('PAID_SUBSCRIPTION') }
        }
    }
    if ($failures.Count -gt 0) { throw (@($failures | Select-Object -Unique | Sort-Object) -join ',') }
    return [ordered]@{status='PASS';subscriptionCount=$Subscriptions.Count}
}

function Test-S3CloudflarePayGo {
    param([AllowNull()][object]$PayGoResult)
    if ($null -eq $PayGoResult) { throw 'PAYGO_UNKNOWN' }
    $alpha = Get-S3CloudflareValue -InputObject $PayGoResult -Name @('alpha','is_alpha')
    $status = [string](Get-S3CloudflareValue -InputObject $PayGoResult -Name @('status','state'))
    if ($alpha -eq $true -or $status -match '(?i)alpha|unknown|indeterminate') { throw 'PAYGO_UNKNOWN' }
    $covered = Get-S3CloudflareValue -InputObject $PayGoResult -Name @('covered','enabled')
    $subscriptions = @(Get-S3CloudflareValue -InputObject $PayGoResult -Name @('subscriptions'))
    if ($covered -eq $true -or $subscriptions.Count -gt 0) { throw 'PAYGO_ENABLED' }
    return [ordered]@{status='PASS';payGo='DISABLED'}
}

function Test-S3WorkersAccountSettings {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns','Test-S3WorkersAccountSettings',Justification='Cloudflare API names this resource account settings.')]
    param([AllowNull()][object]$Settings)
    if ($null -eq $Settings) { throw 'WORKERS_SETTINGS_UNKNOWN' }
    $usageModel = [string](Get-S3CloudflareValue -InputObject $Settings -Name @('default_usage_model','usage_model','usageModel'))
    if ([string]::IsNullOrWhiteSpace($usageModel)) { throw 'WORKERS_SETTINGS_UNKNOWN' }
    if ($usageModel -notin @('bundled','standard','free')) { throw "WORKERS_SETTINGS_UNACCEPTABLE: $usageModel" }
    return [ordered]@{status='PASS';usageModel=$usageModel}
}

function Test-S3WorkersObservabilityAuthorization {
    param([Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$Token,[string]$WorkerName)
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/observability/telemetry/query"
    $body = Get-S3WorkersObservabilityQueryBody -QueryId 's3cpu-preflight' -FromUtc ([DateTime]::UtcNow.AddMinutes(-5)) -ToUtc ([DateTime]::UtcNow) -Limit 1 -WorkerName $WorkerName
    $response = Invoke-S3CloudflareRest -Method POST -Uri $uri -Token $Token -Body $body
    if ($response.success -eq $false -or @($response.errors | Where-Object { $null -ne $_ }).Count -gt 0) { throw 'WORKERS_OBSERVABILITY_NOT_AUTHORIZED' }
    return [ordered]@{status='PASS';authorized=$true}
}

function Test-S3WorkersDevSubdomain {
    param([AllowNull()][object]$SubdomainResult)
    if ($null -eq $SubdomainResult) { throw 'WORKERS_DEV_SUBDOMAIN_UNAVAILABLE' }
    $subdomain = [string](Get-S3CloudflareValue -InputObject $SubdomainResult -Name @('subdomain'))
    $enabled = Get-S3CloudflareValue -InputObject $SubdomainResult -Name @('enabled')
    if ([string]::IsNullOrWhiteSpace($subdomain) -or $enabled -eq $false) { throw 'WORKERS_DEV_SUBDOMAIN_UNAVAILABLE' }
    return [ordered]@{status='PASS';available=$true}
}

function Show-S3CloudflareBillingPage {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    param([Parameter(Mandatory)][string]$AccountId)
    $uri = "https://dash.cloudflare.com/$AccountId/billing"
    if ($PSCmdlet.ShouldProcess($uri,'Open Cloudflare Billing page for read-only user attestation')) { Start-Process $uri }
    return $uri
}

function Confirm-S3CloudflareBillingAttestation {
    param([scriptblock]$ReadChoice = {Read-Host 'اختر 1 أو 2'})
    Write-Information -InformationAction Continue '1. نعم، لا توجد خطة مدفوعة ولا وسيلة دفع.'
    Write-Information -InformationAction Continue '2. إلغاء وإيقاف التنفيذ.'
    $choice = [string](& $ReadChoice)
    if ($choice -eq '1') { return [ordered]@{status='YES';accepted=$true} }
    if ($choice -eq '2') { return [ordered]@{status='CANCELLED';accepted=$false} }
    throw 'INVALID_BILLING_ATTESTATION_CHOICE'
}

function Get-S3WorkersObservabilityQueryBody {
    param(
        [Parameter(Mandatory)][string]$QueryId,
        [Parameter(Mandatory)][datetime]$FromUtc,
        [Parameter(Mandatory)][datetime]$ToUtc,
        [string]$WorkerName,
        [ValidateRange(1,100)][int]$Limit = 100,
        [object[]]$Filters = @(),
        [string]$Offset
    )
    if ($ToUtc -le $FromUtc) { throw 'WORKERS_OBSERVABILITY_TIMEFRAME_INVALID' }
    $body = [ordered]@{
        queryId = $QueryId
        timeframe = [ordered]@{
            from = ([DateTimeOffset]$FromUtc.ToUniversalTime()).ToUnixTimeMilliseconds()
            to = ([DateTimeOffset]$ToUtc.ToUniversalTime()).ToUnixTimeMilliseconds()
        }
        dry = $true
        view = 'events'
        limit = $Limit
        parameters = [ordered]@{
            datasets = @('cloudflare-workers')
            filterCombination = 'and'
            filters = @($Filters)
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($WorkerName)) {
        $body.parameters.filters = @([ordered]@{kind='filter';key='$metadata.service';operation='eq';type='string';value=$WorkerName}) + @($Filters)
    }
    if (-not [string]::IsNullOrWhiteSpace($Offset)) { $body.offset = $Offset }
    return $body
}

function Get-S3TelemetryPageItems {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns','Get-S3TelemetryPageItems',Justification='Established command returns telemetry page items.')]
    param([AllowNull()][object]$Response)
    $result = Get-S3CloudflareValue -InputObject $Response -Name @('result')
    if ($null -eq $result) { return @() }
    $eventsEnvelope = Get-S3CloudflareValue -InputObject $result -Name @('events')
    if ($null -ne $eventsEnvelope) {
        $events = Get-S3CloudflareValue -InputObject $eventsEnvelope -Name @('events')
        if ($null -ne $events) { return @($events) }
        if ($eventsEnvelope -is [Collections.IEnumerable] -and $eventsEnvelope -isnot [string] -and $eventsEnvelope -isnot [Collections.IDictionary]) { return @($eventsEnvelope) }
    }
    $data = Get-S3CloudflareValue -InputObject $result -Name @('data','rows')
    if ($null -ne $data) { return @($data) }
    if ($result -is [Collections.IEnumerable] -and $result -isnot [string]) { return @($result) }
    return @()
}

function Test-S3TelemetrySamplingValue {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value -or $Value -eq $false) { return $false }
    return ([string]$Value) -notin @('','0','1','none','full','false')
}

function ConvertTo-S3WorkersTelemetryRecord {
    param([Parameter(Mandatory)][object]$Item)
    $attributes = Get-S3CloudflareValue -InputObject $Item -Name @('attributes')
    if ($null -eq $attributes) { $attributes = $Item }
    $metadata = Get-S3CloudflareValue -InputObject $Item -Name @('$metadata','metadata')
    $workers = Get-S3CloudflareValue -InputObject $Item -Name @('$workers','workers')
    $source = Get-S3CloudflareValue -InputObject $Item -Name @('source')
    if ($source -is [string]) {
        try { $source = $source | ConvertFrom-Json -Depth 20 } catch { $source = $null }
    }
    $correlation = Get-S3CloudflareValue -InputObject $source -Name @('s3Correlation','correlation')
    if ($null -eq $correlation) { $correlation = Get-S3CloudflareValue -InputObject $source -Name @('s3') }
    $runId = Get-S3CloudflareValue -InputObject $correlation -Name @('runId','run_id')
    if ([string]::IsNullOrWhiteSpace([string]$runId)) { $runId = Get-S3CloudflareValue -InputObject $attributes -Name @('$metadata.runId','metadata.runId','runId','s3.run_id') }
    $requestId = Get-S3CloudflareValue -InputObject $correlation -Name @('requestId','request_id')
    if ([string]::IsNullOrWhiteSpace([string]$requestId)) { $requestId = Get-S3CloudflareValue -InputObject $attributes -Name @('$metadata.requestId','metadata.requestId','requestId','s3.request_id') }
    $scenario = Get-S3CloudflareValue -InputObject $correlation -Name @('scenario')
    if ([string]::IsNullOrWhiteSpace([string]$scenario)) { $scenario = Get-S3CloudflareValue -InputObject $attributes -Name @('$metadata.scenario','metadata.scenario','scenario','s3.scenario') }
    $cloudflareRequestId = Get-S3CloudflareValue -InputObject $workers -Name @('requestId')
    if ([string]::IsNullOrWhiteSpace([string]$cloudflareRequestId)) { $cloudflareRequestId = Get-S3CloudflareValue -InputObject $metadata -Name @('requestId') }
    if ([string]::IsNullOrWhiteSpace([string]$cloudflareRequestId)) { $cloudflareRequestId = Get-S3CloudflareValue -InputObject $attributes -Name @('$workers.requestId','workers.requestId','cloudflare.ray_id','rayId') }
    $cpuMs = Get-S3CloudflareValue -InputObject $workers -Name @('cpuTimeMs')
    if ($null -eq $cpuMs) { $cpuMs = Get-S3CloudflareValue -InputObject $attributes -Name @('$workers.cpuTimeMs','workers.cpuTimeMs','cloudflare.cpu_time_ms','cpuTimeMs') }
    $wallMs = Get-S3CloudflareValue -InputObject $workers -Name @('wallTimeMs')
    if ($null -eq $wallMs) { $wallMs = Get-S3CloudflareValue -InputObject $attributes -Name @('$workers.wallTimeMs','workers.wallTimeMs','cloudflare.wall_time_ms','wallTimeMs') }
    $outcome = Get-S3CloudflareValue -InputObject $workers -Name @('outcome')
    if ($null -eq $outcome) { $outcome = Get-S3CloudflareValue -InputObject $attributes -Name @('$workers.outcome','workers.outcome','cloudflare.outcome','outcome') }
    return [ordered]@{
        runId=[string]$runId
        requestId=[string]$requestId
        scenario=[string]$scenario
        cloudflareRequestId=[string]$cloudflareRequestId
        cpu_ms=$cpuMs
        wall_ms=$wallMs
        outcome=[string]$outcome
        sampling=Get-S3CloudflareValue -InputObject $attributes -Name @('sampling','sampleRate','sampling_rate')
        abrLevel=Get-S3CloudflareValue -InputObject $attributes -Name @('abr_level','abrLevel')
        truncated=Get-S3CloudflareValue -InputObject $attributes -Name @('truncated','isTruncated')
        raw=$Item
    }
}

function ConvertTo-S3TelemetryEventPart {
    param([Parameter(Mandatory)][object]$Item)
    $record = ConvertTo-S3WorkersTelemetryRecord -Item $Item
    $attributes = Get-S3CloudflareValue -InputObject $Item -Name @('attributes')
    if ($null -eq $attributes) { $attributes = $Item }
    $metadata = Get-S3CloudflareValue -InputObject $Item -Name @('$metadata','metadata')
    $metadataType = [string](Get-S3CloudflareValue -InputObject $metadata -Name @('type'))
    $source = Get-S3CloudflareValue -InputObject $Item -Name @('source')
    if ($source -is [string]) { try { $source = $source | ConvertFrom-Json -Depth 20 } catch { $source = $null } }
    $cacheState = Get-S3CloudflareValue -InputObject $source -Name @('cacheState','cache_state')
    if ($null -eq $cacheState) { $cacheState = Get-S3CloudflareValue -InputObject $attributes -Name @('cacheState','cache_state') }
    $correlationPresent = -not [string]::IsNullOrWhiteSpace($record.runId) -and -not [string]::IsNullOrWhiteSpace($record.requestId) -and -not [string]::IsNullOrWhiteSpace($record.scenario)
    $isCustomLog = $metadataType -in @('cf-worker-log','cf-worker')
    $isInvocation = $metadataType -eq 'cf-worker-event'
    if ([string]::IsNullOrWhiteSpace($metadataType)) {
        $isCustomLog = $correlationPresent
        $isInvocation = ($null -ne $record.cpu_ms -or $null -ne $record.wall_ms -or -not [string]::IsNullOrWhiteSpace($record.outcome))
    }
    $hasCorrelation = $isCustomLog -and $correlationPresent
    $hasInvocation = $isInvocation
    return [pscustomobject]@{record=$record;cloudflareRequestId=[string]$record.cloudflareRequestId;hasCorrelation=$hasCorrelation;hasInvocation=$hasInvocation;cacheState=[string]$cacheState;metadataType=$metadataType;raw=$Item}
}
function Merge-S3WorkerTelemetryEvent {
    param([AllowNull()][object[]]$Items,[Parameter(Mandatory)][string]$RunId,[Parameter(Mandatory)][string]$Scenario)
    $groups = [ordered]@{}
    $index = 0
    foreach ($item in @($Items)) {
        $part = ConvertTo-S3TelemetryEventPart -Item $item
        $isCurrentCorrelation = $part.hasCorrelation -and [string]$part.record.runId -eq $RunId -and [string]$part.record.scenario -eq $Scenario
        $key = $part.cloudflareRequestId
        if ([string]::IsNullOrWhiteSpace($key)) { $key = "__missing_cf_request_$index" }
        if (-not $groups.Contains($key)) { $groups[$key] = [ordered]@{parts=@();custom=@();invocation=@()} }
        $groups[$key].parts += [pscustomobject]@{part=$part;isCurrentCorrelation=$isCurrentCorrelation}
        $index++
    }
    $normalized = [Collections.Generic.List[object]]::new()
    foreach ($key in $groups.Keys) {
        $group = $groups[$key]
        foreach ($entry in @($group.parts)) {
            if ($entry.isCurrentCorrelation) { $group.custom += $entry.part }
            if ($entry.part.hasInvocation) { $group.invocation += $entry.part }
        }
        if ($group.custom.Count -eq 0) { continue }
        $custom = $group.custom[0]
        $invocation = if ($group.invocation.Count -gt 0) { $group.invocation[0] } else { $null }
        $record = [ordered]@{} + $custom.record
        if ($null -ne $invocation) {
            $record.cpu_ms = $invocation.record.cpu_ms
            $record.wall_ms = $invocation.record.wall_ms
            $record.outcome = $invocation.record.outcome
        }
        if (-not [string]::IsNullOrWhiteSpace($custom.cacheState)) { $record.cache_state = $custom.cacheState }
        $record.hasCorrelation = $true
        $record.hasInvocation = ($null -ne $invocation)
        $record.duplicateCorrelation = ($group.custom.Count -gt 1)
        $record.duplicateInvocation = ($group.invocation.Count -gt 1)
        $record.cloudflareRequestId = [string]$key
        $normalized.Add($record)
    }
    return @($normalized)
}
function Invoke-S3WorkersTelemetryQuery {
    param(
        [Parameter(Mandatory)][string]$AccountId,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$Scenario,
        [Parameter(Mandatory)][string]$WorkerName,
        [Parameter(Mandatory)][datetime]$FromUtc,
        [ValidateRange(1,100)][int]$PageSize=100
    )
    if ([string]::IsNullOrWhiteSpace($WorkerName)) { throw 'WORKERS_OBSERVABILITY_WORKER_REQUIRED' }
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/observability/telemetry/query"
    $rawItems = [Collections.Generic.List[object]]::new()
    $errors = [Collections.Generic.List[string]]::new()
    $seenOffsets = [Collections.Generic.HashSet[string]]::new()
    $page = 1; $offset = $null; $truncated = $false; $samplingDetected = $false; $paginationComplete = $true
    $fromUtc = $FromUtc.ToUniversalTime(); $toUtc = [DateTime]::UtcNow
    if ($toUtc -le $fromUtc) { throw 'WORKERS_OBSERVABILITY_TIMEFRAME_INVALID' }
    $queryId = "s3cpu-$RunId-$Scenario"
    while ($true) {
        $body = Get-S3WorkersObservabilityQueryBody -QueryId $queryId -FromUtc $fromUtc -ToUtc $toUtc -Limit $PageSize -Offset $offset -WorkerName $WorkerName
        try { $response = Invoke-S3CloudflareRest -Method POST -Uri $uri -Token $Token -Body $body }
        catch {
            $errors.Add("API_ERROR:$($_.Exception.Message)")
            return [ordered]@{status='FAIL';records=@();rawCount=$rawItems.Count;pageCount=$page;paginationComplete=$false;truncated=$truncated;samplingDetected=$samplingDetected;apiSuccess=$false;errors=@($errors)}
        }
        if ($response.success -eq $false -or @($response.errors | Where-Object { $null -ne $_ }).Count -gt 0) {
            $errors.Add('API_ERROR')
            return [ordered]@{status='FAIL';records=@();rawCount=$rawItems.Count;pageCount=$page;paginationComplete=$false;truncated=$truncated;samplingDetected=$samplingDetected;apiSuccess=$false;errors=@($errors)}
        }
        $result = Get-S3CloudflareValue -InputObject $response -Name @('result')
        $statistics = Get-S3CloudflareValue -InputObject $result -Name @('statistics')
        $abrLevel = Get-S3CloudflareValue -InputObject $statistics -Name @('abr_level','abrLevel')
        if ($null -eq $abrLevel) { $abrLevel = 1 }
        $abrNumber = 0.0
        if (-not [double]::TryParse([string]$abrLevel,[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture,[ref]$abrNumber)) { $samplingDetected = $true }
        elseif ($abrNumber -gt 1) { $samplingDetected = $true }
        $responseJson = $response | ConvertTo-Json -Depth 40 -Compress
        if ($responseJson -match '"truncated"\s*:\s*true') { $truncated = $true }
        $pageItems = @(Get-S3TelemetryPageItems -Response $response)
        foreach ($item in $pageItems) {
            $rawItems.Add($item)
            $itemTruncated = Get-S3CloudflareValue -InputObject $item -Name @('truncated','isTruncated')
            if ($itemTruncated -eq $true) { $truncated = $true }
        }
        $eventsEnvelope = Get-S3CloudflareValue -InputObject $result -Name @('events')
        $totalCount = Get-S3CloudflareValue -InputObject $eventsEnvelope -Name @('count')
        $totalCountKnown = $null -ne $totalCount
        if ($pageItems.Count -eq 0) {
            if (-not $totalCountKnown -or [int]$totalCount -eq 0) { break }
            $paginationComplete=$false;$errors.Add('PAGINATION_NEXT_PAGE_MISSING');break
        }
        $hasNextPage = $pageItems.Count -ge $PageSize
        if (-not $hasNextPage -and $totalCountKnown -and [int]$totalCount -gt $rawItems.Count) { $hasNextPage = $true }
        if (-not $hasNextPage) { break }
        $lastMetadata = Get-S3CloudflareValue -InputObject $pageItems[$pageItems.Count - 1] -Name @('$metadata','metadata')
        $nextOffset = [string](Get-S3CloudflareValue -InputObject $lastMetadata -Name @('id'))
        if ([string]::IsNullOrWhiteSpace($nextOffset)) { $paginationComplete=$false;$errors.Add('PAGINATION_NEXT_PAGE_MISSING');break }
        if (-not $seenOffsets.Add($nextOffset)) { $paginationComplete=$false;$errors.Add('PAGINATION_CURSOR_REPEATED');break }
        $offset = $nextOffset; $page++
    }
    $records = @(Merge-S3WorkerTelemetryEvent -Items @($rawItems) -RunId $RunId -Scenario $Scenario)
    $status = if ($paginationComplete -and -not $truncated -and -not $samplingDetected -and $errors.Count -eq 0) {'PASS'} else {'FAIL'}
    return [ordered]@{status=$status;records=$records;rawCount=$rawItems.Count;pageCount=$page;paginationComplete=$paginationComplete;truncated=$truncated;samplingDetected=$samplingDetected;abrLevel=$abrNumber;apiSuccess=$true;errors=@($errors)}
}

function Show-S3CloudflarePreflightRecord {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][object]$Record)
    $directory = Join-Path $Context.Root 'reports'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $path = Join-Path $directory 'cloudflare-read-only-preflight.json'
    $Record | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Invoke-S3CloudflareReadOnlyPreflight {
    param(
        [Parameter(Mandatory)]$Context,
        [string]$SelectedAccountId,
        [string]$Token,
        [string]$TokenType,
        [scriptblock]$AttestationChoice,
        [switch]$SkipOpenBillingPage,
        [string]$BillingToken,
        [string]$ObservabilityToken
    )
    if ($Context.Mode -eq 'Simulation') {
        $record = [ordered]@{runId=$Context.RunId;attestedAtUtc=[DateTime]::UtcNow.ToString('o');accountId='mock-a***ount';automated=[ordered]@{session='PASS';accounts='PASS';subscriptions='PASS';payGo='PASS';workersSettings='PASS';observability='PASS';workers='PASS';d1='PASS';workersDev='PASS'};attestation='YES';status='PASS';writeChecksDeferred='Deferred to separately approved live execution.'}
        Set-S3MapValue -Map $Context.State.results -Name 'cloudflarePreflight' -Value $record
        [void](Show-S3CloudflarePreflightRecord -Context $Context -Record $record)
        return $record
    }
    if ($Context.Mode -ne 'Live') { return [ordered]@{status='NOT_EXECUTED';reason='NON_LIVE_MODE'} }
    $selected = $SelectedAccountId
    $redactedAccountId = if ([string]::IsNullOrWhiteSpace($selected)) {'UNSELECTED'} else {Get-S3RedactedAccountId -AccountId $selected}
    $automated = [ordered]@{}; $attestationResult = 'NOT_REACHED'
    $resolvedBillingToken = $BillingToken
    $resolvedObservabilityToken = $ObservabilityToken
    try {
        if ([string]::IsNullOrWhiteSpace($Token)) {
            $tokenRecord = Get-S3CloudflareToken -Context $Context
            $Token = [string]$tokenRecord.token
            $TokenType = [string]$tokenRecord.type
        }
        if ([string]::IsNullOrWhiteSpace($TokenType)) { throw 'CLOUDFLARE_TOKEN_TYPE_UNKNOWN' }
        $TokenType = $TokenType.ToLowerInvariant()
        if ($TokenType -notin @('oauth','api_token')) { throw 'CLOUDFLARE_TOKEN_TYPE_UNKNOWN' }
        $session = Test-S3CloudflareSession -Token $Token -TokenType $TokenType -SelectedAccountId $selected; $automated.session='PASS'; $automated.tokenType=$TokenType
        $accountsResult = if ($TokenType -eq 'oauth') {$session.accounts} else {Get-S3CloudflareAccounts -Token $Token}; $automated.accounts='PASS'
        $account = Select-S3CloudflareAccount -Accounts @($accountsResult.items) -SelectedAccountId $selected
        $accountId = [string](Get-S3CloudflareValue -InputObject $account -Name @('id'))
        $redactedAccountId = Get-S3RedactedAccountId -AccountId $accountId
        $base = "https://api.cloudflare.com/client/v4/accounts/$accountId"

        if ([string]::IsNullOrWhiteSpace($resolvedBillingToken)) {
            $resolvedBillingToken = $env:S3_CLOUDFLARE_BILLING_READ_TOKEN
            if (-not [string]::IsNullOrWhiteSpace($resolvedBillingToken)) {
                [Environment]::SetEnvironmentVariable('S3_CLOUDFLARE_BILLING_READ_TOKEN', $null, 'Process')
                $env:S3_CLOUDFLARE_BILLING_READ_TOKEN = $null
            }
        }
        if ([string]::IsNullOrWhiteSpace($resolvedBillingToken)) {
            throw 'MANUAL_ACTION_REQUIRED_BILLING_READ_TOKEN'
        }

        try {
            $subscriptionsResponse = Invoke-S3CloudflareBillingRead -Method GET -Uri "$base/subscriptions" -Token $resolvedBillingToken -ExpectedAccountId $accountId
            [void](Test-S3CloudflareSubscriptions -Subscriptions @($subscriptionsResponse.result)); $automated.subscriptions='PASS'
            $payGoResponse = Invoke-S3CloudflareBillingRead -Method GET -Uri "$base/paygo-usage-info" -Token $resolvedBillingToken -ExpectedAccountId $accountId
            [void](Test-S3CloudflarePayGo -PayGoResult $payGoResponse.result); $automated.payGo='PASS'
        }
        finally {
            $resolvedBillingToken = $null
            $BillingToken = $null
        }

        $settingsResponse = Invoke-S3CloudflareRest -Method GET -Uri "$base/workers/account-settings" -Token $Token
        [void](Test-S3WorkersAccountSettings -Settings $settingsResponse.result); $automated.workersSettings='PASS'
        if ([string]::IsNullOrWhiteSpace($resolvedObservabilityToken)) {
            $resolvedObservabilityToken = $env:S3_CLOUDFLARE_OBSERVABILITY_WRITE_TOKEN
            if (-not [string]::IsNullOrWhiteSpace($resolvedObservabilityToken)) {
                [Environment]::SetEnvironmentVariable('S3_CLOUDFLARE_OBSERVABILITY_WRITE_TOKEN', $null, 'Process')
                $env:S3_CLOUDFLARE_OBSERVABILITY_WRITE_TOKEN = $null
            }
        }
        if ([string]::IsNullOrWhiteSpace($resolvedObservabilityToken)) { throw 'MANUAL_ACTION_REQUIRED_OBSERVABILITY_WRITE_TOKEN' }
        $workers = Invoke-S3CloudflarePagedGet -Uri "$base/workers/scripts" -Token $Token; $automated.workers="PASS:$(@($workers.items).Count)"
        $workerForObservability = [string](@($workers.items | ForEach-Object { Get-S3CloudflareValue -InputObject $_ -Name @('id','name') } | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1))
        if ([string]::IsNullOrWhiteSpace($workerForObservability)) {
            [void](Test-S3WorkersObservabilityAuthorization -AccountId $accountId -Token $resolvedObservabilityToken)
        }
        else {
            [void](Test-S3WorkersObservabilityAuthorization -AccountId $accountId -Token $resolvedObservabilityToken -WorkerName $workerForObservability)
        }
        $automated.observability='PASS'
        $d1 = Invoke-S3CloudflarePagedGet -Uri "$base/d1/database" -Token $Token; $automated.d1="PASS:$(@($d1.items).Count)"
        $subdomainResponse = Invoke-S3CloudflareRest -Method GET -Uri "$base/workers/subdomain" -Token $Token
        [void](Test-S3WorkersDevSubdomain -SubdomainResult $subdomainResponse.result); $automated.workersDev='PASS'
        if (-not $SkipOpenBillingPage) { [void](Show-S3CloudflareBillingPage -AccountId $accountId) }
        $attestation = if ($null -eq $AttestationChoice) {Confirm-S3CloudflareBillingAttestation} else {Confirm-S3CloudflareBillingAttestation -ReadChoice $AttestationChoice}
        $attestationResult = $attestation.status
        if (-not $attestation.accepted) { throw 'USER_CANCELLED_BILLING_ATTESTATION' }
        $record = [ordered]@{runId=$Context.RunId;attestedAtUtc=[DateTime]::UtcNow.ToString('o');tokenType=$TokenType;accountId=$redactedAccountId;automated=$automated;attestation=$attestationResult;status='PASS';writeChecksDeferred='Deferred to separately approved live execution.'}
        Set-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareToken' -Value $Token
        Set-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareAccountId' -Value $accountId
        Set-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareObservabilityToken' -Value $resolvedObservabilityToken
        Set-S3MapValue -Map $Context.State.results -Name 'cloudflarePreflight' -Value $record
        [void](Show-S3CloudflarePreflightRecord -Context $Context -Record $record)
        return $record
    }
    catch {
        $record = [ordered]@{runId=$Context.RunId;attestedAtUtc=[DateTime]::UtcNow.ToString('o');tokenType=$TokenType;accountId=$redactedAccountId;automated=$automated;attestation=$attestationResult;status='FAIL';reason=Protect-S3Text $_.Exception.Message;writeChecksDeferred='No write check executed.'}
        Set-S3MapValue -Map $Context.State.results -Name 'cloudflarePreflight' -Value $record
        [void](Show-S3CloudflarePreflightRecord -Context $Context -Record $record)
        throw
    }
    finally {
        $resolvedObservabilityToken = $null
        $ObservabilityToken = $null
    }
}

function New-S3WranglerConfig {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    param($Context,[string]$WorkerName,[string]$DatabaseId,[string]$ProjectId,[string]$TestNonce,[bool]$TestControls=$true)
    $workerDirectory = Join-Path $Context.Root 'workspace\worker'
    if (-not $PSCmdlet.ShouldProcess($workerDirectory,'Create Wrangler configuration')) { return }
    New-Item -ItemType Directory -Path $workerDirectory -Force | Out-Null
    Copy-Item (Join-Path $Context.Root 'worker\src') $workerDirectory -Recurse -Force
    $assetsSource = Join-Path $Context.Root 'worker\assets'
    $assetsConfiguration = $null
    if (Test-Path -LiteralPath $assetsSource -PathType Container) {
        Copy-Item $assetsSource $workerDirectory -Recurse -Force
        $assetsConfiguration = [ordered]@{ directory='assets'; binding='ASSETS'; html_handling='auto-trailing-slash'; not_found_handling='single-page-application' }
    }
    $configuration = [ordered]@{'$schema'='node_modules/wrangler/config-schema.json';name=$WorkerName;main='src/index.js';compatibility_date='2026-08-01';workers_dev=$true;observability=@{enabled=$true;logs=@{enabled=$true;invocation_logs=$true;head_sampling_rate=1}};vars=@{FIREBASE_PROJECT_ID=$ProjectId;RUN_MARKER=$Context.RunId;TEST_CONTROLS=$(if($TestControls){'enabled'}else{'disabled'});TEST_RESET_NONCE=$TestNonce};d1_databases=@(@{binding='DB';database_name="s3cpu-$($Context.RunId)-d1";database_id=$DatabaseId})}
    if ($assetsConfiguration) { $configuration.assets = $assetsConfiguration }
    $path = Join-Path $workerDirectory 'wrangler.json'
    $configuration | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
}

function Get-S3CloudflareD1RunUidSet {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$Token,[Parameter(Mandatory)][string]$DatabaseId,[Parameter(Mandatory)][string]$RunMarker)
    if($RunMarker -notmatch '^[A-Za-z0-9-]{1,128}$'){throw 'D1_RUN_MARKER_INVALID'}
    $sql="SELECT uid, active FROM app_users WHERE run_marker='$RunMarker' ORDER BY uid"
    $response=Invoke-S3CloudflareRest -Method POST -Uri "https://api.cloudflare.com/client/v4/accounts/$AccountId/d1/database/$DatabaseId/query" -Token $Token -Body @{sql=$sql} -AllowReadOnlyD1Query
    $rows=[Collections.Generic.List[object]]::new()
    foreach($result in @($response.result)){foreach($row in @((Get-S3CloudflareValue -InputObject $result -Name @('results','result')))){$rows.Add($row)}}
    $active=@($rows|Where-Object{[int](Get-S3CloudflareValue -InputObject $_ -Name 'active') -eq 1})
    $uids=@($active|ForEach-Object{[string](Get-S3CloudflareValue -InputObject $_ -Name 'uid')}|Where-Object{-not [string]::IsNullOrWhiteSpace($_)}|Sort-Object -Unique)
    if($rows.Count -ne 2 -or $active.Count -ne 2 -or $uids.Count -ne 2){throw 'D1_AUTHORITATIVE_UID_SET_INVALID'}
    return $uids
}

function Get-S3CloudflareD1ExactMatches {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns','Get-S3CloudflareD1ExactMatches',Justification='Returns all exact matches so ambiguous ownership is rejected fail-closed.')]
    param(
        [Parameter(Mandatory)][string]$AccountId,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$D1Name
    )
    if ([string]::IsNullOrWhiteSpace($D1Name)) { throw 'D1_EXACT_NAME_REQUIRED' }
    $base = "https://api.cloudflare.com/client/v4/accounts/$AccountId"
    $response = Invoke-S3CloudflarePagedGet -Uri "$base/d1/database" -Token $Token
    $exactMatches = @(
        foreach ($item in @($response.items)) {
            $uuid = [string](Get-S3CloudflareValue -InputObject $item -Name @('uuid','id'))
            $name = [string](Get-S3CloudflareValue -InputObject $item -Name @('name'))
            if ([string]::IsNullOrWhiteSpace($uuid) -or [string]::IsNullOrWhiteSpace($name)) {
                throw 'D1_LIST_RESPONSE_UNKNOWN'
            }
            if ($name -ceq $D1Name) {
                [ordered]@{name=$name;uuid=$uuid}
            }
        }
    )
    return $exactMatches
}

function Resolve-S3CloudflarePendingD1 {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Resource,
        [Parameter(Mandatory)][string]$Token
    )
    $d1Id = [string](Get-S3MapValue -Map $Resource -Name 'd1Id')
    if (-not [string]::IsNullOrWhiteSpace($d1Id)) {
        return [ordered]@{status='KNOWN';d1Id=$d1Id}
    }
    $accountId = [string](Get-S3MapValue -Map $Resource -Name 'accountId')
    $d1Name = [string](Get-S3MapValue -Map $Resource -Name 'd1Name')
    $exactMatches = @(Get-S3CloudflareD1ExactMatches -AccountId $accountId -Token $Token -D1Name $d1Name)
    if ($exactMatches.Count -gt 1) { throw 'D1_EXACT_NAME_AMBIGUOUS' }
    if ($exactMatches.Count -eq 0) {
        Set-S3MapValue -Map $Resource -Name 'provisioningStatus' -Value 'D1_ABSENT'
        Write-S3State -Root $Context.Root -State $Context.State
        return [ordered]@{status='ABSENT';d1Id=$null}
    }
    $recoveredId = [string]$exactMatches[0].uuid
    if ([string]::IsNullOrWhiteSpace($recoveredId)) { throw 'D1_EXACT_ID_MISSING' }
    Set-S3MapValue -Map $Resource -Name 'd1Id' -Value $recoveredId
    Set-S3MapValue -Map $Resource -Name 'provisioningStatus' -Value 'D1_CREATED'
    Write-S3State -Root $Context.Root -State $Context.State
    return [ordered]@{status='RECOVERED';d1Id=$recoveredId}
}

function Invoke-S3CloudflareProvision {
    param([Parameter(Mandatory)]$Context)
    if ($Context.Mode -eq 'Simulation') {
        $worker="s3cpu-$($Context.RunId)-worker";$database="s3cpu-$($Context.RunId)-d1"
        $resource=[ordered]@{accountId='mock-account';worker=$worker;d1Name=$database;d1Id='mock-d1-id';marker=$Context.RunId;url='https://mock.workers.dev';freePlan=$true;billingAbsent=$true}
        Set-S3MapValue -Map $Context.State.resources -Name 'cloudflare' -Value $resource
        return [ordered]@{status='SIMULATED';worker=$worker;d1=$database;url='https://mock.workers.dev';freePlan=$true;billingAbsent=$true}
    }
    if ($Context.Mode -ne 'Live') { return [ordered]@{status='PLANNED'} }
    $preflight = Get-S3MapValue -Map $Context.State.results -Name 'cloudflarePreflight'
    if ($null -eq $preflight -or (Get-S3MapValue -Map $preflight -Name 'status') -ne 'PASS') { throw 'CLOUDFLARE_PREFLIGHT_REQUIRED_BEFORE_WRITE' }
    $token = [string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareToken')
    $accountId = [string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareAccountId')
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($accountId)) { throw 'CLOUDFLARE_PREFLIGHT_RUNTIME_CONTEXT_MISSING' }
    try {
        $worker=('s3cpu-'+$Context.RunId+'-worker').ToLower();if($worker.Length -gt 63){$worker=$worker.Substring(0,63)}
        $databaseName=('s3cpu-'+$Context.RunId+'-d1').ToLower();if($databaseName.Length -gt 63){$databaseName=$databaseName.Substring(0,63)}
        [void](Assert-S3DeploymentPayloadNoSecret -Context $Context -Scope PreCloud)
        $preCreateMatches = @(Get-S3CloudflareD1ExactMatches -AccountId $accountId -Token $token -D1Name $databaseName)
        if ($preCreateMatches.Count -gt 0) { throw 'D1_NAME_ALREADY_EXISTS' }
        $resource=[ordered]@{
            accountId=$accountId;worker=$worker;d1Name=$databaseName;d1Id=$null;marker=$Context.RunId
            provisioningStatus='D1_CREATE_PENDING';cleanupStatus=$null;preCreateAbsence='PASS';freePlan=$true;billingAbsent=$true
        }
        Set-S3MapValue -Map $Context.State.resources -Name 'cloudflare' -Value $resource
        Write-S3State -Root $Context.Root -State $Context.State
        $create=Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','create',$databaseName) -TimeoutSeconds 180
        $match=[regex]::Match($create.StdOut,'(?i)database_id\s*=\s*["'']?([0-9a-f-]{32,36})');if(-not $match.Success){$match=[regex]::Match($create.StdOut,'([0-9a-f]{8}-[0-9a-f-]{27,})')}
        if ($match.Success) {
            $databaseId=$match.Groups[1].Value
        }
        else {
            $recovered = @(Get-S3CloudflareD1ExactMatches -AccountId $accountId -Token $token -D1Name $databaseName)
            if ($recovered.Count -eq 0) { throw 'D1_CREATE_RESULT_UNRECOVERABLE' }
            if ($recovered.Count -gt 1) { throw 'D1_EXACT_NAME_AMBIGUOUS' }
            $databaseId=[string]$recovered[0].uuid
            if ([string]::IsNullOrWhiteSpace($databaseId)) { throw 'D1_EXACT_ID_MISSING' }
        }
        Set-S3MapValue -Map $resource -Name 'd1Id' -Value $databaseId
        Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'D1_CREATED'
        Write-S3State -Root $Context.Root -State $Context.State
        $firebaseResource=Get-S3MapValue -Map $Context.State.resources -Name 'firebase';$projectId=[string](Get-S3MapValue -Map $firebaseResource -Name 'projectId');$nonce=[guid]::NewGuid().ToString('N');$Context.RuntimeSecrets.testResetNonce=$nonce
        $configurationPath=New-S3WranglerConfig -Context $Context -WorkerName $worker -DatabaseId $databaseId -ProjectId $projectId -TestNonce $nonce -TestControls $true
        $schema=Join-Path $Context.Root 'worker\schema.sql';[void](Assert-S3DeploymentPayloadNoSecret -Context $Context -Scope CloudflareExecution);Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','execute',$databaseName,'--remote','--file',$schema,'--config',$configurationPath,'--yes') -TimeoutSeconds 300|Out-Null
        $runtime=$Context.RuntimeSecrets;$sql="INSERT INTO app_users(uid,role,active,run_marker) VALUES ('$($runtime.uid1)','person_1',1,'$($Context.RunId)'),('$($runtime.uid2)','person_2',1,'$($Context.RunId)');";$sqlFile=Join-Path $Context.Root 'temp\allowlist.sql';Set-Content -LiteralPath $sqlFile -Value $sql -Encoding UTF8
        [void](Assert-S3DeploymentPayloadNoSecret -Context $Context -Scope D1Seed);Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','execute',$databaseName,'--remote','--file',$sqlFile,'--config',$configurationPath,'--yes') -TimeoutSeconds 300|Out-Null;Remove-Item -LiteralPath $sqlFile -Force
        [void](Assert-S3DeploymentPayloadNoSecret -Context $Context -Scope FinalDeployment);$deploy=Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('deploy','--config',$configurationPath) -WorkingDirectory (Split-Path -Parent $configurationPath) -TimeoutSeconds 600
        $urlMatch=[regex]::Match($deploy.StdOut,'https://[^\s]+\.workers\.dev');if(-not $urlMatch.Success){throw 'تعذر إثبات workers.dev URL.'};$url=$urlMatch.Value.TrimEnd('/')
        $cloudflareResource=Get-S3MapValue -Map $Context.State.resources -Name 'cloudflare';Set-S3MapValue -Map $cloudflareResource -Name 'url' -Value $url
        return [ordered]@{status='PASS';worker=$worker;d1=$databaseName;url=$url;freePlan=$true;billingAbsent=$true}
    }
    finally {$token=$null;[GC]::Collect()}
}

function Test-S3CloudflareCleanupOwnership {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)]$Resource)
    $marker = [string](Get-S3MapValue -Map $Resource -Name 'marker')
    $worker = [string](Get-S3MapValue -Map $Resource -Name 'worker')
    $d1Name = [string](Get-S3MapValue -Map $Resource -Name 'd1Name')
    $d1Id = [string](Get-S3MapValue -Map $Resource -Name 'd1Id')
    $accountId = [string](Get-S3MapValue -Map $Resource -Name 'accountId')
    $provisioningStatus = [string](Get-S3MapValue -Map $Resource -Name 'provisioningStatus')
    $pendingD1 = [string]::IsNullOrWhiteSpace($d1Id) -and $provisioningStatus -in @('D1_CREATE_PENDING','D1_ABSENT')
    if (-not (Test-S3OwnedResource -Context $Context -Name $worker -Marker $marker) -or -not (Test-S3OwnedResource -Context $Context -Name $d1Name -Marker $marker) -or $worker -notmatch '^s3cpu-' -or $worker -eq 's3cpu-be239c6980' -or $d1Name -notmatch '^s3cpu-' -or (([string]::IsNullOrWhiteSpace($d1Id)) -and -not $pendingD1) -or [string]::IsNullOrWhiteSpace($accountId)) {
        throw 'رفض حذف Cloudflare غير مملوكة.'
    }
    return [ordered]@{worker=$worker;d1Name=$d1Name;d1Id=$d1Id;accountId=$accountId;provisioningStatus=$provisioningStatus}
}

function Get-S3CloudflareResourceAbsenceProof {
    param([Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$Token,[Parameter(Mandatory)][string]$Worker,[Parameter(Mandatory)][string]$D1Name,[AllowEmptyString()][string]$D1Id='')
    $base = "https://api.cloudflare.com/client/v4/accounts/$AccountId"
    $workerResponse = Invoke-S3CloudflarePagedGet -Uri "$base/workers/scripts" -Token $Token
    $workerIds = [Collections.Generic.List[string]]::new()
    foreach ($item in @($workerResponse.items)) {
        $id = [string](Get-S3CloudflareValue -InputObject $item -Name @('id'))
        if ([string]::IsNullOrWhiteSpace($id)) { throw 'WORKER_LIST_RESPONSE_UNKNOWN' }
        $workerIds.Add($id)
    }
    $d1Response = Invoke-S3CloudflarePagedGet -Uri "$base/d1/database" -Token $Token
    $d1Matches = 0
    foreach ($item in @($d1Response.items)) {
        $uuid = [string](Get-S3CloudflareValue -InputObject $item -Name @('uuid','id'))
        $name = [string](Get-S3CloudflareValue -InputObject $item -Name @('name'))
        if ([string]::IsNullOrWhiteSpace($uuid) -or [string]::IsNullOrWhiteSpace($name)) { throw 'D1_LIST_RESPONSE_UNKNOWN' }
        if ($uuid -eq $D1Id -or $name -eq $D1Name) { $d1Matches++ }
    }
    return [ordered]@{workerAbsent=($workerIds -notcontains $Worker);d1Absent=($d1Matches -eq 0)}
}

function Wait-S3CloudflareResourceAbsence {
    param([Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$Token,[Parameter(Mandatory)][string]$Worker,[Parameter(Mandatory)][string]$D1Name,[Parameter(Mandatory)][string]$D1Id,[ValidateRange(1,5)][int]$MaxAttempts=3,[ValidateRange(0,10)][int]$DelaySeconds=2)
    for ($attempt=1; $attempt -le $MaxAttempts; $attempt++) {
        try { $proof = Get-S3CloudflareResourceAbsenceProof -AccountId $AccountId -Token $Token -Worker $Worker -D1Name $D1Name -D1Id $D1Id }
        catch { return [ordered]@{status='UNKNOWN';attempts=$attempt;workerAbsent=$false;d1Absent=$false;reason=Protect-S3Text $_.Exception.Message} }
        if ($proof.workerAbsent -and $proof.d1Absent) { return [ordered]@{status='PASS';attempts=$attempt;workerAbsent=$true;d1Absent=$true} }
        if ($attempt -lt $MaxAttempts -and $DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    }
    $status = if ($proof.workerAbsent -xor $proof.d1Absent) {'PARTIAL'} else {'FAILED'}
    return [ordered]@{status=$status;attempts=$MaxAttempts;workerAbsent=$proof.workerAbsent;d1Absent=$proof.d1Absent}
}

function Remove-S3CloudflareResource {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    param([Parameter(Mandatory)]$Context)
    $resource = Get-S3MapValue -Map $Context.State.resources -Name 'cloudflare'
    if ($null -eq $resource) { return [ordered]@{status='NOT_CREATED'} }
    $owned = Test-S3CloudflareCleanupOwnership -Context $Context -Resource $resource
    if ((Get-S3MapValue -Map $resource -Name 'cleanupStatus') -eq 'DELETED') {
        return [ordered]@{status='ALREADY_DELETED';worker=$owned.worker;d1=$owned.d1Name;accountId=(Get-S3RedactedAccountId -AccountId $owned.accountId)}
    }
    if (-not $PSCmdlet.ShouldProcess($owned.worker,'Remove owned Cloudflare Worker and D1 resources')) { return [ordered]@{status='SKIPPED'} }
    if ($Context.Mode -eq 'Simulation') {
        Set-S3MapValue -Map $resource -Name 'cleanupStatus' -Value 'DELETED'
        return [ordered]@{status='DELETED';worker=[ordered]@{name=$owned.worker;delete='SIMULATED';absent=$true};d1=[ordered]@{name=$owned.d1Name;id=$owned.d1Id;delete='SIMULATED';absent=$true};accountId=(Get-S3RedactedAccountId -AccountId $owned.accountId);attempts=1}
    }
    $token = [string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareToken')
    $runtimeAccountId = [string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'cloudflareAccountId')
    if ([string]::IsNullOrWhiteSpace($token) -or $runtimeAccountId -ne $owned.accountId) { return [ordered]@{status='UNKNOWN';reason='CLOUDFLARE_CLEANUP_RUNTIME_CONTEXT_MISSING';accountId=(Get-S3RedactedAccountId -AccountId $owned.accountId)} }
    $d1Resolution = Resolve-S3CloudflarePendingD1 -Context $Context -Resource $resource -Token $token
    $owned.d1Id = [string]$d1Resolution.d1Id
    $initialProof = Get-S3CloudflareResourceAbsenceProof -AccountId $owned.accountId -Token $token -Worker $owned.worker -D1Name $owned.d1Name -D1Id $owned.d1Id
    $workerDelete = [ordered]@{status='NOT_ATTEMPTED';exitCode=$null}
    $d1Delete = [ordered]@{status='NOT_ATTEMPTED';exitCode=$null}
    if ($initialProof.workerAbsent) {
        $workerDelete.status = 'ALREADY_ABSENT'
    }
    else {
        try {
            $workerCommand = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('delete','--name',$owned.worker) -TimeoutSeconds 300 -AllowFailure
            $workerDelete.status = if ($workerCommand.ExitCode -eq 0) {'REQUESTED'} else {'FAILED'}
            $workerDelete.exitCode = $workerCommand.ExitCode
        }
        catch { $workerDelete = [ordered]@{status='FAILED';exitCode=$null;reason=Protect-S3Text $_.Exception.Message} }
    }
    if ($initialProof.d1Absent) {
        $d1Delete.status = 'ALREADY_ABSENT'
    }
    else {
        try {
            $d1Command = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','delete',$owned.d1Name,'--skip-confirmation') -TimeoutSeconds 300 -AllowFailure
            $d1Delete.status = if ($d1Command.ExitCode -eq 0) {'REQUESTED'} else {'FAILED'}
            $d1Delete.exitCode = $d1Command.ExitCode
        }
        catch { $d1Delete = [ordered]@{status='FAILED';exitCode=$null;reason=Protect-S3Text $_.Exception.Message} }
    }
    $proof = Wait-S3CloudflareResourceAbsence -AccountId $owned.accountId -Token $token -Worker $owned.worker -D1Name $owned.d1Name -D1Id $owned.d1Id
    $workerOk = ($workerDelete.status -in @('REQUESTED','ALREADY_ABSENT') -and $proof.workerAbsent -eq $true)
    $d1Ok = ($d1Delete.status -in @('REQUESTED','ALREADY_ABSENT') -and $proof.d1Absent -eq $true)
    $status = if ($workerDelete.status -eq 'FAILED' -or $d1Delete.status -eq 'FAILED') {'FAILED'} elseif ($workerOk -and $d1Ok -and $proof.status -eq 'PASS') {'DELETED'} elseif ($proof.status -eq 'UNKNOWN') {'UNKNOWN'} elseif ($proof.workerAbsent -xor $proof.d1Absent) {'PARTIAL'} else {'FAILED'}
    if ($status -eq 'DELETED') {
        Set-S3MapValue -Map $resource -Name 'cleanupStatus' -Value 'DELETED'
        Write-S3State -Root $Context.Root -State $Context.State
    }
    return [ordered]@{
        status=$status
        worker=[ordered]@{name=$owned.worker;delete=$workerDelete.status;exitCode=$workerDelete.exitCode;absent=$proof.workerAbsent}
        d1=[ordered]@{name=$owned.d1Name;id=$owned.d1Id;delete=$d1Delete.status;exitCode=$d1Delete.exitCode;absent=$proof.d1Absent}
        accountId=(Get-S3RedactedAccountId -AccountId $owned.accountId)
        verification=$proof.status
        attempts=$proof.attempts
    }
}

Export-ModuleMember -Function *-S3*
