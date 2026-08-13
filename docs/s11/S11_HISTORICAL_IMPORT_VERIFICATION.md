# S11 Historical Import Verification

## Activation and privacy boundary

S11 / Issue #10 was executed from the exact activated S10 main base `9b09d3af7491ae0fc119b52e3ecf4ef1aff45ef5`. The activation instruction SHA-256 was verified as `f74d193cc6a1a47750f8bf0f8f37a88013275206158fbe2d911b40db2b739d80`.

The private preparation workbook was read locally in read-only mode. Its local SHA-256 is `9362ec01af414c61f6118378c7f7ce53322bf11d986a854e2bf24a90afec847d`. The workbook itself, its raw source text, customer identifiers, and any real financial source rows are not part of this repository, CI, or the PR.

## Implementation

The S11 implementation adds a mirrored migration and importer module. The model preserves immutable source identity, source location, original text, normalized JSON, record type, review state, decision reason, reviewer metadata, date completeness, uncertainty flags, customer-mapping state, the original integer-halalah amount, a separate governed accounting effect, activation state, batch identity, and append-only import events. Historical records are staged separately from current operational tables.

A financial historical record has zero accounting and operational effect unless it is explicitly approved through the S11 approval path with a governed D-015 rule. The original historical amount is never treated as the settlement effect automatically: Work prices do not create a second settlement effect; governed work share, half subscription, half transfer-fee, and other explicit rules calculate the accounting effect separately. Approved activation is recorded with reviewer, timestamp, reason, rule, and a separate activation row. Batches are idempotent by source-store digest plus batch key, conflicting source identity is rejected, and batch deactivation revokes effects without deleting provenance.

## Synthetic acceptance

The deterministic focused suite passed `10/10` tests. It covers D-015 governed effects, no double counting of raw Work prices, complete-day/month/year-only and missing-year date handling, explicit zero-price reasoning, separation of Works/totals/settlements/notes, source preservation, dry-run mutation safety, AC-14, explicit financial approval, idempotency, duplicate/conflict protection, integer halalas, rollback/deactivation, provenance immutability, and internal staged historical search.

The synthetic dry-run report is complete with accepted, rejected, and pending outcomes. Unapproved historical financial values remain non-operational. No synthetic fixture contains real customer content.

## Private local execution

The prepared private workbook was processed only in the local sandbox after the read-only structural gate. The parser produced `9` records. The sanitized dry-run result was `ACCEPTED=1`, `REJECTED=0`, `PENDING_REVIEW=8`, `UNKNOWN=0`; unresolved customer mappings were `4`; incomplete dates were `0`; financial records remaining non-operational were `9`; operational effect was `0` halalas. The local in-memory staging/import reconciliation was `9` total, `9` active, and `0` operational effect. No Cloud or authoritative production write was performed.

The prepared opening historical balance remains a distinct pending historical record and was not injected into `prior_balance` or any current operational balance; its operational effect remains `0`. Customer mappings remain pending where the private store does not provide explicit identity. No source fact was guessed or auto-confirmed.

## Regression and privacy gates

The final evidence stamp must record the exact final PR head and matching final-head CI run IDs. The private workbook is deliberately absent from the changed-file set and from every CI command.

| Gate | Result |
|---|---|
| Activation base | PASS — `9b09d3af7491ae0fc119b52e3ecf4ef1aff45ef5` |
| Focused S11 acceptance | PASS — `10/10` |
| D-015 financial effect separation | PASS — original amount and governed accounting effect are separate; no raw Work double count |
| Date uncertainty gate | PASS — actual field completeness; no year inference |
| Private local dry-run | PASS — no authoritative mutation; zero operational effect |
| AC-14 | PASS — unapproved historical amounts remain non-operational |
| Idempotency / duplicate protection | PASS |
| Rollback / provenance | PASS |
| Integer-halalah reconciliation | PASS |
| Internal staged historical search | PASS — no authorization claim; only local staged helper tested |
| Real data in GitHub | NO |
| Cloud write | NO |
| Paid service | NO |
| Secrets added | NO |
| Stable refs moved | NO |
| Prior verification/evidence head (not final head) | `af6c9ff2a5bc20699a38db2b984fe90b8b7a0d69` |
| Prior verification CI run IDs (not final-head CI) | `31731866240`, `31731866244`, `31731866295`, `31731866296`, `31731866245` (all successful on the prior verification head) |
