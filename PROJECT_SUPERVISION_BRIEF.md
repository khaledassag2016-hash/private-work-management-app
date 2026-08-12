# PROJECT_SUPERVISION_BRIEF

> Operational supervisory handoff. This file does not replace the governing Word requirements or dated decisions.

## 1. Governing order

1. `docs/APPROVED_REQUIREMENTS.docx` — SHA-256 `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`, size 63710 bytes.
2. `docs/DECISION_LOG.md`.
3. `PROJECT_STATE.md`.
4. `docs/TRACEABILITY_MATRIX.md`.
5. Current stage Issue, execution contract and PR evidence.

Never substitute conversation memory, an agent report or `docs/REQUIREMENTS.md` for the governing Word file.

## 2. Current stage state

- `S1 = CLOSED_COMPLETE`.
- `S2 = CLOSED_COMPLETE`.
- `S3 = CLOSED_BLOCKED_DEFERRED` under D-008; not S3 COMPLETE.
- `S4 = CLOSED_COMPLETE`.
- `S5 = CLOSED_COMPLETE`.
- `S6 = CLOSED_COMPLETE`.
- `S7 = CLOSED_COMPLETE` after PR #77 final-head CI, Squash merge, post-merge verification and Issue #6 closure.
- `S8 = AUTHORIZED_NOT_STARTED` after the same S7 closure condition.
- `S9..S11 = NOT_STARTED`.

## 3. S5/S6 evidence retained

S5: PR #68/#69 implementation and PR #70 final verification. Work events, title/status history, cancel/archive dual approval, no hard delete and execution/collection separation remain regression-protected. Evidence: `docs/s5/S5_FINAL_VERIFICATION.md`.

S6: PR #71/#72 implementation and PR #73 final verification. Authoritative pricing movements, 30/70 plus dual-approved exceptions, D-012 rounding and bounded D1 list/similar reads remain regression-protected. Final S6 main before S7: `12a4520ea62e8fb32cd33519bf4b12137d43576b`. Evidence: `docs/s6/S6_FINAL_VERIFICATION.md`.

The unresolved S6 negative-final-price policy remains fail-closed.

## 4. S7 final evidence chain

### PR-A #74 — Payments / Collections / Reversals

- Final head `c3387b772ee457bfb88d7ec3dc06090947776dd7`.
- Squash/main `1e1637451bdd1e63ad82a6782cb1fa2b010cb347`.
- Final-head CI: Foundation `31631306517`, S2 `31631306390`, S3 `31631306391` SUCCESS.
- D-010 reversal is append-only, two-account approved and original payment remains immutable.

### PR-B #75 — Transfers / Subscriptions / Expenses / Settlement Core

- Final head `d52254bafcd9dcec2dda454dbef869caee6b4117`.
- Squash/main `0eb382f7146cb1730e64a37bec1bb46876f500b8`.
- Final-head CI: Foundation `31638405137`, S2 `31638405056`, S3 `31638405045` SUCCESS.
- Node `116/116`; PR-B focused `15/15`.
- D1 measurement: settlement `8` reads, max bind `71`; transfer/subscription/common-expense lists `1` each.
- D-011, D-014, D-015 and D-016 implemented with closed-period guards and immutable history.

### PR-C #76 — Financial UI / Business Flows / Integrated Acceptance

- Base `0eb382f7146cb1730e64a37bec1bb46876f500b8`.
- Final head `1f15df2c6605b007d32d7698f604d948b42e4a91`.
- Squash/main `7539b8289b75e3702d19d84fb29c04f20a98d0e6`.
- Final-head CI: Foundation `31641996434`, S2 `31641996429`, S3 `31641996442` SUCCESS.
- Focused acceptance `9/9`; full Node `125/125`.
- Final repair proved `confirmed_at`, distinct `received_by` / `recorded_by`, real Worker/DB flows, both reopen approval directions, history reload and no client per-Work N+1.
- Post-merge Foundation `31642292225` SUCCESS.
- Post-merge S3 `31642292237` SUCCESS with all validation steps successful.

### PR-D #77 — Final Verification / Administrative Closure

- Branch `s7/pr-d-final-verification-closure`.
- Base `7539b8289b75e3702d19d84fb29c04f20a98d0e6`.
- Docs/admin only. No runtime, no cloud write, no S8 implementation.
- Evidence `docs/s7/S7_FINAL_VERIFICATION.md`.
- After final-head CI, Squash merge and post-merge verification, close Issue #6 as completed and activate S8 from the exact resulting `main` SHA.

## 5. S7 authoritative behavior inherited by later stages

- Ordinary payment belongs to exactly one Work.
- Payment correction/cancellation uses D-010 reversal; original facts are not rewritten or deleted.
- Work settlement membership uses nullable authoritative `confirmed_at` only; unconfirmed Work is outside monthly settlement.
- Approved receipts affect settlement according to actual `received_by`; `recorded_by` remains separately auditable.
- `final_balance_halalas > 0` means person_1 owes person_2; negative means the reverse.
- Prior balance is the latest valid prior monthly settlement final balance; reopened prior snapshots are invalid until reclosed.
- Monthly close is soft; exceptional reopen requires the other account under D-011.
- Exactly two subscriptions; current baseline aggregate 13,650 halalas. Do not invent names or individual amounts.
- Subscription changes/cancellation recorded in month M affect settlement month M+1; no daily prorating.
- P-02: person_2 pays subscriptions, shared half/half.
- P-03: person_1 pays transfer fees, shared half/half.
- P-04: Work ratio is applied to authoritative current Work price before shared subscription/fee/expense settlement effects.
- Generic shared-expense allocation without an approved rule stays fail-closed for settlement closing.
- Overpayment beyond remaining stays `S7_OVERPAYMENT_POLICY_UNRESOLVED` fail-closed.

## 6. Architecture and zero-cost constraints

- API: Cloudflare Workers Free.
- Static UI: Cloudflare Workers Static Assets.
- Database: Cloudflare D1 Free via internal binding.
- Authentication: Firebase Auth Spark, Email/Password, two supervisor-created accounts only.
- Private APIs fail closed; browser never connects directly to D1.
- No mandatory Billing, card, PayGo or paid service.
- Money is integer halalas within the JavaScript safe-integer range; no floating-point financial math.
- No Cloud writes are authorized merely by starting a software stage.

## 7. Permanent delivery rules

- Never edit `main` directly.
- Independent branch + PR for every stage/change.
- Final-head CI is required; Squash merge only.
- A stage is not complete until acceptance, prior-stage regression, `PROJECT_STATE.md` update and post-merge verification.
- Never commit real customer data, passwords, tokens or service keys.
- Do not invent unresolved product policy; fail closed, defer or request a governing decision.
- Stable refs never move automatically.
- Manus and any other coding agent must not push concurrently to the same PR.
- Avoid repeated supervisory stop loops: executor self-repairs within one PR; supervision performs one consolidated final review, at most one consolidated repair batch for discovered defects, then targeted recheck + full regression + final-head CI and immediate merge if clean.

## 8. S8 activation boundary

Issue #7 is `[S8] البحث والتقارير والتصدير`.

Core S8 scope:

- FR-022 — Work search/filter.
- FR-024 — Excel export for defined scopes.
- FR-025 — organized Arabic RTL Excel.
- FR-029 — configurable age-based alerts for no price/no reply/no payment.
- FR-030 — statistics by type/specialty/country/university/period.
- AC-08, AC-09, AC-10.
- Reverify FR-023/AC-12 archive/history visibility when S8 search/analytics consume archived records.

S8 must not start from PR #76 or any S7 branch. It starts only from the exact `main` SHA produced by PR #77 after S7 closure. Execution is authorized only by the S8 `FINAL_ACTIVATED` package tied to that SHA.

S8 must consume authoritative S6/S7 financial facts; historical/supporting price data may support classification but must not become the sole classifier. Search must include current and old titles and archived history where required. Excel verification must be structural and automated; no manual user QA is required when objective automation is possible.

## 9. Stable refs

- `stable/2026-08-09-be14a389` -> `be14a389d7e11f1df9f935999d888e7e2295c8a3`.
- `stable/2026-08-09-643de962` -> `643de962dc8631f68a42e3796c4a096a29c4e14c`.

Do not move them without a separate explicit stable-promotion decision.
