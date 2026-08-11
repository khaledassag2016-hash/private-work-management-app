# S4 Execution Contract — Gate 0

## 1. Governing baseline

هذه الوثيقة هي عقد Gate 0 لمرحلة S4، وليست تنفيذًا Production. المرجع الوظيفي الحاكم هو `docs/APPROVED_REQUIREMENTS.docx`، وبصمته المعتمدة `6cb2e99449deb287b2008baf23e091efe45a89f3edfb15df721c933271d6b65b`، ولا تستبدله `docs/REQUIREMENTS.md`؛ فالملف الأخير فهرس تشغيلي للبحث فقط. baseline المعتمد هو `main@207e53d5279f89ff3833e28d76ff3aa85708a3d5`. وتشمل الحوكمة النافذة `D-006` و`D-007` و`D-008`، مع بقاء `S3_STATUS = CLOSED-BLOCKED/DEFERRED` و`S3_COMPLETE = FALSE` و`S4_STATUS = AUTHORIZED_NOT_STARTED`.

Gate 0 repository-only. لا Cloud write، ولا Firebase write، ولا D1 creation، ولا Worker deployment، ولا Static Assets deployment، ولا Billing أو PayGo أو Workers Paid أو Blaze أو payment method أو trial activation أو credentials export أو token logging أو real customer data. لا تبدأ Gate 1، ولا تُغيّر حالة أي عنصر في `docs/TRACEABILITY_MATRIX.md` إلى `PASS` أو `IMPLEMENTED` في هذه البوابة.

## 2. Exact scope

نطاق S4 في Gate 0 هو تصميم عقد قابل للتنفيذ ومخطط اختبارات مسبق للمتطلبات `FR-001` إلى `FR-006`، و`FR-014` إلى `FR-016`، و`FR-028`، ومعايير القبول `AC-01` و`AC-04` و`AC-07` و`AC-13`، والقرار `P-06`. وتشمل السيناريوهات ذات المسؤولية الكاملة أو الجزئية `S-03` و`S-04` و`S-05` و`S-12` و`S-13` و`S-14` عندما ينطبق جزء S4 منها.

المخرج المطلوب هو عقد المجال والبيانات وAPI والتفويض والتدقيق والكتالوج وسجل العميل والتحذيرات والعلاقات بين الأعمال والحدود المرحلية، مع acceptance map وregression map وfailure-mode map وGate 1 prerequisites. لا تُعد أي وظيفة منفذة في Gate 0؛ كل الحالات هنا `PLANNED`.

## 3. Explicit non-scope

لا تشمل S4 تنفيذ أحداث المتابعة أو تاريخ الحالات أو تاريخ العناوين أو الأرشفة التشغيلية المتقدمة؛ هذه مسؤولية S5. ولا تشمل حركات الأسعار أو الموافقة الثنائية على تعديل السعر أو النسب والاستثناءات أو إعادة الحساب؛ هذه مسؤولية S6. ولا تشمل الدفعات أو الأقساط أو المتبقي أو التسويات أو المصاريف؛ هذه مسؤولية S7. ولا تشمل البحث والتقارير والتصدير والتحليلات الزمنية؛ هذه مسؤولية S8. ولا تشمل UX النهائي المتجاوب وإتاحة الوصول؛ هذه مسؤولية S9. ولا تشمل التكامل الشامل والنسخ والاستعادة؛ هذه مسؤولية S10. ولا تشمل استيراد البيانات التاريخية؛ هذه مسؤولية S11.

لا ينشئ Gate 0 جداول Production أو Worker implementation أو UI Production أو migrations أو Cloud resources. ولا يعيد تصميم S3 أو يفتح مانع Firebase السابق.

## 4. Domain model contract

النموذج المفاهيمي الأدنى يتكون من `Customer` و`Work` و`WorkRelationship` و`CatalogValue` و`CustomerDocumentedFact` و`CustomerWarningProjection`. أسماء الجداول والأعمدة النهائية مؤجلة إلى Gate 1 ولا يجوز اعتبار هذه الأسماء schema نهائية.

| الكيان | الغرض | invariants الحاكمة |
|---|---|---|
| `Customer` | هوية العميل وبياناته الأساسية | له ID ثابت وفريد، ويحمل الاسم والجامعة والتخصص والدولة وفق `P-06`، وله عدة أعمال، ولا يُخلط مع سجل عمل |
| `Work` | سجل مستقل لكل طلب أو مشروع أو مرحلة | له ID ثابت، يرتبط بعميل واحد، يحتفظ بعنوان حالي، ولا يندمج مع عمل آخر |
| `WorkRelationship` | بيان استقلال العمل أو تبعيته | العلاقة لا تلغي سجل child، ولا تستبدله بحقل داخل parent، وتمنع self-parent والدورة والعميل المختلف |
| `CatalogValue` | قيمة قابلة للتوسع للدولة والتخصص ونوع العمل | لها identity وlabel وuniqueness، ولا تكون enum في source code فقط |
| `CustomerDocumentedFact` | واقعة موثقة من سجل التعامل | لها مصدر ودليل ووقت وactor عند انطباقه، ولا تُنشأ من warning يدوي بلا evidence |
| `CustomerWarningProjection` | عرض حتمي للتحذير المبني على وقائع | لا يُنشأ بلا fact، ويعرض evidence source، ولا يستخدم scoring أو AI classification |

العميل يمكن أن يملك عدة أعمال متزامنة أو متعاقبة. الأعمال مستقلة حتى عند وجود علاقة parent/child. العمل التابع يحتفظ بـstable ID وسجله وتدقيقه ورابط العميل ورابط العلاقة. لا يوجد hard delete في S4 عندما يتعارض مع `P-05` أو المراحل اللاحقة، ولا يكسر العقد بنية audit الموجودة في S3.

## 5. Data constraints

تحفظ الهوية والربط بمفاتيح ثابتة وفريدة. يجب منع duplicate customer ambiguity عبر نتيجة واضحة: إما إنشاء هوية جديدة بإقرار صريح، أو إرجاع تعارض يحتاج اختيارًا، ولا يجوز دمج السجلات تلقائيًا. يجب أن يكون كل `Work` مرتبطًا بعميل موجود ونشط وفق التفويض؛ customer غير الموجود أو غير المصرح به يؤدي إلى رفض fail-closed.

`FR-003` يميز صراحةً بين `PRICE_UNSET` و`PRICE_ZERO`. لا يجوز استخدام القيمة الرقمية `0` لتمثيل عدم تحديد السعر إلا إذا أثبتت النسخة الحاكمة ذلك صراحةً. Gate 0 لا ينفذ pricing workflow ولا price movements ولا approvals ولا shares ولا recalculation. إذا احتاجت قراءة السعر التاريخي في `FR-016` إلى بنية S6 غير موجودة، تُسجل كقرار منتج غير محسوم ولا تُخترع بنية بديلة.

الحقول المفاهيمية للعمل هي: `country`, `university`, `specialty`, `work_type`, `subject_or_course_code`, `title`, مع تحديد required وoptional وrequired-if-known وwarning-only في Gate 1 بعد مطابقة Word حرفيًا. عبارة «عند توفره» أو «عند معرفته» لا تتحول إلى hard validation بلا سند. تمنع `FR-006` الاكتفاء بوصف عام عندما تكون التفاصيل متاحة، لكنها لا تمنع إنشاء سجل يسمح المرجع بإنشائه.

القيم المالية المستقبلية تستخدم integer minor units وفق `D-006`، ويحظر floating point. Gate 0 لا يقرر rounding، ولا يحسم `Q-004`، ولا يبني حسابات مالية S6/S7.

## 6. API contract

كل API خاص بـS4 يمر عبر Worker وD1 binding الداخلي، ولا يسمح direct D1 bypass. كل endpoint يجب أن يحدد method وresource وrequest schema وresponse schema وerror class وauthorization predicate وaudit effect قبل Gate 1. الشكل المفاهيمي المقترح هو:

| العملية | الغرض | النجاح المخطط | الفشل الحاكم |
|---|---|---|---|
| Customer create/read/update | إدارة بيانات العميل الأساسية | نتيجة تحمل stable ID ونسخة السجل | malformed/duplicate/unauthorized/not-found |
| Work create/read/update | إنشاء وعرض وتحديث العمل | Work مستقل مرتبط بعميل | customer missing، required detail violation، unauthorized |
| Work relationship set/read | مستقل أو تابع | علاقة validated لا تدمج السجلات | missing parent، self-parent، cycle، cross-customer |
| Catalog read/add/activate/deactivate | قيم data-driven | قيمة جديدة قابلة للاستخدام دون source change | duplicate، inactive، forbidden catalog mutation |
| Customer history read | عرض الوقائع المتاحة | facts مرتبة ومصدرها واضح | unauthorized أو missing customer |
| Warning projection read | عرض تحذير حتمي | warning مع evidence source | no evidence لا ينتج warning |
| Similar-work read | أقل قراءة لازمة لـ`FR-016` | حقائق تاريخية مسموح بها فقط | لا price workflow أو تعديل أو approval |

لا تتحدد أسماء المسارات النهائية في Gate 0. كل استجابة خطأ لا تكشف بيانات غير لازمة ولا تتجاوز التفويض. تعديلات customer/work/catalog/fact تنفذ داخل transaction مناسبة أو تفشل كليًا؛ لا تعلن نجاح mutation إذا فشل audit المرتبط بها.

## 7. Authorization contract

يبني S4 على `D-006` وS3: Firebase Email/Password، حسابان فقط، token verification من جهة الخادم، allowlist، fail closed، وD1 binding داخلي. لا يعتمد أي قرار أمني على UI. كل API يتطلب authentication، ويتحقق Worker من `RS256`, `kid`, signature, `aud`, `iss`, `exp`, `iat`, `auth_time`, و`sub` وفق عقد S3، ثم يتحقق من allowlist ودور الحساب وملكية السجل أو نطاق العملية.

| مجموعة API | authentication | server-side authorization | UI وحده كافٍ؟ |
|---|---|---|---|
| Customer | Firebase ID Token صالح | allowlist + سياسة العملية من جهة الخادم، دون افتراض row/customer ownership | لا |
| Work | Firebase ID Token صالح | allowlist + الدور/العملية المعتمدة + علاقة validated عند الحاجة | لا |
| Work relationship | Firebase ID Token صالح | allowlist + تحقق relation من جهة الخادم، دون اختراع ownership | لا |
| Catalog mutation | Firebase ID Token صالح | allowlist/role enforcement الموجود + audit؛ لا admin role جديد | لا |
| History/warning/similar read | Firebase ID Token صالح | allowlist + سياسة القراءة من جهة الخادم | لا |

رفض المستخدم الثالث، unknown user، invalid signature، unknown `kid`، invalid claims، وdirect D1 access تبقى ضمن regression S3 ولا تعاد كـLive acceptance.

## 8. Audit integration contract

يستخدم S4 audit infrastructure الموجود ولا ينشئ نظامًا موازيًا. كل mutation ذات أثر على customer أو work أو relationship أو catalog أو documented fact تسجل actor وtimestamp وbefore وafter حيث ينطبق، مع request/correlation marker وفق عقد S3. يبقى السجل append-only وtamper-resistant، ولا يسمح S4 بتقليل ضمانات `audit_log` أو bypassing Worker.

العمليات المخطط لتدقيقها هي: create/update customer، create/update work، change work relationship، catalog mutation، وإضافة أو تعديل documented fact. `CustomerWarningProjection` مشتق deterministic من documented facts وليس mutation مستقلة يحررها المستخدم؛ لذلك يسجل audit mutation للـfact ومصدرها، ولا يحول projection إلى warning يدوي قابل للتعديل. القراءة لا تنتج audit mutation إلا إذا حسمت المتطلبات ذلك لاحقًا؛ لا يخترع Gate 0 قاعدة قراءة جديدة.

يجب أن يفشل التغيير إذا تعذر تسجيل audit، أو أن يثبت transaction boundary أن mutation وaudit نجحا معًا. اختبار Gate 1 يثبت actor/time/before/after، ورفض التلاعب، ورفض actor غير المصرح به، وعدم فقد السجل السابق.

## 9. Catalog contract

`country`, `specialty`, و`work_type` قيم data-driven وليست enum ثابتًا في source code. لكل قيمة identity ثابتة وdisplay label وuniqueness، وتحدد Gate 1 uniqueness وreferential integrity قبل البرمجة. يتطلب `AC-13` add/read/use دون source-code change؛ أما activate/deactivate أو lifecycle إضافي فليس جزءًا إلزاميًا من S4 إلا إذا أثبته المرجع أو كان ضروريًا لسلامة البيانات، ولا يُنشئ Gate 1 admin role جديدًا.

يجب أن يثبت `AC-13` سيناريو إضافة دولة أو تخصص أو نوع عمل جديد ثم استخدامه **دون تعديل source code**. لا تضيف S4 شاشة إدارة عامة أو صلاحيات إدارية جديدة لم يطلبها المرجع. تستخدم catalog mutation server-side allowlist/role enforcement الموجود؛ وإذا بقي تقييد منتج حقيقي غير محسوم، تُعزل mutation المتأثرة فقط دون إيقاف بقية Gate 1.

## 10. Customer history contract

`FR-015` يطلب إظهار تاريخ العميل قبل بدء اتفاق جديد. في S4 يقتصر ذلك على facts والسجلات المتاحة من النطاق الجاري، مع ترتيب زمني ومصدر واضح، دون استيراد البيانات التاريخية أو تنفيذ S5/S6/S7 history. يُعرض ما هو موجود فقط، ولا تُملأ فجوات الماضي بتخمين.

يدعم العقد إضافة وقائع مستقبلية من S5 وS6 وS7 دون schema rewrite كبير، عبر fact type/source/time/actor/reference concepts عامة بما يكفي، لكن لا ينفذ هذه الوقائع في S4. لا يُعلن documented fact إلا إذا كان مصدره قابلًا للإسناد.

## 11. Customer warning contract

النموذج الحاكم هو:

```text
documented fact -> deterministic warning projection
```

الوقائع المسموح أن تكون أساسًا للتحذير هي ما يثبته Word، مثل non-payment أو delay أو block/discontinuation أو dispute. لا warning بلا documented fact. لا scoring system، ولا AI classification، ولا risk percentage، ولا warning يدوي اعتباطي بلا evidence.

يعرض warning نوع الواقعة ومصدرها ووقت تسجيلها، ويستطيع المستخدم رؤية أن التحذير projection وليس حقيقة مستقلة. لا ينفذ S4 payment workflow أو settlement workflow. ويثبت `AC-07` أن فتح عميل سابق يعرض مشكلة دفع موثقة قبل إنشاء اتفاق جديد، لا مجرد label غير مفسر.

## 12. Work parent/child contract

لكل work stable ID وسجل مستقل وaudit مستقل ورابط customer. العمل المستقل لا يملك parent. العمل التابع يملك relation إلى parent دون أن يتحول إلى مجرد field داخل parent. لا تندمج السجلات ولا تختفي هوية child.

| الحالة | السلوك المخطط |
|---|---|
| parent missing | رفض fail-closed مع error قابل للتشخيص دون كتابة جزئية |
| self-parent | رفض صريح |
| circular relation | رفض بعد كشف cycle |
| cross-customer parent | رفض لأن customer scope لا يطابق |
| parent inactive/archived | خارج سلوك S4 التنفيذي لأنه lifecycle تابع لـS5؛ لا يكون Gate 1 blocker |
| duplicate relation | idempotent read أو رفض duplicate دون سجل ثانٍ |

لا ينفذ S4 event history أو status history أو timeline أو archiving behavior؛ هذه حدود S5.

## 13. Validation semantics

تقسم validation إلى hard validation وsoft warning. hard validation تمنع السجل عندما تكون الهوية أو العلاقة أو القيمة المطلوبة أو integrity غير صالحة. soft warning تنبه إلى نقص مسموح أو معلومة «عند توفرها» دون إسقاط السجل.

| الحالة | النوع | السلوك |
|---|---|---|
| customer ID مفقود في work | hard | رفض |
| title عام مع تفاصيل متاحة | hard أو warning وفق النص الحاكم، ويثبت Gate 1 الاختيار من Word | لا اختراع لقاعدة جديدة |
| university غير معروف | soft إذا كان المرجع يسمح | حفظ مع warning فقط |
| specialty معروف ومفقود | hard/required-if-known وفق Word | يحدد Gate 1 من النص الحاكم |
| price unset | valid | يحفظ كـ`PRICE_UNSET` ويظهر في follow-up |
| price zero | قيمة مختلفة | لا تساوى بـ`PRICE_UNSET` |
| inactive catalog value | hard | رفض الاستخدام الجديد |
| warning بلا fact | hard | لا ينشأ warning |
| malformed request | hard | رفض بلا partial mutation |

## 14. Basic work-status boundary

S4 يعرّف current/basic status representation فقط، بما يكفي لإظهار حالة العمل الحالية وقائمة المتابعة. لا تنشئ S4 status history أو timeline أو previous-title history أو workflow progression أو archiving behavior؛ هذه S5. يجب أن يكون status الحالي قابلًا للعرض والاختبار دون ادعاء حفظ كل انتقال تاريخي.

`needs follow-up` نتيجة تشغيلية للعمل بلا سعر أو بلا رد أو لحالة يسمح بها المرجع، وليست pricing workflow. لا تنفذ S4 price movement أو payment warning workflow؛ تعرض ما هو موثق فقط.

## 15. Search/read boundary for FR-016

`FR-016` يخطط لأقل عقد قراءة للعثور على أعمال سابقة مشابهة ومعرفة السعر الذي نُفذت به وتاريخها ونوعها، لكنه لا يبني S6. لذلك Gate 0 يفصل `similar-work read` عن price movements وapprovals وshares وrecalculation.

إذا أثبت Word أو البنية الحالية وجود authoritative price source يمكن قراءته دون إنشاء S6، يخطط Gate 1 لقراءته بوصفه read-only historical fact مع بيانات synthetic. إنشاء أو تعديل مصدر السعر يبقى S6. إذا لم يوجد مصدر صالح أو احتاج السلوك إلى قرار منتج حقيقي غير موجود، يعزل الجزء المتأثر تحت `UNRESOLVED PRODUCT DECISION` ويستمر تنفيذ بقية Gate 1؛ لا يُستنتج من أمثلة السعر في المتطلبات أن S4 مخولة ببناء pricing workflow.

## 16. S5/S6/S7/S8/S9/S11 boundaries

| المرحلة | ما يُترك لها | ما يمنع S4 من بنائه |
|---|---|---|
| S5 | events/history/archive/status history/title history | لا timeline أو event engine في S4 |
| S6 | price movement/approval/shares/recalculation | لا pricing workflow أو تعديل سعر في S4 |
| S7 | payments/settlements/expenses | لا payment/settlement engine في S4 |
| S8 | search/reporting/export/analytics | S4 يوفر read boundary فقط لـ`FR-016` |
| S9 | full UX/RTL responsiveness/accessibility | لا UI production في Gate 0 |
| S11 | historical import/cleanup/review | لا real historical data ولا import في S4 |

المبدأ الحاكم: `MINIMAL`, `FORWARD-COMPATIBLE`, `S4-ONLY`.

## 17. Acceptance map

كل صف في الجدول مخطط فقط وحالته `PLANNED`. لا يعني وجود component أو test location أن الكود موجود.

| ID | authoritative requirement | S4 responsibility | planned implementation component | planned automated test | planned negative test | planned acceptance evidence | later dependency | forbidden expansion | unresolved |
|---|---|---|---|---|---|---|---|---|---|
| FR-001 | إنشاء عميل وحفظ بياناته وتاريخه | هوية وبيانات customer | Customer service/API | create/read/update | duplicate/unauthorized | request/response + audit | S5/S7 | no payment engine | field semantics |
| FR-002 | ربط العميل بعدة أعمال مستقلة | customer-work relation | Work service | two works same customer | cross-customer/merge | stable IDs and links | S5/S7 | no work merge | none |
| FR-003 | عمل بلا سعر وقائمة متابعة | `PRICE_UNSET` distinct | Work create + follow-up projection | create unset and list | zero conflation | evidence of preserved work | S6 | no pricing workflow | none |
| FR-004 | مستقل أو تابع | parent/child relation | relationship validator | independent/child pair | missing/self/cycle/cross-customer | relation result + rejection logs | S5 | no event history | parent lifecycle خارج S4 |
| FR-005 | حفظ التفاصيل الأساسية | fields and catalog refs | Work contract | all field combinations | invalid refs | persisted fields + validation | S5/S8 | no history/import | requiredness from Word |
| FR-006 | منع generic-only when details available | hard/soft distinction | validation layer | detailed vs generic | forbidden hard rejection of allowed missing | validation matrix | S5/S8 | no extra mandatory rules | exact field semantics |
| FR-014 | warning from history | deterministic projection | fact/warning read model | fact creates warning | warning without fact | warning + evidence source | S7 | no scoring/AI | allowed fact types from Word |
| FR-015 | show customer history before agreement | history read boundary | customer history query | prior customer display | unauthorized/missing customer | ordered facts evidence | S5/S7/S11 | no import/history engine | future fact schema |
| FR-016 | similar prior work and executed price/date/type | minimal read boundary | similar-work query | matching read | price workflow invocation | read-only result | S6/S8 | no movement/approval | source of price field |
| FR-028 | extensible catalogs | data-driven values | catalog store/API | add and use new value | duplicate/inactive | no-source-change evidence | S8 | no admin extras | mutation authorization |
| AC-01 | create work without price and follow-up | yes | Work + follow-up | end-to-end synthetic | lost record/zero conflation | acceptance report | S6 | no pricing | none |
| AC-04 | customer has multiple works | yes | Customer/Work relation | concurrent independent works | merge or overwrite | IDs and links | S5/S7 | no batch workflow | none |
| AC-07 | documented payment issue shown | yes, read-only | fact/warning projection | prior fact visible | warning without evidence | evidence-linked display | S7 | no payment workflow | fact source boundary |
| AC-13 | new catalogs without code | yes | catalog API/store | add/use new value | duplicate/inactive | schema/API evidence | S8 | no admin UI expansion | authorization |
| P-06 | customer name/university/specialty/country and all work/history links | yes | Customer aggregate contract | required data linkage | missing owner/unauthorized | linkage evidence | S5/S7/S11 | no historical import | privacy details |
| S-03 | child linked to parent without losing history | partial S4 | relationship contract | pair and IDs | cycle/cross-customer | relation evidence | S5 | no events | parent policy |
| S-04 | independent vs dependent | yes | relationship contract | independent/child | merge/invalid relation | acceptance evidence | S5 | no event history | none |
| S-05 | follow-up and last contact boundary | partial S4 | current status/follow-up read | unset price/list | no event history claim | current projection | S5/S8 | no timeline | last-contact source |
| S-12 | several independent works | yes | Customer/Work relation | multiple works | overwrite/merge | IDs and audit | S5/S7 | no payments | none |
| S-13 | warning from evidence | yes | fact/warning projection | documented fact | arbitrary warning | fact-to-warning evidence | S7 | no scoring | fact taxonomy |
| S-14 | reason for zero price | partial read boundary | price state contract | unset/zero distinction | invent reason | state evidence | S6 | no pricing workflow | exact Word semantics |

## 18. Regression map

قبل Gate 1 يجب تشغيل S1 integrity وgovernance validation وapproved Word reconstruction، ثم S2 architecture validation وfinancial integer rules حيث تنطبق وno forbidden file/blob storage، ثم S3 static/regression: Firebase token verification، X.509/RS256، claims validation، two-user allowlist، unauthorized rejection، third-user rejection، private API fail-closed، D1 internal binding، server-side authorization، append-only audit، tamper resistance، secret scan.

هذه الوثيقة لا تعيد S3 Live، ولا Firebase provider acceptance، ولا Cloudflare billing checks، وتبقي `D-008` حاكمًا. أي validator جديد خاص بوثيقة S4 يجب أن يكون أقل تعديل ممكنًا ويُختبر على نفس branch؛ لا يعطل validator القديم ولا يخفف شروطه.

## 19. Failure-mode map

| failure mode | fail-closed behavior | planned evidence |
|---|---|---|
| duplicate customer ambiguity | رفض الدمج أو طلب اختيار صريح | negative test + conflict response |
| invalid work/customer relation | رفض mutation | validation test |
| missing parent | رفض child creation/update | negative test |
| circular parent relation | رفض relation | cycle test |
| cross-customer parent | رفض relation | scope test |
| inactive catalog value | رفض الاستخدام الجديد | catalog negative test |
| deleted/nonexistent catalog value | رفض reference | referential test |
| missing required detail | رفض فقط إذا كان required حاكمًا | requiredness matrix |
| warning without evidence | لا warning ولا mutation ناجحة | fact-to-warning test |
| unauthorized caller | 401/403 دون تسريب | auth test |
| third user | رفض وفق S3 | regression test |
| malformed request | رفض بلا partial write | schema test |
| nonexistent customer/work | not-found دون إنشاء | lookup test |
| concurrent update risk | version/conditional-write policy في Gate 1 | conflict test |
| audit write failure | transaction failure وعدم إعلان mutation | audit failure test |
| D1 transaction failure | rollback/fail closed | transaction test |

## 20. Gate 1 prerequisites

بعد دمج Gate 0 يجوز بدء Gate 1. في بدايته يجب مراجعة هذا العقد، وتثبيت implementation location وtest plan وacceptance evidence لكل عنصر في acceptance map. تُحسم requiredness من Word قبل تنفيذ الجزء المتأثر، وتُحسم schema details وconcurrency/version وaudit correlation من البنية الحالية بأقل تغيير متوافق، ولا تعد هذه البنود توقفًا إشرافيًا ما لم يظهر تعارض حقيقي. parent archived خارج سلوك S4 لأنه lifecycle تابع لـS5، ولا يكون Gate 1 blocker. يبقى `FR-016` read-only؛ فإذا وُجد authoritative price source يخطط Gate 1 لقراءته فقط، وإذا احتاج السلوك مصدرًا أو قرارًا غير موجود يعزل الجزء المتأثر دون إيقاف بقية Gate 1. تستخدم catalog mutation allowlist/role enforcement الموجود، ولا يُخترع admin role جديد؛ وأي قرار منتج حقيقي غير موجود يعزل mutation المتأثرة فقط.

كما يجب أن يكون Gate 1 PR منفصلًا ومحصورًا في implementation S4، مع schema/migration review، API tests، server-side authorization tests، audit tests، synthetic-only data، وعدم Cloud deployment إلا بتفويض مستقل لاحق. Gate 1 لا يبدأ من branch جديد قبل مراجعة ودمج Gate 0؛ يبدأ من merge SHA الناتج.

## 21. Unresolved decisions

تفصل Gate 1 بين قرارات تقنية يمكن حسمها ذاتيًا من Word أو من البنية الحالية في بدايتها، وقرارات منتج حقيقية غير موجودة في المرجع. القرارات التقنية لا توقف Gate 1؛ تُوثق قبل تنفيذ الجزء المتأثر. أما القرار المنتج الحقيقي فيعزل السلوك المتأثر فقط ولا يوقف بقية Gate 1، ولا تُخترع قاعدة بديلة.

العناصر التالية لا تُحسم في Gate 0 ولا تتحول إلى قواعد تنفيذية:

| القرار | سبب بقائه غير محسوم |
|---|---|
| required/optional/required-if-known لكل حقول `FR-005/FR-006` | يُحسم من Word في بداية Gate 1 قبل الجزء المتأثر؛ لا يتحول available/known إلى hard reject بلا سند |
| مصدر authoritative price لـ`FR-016` | read-only في S4؛ يعزل الجزء المتأثر إذا لم يوجد مصدر معتمد ولا يبني S6 |
| taxonomy الوقائع التي تنتج warnings | يجب ألا يتجاوز ما يثبته Word؛ يعزل projection المتأثرة إن بقي غموض حقيقي |
| سياسة catalog mutation authorization | تستخدم allowlist/role enforcement الموجود؛ لا admin role جديد، وتعزل mutation فقط عند حاجة قرار منتج |
| parent archived behavior | خارج سلوك S4 وضمن lifecycle لاحق؛ لا يكون Gate 1 blocker |
| concurrency/version policy | قرار تقني من البنية الحالية في بداية Gate 1 |
| شكل correlation marker مع audit S3 | قرار تقني يحافظ على البنية الحالية في بداية Gate 1 |
| `Q-001` إلى `Q-004` | قرارات لاحقة تخص S6/S7 ولا يجوز افتراضها |

## 22. Forbidden assumptions

لا يُفترض أن `PRICE_ZERO` يساوي `PRICE_UNSET`. لا يُفترض أن كل قيمة مفقودة hard error. لا يُفترض أن parent/child يبرر دمج السجلات. لا يُفترض أن warning يمكن إنشاؤه يدويًا. لا يُفترض وجود price source صالح لـ`FR-016` داخل S4؛ وإذا كان authoritative source موجودًا فالمسموح قراءة فقط. لا يُفترض أن S3 Live مكتملة أو أن D1/Worker/Audit أو CPU/Telemetry اجتازت؛ `D-008` يمنع ذلك. لا يُفترض وجود بيانات تاريخية قابلة للاستيراد. لا يُفترض أن قائمة ثابتة في source code تحقق `AC-13`. لا يُفترض أن UI authorization يحمي API. لا يُفترض rounding أو payment أو settlement أو approval behavior.

## 23. Planned PR structure

Gate 0 هو PR واحد بعنوان مقترح `docs(s4): define execution contract for customers and works` من branch مستقل مبني على `main@207e53d5279f89ff3833e28d76ff3aa85708a3d5`. Checkpoints المخططة هي:

| checkpoint | محتوى | commit expectation |
|---|---|---|
| A | baseline وauthoritative-scope extraction | عقد أولي ونطاق واضح |
| B | domain/security/boundary contract | invariants وauth/audit/phase boundaries |
| C | acceptance/traceability/regression contract | الجداول والاختبارات والفشل |
| D | final validation وPR-ready state | مراجعة diff وscope/secret/regression |

المخرج المتوقع من Gate 0 هو ملف `docs/s4/S4_EXECUTION_CONTRACT.md` فقط ما لم يثبت validator حاجة مباشرة لتعديل ملف آخر. إذا احتاج `validate_foundation.py` معرفة هذه الوثيقة أو D-008، يكون التعديل أقل ما يلزم داخل نفس branch وPR، مع اختبار regression. لا يُعدّل `docs/APPROVED_REQUIREMENTS.docx` أو production code أو D1 schema أو Firebase code أو S3 harness أو stable refs.

## Gate 0 status

```text
S4_GATE0_SCOPE = PLANNED
S4_IMPLEMENTATION = NOT_STARTED
GATE_1 = NOT_STARTED
CLOUD_WRITE = NO
PRODUCTION_CODE = NO
REAL_DATA = NO
```
