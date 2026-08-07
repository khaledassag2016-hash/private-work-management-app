# SECURITY-REVIEW — B3/B4/B8

## الحالة

`READY FOR INDEPENDENT SUPERVISORY REVIEW — NOT MERGED`

لم ينفذ Cloud أو Login أو Billing أو Live CPU Gate ضمن هذه المرحلة. التنفيذ والاختبارات يستخدمان mocks وSimulation فقط.

## B3 — Firebase fail-closed

- فشل قراءة أي مجموعة من مجموعات مزودي الهوية يوقف التنفيذ.
- كل PATCH يعاد التحقق منه بقراءة مستقلة للمجموعات الثلاث.
- لا تسجل `emailPasswordOnly=true` أو `otherProviders=false` قبل اكتمال الإثبات.
- القيم المفقودة أو null أو غير المنطقية في الإعدادات الإلزامية تفشل.
- يتحقق المسار من Email/Password وpassword required وتعطيل Phone وAnonymous وduplicate emails وself-sign-up وحذف المستخدم.
- يثبت أن المشروع فارغ قبل إنشاء المستخدمين، ثم يحتوي حسابين اصطناعيين فقط دون هاتف أو provider links.

## B4 — Cloudflare cleanup fail-closed

- يحلل كل Exit Code لحذف Worker وD1 على حدة.
- يعاد الاستعلام عبر API القراءة الرسمية لإثبات غياب الاسم والمعرف.
- التحقق محدود بثلاث محاولات قصيرة؛ انتهاء المحاولات أو فشل JSON/API لا ينتج `DELETED`.
- الحذف الجزئي ينتج `PARTIAL` أو `FAIL` ولا يسمح بالانتقال إلى `80_RESOURCES_DESTROYED`.
- التقارير تستخدم Account ID منقحًا ولا تتضمن token أو مخرجات CLI الحساسة.

## B8 — الجلسات والأسرار المؤقتة

- تسجل حالة Firebase CLI وgcloud وWrangler قبل أي تسجيل دخول.
- لا توجد أوامر login تلقائية.
- الجلسات السابقة لا تلمس.
- الجلسات المملوكة للتشغيل فقط تنظف، وفشل logout أو revoke يجعل cleanup FAIL.
- إعداد gcloud المؤقت، عند استخدامه، يجب أن يكون داخل `temp` ومعزولًا عبر `CLOUDSDK_CONFIG`.
- RuntimeSecrets والبيئة المملوكة وملفات SQL والإعدادات المؤقتة تنظف قبل نجاح التقرير.

## المصادر الرسمية لـB8

تاريخ الاطلاع: 2026-08-06.

- Firebase CLI reference: https://firebase.google.com/docs/cli
- gcloud configurations and `CLOUDSDK_CONFIG`: https://cloud.google.com/sdk/gcloud/reference/topic/configurations
- gcloud auth revoke: https://cloud.google.com/sdk/gcloud/reference/auth/revoke
- Wrangler authentication, `auth token`, login and logout: https://developers.cloudflare.com/workers/wrangler/commands/general/
