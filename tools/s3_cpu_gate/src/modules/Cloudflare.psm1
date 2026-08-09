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
    if ($response.success -eq $false -or @($response.errors).Count -gt 0) {
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
        if ($response.success -eq $false -or @($response.errors).Count -gt 0) { throw "CLOUDFLARE_PAGED_API_ERROR: page=$page" }
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
    param([Parameter(Mandatory)][string]$Method,[Parameter(Mandatory)][string]$Uri)
    $normalizedMethod = $Method.ToUpperInvariant()
    if ($normalizedMethod -eq 'GET') { return $true }
    if ($normalizedMethod -eq 'POST' -and $Uri -match '/accounts/[^/]+/workers/observability/telemetry/query$') { return $true }
    throw "CLOUDFLARE_WRITE_API_FORBIDDEN: $normalizedMethod $Uri"
}

function Invoke-S3CloudflareRest {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Token,
        [AllowNull()][object]$Body = $null,
        [int]$TimeoutSeconds = 90
    )
    [void](Test-S3CloudflareReadOnlyMethod -Method $Method -Uri $Uri)
    $parameters = @{Method=$Method;Uri=$Uri;Headers=@{Authorization="Bearer $Token"};TimeoutSec=$TimeoutSeconds}
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 30 -Compress
    }
    $response = Invoke-RestMethod @parameters
    if ($response.success -eq $false -or @($response.errors).Count -gt 0) {
        $safeErrors = Protect-S3Text (@($response.errors) | ConvertTo-Json -Depth 10 -Compress)
        throw "CLOUDFLARE_API_ERROR: $safeErrors"
    }
    return $response
}

function Invoke-S3CloudflarePagedGet {
    param([Parameter(Mandatory)][string]$Uri,[Parameter(Mandatory)][string]$Token,[ValidateRange(1,100)][int]$PerPage=50)
    $items = [Collections.Generic.List[object]]::new()
    $pagesRead = [Collections.Generic.List[int]]::new()
    $page = 1
    while ($true) {
        $separator = if ($Uri.Contains('?')) {'&'} else {'?'}
        $response = Invoke-S3CloudflareRest -Method GET -Uri "$Uri${separator}page=$page&per_page=$PerPage" -Token $Token
        if ($response.success -eq $false -or @($response.errors).Count -gt 0) { throw "CLOUDFLARE_PAGED_API_ERROR: page=$page" }
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
    param([Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$Token)
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/observability/telemetry/query"
    $body = Get-S3WorkersObservabilityQueryBody -QueryId 's3cpu-preflight' -FromUtc ([DateTime]::UtcNow.AddMinutes(-5)) -ToUtc ([DateTime]::UtcNow) -Limit 1
    $response = Invoke-S3CloudflareRest -Method POST -Uri $uri -Token $Token -Body $body
    if ($response.success -eq $false -or @($response.errors).Count -gt 0) { throw 'WORKERS_OBSERVABILITY_NOT_AUTHORIZED' }
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
        [ValidateRange(1,2000)][int]$Limit = 500,
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

function Invoke-S3WorkersTelemetryQuery {
    param(
        [Parameter(Mandatory)][string]$AccountId,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$RunId,
        [Parameter(Mandatory)][string]$Scenario,
        [ValidateRange(1,2000)][int]$PageSize=500
    )
    $uri = "https://api.cloudflare.com/client/v4/accounts/$AccountId/workers/observability/telemetry/query"
    $records = [Collections.Generic.List[object]]::new()
    $errors = [Collections.Generic.List[string]]::new()
    $seenOffsets = [Collections.Generic.HashSet[string]]::new()
    $page = 1; $offset = $null; $truncated = $false; $samplingDetected = $false; $paginationComplete = $true
    $fromUtc = [DateTime]::UtcNow.AddMinutes(-15)
    $toUtc = [DateTime]::UtcNow
    $queryId = "s3cpu-$RunId-$Scenario"
    while ($true) {
        $body = Get-S3WorkersObservabilityQueryBody -QueryId $queryId -FromUtc $fromUtc -ToUtc $toUtc -Limit $PageSize -Offset $offset
        try { $response = Invoke-S3CloudflareRest -Method POST -Uri $uri -Token $Token -Body $body }
        catch {
            $errors.Add("API_ERROR:$($_.Exception.Message)")
            return [ordered]@{status='FAIL';records=@($records);pageCount=$page;paginationComplete=$false;truncated=$truncated;samplingDetected=$samplingDetected;apiSuccess=$false;errors=@($errors)}
        }
        if ($response.success -eq $false -or @($response.errors).Count -gt 0) {
            $errors.Add('API_ERROR')
            return [ordered]@{status='FAIL';records=@($records);pageCount=$page;paginationComplete=$false;truncated=$truncated;samplingDetected=$samplingDetected;apiSuccess=$false;errors=@($errors)}
        }
        $responseJson = $response | ConvertTo-Json -Depth 40 -Compress
        if ($responseJson -match '"truncated"\s*:\s*true') { $truncated = $true }
        if ($responseJson -match '"sampling"\s*:\s*(true|"[^"]+"|[2-9][0-9.]*)' -or $responseJson -match '"abr_level"\s*:\s*"(?!none|full|0)[^"]+"') { $samplingDetected = $true }
        $pageItems = @(Get-S3TelemetryPageItems -Response $response)
        foreach ($item in $pageItems) {
            $record = ConvertTo-S3WorkersTelemetryRecord -Item $item
            if ($record.truncated -eq $true) { $truncated = $true }
            if ((Test-S3TelemetrySamplingValue -Value $record.sampling) -or (Test-S3TelemetrySamplingValue -Value $record.abrLevel)) { $samplingDetected = $true }
            $records.Add($record)
        }
        $result = Get-S3CloudflareValue -InputObject $response -Name @('result')
        $eventsEnvelope = Get-S3CloudflareValue -InputObject $result -Name @('events')
        $totalCount = Get-S3CloudflareValue -InputObject $eventsEnvelope -Name @('count')
        $totalCountKnown = $null -ne $totalCount
        if ($totalCountKnown -and [int]$totalCount -lt $records.Count) { $paginationComplete=$false;$errors.Add('PAGINATION_METADATA_INCOMPLETE');break }
        if (($totalCountKnown -and $records.Count -ge [int]$totalCount) -or (-not $totalCountKnown -and $pageItems.Count -lt $PageSize)) { break }
        if ($pageItems.Count -eq 0) { $paginationComplete=$false;$errors.Add('PAGINATION_NEXT_PAGE_MISSING');break }
        $lastMetadata = Get-S3CloudflareValue -InputObject $pageItems[$pageItems.Count - 1] -Name @('$metadata','metadata')
        $nextOffset = [string](Get-S3CloudflareValue -InputObject $lastMetadata -Name @('id'))
        if ([string]::IsNullOrWhiteSpace($nextOffset)) { $paginationComplete=$false;$errors.Add('PAGINATION_NEXT_PAGE_MISSING');break }
        if (-not $seenOffsets.Add($nextOffset)) { $paginationComplete=$false;$errors.Add('PAGINATION_CURSOR_REPEATED');break }
        $offset = $nextOffset
        $page++
    }
    $status = if ($paginationComplete -and -not $truncated -and -not $samplingDetected -and $errors.Count -eq 0) {'PASS'} else {'FAIL'}
    return [ordered]@{status=$status;records=@($records);pageCount=$page;paginationComplete=$paginationComplete;truncated=$truncated;samplingDetected=$samplingDetected;apiSuccess=$true;errors=@($errors)}
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
        [void](Test-S3WorkersObservabilityAuthorization -AccountId $accountId -Token $resolvedObservabilityToken); $automated.observability='PASS'
        $workers = Invoke-S3CloudflarePagedGet -Uri "$base/workers/scripts" -Token $Token; $automated.workers="PASS:$(@($workers.items).Count)"
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
    $configuration = [ordered]@{'$schema'='node_modules/wrangler/config-schema.json';name=$WorkerName;main='src/index.js';compatibility_date='2026-08-01';workers_dev=$true;observability=@{enabled=$true;logs=@{enabled=$true;invocation_logs=$true;head_sampling_rate=1}};vars=@{FIREBASE_PROJECT_ID=$ProjectId;RUN_MARKER=$Context.RunId;TEST_CONTROLS=$(if($TestControls){'enabled'}else{'disabled'});TEST_RESET_NONCE=$TestNonce};d1_databases=@(@{binding='DB';database_name="s3cpu-$($Context.RunId)-d1";database_id=$DatabaseId})}
    $path = Join-Path $workerDirectory 'wrangler.json'
    $configuration | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $path -Encoding UTF8
    return $path
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
        $create=Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','create',$databaseName) -TimeoutSeconds 180
        $match=[regex]::Match($create.StdOut,'(?i)database_id\s*=\s*["'']?([0-9a-f-]{32,36})');if(-not $match.Success){$match=[regex]::Match($create.StdOut,'([0-9a-f]{8}-[0-9a-f-]{27,})')};if(-not $match.Success){throw 'تعذر استخراج D1 database ID.'};$databaseId=$match.Groups[1].Value
        $resource=[ordered]@{accountId=$accountId;worker=$worker;d1Name=$databaseName;d1Id=$databaseId;marker=$Context.RunId;freePlan=$true;billingAbsent=$true}
        Set-S3MapValue -Map $Context.State.resources -Name 'cloudflare' -Value $resource;Write-S3State -Root $Context.Root -State $Context.State
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
    if (-not (Test-S3OwnedResource -Context $Context -Name $worker -Marker $marker) -or -not (Test-S3OwnedResource -Context $Context -Name $d1Name -Marker $marker) -or $worker -notmatch '^s3cpu-' -or $d1Name -notmatch '^s3cpu-' -or [string]::IsNullOrWhiteSpace($d1Id) -or [string]::IsNullOrWhiteSpace($accountId)) {
        throw 'رفض حذف Cloudflare غير مملوكة.'
    }
    return [ordered]@{worker=$worker;d1Name=$d1Name;d1Id=$d1Id;accountId=$accountId}
}

function Get-S3CloudflareResourceAbsenceProof {
    param([Parameter(Mandatory)][string]$AccountId,[Parameter(Mandatory)][string]$Token,[Parameter(Mandatory)][string]$Worker,[Parameter(Mandatory)][string]$D1Name,[Parameter(Mandatory)][string]$D1Id)
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
    $workerDelete = [ordered]@{status='NOT_ATTEMPTED';exitCode=$null}
    $d1Delete = [ordered]@{status='NOT_ATTEMPTED';exitCode=$null}
    try {
        $workerCommand = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('delete',$owned.worker,'--force') -TimeoutSeconds 300 -AllowFailure
        $workerDelete.status = if ($workerCommand.ExitCode -eq 0) {'REQUESTED'} else {'FAILED'}
        $workerDelete.exitCode = $workerCommand.ExitCode
    }
    catch { $workerDelete = [ordered]@{status='FAILED';exitCode=$null;reason=Protect-S3Text $_.Exception.Message} }
    try {
        $d1Command = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','delete',$owned.d1Name,'--yes') -TimeoutSeconds 300 -AllowFailure
        $d1Delete.status = if ($d1Command.ExitCode -eq 0) {'REQUESTED'} else {'FAILED'}
        $d1Delete.exitCode = $d1Command.ExitCode
    }
    catch { $d1Delete = [ordered]@{status='FAILED';exitCode=$null;reason=Protect-S3Text $_.Exception.Message} }
    $proof = Wait-S3CloudflareResourceAbsence -AccountId $owned.accountId -Token $token -Worker $owned.worker -D1Name $owned.d1Name -D1Id $owned.d1Id
    $workerOk = ($workerDelete.status -eq 'REQUESTED' -and $proof.workerAbsent -eq $true)
    $d1Ok = ($d1Delete.status -eq 'REQUESTED' -and $proof.d1Absent -eq $true)
    $status = if ($workerDelete.status -ne 'REQUESTED' -or $d1Delete.status -ne 'REQUESTED') {'FAILED'} elseif ($workerOk -and $d1Ok -and $proof.status -eq 'PASS') {'DELETED'} elseif ($proof.status -eq 'UNKNOWN') {'UNKNOWN'} elseif ($proof.workerAbsent -xor $proof.d1Absent) {'PARTIAL'} else {'FAILED'}
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
