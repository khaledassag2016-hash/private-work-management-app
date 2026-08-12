# S7 PR-A Execution Contract — Payments, Collections, and Reversal Core

## Authority, baseline, and scope

This contract applies only to **S7 PR-A** of Issue #6 in `khaledassag2016-hash/private-work-management-app`. It starts from `S7_BASE_MAIN_SHA = 12a4520ea62e8fb32cd33519bf4b12137d43576b`. The final S6 financial authority is the approved `price_movements` read model exposed through `GET /api/works/:id/financials`, with `current_price_halalas` derived from approved movements and `pricing_source = S6_APPROVED_PRICE_MOVEMENTS`. Legacy `works.price_state` and `works.price_minor_units` are not used as current-price authority.

PR-A implements the append-only client payment ledger, one-Work payment allocation, approved-paid and remaining read models, derived collection status, and D-010 governed payment reversal. It does not implement transfers, subscriptions, generic expenses, settlements, monthly close/reopen, UI acceptance, exports, S8 reporting, direct Cloud/D1 writes, real fixtures, or any change to S6 pricing or ratio semantics. Multi-Work payment allocation remains `DEFERRED / NO_STAGE_ASSIGNED`.

## Financial representation and parsing

All internal monetary values are integer halalas. API inputs use `amount_riyals` text with at most two decimal places and are converted deterministically with `BigInt`; malformed, non-string, over-precision, and unsafe values are rejected before any database mutation. Every intermediate value is checked with `Number.isSafeInteger`. There is no `REAL`, `FLOAT`, `DOUBLE`, `parseFloat`, binary-decimal money arithmetic, or negative-money persistence in the payment ledger.

## Payment ledger semantics

Each ordinary payment belongs to exactly one `work_id`. A payment is immutable and append-only. Its immutable facts are `id`, `work_id`, `amount_halalas`, `effective_at`, `payment_method`, optional `note`, `received_by`, `recorded_by`, `created_at`, the captured `work_version`, and the unique `request_id`. `received_by` records who physically received the money; `recorded_by` and the audit actor record who entered the fact. The authenticated actor is never replaced by a caller-supplied identity.

A payment must reference the current Work version and increments `works.version` atomically with its insertion and audit row. Replaying the same `request_id` for the same Work is idempotent; reusing it for another Work fails closed. Zero payment is represented by no payment row. Payments are not editable or hard-deletable. A payment cannot be recorded when the authoritative S6 price is `PRICE_UNSET`, and a payment that would make approved net payments exceed the current approved price fails closed with `S7_OVERPAYMENT_POLICY_UNRESOLVED`.

The payment effective date is the business/payment date supplied by the caller in canonical UTC ISO format. `created_at` is the audit/system-recorded time and is never substituted for the effective date. PR-A does not implement settlement-period or closed-period guards; those remain a PR-B activation concern.

## Approved paid, remaining, and collection read model

The authoritative approved paid total is:

```text
approved_paid = SUM(all ordinary payment amounts) - SUM(all approved reversal amounts)
```

Pending reversal requests have no financial effect. The remaining amount is:

```text
remaining = current approved S6 price - approved_paid
```

When there are no S7 payment rows, the compatibility field `remaining_projection` remains `PRE_S7_APPROVED_PAYMENTS_ZERO`. Once a payment row exists, it becomes `S7_APPROVED_PAYMENTS_LEDGER`. `PRICE_UNSET` produces no monetary remaining (`null`). An approved zero-price Work remains a valid zero-price financial truth without a fake payment entry.

Collection status is derived and not user-editable. The PR-A taxonomy is `PRICE_UNSET`, `UNPAID`, `PARTIALLY_COLLECTED`, `FINANCIALLY_CLOSED`, and `OVERPAYMENT_UNRESOLVED`. Collection status is separate from execution status; no payment mutation changes `works.status`.

## D-010 reversal state machine

A reversal request references one original payment and preserves the original forever. It records the reason, requester, request timestamp, captured Work version, and unique request identity. A pending request is visible but has no financial effect. The requester is the first approval; only the other active account can approve. Self-approval, third-account approval, stale versions, request/Work/payment mismatch, duplicate finalization, and concurrent duplicate approval fail closed with zero partial financial side effects.

Approval atomically increments the Work version, finalizes the request, creates exactly one append-only reversal row for the original payment amount, and writes audit rows for the request update and reversal creation. The approved reversal subtracts the original amount from approved net payments. A corrected payment, if needed, is a new payment fact; the original and its reversal are never overwritten. Partial reversal semantics are not implemented.

## API contract and SPA compatibility

All routes use the existing authenticated Worker path and existing `{ok, data, requestId}` success envelope or `{ok:false, code, requestId}` error envelope. The existing SPA `api()` wrapper remains the only client API wrapper. PR-A routes are:

| Route | Purpose |
|---|---|
| `GET /api/works/:id/financials` | S6 price/share truth plus S7 approved-paid, remaining, collection status, payment totals, and payment history |
| `GET /api/works/:id/payments` | One-Work immutable payment history with pending/approved reversal state |
| `POST /api/works/:id/payments` | Record one ordinary payment |
| `GET /api/works/:id/payment-reversal-requests` | Read reversal requests and their approved reversal, if any |
| `POST /api/works/:id/payment-reversal-requests` | Request a governed reversal |
| `POST /api/works/:id/payment-reversal-requests/:requestId/approve` | Other-account approval of a pending reversal |

A successful write proves server persistence only. A future UI must refetch authoritative financials and history before displaying verified financial success; a failed refetch must be reported as a split outcome rather than optimistic success. PR-A does not claim UI behavior.

## Migration and audit compatibility

Migration `0007_s7_payments_collections_reversals.sql` is additive from the final S6 schema. It rebuilds `audit_log` only to extend the checked `entity_type` set, copies all existing rows field-for-field, recreates indexes and append-only triggers, reinstalls audit-probe triggers, then creates the three S7 payment/reversal tables and their append-only constraints. The fresh `schema.sql` contains the same final state. The source and packaged Worker mirrors must remain byte-identical for the worker files listed by `package-manifest.json`.

## Query-budget policy

PR-A financial reads use fixed or bounded queries. `getWorkFinancials` uses a fixed number of reads for the Work, approved S6 price history, request/history reads, ratio history, and one joined payment/reversal read; it never issues one query per payment or reversal. Payment history and reversal-request history each use one bounded joined read for one Work. No `Promise.all` fan-out by returned row is permitted.

The S7 internal D1 read budget is at most 40 queries per Worker invocation, with a maximum of 100 bound parameters per individual query. Query-budget tests reset the counter immediately before the read, exclude fixture construction, use enough rows to expose row-wise growth, and report the measured count. A PASS without measured query evidence is invalid.

## Requirement and risk traceability

| Requirement or risk | Test file and exact test | Required assertions and layer |
|---|---|---|
| Integer money and deterministic parsing | `tests/node/s7_pr_a_payments.test.mjs` — `S7 money parsing rejects malformed, over-precision, and unsafe amounts before mutation` | Domain: exact halalas, rejection, zero database mutation |
| One Work and multiple payments | `s7_pr_a_payments.test.mjs` — `S7 records irregular payments for one Work and reaches zero` | Domain: immutable rows, accumulated approved paid, exact remaining zero |
| Zero and partial payment / AC-06 | `s7_pr_a_payments.test.mjs` — `S7 zero and partial collection stay separate from execution` | Domain: unpaid/partial descriptors, unchanged execution status |
| S6 price authority | `s7_pr_a_payments.test.mjs` — `S7 consumes approved S6 current price` | Domain: approved `price_movements` value used; legacy sentinel ignored |
| D-010 both directions | `s7_pr_a_payments.test.mjs` — `S7 reversal requires other-account approval in both directions` | Domain: U1→U2 and U2→U1, self-approval rejection, pending no effect |
| Reversal replay/stale/mismatch | `s7_pr_a_payments.test.mjs` — `S7 reversal races and stale mismatches fail closed` | Domain: exactly one reversal, no duplicate audit, zero side effects on reject |
| Append-only and migration | `s7_pr_a_payments.test.mjs` — `S7 migration preserves S6 rows and payment audit guards` | Migration: historical rows, trigger/index validity, update/delete rejection |
| API/SPA envelope | `s7_pr_a_payments.test.mjs` — `S7 API exposes payment and reversal envelopes` | Worker HTTP: `{ok,data,requestId}` and normalized errors |
| No N+1 | `s7_pr_a_query_budget.test.mjs` — `S7 financial reads remain bounded with large payment fixtures` | Instrumented D1: fixed count, reset immediately before read, no row-wise growth |

## Explicit unresolved boundaries

`S7_OVERPAYMENT_POLICY_UNRESOLVED` remains fail-closed for the overpayment edge and does not block unrelated valid payment/reversal work. The collection taxonomy is derived rather than persisted. Settlement period basis, final settlement balance formula, generic shared-expense allocation, transfer correction, closed-period cross-stage guard, and all PR-B/PR-C behavior are intentionally not resolved or implemented in PR-A.

**PR-A stop condition:** after the two self-reviews, focused tests, full regression, source/package parity, security/payload checks, and final-head CI, open the Draft PR and stop. Do not merge, close Issue #6, start PR-B, start PR-C, or start S8.
