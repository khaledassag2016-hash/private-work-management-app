BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'Common security helpers' {
 BeforeEach {
  foreach($name in @('worker','python')){Remove-Item -LiteralPath (Join-Path $TestDrive $name) -Recurse -Force -ErrorAction SilentlyContinue}
  $env:PATH='C:\Users\MC\Desktop\1\python;'+$env:PATH
 }
 It 'redacts bearer authorization' { Protect-S3Text (('Author'+'ization')+': '+('Bear'+'er')+' abc.def.ghi') | Should -Not -Match 'abc\.def\.ghi' }
 It 'redacts a JWT' { Protect-S3Text (('ey'+'Jabcdefghijk')+'.abcdefghijklmno.abcdefghijklmnop') | Should -Match 'REDACTED' }
 It 'redacts password fields' { Protect-S3Text 'password=Secret123!' | Should -Not -Match 'Secret123' }
 It 'redacts access tokens' { Protect-S3Text 'access_token=secret-value' | Should -Not -Match 'secret-value' }
 It 'redacts private keys' { Protect-S3Text (("-----BEGIN "+"PRIVATE KEY-----")+"`nabc`n"+("-----END "+"PRIVATE KEY-----")) | Should -Not -Match 'abc' }
 It 'returns empty string for null' { Protect-S3Text $null | Should -Be '' }
 It 'creates unique run IDs' { (Get-S3RunId) | Should -Not -Be (Get-S3RunId) }
 It 'run ID has safe prefix' { Get-S3RunId | Should -Match '^s3cpu-' }
 It 'owned resource requires marker' { $c=Get-TestContext; Test-S3OwnedResource $c 's3cpu-20260803-174000-abcdef12-worker' 'wrong' | Should -BeFalse }
 It 'owned resource requires name' { $c=Get-TestContext; Test-S3OwnedResource $c 'unrelated' $c.RunId | Should -BeFalse }
 It 'owned resource accepts both guards' { $c=Get-TestContext; Test-S3OwnedResource $c "$($c.RunId)-worker" $c.RunId | Should -BeTrue }
 It 'cloud resource detector is false when empty' { $c=Get-TestContext; Test-S3HasOwnedCloudResource $c | Should -BeFalse }
 It 'cloud resource detector is true for Firebase marker' { $c=Get-TestContext;$c.State.resources.firebase=@{marker=$c.RunId};Test-S3HasOwnedCloudResource $c|Should -BeTrue;$c.State=($c.State|ConvertTo-Json -Depth 20|ConvertFrom-Json);Test-S3HasOwnedCloudResource $c|Should -BeTrue }
 It 'runtime secret clearing removes entries' { $c=Get-TestContext;$c.RuntimeSecrets.token1='secret';Clear-S3RuntimeSecret $c;$c.RuntimeSecrets.Count|Should -Be 0 }
 It 'state serialization guard rejects secret fields' { {$state=@{};$state[('pass'+'word')]='secret';Write-S3State -Root $TestDrive -State $state} | Should -Throw }
 It 'scans only the positive allowlisted pre-cloud payload and records its identity' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'worker\src'),(Join-Path $TestDrive 'python') -Force|Out-Null
  Set-Content (Join-Path $TestDrive 'worker\src\index.js') 'export default {}';Set-Content (Join-Path $TestDrive 'worker\schema.sql') 'SELECT 1;'
  Copy-Item (Join-Path $SourceRoot 'src\python\secret_scan.py') (Join-Path $TestDrive 'python\secret_scan.py')
  $record=Assert-S3DeploymentPayloadNoSecret -Context $c -Scope PreCloud
  $record.status|Should -Be PASS;$record.files.path|Should -Contain 'worker\src\index.js';$record.payloadSha256|Should -Match '^[a-f0-9]{64}$'
 }
 It 'fails closed for a synthetic secret inside the required payload' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'worker\src'),(Join-Path $TestDrive 'python') -Force|Out-Null
  Set-Content (Join-Path $TestDrive 'worker\src\index.js') (("-----BEGIN "+"PRIVATE KEY-----")+"`nsynthetic`n"+("-----END "+"PRIVATE KEY-----"));Set-Content (Join-Path $TestDrive 'worker\schema.sql') 'SELECT 1;'
  Copy-Item (Join-Path $SourceRoot 'src\python\secret_scan.py') (Join-Path $TestDrive 'python\secret_scan.py')
  {Assert-S3DeploymentPayloadNoSecret -Context $c -Scope PreCloud}|Should -Throw
 }
 It 'rejects a file outside the deployment allowlist' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'worker\src') -Force|Out-Null
  Set-Content (Join-Path $TestDrive 'worker\src\index.js') 'export default {}';Set-Content (Join-Path $TestDrive 'worker\schema.sql') 'SELECT 1;';Set-Content (Join-Path $TestDrive 'worker\unexpected.txt') 'not deployable'
  {Get-S3PayloadFile -Context $c -Scope PreCloud}|Should -Throw '*UNALLOWLISTED*'
 }
 It 'requires a fresh final-payload identity after a deployment file changes' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'workspace\worker\src'),(Join-Path $TestDrive 'python') -Force|Out-Null
  Set-Content (Join-Path $TestDrive 'workspace\worker\src\index.js') 'export default {}';Set-Content (Join-Path $TestDrive 'workspace\worker\wrangler.json') '{}'
  Copy-Item (Join-Path $SourceRoot 'src\python\secret_scan.py') (Join-Path $TestDrive 'python\secret_scan.py')
  $before=Assert-S3DeploymentPayloadNoSecret -Context $c -Scope FinalDeployment
  Set-Content (Join-Path $TestDrive 'workspace\worker\src\index.js') 'export default {fetch(){return new Response("changed")}}'
  $after=Assert-S3DeploymentPayloadNoSecret -Context $c -Scope FinalDeployment
  $after.payloadSha256|Should -Not -Be $before.payloadSha256
 }
 It 'fails closed when the scanner process errors or times out in scope' {
  $c=Get-TestContext;New-Item -ItemType Directory -Path (Join-Path $TestDrive 'worker\src'),(Join-Path $TestDrive 'python') -Force|Out-Null
  Set-Content (Join-Path $TestDrive 'worker\src\index.js') 'export default {}';Set-Content (Join-Path $TestDrive 'worker\schema.sql') 'SELECT 1;';Set-Content (Join-Path $TestDrive 'python\secret_scan.py') '# scanner'
  Mock Invoke-S3Process {throw 'انتهت مهلة python'} -ModuleName Common
  {Assert-S3DeploymentPayloadNoSecret -Context $c -Scope PreCloud}|Should -Throw '*مهلة*'
 }
}
