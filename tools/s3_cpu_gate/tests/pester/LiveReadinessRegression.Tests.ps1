BeforeAll { . (Join-Path $PSScriptRoot 'TestHelper.ps1') }

Describe 'Live readiness regression guards' {
    It 'does not create an empty PR when current main already contains the payload' {
        $context = Get-TestContext 'Live'
        $repositoryFile = Join-Path $context.Root 'repository\tools\s3_cpu_gate\payload.txt'
        $payloadFile = Join-Path $context.Root 'workspace\repository_payload\tools\s3_cpu_gate\payload.txt'
        New-Item -ItemType Directory -Path (Split-Path $repositoryFile),(Split-Path $payloadFile) -Force | Out-Null
        Set-Content -LiteralPath $repositoryFile -Value 'current-main-payload' -NoNewline
        Set-Content -LiteralPath $payloadFile -Value 'current-main-payload' -NoNewline
        Mock Confirm-S3Arabic { throw 'CONFIRMATION_MUST_NOT_RUN' } -ModuleName Repository
        Mock Invoke-S3Process {
            param($FilePath,$ArgumentList)
            $arguments = @($ArgumentList)
            if ($FilePath -ne 'git') { throw "UNEXPECTED_PROCESS: $FilePath $($arguments -join ' ')" }
            if (($arguments -join ' ') -eq 'branch --show-current') { return [pscustomobject]@{ ExitCode = 0; StdOut = 'main'; StdErr = '' } }
            if ($arguments -contains 'status') { return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' } }
            if (($arguments -join ' ') -in @('rev-parse HEAD','rev-parse origin/main')) { return [pscustomobject]@{ ExitCode = 0; StdOut = 'merged-main-sha'; StdErr = '' } }
            throw "UNEXPECTED_GIT_PROCESS: $($arguments -join ' ')"
        } -ModuleName Repository
        $result = Invoke-S3BranchAndDraftPr $context
        $result.status | Should -Be 'NO_DIFF_CURRENT_MAIN'
        $result.currentMain | Should -Be 'PASS'
        $result.branch | Should -BeNullOrEmpty
        $result.draftPr | Should -BeNullOrEmpty
        Should -Invoke Confirm-S3Arabic -ModuleName Repository -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList[0] -eq 'switch' } -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList -contains 'commit' } -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList -contains 'push' } -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $FilePath -eq 'gh' -and $ArgumentList[0] -eq 'pr' } -Times 0
    }

    It 'keeps Draft PR confirmation fail-closed when the payload differs from current main' {
        $context = Get-TestContext 'Live'
        $repositoryFile = Join-Path $context.Root 'repository\tools\s3_cpu_gate\payload.txt'
        $payloadFile = Join-Path $context.Root 'workspace\repository_payload\tools\s3_cpu_gate\payload.txt'
        New-Item -ItemType Directory -Path (Split-Path $repositoryFile),(Split-Path $payloadFile) -Force | Out-Null
        Set-Content -LiteralPath $repositoryFile -Value 'current-main-payload' -NoNewline
        Set-Content -LiteralPath $payloadFile -Value 'required-new-payload' -NoNewline
        Mock Confirm-S3Arabic { $false } -ModuleName Repository
        Mock Invoke-S3Process {
            param($FilePath,$ArgumentList)
            $arguments = @($ArgumentList)
            if ($FilePath -ne 'git') { throw "UNEXPECTED_PROCESS: $FilePath $($arguments -join ' ')" }
            if (($arguments -join ' ') -eq 'branch --show-current') { return [pscustomobject]@{ ExitCode = 0; StdOut = 'main'; StdErr = '' } }
            if ($arguments -contains 'status') { return [pscustomobject]@{ ExitCode = 0; StdOut = ''; StdErr = '' } }
            if (($arguments -join ' ') -in @('rev-parse HEAD','rev-parse origin/main')) { return [pscustomobject]@{ ExitCode = 0; StdOut = 'merged-main-sha'; StdErr = '' } }
            throw "UNEXPECTED_GIT_PROCESS: $($arguments -join ' ')"
        } -ModuleName Repository
        { Invoke-S3BranchAndDraftPr $context } | Should -Throw '*ألغى المستخدم*'
        Should -Invoke Confirm-S3Arabic -ModuleName Repository -Times 1
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList[0] -eq 'switch' } -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList -contains 'commit' } -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $ArgumentList -contains 'push' } -Times 0
        Should -Invoke Invoke-S3Process -ModuleName Repository -ParameterFilter { $FilePath -eq 'gh' -and $ArgumentList[0] -eq 'pr' } -Times 0
    }

    It 'keeps staging script inside the package allowlist' {
        $manifest = Get-Content (Join-Path $SourceRoot 'package-manifest.json') -Raw | ConvertFrom-Json
        @($manifest.files) | Should -Contain 'S3-CPU-Gate-Setup.ps1'
        Test-Path (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') | Should -BeTrue
        $setup = Get-Content (Join-Path $SourceRoot 'S3-CPU-Gate-Setup.ps1') -Raw
        $setup | Should -Match 'Copy-S3ManifestPayloadToStage'
        $setup | Should -Match '\$packageManifest\.files'
        $setup | Should -Not -Match 'Source\s*=\s*\.'
        $setup | Should -Match 'payloadStage\s*=\s*Join-Path\s+\$stageRoot\s+''workspace\\repository_payload\\tools\\s3_cpu_gate'''
        $setup | Should -Match 'payloadDestination\s*=\s*Join-Path\s+\$RuntimeRoot\s+''workspace\\repository_payload\\tools\\s3_cpu_gate'''
        $setup | Should -Match 'Remove-Item -LiteralPath \$payloadDestination -Recurse -Force'
        $setup | Should -Match 'Copy-Item -LiteralPath \$payloadStage -Destination \$payloadDestination -Recurse -Force'
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
        $validation | Should -Match '\$expectedPesterCount\s*=\s*309'
        $validation | Should -Match '\$result\.TotalCount\s+-eq\s+\$expectedPesterCount'
        $validation | Should -Match '\$result\.PassedCount\s+-eq\s+\$expectedPesterCount'
    }

    It 'pins gcloud to the versioned release URL' {
        $manifest = Get-Content (Join-Path $SourceRoot 'src\version-manifest.json') -Raw | ConvertFrom-Json
        $manifest.tools.gcloud.url | Should -Be 'https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-577.0.0-windows-x86_64.zip'
        $manifest.tools.gcloud.version | Should -Be '577.0.0'
        $manifest.tools.gcloud.sha256 | Should -Be '21e68c5e1a88ee4abb484719500c925f814695d8300a7a88db53c70df2d2f142'
    }

    It 'handles optional tool-plan metadata without weakening required definitions' {
        Import-Module (Join-Path $ModuleRoot 'Toolchain.psm1') -Force
        { Get-S3ToolPlan } | Should -Not -Throw
        $plan = @(Get-S3ToolPlan)
        ($plan | Where-Object Name -eq 'Npm').ApproxMB | Should -Be 0
        ($plan | Where-Object Name -eq 'Npm').Source | Should -Be 'PowerShell Gallery/npm official registry'
        $toolchain = Get-Content (Join-Path $SourceRoot 'src\modules\Toolchain.psm1') -Raw
        $toolchain | Should -Match "ContainsKey\('ApproxMB'\)"
        $toolchain | Should -Match "ContainsKey\('Url'\)"
        $toolchain | Should -Match "ContainsKey\('Repo'\)"
        $toolchain | Should -Match 'TOOL_DEFINITION_INVALID'
    }
}
