# S7 PR-B Execution Contract

## Authority and baseline

This contract governs **S7 PR-B** on Issue #6. The branch starts from `MERGED_MAIN_SHA = 1e1637451bdd1e63ad82a6782cb1fa2b010cb347`, which includes the supervisory merge of PR-A. PR-B does not modify PR-A behavior and does not implement PR-C, UI acceptance, exports, S8 reporting, or multi-Work payment allocation.

The final S6 price and ratio read models remain authoritative. PR-B consumes those outputs and never rewrites S6 price history or independently substitutes legacy Work pricing fields.

## PR-B scope

PR-B implements append-only inter-party transfers, effective-dated subscription aggregate history, governed expense facts without invented generic allocation, bounded settlement component preview and D-011 reopen paths, objective P-02/P-03 components, unresolved prior-balance authority, audit history, and closed-period guards. All money is integer halalas and all mutations are authenticated, audited, request-correlated, and append-only where they represent business evidence.

## Activated rules

| Rule | Contract |
|---|---|
| Transfer direction | `from_party` and `to_party` are explicit, distinct active accounts; direction is never inferred from fee payer. |
| Transfer fee | `fee_halalas` is stored separately. Person 1 is the physical fee payer under P-03; each party bears one rounded half. |
| Subscription history | Aggregate rows preserve `subscription_count = 2`, amount, `effective_at`, state, and P-02 physical payer evidence. No `13,650` baseline or within-period amount is applied without an approved effective-date rule. |
| Subscription changes | History is append-only and effective-dated. A period containing subscription history exposes that history but remains unresolved rather than applying the latest row retroactively or to the whole month. |
| Subscription burden | Person 2 remains the physical payer fact; no P-02 amount is applied to a settlement while the effective-date/allocation rule is unresolved. |
| Expense boundary | Expense facts may be recorded and audited. No generic expense is automatically allocated unless an explicit governed allocation is supplied. |
| Rounding | D-012 nearest halala; exact 0.5 half-up, independently at each P-02/P-03 effect. |
| Evidence | No hard delete or update of a transfer, subscription history row, expense, settlement snapshot, or close/reopen history. |

## Explicit unresolved activation boundaries

The governing sources still do not identify a single Work-period basis among the available Work dates, and do not state whether client receipts are cash-basis or a separately reported metric in the final balance. PR-B must not silently invent either rule.

Therefore:

1. Preview exposes objective Work shares, approved receipts, transfer direction/amount/fee, expense facts, and the full effective-dated subscription history. It never treats caller-supplied `period_basis` or `balance_formula` strings as authorization; both remain `null` and unresolved until a governing decision exists.
2. `prior_balance_riyals` is not financial truth supplied by the client. Preview reports `prior_balance_halalas = null` and `prior_balance_authority = UNRESOLVED_AUTHORITATIVE_SETTLEMENT_CHAIN` until an authoritative prior-settlement chain and governing formula exist.
3. A period containing subscription history remains unresolved under `S7_SUBSCRIPTION_EFFECTIVE_DATE_RULE_UNRESOLVED`; no last-row or full-month aggregation is invented, and a subscription effective date is never applied retroactively.
4. Generic expense allocation remains `S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED`; expense facts are preserved but do not alter final balances automatically.
5. `closeSettlement` fails closed for unresolved period basis, final-balance formula, subscription effective-date semantics, or generic expense allocation. A currently `CLOSED` period rejects ordinary re-close; only an approved D-011 reopen clears the state gate, after which unresolved rules still prevent close.
6. Closed-period guards cover Work creation/update, S6 price/ratio request and approval mutations, client payments, reversal requests/approvals, transfers, subscriptions, and expenses.

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
