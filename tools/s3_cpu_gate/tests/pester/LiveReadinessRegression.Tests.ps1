BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }

Describe 'Live readiness regression guards' {
    It 'does not create an empty PR when current main already contains the payload' {
        $context = Get-TestContext 'Live'
        New-Item -ItemType Directory -Path (Join-Path $context.Root 'repository\.git') -Force | Out-Null
        Mock Confirm-S3Arabic { $true } -ModuleName Repository
        Mock Assert-S3NoSecret {} -ModuleName Repository
        Mock Invoke-S3Process {
            param($ArgumentList)
            $arguments = @($ArgumentList)
            if ($arguments -contains 'pr') { return [pscustomobject]@{ ExitCode = 0; StdOut = '[]'; StdErr = '' } }
            if ($arguments -contains 'show-ref') { return [pscustomobject]@{ ExitCode = 1; StdOut = ''; StdErr = '' } }
            if ($arguments -contains 'status') { return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' } }
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
        $setup = Get-Content (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') -Raw
        $setup | Should -Match 'Copy-S3ManifestPayloadToStage'
        $setup | Should -Match '\$packageManifest\.files'
        $setup | Should -Not -Match 'Source\s*=\s*\.'
    }

    It 'refuses every non-final runtime state before staging' {
        $setup = Get-Content (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') -Raw
        $setup | Should -Match '\$current -notin @'
        $setup | Should -Match 'ACTIVE_OR_UNCLEAN_STATE_PRESENT'
    }

    It 'keeps clean finalized staging and ready evidence after validation' {
        $setup = Get-Content (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') -Raw
        $setup | Should -Match "'80_RESOURCES_DESTROYED','90_REPORT_READY'"
        $setup | Should -Match "status = 'PASS'"
        $setup | Should -Match 'runtime-staging\.json'
    }

    It 'cleans failed staging without leaving a partial ready marker' {
        $setup = Get-Content (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') -Raw
        $setup | Should -Match 'finally'
        $setup | Should -Match 'Remove-Item -LiteralPath \$stageRoot -Recurse -Force'
        $setup | Should -Match 'ShouldProcess\(\$RuntimeRoot'
        $setup.IndexOf("status = 'PASS'") | Should -BeLessThan $setup.IndexOf('finally')
    }

    It 'keeps the Pester acceptance count at the approved suite size' {
        $validation = Get-Content (Join-Path $SourceRoot 'build\Invoke-Phase1PowerShellValidation.ps1') -Raw
        $validation | Should -Match '\$expectedPesterCount\s*=\s*176'
        $validation | Should -Match '\$result\.TotalCount\s+-eq\s+\$expectedPesterCount'
        $validation | Should -Match '\$result\.PassedCount\s+-eq\s+\$expectedPesterCount'
    }
}
