# مصفوفة تتبع المتطلبات

إجمالي التغطية المطلوبة: **30/30 FR، 14/14 AC، 7/7 P، 14/14 سيناريو**.

S6 final evidence: `docs/s6/S6_FINAL_VERIFICATION.md`. PR #71 أنجز Financial Core، وPR #72 أنجز read integration/UI/acceptance وإصلاح D1 bounded query budget، وPR #73 هو بوابة الإغلاق الإدارية docs-only.

| المعرف | النوع | المرحلة المسؤولة | طريقة التحقق | الحالة |
| --- | --- | --- | --- | --- |
| FR-001 | متطلب وظيفي | S4 | Customer CRUD، أعمال العميل، history وaudit في PR #59 | متحقق في Gate 2 — PR #59 |
| FR-002 | متطلب وظيفي | S4 | Acceptance AC-04: عدة أعمال مستقلة للعميل نفسه | متحقق في Gate 2 — PR #59 |
| FR-003 | متطلب وظيفي | S4 | Acceptance AC-01: Work بلا سعر محفوظ كـ PRICE_UNSET ويظهر للمتابعة | متحقق في Gate 2 — PR #59 |
| FR-004 | متطلب وظيفي | S4 | independent/child، parent filtering، missing/self/cycle/cross-customer negative tests | متحقق في Gate 2 — PR #59 |
| FR-005 | متطلب وظيفي | S4 | حقول country/university/specialty/work type/subject/title في Work UI وAPI | متحقق في Gate 2 — PR #59 |
| FR-006 | متطلب وظيفي | S4 | required/optional/missing-detail UX مع `soft_warnings` server/read-model/UI للـ`university` و`specialty_key`؛ لا hard rejection؛ تظهر بعد save/reopen وتزول عند اكتمال الحقول؛ لا تتحول إلى fact/customer warning/audit domain state | **S4 soft-warning portion PASS؛ generic-title taxonomy/semantics DEFERRED / NO RULE INVENTED (closed administratively for S4)** |
| FR-007 | متطلب وظيفي | S5 | `s5_pr_a_domain_data_api.test.mjs` + `s5_pr_b_ui_flows.test.mjs`: أحداث غير محدودة، append-only، مرتبة زمنيًا، بهوية وتاريخ، مع add/reload/order | **PASS — S5 PR-A/PR-B؛ final verification PR #70** |
| FR-008 | متطلب وظيفي | S5 | title A→B→C/history + mandatory reason + execution-status history/reason/allowlist + UI flows | **PASS — S5 PR-A/PR-B؛ final verification PR #70** |
| FR-009 | متطلب وظيفي | S6 | `s6_pr_a_financial_core.test.mjs`: BASE/increase/decrease/discount، immutable movements، stale/duplicate/negative fail-closed؛ `s6_pr_b_ui_acceptance.test.mjs`: current/history UI | **PASS — S6 PR #71/#72؛ final verification PR #73** |
| FR-010 | متطلب وظيفي | S6 | S6 authoritative price/shares via `/financials` + Work/list/similar read models؛ post-mutation refetch؛ D-012 rounding | **PASS — authoritative current price/recalculation verified in S6** |
| FR-011 | متطلب وظيفي | S7 | `s7_pr_a_payments.test.mjs`: دفعات متعددة غير منتظمة؛ `s7_pr_c_ui_acceptance.test.mjs`: إدخال دفعة وإعادة جلب الحالة السلطوية | **PR-A core + PR-C UI acceptance ready for supervisory review** |
| FR-012 | متطلب وظيفي | S7 | `s7_pr_a_payments.test.mjs`: paid/remaining/collection derivation؛ `s7_pr_c_ui_acceptance.test.mjs`: عرض التحصيل منفصلًا عن التنفيذ | **PR-A core + PR-C UI acceptance ready for supervisory review** |
| FR-013 | متطلب وظيفي | S7 | `s7_pr_a_payments.test.mjs`: zero/partial collection؛ `s7_pr_c_ui_acceptance.test.mjs`: zero/unpaid and zero-price/PRICE_UNSET UI boundaries | **PR-A core + PR-C UI acceptance ready for supervisory review** |
| FR-014 | متطلب وظيفي | S4 | AC-07: documented fact يولد warning projection مع source/date | متحقق في Gate 2 — PR #59 |
| FR-015 | متطلب وظيفي | S4 | `/warnings` + `/history` ضمن pre-agreement context، وعرض fact type/source/date قبل New Work submit | **PASS — Gate 3 final verification** |
| FR-016 | متطلب وظيفي | S4 | S4 similar-work read boundary؛ اعتمدت S6 لاحقًا مصدر السعر السلطوي، و` s4_gate2_acceptance.test.mjs` يثبت تكامل similar Work مع `current_price_halalas` من S6 مع بقاء legacy sentinel غير سلطوي | **S4 READ BOUNDARY PASS؛ S6 authoritative pricing dependency integration PASS** |
| FR-017 | متطلب وظيفي | S6 | `s6_pr_a_financial_core.test.mjs` + `s6_pr_b_ui_acceptance.test.mjs`: default 30/70، D-009 exceptional ratio U1→U2 وU2→U1، self-approval rejected، history retained | **PASS — S6** |
| FR-018 | متطلب وظيفي | S7 | `s7_pr_b_settlement_core.test.mjs`: transfer ledger/P-03؛ `s7_pr_c_ui_acceptance.test.mjs`: transfer flow and authoritative settlement refetch | **PR-B core + PR-C UI acceptance ready for supervisory review** |
| FR-019 | متطلب وظيفي | S7 | `s7_pr_b_settlement_core.test.mjs`: subscriptions/expenses boundaries؛ `s7_pr_c_ui_acceptance.test.mjs`: effective history and fail-closed expense/close UX | **PR-B core + PR-C UI acceptance ready for supervisory review** |
| FR-020 | متطلب وظيفي | S7 | `s7_pr_b_settlement_core.test.mjs`: preview/close/reopen core؛ `s7_pr_c_ui_acceptance.test.mjs`: component preview, close/reopen UI, both approval directions | **PR-B core + PR-C UI acceptance ready for supervisory review** |
| FR-021 | متطلب وظيفي | S7 | `s7_pr_b_settlement_core.test.mjs`: bounded work/cumulative counts؛ `s7_pr_c_ui_acceptance.test.mjs`: monthly component display | **PR-B core + PR-C UI acceptance ready for supervisory review** |
| FR-022 | متطلب وظيفي | S8 | اختبار وظيفي موثق لـ FR-022 في المرحلة S8 | مخطط |
| FR-023 | متطلب وظيفي | S5 | `s5_pr_a_domain_data_api.test.mjs`: منع hard delete، archive history/retention، بقاء السجل؛ إعادة تحقق البحث/التحليلات والاستعادة في المراحل المسندة | **PASS — S5 portion؛ reverify in S8/S10 as already assigned** |
| FR-024 | متطلب وظيفي | S8 | اختبار وظيفي موثق لـ FR-024 في المرحلة S8 | مخطط |
| FR-025 | متطلب وظيفي | S8 | اختبار وظيفي موثق لـ FR-025 في المرحلة S8 | مخطط |
| FR-026 | متطلب وظيفي | S3 | اختبار وظيفي موثق لـ FR-026 في المرحلة S3 | مخطط |
| FR-027 | متطلب وظيفي | S2 | تحقق schema آلي بعدم وجود أعمدة file/blob/attachment، مع إعادة اختبار رجعي في S10 | متحقق في PR #17 — بانتظار مراجعة مستقلة |
| FR-028 | متطلب وظيفي | S4 | AC-13: إضافة catalog value واستخدامها دون source-code change | متحقق في Gate 2 — PR #59 |
| FR-029 | متطلب وظيفي | S8 | اختبار وظيفي موثق لـ FR-029 في المرحلة S8 | مخطط |
| FR-030 | متطلب وظيفي | S8 | اختبار وظيفي موثق لـ FR-030 في المرحلة S8 | مخطط |
| AC-01 | معيار قبول | S4 | `s4_gate2_acceptance.test.mjs`: Work بلا سعر، متابعة، وبقاء السجل | متحقق في Gate 2 — PR #59 |
| AC-02 | معيار قبول | S6 | `s6_pr_a_financial_core.test.mjs`: 1500 +200 +100 ثم -100/discount؛ pending no effect؛ approval history؛ UI/reload في `s6_pr_b_ui_acceptance.test.mjs` | **PASS — S6** |
| AC-03 | معيار قبول | S5 | `s5_pr_b_ui_flows.test.mjs`: A→B→C؛ current title يصبح C والتاريخ السابق محفوظ | **PASS — S5 PR-B** |
| AC-04 | معيار قبول | S4 | `s4_gate2_acceptance.test.mjs`: Customer واحد مع عدة Works مستقلة | متحقق في Gate 2 — PR #59 |
| AC-05 | معيار قبول | S7 | `s7_pr_a_payments.test.mjs`: installments to exact remaining zero؛ `s7_pr_c_ui_acceptance.test.mjs`: payment UI/refetch | **PR-A core + PR-C UI acceptance ready for supervisory review** |
| AC-06 | معيار قبول | S7 | `s7_pr_a_payments.test.mjs`: completed unpaid/partial derivation; `s7_pr_c_ui_acceptance.test.mjs`: completed execution remains independent from collection descriptor | **PR-A core + PR-C UI acceptance ready for supervisory review** |
| AC-07 | معيار قبول | S4 | `s4_gate2_acceptance.test.mjs` + `s4_gate2_supervisory_repair.test.mjs`: loading/error يمنعان submit، retry يفعّل، warning/history ظاهران قبل submit، وverified-none يسمح بالمتابعة | **PASS — Gate 3 fail-closed final verification** |
| AC-08 | معيار قبول | S8 | سيناريو قبول AC-08 | مخطط |
| AC-09 | معيار قبول | S8 | سيناريو قبول AC-09 | مخطط |
| AC-10 | معيار قبول | S8 | سيناريو قبول AC-10 | مخطط |
| AC-11 | معيار قبول | S3 | سيناريو قبول AC-11 | مخطط |
| AC-12 | معيار قبول | S5 | CANCEL/ARCHIVE pending + U1→U2 وU2→U1 domain approvals + self-approval rejection + archive status preservation/history retention + UI governed request/approve flow | **PASS — S5 PR-A/PR-B** |
| AC-13 | معيار قبول | S4 | `s4_gate2_acceptance.test.mjs`: catalog runtime addition/use دون تعديل المصدر | متحقق في Gate 2 — PR #59 |
| AC-14 | معيار قبول | S11 | سيناريو قبول AC-14 | مخطط |
| P-01 | قرار معتمد | S7 | مراجعة قاعدة العمل واختبار أثرها في S7 | مخطط |
| P-02 | قرار معتمد | S7 | مراجعة قاعدة العمل واختبار أثرها في S7 | مخطط |
| P-03 | قرار معتمد | S7 | مراجعة قاعدة العمل واختبار أثرها في S7 | مخطط |
| P-04 | قرار معتمد | S7 | مراجعة قاعدة العمل واختبار أثرها في S7 | مخطط |
| P-05 | قرار معتمد | S5/S6 | S5: cancel/archive require two different accounts، self-approval rejected، no hard delete؛ S6: price requests require other-account approval، immutable previous/new/reason/actors/time | **PASS — S5 cancel/archive + S6 price-change portions complete** |
| P-06 | قرار معتمد | S4 | customer identity/metadata، duplicate no-merge، works، history، documented facts، warnings، notes | **S4 PORTION PASS؛ financial dealings DEFERRED TO S7 (closed administratively for S4)** |
| P-07 | قرار معتمد | S11 | مراجعة قاعدة العمل واختبار أثرها في S11 | مخطط |
| S-01 | سيناريو | S6 | `s6_pr_a_financial_core.test.mjs`: السعر الأساسي 1500 والإضافات +200 +100 = 1800 مع history | **PASS — S6** |
| S-02 | سيناريو | S5/S6 | S5 title-history transitions retained؛ S6 price movement retains previous/new/reason/effective/approval timestamps | **PASS for S5/S6 assigned portions** |
| S-03 | سيناريو | S4/S5 | S4 parent/child + S5 events/title/status/archive histories تكمل historical timeline ضمن النطاقين | **PASS for S4/S5 assigned portions** |
| S-04 | سيناريو | S4 | Work UI/API وnegative relation tests | متحقق في Gate 2 — PR #59 |
| S-05 | سيناريو | S4/S8 | PRICE_UNSET follow-up UI؛ expanded S8 reporting غير منفذ | متحقق جزئيًا في Gate 2 — PR #59 |
| S-06 | سيناريو | S5 | CANCEL target `CANCELLED_BEFORE_EXECUTION` عبر طلب وموافقة حساب مختلف مع بقاء السجل | **PASS — S5** |
| S-07 | سيناريو | S5/S7 | S5 يثبت `PARTIALLY_STOPPED` كهدف CANCEL governed مع بقاء السجل؛ payment-zero/remaining جزء S7 | **S5 execution portion PASS؛ S7 financial portion planned** |
| S-08 | سيناريو | S7 | اختبار 1700 ناقص 1000 يساوي 700 | مخطط |
| S-09 | سيناريو | S7 | اختبار الأقساط المتباعدة حتى المتبقي صفر | مخطط |
| S-10 | سيناريو | S6 | `s6_pr_a_financial_core.test.mjs`: discount/decrease حركة سالبة موثقة؛ final price non-negative؛ negative edge fail-closed | **PASS — S6** |
| S-11 | سيناريو | S5/S6 | S5 يحافظ على event/history boundary دون mutation مالي؛ S6 يثبت price movement والقيمة الصفرية/halala integer boundary دون S7 payment mutation | **PASS for S5/S6 assigned portions** |
| S-12 | سيناريو | S4 | Acceptance AC-04 في Gate 2 | متحقق في Gate 2 — PR #59 |
| S-13 | سيناريو | S4 | Acceptance AC-07: warning مشتق من documented fact مع source | متحقق في Gate 2 — PR #59 |
| S-14 | سيناريو | S4/S11 | PRICE_UNSET/PRICE_ZERO distinction؛ historical import S11 غير منفذ | متحقق جزئيًا في Gate 2 — PR #59 |

## S6 performance/free-tier acceptance

- `s6_pr_b_query_budget.test.mjs` يثبت أن `listWorks` مع 200 Work يستخدم 3 D1 read queries فقط وبحد أقصى 100 bindings لكل bulk query.
- `getSimilarWorks` مع 50 similar Works يستخدم 3 read queries فقط.
- authoritative pricing remains `S6_APPROVED_PRICE_MOVEMENTS`; legacy S4 fields remain preserved but non-authoritative.
- هذا القيد يُورّث إلى S7: أي list/read مالي جديد يحتاج measured query-budget regression ولا يقبل N+1.
