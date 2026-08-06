# SOURCE-VERIFICATION

- **تاريخ التحقق:** 2026-08-03
- **السياسة:** مصادر رسمية فقط. الروابط قابلة للتغير؛ تعيد الحزمة probes قبل أي كتابة سحابية.

| المصدر الرسمي | الرابط | الادعاء/الحقل المعتمد | خطر التغير |
|---|---|---|---|
| GitHub CLI auth login | https://cli.github.com/manual/gh_auth_login | تسجيل دخول web وتخزين آمن للاعتماد | منخفض |
| GitHub repo clone | https://cli.github.com/manual/gh_repo_clone | استنساخ مستودع خاص | منخفض |
| GitHub PR create | https://cli.github.com/manual/gh_pr_create | `--draft` وhead/base | منخفض |
| GitHub PR checks | https://cli.github.com/manual/gh_pr_checks | قراءة حالة CI وخروج غير صفري | منخفض |
| PowerShell Windows install | https://learn.microsoft.com/powershell/scripting/install/install-powershell-on-windows | ZIP portable وPowerShell 7 | متوسط؛ الإصدار يتغير |
| PowerShell 7.6.3 release | https://github.com/PowerShell/PowerShell/releases/tag/v7.6.3 | SHA-256 للأصول الرسمية | متوسط |
| Pester | https://www.powershellgallery.com/packages/Pester/6.0.0 | إطار الاختبارات الرسمي المنشور | متوسط |
| PSScriptAnalyzer | https://www.powershellgallery.com/packages/PSScriptAnalyzer/1.25.0 | التحليل الساكن | متوسط |
| Identity Platform Config | https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/Config | email/phone/anonymous وdisabled signup/deletion | متوسط |
| Get auth config | https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects/getConfig | GET config وOAuth scopes | منخفض |
| Update auth config | https://docs.cloud.google.com/identity-platform/docs/reference/rest/v2/projects/updateConfig | PATCH + updateMask | منخفض |
| Create admin account | https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects/accounts | إنشاء user مع `localId` عبر OAuth admin | متوسط |
| Query accounts | https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/query | إثبات العدد والخصائص | متوسط |
| Firebase Auth REST | https://firebase.google.com/docs/reference/rest/auth | sign in email/password وإصدار ID token | منخفض |
| Verify Firebase ID tokens | https://firebase.google.com/docs/auth/admin/verify-id-tokens | RS256,kid,X.509,aud,iss,exp,iat,auth_time,sub,max-age | منخفض |
| Verify Google billing | https://docs.cloud.google.com/billing/docs/how-to/verify-billing-enabled | `billingEnabled=false` وbillingAccountName فارغ | منخفض |
| gcloud billing describe | https://docs.cloud.google.com/sdk/gcloud/reference/billing/projects/describe | قراءة حالة Billing | منخفض |
| Cloudflare Workers limits | https://developers.cloudflare.com/workers/platform/limits/ | Free=10ms CPU وoutcome exceededCpu/Error 1102 | متوسط؛ الخطة تتغير |
| Workers pricing | https://developers.cloudflare.com/workers/platform/pricing/ | Workers Logs ضمن Free وD1 Free quotas | مرتفع؛ الأسعار والحصص تتغير |
| CPU/wall publication | https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/ | CPU وwall لكل invocation | متوسط |
| Workers Logs | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ | invocation logs وFree retention/quota | متوسط |
| Cloudflare subscriptions API | https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/ | كشف الاشتراكات؛ Billing Read | متوسط |
| Cloudflare billing profile API | https://developers.cloudflare.com/api/resources/billing/subresources/profiles/methods/get/ | مؤشرات وسيلة الدفع؛ endpoint Deprecated | **مرتفع**؛ probe مانع |
| Cloudflare Billing docs | https://developers.cloudflare.com/billing/ | الاشتراكات ووسائل الدفع | مرتفع |
| Cloudflare D1 Wrangler commands | https://developers.cloudflare.com/d1/wrangler-commands/ | create/list/execute/delete/export | متوسط |
| Workers routes/workers.dev | https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ | نقطة workers.dev | متوسط |
| Wrangler login | https://developers.cloudflare.com/workers/wrangler/commands/#login | OAuth browser/keyring | متوسط |
| Wrangler real-time logs | https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ | جمع traces آنيًا | متوسط |

| Cloudflare trace attributes | https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/ | `cloudflare.cpu_time_ms`, `cloudflare.wall_time_ms`, وoutcome مثل `exceededCpu` | متوسط |
| Workers Trace Events dataset | https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/ | `CPUTimeMs` الرسمي لكل invocation | متوسط |
| PowerShell 7.6.3 release | https://github.com/PowerShell/PowerShell/releases/tag/v7.6.3 | Windows ZIP SHA-256 `80832551...333793` | متوسط |
| Pester 6.0.0 | https://www.powershellgallery.com/packages/Pester/6.0.0 | الإصدار المقفل لاختبارات PowerShell | متوسط |
| PSScriptAnalyzer 1.25.0 | https://www.powershellgallery.com/packages/PSScriptAnalyzer/1.25.0 | الإصدار المقفل للتحليل الساكن | متوسط |

## قواعد الاستخدام

1. لا تُثبت الحزمة خطة الحساب من ذاكرة الوثائق؛ تنفذ probes عند التشغيل.
2. كل مصدر خطة/حصة يحمل تاريخ تحقق ويُعاد فحص endpoint قبل الموارد.
3. أي 403 أو schema غير متوقع في Billing أو telemetry يمنع إنشاء الموارد أو يجعل CPU Gate `FAIL`، لا `PASS`.
4. لا تستخدم Tail Workers أو Logpush لأنهما ليسا مسار Free المطلوب؛ تستخدم Workers Logs/real-time logs فقط.
