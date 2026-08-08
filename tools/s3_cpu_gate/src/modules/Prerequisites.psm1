Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
function Test-S3Transcription {
 $paths=@('HKLM:\Software\Policies\Microsoft\Windows\PowerShell\Transcription','HKCU:\Software\Policies\Microsoft\Windows\PowerShell\Transcription')
 foreach($path in $paths){if(Test-Path $path){$value=Get-ItemProperty $path -ErrorAction SilentlyContinue;if($value.EnableTranscripting -eq 1){return $true}}}
 if($Host.Name -match 'ServerRemoteHost'){return $true};return $false
}
function Get-S3ToolInfo {
 param([string]$Name)
 $command=Get-Command $Name -ErrorAction SilentlyContinue;if($null -eq $command){return [pscustomobject]@{name=$Name;available=$false;path=$null;version=$null}}
 $version=$null;try{$version=& $command.Source --version 2>$null|Select-Object -First 1}catch{Write-Verbose ("تعذر قراءة إصدار " + $Name + ": " + $_.Exception.Message)}
 [pscustomobject]@{name=$Name;available=$true;path=$command.Source;version=[string]$version}
}
function Invoke-S3Prerequisite {
 param([Parameter(Mandatory)]$Context)
 if($Context.Mode -eq 'Simulation'){
  $result=[ordered]@{windows=$true;path=$true;internet=$true;diskFreeGB=20;transcription=$false;proxy='SIMULATED';browser=$true;clockSkewSeconds=0;tools=@('pwsh','git','gh','node','npm','firebase','wrangler','gcloud','python')|ForEach-Object{[pscustomobject]@{name=$_;available=$true;path="mock:$_";version='mock-1.0'}}}
  $result|ConvertTo-Json -Depth 8|Set-Content (Join-Path $Context.Root 'reports\01-local-prerequisites.json') -Encoding UTF8;return $result
 }
 if(-not $IsWindows){throw 'هذه الحزمة تعمل على Windows فقط.'};if($Context.Root -ne 'C:\Users\MC\Desktop\1'){throw 'المسار الحاكم غير متاح.'};if(Test-S3Transcription){throw 'PowerShell transcription نشط. توقف لحماية الأسرار.'}
 $driveName=[IO.Path]::GetPathRoot($Context.Root).TrimEnd(':\');$drive=Get-PSDrive -Name $driveName;if($drive.Free -lt 3GB){throw 'مساحة القرص أقل من 3 GB.'}
 try{$response=Invoke-WebRequest 'https://api.github.com/meta' -TimeoutSec 20 -UseBasicParsing;if($response.StatusCode -ne 200){throw 'bad'}}catch{throw 'تعذر الاتصال الآمن بالإنترنت.'}
 $toolNames=@('pwsh','git','gh','node','npm','firebase','wrangler','gcloud','python');$tools=@($toolNames|ForEach-Object{Get-S3ToolInfo $_});$missing=@($tools|Where-Object{-not $_.available});if($missing.Count -gt 0){throw ('أدوات مفقودة بعد التهيئة: '+(($missing.name)-join ', '))}
 $proxy=[Net.WebRequest]::DefaultWebProxy.GetProxy([uri]'https://api.github.com').AbsoluteUri;$browser=$null -ne (Get-Command 'explorer.exe' -ErrorAction SilentlyContinue)
 $local=[DateTimeOffset]::Now;$utc=[DateTimeOffset]::UtcNow;$clockSkew=[math]::Abs(($local.UtcDateTime-$utc.UtcDateTime).TotalSeconds);if($clockSkew -gt 120){throw 'وقت الجهاز غير متسق؛ صححه قبل المصادقة.'}
 $result=[ordered]@{windows=$true;path=$true;internet=$true;diskFreeGB=[math]::Round($drive.Free/1GB,2);transcription=$false;proxy=$proxy;browser=$browser;localTime=$local.ToString('o');utcTime=$utc.ToString('o');clockSkewSeconds=$clockSkew;tools=$tools}
 $result|ConvertTo-Json -Depth 8|Set-Content (Join-Path $Context.Root 'reports\01-local-prerequisites.json') -Encoding UTF8
 @('# فحص الجهاز','', '- Windows: PASS','- المسار: PASS','- الإنترنت: PASS',"- مساحة القرص: $($result.diskFreeGB) GB",'- Transcription: غير نشط',"- المتصفح: $(if($browser){'PASS'}else{'FAIL'})")|Set-Content (Join-Path $Context.Root 'reports\01-local-prerequisites.md') -Encoding UTF8
 return $result
}
Export-ModuleMember -Function *-S3*
