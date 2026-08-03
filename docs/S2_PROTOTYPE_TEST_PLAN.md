# S2 — خطة النموذج الأولي والاختبارات

## 1. الغرض

إثبات الحد الأدنى من صلاحية المعمارية المعتمدة وتصحيحات المراجعة المستقلة دون إنشاء خدمة سحابية ودون بيانات حقيقية. النموذج لا يبني شاشات ولا ينفذ وظائف S3–S8.

## 2. مكونات النموذج

- `prototype/s2_local_architecture/schema.sql`: **المصدر التنفيذي الوحيد للمخطط** المتوافق مع SQLite/D1.
- `prototype/s2_local_architecture/core.py`: يقرأ `schema.sql` مباشرة، ويطبق provisioning الحتمي والتزامن والتدقيق والتصدير.
- `prototype/worker_auth/auth.mjs`: تحقق Firebase ID Token باستخدام Web Crypto، وشهادات X.509، واختيار `kid`، وcache حسب `max-age`، وفشل مغلق.
- `tests/test_s2_architecture_prototype.py`: اختبارات البيانات والقيود والتفويض والتصدير وتطابق مصدر المخطط.
- `tests/test_worker_auth.mjs`: اختبارات التوقيع والشهادات والمفاتيح والمطالبات وقائمة السماح والفشل المغلق.
- `scripts/validate_s2.py`: مدقق محلي حتمي بلا حزم تطبيق خارجية.

## 3. البيانات والمفاتيح الوهمية

- UIDs مصطنعة: `uid-person-1` و`uid-person-2` وUID ثالث سلبي.
- عميل وعمل وعناوين وهمية.
- مفاتيح RSA للاختبارات تولد مؤقتًا ولا تحفظ.
- اختبار X.509 يولد شهادة self-signed مؤقتة محليًا بواسطة OpenSSL، ويؤكد أنها من نوع `BEGIN CERTIFICATE`، ثم يحذفها.
- endpoint Google ممثل بـmock محلي؛ لا اتصال بـFirebase أو Cloudflare.

## 4. حالات اختبار البيانات — 11 اختبار Python

| ID | الحالة | المتوقع |
|---|---|---|
| S2-P01 | الشخص الأول ينشئ والثاني يقرأ ويعدل لاحقًا | نجاح وتسجيل UID الثاني |
| S2-P02 | UID غير مجهز يحاول القراءة | رفض `AuthorizationError` |
| S2-P03 | تحديث بإصدار قديم | رفض `ConflictError` |
| S2-P04 | تعديل أو حذف سجل التدقيق | رفض من محفزات append-only |
| S2-P05 | تصدير JSON ثم استعادة | تطابق البيانات والتدقيق |
| S2-P06 | تصدير SQL | وجود المخطط والصفوف |
| S2-P07 | فحص FR-027 | عدم وجود file/blob/attachment |
| S2-P08 | `schema.sql` مقابل `SCHEMA_SQL` | تطابق حرفي لأن الملف هو المصدر المقروء |
| S2-P09 | إضافة مستخدم نشط ثالث | رفض من schema trigger |
| S2-P10 | تكرار دور نشط | رفض من partial unique index |
| S2-P11 | إعادة provisioning | الزوج نفسه idempotent؛ الزوج المختلف يرفض دون تغيير الصفوف |

## 5. حالات Firebase ID Token — 12 اختبار Node

| ID | الحالة | المتوقع |
|---|---|---|
| S2-A01 | RS256 صحيح وUID مجهز | قبول |
| S2-A02 | UID غير مجهز | رفض |
| S2-A03 | `kid` يختار المفتاح المطابق وcache صالح | نجاح وعدم إعادة الجلب قبل `max-age` |
| S2-A04 | شهادة X.509 وهمية `BEGIN CERTIFICATE` عبر `GooglePublicKeyCache` | استخراج SPKI والتحقق من التوقيع بنجاح |
| S2-A05 | `kid` مفقود أو مجهول | رفض |
| S2-A06 | `auth_time` مفقود أو مستقبلي | رفض |
| S2-A07 | issuer خاطئ | رفض |
| S2-A08 | خوارزمية غير RS256 | رفض قبل استخدام المفتاح |
| S2-A09 | `sub` مفقود أو فارغ | رفض |
| S2-A10 | payload معدل | رفض التوقيع |
| S2-A11 | انتهاء أو `iat` مستقبلي أو audience خاطئ | رفض |
| S2-A12 | فشل الشبكة أو HTTP أو cache metadata | رفض Fail closed |

## 6. أوامر التشغيل

```bash
python scripts/reconstruct_requirements.py
python scripts/validate_foundation.py
python scripts/validate_s2.py
```

يشغل GitHub Actions الأوامر على **synthetic PR merge revision** لاختبار قابلية الدمج مع `main`. يسجل workflow قيمة `GITHUB_SHA` للمراجعة المختبرة، إضافة إلى head وbase SHA؛ ولا يصف checkout بأنه head منفرد.

## 7. معايير النجاح

- 11 اختبار Python ناجحًا.
- 12 اختبار Node ناجحًا.
- الإجمالي 23 اختبار runner.
- `S2 LOCAL VALIDATION: PASS`.
- `RECONSTRUCTION: PASS` بالحجم والبصمة المعتمدين.
- `FOUNDATION VALIDATION: PASS`.
- نجاح بوابات ADR Accepted وD-006 وStatic Assets وEmail/Password و`workers.dev` وحد CPU وقاعدة الهللات.
- عدم وجود بيانات أو أسرار حقيقية.

## 8. ما لا يثبته النموذج

- CPU الفعلي داخل Cloudflare Workers Free.
- إعداد Firebase Console الفعلي وتعطيل المزودين.
- endpoint Google الحقيقي وتدوير الشهادات الفعلي.
- D1 cloud binding أو معاملات D1 تحت حمل فعلي.
- استعادة D1 وTime Travel السحابية.

هذه بنود بوابة S3/S10. أول بوابة S3 هي قياس تحقق الرمز داخل حد 10ms؛ عند التجاوز المتكرر يتوقف التنفيذ ويعود القرار، دون Workers Paid أو فوترة.
