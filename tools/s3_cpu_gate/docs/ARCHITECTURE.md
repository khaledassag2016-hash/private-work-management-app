# ARCHITECTURE

## الفصل بين البناء والتشغيل

- **Build:** إعداد المصدر، المحاكاة، والتحقق المحلي فقط؛ لا حسابات مستخدم ولا موارد سحابية ولا تغييرات GitHub.
- **Live:** تشغيل لاحق على Windows بعد مراجعة إشرافية مستقلة للحزمة النهائية.

## المكونات المصممة

1. `S3-CPU-Gate-Setup.ps1`: مستخرج ذاتي إلى المسار الحاكم.
2. `START.cmd` و`Bootstrap.ps1`: تشغيل آمن وتهيئة PowerShell 7 محليًا.
3. `Initialize-Toolchain.ps1` و`Toolchain.psm1`: تنزيل الأدوات الرسمية محليًا والتحقق من البصمات.
4. `S3-CpuGate-Orchestrator.ps1`: آلة الحالات والمنسق الوحيد.
5. Modules: Common, Toolchain, UI, Prerequisites, Repository, Firebase, Cloudflare, CPU, Cleanup, Reporting.
6. Worker أدنى: Firebase JWT → X.509/RS256/claims → D1 allowlist.
7. Python helpers: إحصاءات، تنقية، فحص أسرار، تحقق الحزمة، ومحاكاة غير سحابية.

## آلة الحالات

`00_PACKAGE_READY → 10_LOCAL_PREREQUISITES → 20_REPOSITORY_GATE → 30_BRANCH_AND_DRAFT_PR → 40_PRE_CLOUD_GATE → 50_FIREBASE_PROVISIONED → 60_CLOUDFLARE_PROVISIONED → 70_CPU_GATE_EXECUTED → 80_RESOURCES_DESTROYED → 90_REPORT_READY`

الانتقال متسلسل، وكتابة `state.json` تمر عبر ملف مؤقت. كل تشغيل يحمل Run ID مستقلًا. الموارد تحمل marker يطابق Run ID، ولا يسمح التنظيف بحذف مورد لا يطابق السجل والاسم معًا.

## أوضاع التشغيل

- `Plan` افتراضي: لا كتابة سحابية ولا GitHub.
- `Simulation`: محاكاة فقط، بلا حسابات حقيقية.
- `Live`: يحتاج تسجيل دخول رسمي وموافقتين عربيتين واضحتين: قبل الفرع/PR وقبل الموارد السحابية.

## Fail closed

غموض الخطة أو Billing أو وسيلة الدفع أو telemetry أو نقص السجلات أو فشل claims أو ownership أو cleanup verification أو secret scan يؤدي إلى التوقف/FAIL.

## حالة المراجعة الحالية

التصميم مكتمل مبدئيًا، لكن لا يجوز إنتاج الحزمة النهائية أو تشغيلها لأن Pester وPSScriptAnalyzer لم يُنفذا في بيئة البناء الحالية لغياب PowerShell 7. راجع `TEST-REPORT.md` و`BUILD-VALIDATION-BLOCKER.md`.
