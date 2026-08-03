# S2 — الأمن وقابلية نقل البيانات

## 1. حدود هذه الوثيقة

هذه خطة معمارية وليست تنفيذ S3. النموذج المحلي يستخدم مفاتيح وهوية وهمية فقط ولا ينشئ حساب Firebase أو Worker أو قاعدة D1 حقيقية.

## 2. تدفق الهوية المقترح

1. ينشئ المشرف حسابين فقط في Firebase Authentication، من Console أو Admin SDK.
2. تعطل إجراءات إنشاء الحساب وحذفه من المستخدم النهائي في إعدادات Firebase Authentication.
3. يسجل كل شخص دخوله ويحصل على Firebase ID token.
4. يرسل المتصفح الرمز إلى Cloudflare Worker عبر HTTPS.
5. يحقق Worker من:
   - خوارزمية RS256 والتوقيع باستخدام مفاتيح Google العامة الموثوقة.
   - `iss` و`aud` و`exp` و`iat` و`sub`.
   - وجود `sub` بوصفه UID نشطًا في جدول `app_users` داخل D1.
6. لا يعني وجود حساب Firebase الإذن بالدخول؛ قائمة D1 هي بوابة التفويض النهائية.
7. لا يتصل المتصفح بـ D1 مباشرة؛ الوصول يكون عبر Worker binding فقط.

## 3. قائمة السماح الدقيقة

جدول `app_users` يحتوي سجلين نشطين فقط:

- UID للشخص الأول مع الدور `person_1`.
- UID للشخص الثاني مع الدور `person_2`.

أي UID ثالث يرفض افتراضيًا. إلغاء وصول أحد الشخصين يتم بتعطيل السجل، دون حذف تاريخه من سجل التدقيق.

## 4. التهديدات والضوابط

| التهديد | الضابط المقترح | دليل النموذج المحلي |
|---|---|---|
| رمز مزور أو معدل | تحقق RS256 وissuer/audience/expiry | اختبار توقيع صحيح، وتوقيع معدل، وانتهاء، وaudience خاطئ |
| حساب Firebase غير مصرح | UID allowlist داخل D1 | اختبار رفض UID غير مجهز |
| تعديل متزامن ضائع | `version` وتحديث شرطي داخل معاملة | اختبار رفض stale write |
| العبث بسجل التدقيق | سجل append-only ومنع UPDATE/DELETE | اختبارا رفض التعديل والحذف |
| مستخدمان في أوقات مختلفة | بيانات مركزية وهوية مستقلة | اختبار إنشاء الشخص الأول وتعديل الشخص الثاني لاحقًا |
| تسرب أسرار | أسرار البيئة في Cloudflare Secrets/Firebase config المناسب، لا في GitHub | فحص الملفات لا يحتوي مفاتيح أو كلمات مرور حقيقية |
| تخزين ملفات العمل | لا جداول ولا أعمدة file/blob/attachment | اختبار schema مستقل لـ FR-027 |

## 5. سجل التدقيق

يجب أن يسجل لكل عملية حساسة:

- الكيان والمعرف.
- نوع العملية.
- UID الفاعل.
- الوقت UTC.
- القيم السابقة والجديدة عند التعديل.
- معرف طلب أو correlation ID في التنفيذ الفعلي.

النموذج المحلي يثبت append-only على SQLite. توافق triggers والسلوك النهائي على D1 يعاد اختباره في S3 قبل اعتماد أي كود إنتاجي.

## 6. التصدير والنسخ الاحتياطي

### نسخة SQL حاكمة للبيانات

- تصدير D1 إلى ملف SQL باستخدام `wrangler d1 export`.
- استعادة الملف إلى قاعدة D1 جديدة أو SQLite متوافقة باستخدام أوامر SQL.
- يحفظ التصدير خارج GitHub على وسيط محلي مشفر يملكه المستخدمان.
- لا تحفظ نسخ بيانات فعلية في Actions artifacts أو المستودع.

### تصدير JSON للتطبيق

ينفذ التطبيق تصديرًا مستقلًا بإصدار schema واضح، يشمل:

- المستخدمين المجهزين بالأدوار والحالة، دون كلمات مرور.
- العملاء والأعمال والحركات وسجل التدقيق.
- metadata للتاريخ وإصدار schema.

يستخدم JSON لاختبار round-trip ونقل انتقائي، بينما SQL هو النسخة الكاملة منخفضة المستوى.

### الاستعادة

- اختبار الاستعادة المحلي جزء من S2.
- اختبار استعادة D1 حقيقي يؤجل إلى S10 وبعد إذن إنشاء الخدمة.
- Time Travel لمدة 7 أيام آلية تعاف تشغيلية قصيرة فقط، وليست نسخة احتياطية مستقلة.

### هوية Firebase عند الانتقال

كلمات المرور لا تعامل بوصفها بيانات أعمال قابلة للتصدير. عند الانتقال من Firebase:

1. تنشأ هويتان في مزود المصادقة الجديد.
2. تحدث خريطة UID في `app_users` بعملية إدارية موثقة.
3. تبقى سجلات الأعمال والتدقيق في SQL/JSON مستقلة عن مزود الهوية.

## 7. ملكية البيانات والارتباط بالخدمة

- البيانات التشغيلية والمالية تبقى في جداول SQL قابلة للتصدير.
- لا تستخدم أنواعًا مغلقة أو ملفات ثنائية خاصة بالمزود.
- migrations تحفظ كملفات SQL في GitHub.
- طبقة repository في التطبيق تمنع انتشار واجهة D1 في منطق الأعمال.
- Firebase محصور في المصادقة؛ لا تخزن فيه بيانات العمل.

## 8. نقاط مؤجلة إلى S3/S10

- جلب مفاتيح Google العامة وتخزينها المؤقت واحترام مدة صلاحيتها.
- قياس CPU الفعلي للتحقق من JWT داخل Worker Free.
- ضبط headers والجلسات وCSRF/CORS وContent Security Policy.
- اختبار D1 triggers والمعاملات تحت التنفيذ الحقيقي.
- اختبار استعادة SQL إلى D1 جديدة.

## 9. المصادر الرسمية

- Firebase user management and disabling end-user actions: https://firebase.google.com/docs/auth/users
- Firebase Admin user creation: https://firebase.google.com/docs/auth/admin/manage-users
- Firebase custom claims/access: https://firebase.google.com/docs/auth/admin/custom-claims
- D1 SQL semantics: https://developers.cloudflare.com/d1/best-practices/query-d1/
- D1 foreign keys: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- D1 batch transactions: https://developers.cloudflare.com/d1/worker-api/d1-database/
- D1 import/export: https://developers.cloudflare.com/d1/best-practices/import-export-data/
- D1 limits and Time Travel: https://developers.cloudflare.com/d1/platform/limits/
