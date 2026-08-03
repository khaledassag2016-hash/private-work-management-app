# S2 — التحقق من التكلفة والبطاقة والحصص

- تاريخ التحقق: 2026-08-03
- الحالة: أدلة رسمية حالية؛ لا خدمة سحابية أُنشئت أثناء التحقق.

## 1. ضابط المشروع

لا يقبل أي عنصر إنتاجي يحتاج اشتراكًا أو بطاقة بنكية أو تفعيل فوترة، ولا يقبل overage تلقائيًا. الترقية المدفوعة ليست مسار تشغيل بديلًا؛ بلوغ الحصة يجب أن ينتج فشلًا واضحًا قابلًا للمراقبة.

## 2. التكوين المعتمد

| المكون | الخطة | البطاقة/الفوترة | الحصة أو السلوك المجاني | سلوك التجاوز/الخمول |
|---|---|---|---|---|
| Workers Static Assets | Workers Free | لا اشتراك إضافي ولا بطاقة | طلبات الأصول الثابتة مجانية وغير محدودة، ولا تكلفة تخزين إضافية للأصول وفق الوثائق الحالية | عند إجبار الطلب على Worker تسري حصة Worker؛ لا fallback صامت بعد التجاوز |
| Cloudflare Workers API | Free | Cloudflare يعلن البدء دون بطاقة | 100,000 طلب/يوم، 10ms CPU لكل استدعاء | تجاوز الحد المتكرر ينهي الاستدعاء؛ لا يسمح بالترقية المدفوعة |
| Cloudflare D1 | Workers Free | لا اشتراك منفصل ما دام الحساب Free | 5M صف مقروء/يوم، 100k صف مكتوب/يوم، 5GB إجمالي، 500MB لكل قاعدة | أخطاء أو توقف عمليات عند بلوغ الحدود، بلا overage على Free |
| Firebase Authentication | Spark | لا معلومات دفع مطلوبة في Spark | Email/Password لحسابين فقط ضمن حدود أعلى كثيرًا من الحمل المتوقع | لا Blaze ولا Billing؛ Phone/SMS غير مستخدم |
| نطاق التشغيل الأولي | `workers.dev` | مجاني مع حساب Workers | نقطة بدء تلقائية/قابلة للتهيئة | لا يشترط شراء نطاق أو Custom Domain |

Cloudflare Pages ليس عنصرًا في التكوين الأساسي؛ يبقى بديلًا احتياطيًا لا يستخدم إلا بقرار لاحق.

## 3. إعداد Firebase المجاني الملزم

- تمكين Email/Password فقط.
- إنشاء الحسابين إداريًا بواسطة المشرف.
- تعطيل self-sign-up وحذف الحساب من المستخدم النهائي.
- تعطيل Phone/SMS وAnonymous وأي مزود آخر دون قرار جديد.
- Firebase للمصادقة فقط؛ لا Firestore ولا تخزين بيانات أعمال.

## 4. عناصر ممنوعة

- Cloudflare Zero Trust Access.
- Workers Paid أو أي ترقية لمعالجة حد CPU.
- Firebase Blaze.
- Phone Authentication/SMS.
- Billing Account أو بطاقة أو وسيلة دفع.
- نطاق مدفوع بوصفه شرط تشغيل.
- Firestore managed backup/PITR/export.

## 5. بوابة CPU

Workers Free يفرض 10ms CPU لكل استدعاء، وتذكر وثائق Cloudflare أن أعمال المصادقة الثقيلة قد تستخدم 10–20ms. لذلك تبدأ S3 بعد الموافقة المستقلة بقياس تحقق Firebase ID Token فعليًا على Workers Free.

إذا تكرر تجاوز الحد أو إنهاء الاستدعاءات بصورة قابلة لإعادة الإنتاج، يتوقف S3 وتعود المسألة إلى بوابة القرار أو بديل مجاني موثق. يمنع Workers Paid أو تفعيل فوترة.

## 6. البدائل الأخرى

| البديل | الدليل المجاني | مانع المشروع |
|---|---|---|
| Firebase متكامل | Spark دون معلومات دفع | النسخ والتصدير المدار يحتاجان فوترة، والنموذج أقل ملاءمة للعلاقات المالية |
| Supabase Free | $0، قاعدة علائقية | توقف الخمول بعد أسبوع وفجوة إثبات البطاقة لكل مسار Free |
| Appwrite Free | $0 وحدود كافية | توقف الخمول واحتمال الحذف وعدم وجود backup مجاني |
| Apps Script | حصص مجانية | الهوية الدقيقة وسلامة البيانات |

## 7. مخاطر تغير الخطط

- يعاد فتح المصادر الرسمية في يوم إنشاء أي بيئة أو نشر.
- يوثق عدم وجود بطاقة أو Billing Account.
- تراقب الحصص وتبقى الترقية المدفوعة ممنوعة.
- يحافظ تصدير SQL/JSON على قابلية النقل عند تغير الخطة.

## 8. المصادر الرسمية

- Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Static Assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- workers.dev: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Firebase plans: https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- Firebase Email/Password: https://firebase.google.com/docs/auth/web/password-auth
- Firebase Auth limits: https://firebase.google.com/docs/auth/limits
- Firebase ID token verification: https://firebase.google.com/docs/auth/admin/verify-id-tokens
- Supabase pricing: https://supabase.com/pricing
- Supabase pausing: https://supabase.com/docs/guides/platform/free-project-pausing
- Appwrite pricing: https://appwrite.io/pricing
- Appwrite pausing: https://appwrite.io/changelog/entry/2026-02-20-1
- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
