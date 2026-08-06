Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
function Get-S3SyntheticPassword {
 $bytes=[byte[]]::new(32);[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
 try { return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','A').Replace('/','z')+'!a9' } finally {[Array]::Clear($bytes,0,$bytes.Length)}
}
function Get-S3GoogleAccessToken { param($Context) $r=Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','print-access-token') -TimeoutSeconds 60 -SensitiveOutput; $t=$r.StdOut.Trim();if(-not $t){throw 'تعذر الحصول على Google OAuth token.'};return $t }
function Invoke-S3GoogleRest {
 param([string]$Method,[string]$Uri,[string]$Token,[object]$Body=$null)
 $headers=@{Authorization="Bearer $Token"}
 if($null -eq $Body){return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -TimeoutSec 90}
 return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json' -Body ($Body|ConvertTo-Json -Depth 20 -Compress) -TimeoutSec 90
}
function Assert-S3GoogleNoBilling {
 param($Context,[string]$ProjectId)
 $r=Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('billing','projects','describe',$ProjectId,'--format=json') -TimeoutSeconds 120
 $j=$r.StdOut|ConvertFrom-Json
 if($j.billingEnabled -ne $false -or -not [string]::IsNullOrEmpty([string]$j.billingAccountName)){throw 'Billing مرتبط بالمشروع؛ توقف وحذف الموارد.'}
 return [ordered]@{billingEnabled=$false;billingAccountName=$null;verified=$true}
}
function Disable-S3FederatedProvider {
 param([string]$ProjectId,[string]$Token)
 $base="https://identitytoolkit.googleapis.com/admin/v2/projects/$ProjectId"
 foreach($collection in @('defaultSupportedIdpConfigs','oauthIdpConfigs','inboundSamlConfigs')){
  try{$response=Invoke-S3GoogleRest -Method GET -Uri "$base/$collection" -Token $Token}catch{continue}
  foreach($property in $response.PSObject.Properties){
   if($property.Name -notmatch 'Configs$'){continue}
   foreach($config in @($property.Value)){
    if($config.enabled -eq $true){
     Invoke-S3GoogleRest -Method PATCH -Uri "https://identitytoolkit.googleapis.com/admin/v2/$($config.name)?updateMask=enabled" -Token $Token -Body @{enabled=$false;name=$config.name}|Out-Null
    }
   }
  }
 }
}
function Get-S3FirebaseUser { param([string]$ProjectId,[string]$Token)
 $r=Invoke-S3GoogleRest -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/projects/$ProjectId/accounts:query" -Token $Token -Body @{returnUserInfo=$true;limit=100}
 return @($r.userInfo)
}
function New-S3FirebaseAdminUser {
 [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword','',Justification='Synthetic one-run password is required in the Firebase HTTPS JSON body and is never logged or serialized.')]
 param([string]$ProjectId,[string]$ApiKey,[string]$Token,[string]$Uid,[string]$Email,[string]$Password)
 if(-not $PSCmdlet.ShouldProcess(($ProjectId + '/' + $Uid),'Create synthetic Firebase user')){return}
 Invoke-S3GoogleRest -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/projects/$ProjectId/accounts?key=$ApiKey" -Token $Token -Body @{localId=$Uid;email=$Email;password=$Password;emailVerified=$true;displayName='S3 CPU Gate Test User'}|Out-Null
}
function Get-S3FirebaseIdToken {
 [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword','',Justification='Synthetic one-run password is required in the Firebase HTTPS JSON body and is never logged or serialized.')]
 param([string]$ApiKey,[string]$Email,[string]$Password)
 $response=Invoke-RestMethod -Method POST -Uri "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$ApiKey" -ContentType 'application/json' -Body (@{email=$Email;password=$Password;returnSecureToken=$true}|ConvertTo-Json -Compress) -TimeoutSec 90
 if(-not $response.idToken){throw 'لم يصدر Firebase ID Token.'};return [pscustomobject]@{IdToken=[string]$response.idToken;RefreshToken=[string]$response.refreshToken;LocalId=[string]$response.localId}
}
function Invoke-S3FirebaseProvision {
 param([Parameter(Mandatory)]$Context)
 if($Context.Mode -eq 'Simulation'){
  $id="s3cpu-mock-$($Context.RunId.Substring($Context.RunId.Length-8))";$resource=[ordered]@{projectId=$id;marker=$Context.RunId;billing=$false;users=2};Set-S3MapValue -Map $Context.State.resources -Name 'firebase' -Value $resource
  $Context.RuntimeSecrets.uid1='mock-uid-person-1';$Context.RuntimeSecrets.uid2='mock-uid-person-2';$Context.RuntimeSecrets.token1='mock-token-1';$Context.RuntimeSecrets.token2='mock-token-2'
  return [ordered]@{status='SIMULATED';projectId=$id;spark=$true;billing=$false;users=2;secrets='MEMORY_ONLY'}
 }
 if($Context.Mode -ne 'Live'){return [ordered]@{status='PLANNED'}}
 $auth=Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('login:list','--json') -AllowFailure
 if($auth.ExitCode -ne 0 -or $auth.StdOut -notmatch 'user'){Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('login') -TimeoutSeconds 600|Out-Null}
 $gauth=Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','list','--filter=status:ACTIVE','--format=value(account)') -AllowFailure
 if(-not $gauth.StdOut.Trim()){Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('auth','login') -TimeoutSeconds 600|Out-Null}
 $suffix=($Context.RunId -replace '[^a-z0-9-]','').ToLower();if($suffix.Length -gt 20){$suffix=$suffix.Substring($suffix.Length-20)}
 $projectId="s3cpu-$suffix";$display="S3 CPU Gate $($Context.RunId)"
 $password1=$null;$password2=$null;$accessToken=$null;$id1=$null;$id2=$null
 try{
  Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('projects:create',$projectId,'--display-name',$display,'--json','--non-interactive') -TimeoutSeconds 600|Out-Null
  $resource=[ordered]@{projectId=$projectId;marker=$Context.RunId;billing=$null;users=0};Set-S3MapValue -Map $Context.State.resources -Name 'firebase' -Value $resource;Write-S3State -Root $Context.Root -State $Context.State
  $billingProof=Assert-S3GoogleNoBilling -Context $Context -ProjectId $projectId
  $apps=(Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('apps:create','WEB','s3-cpu-gate','--project',$projectId,'--json','--non-interactive') -TimeoutSeconds 300).StdOut|ConvertFrom-Json
  $appId=[string]($apps.result.appId ?? $apps.appId);if(-not $appId){throw 'تعذر استخراج Firebase Web App ID.'}
  $sdk=(Invoke-S3Process -Context $Context -FilePath 'firebase' -ArgumentList @('apps:sdkconfig','WEB',$appId,'--project',$projectId,'--json') -TimeoutSeconds 180 -SensitiveOutput).StdOut|ConvertFrom-Json
  $apiKey=[string]($sdk.result.sdkConfig.apiKey ?? $sdk.sdkConfig.apiKey);if(-not $apiKey){throw 'تعذر استخراج Firebase Web API Key.'}
  $accessToken=Get-S3GoogleAccessToken -Context $Context
  $cfgUri="https://identitytoolkit.googleapis.com/admin/v2/projects/$projectId/config"
  $body=@{name="projects/$projectId/config";signIn=@{email=@{enabled=$true;passwordRequired=$true};phoneNumber=@{enabled=$false};anonymous=@{enabled=$false};allowDuplicateEmails=$false};client=@{permissions=@{disabledUserSignup=$true;disabledUserDeletion=$true}}}
  $mask='signIn.email.enabled,signIn.email.passwordRequired,signIn.phoneNumber.enabled,signIn.anonymous.enabled,signIn.allowDuplicateEmails,client.permissions.disabledUserSignup,client.permissions.disabledUserDeletion'
  Invoke-S3GoogleRest -Method PATCH -Uri "$cfgUri?updateMask=$mask" -Token $accessToken -Body $body|Out-Null
  Disable-S3FederatedProvider -ProjectId $projectId -Token $accessToken
  $cfg=Invoke-S3GoogleRest -Method GET -Uri $cfgUri -Token $accessToken
  if(-not $cfg.signIn.email.enabled -or -not $cfg.signIn.email.passwordRequired -or $cfg.signIn.phoneNumber.enabled -or $cfg.signIn.anonymous.enabled -or -not $cfg.client.permissions.disabledUserSignup -or -not $cfg.client.permissions.disabledUserDeletion){throw 'إعداد Firebase النهائي غير مطابق.'}
  $existing=Get-S3FirebaseUser -ProjectId $projectId -Token $accessToken;if($existing.Count -ne 0){throw 'Firebase project غير فارغ.'}
  $uid1='p1-'+[guid]::NewGuid().ToString('N');$uid2='p2-'+[guid]::NewGuid().ToString('N');$email1="$uid1@example.invalid";$email2="$uid2@example.invalid"
  $password1=Get-S3SyntheticPassword;$password2=Get-S3SyntheticPassword
  New-S3FirebaseAdminUser -ProjectId $projectId -ApiKey $apiKey -Token $accessToken -Uid $uid1 -Email $email1 -Password $password1
  New-S3FirebaseAdminUser -ProjectId $projectId -ApiKey $apiKey -Token $accessToken -Uid $uid2 -Email $email2 -Password $password2
  $users=Get-S3FirebaseUser -ProjectId $projectId -Token $accessToken
  if($users.Count -ne 2 -or @($users|Where-Object{$_.phoneNumber -or @($_.providerUserInfo).Count -gt 0}).Count -ne 0){throw 'عدد/نوع المستخدمين غير مطابق.'}
  $id1=Get-S3FirebaseIdToken -ApiKey $apiKey -Email $email1 -Password $password1;$id2=Get-S3FirebaseIdToken -ApiKey $apiKey -Email $email2 -Password $password2
  $Context.RuntimeSecrets.projectId=$projectId;$Context.RuntimeSecrets.apiKey=$apiKey;$Context.RuntimeSecrets.uid1=$uid1;$Context.RuntimeSecrets.uid2=$uid2;$Context.RuntimeSecrets.email1=$email1;$Context.RuntimeSecrets.email2=$email2;$Context.RuntimeSecrets.token1=$id1.IdToken;$Context.RuntimeSecrets.token2=$id2.IdToken;$Context.RuntimeSecrets.password1=$password1;$Context.RuntimeSecrets.password2=$password2;$Context.RuntimeSecrets.refreshToken1=$id1.RefreshToken;$Context.RuntimeSecrets.refreshToken2=$id2.RefreshToken
  $firebaseResource=Get-S3MapValue -Map $Context.State.resources -Name 'firebase';Set-S3MapValue -Map $firebaseResource -Name 'users' -Value 2;Set-S3MapValue -Map $firebaseResource -Name 'billing' -Value $false;Set-S3MapValue -Map $Context.State.results -Name 'firebaseGuard' -Value ([ordered]@{spark=true;billingProof=$billingProof;emailPasswordOnly=true;disabledUserSignup=true;disabledUserDeletion=true;phone=false;anonymous=false;otherProviders=false;userCount=2})
  return [ordered]@{status='PASS';projectId=$projectId;spark=$true;billing=$false;users=2;secrets='MEMORY_ONLY'}
 } finally {$accessToken=$null;$password1=$null;$password2=$null;$id1=$null;$id2=$null;[GC]::Collect()}
}
function Remove-S3FirebaseProject {
 [CmdletBinding(SupportsShouldProcess=$true,ConfirmImpact='Low')]
 param([Parameter(Mandatory)]$Context)
 $resource=Get-S3MapValue -Map $Context.State.resources -Name 'firebase'
 if($null -eq $resource){return [ordered]@{status='NOT_CREATED'}}
 $projectId=[string](Get-S3MapValue -Map $resource -Name 'projectId')
 if((Get-S3MapValue -Map $resource -Name 'marker') -ne $Context.RunId -or $projectId -notlike 's3cpu-*'){throw 'رفض حذف Firebase غير مملوكة.'}
 if(-not $PSCmdlet.ShouldProcess($projectId,'Delete owned Firebase project')){return [ordered]@{status='SKIPPED';projectId=$projectId}}
 if($Context.Mode -eq 'Simulation'){return [ordered]@{status='DELETE_REQUESTED';projectId=$projectId}}
 Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','delete',$projectId,'--quiet') -TimeoutSeconds 300|Out-Null
 $describe=Invoke-S3Process -Context $Context -FilePath 'gcloud' -ArgumentList @('projects','describe',$projectId,'--format=value(lifecycleState)') -AllowFailure
 if($describe.ExitCode -eq 0 -and $describe.StdOut.Trim() -notin @('DELETE_REQUESTED','DELETE_IN_PROGRESS')){throw 'لم يثبت بدء حذف Firebase Project.'}
 return [ordered]@{status='DELETE_REQUESTED';projectId=$projectId}
}
Export-ModuleMember -Function *-S3*
