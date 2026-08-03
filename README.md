# Private Work Management App

تطبيق ويب خاص لإدارة الأعمال الأكاديمية والمحاسبة والمتابعة بين شخصين.

## الحالة

- المستودع: خاص.
- المرحلة **S1 مكتملة ومعتمدة ومدمجة** عبر PR #11.
- إصلاح سلامة المرجع مدمج عبر PR #14، commit `5ed2315377037c74732ca6fb5c403b450d057d49`.
- تثبيت حالة ما بعد الإصلاح مدمج عبر PR #15، commit `a914c67f305cfd4355eb400a3688eb11f56c48c7`.
- رفع الحظر النهائي عن S2 مدمج عبر PR #16، commit `9038d02d38929ee4ad6d761ac15634ba383eb1b8`.
- المرحلة **S2 مكتملة ومعتمدة ومدمجة** باستخدام Squash عبر PR #17، commit `ccad65637da144ebb115818395e286656863719e`.
- الإغلاق الإداري لـS2 عبر PR #18؛ يغلق Issue #1 عند دمجه.
- المرحلة التالية هي **S3 — Issue #2**، لكنها لم تبدأ ولا يبدأ تنفيذها ضمن PR #18.
- المرجع الحاكم الوحيد: ملف Word المعتمد الذي يعاد بناؤه محليًا في `docs/APPROVED_REQUIREMENTS.docx`.
- تحفظ بايتاته دون تعديل كمقاطع Base64 مرتبة ومحددة صراحة في `FOUNDATION_MANIFEST.json`؛ الأجزاء القديمة 05 إلى 07 غير حاكمة.
- بصمة المرجع SHA-256: `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`.
- الحجم المعتمد: `63710` بايت.
- التكلفة الإلزامية: **صفر**. لا تعتمد أي خدمة مدفوعة، ولا بطاقة بنكية، ولا ترقية تلقائية.

## المعمارية المعتمدة في S2

- Cloudflare Workers Static Assets لاستضافة الواجهة الأساسية.
- Cloudflare Workers Free للـAPI.
- Cloudflare D1 Free لقاعدة البيانات.
- Firebase Authentication Spark بطريقة Email/Password لحسابين ينشئهما المشرف فقط.
- `workers.dev` كنطاق البداية المجاني.
- Cloudflare Pages بديل احتياطي يحتاج قرارًا لاحقًا.
- منع self-sign-up وحذف الحساب من المستخدم وPhone/SMS وAnonymous وأي مزود آخر دون قرار لاحق.
- منع Workers Paid وFirebase Blaze وCloudflare Zero Trust وأي Billing Account أو وسيلة دفع.
- بوابة CPU مانعة في S3 عند حد Workers Free البالغ 10ms؛ التجاوز المتكرر يعيد القرار ولا يجيز الترقية المدفوعة.

## قواعد حاسمة

1. لا ترفع بيانات العملاء الحقيقية أو ملفات الأعمال إلى GitHub.
2. لا يعدل الفرع `main` إلا عبر Pull Request ومراجعة.
3. كل مرحلة تعمل في فرع مستقل وبنطاق ومعايير قبول محددة.
4. لا تسلم مرحلة قبل تشغيل فحوصها وتحديث `PROJECT_STATE.md`.
5. عند التعارض، تسود وثيقة المتطلبات المعتمدة، ثم سجل القرارات المؤرخ.
6. البنود `Q-001` إلى `Q-004` غير محسومة ولا يجوز تحويلها إلى سلوك برمجي قبل اعتماد قرار لاحق.
7. أي أثر حاكم يجب اختباره من نسخة نظيفة قبل الدمج ومن `main` بعد الدمج.
8. لا يبدأ S3 قبل توجيه مستقل وفتح فرع وPR خاصين بـIssue #2.

## إعادة بناء المرجع والتحقق

```bash
python scripts/reconstruct_requirements.py
python scripts/validate_foundation.py
python scripts/validate_s2.py
```

ينجح الأمر الأول فقط إذا أعاد ملف DOCX بطول Base64 والحجم والبصمة المعتمدة. ويتحقق الأمر الثاني من المرجع والتغطية وتوزيع المراحل والبيان والقرارات المفتوحة والملفات الحاكمة ومؤشرات الأسرار الأساسية. ويشغل الأمر الثالث اختبارات نموذج S2 المحلي، بما في ذلك قيود المستخدمين ومسار X.509 والتحقق من التوقيع.

## مراجع التشغيل

- حالة المشروع: `PROJECT_STATE.md`.
- الملخص الإشرافي: `PROJECT_SUPERVISION_BRIEF.md`.
- معمارية S2: `docs/architecture/ADR-001-FREE-ARCHITECTURE.md`.
- تقرير تحقق S2: `docs/S2_VALIDATION_REPORT.md`.
- المراجعة الذاتية لـS2: `docs/S2_SUPERVISORY_SELF_REVIEW.md`.
- تقرير إصلاح سلامة المرجع: `docs/S1_HOTFIX_REFERENCE_INTEGRITY_REPORT.md`.
- الملاحظات الشكلية داخل ملف Word: `docs/SOURCE_NOTES.md`.
- خارطة الطريق: `docs/ROADMAP.md`.
- قواعد المشروع: `docs/PROJECT_RULES.md`.
- تعريف الاكتمال: `docs/DEFINITION_OF_DONE.md`.
- سجل القرارات: `docs/DECISION_LOG.md`.
- تقرير تحقق S1 الأصلي: `docs/STAGE_1_VALIDATION_REPORT.md`.