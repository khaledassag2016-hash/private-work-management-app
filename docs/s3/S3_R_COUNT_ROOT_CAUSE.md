# S3-R Resume Count Root Cause

## Baseline and preserved-run boundary

The reproduction target is merged `main` commit `73af2f3fe5f0a4b8d0a328e47b29603a9d2231e1`. The fixture is sanitized and represents the preserved run at `60_CLOUDFLARE_PROVISIONED`; it contains no tokens, passwords, nonce values, or real provider responses. No Cloud API is called by the reproduction.

The preserved legacy shape omits `resources.firebase.uid1` and `resources.firebase.uid2`. This is valid because Firebase and D1 are the authoritative sources for UID recovery; the persisted state must not be treated as the only UID source.

## Deterministic pre-fix reproduction

`tools/s3_cpu_gate/tests/pester/OperationalRegression.Tests.ps1` invokes `Invoke-S3FirebaseRuntimeRehydration` with `-ExpectedUids $null` and a provider that must not be reached. On baseline `73af2f3fe5f0a4b8d0a328e47b29603a9d2231e1`, the call fails before the provider or any Cloud operation:

```text
Exception type: System.Management.Automation.PropertyNotFoundException
Message: The property 'Count' cannot be found on this object. Verify that the property exists.
Failing file: tools/s3_cpu_gate/src/modules/Firebase.psm1
Function: Invoke-S3FirebaseRuntimeRehydration
Statement: if ($ExpectedUids.Count -ne 0 -and (...))
Baseline line: 613
Runtime object: $ExpectedUids is null (the parameter is declared [string[]], but PowerShell binds an explicit null as null rather than an empty array).
```

The orchestrator creates the same null shape from its pipeline when both persisted UID fields are absent:

```powershell
$expectedUids=@((uid1),(uid2)) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
```

With zero outputs, the pipeline result is null. With one output, it is a scalar `System.String`. With two outputs, it is an `System.Object[]`. Under `Set-StrictMode -Version Latest`, dereferencing `.Count` on the null zero-output result produces the observed exception. The authoritative Firebase and D1 UID discovery occurs later in `Invoke-S3FirebaseRuntimeRehydration`, so the legacy run fails before it can discover those UIDs.

## Correct sequencing

The fixed path normalizes the incoming parameter immediately with `@($ExpectedUids)`, making zero, one, and two element shapes deterministic. It obtains the temporary admin session from the provider, reads the authoritative Firebase users, reads the authoritative D1 run UID set, and compares the two sets before credential construction that depends on UIDs. When the initial provider call returns no credentials for a legacy empty input, the provider is called a second time with the authoritative two-UID array. No UID is invented and no Firebase user is created. Existing providers that already return two credentials remain supported.

The Firebase provider now returns an empty credential collection plus the in-memory admin token and API key when it receives an empty UID set, then constructs synthetic same-UID credentials only after authoritative UIDs are supplied. Credentials, passwords, API keys, ID tokens, and refresh tokens remain runtime-memory values and are cleared in the existing cleanup path.

## Resume-path scalar/array audit

The checkpoint-60 path is guarded as follows:

| Area | Invariant |
|---|---|
| Bootstrap / AutoRehydrateProviders | Only factory switches and scriptblocks cross the process boundary; secret values are not command-line arguments. |
| Orchestrator | Provisioning branches remain disabled for resumed contexts; CPU remains the first incomplete gate. |
| Cleanup credential restore | Session/account collections are wrapped before `.Count` or selection logic; absent sessions fail closed. |
| Firebase provider | Empty, one, and two UID inputs are normalized; credentials are built only after authoritative UIDs are known. |
| Firebase rehydration | Credential arrays, Firebase users, D1 UIDs, and authoritative UID sets are explicitly array-shaped before count/comparison operations. |
| Cloudflare rehydration | Worker variables and snapshot collections remain explicitly array-shaped; nonce values are never returned or logged. |
| Worker restore | The existing success/failure `finally` restoration wrapper remains unchanged and continues to verify effective remote state. |

## Why PR #98 did not catch it

PR #98 tested the newer provider contract with `-ExpectedUids @()` and a custom provider that returned two credentials independently of the UID argument. Its test therefore never reproduced the orchestrator's null pipeline result from a legacy state that omitted both persisted UID fields. The previous suite had strong coverage for two-UID recovery, provisioning avoidance, secret non-serialization, and Worker restoration, but lacked a zero-output pipeline fixture and did not assert the provider call sequence for authoritative UID discovery.

## Failure evidence

`Write-S3FailureEvidence` now accepts the original `ErrorRecord` and operation name. It records only sanitized `exceptionType`, source script name, function, line number, safe position, operation, and a SHA-256 fingerprint. The existing redaction and state serialization guards remain active; no secret material is included in state, logs, reports, or the fingerprint input.

The reproduction and the post-fix regressions also assert that provisioning is not repeated, runtime secrets are not serialized, and Worker restoration tests continue to pass. 
