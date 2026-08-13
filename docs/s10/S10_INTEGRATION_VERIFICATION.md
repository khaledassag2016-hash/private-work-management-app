# S10 INTEGRATION VERIFICATION

## Scope and governance

This document records the S10 / Issue #9 implementation and verification cycle from the exact activated base. It does not declare `S10_CLOSED_COMPLETE`; administrative closure remains outside PR-A under the activated execution instruction.

| Field | Value |
|---|---|
| Repository | `khaledassag2016-hash/private-work-management-app` |
| Issue | `#9 — [S10] اختبار التكامل والنسخ والاستعادة` |
| Base SHA | `83f66a03d481a54ea479963eceea9df614ef5e12` |
| Final head SHA | `938f7c09e9fc7fa264166bd9a8c63227e6d8f06d` |
| Branch | `s10/pr-a-integration-backup-restore` |
| Executor | Manus only |
| Cloud writes | `NO` |
| Real data | `NO` |
| Paid service | `NO` |
| Secrets added | `NO` |
| Stable refs moved | `NO` |

## Changed files

The final PR-A changed-file list at the verified implementation head is:

`4 files: .github/workflows/s10-integration.yml, docs/s10/S10_ACCEPTANCE_MATRIX.json, docs/s10/S10_INTEGRATION_VERIFICATION.md, tests/s10_integration.test.mjs`.

The final PR metadata and the final-head CI run on `938f7c09e9fc7fa264166bd9a8c63227e6d8f06d` are authoritative for supervisory review.

The intended S10-only files are:

1. `.github/workflows/s10-integration.yml`
2. `docs/s10/S10_ACCEPTANCE_MATRIX.json`
3. `docs/s10/S10_INTEGRATION_VERIFICATION.md`
4. `tests/s10_integration.test.mjs`

## Reproducible commands

The focused S10 suite is run with:

```text
node --check tests/s10_integration.test.mjs
node --test tests/s10_integration.test.mjs
```

The final-head CI workflow runs the focused S10 suite, the complete existing Node regression list, the final S9 Playwright Level A and Level B suites with `Playwright 1.62.0` and `@axe-core/playwright 4.12.1`, Foundation, S2, the applicable S3 repository checks, Python, Pester, PSScriptAnalyzer, secret scan and payload integrity. The exact toolchain is read from `tools/s3_cpu_gate/src/version-manifest.json`, including `Node 22.23.1`, `npm 10.9.2`, `Python 3.13.14`, `PowerShell 7.6.3`, `Pester 6.0.0` and `PSScriptAnalyzer 1.25.0`.

## AC-01..AC-14 matrix

The machine-readable matrix is `docs/s10/S10_ACCEPTANCE_MATRIX.json`. The result is **12 PASS rows and two explicit D-020 deferrals**. `AC-11` is `DEFERRED_S3_NOT_FULL_PASS` with implemented actor/time evidence tested. `AC-14` is `DEFERRED_S11_NOT_FULL_PASS` with a protected-route no-bypass boundary test; neither deferred criterion was fabricated as PASS or implemented in S10.

## Security and permissions

The real Worker authentication boundary was exercised with temporary synthetic X.509/JWT material created outside the repository and removed after the test. Missing authentication, malformed token, wrong audience, unknown allowlist UID, authenticated read, and unauthorized write were tested. The two active permitted accounts remained distinct, a protected write without authentication produced no mutation, errors exposed no secret material, and a historical-import route probe returned `404 NOT_FOUND` without any balance mutation.

Result: **PASS — fail-closed security and permissions gate.**

## Concurrency, conflict, and idempotency

Two synthetic actors raced on optimistic Work title updates and dual-approval pricing. Each race produced one winner and one conflict, with no duplicate history or financial movement. Repeating the same payment request ID and alert-setting request ID returned an idempotent replay and created only one durable mutation. Append-only facts and failed-authorization/no-partial-write behavior remained protected.

Result: **PASS — deterministic conflict and duplicate-mutation gate.**

## Financial and settlement reconciliation

All financial assertions used integer halalas. The focused fixture verified an authoritative current price of `170000` halalas, 40/60 shares of `68000/102000`, separate `received_by` and `recorded_by` identities, append-only payment reversal, transfer fee `101` halalas, subscription baseline `13650` halalas, exact closed-period protection and the unresolved shared-expense rule remaining fail-closed. The post-reversal approved payment total reconciled to zero without rewriting the original payment.

Result: **PASS — no unexplained halalah difference.**

## Backup, export and actual restore

The source was a deterministic synthetic two-actor acceptance database created from `schema.sql`. The local backup was a separate SQL artifact generated from the source database and restored into a new empty SQLite target at a distinct path. The restore test compared source and restored row counts and a complete snapshot digest, ran `PRAGMA foreign_key_check`, verified title/archive history, re-read financial, search and analytics outputs, exercised an authenticated Worker read against the restored target, and tested a corrupted backup inside a transaction.

| Restore evidence | Result |
|---|---|
| Source dataset | `S10_SYNTHETIC_SEED_v1 / two actors / acceptance fixture` |
| Schema level | `schema.sql at BASE_SHA` |
| Backup bytes | `86268` |
| Backup SHA-256 | `2677125615f2886c6152e1254828cfbca2df64b21d6fd59df20f5f1c7af3ace50` |
| Source snapshot digest | `6fcc0207a9b13006503f1f970d86f9c59e443c223fc0d357d5295262f533eca3` |
| Restored snapshot digest | `6fcc0207a9b13006503f1f970d86f9c59e443c223fc0d357d5295262f533eca3` |
| Separate restore target | `PASS` |
| Row-count reconciliation | `PASS` |
| Foreign-key reconciliation | `PASS` |
| History/archive reconciliation | `PASS` |
| Financial/search/analytics reconciliation | `PASS` |
| Authenticated restored read | `PASS` |
| Corrupt/incomplete backup negative case | `PASS — rejected without accepting app state` |

The backup SHA and bytes were identical across two clean focused runs; generated backup and restore files were ephemeral and were not committed.

## Multi-year profile and performance

The deterministic synthetic profile used exactly two actors, `24` customers and `240` Works distributed across `2021–2026`, with active and archived Works, price/payment/event records and query paths for search, analytics and customer export. No numeric latency SLA was invented.

| Operation | p50 (ms) | p95 (ms) | max (ms) | Query count | Max bind |
|---|---:|---:|---:|---:|---:|
| Search Works | 1.360 | 1.488 | 1.854 | 1 | 6 |
| Analytics | 1.002 | 1.158 | 1.193 | 1 | 1 |
| Customer export | 0.487 | 0.597 | 0.613 | 4 | 3 |

Result: **PASS — bounded query counts, maximum bind width below 100, no observed per-Work query growth, zero timeout/failure, and no correctness shortcut.** These are objective local measurements, not a new product SLA.

## Prior-stage regression and CI

The successful final-head CI runs below completed on definitive head `938f7c09e9fc7fa264166bd9a8c63227e6d8f06d`. Any later CI rerun caused only by this exact evidence update must also be green before final handoff.

| Gate | Result / run |
|---|---|
| Focused S10 | `PASS — 6/6` |
| Full Node regression | `PASS — 140 passed, 0 failed` |
| S9 Playwright/accessibility | `PASS — Level A 10 passed; Level B 34 passed, 6 intentional skips` |
| Foundation | `PASS — CI run 31719956136` |
| S2 | `PASS — CI run 31719956084` |
| S3 | `PASS — applicable S3 static checks in S10 run; S3 remains CLOSED_BLOCKED_DEFERRED` |
| Python/Pester/PSScriptAnalyzer | `PASS — Python 80/80; Pester/PSScriptAnalyzer 291 passed, 0 failed` |
| Secret scan | `PASS` |
| Payload parity/integrity | `PASS` |
| Final-head CI run IDs | `S10 31719956114; Foundation 31719956136; S2 31719956084` |

## Unresolved governed boundaries

`S3 = CLOSED_BLOCKED_DEFERRED` remains unchanged. `AC-11` is reported as `DEFERRED_S3_NOT_FULL_PASS` under D-020. Historical import and `AC-14` remain S11-owned; `AC-14` is reported as `DEFERRED_S11_NOT_FULL_PASS`, and S10 verifies only that no current protected route silently injects historical numbers. The negative-final-price policy, overpayment beyond remaining, generic shared-expense allocation, and multi-Work allocation of one ordinary payment remain fail-closed and were not redefined.

## Final S10 PR-A boundary

This PR implements only deterministic S10 verification and the minimal test/CI/evidence files required by Issue #9. It does not perform production deployment, Cloud writes, real-data migration, paid-service activation, S11 historical import or stable-ref movement. After final-head verification, Manus stops all branch writes and returns the required supervisory handoff.
