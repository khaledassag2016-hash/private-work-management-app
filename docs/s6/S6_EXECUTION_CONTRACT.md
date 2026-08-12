# S6 PR-A — عقد النواة المالية

## السلطة والنطاق

ينفذ هذا العقد `FR-009` و`FR-010` و`FR-017` و`AC-02` والجزء السعري من `P-05` على `S6_BASE_MAIN_SHA = c26c874c19054c610b273150d533938552036c42`. المرجع الحاكم هو `docs/APPROVED_REQUIREMENTS.docx` ببصمة `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`، ثم `docs/DECISION_LOG.md`، وبالأخص `D-006` و`D-009` و`D-012`.

هذا العقد PR-A فقط: schema، migration، Worker domain/API، math، audit، approval، concurrency، واختبارات backend/domain. لا ينفذ UI/acceptance الخاص بـPR-B، ولا PR-C، ولا S7.

## نموذج المال والحساب

كل قيمة مالية حاكمة تخزن في SQLite/D1 كـ`INTEGER` هللات (`amount_halalas`, `current_price_halalas`, `remaining_halalas`). يقبل API المبلغ كنص ريالات بحد أقصى منزلتين عشريتين (`amount_riyals`)، ويحلله نصيًا بصورة حتمية. ترفض القيم غير الرقمية، أكثر من منزلتين، والقيم التي تتجاوز `Number.MAX_SAFE_INTEGER` قبل أي mutation. لا تستخدم النواة المالية `parseFloat` أو `REAL/FLOAT/DOUBLE` أو الضرب العشري العائم.

حركات السعر تستخدم قيمًا موقعة: `BASE` و`INCREASE` غير سالبتين، و`DECREASE` و`DISCOUNT` غير موجبتين. يبقى السعر الحالي مشتقًا من مجموع الحركات المعتمدة فقط. لا توجد حركة معتمدة تعني `PRICE_UNSET`؛ أما حركة `BASE` بقيمة صفر فتعني سعرًا معتمدًا يساوي صفرًا.

النسبة تمثل basis points صحيحة: `3000 = 30%` و`7000 = 70%`. يثبت العقد النسبة الافتراضية `person_1 = 3000` و`person_2 = 7000`. النسبة الاستثنائية المرسلة يجب أن تكون صحيحة، وكل طرف بين `0` و`10000`، ومجموع الطرفين `10000`؛ لا يضيف التنفيذ صلاحية أو threshold غير موجود.

تحسب كل حصة بصورة مستقلة من `current_price_halalas × ratio_bps / 10000` باستخدام integer/rational arithmetic. يطبق `D-012` nearest-halalah مع `0.5` exact tie إلى الأعلى (`half-up`) لكل حصة على حدة. لا توجد قاعدة معتمدة لـ`SHARE_SUM_INVARIANT` أو residual reallocation؛ لذلك لا يعاد توزيع فرق هللة سرًا.

إذا جعلت حركة معتمدة السعر النهائي سالبًا، يرفضها Worker قبل الكتابة بالرمز `S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED`، ولا يثبت النظام سياسة دائمة للمدخلات السالبة خارج هذا fail-closed edge.

## نموذج البيانات والتاريخ

يضاف `price_change_requests` لطلبات `BASE`, `INCREASE`, `DECREASE`, `DISCOUNT` بحالة `PENDING → APPROVED` فقط. يضاف `price_movements` كسجل append-only للحركات المعتمدة، ويحتوي على الحركة والقيمة الصحيحة والسبب والتاريخ والطالب والموافق والطلب والنتيجة السعرية بعد الحركة.

يضاف `ratio_change_requests` لطلبات تغيير النسبة، و`ratio_history` كسجل append-only للنسب المعتمدة مع النسبة السابقة والجديدة والسبب والطالب والموافق والتوقيت. عدم وجود سجل نسبة معتمد يعني استخدام 30/70، ولا ينشأ سجل افتراضي مخزن بلا mutation.

طلبات وحركات السعر والنسب لا تقبل `DELETE` أو إعادة كتابة الحقول الجوهرية. لا يمسح approval التاريخ السابق، ولا يستبدل حركة قديمة؛ أي خفض هو حركة سالبة موثقة. Migration `0006_s6_financial_core.sql` additive من S5، وتحافظ على كل صفوف S5 وتعيد بناء `audit_log` فقط لتوسيع `entity_type` مع copy-forward.

## الموافقة الثنائية والتزامن

الطالب هو الموافقة الأولى، والموافق يجب أن يكون الحساب الآخر: `requester != approver`. يرفض Worker self-approval server-side، ولا توجد generic `PATCH` لتعديل السعر أو النسبة، ولا admin bypass أو direct DB endpoint.

كل طلب يلتقط `works.version`. عند approval الناجح، يرفع Worker نسخة العمل داخل نفس D1 batch التي تعتمد الطلب وتكتب الحركة/تاريخ النسبة والتدقيق. طلبان مبنيان على النسخة نفسها لا ينتجان إلا نجاحًا واحدًا؛ الطلب الآخر يحصل على `STALE_VERSION` أو `TRANSACTION_FAILED` دون حركة أو إعادة حساب إضافية. الطلب المتعارض، duplicate approval، request/work mismatch، unauthorized UID، وfailed transaction لا ينتج side effects مالية.

قبل approval تبقى `current_price_halalas` وshares وremaining كما هي. بعد approval فقط يعاد اشتقاقها من approved history. الحركة pending ليست جزءًا من السعر الرسمي.

## API وSPA envelope

كل endpoint الخاص يمر عبر `readAuthorized` ثم `handleApi`. Success envelope هو:

```json
{"ok":true,"data":{},"requestId":"..."}
```

والخطأ هو:

```json
{"ok":false,"code":"...","requestId":"..."}
```

وهذا يطابق `app.js::api()` الذي يعيد `payload.data` فقط عند `payload.ok`. لا ينشئ PR-A wrapper عميلًا موازيًا.

المسارات هي:

| المسار | الوظيفة |
|---|---|
| `GET /api/works/:id/financials` | السعر الحالي، الحصص، المتبقي، النسبة، والحركات/الطلبات/التواريخ |
| `POST /api/works/:id/price-requests` | إنشاء طلب حركة سعر pending |
| `GET /api/works/:id/price-requests` | قراءة طلبات السعر |
| `POST /api/works/:id/price-requests/:requestId/approve` | اعتماد طلب السعر بالحساب الآخر |
| `GET /api/works/:id/price-movements` | قراءة السعر history المعتمد |
| `POST /api/works/:id/ratio-requests` | إنشاء طلب نسبة استثنائية pending |
| `GET /api/works/:id/ratio-requests` | قراءة طلبات النسبة |
| `POST /api/works/:id/ratio-requests/:requestId/approve` | اعتماد طلب النسبة بالحساب الآخر |
| `GET /api/works/:id/ratio-history` | قراءة تاريخ النسب المعتمدة |

طلب السعر يتضمن `version`, `movement_type`, `amount_riyals`, `reason`, و`effective_at` اختياريًا. طلب النسبة يتضمن `version`, `person_1_bps`, `person_2_bps`, و`reason`.

## current price وremaining boundary

`financials.current_price_halalas` هو مجموع `price_movements.amount_halalas` المعتمدة فقط، و`price_state` هو `PRICE_UNSET` أو `PRICE_APPROVED`. shares تعاد من النسبة الحالية. قبل S7 لا ينشئ S6 payment ledger أو payment mutation أو collection status؛ لذلك يعرض `approved_payments_total_halalas = 0` و`remaining_halalas = current_price_halalas` مع `remaining_projection = PRE_S7_APPROVED_PAYMENTS_ZERO`. يمكن لـS7 لاحقًا استبدال مصدر مجموع الدفعات دون إعادة كتابة price history.

## audit contract

كل إنشاء طلب يسجل `CREATE` يحوي actor، request/correlation id، القيم الصحيحة، السبب، وversion. كل approval يسجل `UPDATE` للطلب، و`CREATE` للحركة أو ratio history، ويحتفظ `before_json` و`after_json` و`actor_uid` وtimestamps و`run_marker`. كل financial mutation integer-halalas فقط، و`audit_log` append-only.

## Requirement/Risk → exact evidence layer

| Requirement/Risk | الاختبار الفعلي | الطبقة/assertions |
|---|---|---|
| money parsing/overflow/no float | `S6 MONEY parser rejects malformed, >2 decimals, and unsafe values` | `s6_pr_a_financial_core.test.mjs`: exact halalas, rejection before DB mutation، وschema no floating type |
| price history + AC-02 | `S6 AC-02 computes 1500 + 200 + 100 and later -100` | domain: pending immutability، 180000 current، movement order، shares/remaining |
| dual approval directions | `S6 price approval works in both directions` | domain/API: `uid-one→uid-two` و`uid-two→uid-one`، self rejection، no duplicate |
| pending/stale/concurrent safety | `S6 approval races produce exactly one business success` | domain: one approved request، one movement، one audit، no double share calculation |
| D-009 ratio | `S6 ratio exception is pending then approved by other account` | domain: pending old ratio unchanged، approval updates history/shares، self reject |
| D-012 rounding | `S6 shares use independent half-up rounding without residual rebalance` | domain: exact `.5` tie، per-result values، no sum invariant assertion |
| audit/history | `S6 financial audit is append-only and integer-only` | domain: before/after actor/request ids، update/delete triggers reject |
| API envelope | `S6 API envelope is consumed by existing api contract` | Worker HTTP: `ok/data/requestId` and error shape; SPA caller receives `data` |
| S5 migration | `S6 migration preserves S5 rows and installs guards` | migration fixture: rows/counts and new tables/triggers |
| S7 boundary | `S6 exposes pre-S7 remaining projection without payment mutation` | schema/domain: no payment tables/routes, zero approved payment projection |

PR-A does not claim UI acceptance; UI dual-direction and visual pending/approved truth belong to PR-B.

## Post-mutation refresh boundary

Backend write success and refreshed UI success are distinct outcomes. PR-A responses identify the authoritative write and PR-B must refetch Work/financials/history before showing verified success. A failed refetch must not be reported as verified financial success.

## Explicit non-scope

S6 PR-A does not create payments, installments, allocation, correction/reversal of payments, transfers, fees, subscriptions, expenses, settlement/monthly close, analytics/export, imports, deployment, Cloud resources, real data, secrets, or stable-ref changes. `D-010` and `D-011` remain S7 decisions; `D-013` was S5-only and is not an S6 authorization.

## Negative final-price status

`S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED` is a fail-closed edge marker, not a new product decision. The normal acceptance examples use non-negative prices.
