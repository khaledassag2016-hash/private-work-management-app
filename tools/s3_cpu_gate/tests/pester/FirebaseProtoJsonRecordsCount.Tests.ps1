BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }

Describe 'B3 Firebase recordsCount ProtoJSON compatibility' -Tag 'B3' {
    It 'sends the approved quota project header for accounts:query' {
        $script:capturedFirebaseRestHeaders = $null
        Mock Invoke-RestMethod {
            param($Headers)
            $script:capturedFirebaseRestHeaders = $Headers
            [pscustomobject]@{recordsCount='0'}
        } -ModuleName Firebase
        @(Get-S3FirebaseUser -ProjectId 's3cpu-test' -Token 'test-token').Count | Should -Be 0
        $script:capturedFirebaseRestHeaders.Authorization | Should -Be 'Bearer test-token'
        $script:capturedFirebaseRestHeaders['x-goog-user-project'] | Should -Be 'ultra-function-476817-g5'
    }

    It 'accepts recordsCount string zero with omitted userInfo as zero users' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{recordsCount='0'} } -ModuleName Firebase
        @(Get-S3FirebaseUser -ProjectId p -Token token).Count | Should -Be 0
    }

    It 'accepts recordsCount string two with exactly two users' {
        Mock Invoke-S3GoogleRest {
            [pscustomobject]@{
                recordsCount='2'
                userInfo=@(
                    [pscustomobject]@{localId='one'},
                    [pscustomobject]@{localId='two'}
                )
            }
        } -ModuleName Firebase
        @(Get-S3FirebaseUser -ProjectId p -Token token).Count | Should -Be 2
    }

    It 'accepts an integer numeric recordsCount with a matching userInfo count' {
        Mock Invoke-S3GoogleRest {
            [pscustomobject]@{
                recordsCount=[int64]2
                userInfo=@(
                    [pscustomobject]@{localId='one'},
                    [pscustomobject]@{localId='two'}
                )
            }
        } -ModuleName Firebase
        @(Get-S3FirebaseUser -ProjectId p -Token token).Count | Should -Be 2
    }

    It 'treats omitted recordsCount and omitted userInfo as zero users' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{} } -ModuleName Firebase
        @(Get-S3FirebaseUser -ProjectId p -Token token).Count | Should -Be 0
    }

    It 'treats omitted recordsCount and an empty userInfo array as zero users' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{userInfo=@()} } -ModuleName Firebase
        @(Get-S3FirebaseUser -ProjectId p -Token token).Count | Should -Be 0
    }

    It 'fails when recordsCount is omitted but userInfo is nonempty' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{userInfo=@([pscustomobject]@{localId='one'})} } -ModuleName Firebase
        { Get-S3FirebaseUser -ProjectId p -Token token } | Should -Throw '*RECORDSCOUNT_MISSING*'
    }

    It 'rejects a malformed nonnumeric recordsCount string' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{recordsCount='two';userInfo=@()} } -ModuleName Firebase
        { Get-S3FirebaseUser -ProjectId p -Token token } | Should -Throw '*INTEGER_EXPECTED*'
    }

    It 'rejects a negative recordsCount' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{recordsCount=-1;userInfo=@()} } -ModuleName Firebase
        { Get-S3FirebaseUser -ProjectId p -Token token } | Should -Throw '*INTEGER_OUT_OF_RANGE*'
    }

    It 'rejects a fractional recordsCount' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{recordsCount=1.5;userInfo=@()} } -ModuleName Firebase
        { Get-S3FirebaseUser -ProjectId p -Token token } | Should -Throw '*INTEGER_EXPECTED*'
    }

    It 'rejects a recordsCount string outside signed int64 range' {
        Mock Invoke-S3GoogleRest { [pscustomobject]@{recordsCount='9223372036854775808';userInfo=@()} } -ModuleName Firebase
        { Get-S3FirebaseUser -ProjectId p -Token token } | Should -Throw '*INTEGER_OUT_OF_RANGE*'
    }

    It 'accepts the native email sign-in provider record' {
        $users = @(
            [pscustomobject]@{
                localId='one'
                providerUserInfo=@([pscustomobject]@{providerId='password'})
            }
        )
        $proof = Assert-S3FirebaseUserSet -Users $users -ExpectedUids @('one')
        $proof.verified | Should -BeTrue
        $proof.providerLinks | Should -Be 0
    }

    It 'still rejects a federated provider record' {
        $users = @(
            [pscustomobject]@{
                localId='one'
                providerUserInfo=@([pscustomobject]@{providerId='google.com'})
            }
        )
        { Assert-S3FirebaseUserSet -Users $users -ExpectedUids @('one') } |
            Should -Throw '*FIREBASE_USER_PROVIDER_LINK_PRESENT*'
    }
}
