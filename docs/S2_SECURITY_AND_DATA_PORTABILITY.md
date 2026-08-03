# S2 — الأمن وقابلية نقل البيانات

## 1. حدود الوثيقة

هذه خطة معمارية واختبار محلي وليست تنفيذ S3. لم ينشأ حساب Firebase أو Worker أو D1 حقيقي، ولم تستخدم بيانات حقيقية.

## 2. الاستضافة ومسار الطلب

- الواجهة الأساسية تنشر عبر **Cloudflare Workers Static Assets**.
- يبدأ التشغيل على نطاق `workers.dev` المجاني؛ شراء نطاق ليس شرطًا.
- Cloudflare Pages بديل احتياطي فقط يحتاج قرارًا معماريًا لاحقًا.
- كل مسار API خاص يمر عبر Cloudflare Worker.
- D1 متاحة للـWorker من خلال binding داخلي فقط، ولا توجد بيانات اعتماد D1 في الواجهة أو مسار وصول مباشر.
- أي فشل في المصادقة أو التفويض أو قاعدة البيانات يرفض الطلب؛ لا guest mode ولا bypass.

## 3. إعداد Firebase Authentication

1. تمكين **Email/Password** فقط.
2. إنشاء حسابين فقط بواسطة المشرف.
3. تعطيل self-sign-up.
4. تعطيل حذف الحساب من المستخدم النهائي.
5. تعطيل Phone/SMS وAnonymous وأي مزود آخر.
6. لا يضاف مزود تسجيل دخول دون قرار لاحق وفحص تكلفة وبطاقة.
7. Firebase يخزن الهوية فقط، ولا يخزن بيانات العملاء أو الأعمال.

## 4. تدفق Firebase ID Token

1. يسجل أحد الحسابين دخوله عبر Email/Password ويحصل على ID token.
2. يرسل الرمز إلى Worker عبر HTTPS.
3. يقرأ Worker header ويقبل `alg=RS256` فقط ويشترط `kid`.
4. يجلب Worker شهادات Google X.509 العامة من endpoint الرسمي.
5. يختار الشهادة المطابقة لـ`kid` ويستخرج SubjectPublicKeyInfo للتحقق من التوقيع.
6. يخزن الشهادات مؤقتًا حسب `Cache-Control: max-age`، ويعيد الجلب عند الانتهاء أو ظهور `kid` جديد.
7. يتحقق من `aud` و`iss` و`exp` و`iat` و`auth_time` و`sub`، مع اشتراط `sub` غير فارغ.
8. يطابق `sub` بسجل نشط في `app_users`.
9. أي خطأ أو تعذر شبكة أو شهادة أو توقيع أو مطالبة أو UID يرفض الطلب Fail closed.

المصدر الرسمي: https://firebase.google.com/docs/auth/admin/verify-id-tokens

## 5. فرض شخصين فقط

المخطط يفرض:

- الأدوار محصورة في `person_1` و`person_2`.
- لا يزيد عدد المستخدمين النشطين على اثنين.
- لا يتكرر الدور النشط.
- التهيئة الأولى تستخدم INSERT ذريًا.
- لا يستخدم `INSERT OR REPLACE` لأنه قد يحذف الصف ثم يعيد إنشاؤه ويؤثر في العلاقات.
- إعادة provisioning بالزوج نفسه idempotent؛ أما استبدال UID فيحتاج migration مستقلة ومراجعة.

`prototype/s2_local_architecture/schema.sql` هو مصدر المخطط التنفيذي الوحيد؛ يقرأه `core.py` مباشرة، ويختبر وجود الفهارس والمحفزات وتنفيذها.

## 6. التهديدات والضوابط

| التهديد | الضابط | دليل S2 المحلي |
|---|---|---|
| رمز مزور أو معدل | RS256 وX.509 وkid والمطالبات | اختبارات التوقيع والمطالبات السلبية |
| شهادة غير مطابقة | اختيار الشهادة المطابقة لـkid فقط | اختبار cache ومفتاحين واختبار X.509 |
| فشل endpoint أو cache metadata | Fail closed | اختبارات الشبكة وHTTP وغياب max-age |
| حساب Firebase ثالث | allowlist وقيود app_users | رفض UID ثالث ورفض مستخدم نشط ثالث |
| دور نشط مكرر | partial unique index | اختبار duplicate active role |
| إعادة provisioning مدمرة | منع الاستبدال وINSERT OR REPLACE | اختبار رفض الزوج المختلف |
| كتابة متعارضة | version وتحديث شرطي | اختبار stale write |
| العبث بالتدقيق | append-only triggers | رفض UPDATE وDELETE |
| تخزين ملفات العمل | لا أعمدة file/blob/attachment | اختبار FR-027 |

## 7. بوابة CPU قبل S3

حد Workers Free هو 10ms CPU لكل استدعاء. بعد موافقة مستقلة على بيئة مجانية، يجب أن تكون أول خطوة في S3 قياس المسار الكامل للتحقق، مع cache hit وcache miss.

إذا تكرر تجاوز الحد أو إنهاء الاستدعاء بصورة قابلة لإعادة الإنتاج، يتوقف S3 وتعود المعمارية إلى بوابة القرار أو بديل مجاني موثق. يمنع Workers Paid أو Billing أو البطاقة.

المصدر: https://developers.cloudflare.com/workers/platform/limits/

## 8. سجل التدقيق

يسجل لكل عملية حساسة الكيان والمعرف ونوع العملية وUID والوقت UTC والقيم السابقة والجديدة ومعرف الطلب في التنفيذ الفعلي. النموذج يثبت append-only محليًا، ويعاد اختبار D1 الحقيقي في S3 بعد الموافقات.

## 9. الأموال

كل قيمة مالية تخزن كعدد صحيح من الهللات داخل INTEGER ضمن المجال الآمن، ويحظر REAL/FLOAT/DOUBLE وfloating point. قاعدة التقريب غير مفترضة ومسجلة Q-004.

## 10. التصدير والنسخ

### SQL

- `wrangler d1 export` لإنتاج SQL.
- الاستعادة إلى D1 جديدة أو SQLite متوافقة.
- النسخة الفعلية تحفظ خارج GitHub على وسيط محلي مشفر.

### JSON

- تصدير بإصدار schema واضح يشمل المستخدمين المجهزين دون كلمات مرور، والعملاء والأعمال والحركات والتدقيق.
- اختبار round-trip محلي.

### الهوية عند الانتقال

لا تعد كلمات المرور بيانات أعمال قابلة للتصدير. عند تغيير مزود الهوية تنشأ هويتان جديدتان وتحدث خريطة UID بعملية إدارية موثقة، مع بقاء بيانات SQL/JSON مستقلة.

## 11. نقاط مؤجلة

- قياس CPU الحقيقي وبوابة التوقف في S3.
- إعداد Firebase Console الفعلي وتعطيل المزودين.
- اختبار D1 bindings والمعاملات والمحفزات سحابيًا.
- اختبار الاستعادة الفعلية في S10.
- إعادة التحقق من الخطط قبل أي إنشاء أو نشر.

## 12. المصادر الرسمية

- Workers Static Assets: https://developers.cloudflare.com/workers/static-assets/
- workers.dev: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Firebase Email/Password: https://firebase.google.com/docs/auth/web/password-auth
- Firebase users: https://firebase.google.com/docs/auth/users
- Firebase token verification: https://firebase.google.com/docs/auth/admin/verify-id-tokens
- D1 query semantics: https://developers.cloudflare.com/d1/best-practices/query-d1/
- D1 foreign keys: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- D1 import/export: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
