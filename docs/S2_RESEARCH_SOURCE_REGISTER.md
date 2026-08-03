# S2 — سجل مصادر البحث

تاريخ التحقق: 2026-08-03. استخدمت المصادر الرسمية المباشرة فقط. لا تستخدم نتيجة بحث عامة أو مقال طرف ثالث بوصفه دليلًا حاكمًا.

| المزود | المصادر الرسمية التي تحكم القرار |
|---|---|
| Cloudflare | Workers Static Assets وbilling/limitations، Workers pricing/limits، `workers.dev`، D1 pricing/limits/import-export، Zero Trust setup |
| Firebase | Spark billing، Email/Password، user management، ID token verification وX.509/cache، Authentication limits |
| Supabase | Pricing، free project pausing، backups، billing FAQ |
| Appwrite | Pricing، billing limits، 2026 pausing/deletion changelog |
| Google Apps Script | Web app access، quotas، LockService |

## روابط القرار المعتمد

### Cloudflare

- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/

### Firebase

- https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
- https://firebase.google.com/docs/auth/web/password-auth
- https://firebase.google.com/docs/auth/users
- https://firebase.google.com/docs/auth/admin/verify-id-tokens
- https://firebase.google.com/docs/auth/limits

## ملاحظات حاكمية

- Workers Static Assets هي الاستضافة الأساسية؛ Pages ليست جزءًا أساسيًا من القرار.
- `workers.dev` يثبت إمكان البدء دون نطاق مدفوع.
- Email/Password هو مزود الدخول الوحيد المعتمد؛ Phone/SMS وAnonymous وسائر المزودين ممنوعة دون قرار لاحق.
- حد 10ms CPU في Workers Free بوابة توقف إلزامية في S3، وليس مبررًا للترقية المدفوعة.
