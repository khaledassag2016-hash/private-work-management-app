# S11 Historical Import Verification

## Activation and privacy boundary

S11 / Issue #10 was executed from the exact activated S10 main base `9b09d3af7491ae0fc119b52e3ecf4ef1aff45ef5`. The activation instruction SHA-256 was verified as `f74d193cc6a1a47750f8bf0f8f37a88013275206158fbe2d911b40db2b739d80`.

The private preparation workbook was read locally in read-only mode. Its local SHA-256 is `9362ec01af414c61f6118378c7f7ce53322bf11d986a854e2bf24a90afec847d`. The workbook itself, its raw source text, customer identifiers, and any real financial source rows are not part of this repository, CI, or the PR.

## Implementation

The S11 implementation adds a mirrored migration and importer module. The model preserves immutable source identity, source location, original text, normalized JSON, record type, review state, decision reason, reviewer metadata, date completeness, uncertainty flags, customer-mapping state, integer-halalah amounts, activation state, batch identity, and append-only import events. Historical records are staged separately from current operational tables.

A financial historical record has zero operational effect unless it is explicitly approved through the S11 approval path. Approved activation is recorded with reviewer, timestamp, reason, and a separate activation row. Batches are idempotent by source-store digest plus batch key, conflicting source identity is rejected, and batch deactivation revokes effects without deleting provenance.

## Synthetic acceptance

The deterministic focused suite passed `8/8` tests. It covers missing-year fail-closed behavior, explicit zero-price reasoning, separation of Works/totals/settlements/notes, source preservation, dry-run mutation safety, AC-14, explicit financial approval, idempotency, duplicate/conflict protection, integer halalas, rollback/deactivation, provenance immutability, and authorized historical search.

The synthetic dry-run report is complete with accepted, rejected, and pending outcomes. Unapproved historical financial values remain non-operational. No synthetic fixture contains real customer content.

## Private local execution

The prepared private workbook was processed only in the local sandbox after the read-only structural gate. The parser produced `9` records. The sanitized dry-run result was `ACCEPTED=1`, `REJECTED=0`, `PENDING_REVIEW=8`, `UNKNOWN=0`; unresolved customer mappings were `4`; incomplete dates were `0`; financial records remaining non-operational were `9`; operational effect was `0` halalas. The local in-memory staging/import reconciliation was `9` total, `9` active, and `0` operational effect. No Cloud or authoritative production write was performed.

The prepared opening historical balance remains a distinct pending historical record and was not injected into `prior_balance` or any current operational balance. Customer mappings remain pending where the private store does not provide explicit identity. No source fact was guessed or auto-confirmed.

## Regression and privacy gates

The final evidence stamp must record the exact final PR head and matching final-head CI run IDs. The private workbook is deliberately absent from the changed-file set and from every CI command.

| Gate | Result |
|---|---|
| Activation base | PASS — `9b09d3af7491ae0fc119b52e3ecf4ef1aff45ef5` |
| Focused S11 acceptance | PASS — `8/8` |
| Private local dry-run | PASS — no authoritative mutation; zero operational effect |
| AC-14 | PASS — unapproved historical amounts remain non-operational |
| Idempotency / duplicate protection | PASS |
| Rollback / provenance | PASS |
| Integer-halalah reconciliation | PASS |
| Real data in GitHub | NO |
| Cloud write | NO |
| Paid service | NO |
| Secrets added | NO |
| Stable refs moved | NO |
| Final PR head | `0762d70c28645a258011a657f674dd0dbebce271` |
| Final-head CI run IDs | `31726564199`, `31726564153`, `31726564307`, `31726564145`, `31726564246` (all successful on this head) |
