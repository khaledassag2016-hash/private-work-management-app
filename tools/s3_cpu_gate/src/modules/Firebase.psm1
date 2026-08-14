Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-S3SyntheticPassword {
    $bytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    try {
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','A').Replace('/','z') + '!a9'
    }
    finally {
        [Array]::Clear($bytes,0,$bytes.Length)
    }
}

function Get-S3GoogleAccessToken {
    param($Context)
    $result = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','print-access-token') -TimeoutSeconds 60 -SensitiveOutput
    $token = $result.StdOut.Trim()
    if ([string]::IsNullOrWhiteSpace($token)) { throw 'GOOGLE_ACCESS_TOKEN_MISSING' }
    return $token
}

function Invoke-S3GoogleRest {
    param([string]$Method,[string]$Uri,[string]$Token,[AllowNull()][object]$Body=$null)
    $headers = @{Authorization="Bearer $Token"}
    try {
        if ($null -eq $Body) {
            return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -TimeoutSec 90
        }
        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 20 -Compress) -TimeoutSec 90
    }
    catch {
        throw "GOOGLE_API_REQUEST_FAILED:$($Method.ToUpperInvariant())"
    }
}

function Test-S3PropertyPresent {
    param([AllowNull()][object]$InputObject,[Parameter(Mandatory)][string]$Name)
    if ($null -eq $InputObject) { return $false }
    if ($InputObject -is [Collections.IDictionary]) { return $InputObject.Contains($Name) }
    return ($null -ne $InputObject.PSObject.Properties[$Name])
}

function Get-S3RequiredPropertyValue {
    param([AllowNull()][object]$InputObject,[Parameter(Mandatory)][string]$Name)
    if ($null -eq $InputObject) { throw "FIREBASE_RESPONSE_NULL:$Name" }
    $found = $false
    $value = $null
    if ($InputObject -is [Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) {
            $found = $true
            $value = $InputObject[$Name]
        }
    }
    else {
        $property = $InputObject.PSObject.Properties[$Name]
        if ($null -ne $property) {
            $found = $true
            $value = $property.Value
        }
    }
    if (-not $found -or $null -eq $value) { throw "FIREBASE_REQUIRED_VALUE_MISSING:$Name" }
    return $value
}

function Get-S3RequiredArrayProperty {
    param([AllowNull()][object]$InputObject,[Parameter(Mandatory)][string]$Name)
    if ($null -eq $InputObject) { throw "FIREBASE_RESPONSE_NULL:$Name" }
    $found = $false
    $value = $null
    if ($InputObject -is [Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) {
            $found = $true
            $value = $InputObject[$Name]
        }
    }
    else {
        $property = $InputObject.PSObject.Properties[$Name]
        if ($null -ne $property) {
            $found = $true
            $value = $property.Value
        }
    }
    if (-not $found -or $null -eq $value) { throw "FIREBASE_REQUIRED_VALUE_MISSING:$Name" }
    if ($value -is [string] -or $value -isnot [Collections.IEnumerable]) { throw "FIREBASE_ARRAY_EXPECTED:$Name" }
    foreach ($item in $value) { Write-Output $item }
}

function Get-S3OptionalRepeatedArrayProperty {
    param([AllowNull()][object]$InputObject,[Parameter(Mandatory)][string]$Name)
    if ($null -eq $InputObject) { throw "FIREBASE_RESPONSE_NULL:$Name" }
    if (-not (Test-S3PropertyPresent -InputObject $InputObject -Name $Name)) { return }
    $value = $null
    if ($InputObject -is [Collections.IDictionary]) {
        $value = $InputObject[$Name]
    }
    else {
        $value = $InputObject.PSObject.Properties[$Name].Value
    }
    if ($null -eq $value -or $value -is [string] -or $value -isnot [Collections.IEnumerable]) { throw "FIREBASE_ARRAY_EXPECTED:$Name" }
    foreach ($item in $value) { Write-Output $item }
}

function Get-S3RequiredNonNegativeInteger {
    param([AllowNull()][object]$InputObject,[Parameter(Mandatory)][string]$Name)
    $value = Get-S3RequiredPropertyValue -InputObject $InputObject -Name $Name
    if ($value -is [string]) {
        if ($value -notmatch '^[0-9]+$') { throw "FIREBASE_INTEGER_EXPECTED:$Name" }
        [int64]$parsed = 0
        $parsedOk = [int64]::TryParse($value,[Globalization.NumberStyles]::None,[Globalization.CultureInfo]::InvariantCulture,[ref]$parsed)
        if (-not $parsedOk) { throw "FIREBASE_INTEGER_OUT_OF_RANGE:$Name" }
        return $parsed
    }
    $typeCode = [Type]::GetTypeCode($value.GetType())
    if ($typeCode -notin @([TypeCode]::Byte,[TypeCode]::SByte,[TypeCode]::Int16,[TypeCode]::UInt16,[TypeCode]::Int32,[TypeCode]::UInt32,[TypeCode]::Int64,[TypeCode]::UInt64)) {
        throw "FIREBASE_INTEGER_EXPECTED:$Name"
    }
    if ([decimal]$value -gt [decimal][int64]::MaxValue) { throw "FIREBASE_INTEGER_OUT_OF_RANGE:$Name" }
    $integer = [int64]$value
    if ($integer -lt 0) { throw "FIREBASE_INTEGER_OUT_OF_RANGE:$Name" }
    return $integer
}

function Assert-S3ExactBoolean {
    param([AllowNull()][object]$Value,[Parameter(Mandatory)][bool]$Expected,[Parameter(Mandatory)][string]$Name)
    if ($Value -isnot [bool] -or [bool]$Value -ne $Expected) {
        throw "FIREBASE_BOOLEAN_MISMATCH:$Name"
    }
}

function Assert-S3GoogleNoBilling {
    param($Context,[string]$ProjectId)
    $result = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('billing','projects','describe',$ProjectId,'--format=json') -TimeoutSeconds 120
    try { $json = $result.StdOut | ConvertFrom-Json }
    catch { throw 'GOOGLE_BILLING_RESPONSE_INVALID' }
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $json -Name 'billingEnabled') -Expected $false -Name 'billingEnabled'
    $billingAccountName = Get-S3MapValue -Map $json -Name 'billingAccountName'
    if (-not [string]::IsNullOrEmpty([string]$billingAccountName)) { throw 'BILLING_ACCOUNT_PRESENT' }
    return [ordered]@{billingEnabled=$false;billingAccountName=$null;verified=$true}
}

function Get-S3FederatedProviderSnapshot {
    param([string]$ProjectId,[string]$Token)
    $base = "https://identitytoolkit.googleapis.com/admin/v2/projects/$ProjectId"
    $collections = [ordered]@{}
    foreach ($collection in @('defaultSupportedIdpConfigs','oauthIdpConfigs','inboundSamlConfigs')) {
        $response = Invoke-S3GoogleRest -Method GET -Uri "$base/${collection}?pageSize=100" -Token $Token
        $items = @(Get-S3OptionalRepeatedArrayProperty -InputObject $response -Name $collection)
        $nextPageToken = [string](Get-S3MapValue -Map $response -Name 'nextPageToken')
        if (-not [string]::IsNullOrWhiteSpace($nextPageToken)) { throw "FIREBASE_PROVIDER_PAGINATION_INCOMPLETE:$collection" }
        $normalized = [Collections.Generic.List[object]]::new()
        foreach ($config in $items) {
            $name = [string](Get-S3RequiredPropertyValue -InputObject $config -Name 'name')
            $enabled = Get-S3RequiredPropertyValue -InputObject $config -Name 'enabled'
            if ([string]::IsNullOrWhiteSpace($name) -or $enabled -isnot [bool]) {
                throw "FIREBASE_PROVIDER_RESPONSE_INVALID:$collection"
            }
            $normalized.Add([ordered]@{name=$name;enabled=[bool]$enabled})
        }
        $collections[$collection] = @($normalized)
    }
    return $collections
}

function Disable-S3FederatedProvider {
    param([string]$ProjectId,[string]$Token)
    $before = Get-S3FederatedProviderSnapshot -ProjectId $ProjectId -Token $Token
    foreach ($collection in $before.Keys) {
        foreach ($config in @($before[$collection])) {
            if ($config.enabled -eq $true) {
                Invoke-S3GoogleRest -Method PATCH -Uri "https://identitytoolkit.googleapis.com/admin/v2/$($config.name)?updateMask=enabled" -Token $Token -Body @{enabled=$false;name=$config.name} | Out-Null
            }
        }
    }
    $after = Get-S3FederatedProviderSnapshot -ProjectId $ProjectId -Token $Token
    $counts = [ordered]@{}
    foreach ($collection in $after.Keys) {
        $enabled = @($after[$collection] | Where-Object {$_.enabled -eq $true})
        if ($enabled.Count -ne 0) { throw "FIREBASE_PROVIDER_STILL_ENABLED:$collection" }
        $counts[$collection] = @($after[$collection]).Count
    }
    return [ordered]@{verified=$true;enabledCount=0;collections=$counts}
}

function Assert-S3FirebaseConfiguration {
    param([AllowNull()][object]$Configuration,[AllowNull()][object]$ProviderProof)
    $signIn = Get-S3RequiredPropertyValue -InputObject $Configuration -Name 'signIn'
    $email = Get-S3RequiredPropertyValue -InputObject $signIn -Name 'email'
    $phone = Get-S3RequiredPropertyValue -InputObject $signIn -Name 'phoneNumber'
    $anonymous = Get-S3RequiredPropertyValue -InputObject $signIn -Name 'anonymous'
    $client = Get-S3RequiredPropertyValue -InputObject $Configuration -Name 'client'
    $permissions = Get-S3RequiredPropertyValue -InputObject $client -Name 'permissions'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $email -Name 'enabled') -Expected $true -Name 'email.enabled'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $email -Name 'passwordRequired') -Expected $true -Name 'email.passwordRequired'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $phone -Name 'enabled') -Expected $false -Name 'phoneNumber.enabled'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $anonymous -Name 'enabled') -Expected $false -Name 'anonymous.enabled'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $signIn -Name 'allowDuplicateEmails') -Expected $false -Name 'allowDuplicateEmails'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $permissions -Name 'disabledUserSignup') -Expected $true -Name 'disabledUserSignup'
    Assert-S3ExactBoolean -Value (Get-S3RequiredPropertyValue -InputObject $permissions -Name 'disabledUserDeletion') -Expected $true -Name 'disabledUserDeletion'
    if ($null -eq $ProviderProof -or (Get-S3MapValue -Map $ProviderProof -Name 'verified') -ne $true -or [int](Get-S3MapValue -Map $ProviderProof -Name 'enabledCount') -ne 0) {
        throw 'FIREBASE_PROVIDER_PROOF_MISSING'
    }
    return [ordered]@{verified=$true;emailPasswordOnly=$true;otherProviders=$false}
}

function Get-S3FirebaseUser {
    param([string]$ProjectId,[string]$Token)
    $response = Invoke-S3GoogleRest -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/projects/$ProjectId/accounts:query" -Token $Token -Body @{returnUserInfo=$true;limit=100}
    $hasUserInfo = Test-S3PropertyPresent -InputObject $response -Name 'userInfo'
    $users = @()
    if ($hasUserInfo) {
        $users = @(Get-S3RequiredArrayProperty -InputObject $response -Name 'userInfo')
    }
    $hasRecordsCount = Test-S3PropertyPresent -InputObject $response -Name 'recordsCount'
    if (-not $hasRecordsCount) {
        if ($users.Count -eq 0) { return @() }
        throw 'FIREBASE_RECORDSCOUNT_MISSING'
    }
    $recordsCount = Get-S3RequiredNonNegativeInteger -InputObject $response -Name 'recordsCount'
    if (-not $hasUserInfo) {
        if ($recordsCount -eq 0) { return @() }
        throw 'FIREBASE_USERINFO_MISSING'
    }
    if ($users.Count -ne $recordsCount) { throw 'FIREBASE_USERINFO_COUNT_MISMATCH' }
    return $users
}

function Assert-S3FirebaseUserSet {
    param([object[]]$Users,[string[]]$ExpectedUids=@())
    if ($Users.Count -ne $ExpectedUids.Count) { throw 'FIREBASE_USER_COUNT_MISMATCH' }
    $actualUids = [Collections.Generic.List[string]]::new()
    foreach ($user in $Users) {
        $uid = [string](Get-S3RequiredPropertyValue -InputObject $user -Name 'localId')
        if ([string]::IsNullOrWhiteSpace($uid)) { throw 'FIREBASE_USER_UID_MISSING' }
        $actualUids.Add($uid)
        $phone = Get-S3MapValue -Map $user -Name 'phoneNumber'
        if (-not [string]::IsNullOrWhiteSpace([string]$phone)) { throw 'FIREBASE_USER_PHONE_PRESENT' }
        $links = @(Get-S3MapValue -Map $user -Name 'providerUserInfo')
        if ($links.Count -gt 1) { throw 'FIREBASE_USER_PROVIDER_LINK_PRESENT' }
        foreach ($link in $links) {
            $providerId = [string](Get-S3MapValue -Map $link -Name 'providerId')
            if ($providerId -ne 'password') { throw 'FIREBASE_USER_PROVIDER_LINK_PRESENT' }
        }
    }
    $actualIdentity = (@($actualUids | Sort-Object) -join '|')
    $expectedIdentity = (@($ExpectedUids | Sort-Object) -join '|')
    if ($actualIdentity -ne $expectedIdentity) { throw 'FIREBASE_USER_IDENTITY_MISMATCH' }
    return [ordered]@{verified=$true;count=$Users.Count;phones=0;providerLinks=0}
}

function New-S3FirebaseAdminUser {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword','',Justification='Synthetic one-run password is required in the Firebase HTTPS JSON body and is never logged or serialized.')]
    param([string]$ProjectId,[string]$ApiKey,[string]$Token,[string]$Uid,[string]$Email,[string]$Password)
    if (-not $PSCmdlet.ShouldProcess(($ProjectId + '/' + $Uid),'Create synthetic Firebase user')) { return }
    Invoke-S3GoogleRest -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/projects/$ProjectId/accounts?key=$ApiKey" -Token $Token -Body @{localId=$Uid;email=$Email;password=$Password;emailVerified=$true;displayName='S3 CPU Gate Test User'} | Out-Null
}

function Get-S3FirebaseIdToken {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword','',Justification='Synthetic one-run password is required in the Firebase HTTPS JSON body and is never logged or serialized.')]
    param([string]$ApiKey,[string]$Email,[string]$Password)
    try {
        $response = Invoke-RestMethod -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$ApiKey" -ContentType 'application/json' -Body (@{email=$Email;password=$Password;returnSecureToken=$true} | ConvertTo-Json -Compress) -TimeoutSec 90
    }
    catch { throw 'FIREBASE_SIGNIN_REQUEST_FAILED' }
    if ([string]::IsNullOrWhiteSpace([string]$response.idToken) -or [string]::IsNullOrWhiteSpace([string]$response.refreshToken) -or [string]::IsNullOrWhiteSpace([string]$response.localId)) {
        throw 'FIREBASE_SIGNIN_RESPONSE_INCOMPLETE'
    }
    return [pscustomobject]@{IdToken=[string]$response.idToken;RefreshToken=[string]$response.refreshToken;LocalId=[string]$response.localId}
}

function Assert-S3PreexistingGoogleCliSession {
    param([Parameter(Mandatory)]$Context)
    $inventory = Get-S3MapValue -Map $Context.State.results -Name 'cliSessions'
    if ($null -eq $inventory) { throw 'CLI_SESSION_INVENTORY_REQUIRED' }
    foreach ($name in @('firebase','gcloud')) {
        $entry = Get-S3MapValue -Map $inventory -Name $name
        if ($null -eq $entry -or [string](Get-S3MapValue -Map $entry -Name 'status') -ne 'PREEXISTING') {
            throw "BLOCKED_${name}_PREEXISTING_SESSION_REQUIRED"
        }
    }
}

function Get-S3FirebaseProjectRecord {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$ProjectId)
    $result = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','describe',$ProjectId,'--format=json') -TimeoutSeconds 120 -AllowFailure
    if ($result.ExitCode -eq 0) {
        try { $project = $result.StdOut | ConvertFrom-Json }
        catch { return [ordered]@{status='UNKNOWN'} }
        $createTimeValue = Get-S3MapValue -Map $project -Name 'createTime'
        $createTime = if ($createTimeValue -is [datetime]) { $createTimeValue.ToUniversalTime().ToString('o') } else { [string]$createTimeValue }
        return [ordered]@{
            status='EXISTS'
            projectId=[string](Get-S3MapValue -Map $project -Name 'projectId')
            displayName=[string](Get-S3MapValue -Map $project -Name 'name')
            projectNumber=[string](Get-S3MapValue -Map $project -Name 'projectNumber')
            lifecycleState=[string](Get-S3MapValue -Map $project -Name 'lifecycleState')
            createTime=$createTime
        }
    }
    $diagnostic = @([string]$result.StdErr,[string]$result.StdOut) -join "`n"
    if ($diagnostic -match '(?i)permission_denied|permission denied|access denied|forbidden|unauthorized|\b(?:401|403)\b') { return [ordered]@{status='UNKNOWN'} }
    if ($diagnostic -match '(?i)\bNOT_FOUND\b|requested entity was not found|\bproject\b[^\r\n]*\bwas not found\b') { return [ordered]@{status='ABSENT'} }
    return [ordered]@{status='UNKNOWN'}
}

function Get-S3FirebaseProjectPresence {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$ProjectId)
    return [string](Get-S3MapValue -Map (Get-S3FirebaseProjectRecord -Context $Context -ProjectId $ProjectId) -Name 'status')
}

function Get-S3FirebaseProjectDisplayName {
    param([Parameter(Mandatory)][string]$RunId)
    $prefix = 'S3 CPU '
    $normalized = ($RunId -replace '[^A-Za-z0-9-]','-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($normalized)) { $normalized = 'run' }
    $available = 30 - $prefix.Length
    if ($normalized.Length -gt $available) {
        $normalized = $normalized.Substring($normalized.Length - $available)
    }
    $displayName = $prefix + $normalized
    if ($displayName.Length -gt 30) { throw 'FIREBASE_DISPLAY_NAME_INVARIANT_FAILED' }
    return $displayName
}

function Test-S3FirebaseRunCreatedProject {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)]$Resource,[Parameter(Mandatory)]$ProjectRecord)
    if ([string](Get-S3MapValue -Map $ProjectRecord -Name 'status') -ne 'EXISTS') { return $false }
    $projectId = [string](Get-S3MapValue -Map $Resource -Name 'projectId')
    $suffix = ($Context.RunId -replace '[^a-z0-9-]','').ToLowerInvariant()
    if ($suffix.Length -gt 20) { $suffix = $suffix.Substring($suffix.Length-20) }
    if ([string](Get-S3MapValue -Map $Resource -Name 'marker') -ne [string]$Context.RunId -or $projectId -ne "s3cpu-$suffix") { return $false }
    if ([string](Get-S3MapValue -Map $ProjectRecord -Name 'projectId') -ne $projectId) { return $false }
    if ([string](Get-S3MapValue -Map $ProjectRecord -Name 'displayName') -ne (Get-S3FirebaseProjectDisplayName -RunId $Context.RunId)) { return $false }
    if ([string](Get-S3MapValue -Map $ProjectRecord -Name 'lifecycleState') -ne 'ACTIVE') { return $false }
    $projectNumber = [string](Get-S3MapValue -Map $ProjectRecord -Name 'projectNumber')
    if ($projectNumber -notmatch '^[0-9]+$') { return $false }
    try {
        $startedValue = Get-S3MapValue -Map $Context.State -Name 'startedUtc'
        $createdValue = Get-S3MapValue -Map $ProjectRecord -Name 'createTime'
        $started = if ($startedValue -is [datetime]) { [datetimeoffset]::new($startedValue).ToUniversalTime() } else { [datetimeoffset]::Parse([string]$startedValue,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime() }
        $created = if ($createdValue -is [datetime]) { [datetimeoffset]::new($createdValue).ToUniversalTime() } else { [datetimeoffset]::Parse([string]$createdValue,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime() }
    }
    catch { return $false }
    return ($created -ge $started.AddMinutes(-1) -and $created -le [datetimeoffset]::UtcNow.AddMinutes(5))
}

function Set-S3FirebaseProviderVerifiedOwnership {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Resource,
        [Parameter(Mandatory)]$ProjectRecord,
        [ValidateSet('PROJECT_CREATED_AWAITING_FIREBASE','PROJECT_CREATED_FIREBASE_ADD_FAILED')]
        [string]$ProvisioningStatus = 'PROJECT_CREATED_FIREBASE_ADD_FAILED'
    )
    if (-not (Test-S3FirebaseRunCreatedProject -Context $Context -Resource $Resource -ProjectRecord $ProjectRecord)) { return $false }
    if (-not $PSCmdlet.ShouldProcess([string](Get-S3MapValue -Map $Resource -Name 'projectId'),'Record provider-verified Firebase ownership')) { return $false }
    Set-S3MapValue -Map $Resource -Name 'ownershipProof' -Value 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
    Set-S3MapValue -Map $Resource -Name 'provisioningStatus' -Value $ProvisioningStatus
    Set-S3MapValue -Map $Resource -Name 'providerProjectNumber' -Value ([string](Get-S3MapValue -Map $ProjectRecord -Name 'projectNumber'))
    Set-S3MapValue -Map $Resource -Name 'providerCreateTimeUtc' -Value ([string](Get-S3MapValue -Map $ProjectRecord -Name 'createTime'))
    Write-S3State -Root $Context.Root -State $Context.State
    return $true
}

function Get-S3FirebaseAddRequiredPermission {
    return @(
        'firebase.projects.update',
        'resourcemanager.projects.get',
        'serviceusage.services.enable',
        'serviceusage.services.get'
    )
}

function Get-S3FirebaseIamReadiness {
    param(
        [Parameter(Mandatory)][string]$ProjectId,
        [Parameter(Mandatory)][string]$Token
    )
    $required = @(Get-S3FirebaseAddRequiredPermission)
    try {
        $response = Invoke-S3GoogleRest -Method POST -Uri "https://cloudresourcemanager.googleapis.com/v1/projects/${ProjectId}:testIamPermissions" -Token $Token -Body @{permissions=$required}
        $granted = @(Get-S3OptionalRepeatedArrayProperty -InputObject $response -Name 'permissions' | ForEach-Object {[string]$_})
        $missing = @($required | Where-Object { $_ -notin $granted })
        return [ordered]@{queryStatus='PASS';ready=($missing.Count -eq 0);missingPermissions=$missing}
    }
    catch {
        return [ordered]@{queryStatus='RETRYABLE_ERROR';ready=$false;missingPermissions=$required}
    }
}

function Get-S3FirebaseBackendReadiness {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$ProjectId,
        [Parameter(Mandatory)][string]$DisplayName
    )
    $helper = Join-Path $Context.Root 'helpers\firebase_available_project.mjs'
    $firebaseToolsRoot = Join-Path $Context.Root 'tools\npm\node_modules\firebase-tools'
    $quotaProjectId = 'ultra-function-476817-g5'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'FIREBASE_READINESS_HELPER_MISSING' }
    if (-not (Test-Path -LiteralPath $firebaseToolsRoot -PathType Container)) { throw 'FIREBASE_TOOLS_ROOT_MISSING' }
    $result = Invoke-S3Process -Context $Context -FilePath 'node' -ArgumentList @($helper,$firebaseToolsRoot,$ProjectId,$DisplayName,$quotaProjectId) -TimeoutSeconds 90 -AllowFailure -SensitiveOutput
    try { $record = $result.StdOut | ConvertFrom-Json }
    catch { throw 'FIREBASE_AVAILABLE_PROJECTS_PROBE_JSON_INVALID' }
    $status = [string](Get-S3MapValue -Map $record -Name 'status')
    $code = [string](Get-S3MapValue -Map $record -Name 'code')
    if ($result.ExitCode -eq 10 -and $status -eq 'ERROR' -and $code -eq 'AVAILABLE_PROJECTS_QUERY_FAILED') {
        $httpStatus = Get-S3MapValue -Map $record -Name 'httpStatus'
        if ($null -ne $httpStatus) { $httpStatus = Get-S3RequiredNonNegativeInteger -InputObject $record -Name 'httpStatus' }
        return [ordered]@{queryStatus='RETRYABLE_ERROR';httpStatus=$httpStatus;ready=$false;pagesScanned=0;projectCount=0}
    }
    if ($result.ExitCode -ne 0 -or $status -ne 'PASS') {
        throw "FIREBASE_AVAILABLE_PROJECTS_PROBE_FAILED:$code"
    }
    $available = Get-S3MapValue -Map $record -Name 'available'
    $displayNameMatch = Get-S3MapValue -Map $record -Name 'displayNameMatch'
    if ($available -isnot [bool] -or $displayNameMatch -isnot [bool]) { throw 'FIREBASE_AVAILABLE_PROJECTS_PROBE_SCHEMA_INVALID' }
    $pagesScanned = Get-S3RequiredNonNegativeInteger -InputObject $record -Name 'pagesScanned'
    $projectCount = Get-S3RequiredNonNegativeInteger -InputObject $record -Name 'projectCount'
    return [ordered]@{queryStatus='PASS';ready=([bool]$available -and [bool]$displayNameMatch);pagesScanned=$pagesScanned;projectCount=$projectCount}
}

function Get-S3FirebaseAddReadiness {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Resource,
        [Parameter(Mandatory)][string]$DisplayName
    )
    $projectId = [string](Get-S3MapValue -Map $Resource -Name 'projectId')
    $projectRecord = Get-S3FirebaseProjectRecord -Context $Context -ProjectId $projectId
    $projectStatus = [string](Get-S3MapValue -Map $projectRecord -Name 'status')
    $projectReady = Test-S3FirebaseRunCreatedProject -Context $Context -Resource $Resource -ProjectRecord $projectRecord
    if ($projectStatus -eq 'EXISTS' -and -not $projectReady) { throw 'FIREBASE_PROVIDER_OWNERSHIP_DRIFT' }
    if (-not $projectReady) {
        return [ordered]@{ready=$false;projectReady=$false;iamReady=$false;firebaseBackendReady=$false;iamQueryStatus='NOT_REACHED';firebaseQueryStatus='NOT_REACHED';projectRecord=$projectRecord;missingPermissions=@(Get-S3FirebaseAddRequiredPermission)}
    }
    $token = $null
    try {
        $token = Get-S3GoogleAccessToken -Context $Context
        $iam = Get-S3FirebaseIamReadiness -ProjectId $projectId -Token $token
    }
    finally {
        $token = $null
        [GC]::Collect()
    }
    $backend = Get-S3FirebaseBackendReadiness -Context $Context -ProjectId $projectId -DisplayName $DisplayName
    $ready = [bool]$projectReady -and [bool]$iam.ready -and [bool]$backend.ready
    return [ordered]@{
        ready=$ready;projectReady=[bool]$projectReady;iamReady=[bool]$iam.ready;firebaseBackendReady=[bool]$backend.ready
        iamQueryStatus=[string]$iam.queryStatus;firebaseQueryStatus=[string]$backend.queryStatus
        firebaseQueryHttpStatus=(Get-S3MapValue -Map $backend -Name 'httpStatus')
        projectRecord=$projectRecord;missingPermissions=@($iam.missingPermissions)
        pagesScanned=[int64]$backend.pagesScanned;projectCount=[int64]$backend.projectCount
    }
}

function Wait-S3FirebaseAddReadiness {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Resource,
        [Parameter(Mandatory)][string]$DisplayName,
        [ValidateRange(0,1800)][int]$TimeoutSeconds = 600,
        [ValidateRange(0,60)][int]$RetryDelaySeconds = 10,
        [scriptblock]$Now = {[DateTime]::UtcNow},
        [scriptblock]$Sleep = {param($Seconds) Start-Sleep -Seconds $Seconds}
    )
    $deadline = (& $Now).AddSeconds($TimeoutSeconds)
    $attempt = 0
    $lastFailureFingerprint = $null
    $identicalFailureCount = 0
    do {
        $attempt++
        $proof = Get-S3FirebaseAddReadiness -Context $Context -Resource $Resource -DisplayName $DisplayName
        $observedUtc = (& $Now).ToUniversalTime().ToString('o')
        $failureFingerprint = $null
        $providerStateChanged = $false
        if (-not $proof.ready) {
            $projectRecord = Get-S3MapValue -Map $proof -Name 'projectRecord'
            $fingerprintPayload = [ordered]@{
                projectReady=[bool]$proof.projectReady
                iamReady=[bool]$proof.iamReady
                firebaseBackendReady=[bool]$proof.firebaseBackendReady
                iamQueryStatus=[string](Get-S3MapValue -Map $proof -Name 'iamQueryStatus')
                firebaseQueryStatus=[string](Get-S3MapValue -Map $proof -Name 'firebaseQueryStatus')
                firebaseQueryHttpStatus=(Get-S3MapValue -Map $proof -Name 'firebaseQueryHttpStatus')
                missingPermissions=@(Get-S3MapValue -Map $proof -Name 'missingPermissions' | Sort-Object)
                pagesScanned=[int64](Get-S3MapValue -Map $proof -Name 'pagesScanned')
                projectCount=[int64](Get-S3MapValue -Map $proof -Name 'projectCount')
                projectStatus=[string](Get-S3MapValue -Map $projectRecord -Name 'status')
                lifecycleState=[string](Get-S3MapValue -Map $projectRecord -Name 'lifecycleState')
            }
            $fingerprintJson = $fingerprintPayload | ConvertTo-Json -Depth 5 -Compress
            $fingerprintBytes = [Text.Encoding]::UTF8.GetBytes($fingerprintJson)
            $failureFingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($fingerprintBytes)).ToLowerInvariant()
            $providerStateChanged = $null -ne $lastFailureFingerprint -and $failureFingerprint -ne $lastFailureFingerprint
            if ($failureFingerprint -eq $lastFailureFingerprint) { $identicalFailureCount++ }
            else { $lastFailureFingerprint = $failureFingerprint; $identicalFailureCount = 1 }
        }
        if ($proof.projectReady -and [string](Get-S3MapValue -Map $Resource -Name 'ownershipProof') -ne 'CREATE_SUCCEEDED_PROVIDER_VERIFIED') {
            if (-not (Set-S3FirebaseProviderVerifiedOwnership -Context $Context -Resource $Resource -ProjectRecord $proof.projectRecord -ProvisioningStatus 'PROJECT_CREATED_AWAITING_FIREBASE')) {
                throw 'FIREBASE_PROVIDER_OWNERSHIP_PROOF_FAILED'
            }
        }
        Set-S3MapValue -Map $Resource -Name 'readinessStatus' -Value $(if ($proof.ready) {'PASS'} else {'POLLING'})
        Set-S3MapValue -Map $Resource -Name 'readinessAttempts' -Value $attempt
        Set-S3MapValue -Map $Resource -Name 'lastReadinessUtc' -Value $observedUtc
        Set-S3MapValue -Map $Resource -Name 'projectReady' -Value ([bool]$proof.projectReady)
        Set-S3MapValue -Map $Resource -Name 'iamReady' -Value ([bool]$proof.iamReady)
        Set-S3MapValue -Map $Resource -Name 'firebaseBackendReady' -Value ([bool]$proof.firebaseBackendReady)
        Set-S3MapValue -Map $Resource -Name 'iamReadinessQueryStatus' -Value ([string](Get-S3MapValue -Map $proof -Name 'iamQueryStatus'))
        Set-S3MapValue -Map $Resource -Name 'firebaseReadinessQueryStatus' -Value ([string](Get-S3MapValue -Map $proof -Name 'firebaseQueryStatus'))
        Set-S3MapValue -Map $Resource -Name 'firebaseReadinessHttpStatus' -Value (Get-S3MapValue -Map $proof -Name 'firebaseQueryHttpStatus')
        Set-S3MapValue -Map $Resource -Name 'missingFirebaseAddPermissionCount' -Value (@(Get-S3MapValue -Map $proof -Name 'missingPermissions').Count)
        Set-S3MapValue -Map $Resource -Name 'firebaseAvailableProjectsPagesScanned' -Value ([int64](Get-S3MapValue -Map $proof -Name 'pagesScanned'))
        Set-S3MapValue -Map $Resource -Name 'readinessFailureFingerprint' -Value $failureFingerprint
        Set-S3MapValue -Map $Resource -Name 'identicalReadinessFailureCount' -Value $identicalFailureCount
        Set-S3MapValue -Map $Resource -Name 'providerStateChanged' -Value $providerStateChanged
        if ($attempt -eq 1) {
            Set-S3MapValue -Map $Resource -Name 'readinessStartedUtc' -Value $observedUtc
            Set-S3MapValue -Map $Resource -Name 'initialProjectReady' -Value ([bool]$proof.projectReady)
            Set-S3MapValue -Map $Resource -Name 'initialIamReady' -Value ([bool]$proof.iamReady)
            Set-S3MapValue -Map $Resource -Name 'initialFirebaseBackendReady' -Value ([bool]$proof.firebaseBackendReady)
        }
        if ($proof.iamReady -and $null -eq (Get-S3MapValue -Map $Resource -Name 'iamReadyAtAttempt')) {
            Set-S3MapValue -Map $Resource -Name 'iamReadyAtAttempt' -Value $attempt
            Set-S3MapValue -Map $Resource -Name 'iamReadyAtUtc' -Value $observedUtc
        }
        if ($proof.firebaseBackendReady -and $null -eq (Get-S3MapValue -Map $Resource -Name 'firebaseBackendReadyAtAttempt')) {
            Set-S3MapValue -Map $Resource -Name 'firebaseBackendReadyAtAttempt' -Value $attempt
            Set-S3MapValue -Map $Resource -Name 'firebaseBackendReadyAtUtc' -Value $observedUtc
        }
        Write-S3State -Root $Context.Root -State $Context.State
        if ($proof.ready) {
            Set-S3MapValue -Map $Resource -Name 'readyAtUtc' -Value $observedUtc
            Write-S3State -Root $Context.Root -State $Context.State
            return [ordered]@{status='PASS';attempts=$attempt;projectReady=$true;iamReady=$true;firebaseBackendReady=$true}
        }
        if ($identicalFailureCount -ge 3) {
            Set-S3MapValue -Map $Resource -Name 'readinessStatus' -Value 'CIRCUIT_BREAKER'
            Write-S3State -Root $Context.Root -State $Context.State
            throw "FIREBASE_ADD_READINESS_CIRCUIT_BREAKER:$failureFingerprint"
        }
        if ((& $Now) -ge $deadline) { break }
        & $Sleep $RetryDelaySeconds
    } while ($true)
    Set-S3MapValue -Map $Resource -Name 'readinessStatus' -Value 'TIMEOUT'
    Write-S3State -Root $Context.Root -State $Context.State
    throw 'FIREBASE_ADD_READINESS_TIMEOUT'
}

function Assert-S3FirebaseThirdSignupRejected {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword','',Justification='Synthetic one-run password is used only to prove that public Firebase signup is disabled.')]
    param([Parameter(Mandatory)][string]$ApiKey)
    $password = Get-S3SyntheticPassword
    $email = 'p3-' + [guid]::NewGuid().ToString('N') + '@example.invalid'
    try {
        Invoke-RestMethod -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=$ApiKey" -ContentType 'application/json' -Body (@{email=$email;password=$password;returnSecureToken=$true} | ConvertTo-Json -Compress) -TimeoutSec 90 | Out-Null
    }
    catch {
        $diagnostic = (@([string]$_,[string]$_.Exception.Message) -join ' ')
        if ($diagnostic -notmatch '(?i)OPERATION_NOT_ALLOWED|ADMIN_ONLY_OPERATION|signup.*disabled') {
            throw 'FIREBASE_THIRD_SIGNUP_REJECTION_UNPROVEN'
        }
        return [ordered]@{status='PASS';rejected=$true;identity='SYNTHETIC_UNREGISTERED'}
    }
    finally {
        $password = $null
        $email = $null
        [GC]::Collect()
    }
    throw 'FIREBASE_THIRD_SIGNUP_ACCEPTED'
}

function Invoke-S3FirebaseProvision {
    param([Parameter(Mandatory)]$Context)
    if ($Context.Mode -eq 'Simulation') {
        $id = "s3cpu-mock-$($Context.RunId.Substring($Context.RunId.Length-8))"
        $resource = [ordered]@{projectId=$id;marker=$Context.RunId;billing=$false;users=2}
        Set-S3MapValue -Map $Context.State.resources -Name 'firebase' -Value $resource
        $Context.RuntimeSecrets.uid1='mock-uid-person-1'
        $Context.RuntimeSecrets.uid2='mock-uid-person-2'
        $Context.RuntimeSecrets.token1='mock-token-1'
        $Context.RuntimeSecrets.token2='mock-token-2'
        return [ordered]@{status='SIMULATED';projectId=$id;spark=$true;billing=$false;users=2;secrets='MEMORY_ONLY'}
    }
    if ($Context.Mode -ne 'Live') { return [ordered]@{status='PLANNED'} }
    Assert-S3PreexistingGoogleCliSession -Context $Context
    $suffix = ($Context.RunId -replace '[^a-z0-9-]','').ToLowerInvariant()
    if ($suffix.Length -gt 20) { $suffix = $suffix.Substring($suffix.Length-20) }
    $projectId = "s3cpu-$suffix"
    $display = Get-S3FirebaseProjectDisplayName -RunId $Context.RunId
    $password1=$null;$password2=$null;$accessToken=$null;$id1=$null;$id2=$null;$apiKey=$null
    try {
        $preCreatePresence = Get-S3FirebaseProjectPresence -Context $Context -ProjectId $projectId
        if ($preCreatePresence -eq 'EXISTS') { throw 'FIREBASE_PROJECT_NAME_ALREADY_EXISTS' }
        if ($preCreatePresence -notin @('ABSENT','UNKNOWN')) { throw 'FIREBASE_PROJECT_PRESENCE_INVALID' }
        $preCreateAbsence = if ($preCreatePresence -eq 'ABSENT') { 'PASS' } else { 'UNVERIFIABLE' }
        $resource = [ordered]@{
            projectId=$projectId;marker=$Context.RunId;billing=$null;users=0
            provisioningStatus='PROJECT_CREATE_PENDING';cleanupStatus=$null
            preCreatePresence=$preCreatePresence;preCreateAbsence=$preCreateAbsence
            ownershipProof='PENDING_CREATE_SUCCESS'
        }
        Set-S3MapValue -Map $Context.State.resources -Name 'firebase' -Value $resource
        Write-S3State -Root $Context.Root -State $Context.State
        $createResult = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','create',$projectId,'--name',$display,'--no-enable-cloud-apis','--quiet','--format=json') -TimeoutSeconds 600 -AllowFailure
        if ($createResult.ExitCode -ne 0) {
            $createDiagnostic = Protect-S3Text ((@([string]$createResult.StdOut,[string]$createResult.StdErr) -join "`n").Trim())
            $postFailureProject = Get-S3FirebaseProjectRecord -Context $Context -ProjectId $projectId
            if (-not (Set-S3FirebaseProviderVerifiedOwnership -Context $Context -Resource $resource -ProjectRecord $postFailureProject -ProvisioningStatus 'PROJECT_CREATED_AWAITING_FIREBASE')) {
                $postFailureStatus = [string](Get-S3MapValue -Map $postFailureProject -Name 'status')
                if ($postFailureStatus -eq 'ABSENT') {
                    Set-S3MapValue -Map $resource -Name 'ownershipProof' -Value 'CREATE_FAILED_UNOWNED'
                    Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'PROJECT_CREATE_FAILED'
                }
                else {
                    Set-S3MapValue -Map $resource -Name 'ownershipProof' -Value 'PENDING_CREATE_OUTCOME_UNKNOWN'
                    Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'PROJECT_CREATE_OUTCOME_UNKNOWN'
                }
                Write-S3State -Root $Context.Root -State $Context.State
                if ([string]::IsNullOrWhiteSpace($createDiagnostic)) {
                    throw "FIREBASE_PROJECT_CREATE_FAILED_NO_DIAGNOSTIC: exit=$($createResult.ExitCode)"
                }
                throw "FIREBASE_PROJECT_CREATE_FAILED: exit=$($createResult.ExitCode): $createDiagnostic"
            }
        }
        if ([string](Get-S3MapValue -Map $resource -Name 'ownershipProof') -ne 'CREATE_SUCCEEDED_PROVIDER_VERIFIED') {
            Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'PROJECT_CREATED_AWAITING_PROVIDER_PROOF'
        }
        Write-S3State -Root $Context.Root -State $Context.State
        [void](Wait-S3FirebaseAddReadiness -Context $Context -Resource $resource -DisplayName $display)
        $addResult = Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('projects:addfirebase',$projectId,'--json','--non-interactive') -TimeoutSeconds 600 -AllowFailure
        if ($addResult.ExitCode -ne 0) {
            Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'PROJECT_CREATED_FIREBASE_ADD_FAILED'
            Write-S3State -Root $Context.Root -State $Context.State
            $addDiagnostic = Protect-S3Text ((@([string]$addResult.StdOut,[string]$addResult.StdErr) -join "`n").Trim())
            if ([string]::IsNullOrWhiteSpace($addDiagnostic)) { throw "FIREBASE_ADD_FAILED_AFTER_READINESS_NO_DIAGNOSTIC: exit=$($addResult.ExitCode)" }
            throw "FIREBASE_ADD_FAILED_AFTER_READINESS: exit=$($addResult.ExitCode): $addDiagnostic"
        }
        try { $addResponse = $addResult.StdOut | ConvertFrom-Json }
        catch { throw 'FIREBASE_ADD_RESPONSE_JSON_INVALID' }
        if ([string](Get-S3MapValue -Map $addResponse -Name 'status') -ne 'success') { throw 'FIREBASE_ADD_RESPONSE_NOT_SUCCESS' }
        Set-S3MapValue -Map $resource -Name 'ownershipProof' -Value 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
        Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'PROJECT_CREATED'
        Set-S3MapValue -Map $resource -Name 'firebaseAddedAtUtc' -Value ([DateTime]::UtcNow.ToString('o'))
        Write-S3State -Root $Context.Root -State $Context.State
        $billingProof = Assert-S3GoogleNoBilling -Context $Context -ProjectId $projectId
        $apps = (Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('apps:create','WEB','s3-cpu-gate','--project',$projectId,'--json','--non-interactive') -TimeoutSeconds 300).StdOut | ConvertFrom-Json
        $appId = [string]($apps.result.appId ?? $apps.appId)
        if ([string]::IsNullOrWhiteSpace($appId)) { throw 'FIREBASE_WEB_APP_ID_MISSING' }
        $sdk = (Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('apps:sdkconfig','WEB',$appId,'--project',$projectId,'--json') -TimeoutSeconds 180 -SensitiveOutput).StdOut | ConvertFrom-Json
        $apiKey = [string]($sdk.result.sdkConfig.apiKey ?? $sdk.sdkConfig.apiKey)
        if ([string]::IsNullOrWhiteSpace($apiKey)) { throw 'FIREBASE_WEB_API_KEY_MISSING' }
        $accessToken = Get-S3GoogleAccessToken -Context $Context
        $configUri = "https://identitytoolkit.googleapis.com/admin/v2/projects/$projectId/config"
        $body = @{name="projects/$projectId/config";signIn=@{email=@{enabled=$true;passwordRequired=$true};phoneNumber=@{enabled=$false};anonymous=@{enabled=$false};allowDuplicateEmails=$false};client=@{permissions=@{disabledUserSignup=$true;disabledUserDeletion=$true}}}
        $mask = 'signIn.email.enabled,signIn.email.passwordRequired,signIn.phoneNumber.enabled,signIn.anonymous.enabled,signIn.allowDuplicateEmails,client.permissions.disabledUserSignup,client.permissions.disabledUserDeletion'
        Invoke-S3GoogleRest -Method PATCH -Uri "${configUri}?updateMask=$mask" -Token $accessToken -Body $body | Out-Null
        $providerProof = Disable-S3FederatedProvider -ProjectId $projectId -Token $accessToken
        $configuration = Invoke-S3GoogleRest -Method GET -Uri $configUri -Token $accessToken
        $configProof = Assert-S3FirebaseConfiguration -Configuration $configuration -ProviderProof $providerProof
        $existing = Get-S3FirebaseUser -ProjectId $projectId -Token $accessToken
        $emptyProof = Assert-S3FirebaseUserSet -Users $existing -ExpectedUids @()
        $uid1 = 'p1-' + [guid]::NewGuid().ToString('N')
        $uid2 = 'p2-' + [guid]::NewGuid().ToString('N')
        $email1 = "$uid1@example.invalid"
        $email2 = "$uid2@example.invalid"
        $password1 = Get-S3SyntheticPassword
        $password2 = Get-S3SyntheticPassword
        New-S3FirebaseAdminUser -ProjectId $projectId -ApiKey $apiKey -Token $accessToken -Uid $uid1 -Email $email1 -Password $password1
        New-S3FirebaseAdminUser -ProjectId $projectId -ApiKey $apiKey -Token $accessToken -Uid $uid2 -Email $email2 -Password $password2
        $users = Get-S3FirebaseUser -ProjectId $projectId -Token $accessToken
        $userProof = Assert-S3FirebaseUserSet -Users $users -ExpectedUids @($uid1,$uid2)
        $thirdSignupProof = Assert-S3FirebaseThirdSignupRejected -ApiKey $apiKey
        $id1 = Get-S3FirebaseIdToken -ApiKey $apiKey -Email $email1 -Password $password1
        $id2 = Get-S3FirebaseIdToken -ApiKey $apiKey -Email $email2 -Password $password2
        $Context.RuntimeSecrets.projectId=$projectId
        $Context.RuntimeSecrets.apiKey=$apiKey
        $Context.RuntimeSecrets.uid1=$uid1
        $Context.RuntimeSecrets.uid2=$uid2
        $Context.RuntimeSecrets.email1=$email1
        $Context.RuntimeSecrets.email2=$email2
        $Context.RuntimeSecrets.token1=$id1.IdToken
        $Context.RuntimeSecrets.token2=$id2.IdToken
        $Context.RuntimeSecrets.password1=$password1
        $Context.RuntimeSecrets.password2=$password2
        $Context.RuntimeSecrets.refreshToken1=$id1.RefreshToken
        $Context.RuntimeSecrets.refreshToken2=$id2.RefreshToken
        $firebaseResource = Get-S3MapValue -Map $Context.State.resources -Name 'firebase'
        Set-S3MapValue -Map $firebaseResource -Name 'users' -Value 2
        Set-S3MapValue -Map $firebaseResource -Name 'billing' -Value $false
        Set-S3MapValue -Map $Context.State.results -Name 'firebaseGuard' -Value ([ordered]@{
            spark=$true
            billingProof=$billingProof
            emailPasswordOnly=$configProof.emailPasswordOnly
            disabledUserSignup=$true
            disabledUserDeletion=$true
            phone=$false
            anonymous=$false
            duplicateEmails=$false
            otherProviders=$configProof.otherProviders
            providerProof=$providerProof
            projectInitiallyEmpty=$emptyProof.verified
            userCount=$userProof.count
            providerLinks=$userProof.providerLinks
            thirdSignupRejected=$thirdSignupProof.rejected
        })
        return [ordered]@{status='PASS';projectId=$projectId;spark=$true;billing=$false;users=2;secrets='MEMORY_ONLY'}
    }
    finally {
        $accessToken=$null;$password1=$null;$password2=$null;$id1=$null;$id2=$null;$apiKey=$null
        [GC]::Collect()
    }
}

function Remove-S3FirebaseProject {
    [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
    param([Parameter(Mandatory)]$Context)
    $resource = Get-S3MapValue -Map $Context.State.resources -Name 'firebase'
    if ($null -eq $resource) { return [ordered]@{status='NOT_CREATED'} }
    $projectId = [string](Get-S3MapValue -Map $resource -Name 'projectId')
    if ((Get-S3MapValue -Map $resource -Name 'marker') -ne $Context.RunId -or $projectId -notlike 's3cpu-*') { throw 'رفض حذف Firebase غير مملوكة.' }
    if ($Context.Mode -eq 'Live') {
        $suffix = ($Context.RunId -replace '[^a-z0-9-]','').ToLowerInvariant()
        if ($suffix.Length -gt 20) { $suffix = $suffix.Substring($suffix.Length-20) }
        if ($projectId -ne "s3cpu-$suffix") { throw 'FIREBASE_PROJECT_ID_NOT_DETERMINISTIC' }
        $ownershipProof = [string](Get-S3MapValue -Map $resource -Name 'ownershipProof')
        $projectRecord = $null
        if ($ownershipProof -in @('CREATE_FAILED_UNOWNED','PENDING_CREATE_SUCCESS','PENDING_CREATE_OUTCOME_UNKNOWN')) {
            $projectRecord = Get-S3FirebaseProjectRecord -Context $Context -ProjectId $projectId
            if (Set-S3FirebaseProviderVerifiedOwnership -Context $Context -Resource $resource -ProjectRecord $projectRecord) {
                $ownershipProof = 'CREATE_SUCCEEDED_PROVIDER_VERIFIED'
            }
            elseif ([string](Get-S3MapValue -Map $projectRecord -Name 'status') -eq 'ABSENT') {
                Set-S3MapValue -Map $resource -Name 'cleanupStatus' -Value 'ALREADY_ABSENT'
                Write-S3State -Root $Context.Root -State $Context.State
                return [ordered]@{status='ALREADY_ABSENT';projectId=$projectId}
            }
        }
        $legacyPreCreateAbsence = [string](Get-S3MapValue -Map $resource -Name 'preCreateAbsence')
        $legacyOwnership = [string]::IsNullOrWhiteSpace($ownershipProof) -and $legacyPreCreateAbsence -eq 'PASS'
        if ($ownershipProof -notin @('CREATE_SUCCEEDED','CREATE_SUCCEEDED_PROVIDER_VERIFIED') -and -not $legacyOwnership) { throw 'FIREBASE_PROJECT_OWNERSHIP_PROOF_MISSING' }
        $presence = if ($null -ne $projectRecord) { [string](Get-S3MapValue -Map $projectRecord -Name 'status') } else { Get-S3FirebaseProjectPresence -Context $Context -ProjectId $projectId }
        if ($presence -eq 'ABSENT') {
            Set-S3MapValue -Map $resource -Name 'cleanupStatus' -Value 'ALREADY_ABSENT'
            Write-S3State -Root $Context.Root -State $Context.State
            return [ordered]@{status='ALREADY_ABSENT';projectId=$projectId}
        }
        if ($presence -ne 'EXISTS') { throw 'FIREBASE_PROJECT_PRESENCE_UNVERIFIABLE' }
    }
    if ((Get-S3MapValue -Map $resource -Name 'cleanupStatus') -eq 'DELETE_REQUESTED') { return [ordered]@{status='ALREADY_DELETE_REQUESTED';projectId=$projectId} }
    if (-not $PSCmdlet.ShouldProcess($projectId,'Delete owned Firebase project')) { return [ordered]@{status='SKIPPED';projectId=$projectId} }
    if ($Context.Mode -eq 'Simulation') {
        Set-S3MapValue -Map $resource -Name 'cleanupStatus' -Value 'DELETE_REQUESTED'
        return [ordered]@{status='DELETE_REQUESTED';projectId=$projectId}
    }
    Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','delete',$projectId,'--quiet') -TimeoutSeconds 300 | Out-Null
    $describe = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','describe',$projectId,'--format=value(lifecycleState)') -AllowFailure
    if ($describe.ExitCode -eq 0 -and $describe.StdOut.Trim() -notin @('DELETE_REQUESTED','DELETE_IN_PROGRESS')) { throw 'FIREBASE_DELETE_NOT_PROVEN' }
    if ($describe.ExitCode -ne 0 -and $describe.StdErr -notmatch '(?i)not found|does not exist') { throw 'FIREBASE_DELETE_VERIFY_FAILED' }
    Set-S3MapValue -Map $resource -Name 'cleanupStatus' -Value 'DELETE_REQUESTED'
    Write-S3State -Root $Context.Root -State $Context.State
    return [ordered]@{status='DELETE_REQUESTED';projectId=$projectId}
}

Export-ModuleMember -Function *-S3*
