# S2 — مقارنة المعماريات المجانية

- تاريخ التحقق: 2026-08-03
- Issue: #1
- الفرع: `stage-2/free-architecture-evaluation`
- حالة القرار: **معتمد وفق D-006 وADR-001**
- المرجع الحاكم: ملف Word المعاد بناؤه بالحجم `63710` والبصمة `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`

## 1. نطاق المقارنة

تغطي المقارنة استضافة الواجهة، والتنفيذ الخلفي، وقاعدة البيانات، والمصادقة، والعمل لشخصين في أوقات مختلفة، والتصدير والاستعادة، وسلوك الخطة المجانية. لا تشمل إنشاء خدمة سحابية أو بناء شاشات التطبيق.

## 2. البوابات الإلزامية

أي بديل يفشل بوابة واحدة لا يعتمد مهما كانت درجته:

1. لا تكلفة أو اشتراك إلزامي.
2. لا بطاقة بنكية ولا Billing Account ولا تفعيل فوترة.
3. لا overage تلقائي؛ بلوغ الحد ينتج فشلًا واضحًا.
4. لا توقف خمول يمنع الشخصين من استخدام التطبيق عند الحاجة.
5. هوية منفصلة وحصر الوصول في شخصين.
6. مسار تصدير واستعادة مفتوح.
7. عدم تخزين ملفات الأعمال وفق FR-027.
8. عدم الاعتماد على نطاق مدفوع للتشغيل الأولي.

## 3. أوزان التقييم

| المحور | الوزن |
|---|---:|
| التكلفة والبطاقة وسلوك التجاوز | 25% |
| الاستمرارية وعدم توقف الخمول | 15% |
| أمن الهوية وقصر الوصول على شخصين | 20% |
| سلامة البيانات والتزامن وسجل التدقيق | 15% |
| التصدير والنسخ والاستعادة وقابلية النقل | 15% |
| سهولة الصيانة وخطر تغير الخطة | 10% |

## 4. البدائل

### A — Cloudflare Workers Static Assets + Workers API + D1 + Firebase Authentication Spark

**التكوين المعتمد:**

- **Cloudflare Workers Static Assets** للواجهة الأساسية.
- Cloudflare Workers Free للـAPI.
- Cloudflare D1 Free لقاعدة البيانات.
- Firebase Authentication Spark للمصادقة فقط.
- Email/Password لحسابين ينشئهما المشرف.
- تعطيل self-sign-up وحذف الحساب من المستخدم وPhone/SMS وAnonymous وأي مزود آخر.
- التشغيل الأولي على `workers.dev` المجاني؛ لا يشترط نطاق مدفوع.
- Cloudflare Pages بديل احتياطي فقط يحتاج قرارًا لاحقًا.
- تحقق Firebase ID Token داخل Worker ثم قائمة سماح لشخصين داخل D1.
- كل API خاص Fail closed ولا يوجد وصول مباشر إلى D1.

**نقاط القوة:**

- Workers Free وFirebase Spark يحققان شرط عدم البطاقة والفوترة في التكوين المعتمد.
- طلبات Static Assets مجانية وغير محدودة وفق وثائق Cloudflare الحالية، وتدمج الواجهة والـWorker كوحدة نشر.
- `workers.dev` يتيح البدء دون شراء نطاق.
- D1 علائقي بدلالات SQLite ويدعم التصدير إلى SQL.
- البيانات التشغيلية منفصلة عن مزود الهوية.
- قيود `app_users` تفرض مستخدمين نشطين فقط ودورًا نشطًا فريدًا.

**المخاطر والبوابات:**

- مزودان بدل مزود واحد.
- Workers Free يفرض 10ms CPU لكل استدعاء، والأعمال الثقيلة مثل المصادقة قد تقع في 10–20ms وفق وثائق Cloudflare.
- لذلك تبدأ S3 بقياس فعلي؛ إذا تكرر تجاوز الحد يتوقف التنفيذ ويعود إلى بوابة القرار أو بديل مجاني. يمنع Workers Paid والفوترة.
- حد D1 المجاني 500MB لكل قاعدة، ويلزم رصد النمو والتصدير الدوري.

**الحكم:** PASS — معتمد.

### B — Firebase Spark متكامل: Hosting + Authentication + Firestore

**نقاط القوة:** مزود واحد، Spark دون معلومات دفع، معاملات وكتابات مجمعة، وحصص مناسبة لشخصين.

**القيود:** النسخ الاحتياطية المدارة وPITR والتصدير/الاستيراد المدار تتطلب فوترة، والنموذج الوثائقي أقل ملاءمة من SQL للعلاقات المالية والتاريخية، والارتباط بالمزود أعلى.

**الحكم:** PASS مشروط بتصدير تطبيق مستقل؛ بديل مجاني موثق يمكن العودة إلى بوابة القرار لمراجعته إذا فشل حد CPU في البديل A.

### C — Supabase Free

PostgreSQL ومصادقة وتصدير منطقي جيد، لكن مشاريع Free قليلة النشاط قد تتوقف بعد سبعة أيام، والنسخ الاحتياطية الآلية ليست ضمن Free، كما بقي إثبات عدم طلب البطاقة في كل مسار إنشاء غير كافٍ للمشروع.

**الحكم:** FAIL بسبب الخمول وفجوة إثبات البطاقة.

### D — Appwrite Cloud Free

منصة موحدة وحدود كافية، لكن المشروع المجاني يتوقف بعد غياب النشاط التطويري وقد يتعرض للحذف بعد توقف طويل، ولا تتضمن Free نسخًا احتياطية.

**الحكم:** FAIL بسبب الخمول وخطر الحذف.

### E — Google Apps Script + Sheets

سهل وتصديره مباشر، لكن خيارات النشر لا تحصر أصلًا بريدين شخصيين بدقة، وهوية المستخدم قد تكون غامضة في بعض أوضاع التنفيذ، وSheets أضعف في المعاملات والعلاقات المالية.

**الحكم:** FAIL بسبب الهوية وسلامة البيانات.

## 5. مصفوفة النتيجة

| البديل | التكلفة 25 | الاستمرارية 15 | الأمن 20 | سلامة البيانات 15 | النقل 15 | الصيانة 10 | النتيجة /100 | البوابة |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A: Workers Static Assets + D1 + Firebase Auth | 25 | 15 | 18 | 14 | 14 | 8 | **94** | PASS — معتمد |
| B: Firebase متكامل | 25 | 15 | 18 | 11 | 9 | 9 | **87** | PASS مشروط |
| C: Supabase Free | 18 | 3 | 17 | 15 | 14 | 8 | 75 | FAIL |
| D: Appwrite Cloud Free | 16 | 0 | 16 | 12 | 8 | 5 | 57 | FAIL |
| E: Apps Script + Sheets | 22 | 11 | 6 | 7 | 12 | 7 | 65 | FAIL |

## 6. القرار التفصيلي

اعتمد المستخدم البديل A بالشروط الآتية:

1. Workers Static Assets هي الاستضافة الأساسية؛ Pages احتياطية فقط بقرار لاحق.
2. `workers.dev` هو النطاق الأولي المجاني، ولا يشترط نطاق مدفوع.
3. Firebase Authentication يستخدم Email/Password فقط لحسابين ينشئهما المشرف.
4. self-sign-up وحذف الحساب من المستخدم وPhone/SMS وAnonymous وأي مزود آخر معطلة.
5. لا Zero Trust ولا Blaze ولا Workers Paid ولا Billing Account ولا بطاقة.
6. D1 داخل Worker binding فقط، وكل API خاص Fail closed.
7. `app_users` يفرض مستخدمين نشطين فقط ودورًا نشطًا فريدًا.
8. `schema.sql` هو مصدر المخطط الواحد، ولا يستخدم provisioning عبارة `INSERT OR REPLACE`.
9. تخزن الأموال كهللات صحيحة ضمن المجال الآمن.
10. بوابة CPU في S3 مانعة؛ الفشل المتكرر يعيد القرار ولا يجيز الترقية المدفوعة.

## 7. المصادر الرسمية

### Cloudflare

- Workers Static Assets — https://developers.cloudflare.com/workers/static-assets/
- Static Assets billing — https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Workers pricing — https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits وCPU — https://developers.cloudflare.com/workers/platform/limits/
- `workers.dev` — https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- D1 pricing — https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits — https://developers.cloudflare.com/d1/platform/limits/
- D1 export — https://developers.cloudflare.com/d1/best-practices/import-export-data/

### Firebase

- Pricing plans — https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- Sign-in with email and password — https://firebase.google.com/docs/auth/web/password-auth
- User management — https://firebase.google.com/docs/auth/users
- ID token verification — https://firebase.google.com/docs/auth/admin/verify-id-tokens
- Authentication limits — https://firebase.google.com/docs/auth/limits

### البدائل

- Supabase pricing — https://supabase.com/pricing
- Supabase pausing — https://supabase.com/docs/guides/platform/free-project-pausing
- Appwrite pricing — https://appwrite.io/pricing
- Appwrite pausing — https://appwrite.io/changelog/entry/2026-02-20-1
- Apps Script web apps — https://developers.google.com/apps-script/manifest/web-app-api-executable
- Apps Script quotas — https://developers.google.com/apps-script/guides/services/quotas
