# مصفوفة UAT Remediation بعد S11

هذه المصفوفة هي سجل تتبع الجولة `UAT-001` إلى `UAT-047`. لا تعني الحالة `IN_PROGRESS` قبولًا نهائيًا. لا تصبح الجولة مغلقة إلا بعد وجود اختبار ودليل ومرجع PR لكل صف.

| ID | المشكلة / المكونات المتأثرة | القرار | التعديل المنفذ | اختبار القبول | النتيجة | PR | الحالة |
|---|---|---|---|---|---|---|---|
| UAT-001 | الأسماء والأدوار الظاهرة / UI وDTO | D-023 | قيد التنفيذ | اختبار عدم ظهور الأدوار التقنية وظهور خالد/وليد | — | PR-2 | IN_PROGRESS |
| UAT-002 | النسبة الافتراضية / financial core | D-023 | قيد التنفيذ | اختبار 70/30 مع استثناء ثنائي | — | PR-3 | IN_PROGRESS |
| UAT-003 | أسماء المراحل / UI | — | قيد التنفيذ | فحص DOM للنصوص المحظورة | — | PR-2 | IN_PROGRESS |
| UAT-004 | لغة البنية الداخلية / UI | — | قيد التنفيذ | فحص DOM للنصوص التقنية | — | PR-2 | IN_PROGRESS |
| UAT-005 | الحالات والEnums / UI وexports | — | قيد التنفيذ | اختبار labels عربية وظيفية | — | PR-2 | IN_PROGRESS |
| UAT-006 | التاريخ والوقت / UI | — | قيد التنفيذ | اختبار RTL وتنسيق عربي | — | PR-2 | IN_PROGRESS |
| UAT-007 | صلاحية الاشتراك / API وUI | — | قيد التنفيذ | person_2 فقط ينفذ التغيير | — | PR-3 | IN_PROGRESS |
| UAT-008 | إعادة فتح الفترة / settlement UI | D-011 | قيد التنفيذ | اختفاء الطلب عند OPEN | — | PR-2 | IN_PROGRESS |
| UAT-009 | التأكيدات الحساسة / UI | D-018 | قيد التنفيذ | لا وجود لـwindow.confirm وModal عربي | — | PR-2 | IN_PROGRESS |
| UAT-010 | البحث / UI وAPI | — | قيد التنفيذ | مرشحات ورسائل عربية | — | PR-2 | IN_PROGRESS |
| UAT-011 | التحليلات والتنبيهات / UI | — | قيد التنفيذ | labels عربية بلا raw enums | — | PR-2 | IN_PROGRESS |
| UAT-012 | Decision IDs / UI | — | قيد التنفيذ | لا يظهر D-/FR- | — | PR-2 | IN_PROGRESS |
| UAT-013 | Excel selectors / UI وexport | — | قيد التنفيذ | الاختيار بالاسم دون IDs | — | PR-2 | IN_PROGRESS |
| UAT-014 | لغة التصدير / XLSX UI | — | قيد التنفيذ | واجهة عربية فقط | — | PR-2 | IN_PROGRESS |
| UAT-015 | تسجيل الدخول / auth UI | — | قيد التنفيذ | لا ذكر لمزود المصادقة | — | PR-2 | IN_PROGRESS |
| UAT-016 | value_key / catalog UI وAPI | — | قيد التنفيذ | توليد مفتاح داخلي مستقر | — | PR-2 | IN_PROGRESS |
| UAT-017 | تفاصيل العميل / UI | — | قيد التنفيذ | أسماء وقيم مفهومة | — | PR-2 | IN_PROGRESS |
| UAT-018 | تفاصيل العمل / UI | — | قيد التنفيذ | لا IDs أو إصدارات تقنية | — | PR-2 | IN_PROGRESS |
| UAT-019 | النسب وbps / UI | D-023 | قيد التنفيذ | إدخال/عرض نسب مئوية | — | PR-2 | IN_PROGRESS |
| UAT-020 | المال والهللات / UI وexports | D-006 | قيد التنفيذ | `1,500 ريال` بلا raw halalas | — | PR-2 | IN_PROGRESS |
| UAT-021 | UID/IDs / UI | — | قيد التنفيذ | فحص الأسطح المستخدمة | — | PR-2 | IN_PROGRESS |
| UAT-022 | Session refresh / auth UI | — | قيد التنفيذ | بقاء الجلسة بعد Refresh | — | PR-2 | IN_PROGRESS |
| UAT-023 | Responsive overflow / CSS | D-018 | قيد التنفيذ | viewport 360–1440 بلا overflow | — | PR-2 | IN_PROGRESS |
| UAT-024 | Modals / CSS وUI | D-018 | قيد التنفيذ | داخل viewport مع focus trap | — | PR-2 | IN_PROGRESS |
| UAT-025 | Sidebar/touch/RTL / CSS | D-018 | قيد التنفيذ | إغلاق/لمس واتجاه RTL | — | PR-2 | IN_PROGRESS |
| UAT-026 | Work Details الطويلة / UI | — | قيد التنفيذ | مناطق الملخص والمتابعة والمالية والسجل | — | PR-2 | IN_PROGRESS |
| UAT-027 | Timeline / API وUI | — | قيد التنفيذ | دمج الأحداث والتغييرات دون فقد التاريخ | — | PR-2 | IN_PROGRESS |
| UAT-028 | Work shares placement / UI | D-023 | قيد التنفيذ | الحصص أساسًا في التحصيل والتسويات | — | PR-2 | IN_PROGRESS |
| UAT-029 | Similar works placement / UI | — | قيد التنفيذ | سياقي أثناء التسعير | — | PR-2 | IN_PROGRESS |
| UAT-030 | الموافقات المطلوبة / UI وAPI | — | قيد التنفيذ | قائمة مركزية بالسياق | — | PR-2 | IN_PROGRESS |
| UAT-031 | أعلى الإجماليات / financial UI | — | قيد التنفيذ | فصل receivables عن carry-forward | — | PR-3 | IN_PROGRESS |
| UAT-032 | authoritative financial read model | D-024 | قيد التنفيذ | كل الأسطح تتفق على الرقم | — | PR-3 | IN_PROGRESS |
| UAT-033 | customer remaining after cancel / API | D-024 | قيد التنفيذ | يساوي صفرًا | — | PR-3 | IN_PROGRESS |
| UAT-034 | cancelled collection/search / API | D-024 | قيد التنفيذ | لا يظهر كدين | — | PR-3 | IN_PROGRESS |
| UAT-035 | cancelled internal share / settlement | D-024 | قيد التنفيذ | net approved receipts وratio السابقة | — | PR-3 | IN_PROGRESS |
| UAT-036 | closed snapshot / settlement | D-024 | قيد التنفيذ | immutable مع adjustment لاحق | — | PR-3 | IN_PROGRESS |
| UAT-037 | ordinary writes after cancel / API | D-024 | قيد التنفيذ | price/ratio/payment create مرفوض | — | PR-3 | IN_PROGRESS |
| UAT-038 | approval freeze after cancel / API | D-024 | قيد التنفيذ | approvals مرفوضة | — | PR-3 | IN_PROGRESS |
| UAT-039 | cancellation state distinction / domain | D-024 | قيد التنفيذ | قبل التنفيذ منفصل عن توقف جزئي | — | PR-3 | IN_PROGRESS |
| UAT-040 | superseded pending requests / API | D-024 | قيد التنفيذ | non-actionable موثق | — | PR-3 | IN_PROGRESS |
| UAT-041 | payment reversal / API | D-010 | قيد التنفيذ | append-only وAPPROVED | — | PR-3 | IN_PROGRESS |
| UAT-042 | recalculation after reversal / read models | D-010 | قيد التنفيذ | paid/remaining يعاد حسابهما | — | PR-3 | IN_PROGRESS |
| UAT-043 | settlement adjustment / API | D-024 | قيد التنفيذ | لا تعديل snapshot مقفلة | — | PR-3 | IN_PROGRESS |
| UAT-044 | cancelled financial truth / all surfaces | D-024 | قيد التنفيذ | search/analytics/export/alerts متسقة | — | PR-3 | IN_PROGRESS |
| UAT-045 | admin account management / API وUI | D-025 | قيد التنفيذ | authorization وUID/role/audit | — | PR-4 | IN_PROGRESS |
| UAT-046 | cancelled price/ratio freeze / API وUI | D-024 | قيد التنفيذ | create/approve مرفوضان server-side | — | PR-3 | IN_PROGRESS |
| UAT-047 | payment correction work_version / API وUI | D-010 | قيد التنفيذ | تعارض قابل للمعالجة وreversal معتمد | — | PR-3 | IN_PROGRESS |

## قيود الأدلة الحالية

- لا يوجد جدول UAT منفصل داخل المستودع؛ البنود أعلاه صيغت مباشرة من التفويض الحالي ومراجع المتطلبات والقرارات.
- Issue وPull Requests الخارجية لم تُنشأ بعد لأن GitHub CLI غير متاح ولا توجد جلسة GitHub مصادق عليها في هذه البيئة.
- لا توجد حالة `PASS` في هذه المصفوفة قبل تنفيذ الاختبارات الخاصة بكل بند على HEAD النهائي.

## نتيجة التحقق المحلي في هذه الجولة

- لا توجد حالة UAT رسمية `PASS`: `PASS=0`, `BLOCKED/PENDING=47`؛ لأن شروط التفويض تتطلب Issue/PR/CI نهائيًا واختبار المتصفح والبيئة المعتمدة.
- دليل محلي ناجح: حزمة Node بعد التعديلات `163` اختبارًا، منها `154 PASS`, `3 FAIL` بيئية معروفة، و`6 SKIP`. كما نجحت اختبارات الإلغاء/التجميد المالي، التسوية، واجهة S4–S7، وعقد إدارة الحسابات/reset.
- الاختبارات الثلاثة المتبقية محجوبة ببيئة التشغيل: `openssl` غير متاح، تنظيف مجلد backup محجوب (`EPERM`)، وسجل التشغيل البعيد غير قابل للقراءة من دون GitHub auth.
- Playwright Level-A ما زال محجوبًا قبل assertions بسبب `Chromium spawn EPERM`؛ لذلك لم أرفع أي صف إلى `PASS` رسميًا.
