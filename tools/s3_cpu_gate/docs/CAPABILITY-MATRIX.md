# CAPABILITY-MATRIX — S3 CPU Gate Tooling

- **تاريخ التحقق:** 2026-08-03
- **نطاق الإثبات:** إثبات قابلية التنفيذ الرسمية قبل كتابة المسار التشغيلي.
- **المستودع:** `khaledassag2016-hash/private-work-management-app`
- **مرجع البداية المتحقق منه:** `main@f4951b9bc28bcf6547294174377d10b1fc7a6439`
- **النتيجة:** **GATE A — PASS WITH FAIL-CLOSED RUNTIME PROBES**

> معنى النتيجة: توجد طريقة رسمية لكل قدرة حاكمة. لا تُفترض صلاحية حساب المستخدم أو خطته؛ بل تُختبر عند التشغيل، وأي عجز عن الإثبات يوقف التشغيل قبل إنشاء الموارد.

## مفاتيح الحالة

- **آلي:** تنفذه الحزمة دون تدخل تقني.
- **متصفح:** يحتاج تسجيل دخول رسمي فقط.
- **موافقة:** شاشة عربية نعم/لا.
- **Fail closed:** أي غموض أو نقص صلاحية يؤدي إلى التوقف، لا إلى التخمين.

## GitHub

| العملية | الطريقة الرسمية | الأداة/API | آلي | متصفح | موافقة | التبسيط اليدوي | الفشل والتراجع |
|---|---|---|---:|---:|---:|---|---|
| تسجيل الدخول | Device/browser flow | `gh auth login --web` | جزئي | نعم | لا | تفتح الصفحة الرسمية | توقف بلا تغيير |
| الوصول للمستودع الخاص | فحص صلاحية ثم clone | `gh repo view`, `gh repo clone` | نعم | عند الحاجة | لا | لا أوامر يدوية | حذف النسخة المحلية الجزئية |
| أحدث `main` | fetch/checkout/pull | Git + GitHub | نعم | لا | لا | — | توقف إذا الشجرة غير نظيفة |
| التحقق من commit | `git rev-parse` ومقارنة GitHub | Git/GitHub API | نعم | لا | لا | — | تقرير تعارض حاكم |
| إنشاء فرع | فرع واحد من أحدث main | Git | نعم | لا | نعم قبل الكتابة | زر متابعة | حذف الفرع المحلي إذا لم يُدفع |
| push | دفع الفرع المحدد فقط | Git | نعم | لا | ضمن موافقة المرحلة | — | لا force-push؛ إعادة آمنة فقط |
| Draft PR | `gh pr create --draft` | GitHub CLI | نعم | لا | ضمن موافقة المرحلة | — | لا PR ثانية؛ كشف القائمة أولًا |
| قراءة CI | `gh pr checks`, Actions API | GitHub CLI/API | نعم | لا | لا | ملخص عربي | توقف عند فشل/عدم اكتمال |
| عدم الدمج | لا يوجد أمر merge في المسار | حارس ساكن واختبارات | نعم | لا | لا | — | أي محاولة = فشل أمني |
| عدم إغلاق Issue #2 | صياغة `Relates to #2` فقط | فحص نص PR | نعم | لا | لا | — | رفض عبارات `Closes/Fixes` |

## الأدوات المحلية

| الأداة | مسار الإثبات/التثبيت | السياسة |
|---|---|---|
| PowerShell 7 | ZIP رسمي محمول من إصدار PowerShell، مع SHA-256 المنشور | داخل `tools`, بلا PATH دائم |
| Git | Git for Windows رسمي أو الموجود بعد التحقق | داخل `tools` قدر الإمكان |
| GitHub CLI | إصدار رسمي من GitHub CLI أو الموجود | داخل `tools` |
| Node.js/npm | ZIP رسمي من nodejs.org + `SHASUMS256.txt` | داخل `tools` |
| Firebase CLI/Wrangler | npm محلي بإصدارات مقفلة | داخل `tools/node_modules` |
| Google Cloud CLI | الأرشيف الرسمي عند الحاجة فقط | داخل `tools`/المستخدم، بلا Billing |
| Python | الموجود أو نسخة رسمية محلية؛ ليس لازمًا للمسار الحاكم | داخل `python` |
| Pester/PSScriptAnalyzer | PowerShell Gallery الرسمي، نسخ مقفلة | داخل `modules` |

كل تنزيل يعرض الاسم والغرض والمصدر والحجم المتوقع، ويتحقق من HTTPS وSHA-256 أو التوقيع/manifest الرسمي. فشل التحقق يمنع الاستخدام ويحذف الملف.

## Firebase / Google Cloud

| العملية | الطريقة الرسمية | آلي | متصفح | ملاحظات الحارس |
|---|---|---:|---:|---|
| تسجيل الدخول | `firebase login` و`gcloud auth login` | جزئي | نعم | لا service-account JSON |
| إنشاء المشروع | `firebase projects:create` | نعم | لا | Project ID مولد ويحمل Run ID |
| إضافة Firebase/Web App | Firebase CLI | نعم | لا | تطبيق Web واحد فقط عند الحاجة |
| إثبات Spark وعدم Billing | `gcloud billing projects describe` | نعم | لا | يشترط `billingEnabled=false` واسم Billing فارغ |
| تهيئة Auth | Identity Toolkit Admin v2 | نعم | لا | OAuth في الذاكرة فقط |
| Email/Password فقط | `projects.updateConfig` | نعم | لا | email enabled/passwordRequired |
| تعطيل self-sign-up | `client.permissions.disabledUserSignup=true` | نعم | لا | تحقق GET بعد PATCH |
| تعطيل حذف الحساب | `disabledUserDeletion=true` | نعم | لا | تحقق GET بعد PATCH |
| تعطيل Phone/Anonymous | `signIn.phoneNumber.enabled=false`, `signIn.anonymous.enabled=false` | نعم | لا | fail closed |
| تعطيل بقية المزودين | list/patch/delete provider configs | نعم | لا | أي provider enabled يمنع المتابعة |
| إنشاء حسابين وUID محدد | Admin `projects.accounts` | نعم | لا | كلمات المرور عشوائية وفي الذاكرة فقط |
| إثبات العدد 2 | `projects.accounts:query` | نعم | لا | مستخدم ثالث = توقف وتنظيف |
| إصدار ID Tokens | Auth REST email/password sign-in | نعم | لا | token لا يُسجل ولا يُحفظ |
| حذف المشروع | `gcloud projects delete` | نعم | لا | تحقق lifecycle `DELETE_REQUESTED` |

## Cloudflare

| العملية | الطريقة الرسمية | آلي | متصفح | ملاحظات الحارس |
|---|---|---:|---:|---|
| تسجيل دخول Wrangler | `wrangler login --use-keyring` | جزئي | نعم | OAuth رسمي؛ token في الذاكرة |
| اكتشاف الحساب | `wrangler whoami`/Accounts API | نعم | لا | حساب واحد أو اختيار عربي واضح |
| إثبات عدم الخطة المدفوعة | Account Subscriptions API + PayGo usage probe | نعم | لا | Billing Read؛ أي اشتراك مدفوع/PayGo = توقف |
| إثبات عدم وسيلة دفع | Billing Profile API الرسمي الحالي (موسوم Deprecated) | نعم مشروط | لا | إذا تعذر/403/تغير schema يتوقف التشغيل قبل الإنشاء؛ لا تخمين |
| Worker Free/workers.dev | Wrangler deploy مع `workers_dev=true` ومن دون paid bindings | نعم | لا | config allowlist صارمة |
| D1 Free | Wrangler D1 create/list/execute/delete | نعم | لا | D1 واحدة تحمل Run ID |
| binding داخلي | `d1_databases` في Wrangler config | نعم | لا | لا credentials في الواجهة |
| logs/CPU | Workers Logs invocation logs / real-time logs | نعم | لا | CPU وwall time منفصلان |
| حذف Worker/D1 | Wrangler delete/D1 delete ثم list | نعم | لا | لا يحذف إلا marker مطابق |

### قيد مهم

واجهة Billing Profile الرسمية في Cloudflare ما زالت موثقة لكنها **Deprecated**. الحزمة لا تعتمد عليها بصمت: تنفذ probe قبل إنشاء أي مورد. إذا لم تعد الاستجابة تسمح بإثبات عدم وجود وسيلة دفع، فالنتيجة هي `BLOCKED — CLOUDFLARE BILLING PROOF UNAVAILABLE` ولا تُنشأ موارد.

## القياس

| البند | المسار المثبت |
|---|---|
| cache hit/miss | cache داخلي للشهادات وفق `Cache-Control: max-age`; reset اختباري محمي ومزال بإعادة النشر قبل الإنهاء |
| X.509/RS256/kid | endpoint Google الرسمي + استخراج SPKI + Web Crypto |
| claims | فحص `aud/iss/exp/iat/auth_time/sub` |
| D1 allowlist | query parameterized لمستخدم نشط من اثنين |
| CPU/wall | Invocation logs؛ لا يُستبدل CPU بالـwall |
| warm-up | 20 طلبًا مستبعدة من الحكم |
| hit | جولتان × 100 |
| miss | 20 تجربة مستقلة |
| الإحصاءات | median/p95/p99/max وعدد التجاوزات والإنهاءات |
| termination | outcome `exceededCpu` وHTTP Error 1102/نتيجة ناقصة |
| الرفض | UID غير موجود، kid مجهول، توقيع معدل؛ aud/iss/exp عبر إعادة نشر اختبارية مؤقتة مع توقعات/ساعة اختبار ثم استعادة النسخة الصارمة |

## الأمان والتنظيف

| القدرة | التنفيذ المثبت |
|---|---|
| منع كلمات المرور/tokens/private keys | redaction مركزي + منع args + secret scan قبل ZIP/commit |
| منع `.env` وservice accounts | pre-cloud gate وrepository scan |
| الملفات المؤقتة | Run-scoped temp + `finally` |
| ملكية الموارد | Run ID + manifest؛ لا حذف دون تطابق مزدوج |
| تنظيف PASS/FAIL/exception | `finally` إلزامي ثم verification |
| الخروج المؤقت | `wrangler logout`/`firebase logout`/`gcloud auth revoke` اختياري ومفسر؛ لا يبطل جلسات قديمة دون موافقة |

## قرار Gate A

**PASS** لأن كل عملية حاكمة لها مسار رسمي أو probe رسمي fail-closed. لا يُعد هذا إثباتًا لحساب المستخدم أو نجاحًا سحابيًا. الإثبات السحابي لا يحدث إلا عند تشغيل الحزمة بعد المراجعة الإشرافية.
