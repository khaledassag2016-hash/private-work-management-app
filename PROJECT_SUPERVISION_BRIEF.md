# PROJECT_SUPERVISION_BRIEF

> **الغرض:** ملخص إشرافي تشغيلي حديث للجلسات الجديدة. لا يستبدل المرجع الحاكم، بل يحدد ما يجب قراءته والحالة الحالية وكيفية الانتقال بين المراحل.

## 1. المشروع والمرجع الحاكم

- المشروع: **Private Work Management App**.
- المستودع الرسمي: `khaledassag2016-hash/private-work-management-app`.
- المستودع خاص.
- المستخدمان النهائيان: حسابان معتمدان فقط.
- المرجع الحاكم الأعلى: `docs/APPROVED_REQUIREMENTS.docx`.
- SHA-256 المعتمد: `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`.
- الحجم: `63710` بايت.

## 2. ترتيب الحاكمية

عند أي اختلاف:

1. `docs/APPROVED_REQUIREMENTS.docx` بالبصمة المعتمدة.
2. القرارات المؤرخة في `docs/DECISION_LOG.md`.
3. `PROJECT_STATE.md` للحالة التشغيلية الحالية.
4. `docs/TRACEABILITY_MATRIX.md` لتوزيع المتطلبات والاختبارات.
5. Issue المرحلة وعقود التنفيذ وPull Requests الخاصة بها.

لا تعتمد على ذاكرة محادثة أو تقرير وكيل بدل GitHub الفعلي.

## 3. الحالة الحالية

هذه الحالة تصبح نافذة بعد نجاح final-head CI وSquash-merge لـPR #73 والتحقق من `main` بعد الدمج وإغلاق Issue #5:

- `S1 = CLOSED_COMPLETE`.
- `S2 = CLOSED_COMPLETE`.
- `S3 = CLOSED_BLOCKED_DEFERRED` وفق D-008، وليست S3 COMPLETE.
- `S4 = CLOSED_COMPLETE`.
- `S5 = CLOSED_COMPLETE`.
- `S6 = CLOSED_COMPLETE`.
- `S6_COMPLETE = TRUE`.
- Issue #5 تغلق completed بعد تحقق PR #73.
- `S7 = AUTHORIZED_NOT_STARTED`.
- Issue #6 `[S7] الدفعات والتسويات والمصاريف` هي المرحلة التالية.
- S8 وما بعدها لم تبدأ.

### S5 evidence chain

- PR-A #68:
  - final head `c64d83998998bcefff1b21962d961344b47de29d`
  - Squash/main `3c6bb5dbdd5074517d4568b6b4a3c5c355c856cd`
- PR-B #69:
  - final head `eb19187a9450dad0da92562a90e9cc168eaba38f`
  - Squash/main `6c35fad443f6ce90ba3834784ac471372c2df8ec`
  - final-head CI: S3 `31607393828` SUCCESS؛ S2 `31607393809` SUCCESS
  - Node `65/65`، Python `80/80`، Pester `291/291`، Foundation/S2/Secret Scan/Payload-ZIP PASS
  - post-merge S3 run `31607788819` SUCCESS
- PR-C #70: final-verification/administrative closure only; evidence `docs/s5/S5_FINAL_VERIFICATION.md`.

### S6 evidence chain

- PR-A #71:
  - base `c26c874c19054c610b273150d533938552036c42`
  - final head `0b18c62cc0c8c5ab025b7473e5a23e3243babf63`
  - Squash/main `281ca5490f9c498d0f34a71c6081e65108e89abe`
  - final-head CI: Foundation `31614196766` SUCCESS؛ S2 `31614196675` SUCCESS؛ S3 `31614196721` SUCCESS
- PR-B #72:
  - base `281ca5490f9c498d0f34a71c6081e65108e89abe`
  - final head `fdbd7f0fe21409849ad98a161aac4a3dde72bf8b`
  - Squash/main `0de57ef07f015506c0ef9afa9956413916743442`
  - final-head CI: Foundation `31618901526` SUCCESS؛ S2 `31618901361` SUCCESS؛ S3 `31618901360` SUCCESS
  - post-merge Foundation `31619376196` SUCCESS
  - post-merge S3 `31619376114` SUCCESS on attempt 2; attempt 1 failed only during external PowerShell archive download with `curl (56) Connection died`, before implementation/test execution
- PR-C #73:
  - branch `s6/pr-c-final-verification-closure`
  - base `0de57ef07f015506c0ef9afa9956413916743442`
  - docs/admin only; evidence `docs/s6/S6_FINAL_VERIFICATION.md`

## 4. ما ثبت في S5

- FR-007: Work Events غير محدودة، زمنية، append-only، بهوية وتاريخ.
- FR-008: العنوان الحالي رسمي؛ العناوين السابقة وأسبابها محفوظة؛ execution-status history محفوظ بسبب وتاريخ.
- FR-023: لا hard delete؛ الإلغاء/الأرشفة يبقيان السجل والتاريخ قابلين للتتبع.
- AC-03: A→B→C يحتفظ بالتاريخ.
- AC-12 وP-05 S5: CANCEL/ARCHIVE يحتاجان حسابين مختلفين، ولا self-approval.
- execution status وcollection-status boundary معروضان منفصلين؛ S5 لا تخترع حالة تحصيل.

## 5. ما ثبت في S6

- FR-009: BASE / increase / decrease / discount موثقة كسجل حركات معتمد؛ السابق والجديد والسبب والطرفان والتوقيت محفوظة.
- FR-010: السعر الحالي السلطوي مشتق من حركات S6 المعتمدة، وتُعاد الحصص منه دون الاعتماد على legacy S4 price sentinel.
- FR-017: 30/70 افتراضي، والاستثناء الموثق يحتاج حسابين مختلفين وفق D-009.
- AC-02: تدفقات 1500 ثم الزيادات/النقص والخصم ثبتت مع history وإعادة فتح.
- P-05 S6: تعديل السعر request → other-account approval؛ self-approval مرفوض.
- D-012: nearest halala وexact .5 half-up لكل حصة بشكل مستقل، بلا residual rebalance.
- pending لا يغير الحقيقة المعتمدة؛ stale/duplicate fail closed.
- `S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED` يبقى fail-closed دون اختراع قرار منتج.
- Work/list/similar/UI تستخدم `pricing_state`, `current_price_halalas`, `pricing_source = S6_APPROVED_PRICE_MOVEMENTS` كمصدر حاكم؛ legacy S4 fields محفوظة لكنها غير سلطوية.
- D1 query budget: 200 Work في `listWorks` = 3 read queries وبحد أقصى 100 bindings لكل bulk query؛ 50 similar Works = 3 read queries؛ لا N+1 pricing reads.
- لا payment ledger أو settlement/expense/subscription/transfer mutations من S7.

## 6. القرارات الحالية المهمة

- D-006: Workers Free + Workers Static Assets + D1 Free + Firebase Authentication Spark/Email-Password؛ حسابان فقط؛ لا Billing/بطاقة/خدمة مدفوعة؛ الأموال integer halalas ولا floating point.
- D-007: لا direct main؛ final-head CI؛ stable refs لا تتحرك تلقائيًا.
- D-008: S3 مغلقة إداريًا `CLOSED-BLOCKED/DEFERRED` وليست COMPLETE.
- D-009 / Q-001: تغيير النسبة الاستثنائية يحتاج موافقة الحسابين المختلفين؛ requester لا يوافق طلبه؛ reason/requester/approver/timestamp/audit.
- D-010 / Q-002: تصحيح/إلغاء دفعة بقيد عكسي موثق وموافقتين؛ S7.
- D-011 / Q-003: soft monthly close وإعادة فتح استثنائية بموافقتين؛ S7.
- D-012 / Q-004: nearest halala؛ exact 0.5 halala tie = half-up.
- D-013: استثناء تشغيلي خاص بـS5 فقط؛ **لا يمتد إلى S6 أو S7**.

## 7. ضوابط غير قابلة للتجاوز

- لا direct edits على `main`.
- كل مرحلة/إصلاح في branch وPR مستقل.
- Squash merge فقط بعد final-head CI ومراجعة إشرافية.
- لا مرحلة COMPLETE قبل acceptance + regression + `PROJECT_STATE.md` + post-merge verification.
- لا بيانات عملاء حقيقية أو كلمات مرور أو tokens أو service keys في GitHub.
- لا Cloud write أو Billing أو بطاقة أو خطة مدفوعة دون تفويض مستقل يطابق القرارات.
- لا hard delete للسجلات التنفيذية أو المالية.
- لا قرار منتج مفترض؛ أي نقص غير محسوم يعود للإشراف.
- لا stable promotion تلقائيًا.

## 8. المعمارية الحالية

- API: Cloudflare Workers Free.
- الواجهة: Cloudflare Workers Static Assets.
- البيانات: Cloudflare D1 Free عبر binding داخلي.
- المصادقة: Firebase Authentication Spark، Email/Password، حسابان ينشئهما المشرف.
- self-sign-up وPhone/SMS وAnonymous ومزودو الهوية الآخرون معطلون وفق D-006.
- APIs الخاصة fail closed؛ D1 لا يُوصل مباشرة من المتصفح.
- S7 يجب أن يحافظ على bounded D1 reads؛ لا N+1 financial list/read models.

## 9. بدء S7

S7 = Issue #6: **الدفعات والتسويات والمصاريف**.

لا يبدأ التنفيذ من PR #72 أو أي فرع S6. بعد الإغلاق النهائي لـPR #73 يجب:

1. قراءة `main` النهائي بعد Squash-merge لـPR #73 وتثبيت SHA الناتج بوصفه `S7_BASE_MAIN_SHA`.
2. قراءة Word + DECISION_LOG + PROJECT_STATE + TRACEABILITY + Issue #6 + `FINANCIAL_INTEGER_RULE.md` + عقد S6 الفعلي.
3. استخدام تعليمات S7 `FINAL_ACTIVATED` فقط؛ Prepared V3 ليست إذن تنفيذ.
4. بدء S7 PR-A فقط من ذلك SHA.

حدود S7 المعتمدة قبل التفعيل النهائي:

- ordinary payment واحد يرتبط بـWork واحد؛ multi-work payment allocation يبقى `DEFERRED / NO_STAGE_ASSIGNED` ما لم يصدر قرار معتمد لاحقًا.
- الاشتراكان: `subscription_count = 2` والإجمالي الحالي `136.5 SAR = 13,650 halalas`؛ لا تُخترع أسماء أو قيم فردية أو تقسيم 68.25/68.25.
- الأسماء والقيم الفردية للاشتراكين `UNKNOWN / OPTIONAL UNTIL EXPLICITLY PROVIDED/APPROVED`، ولا تمنع استخدام الإجمالي عندما تكفي القاعدة الحاكمة.
- تصحيح/إلغاء payment يخضع D-010 reversal، وإعادة فتح settlement تخضع D-011.
- كل القيم المالية integer halalas، no float financial math.
- N+1 D1 reads ممنوعة؛ يلزم query-budget regression بقياس فعلي على fixtures كبيرة.
- لا S8 analytics/export scope.

## 10. درس جودة مستمر

- لا تعتبر اسم test أو تقرير الوكيل دليلًا؛ المعيار هو assertions والطبقة الفعلية.
- لكل claim: `Requirement/Risk → exact test file → exact test name → exact assertions`.
- approval both-directions المطلوب في UI يجب أن ينفذ الاتجاهين داخل UI test نفسه إذا كان الادعاء UI-layer.
- API/SPA envelope يجب أن يبقى عقدًا موحدًا.
- mutation write success لا يساوي refreshed UI success؛ لا نجاح UX نهائي قبل authoritative refetch.
- النص العربي المرئي يحتاج sanity scan.
- أي list/read مالي جديد يجب اختباره ضد D1 query budget، لا فحص مصدر فقط.

## 11. Stable refs

لا تحرك تلقائيًا:

- `stable/2026-08-09-be14a389` → `be14a389d7e11f1df9f935999d888e7e2295c8a3`.
- `stable/2026-08-09-643de962` → `643de962dc8631f68a42e3796c4a096a29c4e14c`.
