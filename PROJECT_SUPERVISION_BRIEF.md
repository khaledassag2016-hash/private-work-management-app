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

هذه الحالة تصبح الحالة التشغيلية المعتمدة بعد Squash-merge لـPR #70 والتحقق بعد الدمج:

- `S1 = CLOSED_COMPLETE`.
- `S2 = CLOSED_COMPLETE`.
- `S3 = CLOSED_BLOCKED_DEFERRED` وفق D-008، وليست S3 COMPLETE.
- `S4 = CLOSED_COMPLETE`.
- `S5 = CLOSED_COMPLETE`.
- `S5_COMPLETE = TRUE`.
- Issue #4 تغلق completed بعد تحقق PR #70.
- `S6 = AUTHORIZED_NOT_STARTED`.
- Issue #5 `[S6] الأسعار وطلبات الموافقة الثنائية` هي المرحلة التالية.
- S7 وما بعدها لم تبدأ.

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
- PR-C #70:
  - final-verification/administrative closure only
  - no runtime feature change and no S6 implementation
  - evidence: `docs/s5/S5_FINAL_VERIFICATION.md`

## 4. ما ثبت في S5

- FR-007: Work Events غير محدودة، زمنية، append-only، بهوية وتاريخ.
- FR-008: العنوان الحالي رسمي؛ العناوين السابقة وأسبابها محفوظة؛ execution-status history محفوظ بسبب وتاريخ.
- FR-023: لا hard delete؛ الإلغاء/الأرشفة يبقيان السجل والتاريخ قابلين للتتبع.
- AC-03: A→B→C يحتفظ بالتاريخ.
- AC-12 وP-05 S5: CANCEL/ARCHIVE يحتاجان حسابين مختلفين، ولا self-approval.
- CANCEL يطلب target execution status صريحًا من القيمتين المعتمدتين.
- ARCHIVE مستقل عن execution status ولا يحوله إلى `ARCHIVED`.
- execution status وcollection-status boundary معروضان منفصلين؛ S5 لا تخترع حالة تحصيل ولا تشتقها من `price_state`.
- backend هو السلطة، مع stale/concurrency/duplicate fail-safe وappend-only audit/history.

## 5. القرارات الحالية المهمة

- D-006: Workers Free + Workers Static Assets + D1 Free + Firebase Authentication Spark/Email-Password؛ حسابان فقط؛ لا Billing/بطاقة/خدمة مدفوعة؛ الأموال integer halalas ولا floating point.
- D-007: لا direct main؛ final-head CI؛ stable refs لا تتحرك تلقائيًا.
- D-008: S3 مغلقة إداريًا `CLOSED-BLOCKED/DEFERRED` وليست COMPLETE.
- D-009 / Q-001: تغيير النسبة الاستثنائية يحتاج موافقة الحسابين المختلفين؛ requester لا يوافق طلبه؛ reason/requester/approver/timestamp/audit.
- D-010 / Q-002: تصحيح/إلغاء دفعة بقيد عكسي موثق وموافقتين؛ S7.
- D-011 / Q-003: soft monthly close وإعادة فتح استثنائية بموافقتين؛ S7.
- D-012 / Q-004: nearest halala؛ exact 0.5 halala tie = half-up.
- D-013: استثناء تشغيلي خاص بـS5 فقط؛ **لا يمتد إلى S6**.

لا توجد Q-001..Q-004 مفتوحة حاليًا؛ كلها محسومة في DECISION_LOG.

## 6. ضوابط غير قابلة للتجاوز

- لا direct edits على `main`.
- كل مرحلة/إصلاح في branch وPR مستقل.
- Squash merge فقط بعد final-head CI ومراجعة إشرافية.
- لا مرحلة COMPLETE قبل acceptance + regression + `PROJECT_STATE.md` + post-merge verification.
- لا بيانات عملاء حقيقية أو كلمات مرور أو tokens أو service keys في GitHub.
- لا Cloud write أو Billing أو بطاقة أو خطة مدفوعة دون تفويض مستقل يطابق القرارات.
- لا hard delete للسجلات التنفيذية أو المالية.
- لا قرار منتج مفترض؛ أي نقص غير محسوم يعود للإشراف.
- لا stable promotion تلقائيًا.

## 7. المعمارية الحالية

- API: Cloudflare Workers Free.
- الواجهة: Cloudflare Workers Static Assets.
- البيانات: Cloudflare D1 Free عبر binding داخلي.
- المصادقة: Firebase Authentication Spark، Email/Password، حسابان ينشئهما المشرف.
- self-sign-up وPhone/SMS وAnonymous ومزودو الهوية الآخرون معطلون وفق D-006.
- APIs الخاصة fail closed؛ D1 لا يُوصل مباشرة من المتصفح.

## 8. بدء S6

S6 = Issue #5: **الأسعار وطلبات الموافقة الثنائية**.

لا يبدأ التنفيذ من PR #69 أو فرع S5. يجب بعد إغلاق S5:

1. قراءة `main` بعد Squash-merge لـPR #70.
2. تثبيت SHA الناتج بوصفه `S6_BASE_MAIN_SHA`.
3. قراءة Word + DECISION_LOG + PROJECT_STATE + TRACEABILITY + Issue #5 + `FINANCIAL_INTEGER_RULE.md` + عقد S5 الفعلي.
4. تفعيل تعليمات S6 المستقلة صراحة.
5. بدء PR-A المالي من ذلك SHA فقط.

حدود S6:

- الحركات السعرية، السعر الحالي، النسب والحصص، الموافقة الثنائية على تعديل السعر، وإعادة الحساب ضمن FR-009/010/017 وAC-02 وP-05 S6.
- D-009 يحكم النسبة الاستثنائية.
- لا payment ledger أو تسويات أو مصاريف أو اشتراكات أو تحويلات من S7.
- كل مبلغ integer halalas؛ لا floating-point financial math.

## 9. درس جودة ملزم من S5 إلى S6

في إصلاح S5، كان هناك اختبار UI عنوانه يوحي بأنه يثبت `ARCHIVE both directions` بينما assertions داخل ذلك الاختبار لم تنفذ الاتجاهين فعليًا؛ الإثبات الكامل وُضع في domain test آخر. لم يكن ذلك عيبًا وظيفيًا نهائيًا لأن السلوك ثبت في طبقة domain ومسار UI العام اختُبر منفصلًا، لكنه كشف ضعفًا في traceability.

لذلك في S6:

- لا تعتبر اسم test أو تقرير الوكيل دليلًا.
- لكل claim في التقرير يجب وجود mapping: `Requirement/Risk → exact test file → exact test name → exact assertions`.
- إذا كان معيار القبول يطلب الاتجاهين U1→U2 وU2→U1، يجب أن ينفذهما الاختبار المطلوب في **الطبقة المحددة**؛ لا تستبدل UI acceptance باختبار backend فقط.
- قبل تسليم PASS، افحص أن test name لا يدعي أكثر مما تثبته assertions.
- API/SPA response envelope يجب مراجعته عقديًا قبل دمج UI حتى لا تتكرر مشكلة `/private/ping`.
- mutation success لا يعني أن UI أصبحت authoritative؛ لا success UX كاملًا قبل refetch ناجح، وإذا نجحت الكتابة وفشل refetch يعرض split outcome واضحًا.
- نفذ sanity scan للنص العربي المرئي حتى لا تمر أخطاء نصية بسيطة أثناء التركيز على المخاطر العالية.

## 10. Stable refs

لا تحرك تلقائيًا:

- `stable/2026-08-09-be14a389` → `be14a389d7e11f1df9f935999d888e7e2295c8a3`.
- `stable/2026-08-09-643de962` → `643de962dc8631f68a42e3796c4a096a29c4e14c`.
