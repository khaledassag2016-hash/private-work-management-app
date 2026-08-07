BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }

Describe 'Live readiness regression guards' {
    It 'does not create an empty PR when current main already contains the payload' {
        $context = Get-TestContext 'Live'
        New-Item -ItemType Directory -Path (Join-Path $context.Root 'repository\.git') -Force | Out-Null
        Mock Confirm-S3Arabic { $true } -ModuleName Repository
        Mock Assert-S3NoSecret {} -ModuleName Repository
        Mock Invoke-S3Process {
            param($Context,$FilePath,$ArgumentList)
            $args = @($ArgumentList)
            if ($args -contains 'pr') { return [pscustomobject]@{ ExitCode = 0; StdOut = '[]'; StdErr = '' } }
            if ($args -contains 'show-ref') { return [pscustomobject]@{ ExitCode = 1; StdOut = ''; StdErr = '' } }
            if ($args -contains 'status') { return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' } }
            return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' }
        } -ModuleName Repository
        $result = Invoke-S3BranchAndDraftPr $context
        $result.status | Should -Be 'NO_DIFF_CURRENT_MAIN'
        $result.draftPr | Should -BeNullOrEmpty
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList -contains 'push' } -Times 0
    }

    It 'keeps staging script inside the package allowlist' {
        $manifest = Get-Content (Join-Path $SourceRoot 'package-manifest.json') -Raw | ConvertFrom-Json
        @($manifest.files) | Should -Contain 'S3-CPU-Gate-Setup.ps1'
        Test-Path (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') | Should -BeTrue
    }
}
