# Architecture decision records

- `ADR-001-FREE-ARCHITECTURE.md`: **Accepted** بعد اعتماد المستخدم وتسجيل D-006، ثم تنقيحه وفق المراجعة المستقلة.
  - الواجهة الأساسية: Cloudflare Workers Static Assets.
  - Pages: بديل احتياطي يحتاج قرارًا لاحقًا.
  - المصادقة: Firebase Spark Email/Password لحسابين ينشئهما المشرف فقط.
  - نقطة البداية: `workers.dev` المجانية.
  - S3 محجوبة ببوابة قياس CPU عند حد Workers Free البالغ 10ms؛ لا ترقية مدفوعة.
- `FINANCIAL_INTEGER_RULE.md`: قاعدة معتمدة لتخزين وحساب الأموال كأعداد صحيحة من الهللات ومنع floating point.

لا يصبح أي ADR لاحق معتمدًا إلا بموافقة المستخدم الصريحة وتسجيل قرار مؤرخ في `docs/DECISION_LOG.md`.
