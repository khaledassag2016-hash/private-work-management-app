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
