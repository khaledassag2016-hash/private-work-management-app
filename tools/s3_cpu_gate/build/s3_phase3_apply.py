from pathlib import Path
import re

ROOT = Path.cwd()


def write_text(path: str, content: str, bom: bool = False) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    encoding = 'utf-8-sig' if bom else 'utf-8'
    target.write_text(content.strip('\n') + '\n', encoding=encoding)


def replace_once(path: str, pattern: str, replacement: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8-sig')
    updated, count = re.subn(pattern, replacement.strip('\n') + '\n', text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f'Expected exactly one match in {path}, got {count}')
    target.write_text(updated, encoding='utf-8-sig')


firebase = r'''
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
        $response = Invoke-S3GoogleRest -Method GET -Uri "$base/$collection" -Token $Token
        $items = @(Get-S3RequiredArrayProperty -InputObject $response -Name $collection)
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
    return @(Get-S3RequiredArrayProperty -InputObject $response -Name 'userInfo')
}

function Assert-S3FirebaseUsers {
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

function Assert-S3PreexistingGoogleCliSessions {
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
    Assert-S3PreexistingGoogleCliSessions -Context $Context
    $suffix = ($Context.RunId -replace '[^a-z0-9-]','').ToLowerInvariant()
    if ($suffix.Length -gt 20) { $suffix = $suffix.Substring($suffix.Length-20) }
    $projectId = "s3cpu-$suffix"
    $display = "S3 CPU Gate $($Context.RunId)"
    $password1=$null;$password2=$null;$accessToken=$null;$id1=$null;$id2=$null;$apiKey=$null
    try {
        Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('projects:create',$projectId,'--display-name',$display,'--json','--non-interactive') -TimeoutSeconds 600 | Out-Null
        $resource = [ordered]@{projectId=$projectId;marker=$Context.RunId;billing=$null;users=0}
        Set-S3MapValue -Map $Context.State.resources -Name 'firebase' -Value $resource
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
        Invoke-S3GoogleRest -Method PATCH -Uri "$configUri?updateMask=$mask" -Token $accessToken -Body $body | Out-Null
        $providerProof = Disable-S3FederatedProvider -ProjectId $projectId -Token $accessToken
        $configuration = Invoke-S3GoogleRest -Method GET -Uri $configUri -Token $accessToken
        $configProof = Assert-S3FirebaseConfiguration -Configuration $configuration -ProviderProof $providerProof
        $existing = Get-S3FirebaseUser -ProjectId $projectId -Token $accessToken
        $emptyProof = Assert-S3FirebaseUsers -Users $existing -ExpectedUids @()
        $uid1 = 'p1-' + [guid]::NewGuid().ToString('N')
        $uid2 = 'p2-' + [guid]::NewGuid().ToString('N')
        $email1 = "$uid1@example.invalid"
        $email2 = "$uid2@example.invalid"
        $password1 = Get-S3SyntheticPassword
        $password2 = Get-S3SyntheticPassword
        New-S3FirebaseAdminUser -ProjectId $projectId -ApiKey $apiKey -Token $accessToken -Uid $uid1 -Email $email1 -Password $password1
        New-S3FirebaseAdminUser -ProjectId $projectId -ApiKey $apiKey -Token $accessToken -Uid $uid2 -Email $email2 -Password $password2
        $users = Get-S3FirebaseUser -ProjectId $projectId -Token $accessToken
        $userProof = Assert-S3FirebaseUsers -Users $users -ExpectedUids @($uid1,$uid2)
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
'''

cleanup = r'''
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-S3CliSessionStatusRecord {
    param([string]$Status,[bool]$PreExisting,[string]$Evidence)
    return [ordered]@{status=$Status;preExisting=$PreExisting;createdByTool=$false;evidence=$Evidence}
}

function Initialize-S3CliSessionInventory {
    param([Parameter(Mandatory)]$Context)
    if ($Context.Mode -eq 'Plan') {
        $record = [ordered]@{
            firebase=(Get-S3CliSessionStatusRecord -Status 'NOT_CHECKED' -PreExisting $false -Evidence 'PLAN_MODE')
            gcloud=(Get-S3CliSessionStatusRecord -Status 'NOT_CHECKED' -PreExisting $false -Evidence 'PLAN_MODE')
            cloudflare=(Get-S3CliSessionStatusRecord -Status 'NOT_CHECKED' -PreExisting $false -Evidence 'PLAN_MODE')
        }
        Set-S3MapValue -Map $Context.State.results -Name 'cliSessions' -Value $record
        return $record
    }
    if ($Context.Mode -eq 'Simulation') {
        $record = [ordered]@{
            firebase=(Get-S3CliSessionStatusRecord -Status 'SIMULATED' -PreExisting $false -Evidence 'NO_LOGIN_EXECUTED')
            gcloud=(Get-S3CliSessionStatusRecord -Status 'SIMULATED' -PreExisting $false -Evidence 'NO_LOGIN_EXECUTED')
            cloudflare=(Get-S3CliSessionStatusRecord -Status 'SIMULATED' -PreExisting $false -Evidence 'NO_LOGIN_EXECUTED')
        }
        Set-S3MapValue -Map $Context.State.results -Name 'cliSessions' -Value $record
        return $record
    }
    $record = [ordered]@{}
    $firebaseResult = Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('login:list','--json') -TimeoutSeconds 60 -AllowFailure -SensitiveOutput
    if ($firebaseResult.ExitCode -ne 0) {
        $record.firebase = Get-S3CliSessionStatusRecord -Status 'ABSENT' -PreExisting $false -Evidence 'login:list exit nonzero'
    }
    else {
        try {
            $json = $firebaseResult.StdOut | ConvertFrom-Json
            $items = @(Get-S3MapValue -Map $json -Name 'result')
            $status = if ($items.Count -gt 0) {'PREEXISTING'} else {'ABSENT'}
            $record.firebase = Get-S3CliSessionStatusRecord -Status $status -PreExisting ($status -eq 'PREEXISTING') -Evidence 'login:list parsed'
        }
        catch { $record.firebase = Get-S3CliSessionStatusRecord -Status 'UNKNOWN' -PreExisting $false -Evidence 'login:list JSON invalid' }
    }
    $gcloudResult = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','list','--filter=status:ACTIVE','--format=json') -TimeoutSeconds 60 -AllowFailure -SensitiveOutput
    if ($gcloudResult.ExitCode -ne 0) {
        $record.gcloud = Get-S3CliSessionStatusRecord -Status 'ABSENT' -PreExisting $false -Evidence 'auth list exit nonzero'
    }
    else {
        try {
            $items = @($gcloudResult.StdOut | ConvertFrom-Json)
            $status = if ($items.Count -gt 0) {'PREEXISTING'} else {'ABSENT'}
            $record.gcloud = Get-S3CliSessionStatusRecord -Status $status -PreExisting ($status -eq 'PREEXISTING') -Evidence 'auth list parsed'
        }
        catch { $record.gcloud = Get-S3CliSessionStatusRecord -Status 'UNKNOWN' -PreExisting $false -Evidence 'auth list JSON invalid' }
    }
    $cloudflareResult = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('auth','token','--json') -TimeoutSeconds 60 -AllowFailure -SensitiveOutput
    if ($cloudflareResult.ExitCode -ne 0) {
        $record.cloudflare = Get-S3CliSessionStatusRecord -Status 'ABSENT' -PreExisting $false -Evidence 'auth token exit nonzero'
    }
    else {
        try {
            $json = $cloudflareResult.StdOut | ConvertFrom-Json
            $token = [string](Get-S3MapValue -Map $json -Name 'token')
            $status = if ([string]::IsNullOrWhiteSpace($token)) {'UNKNOWN'} else {'PREEXISTING'}
            $record.cloudflare = Get-S3CliSessionStatusRecord -Status $status -PreExisting ($status -eq 'PREEXISTING') -Evidence 'auth token parsed'
            $token = $null
        }
        catch { $record.cloudflare = Get-S3CliSessionStatusRecord -Status 'UNKNOWN' -PreExisting $false -Evidence 'auth token JSON invalid' }
    }
    $firebaseResult=$null;$gcloudResult=$null;$cloudflareResult=$null
    Set-S3MapValue -Map $Context.State.results -Name 'cliSessions' -Value $record
    Write-S3State -Root $Context.Root -State $Context.State
    return $record
}

function Register-S3OwnedCliSession {
    param(
        [Parameter(Mandatory)]$Context,
        [ValidateSet('firebase-token','gcloud-config')][string]$Kind,
        [string]$SecretKey,
        [string]$ConfigPath
    )
    $entries = @(Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'ownedCliSessions')
    $entry = [ordered]@{kind=$Kind;createdByTool=$true;cleaned=$false;secretKey=$SecretKey;configPath=$ConfigPath}
    Set-S3MapValue -Map $Context.RuntimeSecrets -Name 'ownedCliSessions' -Value @($entries + $entry)
    return $entry
}

function Register-S3OwnedEnvironmentVariable {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)][string]$Name)
    $entries = @(Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'ownedEnvironmentVariables')
    if (@($entries | Where-Object {$_.name -eq $Name}).Count -gt 0) { return }
    $original = [Environment]::GetEnvironmentVariable($Name,'Process')
    $entry = [ordered]@{name=$Name;originalWasSet=($null -ne $original);originalValue=$original}
    Set-S3MapValue -Map $Context.RuntimeSecrets -Name 'ownedEnvironmentVariables' -Value @($entries + $entry)
}

function Invoke-S3OwnedCliSessionCleanup {
    param([Parameter(Mandatory)]$Context)
    $entries = @(Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'ownedCliSessions')
    if ($entries.Count -eq 0) { return [ordered]@{status='NOT_REQUIRED';cleaned=0;errors=@()} }
    $errors = [Collections.Generic.List[string]]::new()
    $cleaned = 0
    foreach ($entry in $entries) {
        if ((Get-S3MapValue -Map $entry -Name 'createdByTool') -ne $true -or (Get-S3MapValue -Map $entry -Name 'cleaned') -eq $true) { continue }
        try {
            switch ([string](Get-S3MapValue -Map $entry -Name 'kind')) {
                'firebase-token' {
                    $secretKey = [string](Get-S3MapValue -Map $entry -Name 'secretKey')
                    $token = [string](Get-S3MapValue -Map $Context.RuntimeSecrets -Name $secretKey)
                    if ([string]::IsNullOrWhiteSpace($token)) { throw 'OWNED_FIREBASE_TOKEN_MISSING' }
                    $logout = Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('logout','--token',$token) -TimeoutSeconds 120 -AllowFailure -SensitiveOutput
                    if ($logout.ExitCode -ne 0) { throw 'OWNED_FIREBASE_LOGOUT_FAILED' }
                    Set-S3MapValue -Map $Context.RuntimeSecrets -Name $secretKey -Value $null
                    $token=$null;$logout=$null
                }
                'gcloud-config' {
                    $configPath = [IO.Path]::GetFullPath([string](Get-S3MapValue -Map $entry -Name 'configPath'))
                    $tempRoot = [IO.Path]::GetFullPath((Join-Path $Context.Root 'temp'))
                    if (-not $configPath.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'OWNED_GCLOUD_CONFIG_OUTSIDE_TEMP' }
                    if (Test-Path -LiteralPath $configPath) {
                        $environment = @{CLOUDSDK_CONFIG=$configPath}
                        $revoke = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','revoke','--all','--quiet') -Environment $environment -TimeoutSeconds 120 -AllowFailure -SensitiveOutput
                        if ($revoke.ExitCode -ne 0) { throw 'OWNED_GCLOUD_REVOKE_FAILED' }
                        $list = Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','list','--format=json') -Environment $environment -TimeoutSeconds 60 -AllowFailure -SensitiveOutput
                        if ($list.ExitCode -ne 0) { throw 'OWNED_GCLOUD_VERIFY_FAILED' }
                        try { $remaining = @($list.StdOut | ConvertFrom-Json) }
                        catch { throw 'OWNED_GCLOUD_VERIFY_JSON_INVALID' }
                        if ($remaining.Count -ne 0) { throw 'OWNED_GCLOUD_SESSION_REMAINS' }
                        Remove-Item -LiteralPath $configPath -Recurse -Force -ErrorAction Stop
                    }
                }
                default { throw 'OWNED_SESSION_KIND_UNKNOWN' }
            }
            Set-S3MapValue -Map $entry -Name 'cleaned' -Value $true
            $cleaned++
        }
        catch { $errors.Add((Protect-S3Text $_.Exception.Message)) }
    }
    $status = if ($errors.Count -eq 0) {'PASS'} else {'FAIL'}
    return [ordered]@{status=$status;cleaned=$cleaned;errors=@($errors)}
}

function Clear-S3OwnedEnvironmentVariable {
    param([Parameter(Mandatory)]$Context)
    $entries = @(Get-S3MapValue -Map $Context.RuntimeSecrets -Name 'ownedEnvironmentVariables')
    $errors = [Collections.Generic.List[string]]::new()
    foreach ($entry in $entries) {
        try {
            $name = [string](Get-S3MapValue -Map $entry -Name 'name')
            if ((Get-S3MapValue -Map $entry -Name 'originalWasSet') -eq $true) {
                [Environment]::SetEnvironmentVariable($name,[string](Get-S3MapValue -Map $entry -Name 'originalValue'),'Process')
            }
            else {
                [Environment]::SetEnvironmentVariable($name,$null,'Process')
            }
        }
        catch { $errors.Add((Protect-S3Text $_.Exception.Message)) }
    }
    return [ordered]@{status=$(if($errors.Count -eq 0){'PASS'}else{'FAIL'});errors=@($errors)}
}

function Invoke-S3Cleanup {
    param([Parameter(Mandatory)]$Context)
    $result = [ordered]@{
        runId=$Context.RunId
        startedUtc=[DateTime]::UtcNow.ToString('o')
        cloudflare=[ordered]@{status='NOT_ATTEMPTED'}
        firebase=[ordered]@{status='NOT_ATTEMPTED'}
        sessions=[ordered]@{status='NOT_ATTEMPTED'}
        environment=[ordered]@{status='NOT_ATTEMPTED'}
        temp='NOT_ATTEMPTED'
        runtimeSecrets='NOT_ATTEMPTED'
        errors=@()
    }
    try { $result.cloudflare = Remove-S3CloudflareResource -Context $Context }
    catch {
        $safe = Protect-S3Text $_.Exception.Message
        $result.cloudflare = [ordered]@{status='FAILED';reason=$safe}
        $result.errors += $safe
    }
    if ($result.cloudflare.status -notin @('NOT_CREATED','DELETED','ALREADY_DELETED')) { $result.errors += "CLOUDFLARE_CLEANUP_$($result.cloudflare.status)" }
    try { $result.firebase = Remove-S3FirebaseProject -Context $Context }
    catch {
        $safe = Protect-S3Text $_.Exception.Message
        $result.firebase = [ordered]@{status='FAILED';reason=$safe}
        $result.errors += $safe
    }
    if ($result.firebase.status -notin @('NOT_CREATED','DELETE_REQUESTED','ALREADY_DELETE_REQUESTED')) { $result.errors += "FIREBASE_CLEANUP_$($result.firebase.status)" }
    try { $result.sessions = Invoke-S3OwnedCliSessionCleanup -Context $Context }
    catch {
        $safe = Protect-S3Text $_.Exception.Message
        $result.sessions = [ordered]@{status='FAILED';reason=$safe}
        $result.errors += $safe
    }
    if ($result.sessions.status -notin @('PASS','NOT_REQUIRED')) { $result.errors += "SESSION_CLEANUP_$($result.sessions.status)" }
    try {
        $temp = Join-Path $Context.Root 'temp'
        Get-ChildItem $temp -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction Stop
        $result.temp = 'CLEARED'
    }
    catch {
        $safe = Protect-S3Text $_.Exception.Message
        $result.temp = 'FAILED'
        $result.errors += $safe
    }
    try {
        $result.environment = Clear-S3OwnedEnvironmentVariable -Context $Context
        if ($result.environment.status -ne 'PASS') { $result.errors += 'OWNED_ENVIRONMENT_CLEANUP_FAILED' }
    }
    catch {
        $safe = Protect-S3Text $_.Exception.Message
        $result.environment = [ordered]@{status='FAILED';reason=$safe}
        $result.errors += $safe
    }
    try {
        Clear-S3RuntimeSecret -Context $Context
        if ($Context.RuntimeSecrets.Count -ne 0) { throw 'RUNTIME_SECRETS_NOT_EMPTY' }
        $result.runtimeSecrets = 'CLEARED'
    }
    catch {
        $safe = Protect-S3Text $_.Exception.Message
        $result.runtimeSecrets = 'FAILED'
        $result.errors += $safe
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    $result.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $result.errors = @($result.errors | ForEach-Object {Protect-S3Text ([string]$_)} | Select-Object -Unique)
    $result.status = if ($result.errors.Count -eq 0) {'PASS'} else {'FAIL'}
    $reports = Join-Path $Context.Root 'reports'
    New-Item -ItemType Directory -Path $reports -Force | Out-Null
    $json = Protect-S3Text ($result | ConvertTo-Json -Depth 20)
    [IO.File]::WriteAllText((Join-Path $reports 'resource-destruction.json'),$json,[Text.UTF8Encoding]::new($false))
    @(
        '# تقرير حذف الموارد والجلسات المؤقتة'
        ''
        "- Cloudflare: $($result.cloudflare.status)"
        "- Firebase: $($result.firebase.status)"
        "- Sessions: $($result.sessions.status)"
        "- Environment: $($result.environment.status)"
        "- Temp: $($result.temp)"
        "- Runtime secrets: $($result.runtimeSecrets)"
        "- النتيجة: $($result.status)"
    ) | Set-Content (Join-Path $reports 'resource-destruction.md') -Encoding UTF8
    return $result
}

Export-ModuleMember -Function *-S3*
'''

orchestrator = r'''
[CmdletBinding()]
param([ValidateSet('Interactive','Plan','Simulation','Live')][string]$Mode='Interactive',[switch]$Resume,[switch]$NoOpenFolder,[string]$CloudflareAccountId='')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$moduleRoot=Join-Path $PSScriptRoot 'modules'
foreach($module in @('Toolchain','Common','Ui','Prerequisites','Repository','Firebase','Cloudflare','CpuGate','Cleanup','Reporting')){Import-Module (Join-Path $moduleRoot "$module.psm1") -Force}
Enable-S3LocalToolPath -Root $PSScriptRoot
if($Mode -eq 'Interactive'){$Mode=Select-S3Mode}
$context=$null;$cleanupResult=$null;$cpu=[ordered]@{status='NOT_EXECUTED';reasons=@('NOT_REACHED')};$hadFailure=$false
try{
 $context=New-S3Context -Mode $Mode -Resume:$Resume
 Write-S3Log -Context $context -Message "بدء التشغيل $($context.RunId) بوضع $Mode"
 if($null -eq (Get-S3MapValue -Map $context.State.results -Name 'cliSessions')){[void](Initialize-S3CliSessionInventory -Context $context)}
 if($Mode -eq 'Live' -and $context.IsResumed -and (Test-S3HasOwnedCloudResource -Context $context)){
  throw 'استؤنف تشغيل Live بعد انقطاع مع موارد موجودة لكن الأسرار كانت في الذاكرة فقط. ستنفذ الحزمة التنظيف الآمن؛ أعد التشغيل بعده للحصول على Run ID جديد.'
 }
 if($context.State.currentState -eq '00_PACKAGE_READY'){Show-S3Stage 1 9 'فحص الجهاز' 'لن يتم إنشاء أي خدمة أو تعديل المستودع.';$prerequisites=Invoke-S3Prerequisite -Context $context;Set-S3MapValue -Map $context.State.results -Name 'tools' -Value $prerequisites.tools;Set-S3Checkpoint $context '10_LOCAL_PREREQUISITES'}
 if($context.State.currentState -eq '10_LOCAL_PREREQUISITES'){Show-S3Stage 2 9 'بوابة المستودع' 'تشغيل تحقق S1 وS2 دون إصلاح تلقائي.';$repository=Invoke-S3RepositoryGate -Context $context;Set-S3MapValue -Map $context.State.results -Name 'repository' -Value $repository;Set-S3Checkpoint $context '20_REPOSITORY_GATE'}
 if($context.State.currentState -eq '20_REPOSITORY_GATE'){Show-S3Stage 3 9 'الفرع وDraft PR' 'في Plan لا كتابة. في Live ينشأ فرع وDraft PR فقط.';$branchPr=Invoke-S3BranchAndDraftPr -Context $context;Set-S3MapValue -Map $context.State.results -Name 'branchPr' -Value $branchPr;Set-S3Checkpoint $context '30_BRANCH_AND_DRAFT_PR'}
 if($Mode -eq 'Plan'){@('# نتيجة Plan','',"- Run ID: $($context.RunId)",'- لا موارد سحابية.','- لا فرع أو PR.','- الخطوة التالية بعد المراجعة: Simulation أو Live.')|Set-Content (Join-Path $context.Root 'reports\plan.md') -Encoding UTF8;Write-Information -InformationAction Continue 'اكتملت الخطة الآمنة دون أي كتابة.';return}
 if($context.State.currentState -eq '30_BRANCH_AND_DRAFT_PR'){
  Show-S3Stage 4 9 'بوابة Cloudflare للقراءة فقط' 'تعمل قبل Firebase وقبل أي كتابة سحابية.';Assert-S3NoSecret -Context $context -Path $context.Root
  $selectedAccountId=$CloudflareAccountId
  if($Mode -eq 'Live' -and [string]::IsNullOrWhiteSpace($selectedAccountId)){$selectedAccountId=Read-Host 'أدخل Cloudflare Account ID الذي اخترته بوضوح من قائمة الحسابات'}
  $preflight=Invoke-S3CloudflareReadOnlyPreflight -Context $context -SelectedAccountId $selectedAccountId
  if($preflight.status -ne 'PASS'){throw 'CLOUDFLARE_READ_ONLY_PREFLIGHT_FAILED'}
  Set-S3MapValue -Map $context.State.results -Name 'cloudflarePreflight' -Value $preflight
  Set-S3Checkpoint $context '40_PRE_CLOUD_GATE'
 }
 if($context.State.currentState -eq '40_PRE_CLOUD_GATE'){Show-S3Stage 5 9 'Firebase التجريبية' 'مشروع Spark مؤقت وحسابان مصطنعان فقط.';$firebase=Invoke-S3FirebaseProvision -Context $context;Set-S3MapValue -Map $context.State.results -Name 'firebase' -Value $firebase;Set-S3Checkpoint $context '50_FIREBASE_PROVISIONED'}
 if($context.State.currentState -eq '50_FIREBASE_PROVISIONED'){Show-S3Stage 6 9 'Cloudflare التجريبية' 'Worker وD1 مؤقتتان على Free وworkers.dev فقط.';$cloudflare=Invoke-S3CloudflareProvision -Context $context;Set-S3MapValue -Map $context.State.results -Name 'cloudflare' -Value $cloudflare;Set-S3Checkpoint $context '60_CLOUDFLARE_PROVISIONED'}
 if($context.State.currentState -eq '60_CLOUDFLARE_PROVISIONED'){Show-S3Stage 7 9 'بوابة CPU' '20 warm-up، جولتان hit، و20 miss، مع قياس CPU رسمي.';$cpu=Invoke-S3CpuGate -Context $context;Set-S3MapValue -Map $context.State.results -Name 'cpu' -Value $cpu;Set-S3Checkpoint $context '70_CPU_GATE_EXECUTED'}
}catch{
 $hadFailure=$true
 $failureReason=Protect-S3Text $_.Exception.Message
 if($null -ne $context){
  [void](Write-S3FailureEvidence -Context $context -Reason $failureReason)
  try{New-S3BlockerReport -Context $context -Reason $failureReason|Out-Null}catch{Write-Verbose ("تعذر إنشاء blocker-report.zip: " + $_.Exception.Message)}
 }
 Write-Information -InformationAction Continue ('توقف آمن: '+$failureReason)
}finally{
 try{
  if($null -ne $context -and $Mode -ne 'Plan'){
   Show-S3Stage 8 9 'التنظيف الإلزامي' 'سيُحذف فقط ما أنشأته الحزمة ويحمل Run ID، وستُحفظ جلسات المستخدم السابقة.'
   $cleanupResult=Invoke-S3Cleanup -Context $context
   if($context.State.currentState -eq '70_CPU_GATE_EXECUTED' -and $cleanupResult.status -eq 'PASS'){Set-S3Checkpoint $context '80_RESOURCES_DESTROYED'}
   elseif($cleanupResult.status -ne 'PASS'){$hadFailure=$true}
  }
  if($null -ne $context -and $context.State.currentState -eq '80_RESOURCES_DESTROYED'){
   Show-S3Stage 9 9 'التقرير النهائي' 'إنشاء ZIP منقح جاهز للرفع.'
   $final=New-S3FinalReport -Context $context -CpuDecision $cpu -CleanupResult $cleanupResult
   Set-S3MapValue -Map $context.State.results -Name 'final' -Value $final
   Set-S3Checkpoint $context '90_REPORT_READY'
   Write-Information -InformationAction Continue "CPU GATE: $($cpu.status)"
   Write-Information -InformationAction Continue "التقرير: $($final.zip)"
   if(-not $NoOpenFolder){Start-Process explorer.exe (Join-Path $context.Root 'artifacts')}
  }
 }catch{
  $hadFailure=$true
  $finalizationReason=Protect-S3Text $_.Exception.Message
  if($null -ne $context){[void](Write-S3FailureEvidence -Context $context -Reason $finalizationReason)}
  Write-Information -InformationAction Continue ('توقف آمن أثناء التنظيف أو التقرير: '+$finalizationReason)
 }finally{
  if($null -ne $context -and $context.RuntimeSecrets.Count -ne 0){
   try{Clear-S3RuntimeSecret -Context $context}
   catch{
    $hadFailure=$true
    $clearReason=Protect-S3Text $_.Exception.Message
    [void](Write-S3FailureEvidence -Context $context -Reason $clearReason)
   }
  }
 }
}
if($hadFailure){exit 1}
'''

cloudflare_cleanup = r'''
function Test-S3CloudflareCleanupOwnership {
    param([Parameter(Mandatory)]$Context,[Parameter(Mandatory)]$Resource)
    $marker = [string](Get-S3MapValue -Map $Resource -Name 'marker')
    $worker = [string](Get-S3MapValue -Map $Resource -Name 'worker')
    $d1Name = [string](Get-S3MapValue -Map $Resource -Name 'd1Name')
    $d1Id = [string](Get-S3MapValue -Map $Resource -Name 'd1Id')
    $accountId = [string](Get-S3MapValue -Map $Resource -Name 'accountId')
    if ($marker -ne [string]$Context.RunId -or $worker -notmatch '^s3cpu-' -or $d1Name -notmatch '^s3cpu-' -or [string]::IsNullOrWhiteSpace($d1Id) -or [string]::IsNullOrWhiteSpace($accountId)) {
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
    $workerDelete = [ordered]@{status='NOT_ATTEMPTED'}
    $d1Delete = [ordered]@{status='NOT_ATTEMPTED'}
    try {
        $workerCommand = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('delete',$owned.worker,'--force') -TimeoutSeconds 300 -AllowFailure
        $workerDelete.status = if ($workerCommand.ExitCode -eq 0) {'REQUESTED'} else {'FAILED'}
        $workerDelete.exitCode = $workerCommand.ExitCode
    }
    catch { $workerDelete = [ordered]@{status='FAILED';reason=Protect-S3Text $_.Exception.Message} }
    try {
        $d1Command = Invoke-S3Process -Context $Context -FilePath 'wrangler' -ArgumentList @('d1','delete',$owned.d1Name,'--yes') -TimeoutSeconds 300 -AllowFailure
        $d1Delete.status = if ($d1Command.ExitCode -eq 0) {'REQUESTED'} else {'FAILED'}
        $d1Delete.exitCode = $d1Command.ExitCode
    }
    catch { $d1Delete = [ordered]@{status='FAILED';reason=Protect-S3Text $_.Exception.Message} }
    $proof = Wait-S3CloudflareResourceAbsence -AccountId $owned.accountId -Token $token -Worker $owned.worker -D1Name $owned.d1Name -D1Id $owned.d1Id
    $workerOk = ($workerDelete.status -eq 'REQUESTED' -and $proof.workerAbsent -eq $true)
    $d1Ok = ($d1Delete.status -eq 'REQUESTED' -and $proof.d1Absent -eq $true)
    $status = if ($workerOk -and $d1Ok -and $proof.status -eq 'PASS') {'DELETED'} elseif ($workerOk -xor $d1Ok) {'PARTIAL'} elseif ($proof.status -eq 'UNKNOWN') {'UNKNOWN'} else {'FAILED'}
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
'''

tests = r'''
BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }

function global:New-S3ProviderResponseForTest {
    param([string]$Collection,[bool]$Enabled,[string]$Name='projects/p/configs/provider')
    return [pscustomobject]@{$Collection=@([pscustomobject]@{name=$Name;enabled=$Enabled})}
}

function New-S3LiveCleanupContextForTest {
    $context = Get-TestContext 'Live'
    $accountId = '1234567890abcdef1234567890abcdef'
    $context.State.resources.cloudflare = [ordered]@{accountId=$accountId;worker='s3cpu-owned-worker';d1Name='s3cpu-owned-d1';d1Id='11111111-2222-3333-4444-555555555555';marker=$context.RunId}
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
            if($Method -eq 'GET'){$collection=($Uri -split '/')[-1];return New-S3ProviderResponseForTest -Collection $collection -Enabled $true -Name "projects/p/$collection/x"}
            throw 'PATCH failed'
        } -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw
    }
    It 'stops when one provider remains enabled after reread' {
        Mock Invoke-S3GoogleRest {
            param($Method,$Uri)
            if($Method -eq 'PATCH'){return [pscustomobject]@{}}
            $collection=($Uri -split '/')[-1]
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
            $collection=($Uri -split '/')[-1]
            return [pscustomobject]@{$collection=@([pscustomobject]@{name='projects/p/configs/x';enabled='false'})}
        } -ModuleName Firebase
        {Disable-S3FederatedProvider -ProjectId p -Token token} | Should -Throw '*RESPONSE_INVALID*'
    }
    It 'succeeds only after all provider collections reread disabled' {
        $script:getCounts=@{}
        Mock Invoke-S3GoogleRest {
            param($Method,$Uri)
            if($Method -eq 'PATCH'){return [pscustomobject]@{}}
            $collection=($Uri -split '/')[-1]
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
        Mock Invoke-RestMethod {throw 'https://example.test?key=SECRET-KEY Authorization: Bearer SECRET-TOKEN'} -ModuleName Firebase
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
        (Get-ChildItem (Join-Path $TestDrive 'temp') -Force).Count | Should -Be 0
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
'''

user_guide = r'''
# دليل المستخدم — S3 CPU Gate

هذه الحزمة ما زالت بانتظار الاعتماد الإشرافي ولا يجوز تشغيل Live CPU Gate قبل ذلك.

## جلسات تسجيل الدخول

- تفحص الأداة حالة Firebase CLI وgcloud وWrangler قبل أي عملية سحابية.
- لا تشغّل الأداة `wrangler login` تلقائيًا. غياب جلسة Cloudflare صالحة يوقف التنفيذ.
- لا تشغّل الأداة `firebase login` أو `gcloud auth login` تلقائيًا. يلزم وجود جلسة سابقة معتمدة قبل Live.
- الجلسات الموجودة قبل تشغيل الأداة تخص المستخدم ولا تسجل الأداة خروجًا منها ولا تلغيها.
- أي جلسة مؤقتة تنشئها الأداة في مسار معزول تسجل كجلسة مملوكة للتشغيل، وتنظف داخل `finally`، ويؤدي فشل تنظيفها إلى FAIL.

## ما تنظفه الأداة

- موارد Firebase وCloudflare التي تحمل Run ID وتطابق المعرفات التي أنشأتها الحزمة فقط.
- كلمات المرور الاصطناعية وID/refresh/access tokens الموجودة في الذاكرة.
- متغيرات البيئة المؤقتة التي سجلتها الأداة بوصفها مملوكة لها فقط.
- إعدادات تسجيل الدخول المؤقتة المعزولة وملفات SQL المؤقتة ومحتويات مجلد `temp`.

## ما لا تلمسه الأداة

- جلسات Firebase أو gcloud أو Wrangler الموجودة قبل التشغيل.
- موارد لا تطابق Run ID أو نمط `s3cpu-` أو المعرف المحفوظ عند الإنشاء.
- إعدادات المستخدم أو متغيراته البيئية التي لم تنشئها الأداة.

## عند التوقف

- لا تحذف `state.json` أثناء تشغيل غير مكتمل.
- أعد تشغيل `START.cmd` وفق توجيه الإشراف فقط.
- عند وجود موارد مملوكة بعد انقطاع، ينفذ مسار التنظيف الآمن ولا يعيد استخدام أسرار مفقودة من الذاكرة.
- ارفع `blocker-report.zip` عند ظهور مانع.
- عند ظهور Billing أو خطة مدفوعة أو طلب بطاقة، ألغ التنفيذ فورًا.
'''

security_review = r'''
# SECURITY-REVIEW — B3/B4/B8

## الحالة

`READY FOR INDEPENDENT SUPERVISORY REVIEW — NOT MERGED`

لم ينفذ Cloud أو Login أو Billing أو Live CPU Gate ضمن هذه المرحلة. التنفيذ والاختبارات يستخدمان mocks وSimulation فقط.

## B3 — Firebase fail-closed

- فشل قراءة أي مجموعة من مجموعات مزودي الهوية يوقف التنفيذ.
- كل PATCH يعاد التحقق منه بقراءة مستقلة للمجموعات الثلاث.
- لا تسجل `emailPasswordOnly=true` أو `otherProviders=false` قبل اكتمال الإثبات.
- القيم المفقودة أو null أو غير المنطقية في الإعدادات الإلزامية تفشل.
- يتحقق المسار من Email/Password وpassword required وتعطيل Phone وAnonymous وduplicate emails وself-sign-up وحذف المستخدم.
- يثبت أن المشروع فارغ قبل إنشاء المستخدمين، ثم يحتوي حسابين اصطناعيين فقط دون هاتف أو provider links.

## B4 — Cloudflare cleanup fail-closed

- يحلل كل Exit Code لحذف Worker وD1 على حدة.
- يعاد الاستعلام عبر API القراءة الرسمية لإثبات غياب الاسم والمعرف.
- التحقق محدود بثلاث محاولات قصيرة؛ انتهاء المحاولات أو فشل JSON/API لا ينتج `DELETED`.
- الحذف الجزئي ينتج `PARTIAL` أو `FAIL` ولا يسمح بالانتقال إلى `80_RESOURCES_DESTROYED`.
- التقارير تستخدم Account ID منقحًا ولا تتضمن token أو مخرجات CLI الحساسة.

## B8 — الجلسات والأسرار المؤقتة

- تسجل حالة Firebase CLI وgcloud وWrangler قبل أي تسجيل دخول.
- لا توجد أوامر login تلقائية.
- الجلسات السابقة لا تلمس.
- الجلسات المملوكة للتشغيل فقط تنظف، وفشل logout أو revoke يجعل cleanup FAIL.
- إعداد gcloud المؤقت، عند استخدامه، يجب أن يكون داخل `temp` ومعزولًا عبر `CLOUDSDK_CONFIG`.
- RuntimeSecrets والبيئة المملوكة وملفات SQL والإعدادات المؤقتة تنظف قبل نجاح التقرير.

## المصادر الرسمية لـB8

تاريخ الاطلاع: 2026-08-06.

- Firebase CLI reference: https://firebase.google.com/docs/cli
- gcloud configurations and `CLOUDSDK_CONFIG`: https://cloud.google.com/sdk/gcloud/reference/topic/configurations
- gcloud auth revoke: https://cloud.google.com/sdk/gcloud/reference/auth/revoke
- Wrangler authentication, `auth token`, login and logout: https://developers.cloudflare.com/workers/wrangler/commands/general/
'''

write_text('tools/s3_cpu_gate/src/modules/Firebase.psm1', firebase, bom=True)
write_text('tools/s3_cpu_gate/src/modules/Cleanup.psm1', cleanup, bom=True)
write_text('tools/s3_cpu_gate/src/S3-CpuGate-Orchestrator.ps1', orchestrator, bom=True)
replace_once('tools/s3_cpu_gate/src/modules/Cloudflare.psm1', r'function Remove-S3CloudflareResource \{.*?Export-ModuleMember -Function \*-S3\*\s*$', cloudflare_cleanup)
write_text('tools/s3_cpu_gate/tests/pester/SecurityCleanup.Tests.ps1', tests, bom=True)
write_text('tools/s3_cpu_gate/docs/USER-GUIDE-AR.md', user_guide)
write_text('tools/s3_cpu_gate/docs/SECURITY-REVIEW.md', security_review)

state_path = ROOT / 'PROJECT_STATE.md'
state = state_path.read_text(encoding='utf-8-sig')
state = state.replace('- حالة S3: **لم تبدأ. لا يوجد كود هوية أو قاعدة بيانات إنتاج أو سجل تدقيق تشغيلي، ولم تُنشأ خدمة سحابية.**', '- حالة S3: **B3/B4/B8 منفذة على فرع مستقل وفي Pull Request مفتوح للمراجعة؛ S3 الرئيسية غير مكتملة ولم يبدأ Live CPU Gate.**')
state = state.replace('## الخطوة التالية\n\nلا تبدأ المرحلة الثالثة حتى يصدر اعتماد إشرافي مستقل وصريح ضمن Issue #2 وعلى فرع وPull Request منفصلين.', '''## المرحلة الداخلية الثالثة — B3/B4/B8\n\n- B2/B5 مقفلتان إداريًا ولا تتغيران.\n- B3/B4/B8 منفذة في الفرع `phase/s3-b3-b4-b8-security-cleanup` ضمن Pull Request واحد مفتوح للمراجعة.\n- المرحلة الداخلية الثالثة ليست مقفلة قبل المراجعة والدمج والتحقق من `main`.\n- S3 الرئيسية لم تكتمل.\n- Live CPU Gate غير منفذة.\n- Issue #2 ما زالت مفتوحة.\n- لم ينفذ Cloud أو Login أو Billing أو Live CPU Gate في هذه المرحلة.\n\n## الخطوة التالية\n\nالمراجعة الإشرافية المستقلة لـPull Request الخاصة بـB3/B4/B8. لا يبدأ B1 أو Live CPU Gate ولا يدمج PR قبل اعتماد صريح.''')
state_path.write_text(state, encoding='utf-8')

report = '''# S3 Phase 3 — B3/B4/B8 Implementation Report\n\n- Base SHA: `7a9e4d3610387b48ee390edfe790965b66cd1163`\n- Head SHA: `PENDING_FINAL_COMMIT`\n- Branch: `phase/s3-b3-b4-b8-security-cleanup`\n- Status: `READY FOR INDEPENDENT SUPERVISORY REVIEW — NOT MERGED`\n\n## Scope\n\n- B3: Firebase fail-closed provider and account proof.\n- B4: Cloudflare deletion and absence proof fail-closed.\n- B8: preexisting-session preservation and owned temporary-session cleanup.\n\n## Changed files\n\n- `tools/s3_cpu_gate/src/modules/Firebase.psm1`\n- `tools/s3_cpu_gate/src/modules/Cloudflare.psm1`\n- `tools/s3_cpu_gate/src/modules/Cleanup.psm1`\n- `tools/s3_cpu_gate/src/S3-CpuGate-Orchestrator.ps1`\n- `tools/s3_cpu_gate/tests/pester/SecurityCleanup.Tests.ps1`\n- `tools/s3_cpu_gate/docs/USER-GUIDE-AR.md`\n- `tools/s3_cpu_gate/docs/SECURITY-REVIEW.md`\n- `PROJECT_STATE.md`\n- `docs/evidence/S3-PHASE-3-B3-B4-B8-IMPLEMENTATION-REPORT.md`\n\n## B3\n\nAll provider collection reads and disable PATCH operations are fail-closed. The three collections are reread independently, required booleans are exact, the project-empty proof precedes account creation, and only two synthetic users without phone numbers or provider links are accepted. Guard flags are written only after proof completion.\n\n## B4\n\nWorker and D1 deletion commands are evaluated separately. Absence is verified through the official list APIs with a bounded retry count. Command, API, JSON, ownership, or residual-resource failures cannot produce `DELETED`; partial cleanup is explicit and blocks checkpoint `80_RESOURCES_DESTROYED`. Reports redact the Account ID.\n\n## B8\n\nCLI session inventory runs before cloud stages. No automatic Firebase, gcloud, or Wrangler login is performed. Preexisting sessions are preserved. Only sessions registered as tool-owned are eligible for token-specific logout or isolated gcloud revocation, and failures make cleanup fail. Runtime secrets, owned environment variables, temporary configuration, and SQL files are cleared.\n\n## Official sources reviewed\n\nReviewed 2026-08-06:\n\n- Firebase CLI: https://firebase.google.com/docs/cli\n- gcloud configuration isolation: https://cloud.google.com/sdk/gcloud/reference/topic/configurations\n- gcloud auth revoke: https://cloud.google.com/sdk/gcloud/reference/auth/revoke\n- Wrangler authentication: https://developers.cloudflare.com/workers/wrangler/commands/general/\n- Cloudflare Workers list API: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/\n- Cloudflare D1 list API: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/list/\n\n## Validation\n\n- PowerShell parser: `PENDING`\n- PSScriptAnalyzer: `PENDING`\n- Pester baseline: `120/120 PASS` before this change\n- Pester new total: `PENDING`\n- Python regression: `PENDING`\n- Node syntax: `PENDING`\n- Foundation integrity: `PENDING`\n- S2 regression: `PENDING`\n- Secret scan: `PENDING`\n- Payload integrity: `PENDING`\n- ZIP safety: `PENDING`\n\n## Execution exclusions\n\nNo Cloud, Firebase, Cloudflare, Login, Billing, or Live CPU Gate operation was executed. B2/B5 and `version-manifest.json` were not modified. Issue #2 remains open.\n\nThis phase is awaiting independent supervisory review and is not closed.\n'''
write_text('docs/evidence/S3-PHASE-3-B3-B4-B8-IMPLEMENTATION-REPORT.md', report)
