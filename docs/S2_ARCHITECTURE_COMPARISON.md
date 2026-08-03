# S2 — مقارنة المعماريات المجانية

- تاريخ التحقق: 2026-08-03
- Issue: #1
- الفرع: `stage-2/free-architecture-evaluation`
- حالة القرار: **توصية مقترحة، غير معتمدة**
- المرجع الحاكم: ملف Word المعاد بناؤه بالحجم `63710` والبصمة `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`

## 1. نطاق المقارنة

تغطي هذه المقارنة الاستضافة، التنفيذ الخلفي، قاعدة البيانات، المصادقة، العمل المتزامن أو المتعاقب لشخصين، التصدير والاستعادة، وسلوك الخطة المجانية. لا تشمل بناء شاشات التطبيق أو إنشاء أي خدمة سحابية فعلية.

## 2. البوابات الإلزامية

أي بديل يفشل بوابة واحدة لا يمكن اعتماده، مهما كانت درجته الإجمالية:

1. لا تكلفة أو اشتراك إلزامي.
2. لا بطاقة بنكية ولا تفعيل فوترة.
3. لا فوترة تلقائية عند تجاوز الحصة؛ يجب أن يتوقف الاستخدام أو يفشل بوضوح.
4. قابلية العمل لشخصين في أوقات مختلفة دون توقف خمول يجعل التطبيق غير متاح.
5. هوية منفصلة لكل شخص ومنع أي مستخدم ثالث من الوصول إلى بيانات التطبيق.
6. مسار تصدير واستعادة مفتوح لا يحبس البيانات.
7. عدم تخزين ملفات الأعمال نفسها داخل التطبيق وفق `FR-027`.

## 3. أوزان التقييم

| المحور | الوزن |
|---|---:|
| التكلفة والبطاقة وسلوك التجاوز | 25% |
| الاستمرارية وعدم توقف الخمول | 15% |
| أمن الهوية وقصر الوصول على شخصين | 20% |
| سلامة البيانات والتزامن وسجل التدقيق | 15% |
| التصدير والنسخ والاستعادة وقابلية النقل | 15% |
| سهولة الصيانة وخطر تغير الخطة | 10% |

الدرجات من 0 إلى 5، ثم تحسب النتيجة الموزونة من 100. البوابات الإلزامية تسبق النتيجة الرقمية.

## 4. البدائل

### A — Cloudflare Workers/Pages + D1 + Firebase Authentication Spark

**التكوين المقترح:**

- واجهة ثابتة على Cloudflare Workers Static Assets أو Pages.
- API خاص على Cloudflare Workers Free.
- قاعدة بيانات Cloudflare D1 Free.
- Firebase Authentication على Spark للمصادقة فقط.
- حسابان ينشئهما المشرف، مع تعطيل إنشاء الحسابات وحذفها من المستخدم النهائي.
- يتحقق Worker من توقيع ورمز Firebase، ثم يطبق قائمة سماح داخل D1 تحتوي UID للشخصين فقط.

**نقاط القوة:**

- Cloudflare يعلن بدء البناء مجانًا دون بطاقة، وFirebase Spark لا يحتاج معلومات دفع.
- تجاوز حصص Workers/D1 المجانية يؤدي إلى أخطاء أو توقف العمليات، لا إلى رسوم تلقائية.
- D1 يستخدم دلالات SQLite ويدعم العلاقات والمفاتيح الأجنبية والتصدير إلى SQL.
- لا يوجد توقف خمول معلن لـ Workers/D1 أو Firebase Authentication.
- D1 يوفر Time Travel لمدة 7 أيام على الخطة المجانية، مع بقاء النسخة الخارجية المستقلة مطلوبة.
- الفصل بين المصادقة والبيانات يقلل الحاجة إلى بناء نظام كلمات مرور خاص.

**القيود والمخاطر:**

- مزودان بدل مزود واحد.
- يجب اختبار تحقق RS256 وجلب مفاتيح Google العامة وذاكرة التخزين المؤقت ضمن حد CPU في Workers Free أثناء S3.
- حد D1 المجاني 500 MB لكل قاعدة و5 GB للحساب؛ يلزم رصد النمو.
- Time Travel ليس بديلًا عن نسخة SQL خارج المنصة.

**حكم البوابات:** PASS، بشرط بقاء الحساب على الخطتين المجانيتين وعدم استخدام Cloudflare Zero Trust Access، لأن إعداد Zero Trust يطلب بيانات دفع حتى على خطته المجانية.

### B — Firebase Spark متكامل: Hosting + Authentication + Firestore

**نقاط القوة:**

- مزود واحد، ولا يحتاج Spark إلى معلومات دفع.
- المصادقة متاحة دون تكلفة لمعظم الطرق.
- حصص Firestore مناسبة جدًا لمستخدمين اثنين، والتجاوز على Spark يوقف المنتج بدل الفوترة.
- معاملات Firestore والكتابات المجمعة تدعم الذرية.

**القيود:**

- النسخ الاحتياطية المدارة وPITR والاستعادة والاستنساخ تحتاج تفعيل فوترة.
- خدمة التصدير والاستيراد المدارة تتطلب Blaze؛ لذلك يلزم بناء تصدير JSON خاص بالتطبيق واختبار استعادته.
- نموذج المستندات أقل ملاءمة من SQL للعلاقات المالية وسجل الحركات والاستعلامات التحليلية المتعددة.
- الارتباط بخدمات Firebase أعلى.

**حكم البوابات:** PASS مشروط بتصدير تطبيق مستقل، لكنه أدنى من البديل A في قابلية النقل والنموذج العلاقي.

### C — Supabase Free

**نقاط القوة:**

- PostgreSQL ومصادقة وواجهات API مدمجة.
- تصدير منطقي باستخدام `db dump` متاح، وقاعدة البيانات علائقية.
- سعة 500 MB و50,000 MAU أعلى كثيرًا من حمل شخصين.

**القيود المانعة:**

- مشاريع Free قليلة النشاط قد تتوقف بعد 7 أيام، وهو تعارض مباشر مع ضرورة استخدام الشخصين للتطبيق عند الحاجة دون إجراء إحياء إداري.
- النسخ الاحتياطية الآلية غير متاحة للخطة المجانية.
- الوثائق الحالية تثبت أن الخطط المدفوعة تحتاج بطاقة، لكنها لا تقدم نصًا حديثًا صريحًا يضمن أن كل مسار إنشاء Free لا يطلب بطاقة؛ لذلك تبقى بوابة البطاقة غير مثبتة بما يكفي لهذا المشروع.

**حكم البوابات:** FAIL بسبب توقف الخمول، إضافة إلى فجوة إثبات البطاقة.

### D — Appwrite Cloud Free

**نقاط القوة:**

- خدمات مصادقة وقاعدة بيانات وموقع ووظائف ضمن منصة واحدة.
- حدود 75,000 MAU و500,000 قراءة و250,000 كتابة شهريًا كافية للحمل المتوقع.
- تجاوز عمليات القراءة أو الكتابة على Free يسبب الخنق بدل overage مدفوع.

**القيود المانعة:**

- المشروع المجاني يتوقف بعد 7 أيام دون نشاط تطويري، ويصبح غير متاح للمستخدمين حتى إعادة تنشيطه.
- المشاريع المجانية المتوقفة 90 يومًا معرضة للحذف وفق تحديث يونيو 2026.
- النسخ الاحتياطية ليست ضمن Free.
- تغيرت حدود الخطة المجانية عدة مرات في 2026، بما يزيد خطر تغير الخطة.
- لم نجد في صفحة التسعير الحالية نصًا صريحًا يكفي وحده لإثبات عدم طلب بطاقة في مسار التسجيل.

**حكم البوابات:** FAIL بسبب توقف الخمول وخطر الحذف وفجوة إثبات البطاقة.

### E — Google Apps Script + Google Sheets

**نقاط القوة:**

- بيئة بسيطة، تصدير Sheets/Excel مباشر، وLockService يمنع تصادم المقاطع الحرجة.
- لا تحتاج خادمًا مخصصًا.

**القيود المانعة:**

- خيارات نشر Web App هي: المالك فقط، النطاق، أي مستخدم مسجل، أو أي مستخدم؛ لا توجد سياسة نشر أصلية تحصر الوصول في بريدين شخصيين محددين.
- هوية المستخدم النشط قد تكون غير متاحة في بعض أوضاع التنفيذ، ما يضعف سجل التدقيق وقائمة السماح.
- الحصص عرضة للتغيير دون إشعار، والتجاوز يرمي استثناء ويوقف التنفيذ.
- Sheets ليس قاعدة معاملات علائقية مناسبة لتاريخ مالي طويل واستعلامات وتحليلات متعددة.

**حكم البوابات:** FAIL بسبب غموض الهوية والحصر الدقيق للمستخدمين وسلامة البيانات.

## 5. مصفوفة النتيجة

| البديل | التكلفة 25 | الاستمرارية 15 | الأمن 20 | سلامة البيانات 15 | النقل 15 | الصيانة 10 | النتيجة /100 | البوابة |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A: Cloudflare + D1 + Firebase Auth | 25 | 15 | 18 | 14 | 14 | 8 | **94** | PASS |
| B: Firebase متكامل | 25 | 15 | 18 | 11 | 9 | 9 | **87** | PASS مشروط |
| C: Supabase Free | 18 | 3 | 17 | 15 | 14 | 8 | 75 | FAIL |
| D: Appwrite Cloud Free | 16 | 0 | 16 | 12 | 8 | 5 | 57 | FAIL |
| E: Apps Script + Sheets | 22 | 11 | 6 | 7 | 12 | 7 | 65 | FAIL |

## 6. التوصية

التوصية المعمارية المقترحة هي **A: Cloudflare Workers/Static Assets + D1 + Firebase Authentication Spark**، مع هذه الشروط غير القابلة للتخفيف:

1. لا يستخدم Cloudflare Zero Trust Access لأنه يطلب بيانات دفع عند الإعداد.
2. لا يربط أي حساب فوترة في Cloudflare أو Firebase.
3. ينشأ حسابا Firebase إداريًا فقط، وتعطل عمليات إنشاء الحساب أو حذفه من المستخدم النهائي.
4. لا يكفي امتلاك حساب Firebase للوصول؛ يجب أن يطابق UID سجلًا نشطًا ضمن `app_users` في D1.
5. لا تخزن ملفات الأعمال؛ البيانات النصية والمالية فقط.
6. ينفذ تصدير SQL دوري يدويًا إلى تخزين محلي مشفر خارج GitHub، مع اختبار استعادة في S10.
7. يظل ADR بحالة `Proposed` حتى موافقة المستخدم الصريحة، ولا يعدل `docs/DECISION_LOG.md` قبلها.

## 7. المصادر الرسمية

### Cloudflare

- https://www.cloudflare.com/products/workers/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/
- https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/cloudflare-one/setup/

### Firebase

- https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- https://firebase.google.com/docs/auth
- https://firebase.google.com/docs/auth/users
- https://firebase.google.com/docs/auth/limits
- https://firebase.google.com/docs/firestore/quotas
- https://firebase.google.com/docs/firestore/solutions/schedule-export
- https://firebase.google.com/docs/firestore/manage-data/transactions

### Supabase

- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/free-project-pausing
- https://supabase.com/docs/guides/platform/backups
- https://supabase.com/docs/guides/platform/billing-faq

### Appwrite

- https://appwrite.io/pricing
- https://appwrite.io/changelog/entry/2026-02-20-1
- https://appwrite.io/changelog
- https://appwrite.io/docs/advanced/billing/database-reads-and-writes

### Google Apps Script

- https://developers.google.com/apps-script/manifest/web-app-api-executable
- https://developers.google.com/apps-script/guides/services/quotas
- https://developers.google.com/apps-script/reference/lock/lock-service
