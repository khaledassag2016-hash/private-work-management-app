# S7 PR-B Execution Contract

## Authority and baseline

This contract governs **S7 PR-B** on Issue #6. The branch starts from `MERGED_MAIN_SHA = 1e1637451bdd1e63ad82a6782cb1fa2b010cb347`, which includes the supervisory merge of PR-A. PR-B does not modify PR-A behavior and does not implement PR-C, UI acceptance, exports, S8 reporting, or multi-Work payment allocation.

The final S6 price and ratio read models remain authoritative. PR-B consumes those outputs and never rewrites S6 price history or independently substitutes legacy Work pricing fields.

## PR-B scope

PR-B implements append-only inter-party transfers, authoritative `confirmed_at` Work membership, effective-dated subscription aggregate history, governed expense facts without invented generic allocation, bounded settlement preview/close and D-011 reopen paths, D-014/D-015 objective accounting components, audit history, and closed-period guards. All money is integer halalas and all mutations are authenticated, audited, request-correlated, and append-only where they represent business evidence.

## Activated rules

| Rule | Contract |
|---|---|
| Transfer direction | `from_party` and `to_party` are explicit, distinct active accounts; direction is never inferred from fee payer. |
| Transfer fee | `fee_halalas` is stored separately. Person 1 is the physical fee payer under P-03; each party bears one rounded half. |
| Subscription baseline | P-01 aggregate baseline is `13,650` halalas for `subscription_count = 2` until a governed change is effective; individual names and item amounts remain unknown. |
| Subscription changes | Under D-016, a change or cancellation recorded during month M becomes effective for settlement month M+1, with no daily prorating. Prior closed snapshots remain immutable. |
| Subscription burden | Person 2 remains the physical payer fact; P-02 contributes one rounded half of the effective aggregate subscription cost to the D-015 final balance. |
| Expense boundary | Expense facts may be recorded and audited. No generic expense is automatically allocated unless an explicit governed allocation is supplied. |
| Rounding | D-012 nearest halala; exact 0.5 half-up, independently at each P-02/P-03 effect. |
| Evidence | No hard delete or update of a transfer, subscription history row, expense, settlement snapshot, or close/reopen history. |

## Explicit unresolved activation boundaries

D-014, D-015, and D-016 resolve the prior settlement placeholders:

1. Settlement Work membership is `confirmed_at >= period_start AND confirmed_at < period_end`; Work with `confirmed_at = NULL` is excluded. No `created_at`, price date, or inferred status timestamp is substituted.
2. Preview exposes objective Work shares, approved receipts split by `received_by` role, transfer direction/amount/fee, effective subscription history, and expense facts. Caller-supplied `period_basis`, `balance_formula`, or `prior_balance_riyals` cannot authorize or alter financial truth.
3. `prior_balance_halalas` is zero when no valid prior closed monthly settlement exists; otherwise it is the latest valid prior snapshot final balance. `final_balance_halalas > 0` means person 1 owes person 2, and the D-015 identity includes only person-2 receipts, signed transfers, half subscription cost, and half transfer fees once.
4. D-016 applies a subscription aggregate change/cancellation recorded in month M to month M+1; P-01 baseline remains 13,650 halalas until then, with no daily prorating or invented individual detail.
5. Generic expense allocation remains `S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED`; expense facts are preserved and `closeSettlement` remains fail-closed while any generic expense is present.
6. Closed-period guards cover Work creation/update including both old and new confirmation months, S6 price/ratio request and approval mutations, client payments, reversal requests/approvals, transfers, subscriptions, and expenses. D-011 ordinary re-close remains rejected unless an approved reopen exists; snapshots remain append-only.

This is an explicit fail-closed boundary, not a product-rule invention.

## Required PR-B APIs

| Route | Purpose |
|---|---|
| `GET /api/transfers` | Bounded transfer history for a period. |
| `POST /api/transfers` | Append one explicit inter-party transfer. |
| `GET /api/subscriptions` | Effective aggregate subscription history. |
| `POST /api/subscriptions` | Append a prospective aggregate subscription value. |
| `GET /api/expenses` | Bounded expense facts for a period. |
| `POST /api/expenses` | Append one expense fact without automatic generic allocation. |
| `GET /api/settlements/preview` | Bounded component preview with explicit unresolved tokens. |
| `POST /api/settlements/:periodKey/close` | Persist an auditable snapshot only when all required rules are resolved. |
| `POST /api/settlements/:periodKey/reopen-requests` | Request exceptional D-011 reopen. |
| `POST /api/settlements/:periodKey/reopen-requests/:requestId/approve` | Other-account approval of a pending reopen. |

All routes use the existing authenticated Worker envelope `{ok,data,requestId}` or `{ok:false,code,requestId}`.

## D-011 closed-period guard

A closed period is immutable under ordinary mutations. Work changes, S6 price/ratio requests and approvals, new or backdated payments, reversal requests/approvals, transfers, prospective subscription changes, and governed expense facts whose effective date targets a closed period must fail closed. Reopen is a two-account, reasoned, append-only governed flow; pending reopen has no financial effect, self-approval is rejected, and concurrent approval may produce only one successful reopen with exactly one history row and one approval audit.

## Query-budget policy

Every PR-B list/read path uses fixed or bounded SQL. Settlement preview uses bulk Work/price/ratio reads and grouped child reads rather than one query per Work. Tests reset the D1 counter immediately before each read, use representative large fixtures, record actual query counts and maximum bind widths, and stay below the internal 40-query / 100-bind limits.

## Exact PR-B test traceability

The PR-B test file will contain exact test names for transfers, P-02/P-03, subscriptions, expenses, settlement components, D-011 close/reopen, closed-period guards, migration/audit preservation, and measured D1 budgets. This table is extended in the same commit as the tests; no test title alone is treated as evidence.

## Non-scope and handoff

`PR_MERGED = NO`, `PR-C = NOT_STARTED`, and `S8 = NOT_STARTED` are mandatory at handoff. The Draft PR remains open for supervisory review and is never merged by this implementation workflow.

## Exact PR-B test traceability

The exact mandatory PR-B tests are:

| Requirement | Exact test name |
|---|---|
| Transfers / direction / fee separation | `PR-B transfers preserve explicit direction and P-03 fee separation` |
| P-01 / P-02 subscriptions | `PR-B subscriptions preserve P-01 13650 baseline and prospective P-02 burden` |
| Generic expenses | `PR-B generic expenses preserve facts and fail closed on invented allocation` |
| Settlement components / S6 authority / D-012 | `PR-B settlement components consume S6 price authority, receipts, transfers, subscriptions, and D-012 rounding` |
| D-011 close/reopen / both directions | `PR-B D-011 soft-close and reopen require dual approval in both directions and preserve history` |
| D-011 sequential re-close governance | `PR-B D-011 re-close rejects sequentially and only an approved reopen can clear the state gate` |
| D-011 concurrent approval atomicity | `PR-B D-011 concurrent reopen approvals yield one transition, one history row, one audit, and zero loser side effects` |
| P-01 effective-dated boundary | `PR-B P-01 effective-dated history is reported without retroactive full-period aggregation` |
| Closed-period cross-stage coverage | `PR-B closed-period cross-stage mutations are blocked across Work, S6 approvals, payments, reversals, and PR-B facts` |
| Migration preservation / audit guards | `PR-B migration preservation retains PR-A/S6 rows and installs append-only transfer and settlement audit guards` |
| D1 query and bind budgets | `PR-B D1 query and bind budgets remain bounded for large settlement and child histories` |

The D1 test emits `S7_PR_B_D1_MEASUREMENT` lines with the measured settlement query count, maximum bind width, and bounded child-list query counts. Test names are traceability only; the assertions and measurements are the evidence.
