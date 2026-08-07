# S3 B1 — Final Operational Package Evidence

## Scope and state

- Scope: B1 final operational CPU Gate package only.
- Base SHA: `8ded7aea50bdf34dad8b2e2c711ddf2a35f619c7`.
- Branch: `phase/s3-b1-final-operational-package`.
- Pull Request: #25 (draft, open, not merged).
- Issue #2 remains open. The PR is not merged.
- B2/B3/B4/B5/B8 remain locked and were not reopened or semantically changed.

## Gap and implementation

The existing phase-1 ZIP builder included every file found below `tools/s3_cpu_gate`, while validation checked only a small required subset and did not reject unallowlisted or forbidden files. This left no explicit operational package allowlist and made reproducibility dependent on incidental filesystem contents.

B1 adds a checked-in `package-manifest.json` allowlist, fail-closed validation for manifest paths, unallowlisted files, secrets/auth-state names, caches, bytecode, temporary files, and deterministic ZIP entry ordering/timestamps. CI disables Python bytecode generation before package validation so its own test run cannot contaminate the payload.

The supervisory blocker on `702d07b246f72fcd26f9882e117d1d22e2962184` was fixed by skipping `make_zip()` after any validation error, validating every manifest entry before opening the ZIP, and enforcing resolved-path containment under the package root.

## Verification recorded on the current local head

- Operational package: PASS.
- Clean-checkout package build: PASS from implementation commit `9c9ca5355044175ee9d524c2906977415e386c64`.
- Payload integrity: PASS.
- ZIP safety: PASS.
- Secret scan: 0 findings (local scan).
- Forbidden/temp/cache files: PASS after cleanup; validator is fail-closed.
- Authoritative DOCX reconstruction: PASS in S3 CPU Gate Static run #49.
- Approved DOCX SHA-256: MATCH (`6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`).
- Python: `79/79 PASS` (`73` baseline plus `6` focused B1 tests).
- Pester: `170/170 PASS`, Failed 0, Skipped 0, Inconclusive 0, NotRun 0.
- PowerShell parser: `0 errors`.
- PSScriptAnalyzer: `0 Warning / 0 Error`.
- Node syntax: PASS.
- Foundation and S2: PASS; S2 `23/23 PASS`.

## Security regression coverage

- ZIP after validation failure: FIXED; the main-path regression confirms `make_zip()` is not called and no ZIP is created.
- `../outside.txt`: PASS; validation and direct `make_zip()` reject it before any payload read.
- Absolute POSIX and Windows-drive paths: PASS; validation and direct `make_zip()` reject them before any payload read.
- Valid allowlisted package: PASS.

## Protected boundaries

- Cloud: NOT EXECUTED.
- Login: NOT EXECUTED.
- Billing: NOT EXECUTED.
- Live CPU Gate: NOT EXECUTED.
- Real customer data or secrets: NOT ADDED.
- No Cloud resource was created, updated, deleted, or deployed.

## Actions on implementation head `9c9ca5355044175ee9d524c2906977415e386c64`

- Foundation integrity: run #124 / Run ID `31196109150` / success.
- S2 architecture validation: run #117 / Run ID `31196108026` / success.
- S3 CPU Gate Static: run #51 / Run ID `31196108144` / success.
- Relevant job: `92924603577` (`synthetic-merge-regression`).
- The workflow validated the synthetic PR merge revision generated from implementation head `9c9ca5355044175ee9d524c2906977415e386c64`.
- A later documentation-only head is pushed after this record; its final Actions results are recorded in the PR body to avoid an evidence/Actions self-reference cycle.
