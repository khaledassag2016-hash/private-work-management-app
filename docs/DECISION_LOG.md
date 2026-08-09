# سجل القرارات

| الرقم | التاريخ | القرار | السبب | الحالة |
|---|---|---|---|---|
| D-001 | 2026-08-02 | اعتماد `APPROVED_REQUIREMENTS.docx` وحده مرجعًا حاكمًا، ببصمة `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`. | النسخ السابقة لا تتضمن جميع التعديلات. | معتمد |
| D-002 | 2026-08-02 | التطبيق والخدمات يجب أن تعمل دون اشتراك أو تكلفة إلزامية ودون بطاقة بنكية. | شرط صريح من المستخدم. | معتمد |
| D-003 | 2026-08-02 | تقسيم التنفيذ إلى مراحل وفروع وPull Requests مع تحقق قبل الدمج. | منع تضارب الجلسات وادعاء الاكتمال غير المثبت. | معتمد |
| D-004 | 2026-08-02 | GitHub للكود والوثائق فقط، لا لبيانات العملاء الحقيقية. | الخصوصية وتقليل أثر التسرب. | معتمد |
| D-005 | 2026-08-02 | عبارات «مسودة» و«بانتظار الاعتماد» المتبقية داخل ملف Word عبارات شكلية تجاوزها اعتماد المستخدم الصريح، مع إبقاء الملف دون تعديل للحفاظ على بصمته. | منع التباس الجلسات اللاحقة دون تغيير المرجع الأصلي. | معتمد |
| D-006 | 2026-08-03 | اعتماد Cloudflare Workers Free للـAPI، و**Cloudflare Workers Static Assets** لاستضافة الواجهة الأساسية، وCloudflare D1 Free للبيانات، مع Firebase Authentication Spark للمصادقة فقط بطريقة **Email/Password** لحسابين ينشئهما المشرف. يبدأ التشغيل على نطاق `workers.dev` المجاني ولا يشترط نطاقًا مدفوعًا؛ وCloudflare Pages بديل احتياطي يحتاج قرارًا لاحقًا. يعطل self-sign-up وحذف الحساب من المستخدم وPhone/SMS وAnonymous وأي مزود آخر. كل API خاص يعمل Fail closed، ويتحقق من Firebase ID Token وفق `alg=RS256` و`kid` المطابق لشهادة X.509 العامة والتوقيع و`aud` و`iss` و`exp` و`iat` و`auth_time` و`sub`، ثم قائمة سماح لشخصين داخل D1. ترتبط D1 بالـWorker داخليًا ولا يسمح بتجاوزه. يفرض `app_users` مستخدمين نشطين فقط ودورًا نشطًا فريدًا، ويمنع `INSERT OR REPLACE` في provisioning. تخزن القيم المالية كعدد صحيح من الهللات ضمن المجال الآمن، ويحظر floating point. في بداية S3 يجب قياس تحقق الرمز على Workers Free؛ إذا تكرر تجاوز حد CPU البالغ 10ms يتوقف التنفيذ وتعود المسألة إلى بوابة القرار أو بديل مجاني، ويحظر Workers Paid أو الفوترة. يحظر Zero Trust وBlaze وأي Billing Account أو وسيلة دفع، ولا تنشأ خدمة سحابية دون موافقة مستقلة. | يحقق شرط صفر تكلفة إلزامية، ويوفر قاعدة علائقية قابلة للتصدير وهوية منفصلة، مع فصل مزود الهوية عن البيانات وتقليل مخاطر المصادقة المخصصة وقفل البيانات. تفاصيل التنفيذ والقيود في `docs/architecture/ADR-001-FREE-ARCHITECTURE.md` و`docs/architecture/FINANCIAL_INTEGER_RULE.md`. | معتمد |

## قرارات تحتاج حسمًا قبل مراحل لاحقة

| الرقم | القرار المطلوب | المرحلة التي تمنعها | الحالة |
|---|---|---|---|
| Q-001 | هل تغيير النسبة الاستثنائية لعمل معين يحتاج موافقة الطرفين، أم يكفي تسجيل السبب وسجل التدقيق؟ | S6 | غير محسوم |
| Q-002 | ما آلية تصحيح أو إلغاء دفعة سبق تسجيلها، وهل تحتاج موافقة الطرفين؟ | S7 | غير محسوم |
| Q-003 | هل سيُعتمد إقفال شهري للتسويات وآلية لإعادة فتحها؟ هذه الميزة ليست معتمدة في المرجع الحالي ولا يجوز افتراضها. | S7 | غير محسوم |
| Q-004 | ما قاعدة التقريب الحاكمة عند حساب نسب مالية تنتج كسور هللة؟ لا يجوز افتراض التقريب قبل اعتماد قاعدة صريحة. | S7 قبل تنفيذ الحسابات ذات الكسور | غير محسوم |

## إضافة قرار جديد

يضاف القرار برقم متسلسل، وتاريخ، ونص دقيق، وسبب، وحالة. لا تُعدل القرارات القديمة لمسح التاريخ؛ يُضاف قرار لاحق يلغي أو يستبدل السابق. لا يتحول أي بند `Q` إلى قاعدة تنفيذية إلا بعد تسجيل قرار `D` معتمد.

## D-007 — Stable checkpoint and recovery governance

| Number | Date | Decision | Rationale | Status |
|---|---|---|---|---|
| D-007 | 2026-08-09 | Models must not work directly on `main`; work starts from a stable checkpoint or from `main` only after explicit verification. A PR is accepted only when CI passes on its final head. Force-push to stable refs and deletion of stable branches/tags are prohibited. A commit is not stable merely because it was merged. Stable promotion requires final-head CI, human supervisory review, SHA registration in `PROJECT_STATE.md`, and an explicit stable checkpoint. If a suspect change series exists, do not repair `main` with a force reset; create a recovery branch from the last stable checkpoint and reintroduce changes through a PR. | Protect the recoverable baseline and separate merging from declaring stability. | Approved |
