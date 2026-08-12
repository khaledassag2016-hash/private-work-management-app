# PROJECT_STATE

## Governing authority

- Project: **Private Work Management App**.
- Official repository: `khaledassag2016-hash/private-work-management-app`.
- Authoritative requirements: `docs/APPROVED_REQUIREMENTS.docx`.
- Approved SHA-256: `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`.
- Approved size: `63710` bytes.
- Later governing decisions: `docs/DECISION_LOG.md`.
- Searchable `docs/REQUIREMENTS.md` is an operational index only and does not replace the Word authority.

## Stage status

- `S1 = CLOSED_COMPLETE`.
- `S2 = CLOSED_COMPLETE`.
- `S3 = CLOSED_BLOCKED_DEFERRED` under D-008; it is not S3 COMPLETE.
- `S4 = CLOSED_COMPLETE`.
- `S5 = CLOSED_COMPLETE`.
- `S6 = CLOSED_COMPLETE`.
- `S7 = CLOSED_COMPLETE` after PR #77 final-head CI, Squash merge and post-merge verification.
- `S7_COMPLETE = TRUE` after the same closure condition.
- `S8 = AUTHORIZED_NOT_STARTED` after S7 closure becomes effective.
- `S9..S11 = NOT_STARTED`.

## Stable refs

Stable refs do not move automatically:

- `stable/2026-08-09-be14a389` -> `be14a389d7e11f1df9f935999d888e7e2295c8a3`.
- `stable/2026-08-09-643de962` -> `643de962dc8631f68a42e3796c4a096a29c4e14c`.

## Closed-stage evidence summary

### S4 — Issue #3

- `S4_COMPLETE = TRUE`.
- Final closed main checkpoint from the S4 chain: `8807696a862b3dc6b15700e2837d8afcf1aa30c5`.
- Customer/Work core, pre-agreement warning/history, relationship rules, configurable catalogs and S4 acceptance remain regression-protected.
- Q-001..Q-004 were later resolved by D-009..D-012.

### S5 — Issue #4

- PR-A #68 final head `c64d83998998bcefff1b21962d961344b47de29d`, Squash/main `3c6bb5dbdd5074517d4568b6b4a3c5c355c856cd`.
- PR-B #69 final head `eb19187a9450dad0da92562a90e9cc168eaba38f`, Squash/main `6c35fad443f6ce90ba3834784ac471372c2df8ec`.
- PR-C #70 final verification/administrative closure; evidence `docs/s5/S5_FINAL_VERIFICATION.md`.
- `FR-007`, `FR-008`, `AC-03`, S5 portion of `FR-023`, S5 cancel/archive portion of `P-05`, dual approval, append-only history and no hard delete are PASS.
- D-013 was an S5-only execution exception and does not apply to later stages.

### S6 — Issue #5

- PR-A #71 final head `0b18c62cc0c8c5ab025b7473e5a23e3243babf63`, Squash/main `281ca5490f9c498d0f34a71c6081e65108e89abe`.
- PR-B #72 final head `fdbd7f0fe21409849ad98a161aac4a3dde72bf8b`, Squash/main `0de57ef07f015506c0ef9afa9956413916743442`.
- PR-C #73 final verification/administrative closure; evidence `docs/s6/S6_FINAL_VERIFICATION.md`; final S6 main `12a4520ea62e8fb32cd33519bf4b12137d43576b`.
- `FR-009`, `FR-010`, `FR-017`, `AC-02`, S6 price-change portion of `P-05`, D-009 and D-012 are PASS.
- Authoritative price is derived from approved S6 movements; legacy S4 price fields remain non-authoritative.
- S6 query budgets remain regression-protected: 200 Works list = 3 reads with max 100 bindings; 50 similar Works = 3 reads.
- `S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED` remains fail-closed.

## S7 — Issue #6 final chain

Scope: `FR-011..FR-013`, `FR-018..FR-021`, `AC-05`, `AC-06`, `P-01..P-04`, plus D-010, D-011, D-014, D-015 and D-016.

### PR-A #74 — payments / collections / governed reversals

- Final reviewed head: `c3387b772ee457bfb88d7ec3dc06090947776dd7`.
- Squash/main SHA: `1e1637451bdd1e63ad82a6782cb1fa2b010cb347`.
- Final-head CI: Foundation `31631306517` SUCCESS; S2 `31631306390` SUCCESS; S3 `31631306391` SUCCESS on retry after external download interruption.
- Implements Work-scoped irregular payments, remaining/collection truth, D-010 reversal, dual-account approval, audit/idempotency/concurrency boundaries and bounded reads.

### PR-B #75 — transfers / subscriptions / expenses / settlement core

- Final reviewed head: `d52254bafcd9dcec2dda454dbef869caee6b4117`.
- Squash/main SHA: `0eb382f7146cb1730e64a37bec1bb46876f500b8`.
- Final-head CI: Foundation `31638405137` SUCCESS; S2 `31638405056` SUCCESS; S3 `31638405045` SUCCESS.
- Targeted PR-B `15/15 PASS`; full Node `116/116 PASS`.
- D1: settlement preview 8 reads, maximum bind 71; transfer/subscription/common-expense lists 1 read each.
- Implements D-011, D-014, D-015, D-016, P-02/P-03/P-04, reopened-prior invalidation and closed-period cross-stage guards.

### PR-C #76 — business flows / Arabic RTL financial UI / integrated acceptance

- Base main: `0eb382f7146cb1730e64a37bec1bb46876f500b8`.
- Final reviewed head: `1f15df2c6605b007d32d7698f604d948b42e4a91`.
- Squash/main SHA: `7539b8289b75e3702d19d84fb29c04f20a98d0e6`.
- Final-head CI: Foundation `31641996434` SUCCESS; S2 `31641996429` SUCCESS; S3 `31641996442` SUCCESS.
- Focused PR-C `9/9 PASS`; full Node regression `125/125 PASS`.
- Integrated acceptance covers real UI + Worker/DB flows, `confirmed_at`, distinct `received_by`/`recorded_by`, payment correction, transfers, subscription month+1, close/reopen both directions, reload/history and no client per-Work N+1.
- Post-merge main verified at `7539b8289b75e3702d19d84fb29c04f20a98d0e6`.
- Post-merge Foundation `31642292225` SUCCESS.
- Post-merge S3 `31642292237` SUCCESS with all project validation steps successful.

### PR-D #77 — final verification / administrative closure

- Branch: `s7/pr-d-final-verification-closure`.
- Base main: `7539b8289b75e3702d19d84fb29c04f20a98d0e6`.
- Docs/admin only; no runtime changes, no cloud write and no S8 implementation.
- Evidence: `docs/s7/S7_FINAL_VERIFICATION.md`.
- Closure becomes effective after final-head CI + independent supervisory review + Squash merge + post-merge verification + Issue #6 close completed.

## S7 final verdict

- `FR-011 = PASS`.
- `FR-012 = PASS`.
- `FR-013 = PASS`.
- `FR-018 = PASS`.
- `FR-019 = PASS_WITH_GOVERNED_BOUNDARY` for the unresolved generic common-expense allocation rule; factual expense history is retained and settlement close fails closed when allocation is unresolved.
- `FR-020 = PASS`.
- `FR-021 = PASS`.
- `AC-05 = PASS`.
- `AC-06 = PASS`.
- `P-01 = PASS` under D-016.
- `P-02 = PASS`.
- `P-03 = PASS`.
- `P-04 = PASS`.
- `D-010 = PASS`.
- `D-011 = PASS`.
- `D-014 = PASS`.
- `D-015 = PASS`.
- `D-016 = PASS`.
- `S7_OVERPAYMENT_POLICY_UNRESOLVED = FAIL_CLOSED`.
- `S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED = FAIL_CLOSED`.
- Multi-Work allocation of one payment remains deferred and unimplemented; ordinary payment is linked to one Work.
- Exactly two subscriptions; current baseline aggregate is `13,650` halalas; names and individual values were not invented.
- `CLOUD_WRITE = NO`.
- `REAL_DATA = NO`.
- `SECRETS_ADDED = NO`.
- `STABLE_REFS_MOVED = NO`.

## Governing decisions relevant to S8

- D-006: Workers Free + Workers Static Assets + D1 Free + Firebase Auth Spark Email/Password; only two active users; no mandatory Billing/card; integer halalas and no floating-point money math.
- D-007: branch + PR, final-head CI, no direct main, no automatic stable movement.
- D-008: S3 remains administratively deferred, not complete.
- D-009..D-012 remain governing for dual approval, reversal, settlement close/reopen and rounding.
- D-014: settlement Work membership uses authoritative nullable `confirmed_at` only.
- D-015: approved receipts use `received_by`; positive final balance means person_1 owes person_2; prior balance comes from latest valid prior monthly settlement.
- D-016: subscription change/cancellation takes effect from the next settlement month; no daily prorating.

## Next stage

After PR #77 is merged, its `main` SHA is verified and Issue #6 is closed completed:

- `NEXT_STAGE = S8`.
- S8 Issue #7: **البحث والتقارير والتصدير**.
- Core scope: FR-022, FR-024, FR-025, FR-029, FR-030; AC-08, AC-09, AC-10; reverify FR-023/AC-12 archive/history behavior where S8 consumes those records.
- S8 must start from the exact final `main` SHA produced by PR #77, not from PR #76 or an S7 implementation branch.
- Only an S8 `FINAL_ACTIVATED` instruction package tied to that SHA authorizes execution.

## Permanent rules

- No direct edits to `main`; every stage/change through its own branch and PR.
- Squash merge only after final-head CI and supervisory review.
- No stage is complete before acceptance, earlier-stage regression, `PROJECT_STATE.md` update and post-merge verification.
- Never commit real customer data, passwords, tokens or service keys.
- No mandatory-cost service, Billing activation or payment card.
- Do not invent unresolved product rules; fail closed or record/defer them.
- Stage conversations stay within their Issue scope.
- General supervision reviews PRs and authorizes stage transitions.
