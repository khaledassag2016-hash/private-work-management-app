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
        if ($links.Count -ne 0) { throw 'FIREBASE_USER_PROVIDER_LINK_PRESENT' }
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

function Get-S3FirebaseProjectPresence {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$ProjectId)
    $result = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','describe',$ProjectId,'--format=json') -TimeoutSeconds 120 -AllowFailure
    if ($result.ExitCode -eq 0) { return 'EXISTS' }
    $diagnostic = @([string]$result.StdErr,[string]$result.StdOut) -join "`n"
    if ($diagnostic -match '(?i)permission_denied|permission denied|access denied|forbidden|unauthorized|\b(?:401|403)\b') { return 'UNKNOWN' }
    if ($diagnostic -match '(?i)\bNOT_FOUND\b|requested entity was not found|\bproject\b[^\r\n]*\bwas not found\b') { return 'ABSENT' }
    return 'UNKNOWN'
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
    $display = "S3 CPU Gate $($Context.RunId)"
    $password1=$null;$password2=$null;$accessToken=$null;$id1=$null;$id2=$null;$apiKey=$null
    try {
        $preCreatePresence = Get-S3FirebaseProjectPresence -Context $Context -ProjectId $projectId
        if ($preCreatePresence -eq 'EXISTS') { throw 'FIREBASE_PROJECT_NAME_ALREADY_EXISTS' }
        if ($preCreatePresence -ne 'ABSENT') { throw 'FIREBASE_PROJECT_ABSENCE_UNVERIFIABLE' }
        $resource = [ordered]@{
            projectId=$projectId;marker=$Context.RunId;billing=$null;users=0
            provisioningStatus='PROJECT_CREATE_PENDING';cleanupStatus=$null;preCreateAbsence='PASS'
        }
        Set-S3MapValue -Map $Context.State.resources -Name 'firebase' -Value $resource
        Write-S3State -Root $Context.Root -State $Context.State
        $createResult = Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('projects:create',$projectId,'--display-name',$display,'--json','--non-interactive') -TimeoutSeconds 600 -AllowFailure
        if ($createResult.ExitCode -ne 0) {
            $createDiagnostic = Protect-S3Text ((@([string]$createResult.StdOut,[string]$createResult.StdErr) -join "`n").Trim())
            if ([string]::IsNullOrWhiteSpace($createDiagnostic)) {
                throw "FIREBASE_PROJECT_CREATE_FAILED_NO_DIAGNOSTIC: exit=$($createResult.ExitCode)"
            }
            throw "FIREBASE_PROJECT_CREATE_FAILED: exit=$($createResult.ExitCode): $createDiagnostic"
        }
        Set-S3MapValue -Map $resource -Name 'provisioningStatus' -Value 'PROJECT_CREATED'
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
        if ((Get-S3MapValue -Map $resource -Name 'preCreateAbsence') -ne 'PASS') { throw 'FIREBASE_PROJECT_OWNERSHIP_PROOF_MISSING' }
        $presence = Get-S3FirebaseProjectPresence -Context $Context -ProjectId $projectId
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
