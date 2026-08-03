# S2 — التحقق من التكلفة والبطاقة والحصص

- تاريخ التحقق: 2026-08-03
- الحالة: أدلة رسمية حالية؛ لا خدمة سحابية أُنشئت أثناء التحقق.

## 1. ضابط المشروع

لا يقبل أي عنصر إنتاجي يحتاج اشتراكًا أو بطاقة بنكية أو تفعيل فوترة، ولا يقبل overage تلقائيًا. الترقية المدفوعة ليست مسار تشغيل بديلًا؛ بلوغ الحصة يجب أن ينتج فشلًا واضحًا قابلًا للمراقبة.

## 2. التكوين المقترح

| المكون | الخطة | البطاقة/الفوترة | الحصة المجانية الأساسية | سلوك التجاوز | الخمول |
|---|---|---|---|---|---|
| Cloudflare Workers | Free | Cloudflare يعلن البدء دون بطاقة | 100,000 طلب/يوم، 10ms CPU لكل استدعاء | العمليات اللاحقة تفشل عند بلوغ حدود Free | لا توقف خمول موثق |
| Cloudflare D1 | Workers Free | لا اشتراك منفصل ولا فوترة ما دام الحساب Free | 5M صف مقروء/يوم، 100k صف مكتوب/يوم، 5GB إجمالي | الاستعلامات ترجع أخطاء حتى إعادة الضبط؛ لا overage على Free | لا توقف خمول موثق |
| D1 database | Free | — | 500MB لكل قاعدة، 10 قواعد، Time Travel سبعة أيام | يمنع إدخال بيانات جديدة عند بلوغ التخزين حتى التنظيف | لا توقف خمول موثق |
| Firebase Authentication | Spark | لا معلومات دفع مطلوبة | معظم المصادقة مجانية؛ 3,000 DAU بعد ترقية Identity Platform على Spark | حدود/حماية إساءة استخدام؛ لا Blaze دون ربط حساب فوترة | لا توقف خمول موثق |

الحمل المتوقع لشخصين أقل كثيرًا من هذه الحدود، لكن لا يعتمد التصميم على هذا الافتراض وحده؛ يجب إضافة مراقبة استهلاك وتنبيه داخلي في مراحل التنفيذ.

## 3. عناصر ممنوعة في التكوين

### Cloudflare Zero Trust Access

رغم وجود خطة Free، توضح وثائق الإعداد الحالية أن إنشاء منظمة Zero Trust يتطلب اختيار خطة وإدخال بيانات دفع حتى عند اختيار Free. لذلك لا يدخل Zero Trust Access في التوصية.

### Firebase Blaze أو خدمات Firestore المدفوعة

لا يربط حساب فوترة ولا يستخدم Blaze. النسخ الاحتياطية المدارة وPITR وRestore وخدمة export/import المدارة في Firestore خارج التكوين؛ فهي تتطلب فوترة. تستخدم Firebase للمصادقة فقط في البديل المقترح.

## 4. البدائل الأخرى

| البديل | الدليل المجاني | سلوك التجاوز | مانع المشروع |
|---|---|---|---|
| Supabase Free | $0، 500MB، 50k MAU، مشروعان | إشعار ثم قيود خدمة عند الاستمرار في التجاوز | توقف بعد أسبوع من انخفاض النشاط؛ عدم وجود نص حديث صريح يثبت عدم طلب بطاقة في كل مسار Free |
| Appwrite Free | $0، 75k MAU، 500k قراءة، 250k كتابة | القراءة/الكتابة تُخنق على Free | توقف بعد 7 أيام دون نشاط تطويري، واحتمال حذف بعد 90 يومًا من التوقف، ولا نسخ احتياطي مجاني |
| Apps Script | حصص خدمة دون اشتراك إنتاجي مستقل | استثناء وإيقاف التنفيذ عند تجاوز الحصة | ليس مانع التكلفة الأساسي؛ المانع هو الهوية وسلامة البيانات |

## 5. مخاطر تغير الخطط

- جميع الخطط المجانية قابلة للتغيير؛ لذلك تحفظ روابط المصدر وتاريخ التحقق داخل المستودع.
- Appwrite غيّر حد الوظائف المجانية وطبق توقف الخمول والحذف خلال 2026، لذا يصنف خطر تغيره مرتفعًا.
- Supabase يربط الاستمرارية بعدم الخمول أو الترقية، لذا يصنف خطر التوافر على Free مرتفعًا.
- Firebase وCloudflare قد يغيران الحصص، لكن التكوين المقترح يفصل البيانات بصيغة SQL مفتوحة ويمنع الفوترة، ما يقلل أثر التغيير ولا يلغيه.

## 6. بوابة ما قبل أي نشر مستقبلي

قبل إنشاء الخدمات في مرحلة لاحقة وبعد موافقة منفصلة:

1. إعادة فتح صفحات التسعير والحدود الرسمية في اليوم نفسه.
2. تصوير أو توثيق شاشة الخطة التي تؤكد عدم وجود بطاقة أو فوترة.
3. التحقق من أن الحسابين على Free/Spark دون Billing Account.
4. ضبط مراقبة الحصص.
5. تنفيذ اختبار تجاوز مصغر أو محاكاة موثقة دون إحداث تكلفة.

## 7. المصادر الرسمية

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare D1 pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Cloudflare no-card statement: https://www.cloudflare.com/products/workers/
- Cloudflare Zero Trust setup: https://developers.cloudflare.com/cloudflare-one/setup/
- Firebase plans: https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- Firebase Auth limits: https://firebase.google.com/docs/auth/limits
- Firestore quotas: https://firebase.google.com/docs/firestore/quotas
- Firestore managed export billing: https://firebase.google.com/docs/firestore/solutions/schedule-export
- Supabase pricing: https://supabase.com/pricing
- Supabase pausing: https://supabase.com/docs/guides/platform/free-project-pausing
- Supabase billing FAQ: https://supabase.com/docs/guides/platform/billing-faq
- Appwrite pricing: https://appwrite.io/pricing
- Appwrite pausing: https://appwrite.io/changelog/entry/2026-02-20-1
- Apps Script quotas: https://developers.google.com/apps-script/guides/services/quotas
