# مصفوفة تتبع المتطلبات

إجمالي التغطية المطلوبة: **30/30 FR، 14/14 AC، 7/7 P، 14/14 سيناريو**.

أدلة الإقفال الحالية: S5 `docs/s5/S5_FINAL_VERIFICATION.md`، S6 `docs/s6/S6_FINAL_VERIFICATION.md`، S7 `docs/s7/S7_FINAL_VERIFICATION.md`، S8 `docs/s8/S8_FINAL_VERIFICATION.md`، S9 `docs/s9/S9_FINAL_VERIFICATION.md`.

| المعرف | النوع | المرحلة المسؤولة | طريقة التحقق | الحالة |
| --- | --- | --- | --- | --- |
| FR-001 | متطلب وظيفي | S4 | Customer CRUD، أعمال العميل، history وaudit في PR #59 | PASS — S4 |
| FR-002 | متطلب وظيفي | S4 | AC-04: عدة أعمال مستقلة للعميل نفسه | PASS — S4 |
| FR-003 | متطلب وظيفي | S4 | Work بلا سعر كـ `PRICE_UNSET` مع متابعة | PASS — S4 |
| FR-004 | متطلب وظيفي | S4 | independent/child + parent negative tests | PASS — S4 |
| FR-005 | متطلب وظيفي | S4 | حقول Work الأساسية في UI/API | PASS — S4 |
| FR-006 | متطلب وظيفي | S4 | soft warnings للحقول المتاحة وعدم اختراع taxonomy للعناوين العامة | PASS ضمن قاعدة S4؛ generic-title semantics غير مخترعة |
| FR-007 | متطلب وظيفي | S5 | `s5_pr_a_domain_data_api.test.mjs` + `s5_pr_b_ui_flows.test.mjs` | PASS — S5 |
| FR-008 | متطلب وظيفي | S5 | title A→B→C/history + reason + status history | PASS — S5 |
| FR-009 | متطلب وظيفي | S6 | `s6_pr_a_financial_core.test.mjs` + UI acceptance | PASS — S6 |
| FR-010 | متطلب وظيفي | S6 | authoritative S6 price/shares/read model + D-012 | PASS — S6 |
| FR-011 | متطلب وظيفي | S7 | `s7_pr_a_payments.test.mjs` + integrated `s7_pr_c_ui_acceptance.test.mjs` | **PASS — S7 PR #74/#76** |
| FR-012 | متطلب وظيفي | S7 | authoritative paid/remaining/collection + post-mutation refetch | **PASS — S7 PR #74/#76** |
| FR-013 | متطلب وظيفي | S7 | zero/partial/full collection and execution/collection separation | **PASS — S7 PR #74/#76** |
| FR-014 | متطلب وظيفي | S4 | documented fact -> warning projection | PASS — S4 |
| FR-015 | متطلب وظيفي | S4 | pre-agreement warning/history context | PASS — S4 |
| FR-016 | متطلب وظيفي | S4 | similar-work boundary; S6 authoritative price integration retained | PASS — S4/S6 integration |
| FR-017 | متطلب وظيفي | S6 | default 30/70 + D-009 dual-approved exception | PASS — S6 |
| FR-018 | متطلب وظيفي | S7 | transfer ledger, fees/dates, P-03 + UI authoritative refetch | **PASS — S7 PR #75/#76** |
| FR-019 | متطلب وظيفي | S7 | subscription/expense factual ledgers + payer/history; unresolved generic allocation fails closed | **PASS_WITH_GOVERNED_BOUNDARY — S7 PR #75/#76** |
| FR-020 | متطلب وظيفي | S7 | monthly preview/close/reopen, D-011/D-014/D-015/D-016, prior/final balance | **PASS — S7 PR #75/#76** |
| FR-021 | متطلب وظيفي | S7 | monthly work count, total financial value, cumulative work count | **PASS — S7 PR #75/#76** |
| FR-022 | متطلب وظيفي | S8 | search/filter current/old title, customer, classifications, explicit period basis, execution/collection states + deterministic pagination | **PASS — S8 PR #78/#80** |
| FR-023 | متطلب وظيفي | S5 | no hard delete/archive retention; S8 reverify historical search/analytics visibility | **PASS — S5 + S8 REVERIFY PR #80** |
| FR-024 | متطلب وظيفي | S8 | authoritative DTO + real XLSX exports for Work/month/follow-up/customer/classification | **PASS — S8 PR #79/#80** |
| FR-025 | متطلب وظيفي | S8 | Arabic RTL real XLSX structural/OOXML verification | **PASS — S8 PR #79/#80** |
| FR-026 | متطلب وظيفي | S3 | audit identity/time scope | مخطط ضمن S3 deferred state |
| FR-027 | متطلب وظيفي | S2 | schema excludes file/blob/attachment storage | PASS — S2 portion |
| FR-028 | متطلب وظيفي | S4 | runtime catalog value addition/use | PASS — S4 |
| FR-029 | متطلب وظيفي | S8 | configurable NO_PRICE/NO_REPLY/NO_PAYMENT alerts with D-017 authoritative anchors and no default thresholds | **PASS — S8 PR #80 / D-017** |
| FR-030 | متطلب وظيفي | S8 | statistics by type/specialty/country/university/explicit period basis | **PASS — S8 PR #79/#80** |
| AC-01 | معيار قبول | S4 | Work بلا سعر يبقى محفوظًا للمتابعة | PASS — S4 |
| AC-02 | معيار قبول | S6 | 1500 + adjustments + history + recalculation | PASS — S6 |
| AC-03 | معيار قبول | S5 | A→B→C with retained title history | PASS — S5 |
| AC-04 | معيار قبول | S4 | multiple independent Works for one customer | PASS — S4 |
| AC-05 | معيار قبول | S7 | irregular installments to exact remaining zero + UI/refetch | **PASS — S7** |
| AC-06 | معيار قبول | S7 | completed execution remains independent from unpaid/partial collection | **PASS — S7** |
| AC-07 | معيار قبول | S4 | documented payment-risk history before new agreement | PASS — S4 |
| AC-08 | معيار قبول | S8 | current/old title search finds retained same Work including explicit archived history | **PASS — S8 PR #78/#80** |
| AC-09 | معيار قبول | S8 | Arabic RTL organized real Excel for month/Work/follow-up plus customer/classification | **PASS — S8 PR #79/#80** |
| AC-10 | معيار قبول | S8 | statistics by type/specialty/country/university/period | **PASS — S8 PR #79/#80** |
| AC-11 | معيار قبول | S3 | actor/time audit visibility | مخطط ضمن S3 deferred state |
| AC-12 | معيار قبول | S5 | archive retains record/history; S8 search/analytics historical inclusion and active exclusion reverified | **PASS — S5 + S8 REVERIFY PR #80** |
| AC-13 | معيار قبول | S4 | catalog additions without source change | PASS — S4 |
| AC-14 | معيار قبول | S11 | historical unconfirmed numbers excluded from current balance | مخطط لـS11 |
| P-01 | قرار معتمد | S7 | two subscriptions, baseline aggregate 13,650 halalas; D-016 month+1 effect; no invented individual split | **PASS — S7** |
| P-02 | قرار معتمد | S7 | person_2 pays subscriptions; cost shared half/half | **PASS — S7** |
| P-03 | قرار معتمد | S7 | person_1 pays transfer fee; cost shared half/half | **PASS — S7** |
| P-04 | قرار معتمد | S7 | Work ratio applied to authoritative current Work price before shared settlement effects | **PASS — S7** |
| P-05 | قرار معتمد | S5/S6 | cancel/archive dual approval in S5; price-change dual approval in S6 | PASS — S5/S6 portions |
| P-06 | قرار معتمد | S4 | customer identity/metadata/works/history/warnings; S7 financial dealings available through linked Works | PASS — S4 boundary; S7 finance integration present |
| P-07 | قرار معتمد | S11 | historical import governance | مخطط لـS11 |
| S-01 | سيناريو | S6 | base 1500 +200 +100 = 1800 with movement history | PASS — S6 |
| S-02 | سيناريو | S5/S6 | title history + price movement previous/new/reason/time | PASS — S5/S6 |
| S-03 | سيناريو | S4/S5 | parent/child + events/title/status/archive timeline | PASS — S4/S5 |
| S-04 | سيناريو | S4 | Work UI/API and relation negatives | PASS — S4 |
| S-05 | سيناريو | S4/S8 | PRICE_UNSET follow-up plus D-017 configurable S8 alerts | **PASS — S4 + S8** |
| S-06 | سيناريو | S5 | governed cancel before execution with retained history | PASS — S5 |
| S-07 | سيناريو | S5/S7 | governed partial-stop history + S7 zero-payment/remaining behavior | **PASS for assigned S5/S7 portions** |
| S-08 | سيناريو | S7 | 1700 minus 1000 = 700 remaining | **PASS — S7** |
| S-09 | سيناريو | S7 | spaced installments until remaining reaches zero | **PASS — S7** |
| S-10 | سيناريو | S6 | discount/decrease history and negative-final-price fail-closed edge | PASS — S6 |
| S-11 | سيناريو | S5/S6 | event/history boundary + S6 integer-price movement/zero-price behavior | PASS — S5/S6 |
| S-12 | سيناريو | S4 | multiple Works acceptance | PASS — S4 |
| S-13 | سيناريو | S4 | warning from documented fact/source | PASS — S4 |
| S-14 | سيناريو | S4/S11 | PRICE_UNSET/PRICE_ZERO distinction; historical import remains S11 | S4 portion PASS؛ S11 remaining |

## S7 final performance / free-tier acceptance

- PR-B final measurement: settlement preview `8` D1 read queries, maximum bind width `71`; transfer list `1`; subscription list `1`; common-expense list `1`.
- PR-C financial workspace uses `7` fixed API reads with no per-Work client N+1.
- Full Node regression on PR-C final head: `125/125 PASS`.
- Final-head CI on PR #76: Foundation `31641996434`, S2 `31641996429`, S3 `31641996442` — SUCCESS.
- Post-merge main `7539b8289b75e3702d19d84fb29c04f20a98d0e6`: Foundation `31642292225` SUCCESS; S3 `31642292237` SUCCESS.

## S8 final performance / free-tier acceptance

- PR-A search and alerts remain bounded and avoid per-Work N+1.
- PR-B analytics: `1` D1 read query, max bind `2`; month export `2` queries/max bind `3`; customer export query count remains bounded and PR-C proves complete totals after pagination repair.
- PR-C authenticated harness: maximum customer export `5` D1 queries; max bind width `9`; no Cloud writes.
- Real XLSX all five export types PASS with local vendored SheetJS `0.20.3`, no CDN/runtime paid dependency.
- Full Node regression on final PR-C head: `140/140 PASS`.
- Final-head CI PR #80: Foundation `31695541782`, S2 `31695541807`, S3 `31695541798` — SUCCESS.
- Post-merge main `19856a4b8a31b9e756406ccda0f16ac169af236d`: Foundation `31695925778` SUCCESS; S3 `31695925794` SUCCESS.
- D-017 alerts use authoritative server-side anchors, configurable thresholds with no defaults, and no client-controlled clock.

## S9 final UX / acceptance evidence

- PR #82 base main `5808415e2f5f8710beaacf3dc0496d3645f70d77`.
- Codex final handoff head `ec759af7474336f3b358d0e6a0c263e91e0a498d` then branch writes stopped.
- Manus final reviewed/repaired head `0eeb902068dc6b411ce3780d96998578ed5dac3e` then branch writes stopped.
- D-019 sequential ownership satisfied; no concurrent Codex/Manus writes and no return to Codex.
- Manus repair restored New Work modal focus to its invoker in both mirrored assets and added deterministic regression coverage.
- Playwright Level A `10 PASS`; Level B `34 PASS + 6 intentional non-applicable skips`.
- Final-head CI: S9 UX Acceptance `31709356193`, S3 `31709356421`, S2 `31709356846` — SUCCESS.
- Full Node regression `140 PASS`, `0 failed`; Foundation local final-head validation PASS; secret scan and payload/source-runtime parity PASS.
- Responsive RTL, keyboard/focus, touch targets, automated accessibility, sensitive confirmations, duplicate-submit protection, error recovery/state clarity and mobile/desktop A–M function parity = PASS.
- PR #82 Squash/main `7a19bcdd0c85838a6c5e764e86b1a51e76fde0b7`; post-merge S3 `31710108330` SUCCESS.
- S9 did not alter business/financial semantics, schema/migrations, Cloud resources, real customer data or stable refs.

## S10 inherited verification obligations

- Re-test the integrated system against AC-01..AC-14 as a reproducible status matrix without silently pulling S3-deferred or S11-assigned implementation into S10.
- AC-11 remains assigned to S3/FR-026 deferred state in this traceability matrix; AC-14/P-07 remain assigned to S11. S10 must report these cross-stage statuses explicitly and fail closed on any unresolved acceptance interpretation rather than fabricate PASS or implement another stage silently.
- Preserve S4–S9 behavior and authoritative S6/S7 financial truth, including D-009..D-017 and the S9 UX regression contract.
- Test permissions/security, conflicting edits/concurrency/idempotency, reversal/closed-settlement behavior and exact integer-halalah reconciliation.
- Backup acceptance requires a real reproducible backup and restore into a separate empty local D1-compatible/SQLite target, with row/history/archive/financial and representative API reconciliation; file-existence-only evidence is insufficient.
- Use deterministic synthetic two-user, multi-year data. No real customer data, Cloud write, paid service, Billing or payment card.
- No governing numeric latency SLA exists; measure deterministic performance and query behavior but do not invent a millisecond threshold.
- S10 starts only from the exact final main SHA produced by the S9 administrative closure and a separately issued `FINAL_ACTIVATED` package.
