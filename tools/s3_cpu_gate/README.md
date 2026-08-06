# S3 CPU Gate repository payload

This payload is self-contained for static and regression testing. It includes the orchestrator source, all PowerShell modules, Python helpers, Worker source, Pester tests with `TestHelper.ps1`, Python tests, validation scripts, and the authoritative `src/version-manifest.json`.

The workflow executes against GitHub's synthetic pull-request merge revision and performs Foundation, S2, PowerShell, Python, Node, secret, ZIP-safety, and payload-integrity checks. It does not authenticate to cloud providers or create resources.
