BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }
Describe 'Common security helpers' {
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
}
