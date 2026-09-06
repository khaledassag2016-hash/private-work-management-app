const root = document.querySelector('#app');
const appConfig = window.__PRIVATE_WORK_APP_CONFIG__ || {};
const state = {
  auth: { status: 'checking', tokenProvider: null, email: '', role: '' },
  view: 'dashboard',
  customers: [],
  works: [],
  catalogs: { country: [], specialty: [], work_type: [] },
  selectedCustomer: null,
  selectedWork: null,
  financial: { periodKey: new Date().toISOString().slice(0, 7), preview: null, snapshots: [], reopenRequests: [], transfers: [], subscriptions: [], expenses: [], participants: [] },
  s8: { filters: { q: '', period_basis: 'CREATED_AT', month: '', year: '', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: false }, search: { items: [], page: 1, page_size: 25, has_more: false }, analytics: null, alerts: null, alertSettings: [], export_type: 'WORK', export_work_id: '', export_customer_id: '', loading: false },
  audit: { rows: [], loading: false },
  accountAdmin: { accounts: [], loading: false },
  modal: null,
  busy: false,
};
let modalInvoker = null;
let pendingConfirmation = null;

const labels = {
  TOKEN_MISSING: 'يلزم تسجيل الدخول للوصول إلى البيانات الخاصة.',
  TOKEN_REVOKED: 'تم إنهاء الجلسة بعد تغيير بيانات الحساب. سجّل الدخول مجددًا.',
  ACCOUNT_ADMIN_NOT_CONFIGURED: 'إدارة الحسابات غير مهيأة على الخادم بعد.',
  ACCOUNT_EMAIL_UNCHANGED: 'البريد الجديد مطابق للبريد الحالي.',
  UID_NOT_ALLOWED: 'هذا الحساب غير مصرح له باستخدام التطبيق.',
  CUSTOMER_NOT_FOUND: 'تعذر العثور على العميل المطلوب.',
  WORK_NOT_FOUND: 'تعذر العثور على العمل المطلوب.',
  VERSION_CONFLICT: 'تم تعديل السجل في جلسة أخرى. حدّث الصفحة ثم أعد المحاولة.',
  CATALOG_DUPLICATE: 'هذه القيمة موجودة مسبقًا في القائمة.',
  CATALOG_VALUE_INVALID: 'القيمة المختارة غير متاحة حاليًا في القائمة.',
  PARENT_NOT_FOUND: 'العمل الأصل غير موجود.',
  CROSS_CUSTOMER_PARENT: 'يجب أن يكون العمل الأصل تابعًا للعميل نفسه.',
  PARENT_CYCLE: 'لا يمكن إنشاء علاقة دائرية بين الأعمال.',
  SELF_PARENT: 'لا يمكن اختيار العمل نفسه كعمل أصل.',
  PARENT_REQUIRED: 'يلزم اختيار عمل أصل للعمل التابع.',
  PARENT_FOR_INDEPENDENT: 'لا يمكن ربط عمل مستقل بعمل أصل.',
  PRICE_UNSET_VALUE_FORBIDDEN: 'السعر غير محدد، لذلك لا يمكن إدخال قيمة سعرية هنا.',
  PRICE_ZERO_VALUE_REQUIRED: 'قيمة السعر الصفري يجب أن تكون صفرًا.',
  CUSTOMER_ID_REQUIRED: 'يلزم اختيار عميل للعمل.',
  WORK_TITLE_REQUIRED: 'عنوان العمل مطلوب.',
  WORK_COUNTRY_REQUIRED: 'الدولة مطلوبة لكل عمل.',
  JSON_INVALID: 'تعذر قراءة بيانات الطلب. أعد المحاولة.',
  NETWORK_ERROR: 'تعذر الاتصال بالخدمة. تحقق من الشبكة ثم أعد المحاولة.',
  POST_MUTATION_REFRESH_FAILED: 'تم حفظ التغيير، لكن تعذر تحديث العرض الحالي. أعد فتح العمل أو حدّث الصفحة للتحقق.',
  HTTP_401: 'انتهت الجلسة أو يلزم تسجيل الدخول مجددًا.',
  HTTP_400: 'الطلب غير صالح. راجع الحقول ثم أعد المحاولة.',
  HTTP_403: 'لا تملك صلاحية تنفيذ هذه العملية.',
  HTTP_404: 'السجل المطلوب غير موجود أو لم يعد متاحًا.',
  HTTP_409: 'توجد حالة تعارض. حدّث البيانات ثم أعد المحاولة.',
  HTTP_500: 'تعذر إكمال العملية في الخدمة. لم تُعرض تفاصيل داخلية ولم تُسجل حالة نجاح.',
  METHOD_NOT_ALLOWED: 'هذه العملية للقراءة فقط.',
  AUDIT_LIMIT_INVALID: 'حد قراءة سجل التدقيق غير صالح.',
  MALFORMED_RESPONSE: 'تعذر التحقق من استجابة الخدمة بأمان. لم تُحفظ أي بيانات جديدة.',
  FACT_SOURCE_REQUIRED: 'يلزم إدخال مصدر أو دليل للواقعة قبل حفظها.',
  FACT_TIME_REQUIRED: 'يلزم إدخال وقت الواقعة الموثقة.',
  CROSS_CUSTOMER_WORK: 'العمل المختار لا يتبع العميل الحالي.',
  CATALOG_KIND_INVALID: 'نوع القائمة المطلوب غير مدعوم.',
  AUDIT_EVIDENCE_MISSING: 'تعذر إثبات سجل التدقيق للعملية؛ لم تُعتمد النتيجة.',
  PRICING_OUT_OF_SCOPE: 'تعديل السعر خارج نطاق هذه الواجهة في S4.',
  DUPLICATE_CUSTOMER_AMBIGUITY: 'يوجد عميل باسم مماثل. راجع السجل قبل حفظ عميل جديد.',
  CUSTOMER_STATUS_DERIVED: 'لا يمكن إدخال حالة العميل الوقائعية يدويًا؛ أضف واقعة موثقة أولًا.',
  WORK_STATUS_INVALID: 'حالة العمل غير مدعومة في نطاق S4.',
  FACT_TIME_INVALID: 'وقت الواقعة غير صالح. استخدم تاريخًا ووقتًا صحيحين بصيغة UTC.',
  WARNING_CONTEXT_UNAVAILABLE: 'تعذر تحميل سياق العميل قبل إنشاء العمل. راجع الاتصال ثم أعد المحاولة؛ لا يمكن الحفظ قبل تحقق التحذيرات والتاريخ المتاحين.',
  PRE_AGREEMENT_CONTEXT_REQUIRED: 'يلزم نجاح تحميل تحذيرات العميل وتاريخه المتاح قبل إنشاء عمل جديد.',
  CUSTOMER_NAME_MISSING: 'اسم العميل غير متوفر حاليًا؛ يمكنك حفظ السجل واستكماله لاحقًا.',
  INTERNAL_ERROR: 'تعذر إكمال العملية بأمان. لم تعرض تفاصيل داخلية.',
  EVENT_TIME_REQUIRED: 'يلزم إدخال وقت الحدث.',
  EVENT_TIME_INVALID: 'وقت الحدث غير صالح.',
  EVENT_TYPE_REQUIRED: 'نوع الحدث مطلوب.',
  EVENT_DESCRIPTION_REQUIRED: 'وصف الحدث مطلوب.',
  TITLE_REQUIRED: 'العنوان الجديد مطلوب.',
  REASON_REQUIRED: 'السبب مطلوب ومبرر إلزاميًا.',
  STALE_VERSION: 'تم تعديل العمل في جلسة أخرى؛ حدّث البيانات ثم أعد المحاولة.',
  TARGET_STATUS_REQUIRED: 'الحالة المستهدفة مطلوبة لطلب الإلغاء.',
  TARGET_STATUS_INVALID: 'الحالة المستهدفة لطلب الإلغاء غير صالحة.',
  TARGET_STATUS_FORBIDDEN_FOR_ARCHIVE: 'لا يمكن تحديد حالة مستهدفة لطلب الأرشفة.',
  SELF_APPROVAL_REJECTED: 'لا يمكن اعتماد طلبك الشخصي بموجب قواعد الموافقة الثنائية.',
  ALREADY_FINALIZED: 'تم اعتماد أو إنهاء هذا الطلب مسبقًا.',
  REQUEST_WORK_MISMATCH: 'مستند الطلب لا يتطابق مع العمل الحالي.',
  REQUEST_NOT_FOUND: 'الطلب غير موجود.',
  ACTION_REQUIRED: 'العملية المطلوبة غير محددة.',
  ACTION_INVALID: 'العملية المطلوبة غير مدعومة.',
  PRICE_REQUEST_NOT_FOUND: 'طلب السعر غير موجود.',
  RATIO_REQUEST_NOT_FOUND: 'طلب النسبة غير موجود.',
  MOVEMENT_TYPE_REQUIRED: 'نوع حركة السعر مطلوب.',
  MOVEMENT_TYPE_INVALID: 'نوع حركة السعر غير مدعوم.',
  MOVEMENT_SIGN_INVALID: 'إشارة قيمة الحركة لا تطابق نوعها.',
  BASE_REQUIRED: 'يجب اعتماد السعر الأساسي أولًا.',
  BASE_ALREADY_SET: 'تم اعتماد السعر الأساسي لهذا العمل مسبقًا.',
  RATIO_INVALID: 'يجب أن تكون النسبتان صحيحتين ومجموعهما 100%.',
  S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED: 'لا يمكن اعتماد هذه الحركة لأنها تجعل السعر النهائي سالبًا. لم يتغير السعر الحالي.',
  APPROVAL_REQUIRED: 'لا يمكن اعتماد الطلب إلا بالحساب الآخر.',
  PRICE_APPROVED: 'السعر معتمد.',
  PRICE_UNSET: 'السعر غير محدد بعد.',
  PAYMENT_AMOUNT_INVALID: 'قيمة الدفعة يجب أن تكون موجبة وبصيغة مالية صحيحة.',
  PAYMENT_METHOD_INVALID: 'طريقة الدفع غير مدعومة.',
  PRICE_UNSET_PAYMENT_FORBIDDEN: 'لا يمكن تسجيل دفعة قبل اعتماد سعر العمل.',
  S7_OVERPAYMENT_POLICY_UNRESOLVED: 'لا يمكن تسجيل دفعة تتجاوز المتبقي المعتمد.',
  PAYMENT_ID_REQUIRED: 'يلزم اختيار الدفعة المطلوب تصحيحها.',
  PAYMENT_NOT_FOUND: 'الدفعة المطلوبة غير موجودة.',
  PAYMENT_WORK_MISMATCH: 'الدفعة لا تنتمي إلى هذا العمل.',
  REVERSAL_ALREADY_PENDING: 'يوجد طلب تصحيح معلق لهذه الدفعة.',
  REVERSAL_ALREADY_APPROVED: 'تم تصحيح هذه الدفعة مسبقًا بسجل مستقل.',
  REOPEN_REASON_REQUIRED: 'سبب إعادة فتح التسوية مطلوب.',
  SETTLEMENT_ALREADY_CLOSED: 'الفترة مقفلة بالفعل. يلزم اعتماد إعادة الفتح قبل إقفال نسخة جديدة.',
  SETTLEMENT_NOT_CLOSED: 'لا يمكن طلب إعادة فتح فترة لم تُقفل بعد.',
  CLOSED_PERIOD_MUTATION_FORBIDDEN: 'الفترة المالية مقفلة. اطلب إعادة فتح معتمدة قبل أي تعديل مؤثر.',
  S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED: 'المصروف المشترك محفوظ كسجل، لكن لا يمكن إقفال التسوية قبل اعتماد قاعدة توزيعه.',
  SUBSCRIPTION_PAYER_MUST_BE_PERSON_2: 'يسجل الاشتراك من الحساب الثاني بوصفه الدافع الفعلي.',
  TRANSFER_DIRECTION_INVALID: 'يجب أن يكون طرفا التحويل مختلفين.',
  TRANSFER_FEE_PAYER_INVALID: 'قاعدة هذه المرحلة تثبت أن دافع رسوم التحويل هو الشخص الأول.',
  S8_PERIOD_BASIS_REQUIRED: 'يلزم تحديد أساس الفترة قبل استخدام الشهر أو السنة.',
  S8_PERIOD_BASIS_INVALID: 'أساس الفترة غير مدعوم.',
  S8_MONTH_INVALID: 'الشهر غير صالح.',
  S8_YEAR_INVALID: 'السنة غير صالحة.',
  S8_INCLUDE_ARCHIVED_INVALID: 'نطاق الأرشيف غير صالح.',
  S8_COLLECTION_INVALID: 'حالة التحصيل غير مدعومة.',
  S8_PAGE_INVALID: 'صفحة البحث غير صالحة.',
  S8_PAGE_SIZE_INVALID: 'حجم صفحة البحث غير صالح.',
  S8_EXPORT_PAGE_SIZE_INVALID: 'حجم صفحة التصدير غير صالح.',
  S8_EXPORT_CURSOR_INVALID: 'مؤشر التصدير غير صالح.',
  S8_FOLLOW_UP_CURSOR_INVALID: 'مؤشر سجل المتابعة غير صالح.',
  S8_WARNING_CURSOR_INVALID: 'مؤشر التحذيرات غير صالح.',
  S8_EXPORT_TYPE_INVALID: 'نوع التصدير غير مدعوم.',
  S8_EXPORT_PERIOD_REQUIRED: 'يلزم تحديد شهر وسنة للتصدير الشهري.',
  S8_ALERT_THRESHOLD_INVALID: 'أدخل عدد أيام صحيحًا موجبًا ضمن المجال المسموح.',
  S8_ALERT_TYPE_INVALID: 'نوع التنبيه غير مدعوم.',
  S8_ALERT_SETTINGS_REQUIRED: 'أدخل مدة واحدة على الأقل لحفظ إعدادات التنبيه.',
  CANCELLED_WORK_OPERATION_FORBIDDEN: 'هذا العمل ملغى؛ لا يمكن تعديل السعر أو النسبة أو تسجيل دفعة جديدة. يمكن قراءة السجل أو تصحيح دفعة معتمدة فقط.',
};
const WORK_STATUS_LABELS = Object.freeze({
  NEW_REQUEST: 'طلب جديد',
  REQUIREMENT_REVIEW: 'قيد دراسة المطلوب',
  NEEDS_PRICING: 'يحتاج تسعير',
  WAITING_CLIENT_RESPONSE: 'بانتظار رد العميل',
  NEEDS_FOLLOW_UP: 'يحتاج متابعة',
  AGREED: 'متفق عليه',
  IN_PROGRESS: 'قيد التنفيذ',
  WAITING_CUSTOMER_INFO: 'بانتظار معلومات من العميل',
  WAITING_REVIEW: 'بانتظار مراجعة العميل/المشرف',
  REVISION_REQUIRED: 'تعديل مطلوب',
  PAUSED: 'متوقف مؤقتًا',
  CANCELLED_BEFORE_EXECUTION: 'ملغى قبل التنفيذ',
  PARTIALLY_STOPPED: 'متوقف بعد تنفيذ جزئي',
  COMPLETED: 'مكتمل',
  DELIVERED: 'مسلم',
});
const CUSTOMER_STATUS_LABELS = Object.freeze({ normal: 'تظهر التنبيهات من الوقائع المسجلة عند وجودها.' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
const USER_DATE_LOCALE = 'ar-SA-u-ca-gregory';
function dateLabel(value) {
  if (!value) return 'غير متاح';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'غير متاح' : new Intl.DateTimeFormat(USER_DATE_LOCALE, { dateStyle: 'medium' }).format(date);
}
function idLabel(value) { return value ? `${String(value).slice(0, 8)}…` : '—'; }
function dateTimeLabel(value) {
  if (!value) return 'غير متاح';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'غير متاح' : new Intl.DateTimeFormat(USER_DATE_LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function twoDigits(value) { return String(value).padStart(2, '0'); }
function dateTimeInputLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${twoDigits(date.getDate())}/${twoDigits(date.getMonth() + 1)}/${date.getFullYear()} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}
function parseDateTimeInput(value) {
  const normalized = String(value || '').trim()
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  const match = normalized.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText, hourText, minuteText] = match;
  const day = Number(dayText); const month = Number(monthText); const year = Number(yearText); const hour = Number(hourText); const minute = Number(minuteText);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) return null;
  return date.toISOString();
}
function catalogLabel(kind, value) {
  if (!value || value === 'UNSPECIFIED') return 'غير محدد';
  return state.catalogs[kind]?.find(item => item.value_key === value)?.label || 'قيمة محفوظة';
}
function workStatusLabel(value) { return WORK_STATUS_LABELS[value] || 'حالة محفوظة'; }
function customerFactLabel(value) { return ({ NON_PAYMENT: 'عدم دفع', DELAY: 'تأخر', BLOCKED: 'حظر أو انقطاع', DISPUTE: 'نزاع' }[value] || 'واقعة مسجلة'); }
function entityTypeLabel(value) {
  return ({
    customer: 'عميل', work: 'عمل', work_event: 'متابعة عمل', title_history: 'تغيير عنوان', status_history: 'تغيير حالة',
    documented_fact: 'واقعة عميل', catalog_value: 'قيمة قائمة', s8_alert_setting: 'إعداد تنبيه',
    financial_request: 'طلب مالي', price_change_request: 'طلب تغيير سعر', price_movement: 'حركة سعر',
    ratio_change_request: 'طلب تغيير نسبة', ratio_history: 'تغيير نسبة', payment: 'دفعة', client_payment: 'دفعة',
    payment_reversal_request: 'طلب تصحيح دفعة', payment_reversal: 'تصحيح دفعة', inter_party_transfer: 'تحويل بين الطرفين',
    subscription_history: 'اشتراك', common_expense: 'مصروف مشترك', cancel_archive_request: 'طلب إلغاء أو أرشفة',
    settlement: 'تسوية', settlement_snapshot: 'تسوية', settlement_reopen_request: 'طلب إعادة فتح التسوية',
    settlement_adjustment: 'تعديل تسوية', account_admin: 'إدارة حساب'
  }[value] || 'سجل');
}
function auditActionLabel(action) { return ({ CREATE: 'إنشاء', UPDATE: 'تعديل', DELETE: 'حذف', APPROVE: 'اعتماد', REVERSE: 'تصحيح' }[action] || 'عملية'); }
const AUDIT_FIELD_LABELS = Object.freeze({
  name: 'الاسم', title: 'العنوان', old_title: 'العنوان السابق', new_title: 'العنوان الجديد',
  contact: 'رقم التواصل', country: 'الدولة', university: 'الجامعة', specialty: 'التخصص', specialty_key: 'التخصص',
  work_type_key: 'نوع العمل', subject_or_course_code: 'المادة أو الرمز', status: 'الحالة', old_status: 'الحالة السابقة', new_status: 'الحالة الجديدة',
  target_execution_status: 'حالة التنفيذ بعد الإجراء', relationship_kind: 'علاقة العمل', description: 'الوصف', quantity: 'الكمية',
  notes: 'ملاحظات', note: 'ملاحظة', reason: 'السبب', category: 'الفئة', source_ref: 'المرجع',
  event_type: 'نوع المتابعة', fact_type: 'نوع الواقعة', movement_type: 'نوع حركة السعر', collection_status: 'حالة التحصيل',
  payment_method: 'طريقة الدفع', action: 'الإجراء', state: 'الحالة', price_state: 'حالة السعر',
  period_key: 'الفترة', period_basis: 'أساس الفترة', alert_type: 'نوع التنبيه', threshold_days: 'المدة بالأيام',
  kind: 'نوع القائمة', label: 'الاسم الظاهر', active: 'فعال', is_archived: 'مؤرشف',
  from_party: 'من', to_party: 'إلى', fee_payer: 'دافع الرسوم',
  requested_by: 'مقدم الطلب', approved_by: 'معتمد الطلب', created_by: 'من أنشأ السجل', updated_by: 'من حدّث السجل',
  changed_by: 'من أجرى التغيير', actor_uid: 'من قام بالعملية', paid_by_uid: 'الدافع', received_by: 'مستلم الدفعة', recorded_by: 'سُجلت بواسطة',
  details_json: 'التفاصيل', value: 'القيمة',
  person_1_bps: 'نسبة الطرف الأول', person_2_bps: 'نسبة الطرف الثاني',
  old_person_1_bps: 'نسبة الطرف الأول السابقة', old_person_2_bps: 'نسبة الطرف الثاني السابقة',
  new_person_1_bps: 'نسبة الطرف الأول الجديدة', new_person_2_bps: 'نسبة الطرف الثاني الجديدة',
  work_count: 'عدد الأعمال', active_work_count: 'الأعمال النشطة', archived_work_count: 'الأعمال المؤرشفة',
  price_unset_work_count: 'أعمال بلا سعر',
  amount_halalas: 'المبلغ', fee_halalas: 'الرسوم', aggregate_amount_halalas: 'إجمالي الاشتراك',
  current_price_halalas: 'السعر الحالي', previous_price_halalas: 'السعر السابق', new_price_halalas: 'السعر الجديد',
  resulting_price_halalas: 'السعر بعد الحركة', remaining_halalas: 'المتبقي', customer_remaining_halalas: 'المتبقي على العميل',
  approved_paid_halalas: 'المدفوع المعتمد', approved_payments_total_halalas: 'إجمالي التحصيل المعتمد',
  approved_receipts_halalas: 'المتحصل المعتمد', approved_receipts_person_1_halalas: 'استلام الطرف الأول',
  approved_receipts_person_2_halalas: 'استلام الطرف الثاني', gross_paid_halalas: 'إجمالي المدفوع',
  reversed_paid_halalas: 'الدفعات المصححة', reversal_amount_halalas: 'مبلغ التصحيح',
  total_work_value_halalas: 'إجمالي قيمة الأعمال', person_1_work_share_halalas: 'حصة الطرف الأول من الأعمال',
  person_2_work_share_halalas: 'حصة الطرف الثاني من الأعمال', person_1_halalas: 'حصة الطرف الأول', person_2_halalas: 'حصة الطرف الثاني',
  prior_balance_halalas: 'الرصيد السابق', final_balance_halalas: 'الرصيد النهائي',
  subscription_total_halalas: 'إجمالي الاشتراكات', governed_expense_total_halalas: 'إجمالي المصروفات المشتركة',
  transfer_amount_halalas: 'إجمالي التحويلات', transfer_fee_halalas: 'رسوم التحويل',
  subscription_effect_person_1_halalas: 'أثر الاشتراك على الطرف الأول', subscription_effect_person_2_halalas: 'أثر الاشتراك على الطرف الثاني',
  transfer_fee_effect_person_1_halalas: 'أثر رسوم التحويل على الطرف الأول', transfer_fee_effect_person_2_halalas: 'أثر رسوم التحويل على الطرف الثاني',
  settlement_adjustment_person_1_halalas: 'تعديل تسوية الطرف الأول', settlement_adjustment_person_2_halalas: 'تعديل تسوية الطرف الثاني',
  recognized_person_1_before_halalas: 'المعتمد سابقًا للطرف الأول', recognized_person_2_before_halalas: 'المعتمد سابقًا للطرف الثاني',
  corrected_person_1_after_halalas: 'المعتمد بعد التصحيح للطرف الأول', corrected_person_2_after_halalas: 'المعتمد بعد التصحيح للطرف الثاني',
  person_1_delta_halalas: 'فرق الطرف الأول', person_2_delta_halalas: 'فرق الطرف الثاني',
  governed_expense_net_effect_to_person_2_halalas: 'أثر المصروفات على الطرف الثاني', transfer_net_person_2_halalas: 'صافي أثر التحويل على الطرف الثاني'
});
const AUDIT_TECHNICAL_FIELD = /(^id$|_id$|request_id$|run_marker$|(^|_)version$|value_key$|price_minor_units$|approval_request_id$|internal_share_basis_halalas$)/;
function auditFieldLabel(key) {
  if (AUDIT_TECHNICAL_FIELD.test(key)) return '';
  if (AUDIT_FIELD_LABELS[key]) return AUDIT_FIELD_LABELS[key];
  if (key.endsWith('_at')) return 'التاريخ والوقت';
  return '';
}
function auditUserLabel(value, row) {
  if (!value) return 'غير محدد';
  if (value === row?.actor_uid) return roleLabel(row.actor_role);
  if (value === state.auth.uid) return roleLabel(state.auth.role);
  return 'الحساب الآخر المصرح';
}
function auditPartyLabel(value) { return value === 'person_1' ? 'الطرف الأول' : value === 'person_2' ? 'الطرف الثاني' : 'طرف مسجل'; }
function auditEventTypeLabel(value) { return ({ FOLLOW_UP: 'متابعة', NOTE: 'ملاحظة', CONTACT: 'تواصل', MEETING: 'اجتماع', DELIVERY: 'تسليم' }[value] || 'متابعة مسجلة'); }
function auditRequestActionLabel(value) { return ({ CANCEL: 'إلغاء العمل', ARCHIVE: 'أرشفة العمل' }[value] || 'إجراء مسجل'); }
function auditPriceStateLabel(value) { return value === 'PRICE_UNSET' || value === 'UNSET' ? 'السعر غير محدد' : value === 'PRICED' || value === 'APPROVED' ? 'السعر معتمد' : 'حالة سعر محفوظة'; }
function auditPeriodBasisLabel(value) { return value === 'CONFIRMED_AT' ? 'تاريخ التأكيد' : value === 'CREATED_AT' ? 'تاريخ الإنشاء' : 'أساس فترة محفوظ'; }
function auditAlertTypeLabel(value) { return ({ NO_PRICE: 'بلا سعر', NO_REPLY: 'بانتظار رد العميل', NO_PAYMENT: 'دون تحصيل' }[value] || 'تنبيه مسجل'); }
function auditCatalogKindLabel(value) { return ({ country: 'الدول', specialty: 'التخصصات', work_type: 'أنواع الأعمال' }[value] || 'قائمة'); }
function auditMovementTypeLabel(value) { return ({ BASE: 'سعر أساسي', INCREASE: 'زيادة', DECREASE: 'نقصان', DISCOUNT: 'خصم' }[value] || 'حركة سعر'); }
function auditCollectionStatusLabel(value) { return ({ PRICE_UNSET: 'السعر غير محدد', UNPAID: 'غير محصل', PARTIALLY_COLLECTED: 'تحصيل جزئي', FINANCIALLY_CLOSED: 'مغلق ماليًا', OVERPAYMENT_UNRESOLVED: 'تجاوز غير محسوم', CANCELLED_ZERO_BALANCE: 'ملغى — الرصيد على العميل صفر' }[value] || 'حالة تحصيل محفوظة'); }
function auditDetailsLabel(value) {
  if (!value) return 'لا توجد تفاصيل';
  if (typeof value === 'object' && !Array.isArray(value)) return String(value.note || 'تفاصيل مسجلة');
  try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' ? String(parsed.note || 'تفاصيل مسجلة') : String(parsed); }
  catch { return 'تفاصيل مسجلة'; }
}
function auditFieldValue(key, value, row) {
  if (value === null || value === undefined || value === '') return 'غير محدد';
  if (key.endsWith('_halalas')) return moneyLabel(Number(value));
  if (key.endsWith('_at')) return dateTimeLabel(value);
  if (key.endsWith('_bps')) return `${Number(value) / 100}%`;
  if (['requested_by', 'approved_by', 'created_by', 'updated_by', 'changed_by', 'actor_uid', 'paid_by_uid', 'received_by', 'recorded_by'].includes(key)) return auditUserLabel(value, row);
  if (key === 'status' || key === 'old_status' || key === 'new_status' || key === 'target_execution_status') return workStatusLabel(value);
  if (key === 'relationship_kind') return value === 'CHILD' ? 'تابع لعمل أكبر' : value === 'INDEPENDENT' ? 'عمل مستقل' : 'علاقة محفوظة';
  if (key === 'country') return catalogLabel('country', value);
  if (key === 'specialty' || key === 'specialty_key') return catalogLabel('specialty', value);
  if (key === 'work_type_key') return catalogLabel('work_type', value);
  if (key === 'payment_method') return paymentMethodLabel(value);
  if (key === 'fact_type') return customerFactLabel(value);
  if (key === 'movement_type') return auditMovementTypeLabel(value);
  if (key === 'collection_status') return auditCollectionStatusLabel(value);
  if (key === 'event_type') return auditEventTypeLabel(value);
  if (key === 'action') return auditRequestActionLabel(value);
  if (key === 'price_state') return auditPriceStateLabel(value);
  if (key === 'period_basis') return auditPeriodBasisLabel(value);
  if (key === 'period_key') return periodBucketLabel(value);
  if (key === 'alert_type') return auditAlertTypeLabel(value);
  if (key === 'kind') return auditCatalogKindLabel(value);
  if (key === 'state') return requestStateLabel(value);
  if (key === 'from_party' || key === 'to_party' || key === 'fee_payer') return auditPartyLabel(value);
  if (key === 'details_json') return auditDetailsLabel(value);
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (typeof value === 'object') return 'تفاصيل مسجلة';
  return String(value);
}
function auditValueMarkup(value, row) {
  if (value === null) return '<span class="audit-empty">لا توجد قيمة سابقة.</span>';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '<span class="audit-empty">قيمة مسجلة.</span>';
  const entries = Object.entries(value).map(([key, item]) => [key, item, auditFieldLabel(key)]).filter(([, , label]) => label);
  return entries.length
    ? `<dl class="audit-values">${entries.map(([key, item, label]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(auditFieldValue(key, item, row))}</dd></div>`).join('')}</dl>`
    : '<span class="audit-empty">لا توجد تفاصيل إضافية للعرض.</span>';
}
function requestId() { return crypto.randomUUID(); }
function toast(message, kind = '') {
  const region = document.querySelector('.toast-region') || Object.assign(document.createElement('div'), { className: 'toast-region' });
  region.setAttribute?.('aria-live', kind === 'error' ? 'assertive' : 'polite');
  region.setAttribute?.('aria-atomic', 'true');
  if (!region.parentNode) document.body.append(region);
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.setAttribute?.('role', kind === 'error' ? 'alert' : 'status');
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), 4400);
}
function syncBusyControls() {
  const controls = document.querySelectorAll?.('form button[type="submit"], [data-action^="approve-"], [data-action="request-payment-reversal"]') || [];
  controls.forEach(control => {
    if (state.busy && !control.hasAttribute?.('aria-disabled')) {
      control.disabled = true;
      control.dataset.s9Pending = 'true';
      control.setAttribute?.('aria-busy', 'true');
    } else if (!state.busy && control.dataset?.s9Pending === 'true') {
      control.disabled = false;
      delete control.dataset.s9Pending;
      control.removeAttribute?.('aria-busy');
    }
  });
}
function setBusy(value) { state.busy = value; root.setAttribute?.('aria-busy', String(value)); syncBusyControls(); }
function confirmSensitive(action, effect) {
  if (state.busy) return Promise.resolve(false);
  if (window.__PRIVATE_WORK_APP_TEST__) return Promise.resolve(true);
  return new Promise(resolve => {
    pendingConfirmation = resolve;
    openModal({ type: 'confirmation', data: { action, effect } });
  });
}
function resolveConfirmation(value) {
  const resolver = pendingConfirmation;
  pendingConfirmation = null;
  const invoker = modalInvoker;
  state.modal = null;
  modalInvoker = null;
  render();
  Promise.resolve().then(() => (invoker?.selector && document.querySelector(invoker.selector) || invoker?.element)?.focus?.());
  resolver?.(value);
}
function errorMessage(code) { return labels[code] || 'حدث خطأ تحقق. لم تعرض تفاصيل داخلية.'; }
function queryString(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') params.set(key, value); });
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function createFirebaseAdapter() {
  if (typeof appConfig.getIdToken === 'function') return { getToken: appConfig.getIdToken, signOut: appConfig.signOut || (() => Promise.resolve()), email: appConfig.email || '' };
  if (!appConfig.firebaseConfig) return null;
  const [{ initializeApp }, { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut }] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
  ]);
  const firebaseApp = initializeApp(appConfig.firebaseConfig);
  const auth = getAuth(firebaseApp);
  let initialUserPromise = null;
  function waitForInitialUser() {
    if (initialUserPromise) return initialUserPromise;
    initialUserPromise = new Promise(resolve => {
      let unsubscribe = null;
      const finish = user => { const stop = unsubscribe; unsubscribe = null; stop?.(); resolve(user || null); };
      unsubscribe = onAuthStateChanged(auth, finish, () => finish(null));
    });
    return initialUserPromise;
  }
  return {
    waitForInitialUser,
    async getToken() { return auth.currentUser ? auth.currentUser.getIdToken() : null; },
    signIn(email, password) { return signInWithEmailAndPassword(auth, email, password); },
    signOut() { return signOut(auth); },
    observe(callback) { return onAuthStateChanged(auth, callback); },
    getEmail() { return auth.currentUser?.email || ''; },
  };
}

async function api(path, options = {}) {
  const token = await state.auth.tokenProvider?.getToken();
  if (!token) {
    const error = new Error('TOKEN_MISSING'); error.code = 'TOKEN_MISSING'; throw error;
  }
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('x-s3-request-id', requestId());
  headers.set('Accept', 'application/json');
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(`${appConfig.apiBaseUrl || ''}${path}`, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  } catch {
    const error = new Error('NETWORK_ERROR'); error.code = 'NETWORK_ERROR'; throw error;
  }
  let payload = null;
  try { payload = await response.json(); } catch { const error = new Error('MALFORMED_RESPONSE'); error.code = 'MALFORMED_RESPONSE'; throw error; }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.code || `HTTP_${response.status}`); error.code = payload?.code || `HTTP_${response.status}`; error.status = response.status; throw error;
  }
  return payload.data;
}

async function loadCatalogs() {
  const entries = await Promise.all(['country', 'specialty', 'work_type'].map(async kind => [kind, await api(`/api/catalog/${kind}`)]));
  state.catalogs = Object.fromEntries(entries);
}
async function loadAuditLog() {
  state.audit.loading = true;
  try { state.audit.rows = await api('/api/audit?limit=50'); }
  finally { state.audit.loading = false; }
}
async function loadDashboard() {
  const [customers, works] = await Promise.all([api('/api/customers'), api('/api/works')]);
  state.customers = customers; state.works = works;
}
async function authenticateExistingSession() {
  try {
    const adapter = await createFirebaseAdapter();
    if (!adapter) { state.auth.status = 'needs_configuration'; render(); return; }
    state.auth.tokenProvider = adapter;
    await adapter.waitForInitialUser?.();
    const token = await adapter.getToken();
    if (!token) { state.auth.status = 'signed_out'; render(); return; }
    const ping = await api('/private/ping');
    state.auth.status = 'signed_in';
    state.auth.uid = ping.uid || '';
    state.auth.email = adapter.getEmail?.() || adapter.email || '';
    state.auth.role = ping.role || '';
    await Promise.all([loadCatalogs(), loadDashboard()]);
    render();
  } catch (error) {
    state.auth.status = error.code === 'UID_NOT_ALLOWED' ? 'forbidden' : 'signed_out';
    render();
  }
}

function authScreen() {
  const configured = Boolean(appConfig.firebaseConfig || typeof appConfig.getIdToken === 'function');
  const message = state.auth.status === 'forbidden' ? 'تم التحقق من الحساب، لكنه غير موجود في قائمة السماح المكونة من الشخصين.' : configured ? 'سجّل الدخول بأحد الحسابين المعتمدين. لا توجد شاشة لإنشاء حسابات جديدة.' : 'تحتاج الواجهة إلى تهيئة تسجيل الدخول من إعدادات النشر قبل الاستخدام.';
  return `<section class="auth-screen"><div class="auth-card">
    <div class="brand-lockup"><div class="brand-mark">إ</div><div><h1>إدارة الأعمال الخاصة</h1><p>مساحة مغلقة لشخصين فقط</p></div></div>
    <h2>${state.auth.status === 'forbidden' ? 'الوصول غير مصرح' : 'تسجيل الدخول'}</h2><p>${message}</p>
    ${configured && state.auth.status !== 'forbidden' ? `<form id="login-form" class="grid"><div class="field"><label for="email">البريد الإلكتروني</label><input id="email" name="email" class="input" type="email" required autocomplete="email" /></div><div class="field"><label for="password">كلمة المرور</label><input id="password" name="password" class="input" type="password" required autocomplete="current-password" /></div><button class="button" type="submit">تسجيل الدخول</button></form>` : ''}
  </div></section>`;
}

function shell(content) {
  const nav = [
    ['dashboard', 'نظرة عامة'], ['customers', 'العملاء'], ['works', 'الأعمال'], ['financial', 'التحصيل والتسويات'], ['s8', 'البحث والتحليلات'], ['catalogs', 'القوائم'], ['audit', 'سجل التدقيق'],
  ].map(([id, label]) => `<button class="nav-item" data-nav="${id}" ${state.view === id ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  return `<div class="shell"><aside class="sidebar"><div class="brand-lockup"><div class="brand-mark">إ</div><div><h1>إدارة الأعمال</h1><p>العملاء والأعمال</p></div></div><nav class="nav-list" aria-label="التنقل الرئيسي">${nav}</nav><div class="sidebar-footer">صلاحياتك مخصصة للحساب الحالي، وكل تغيير موثق وقابل للمراجعة.</div></aside><section class="content"><header class="topbar"><div><h1>${pageTitle()}</h1><p>${escapeHtml(pageSubtitle())}</p></div><div class="identity"><div><strong>${escapeHtml(state.auth.email || 'حساب مصرح')}</strong><br/><span>${escapeHtml(roleLabel(state.auth.role))}</span></div><div class="avatar">${escapeHtml((state.auth.email || 'م').slice(0, 1))}</div><button class="button ghost" id="sign-out" type="button">خروج</button></div></header>${content}${accountAdminMarkup()}</section></div>${modalMarkup()}`;
}
async function loadAccountAdmin() {
  if (state.auth.role !== 'person_1') return;
  state.accountAdmin.loading = true;
  try { state.accountAdmin.accounts = await api('/api/account-admin/accounts'); }
  finally { state.accountAdmin.loading = false; }
}
function accountAdminMarkup() {
  if (state.view !== 'audit' || state.auth.role !== 'person_1') return '';
  const accounts = state.accountAdmin.accounts || [];
  return `<section class="card" data-account-admin style="margin-top:1rem"><div class="toolbar"><div><h2>إدارة الحسابات</h2><p>متاحة لخالد فقط. تغيير البريد ينهي الجلسات السابقة للحساب، وإعادة التعيين تُرسل إلى البريد الحالي الموثوق من الخادم دون كشف كلمة المرور.</p></div><span class="badge ok">خالد — مسؤول الحسابات</span></div>${state.accountAdmin.loading ? loading() : accounts.length ? `<div class="fact-list">${accounts.map(account => `<div class="account-admin-row" data-role="${escapeHtml(account.role)}"><div><strong>${escapeHtml(account.display_name || roleLabel(account.role))}</strong><br/><span>${escapeHtml(account.email || 'بريد غير متاح')}</span> <span class="badge ${account.disabled ? 'warn' : 'ok'}">${account.disabled ? 'معطل' : 'نشط'}</span></div><form class="account-email-form" data-role="${escapeHtml(account.role)}"><label>البريد الجديد<input class="input" type="email" name="email" autocomplete="email" value="${escapeHtml(account.email || '')}" required/></label><button class="button secondary" type="submit">تغيير البريد</button></form><form class="account-reset-form" data-role="${escapeHtml(account.role)}"><button class="button ghost" type="submit">إرسال رابط إعادة التعيين إلى البريد الحالي</button></form></div>`).join('')}</div>` : empty('لا توجد حسابات نشطة لإدارتها.')}`;
}
async function submitAccountEmail(event) {
  event.preventDefault(); const form = event.currentTarget; const role = form.dataset.role; const values = formObject(form);
  if (!(await confirmSensitive('تغيير بريد الحساب', 'سيؤدي التغيير إلى إنهاء الجلسات السابقة للحساب وإلزامه بتسجيل الدخول مجددًا.'))) return;
  await submitFlow(async () => {
    const result = await api(`/api/account-admin/accounts/${encodeURIComponent(role)}/email`, { method: 'POST', body: { email: values.email } });
    if (result.role === state.auth.role) {
      await state.auth.tokenProvider?.signOut?.();
      state.auth = { status: 'signed_out', tokenProvider: state.auth.tokenProvider, email: '', role: '' };
      render(); toast('تم تغيير البريد وإنهاء الجلسة. سجّل الدخول بالبريد الجديد.', ''); return;
    }
    await loadAccountAdmin(); render(); toast('تم تغيير البريد وإنهاء جلسات الحساب السابقة.', '');
  });
}
async function submitAccountReset(event) {
  event.preventDefault(); const form = event.currentTarget; const role = form.dataset.role;
  if (!(await confirmSensitive('إرسال رابط إعادة تعيين كلمة المرور', 'سيصل الرابط إلى البريد الحالي المسجل للحساب، ولا تُعرض كلمة المرور داخل التطبيق.'))) return;
  await submitFlow(async () => { await api(`/api/account-admin/accounts/${encodeURIComponent(role)}/password-reset`, { method: 'POST', body: {} }); await loadAccountAdmin(); render(); toast('تم إرسال رابط إعادة التعيين إلى البريد الحالي وتسجيل العملية.', ''); });
}
function pageTitle() { return ({ dashboard: 'نظرة عامة', customers: 'العملاء', works: 'الأعمال', financial: 'التحصيل والتسويات', s8: 'البحث والتحليلات', catalogs: 'القوائم', audit: 'سجل التدقيق', customer: 'سجل العميل', work: 'تفاصيل العمل' }[state.view] || 'إدارة الأعمال'); }
function pageSubtitle() { return ({ dashboard: 'ملخص سريع للعملاء والأعمال التي تحتاج متابعة.', customers: 'إدارة بيانات العملاء وسجل التعامل.', works: 'متابعة الأعمال وحالتها الحالية.', financial: 'متابعة التحصيل والتسويات المالية.', s8: 'ابحث في الأعمال وراجع التحليلات والتقارير.', catalogs: 'إدارة القيم المتاحة في القوائم.', audit: 'راجع التغييرات المسجلة في التطبيق.', customer: 'بيانات العميل وأعماله وسجل التعامل.', work: 'بيانات العمل وحالته وسجلاته المرتبطة.' }[state.view] || 'إدارة الأعمال الخاصة.'); }
function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function loading(message = 'جارٍ تحميل البيانات…') { return `<div class="loading"><span class="spinner"></span>${escapeHtml(message)}</div>`; }
function isPricingUnset(work) { return (work.pricing_state || work.price_state) === 'PRICE_UNSET'; }
function moneyLabel(value) {
  if (value === null || value === undefined) return 'غير محدد';
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) return 'غير متاح';
  const sign = amount < 0 ? '-' : '';
  const absolute = Math.abs(amount);
  const riyals = Math.floor(absolute / 100);
  const halalas = absolute % 100;
  return `${sign}${riyals}${halalas ? `.${twoDigits(halalas)}` : ''} ريال`;
}
function roleLabel(value) { return value === 'person_1' ? 'خالد' : value === 'person_2' ? 'وليد' : 'مستخدم مصرح'; }
function ratioPercentLabel(ratio) { return `${Number(ratio?.person_1_bps || 0) / 100}% خالد / ${Number(ratio?.person_2_bps || 0) / 100}% وليد`; }
function workTypeLabel(value) { return catalogLabel('work_type', value); }
function paymentMethodLabel(value) { return ({ BANK_TRANSFER: 'تحويل بنكي', CASH: 'نقدي', CARD: 'بطاقة', OTHER: 'أخرى' }[value] || 'طريقة دفع أخرى'); }
function movementLabel(type) { return ({ BASE: 'سعر أساسي', INCREASE: 'زيادة', DECREASE: 'نقصان', DISCOUNT: 'خصم' }[type] || type || 'حركة سعر'); }
function requestStateLabel(stateValue) { return stateValue === 'PENDING' ? 'معلق — لا يغير السعر المعتمد' : stateValue === 'APPROVED' ? 'معتمد' : stateValue === 'SUPERSEDED' ? 'أصبح غير قابل للتنفيذ بعد إلغاء العمل' : stateValue === 'CANCELLED' ? 'ملغى' : stateValue === 'ACTIVE' ? 'فعال' : stateValue === 'OPEN' ? 'مفتوحة' : stateValue === 'CLOSED' ? 'مغلقة' : 'حالة محفوظة'; }
function badgeForWork(work) {
  if (isPricingUnset(work)) return '<span class="badge unset">السعر غير محدد</span>';
  return `<span class="badge ok">${escapeHtml(moneyLabel(work.current_price_halalas))}</span>`;
}
function softWarningLabel(warning) {
  return ({
    WORK_DETAIL_UNIVERSITY_MISSING: 'الجامعة غير متوفرة.',
    WORK_DETAIL_SPECIALTY_MISSING: 'التخصص غير متوفر.',
  }[warning?.code] || 'توجد معلومة تفصيلية غير متوفرة.');
}
function softWarningsMarkup(work) {
  const warnings = Array.isArray(work?.soft_warnings) ? work.soft_warnings : [];
  if (!warnings.length) return '';
  return `<section class="notice info" data-soft-warnings="present"><strong>تفاصيل يفضّل استكمالها عند توفرها:</strong><ul class="fact-list">${warnings.map(warning => `<li data-soft-warning-code="${escapeHtml(warning.code)}"><strong>${escapeHtml(softWarningLabel(warning))}</strong><span>الحفظ مسموح؛ هذه المعلومة غير متوفرة حاليًا وليست واقعة موثقة أو تحذير عميل.</span></li>`).join('')}</ul></section>`;
}
function financialRequestCard(request, kind) {
  const isPending = request.state === 'PENDING';
  const isSelf = request.requested_by === state.auth.uid;
  const approvalAction = kind === 'price' ? 'approve-price-request' : 'approve-ratio-request';
  const title = kind === 'price' ? movementLabel(request.movement_type) : `استثناء النسبة ${ratioPercentLabel(request)}`;
  return `<div class="financial-request ${isPending ? 'pending' : 'approved'}" data-financial-request="${escapeHtml(request.id)}"><div class="toolbar"><strong>${escapeHtml(title)}</strong><span class="badge ${isPending ? 'unset' : 'ok'}">${escapeHtml(requestStateLabel(request.state))}</span></div><div class="financial-meta"><span>السبب: ${escapeHtml(request.reason)}</span><span>الطالب: ${escapeHtml(roleLabel(request.requested_by))}</span><span>وقت الطلب: ${dateTimeLabel(request.requested_at)}</span>${request.approved_by ? `<span>الموافق: ${escapeHtml(roleLabel(request.approved_by))} — ${dateTimeLabel(request.approved_at)}</span>` : ''}</div>${kind === 'price' ? `<div class="financial-meta"><span>القيمة: ${escapeHtml(moneyLabel(request.amount_halalas))}</span><span>التاريخ التجاري: ${dateTimeLabel(request.effective_at)}</span></div>` : ''}${isPending ? (isSelf ? '<span class="badge warn">بانتظار اعتماد الحساب الآخر؛ لا يمكنك اعتماد طلبك</span>' : `<button class="button secondary" data-action="${approvalAction}" data-request-id="${escapeHtml(request.id)}" ${state.busy ? 'disabled' : ''}>اعتماد الطلب</button>`) : ''}</div>`;
}
function financialMarkup(work) {
  const financials = work.financials || {};
  const currentPrice = financials.current_price_halalas ?? work.current_price_halalas ?? null;
  const pricingState = financials.price_state || work.pricing_state || (currentPrice === null ? 'PRICE_UNSET' : 'PRICE_APPROVED');
  const ratio = financials.ratio || { person_1_bps: 7000, person_2_bps: 3000, source: 'DEFAULT' };
  const movements = Array.isArray(financials.movements) ? financials.movements : [];
  const priceRequests = Array.isArray(financials.price_requests) ? financials.price_requests : [];
  const ratioRequests = Array.isArray(financials.ratio_requests) ? financials.ratio_requests : [];
  const ratioHistory = Array.isArray(financials.ratio_history) ? financials.ratio_history : [];
  const cancelled = work.is_cancelled || ['CANCELLED_BEFORE_EXECUTION', 'PARTIALLY_STOPPED'].includes(work.status);
  return `<section class="s6-financial-core" data-s6-financial-core><div class="grid grid-3"><article class="stat"><small>السعر المعتمد</small><strong data-authoritative-price>${escapeHtml(pricingState === 'PRICE_UNSET' ? 'السعر غير محدد' : moneyLabel(currentPrice))}</strong><span class="hint">يعتمد العرض على السجل المالي المعتمد فقط.</span></article><article class="stat"><small>المتبقي</small><strong>${escapeHtml(moneyLabel(financials.remaining_halalas ?? currentPrice))}</strong><span class="hint">يُحتسب من السعر والدفعات المعتمدة.</span></article><article class="stat"><small>النسبة الحالية</small><strong>${escapeHtml(ratioPercentLabel(ratio))}</strong><span class="hint">${escapeHtml(ratio.source === 'DEFAULT' ? 'النسبة الافتراضية' : 'استثناء معتمد وموثق')}</span></article></div><div class="grid grid-2" style="margin-top:1rem"><article class="card"><h2>الحصص المعتمدة</h2><ul class="fact-list"><li><strong>خالد</strong><span>${escapeHtml(moneyLabel(financials.shares?.person_1_halalas))}</span></li><li><strong>وليد</strong><span>${escapeHtml(moneyLabel(financials.shares?.person_2_halalas))}</span></li></ul></article><article class="card"><h2>طلبات السعر والنسبة</h2><p class="hint">الطلبات المعلقة منفصلة عن السعر والنسبة المعتمدين.</p><form id="s6-price-form" class="form-grid" ${cancelled ? 'hidden' : ''}><div class="field"><label>نوع الحركة</label><select class="select" name="movement_type" required><option value="BASE">سعر أساسي</option><option value="INCREASE">زيادة</option><option value="DECREASE">نقصان</option><option value="DISCOUNT">خصم</option></select></div><div class="field"><label>القيمة بالريال</label><input class="input" name="amount_riyals" inputmode="decimal" placeholder="1500" required/></div><div class="field"><label>التاريخ التجاري</label><input class="input" name="effective_at" type="datetime-local"/></div><div class="field full"><label>السبب</label><input class="input" name="reason" required/></div><div class="form-actions full"><button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تقديم طلب حركة سعر</button></div></form><form id="s6-ratio-form" class="form-grid" style="margin-top:1rem" ${cancelled ? 'hidden' : ''}><div class="field"><label>نسبة خالد (%)</label><input class="input" name="person_1_bps" type="number" min="0" max="100" step="0.01" value="${escapeHtml(Number(ratio.person_1_bps) / 100)}" required/><span class="hint">أدخل نسبة من 0 إلى 100. يجب أن يساوي مجموع النسب 100%.</span></div><div class="field"><label>نسبة وليد (%)</label><input class="input" name="person_2_bps" type="number" min="0" max="100" step="0.01" value="${escapeHtml(Number(ratio.person_2_bps) / 100)}" required/></div><div class="field full"><label>سبب الاستثناء</label><input class="input" name="reason" required/></div><div class="form-actions full"><button class="button secondary" type="submit" ${state.busy ? 'disabled' : ''}>تقديم طلب استثناء النسبة</button></div></form></article></div><div class="grid grid-2" style="margin-top:1rem"><article class="card"><h2>تاريخ حركات السعر المعتمدة</h2>${movements.length ? `<ul class="fact-list">${movements.map(item => `<li><strong>${escapeHtml(movementLabel(item.movement_type))}: ${escapeHtml(moneyLabel(item.amount_halalas))}</strong><span>السابق: ${escapeHtml(moneyLabel(item.previous_price_halalas))} ← الجديد: ${escapeHtml(moneyLabel(item.new_price_halalas))}</span><span>السبب: ${escapeHtml(item.reason)} — التاريخ التجاري: ${dateTimeLabel(item.effective_at)}</span><span>الطالب: ${escapeHtml(roleLabel(item.requested_by))} — الموافق: ${escapeHtml(roleLabel(item.approved_by))} — وقت الاعتماد: ${dateTimeLabel(item.approved_at)}</span></li>`).join('')}</ul>` : empty('لا توجد حركة سعر معتمدة بعد.')}</article><article class="card"><h2>تاريخ النسب والطلبات</h2>${ratioHistory.length ? `<ul class="fact-list">${ratioHistory.map(item => `<li><strong>${escapeHtml(`${Number(item.old_person_1_bps) / 100}% / ${Number(item.old_person_2_bps) / 100}% → ${Number(item.new_person_1_bps) / 100}% / ${Number(item.new_person_2_bps) / 100}%`)}</strong><span>السبب: ${escapeHtml(item.reason)} — طلب: ${dateTimeLabel(item.requested_at)} — اعتماد: ${dateTimeLabel(item.approved_at)}</span></li>`).join('')}</ul>` : empty('لا توجد استثناءات نسبة معتمدة؛ النسبة الافتراضية 70% خالد / 30% وليد.')}</article></div><section class="card" style="margin-top:1rem"><h2>حالة الطلبات</h2>${priceRequests.length ? `<h3>طلبات السعر</h3>${priceRequests.map(item => financialRequestCard(item, 'price')).join('')}` : ''}${ratioRequests.length ? `<h3>طلبات النسبة</h3>${ratioRequests.map(item => financialRequestCard(item, 'ratio')).join('')}` : (!priceRequests.length ? empty('لا توجد طلبات مالية.') : '')}</section></section>`;
}
function collectionLabel(value) {
  return ({ PRICE_UNSET: 'السعر غير محدد', OVERPAYMENT_UNRESOLVED: 'تجاوز غير محسوم', FINANCIALLY_CLOSED: 'مغلق ماليًا', UNPAID: 'غير محصل', PARTIALLY_COLLECTED: 'تحصيل جزئي', CANCELLED_ZERO_BALANCE: 'ملغى — الرصيد على العميل صفر' }[value] || 'غير متاح');
}
function partyLabel(value) { return value === 'person_1' ? 'خالد' : value === 'person_2' ? 'وليد' : 'الحساب الحالي'; }
function reversalLabel(payment) { return payment.reversal_state === 'APPROVED' ? 'تم التصحيح بسجل عكسي معتمد' : payment.reversal_state === 'PENDING' ? 'طلب تصحيح معلق — لا يغير التحصيل' : 'لا يوجد طلب تصحيح'; }
function nextSettlementMonth(recordedAt) { const date = new Date(recordedAt); if (!Number.isFinite(date.getTime())) return 'غير متاح'; return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 7); }
function settlementPeriodState(snapshots, requests) { const latestSnapshot = [...(snapshots || [])].sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0]; if (!latestSnapshot) return 'OPEN'; const latestReopen = [...(requests || [])].filter(item => item.state === 'APPROVED' && item.approved_at).sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at)))[0]; return latestReopen && String(latestReopen.approved_at) > String(latestSnapshot.created_at) ? 'OPEN' : 'CLOSED'; }
function settlementStateLabel(value) { return value === 'CLOSED' ? 'مغلقة' : 'مفتوحة'; }
function s7WorkFinancialMarkup(work) {
  const financials = work.financials || {}; const payments = Array.isArray(work.payments) ? work.payments : (financials.payments || []); const reversals = Array.isArray(work.reversalRequests) ? work.reversalRequests : []; const participants = (Array.isArray(state.financial.participants) ? state.financial.participants : []).filter(item => item.uid && item.role); const participantOptions = participants.length ? participants.map(item => `<option value="${escapeHtml(item.uid)}" ${item.uid === state.auth.uid ? 'selected' : ''}>${escapeHtml(partyLabel(item.role))}</option>`).join('') : `<option value="${escapeHtml(state.auth.uid || '')}">${escapeHtml(roleLabel(state.auth.role))}</option>`;
  const priceUnset = financials.price_state === 'PRICE_UNSET'; const cancelled = work.is_cancelled || ['CANCELLED_BEFORE_EXECUTION', 'PARTIALLY_STOPPED'].includes(work.status); const paymentBlocked = cancelled || priceUnset || Number(financials.current_price_halalas) === 0;
  return `<section class="s7-work-financial" data-s7-work-financial><div class="grid grid-3"><article class="stat"><small>إجمالي التحصيل المعتمد</small><strong data-approved-payments>${escapeHtml(moneyLabel(financials.approved_payments_total_halalas))}</strong><span class="hint">لا يدخل طلب التصحيح المعلق في هذا الإجمالي.</span></article><article class="stat"><small>المتبقي</small><strong data-remaining>${escapeHtml(moneyLabel(financials.remaining_halalas))}</strong><span class="hint">مشتق من السعر المعتمد وسجل الدفعات فقط.</span></article><article class="stat"><small>وصف التحصيل</small><strong data-collection-descriptor>${escapeHtml(collectionLabel(financials.collection_status))}</strong><span class="hint">مستقل عن حالة تنفيذ العمل.</span></article></div><section class="grid grid-2" style="margin-top:1rem"><article class="card"><h2>إضافة دفعة فعلية</h2><p class="hint">تسجل دفعة واحدة لهذا العمل وتظهر النتيجة بعد الحفظ.</p>${paymentBlocked ? `<section class="notice warning">${cancelled ? 'هذا العمل ملغى؛ لا يمكن تسجيل دفعة جديدة.' : priceUnset ? 'لا يمكن إدخال دفعة لأن السعر المعتمد غير محدد.' : 'هذا العمل بسعر معتمد صفر؛ لا تُدخل دفعة موجبة.'}</section>` : `<form id="s7-payment-form" class="form-grid"><div class="field"><label>المبلغ بالريال</label><input class="input" name="amount_riyals" inputmode="decimal" required placeholder="1000"/></div><div class="field"><label>التاريخ الفعلي</label><input class="input" name="effective_at" type="datetime-local" required/></div><div class="field"><label>طريقة الدفع</label><select class="select" name="payment_method" required><option value="BANK_TRANSFER">تحويل بنكي</option><option value="CASH">نقدي</option><option value="CARD">بطاقة</option><option value="OTHER">أخرى</option></select></div><div class="field"><label>المستلم الفعلي <span class="required">*</span></label><select class="select" name="received_by" required>${participantOptions}</select><span class="hint">اختر الحساب الذي استلم الدفعة فعليًا.</span></div><div class="field full"><label>ملاحظة اختيارية</label><input class="input" name="note"/></div><div class="form-actions full"><button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تسجيل الدفعة</button></div></form>`}</article><article class="card"><h2>سجل الدفعات والتصحيح</h2>${payments.length ? `<ul class="fact-list">${payments.map(payment => `<li data-payment-id="${escapeHtml(payment.id)}"><strong>${escapeHtml(moneyLabel(payment.amount_halalas))} — ${escapeHtml(paymentMethodLabel(payment.payment_method))}</strong><span>استلمها: ${escapeHtml(roleLabel(payment.received_by))} — سُجلت بواسطة: ${escapeHtml(roleLabel(payment.recorded_by))}</span><span>التاريخ الفعلي: ${dateTimeLabel(payment.effective_at)} — ${escapeHtml(reversalLabel(payment))}</span>${payment.reversal_state === 'PENDING' ? `<span class="badge unset">${escapeHtml(reversalLabel(payment))}</span>` : ''}${payment.reversal_state === 'APPROVED' ? `<span class="badge ok">القيد العكسي: ${escapeHtml(moneyLabel(payment.reversal_amount_halalas))}</span>` : ''}${!payment.reversal_state ? `<button class="button secondary" data-action="request-payment-reversal" data-payment-id="${escapeHtml(payment.id)}" ${state.busy ? 'disabled' : ''}>طلب تصحيح/إلغاء الدفعة</button>` : ''}</li>`).join('')}</ul>` : empty('لا توجد دفعات مسجلة لهذا العمل.')}</article></section><section class="card" style="margin-top:1rem"><h2>طلبات تصحيح الدفعات</h2>${reversals.length ? `<ul class="fact-list">${reversals.map(request => { const pending = request.state === 'PENDING'; const self = request.requested_by === state.auth.uid; return `<li data-reversal-request="${escapeHtml(request.id)}"><strong>${escapeHtml(moneyLabel(request.amount_halalas))} — ${pending ? 'معلق' : 'معتمد'}</strong><span>السبب: ${escapeHtml(request.reason)} — الطالب: ${escapeHtml(roleLabel(request.requested_by))}</span><span>طُلب: ${dateTimeLabel(request.requested_at)}${request.approved_at ? ` — اعتُمد: ${dateTimeLabel(request.approved_at)}` : ''}</span>${pending ? (self ? '<span class="badge warn">بانتظار الحساب الآخر؛ لا يمكنك اعتماد طلبك</span>' : `<button class="button secondary" data-action="approve-payment-reversal" data-request-id="${escapeHtml(request.id)}" ${state.busy ? 'disabled' : ''}>اعتماد التصحيح</button>`) : `<span class="badge ok">اعتمده: ${escapeHtml(roleLabel(request.approved_by))}</span>`}</li>`; }).join('')}</ul>` : empty('لا توجد طلبات تصحيح.')}</section></section>`;
}
function settlementRows(items, renderItem, emptyText) { return items.length ? `<ul class="fact-list">${items.map(renderItem).join('')}</ul>` : empty(emptyText); }
function settlementPreviewMarkup(preview) {
  if (!preview) return loading('جارٍ تحميل معاينة التسوية…');
  const rows = [['عدد الأعمال', preview.work_count], ['العدد التراكمي', preview.cumulative_work_count], ['إجمالي قيمة الأعمال', moneyLabel(preview.total_work_value_halalas)], ['حصة خالد', moneyLabel(preview.person_1_work_share_halalas)], ['حصة وليد', moneyLabel(preview.person_2_work_share_halalas)], ['المتحصل من العميل', moneyLabel(preview.approved_receipts_halalas)], ['استلام خالد', moneyLabel(preview.approved_receipts_person_1_halalas)], ['استلام وليد', moneyLabel(preview.approved_receipts_person_2_halalas)], ['التحويلات', moneyLabel(preview.transfer_amount_halalas)], ['رسوم التحويل', moneyLabel(preview.transfer_fee_halalas)], ['إجمالي الاشتراكات', moneyLabel(preview.subscription_total_halalas)], ['المصروفات المشتركة', moneyLabel(preview.governed_expense_total_halalas)], ['تسويات تاريخية — خالد', moneyLabel(preview.settlement_adjustment_person_1_halalas)], ['تسويات تاريخية — وليد', moneyLabel(preview.settlement_adjustment_person_2_halalas)], ['الرصيد السابق', moneyLabel(preview.prior_balance_halalas)], ['الرصيد النهائي', moneyLabel(preview.final_balance_halalas)]];
  const unresolved = preview.unresolved_code ? `<section class="notice warning" data-settlement-unresolved><strong>التسوية تحتاج مراجعة قبل الإقفال.</strong><p>${escapeHtml(errorMessage(preview.unresolved_code))}</p><p>لا يمكن إقفال التسوية ما دامت هناك قاعدة مالية غير معتمدة.</p></section>` : '';
  return `${unresolved}<div class="table-wrap"><table><tbody>${rows.map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(String(value ?? 'غير متاح'))}</td></tr>`).join('')}</tbody></table></div>`;
}
function financialSummaryMarkup(preview) {
  if (!preview) return loading('جارٍ تحميل ملخص التسوية…');
  const items = [
    ['إجمالي قيمة أعمال الشهر', preview.total_work_value_halalas],
    ['حصة خالد', preview.person_1_work_share_halalas],
    ['حصة وليد', preview.person_2_work_share_halalas],
    ['إجمالي الاشتراكات', preview.subscription_total_halalas],
    ['رسوم التحويل', preview.transfer_fee_halalas],
  ];
  return `<section class="card" data-settlement-summary><div class="toolbar"><div><h2>ملخص التسوية</h2><p>أهم أرقام الشهر قبل مراجعة التفاصيل.</p></div></div><div class="grid grid-3">${items.map(([label, value]) => `<article class="stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(moneyLabel(value))}</strong></article>`).join('')}</div></section>`;
}
function financialPage() {
  const financial = state.financial; const period = financial.periodKey; const preview = financial.preview;
  const snapshots = financial.snapshots || []; const requests = financial.reopenRequests || []; const periodState = settlementPeriodState(snapshots, requests);
  const closeAction = periodState === 'OPEN'
    ? `<form id="s7-settlement-close-form" class="form-actions" style="margin-top:1rem"><button class="button" type="submit" ${state.busy || !preview || preview.unresolved_code ? 'disabled' : ''}>إغلاق التسوية</button></form>`
    : '<p class="notice info" data-settlement-closed-note>الفترة مغلقة. أعد فتحها استثنائيًا إذا احتجت إجراء تعديل مالي عليها.</p>';
  const reopenForm = periodState === 'CLOSED'
    ? `<form id="s7-reopen-form" class="form-grid"><div class="field full"><label>السبب</label><input class="input" name="reason" required/></div><div class="form-actions full"><button class="button secondary" type="submit" ${state.busy ? 'disabled' : ''}>طلب إعادة الفتح</button></div></form>`
    : '<p class="hint" data-reopen-open-note>إعادة الفتح متاحة فقط بعد إغلاق الفترة.</p>';
  return `<section class="notice info"><strong>البيانات المالية المعروضة من السجل المعتمد.</strong><p>راجع ملخص الفترة والتفاصيل قبل إغلاق التسوية.</p></section>
  <div style="margin-top:1rem">${financialSummaryMarkup(preview)}</div>
  <section class="card" style="margin-top:1rem"><div class="toolbar"><div><h2>فترة التسوية</h2><p>اختر الشهر لمراجعة التسوية. الإغلاق متاح فقط عندما تكون البيانات المالية محسومة.</p></div></div><form id="s7-settlement-period-form" class="form-grid"><div class="field"><label>الشهر</label><input class="input" name="period_key" type="month" value="${escapeHtml(period)}" required/></div><div class="form-actions"><button class="button secondary" type="submit" ${state.busy ? 'disabled' : ''}>تحديث المعاينة</button></div></form></section>
  <section class="card" style="margin-top:1rem" data-settlement-current-state><h2>حالة الفترة</h2><p><strong>حالة الفترة: ${escapeHtml(settlementStateLabel(periodState))}</strong></p></section>
  <section class="grid grid-3" style="margin-top:1rem">
    <article class="card"><h2>تحويل بين الطرفين</h2><form id="s7-transfer-form" class="form-grid"><div class="field"><label>المبلغ بالريال</label><input class="input" name="amount_riyals" inputmode="decimal" required/></div><div class="field"><label>من</label><select class="select" name="from_party"><option value="person_1">خالد</option><option value="person_2">وليد</option></select></div><div class="field"><label>إلى</label><select class="select" name="to_party"><option value="person_2">وليد</option><option value="person_1">خالد</option></select></div><div class="field"><label>رسوم بالريال</label><input class="input" name="fee_riyals" inputmode="decimal" value="0" required/></div><div class="field full"><label>التاريخ الفعلي</label><input class="input" name="effective_at" type="datetime-local" required/></div><div class="form-actions full"><button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تسجيل التحويل</button></div></form></article>
    <article class="card"><h2>الاشتراكات</h2><p class="hint">الاشتراك مبلغ شهري إجمالي معتمد، ولا يُحسب يوميًا. أي تغيير يسري من تسوية الشهر التالي، ولا يعيد حساب التسويات المغلقة.</p><form id="s7-subscription-form" class="form-grid"><div class="field"><label>الحالة</label><select class="select" name="state"><option value="ACTIVE">فعّال</option><option value="CANCELLED">ملغى</option></select></div><div class="field"><label>الإجمالي بالريال</label><input class="input" name="aggregate_amount_riyals" inputmode="decimal" value="136.50" required/></div><div class="field full"><label>تاريخ تسجيل التغيير</label><input class="input" name="effective_at" type="datetime-local" required/><span class="hint">يسري التغيير من تسوية الشهر التالي.</span></div><div class="form-actions full"><button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تسجيل التغيير</button></div></form></article>
    <article class="card"><h2>مصروف مشترك</h2><p class="hint">يسجل المصروف ودافعه. إذا لم توجد له قاعدة توزيع معتمدة، تبقى التسوية غير محسومة ولا يمكن إغلاقها.</p><form id="s7-expense-form" class="form-grid"><div class="field"><label>المبلغ بالريال</label><input class="input" name="amount_riyals" inputmode="decimal" required/></div><div class="field"><label>الفئة</label><input class="input" name="category" required/></div><div class="field"><label>الدافع</label><input class="input" value="الحساب الحالي" readonly/><input type="hidden" name="paid_by_uid" value="${escapeHtml(state.auth.uid || '')}"/></div><div class="field full"><label>التاريخ الفعلي</label><input class="input" name="effective_at" type="datetime-local" required/></div><div class="form-actions full"><button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تسجيل المصروف</button></div></form></article>
  </section>
  <section class="grid grid-2" style="margin-top:1rem">
    <article class="card"><h2>تفاصيل تسوية ${escapeHtml(periodBucketLabel(period))}</h2>${settlementPreviewMarkup(preview)}${closeAction}</article>
    <article class="card"><h2>إعادة فتح استثنائية</h2><p class="hint">إعادة الفتح تحتاج طلبًا واعتماد الحساب الآخر.</p>${reopenForm}<h3>سجل طلبات إعادة الفتح</h3>${settlementRows(requests, request => { const pending = request.state === 'PENDING'; const self = request.requested_by === state.auth.uid; const pendingAction = periodState === 'OPEN' ? '<span class="badge unset">طلب معلّق محفوظ للمراجعة؛ لا يتطلب إجراء ما دامت الفترة مفتوحة.</span>' : self ? '<span class="badge warn">لا يمكنك اعتماد طلبك</span>' : `<button class="button secondary" data-action="approve-settlement-reopen" data-request-id="${escapeHtml(request.id)}" ${state.busy ? 'disabled' : ''}>اعتماد إعادة الفتح</button>`; return `<li><strong>${pending ? 'طلب معلق' : 'طلب معتمد'}</strong><span>السبب: ${escapeHtml(request.reason)} — الطالب: ${escapeHtml(roleLabel(request.requested_by))}</span><span>طُلب: ${dateTimeLabel(request.requested_at)}${request.approved_at ? ` — اعتُمد: ${dateTimeLabel(request.approved_at)}` : ''}</span>${pending ? pendingAction : `<span class="badge ok">اعتمده: ${escapeHtml(roleLabel(request.approved_by))}</span>`}</li>`; }, 'لا توجد طلبات إعادة فتح لهذه الفترة.')}</article>
  </section>
  <section class="grid grid-3" style="margin-top:1rem">
    <article class="card"><h2>سجل التحويلات</h2>${settlementRows(financial.transfers || [], item => `<li><strong>${escapeHtml(moneyLabel(item.amount_halalas))}: ${escapeHtml(partyLabel(item.from_party))} ← ${escapeHtml(partyLabel(item.to_party))}</strong><span>الرسوم: ${escapeHtml(moneyLabel(item.fee_halalas))} — ${dateTimeLabel(item.effective_at)}</span></li>`, 'لا توجد تحويلات.')}</article>
    <article class="card"><h2>تاريخ الاشتراكات</h2>${settlementRows(financial.subscriptions || [], item => `<li><strong>${escapeHtml(item.state === 'CANCELLED' ? 'ملغى' : moneyLabel(item.aggregate_amount_halalas))}</strong><span>سُجل التغيير: ${dateTimeLabel(item.effective_at)} — يسري من تسوية ${escapeHtml(periodBucketLabel(nextSettlementMonth(item.effective_at)))} — الدافع الفعلي: ${escapeHtml(roleLabel(item.paid_by_uid))}</span></li>`, 'لا توجد تغييرات اشتراك.')}</article>
    <article class="card"><h2>سجل المصروفات</h2>${settlementRows(financial.expenses || [], item => `<li><strong>${escapeHtml(moneyLabel(item.amount_halalas))} — ${escapeHtml(item.category)}</strong><span>الدافع: ${escapeHtml(roleLabel(item.paid_by_uid))} — ${dateTimeLabel(item.effective_at)}</span></li>`, 'لا توجد مصروفات.')}</article>
  </section>
  <section class="card" style="margin-top:1rem"><h2>نسخ التسوية المغلقة</h2>${settlementRows(snapshots, item => `<li><strong>نسخة الإقفال — ${escapeHtml(settlementStateLabel(item.state))}</strong><span>الرصيد النهائي: ${escapeHtml(moneyLabel(item.final_balance_halalas))} — أُغلقت/أُنشئت: ${dateTimeLabel(item.created_at)}</span></li>`, 'لا توجد نسخة مغلقة لهذه الفترة.')}</section>`;
}
  const S8_EXPORT_LABELS = Object.freeze({ WORK: 'تقرير عمل واحد', MONTH: 'تقرير شهر', FOLLOW_UP: 'سجل المتابعة', CUSTOMER: 'تقرير عميل', CLASSIFICATION: 'تحليل التصنيف' });
  const S8_COLLECTION_LABELS = Object.freeze({ PRICE_UNSET: 'السعر غير محدد', UNPAID: 'غير محصل', PARTIALLY_COLLECTED: 'تحصيل جزئي', FINANCIALLY_CLOSED: 'مغلق ماليًا', OVERPAYMENT_UNRESOLVED: 'تجاوز غير محسوم', CANCELLED_ZERO_BALANCE: 'ملغى — الرصيد على العميل صفر' });
  function s8FilterParams() { const filters = state.s8.filters; return { ...filters, include_archived: filters.include_archived ? 'true' : 'false', page: state.s8.search.page || 1, page_size: state.s8.search.page_size || 25 }; }
  function s8Options(kind, selected) { return `<option value="">الكل</option>${(state.catalogs[kind] || []).map(item => `<option value="${escapeHtml(item.value_key)}" ${item.value_key === selected ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}`; }
function s8DimensionLabel(value) { return ({ WORK_TYPE: 'نوع العمل', SPECIALTY: 'التخصص', COUNTRY: 'الدولة', UNIVERSITY: 'الجامعة', PERIOD: 'الفترة' }[value] || 'تصنيف'); }
function periodBucketLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return value ? 'فترة محفوظة' : 'غير محدد';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return new Intl.DateTimeFormat(USER_DATE_LOCALE, { month: 'long', year: 'numeric' }).format(date);
}
function s8BucketLabel(dimension, value) {
  if (dimension === 'WORK_TYPE') return catalogLabel('work_type', value);
  if (dimension === 'SPECIALTY') return catalogLabel('specialty', value);
  if (dimension === 'COUNTRY') return catalogLabel('country', value);
  if (dimension === 'UNIVERSITY') return value && value !== 'UNSPECIFIED' ? String(value) : 'غير محدد';
  if (dimension === 'PERIOD') return periodBucketLabel(value);
  return 'قيمة محفوظة';
}
  function s8SearchRows() { const items = state.s8.search.items || []; if (!items.length) return empty('لا توجد نتائج مطابقة للمرشحات الحالية.'); return `<div class="table-wrap"><table data-s8-results><thead><tr><th>العنوان</th><th>العميل</th><th>التصنيف</th><th>الحالة</th><th>التحصيل</th><th>السعر</th><th>الأرشيف</th><th></th></tr></thead><tbody>${items.map(item => `<tr data-s8-work-row="${escapeHtml(item.id)}" data-archived="${item.is_archived ? 'true' : 'false'}"><td><strong>${escapeHtml(item.title)}</strong><br/></td><td>${escapeHtml(item.customer_name || customerName(item.customer_id))}</td><td>${escapeHtml(workTypeLabel(item.work_type_key))}</td><td>${escapeHtml(workStatusLabel(item.status))}</td><td>${escapeHtml(S8_COLLECTION_LABELS[item.collection_status] || 'حالة تحصيل محفوظة')}</td><td>${escapeHtml(item.current_price_halalas === null ? 'السعر غير محدد' : moneyLabel(item.current_price_halalas))}</td><td><span class="badge ${item.is_archived ? 'ok' : 'unset'}">${item.is_archived ? 'تاريخي مؤرشف' : 'نشط'}</span></td><td><button class="row-action" data-work="${escapeHtml(item.id)}" type="button">فتح</button></td></tr>`).join('')}</tbody></table></div>`; }
  function s8AnalyticsMarkup() { const analytics = state.s8.analytics; if (!analytics) return empty('اضغط تحديث التحليل بعد تحديد أساس الفترة.'); const groups = analytics.groups || {}; return `<section class="grid grid-3" data-s8-analytics>${Object.entries(groups).map(([dimension, rows]) => `<article class="card"><h3>${escapeHtml(s8DimensionLabel(dimension))}</h3>${rows.length ? `<ul class="fact-list">${rows.map(row => `<li data-s8-analytics-row="${escapeHtml(dimension)}:${escapeHtml(row.bucket)}"><strong>${escapeHtml(s8BucketLabel(dimension, row.bucket))}</strong><span>الأعمال: ${row.work_count} — نشطة: ${row.active_work_count} — مؤرشفة: ${row.archived_work_count}</span><span>القيمة: ${escapeHtml(moneyLabel(row.current_price_halalas))} — المدفوع: ${escapeHtml(moneyLabel(row.approved_paid_halalas))} — المتبقي: ${escapeHtml(moneyLabel(row.remaining_halalas))}</span></li>`).join('')}</ul>` : empty('لا توجد بيانات.')}</article>`).join('')}</section>`; }
  function alertStateLabel(value) { return value === 'CONFIGURED' ? 'مضبوط' : value === 'NOT_CONFIGURED' ? 'غير مضبوط' : 'غير متاح'; }
  function s8AlertSetting(alertType) { return (state.s8.alertSettings || []).find(setting => setting.alert_type === alertType) || { alert_type: alertType, threshold_days: null, state: 'NOT_CONFIGURED' }; }
  function s8AlertsMarkup() { const alerts = state.s8.alerts; if (!alerts) return ''; const labels = { NO_PRICE: 'بلا سعر', NO_REPLY: 'بانتظار رد العميل', NO_PAYMENT: 'دون تحصيل' }; return `<section class="card" style="margin-top:1rem" data-s8-alerts><div class="toolbar"><div><h2>تنبيهات المتابعة</h2><p>تُحتسب التنبيهات من تواريخ السجل المعتمد: إنشاء العمل، آخر انتظار لرد العميل، أو تاريخ التأكيد مع سعر موجب ودون دفعة معتمدة.</p></div></div><p class="hint" data-s8-alert-clock>وقت التقييم: ${escapeHtml(dateTimeLabel(alerts.now))}. لا توجد مدد افتراضية؛ لا تُطابق العناصر غير المضبوطة.</p><form id="s8-alert-settings-form" class="form-grid" data-s8-alert-settings>${['NO_PRICE', 'NO_REPLY', 'NO_PAYMENT'].map(type => { const setting = s8AlertSetting(type); return `<div class="field"><label>${escapeHtml(labels[type])} — الأيام</label><input class="input" type="number" min="1" max="36500" inputmode="numeric" name="threshold_${type}" value="${escapeHtml(setting.threshold_days ?? '')}" placeholder="غير مضبوط"/><span class="hint" data-s8-setting-state="${type}">${escapeHtml(alertStateLabel(setting.state))}</span></div>`; }).join('')}<div class="form-actions full"><button class="button secondary" type="submit" ${state.busy ? 'disabled' : ''}>حفظ مدد التنبيهات</button></div></form><div class="grid grid-3">${(alerts.alerts || []).map(alert => `<article class="notice ${alert.state === 'CONFIGURED' ? 'info' : 'warning'}" data-s8-alert-state="${escapeHtml(alert.alert_type)}"><strong>${escapeHtml(labels[alert.alert_type] || 'تنبيه')}</strong><p>${escapeHtml(alertStateLabel(alert.state))}${alert.threshold_days === null ? '' : ` — ${escapeHtml(alert.threshold_days)} يومًا`} — العناصر: ${alert.items.length}</p>${alert.items.length ? `<ul class="fact-list">${alert.items.map(item => `<li data-s8-alert-work="${escapeHtml(item.work_id)}"><strong>${escapeHtml(item.title)}</strong><span>بداية القياس: ${escapeHtml(dateTimeLabel(item.anchor_at))} — العمر: ${escapeHtml(item.age_days)} يومًا</span><span>${item.current_price_halalas === null ? 'السعر غير محدد' : `السعر: ${escapeHtml(moneyLabel(item.current_price_halalas))}`} — المدفوع المعتمد: ${escapeHtml(moneyLabel(item.approved_paid_halalas))}</span></li>`).join('')}</ul>` : '<p class="hint">لا توجد عناصر مطابقة للمدة الحالية.</p>'}</article>`).join('')}</div></section>`; }
  function s8SearchPage() { const filters = state.s8.filters; const search = state.s8.search; const exportType = state.s8.export_type; return `<section class="notice info"><strong>بحث وتحليل وتصدير</strong><p>الأرشيف يظهر في النطاق التاريخي فقط ولا يدخل ضمن الأعمال النشطة. القيم المالية تأتي من السجل المعتمد؛ لا تحسب الواجهة أي نتيجة من تلقاء نفسها.</p></section>${s8AlertsMarkup()}<section class="card" data-s8-search-panel><div class="toolbar"><div><h2>البحث والمرشحات</h2><p>يشمل البحث العنوان الحالي والعناوين السابقة.</p></div><button class="button secondary" data-action="s8-refresh" type="button" ${state.s8.loading ? 'disabled' : ''}>تحديث</button></div><form id="s8-search-form" class="form-grid"><div class="field full"><label for="s8-q">البحث النصي</label><input class="input" id="s8-q" name="q" value="${escapeHtml(filters.q)}" placeholder="عنوان حالي أو تاريخي"/></div><div class="field"><label>أساس الفترة</label><select class="select" name="period_basis"><option value="CREATED_AT" ${filters.period_basis === 'CREATED_AT' ? 'selected' : ''}>تاريخ الإنشاء</option><option value="CONFIRMED_AT" ${filters.period_basis === 'CONFIRMED_AT' ? 'selected' : ''}>تاريخ التأكيد</option></select></div><div class="field"><label>الشهر</label><input class="input" type="number" min="1" max="12" name="month" value="${escapeHtml(filters.month)}" placeholder="08"/></div><div class="field"><label>السنة</label><input class="input" type="number" min="2000" max="2999" name="year" value="${escapeHtml(filters.year)}" placeholder="2026"/></div><div class="field"><label>الحالة</label><select class="select" name="status"><option value="">الكل</option>${Object.entries(WORK_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field"><label>العميل</label><select class="select" name="customer_id"><option value="">الكل</option>${state.customers.map(item => `<option value="${escapeHtml(item.id)}" ${filters.customer_id === item.id ? 'selected' : ''}>${escapeHtml(item.name || 'عميل غير مسمى')}</option>`).join('')}</select></div><div class="field"><label>الدولة</label><select class="select" name="country">${s8Options('country', filters.country)}</select></div><div class="field"><label>الجامعة</label><input class="input" name="university" value="${escapeHtml(filters.university)}"/></div><div class="field"><label>التخصص</label><select class="select" name="specialty_key">${s8Options('specialty', filters.specialty_key)}</select></div><div class="field"><label>نوع العمل</label><select class="select" name="work_type_key">${s8Options('work_type', filters.work_type_key)}</select></div><div class="field"><label>حالة التحصيل</label><select class="select" name="collection_status"><option value="">الكل</option>${Object.entries(S8_COLLECTION_LABELS).map(([value, label]) => `<option value="${value}" ${filters.collection_status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field"><label><input type="checkbox" name="include_archived" ${filters.include_archived ? 'checked' : ''}/> تضمين الأرشيف التاريخي</label><span class="hint">عند إلغاء الاختيار تظهر الأعمال النشطة فقط.</span></div><div class="form-actions full"><button class="button" type="submit">تطبيق البحث</button><button class="button ghost" data-action="s8-reset" type="button">مسح المرشحات</button></div></form></section><section class="card" style="margin-top:1rem" data-s8-results-panel><div class="toolbar"><div><h2>نتائج البحث</h2><p>صفحة ${search.page || 1} — ${search.items.length} نتيجة معروضة.</p></div><div class="toolbar-right"><button class="button ghost" data-action="s8-prev" type="button" ${search.page <= 1 || state.s8.loading ? 'disabled' : ''}>السابق</button><button class="button ghost" data-action="s8-next" type="button" ${!search.has_more || state.s8.loading ? 'disabled' : ''}>التالي</button></div></div>${state.s8.loading ? loading() : s8SearchRows()}</section><section class="card" style="margin-top:1rem"><div class="toolbar"><div><h2>التحليل</h2><p>يعرض التحليل النتائج بحسب الفترة المختارة مع فصل الأعمال النشطة عن المؤرشفة.</p></div><button class="button secondary" data-action="s8-analytics-refresh" type="button" ${state.s8.loading ? 'disabled' : ''}>تحديث التحليل</button></div>${s8AnalyticsMarkup()}</section><section class="card" style="margin-top:1rem" data-s8-export-panel><div class="toolbar"><div><h2>تصدير ملف Excel</h2><p>اختر نوع التقرير والبيانات المطلوبة ثم نزّل ملف Excel.</p></div></div><form id="s8-export-form" class="form-grid"><div class="field"><label>نوع التصدير</label><select class="select" name="export_type">${Object.entries(S8_EXPORT_LABELS).map(([value, label]) => `<option value="${value}" ${exportType === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><div class="field" data-s8-export-work-field><label>العمل</label><select class="select" name="work_id"><option value="">— اختر العمل —</option>${state.works.map(item => `<option value="${escapeHtml(item.id)}" ${state.s8.export_work_id === item.id ? 'selected' : ''}>${escapeHtml(item.title)} — ${escapeHtml(customerName(item.customer_id))}</option>`).join('')}</select></div><div class="field" data-s8-export-customer-field><label>العميل</label><select class="select" name="customer_id"><option value="">— اختر العميل —</option>${state.customers.map(item => `<option value="${escapeHtml(item.id)}" ${state.s8.export_customer_id === item.id ? 'selected' : ''}>${escapeHtml(item.name || 'عميل غير مسمى')}</option>`).join('')}</select></div><div class="field full"><button class="button" type="submit" ${state.s8.loading ? 'disabled' : ''}>تنزيل ملف Excel</button></div></form><p class="hint">تجمع التقارير صفحات النتائج بترتيب ثابت، وتبقى لقطة التسوية محفوظة كما هي، ولا تُعرض نتيجة غير مكتملة.</p></section>`; }
  async function loadS8Search() { const data = await api(`/api/search/works${queryString(s8FilterParams())}`); state.s8.search = data; return data; }
  async function loadS8Analytics() { const filters = state.s8.filters; const params = { period_basis: filters.period_basis, month: filters.month, year: filters.year, include_archived: filters.include_archived ? 'true' : 'false' }; state.s8.analytics = await api(`/api/analytics${queryString(params)}`); return state.s8.analytics; }
  async function loadS8Workspace() { state.s8.loading = true; try { await Promise.all([loadS8Search(), loadS8Analytics(), api('/api/alerts').then(data => { state.s8.alerts = data; }), api('/api/alerts/settings').then(data => { state.s8.alertSettings = data; })]); } finally { state.s8.loading = false; } return state.s8; }
  async function s8ApplySearch(event) { event.preventDefault(); const values = formObject(event.currentTarget); state.s8.filters = { ...state.s8.filters, ...values, include_archived: values.include_archived === 'on' }; state.s8.search = { ...state.s8.search, page: 1 }; await submitFlow(async () => { await loadS8Workspace(); render(); }); }
  async function s8RefreshAnalytics() { await submitFlow(async () => { await loadS8Analytics(); render(); }); }
async function submitS8AlertSettings(event) { event.preventDefault(); const values = formObject(event.currentTarget); const settings = ['NO_PRICE', 'NO_REPLY', 'NO_PAYMENT'].map(alert_type => ({ alert_type, threshold_days: values[`threshold_${alert_type}`] })).filter(setting => setting.threshold_days !== ''); if (!settings.length) { toast(errorMessage('S8_ALERT_SETTINGS_REQUIRED'), 'error'); return; } if (!(await confirmSensitive('حفظ إعدادات التنبيهات', settings.map(item => `${({ NO_PRICE: 'بلا سعر', NO_REPLY: 'بانتظار رد العميل', NO_PAYMENT: 'دون تحصيل' }[item.alert_type] || 'تنبيه')} — ${item.threshold_days} يوم`).join('، ')))) return; await submitFlow(async () => { for (const setting of settings) await api('/api/alerts/settings', { method: 'POST', body: setting }); await loadS8Workspace(); render(); toast('تم حفظ مدد التنبيهات.', ''); }); }
  function s8ExportPath(type, values) { const query = { period_basis: state.s8.filters.period_basis, month: state.s8.filters.month, year: state.s8.filters.year, include_archived: state.s8.filters.include_archived ? 'true' : 'false', page_size: 1000 }; if (type === 'WORK') return `/api/exports/work/${encodeURIComponent(values.work_id)}`; if (type === 'CUSTOMER') return `/api/exports/customer/${encodeURIComponent(values.customer_id)}${queryString({ ...query })}`; if (type === 'MONTH') return `/api/exports/month${queryString(query)}`; if (type === 'FOLLOW_UP') return `/api/exports/follow-up${queryString({ include_archived: query.include_archived, page_size: 1000 })}`; return `/api/exports/classification${queryString({ period_basis: query.period_basis, month: query.month, year: query.year, include_archived: query.include_archived })}`; }
  async function fetchS8CompleteExport(type, values) { const first = await api(s8ExportPath(type, values)); if (type === 'WORK' || type === 'CLASSIFICATION') return first; const all = { ...first }; const rowsKey = type === 'FOLLOW_UP' ? 'events' : 'works'; all[rowsKey] = [...(first[rowsKey] || [])]; let cursor = first.next_cursor; while (cursor) { const path = s8ExportPath(type, values) + `&cursor=${encodeURIComponent(cursor)}`; const page = await api(path); all[rowsKey].push(...(page[rowsKey] || [])); cursor = page.next_cursor; } if (type === 'CUSTOMER') { all.warnings = [...(first.warnings || [])]; let warningCursor = first.warning_next_cursor; while (warningCursor) { const page = await api(s8ExportPath(type, values) + `&warning_cursor=${encodeURIComponent(warningCursor)}`); all.warnings.push(...(page.warnings || [])); warningCursor = page.warning_next_cursor; } } all.next_cursor = null; return all; }
  async function submitS8Export(event) { event.preventDefault(); const values = formObject(event.currentTarget); state.s8.export_type = values.export_type; state.s8.export_work_id = values.work_id || ''; state.s8.export_customer_id = values.customer_id || ''; if (values.export_type === 'WORK' && !values.work_id) { toast('اختر عملًا للتصدير.', 'error'); return; } if (values.export_type === 'CUSTOMER' && !values.customer_id) { toast('اختر عميلًا للتصدير.', 'error'); return; } await submitFlow(async () => { const dto = { ...(await fetchS8CompleteExport(values.export_type, values)), presentation_catalogs: state.catalogs }; const exporter = await import(appConfig.s8ExportModuleUrl || '/assets/s8-export.mjs'); const bytes = exporter.generateS8Workbook(dto); const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); const identifier = values.export_type === 'WORK' ? (state.works.find(item => item.id === values.work_id)?.title || 'عمل') : values.export_type === 'CUSTOMER' ? (state.customers.find(item => item.id === values.customer_id)?.name || 'عميل') : values.export_type === 'MONTH' ? `${state.s8.filters.year || 'فترة'}-${state.s8.filters.month || 'الكل'}` : (S8_EXPORT_LABELS[values.export_type] || 'تقرير'); anchor.href = url; anchor.download = exporter.safeS8ExportFilename(values.export_type, identifier); anchor.click(); URL.revokeObjectURL(url); toast('تم إنشاء ملف Excel.', ''); }); }
  function dashboard() {
  const followUp = state.works.filter(isPricingUnset);
  return `<div class="grid grid-3"><div class="stat"><small>العملاء المسجلون</small><strong>${state.customers.length}</strong></div><div class="stat"><small>الأعمال الحالية</small><strong>${state.works.length}</strong></div><div class="stat"><small>تحتاج متابعة سعر</small><strong class="accent">${followUp.length}</strong></div></div>
  <section class="card" style="margin-top:1rem"><div class="toolbar"><div><h2>أعمال بلا سعر</h2><p>الأعمال التي لم يُعتمد سعرها بعد تظهر بوضوح بعبارة «السعر غير محدد».</p></div><button class="button" data-action="new-work" type="button">إضافة عمل</button></div>${followUp.length ? worksTable(followUp) : empty('لا توجد أعمال بسعر غير محدد حاليًا.')}</section>`;
}
function worksTable(works) { return `<div class="table-wrap"><table><thead><tr><th>العنوان</th><th>العميل</th><th>النوع</th><th>الحالة</th><th>السعر</th><th></th></tr></thead><tbody>${works.map(work => `<tr><td>${escapeHtml(work.title)}</td><td>${escapeHtml(customerName(work.customer_id))}</td><td>${escapeHtml(workTypeLabel(work.work_type_key))}</td><td>${escapeHtml(WORK_STATUS_LABELS[work.status] || 'غير متاح')}</td><td>${badgeForWork(work)}</td><td><button class="row-action" data-work="${escapeHtml(work.id)}">عرض</button></td></tr>`).join('')}</tbody></table></div>`; }
function customersTable(customers) { return `<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الدولة</th><th>الجامعة</th><th>التخصص</th><th>الأعمال</th><th></th></tr></thead><tbody>${customers.map(customer => `<tr><td>${escapeHtml(customer.name || 'اسم غير متاح')}</td><td>${escapeHtml(catalogLabel('country', customer.country))}</td><td>${escapeHtml(customer.university || '—')}</td><td>${escapeHtml(catalogLabel('specialty', customer.specialty))}</td><td>${state.works.filter(work => work.customer_id === customer.id).length}</td><td><button class="row-action" data-customer="${escapeHtml(customer.id)}">فتح السجل</button></td></tr>`).join('')}</tbody></table></div>`; }
function customerName(id) { return state.customers.find(customer => customer.id === id)?.name || 'عميل غير مسمى'; }
function customersPage() { return `<section class="card"><div class="toolbar"><div><h2>العملاء</h2><p>بيانات العميل الأساسية وسجل الوقائع المتاح.</p></div><div class="toolbar-right"><input class="input" id="customer-search" aria-label="البحث في العملاء" placeholder="ابحث بالاسم أو الجامعة أو التخصص" style="width:260px" /><button class="button" data-action="new-customer" type="button">إضافة عميل</button></div></div>${customersTable(state.customers)}</section>`; }
function worksPage() { return `<section class="card"><div class="toolbar"><div><h2>الأعمال</h2><p>كل عمل سجل مستقل، حتى عند وجود علاقة تابع/أصل.</p></div><button class="button" data-action="new-work" type="button">إضافة عمل</button></div>${state.works.length ? worksTable(state.works) : empty('لا توجد أعمال بعد. أنشئ أول عمل من هنا أو من سجل العميل.')}</section>`; }
function catalogsPage() { return `<section class="grid grid-3">${['country', 'specialty', 'work_type'].map(kind => `<article class="card"><div class="toolbar"><h2>${({ country: 'الدول', specialty: 'التخصصات', work_type: 'أنواع الأعمال' }[kind])}</h2><button class="button secondary" data-action="new-catalog" data-kind="${kind}" type="button">إضافة قيمة</button></div>${catalogList(kind)}</article>`).join('')}</section>`; }
function catalogList(kind) { const values = state.catalogs[kind] || []; return values.length ? `<div class="fact-list">${values.map(value => `<li><strong>${escapeHtml(value.label)}</strong><span>${value.active ? 'متاحة للاختيار' : 'غير متاحة للاختيار'}</span></li>`).join('')}</div>` : empty('لا توجد قيم بعد.'); }
function auditPage() {
  const rows = state.audit.rows || [];
  return `<section class="card" data-audit-log><div class="toolbar"><div><h2>سجل التدقيق</h2><p>سجل قراءة فقط للتغييرات، مرتب من الأحدث إلى الأقدم.</p></div><button class="button secondary" data-action="audit-refresh" type="button" ${state.audit.loading ? 'disabled' : ''}>تحديث</button></div><p class="notice info">يعرض السجل ما تغير ومن قام بالتغيير ووقته، مع تفاصيل مفهومة للمراجعة.</p>${state.audit.loading ? loading() : rows.length ? `<div class="table-wrap"><table class="audit-table"><thead><tr><th>العملية</th><th>السجل</th><th>من قام بالعملية</th><th>التاريخ والوقت</th><th>قبل التغيير</th><th>بعد التغيير</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(auditActionLabel(row.action))}</td><td>${escapeHtml(entityTypeLabel(row.entity_type))}</td><td>${escapeHtml(roleLabel(row.actor_role))}</td><td>${escapeHtml(dateTimeLabel(row.created_at))}</td><td>${auditValueMarkup(row.before, row)}</td><td>${auditValueMarkup(row.after, row)}</td></tr>`).join('')}</tbody></table></div>` : empty('لا توجد سجلات تدقيق متاحة.')}</section>`;
}
function customerPage() {
  const customer = state.selectedCustomer; if (!customer) return loading();
  const works = customer.works || []; const warnings = customer.warnings || []; const history = customer.history || [];
  return `<section class="detail-header"><div><h2>${escapeHtml(customer.name || 'عميل دون اسم')}</h2><div class="detail-meta"><span>الدولة: ${escapeHtml(catalogLabel('country', customer.country))}</span><span>الجامعة: ${escapeHtml(customer.university || 'غير متاحة')}</span><span>التخصص: ${escapeHtml(catalogLabel('specialty', customer.specialty))}</span></div></div><div class="toolbar-right"><button class="button ghost" data-action="edit-customer" type="button">تعديل العميل</button><button class="button" data-action="new-work" data-customer-id="${escapeHtml(customer.id)}" type="button">إضافة عمل</button></div></section>
  ${warnings.length ? `<section class="notice warning" style="margin-bottom:1rem"><strong>تنبيه مبني على وقائع موثقة:</strong><div>${warnings.map(item => `${escapeHtml(customerFactLabel(item.warning_type))} — ${escapeHtml(item.source_ref)} (${dateLabel(item.happened_at)})`).join('<br/>')}</div></section>` : '<section class="notice info" style="margin-bottom:1rem">لا توجد تحذيرات موثقة لهذا العميل.</section>'}
  <section class="grid grid-2"><article class="card"><div class="toolbar"><div><h2>أعمال العميل</h2><p>لكل عمل هوية وسجل مستقلان.</p></div></div>${works.length ? worksTable(works) : empty('لا توجد أعمال مسجلة لهذا العميل.')}</article><article class="card"><div class="toolbar"><div><h2>تاريخ التعامل المتاح</h2><p>يعرض الوقائع المسجلة لهذا العميل.</p></div><button class="button secondary" data-action="new-fact" type="button">إضافة واقعة موثقة</button></div>${history.length ? `<ul class="fact-list">${history.map(item => `<li><strong>${escapeHtml(customerFactLabel(item.fact_type))} — ${escapeHtml(item.source_ref)}</strong><span>${dateLabel(item.happened_at)}</span></li>`).join('')}</ul>` : empty('لا توجد وقائع موثقة بعد.')}</article></section>`;
}
function workPrimarySummaryMarkup(work) {
  const financials = work.financials || {};
  const pricingState = financials.price_state || work.pricing_state || ((financials.current_price_halalas ?? work.current_price_halalas) === null ? 'PRICE_UNSET' : 'PRICE_APPROVED');
  const currentPrice = financials.current_price_halalas ?? work.current_price_halalas ?? null;
  const statusText = workStatusLabel(work.status);
  const collectionText = collectionLabel(financials.collection_status);
  return `<section class="work-primary-summary" data-work-summary><div class="work-summary-heading"><div><p class="eyebrow">ملخص العمل</p><h2>${escapeHtml(work.title)}</h2><div class="detail-meta"><span>العميل: ${escapeHtml(customerName(work.customer_id))}</span><span>العلاقة: ${work.relationship_kind === 'CHILD' ? 'تابع لعمل أكبر' : 'عمل مستقل'}</span>${work.confirmed_at ? `<span>تاريخ التأكيد: ${escapeHtml(dateTimeLabel(work.confirmed_at))}</span>` : ''}</div></div><span class="badge ok">${escapeHtml(statusText)}</span></div><div class="grid grid-3 work-summary-financial"><article class="stat"><small>السعر المعتمد</small><strong data-authoritative-price>${escapeHtml(pricingState === 'PRICE_UNSET' ? 'السعر غير محدد' : moneyLabel(currentPrice))}</strong></article><article class="stat"><small>المدفوع المعتمد</small><strong data-approved-payments>${escapeHtml(moneyLabel(financials.approved_payments_total_halalas))}</strong></article><article class="stat"><small>المتبقي</small><strong data-remaining>${escapeHtml(moneyLabel(financials.remaining_halalas ?? currentPrice))}</strong></article></div><div class="work-summary-status"><article class="card" data-execution-status><h2>حالة التنفيذ</h2><div class="badge ok">${escapeHtml(statusText)}</div></article><article class="card" data-collection-status><h2>ملخص التحصيل</h2><div class="badge ${financials.collection_status === 'PARTIALLY_COLLECTED' ? 'unset' : 'ok'}" data-collection-descriptor>${escapeHtml(collectionText)}</div><p class="hint">مشتق من السعر والدفعات المعتمدة، ومستقل عن حالة التنفيذ.</p></article></div></section>`;
}
function workAttentionMarkup(work) {
  const financials = work.financials || {};
  const pendingFinancial = [...(Array.isArray(financials.price_requests) ? financials.price_requests : []), ...(Array.isArray(financials.ratio_requests) ? financials.ratio_requests : [])].filter(item => item.state === 'PENDING');
  const pendingWork = (Array.isArray(work.requests) ? work.requests : []).filter(item => item.state === 'PENDING');
  const pendingReversals = (Array.isArray(work.reversalRequests) ? work.reversalRequests : []).filter(item => item.state === 'PENDING');
  const warnings = Array.isArray(work.soft_warnings) ? work.soft_warnings : [];
  if (!pendingFinancial.length && !pendingWork.length && !pendingReversals.length && !warnings.length) return '';
  return `<section class="work-attention notice warning" data-work-attention><div><strong>يحتاج انتباهًا</strong><ul class="work-attention-list">${warnings.map(warning => `<li>${escapeHtml(softWarningLabel(warning))}</li>`).join('')}${pendingFinancial.length ? `<li>طلبات سعر أو نسبة معلقة (${pendingFinancial.length})</li>` : ''}${pendingReversals.length ? `<li>طلبات تصحيح دفعات معلقة (${pendingReversals.length})</li>` : ''}${pendingWork.length ? `<li>طلبات إلغاء أو أرشفة معلقة (${pendingWork.length})</li>` : ''}</ul><div class="work-attention-actions">${pendingFinancial.length ? '<button class="button secondary" data-open-work-disclosure="financial-details" type="button">فتح الطلبات المالية</button>' : ''}${pendingReversals.length ? '<button class="button secondary" data-open-work-disclosure="collection-details" type="button">فتح تصحيح الدفعات</button>' : ''}${pendingWork.length ? '<button class="button danger" data-open-work-disclosure="danger" type="button">فتح الإجراءات المعلقة</button>' : ''}</div></div></section>`;
}
function workPage() {
  const work = state.selectedWork; if (!work) return loading(); const similar = work.similar || [];
  const statusText = workStatusLabel(work.status);
  const cancelled = work.is_cancelled || ['CANCELLED_BEFORE_EXECUTION', 'PARTIALLY_STOPPED'].includes(work.status);

  // Sort events chronologically: effective_at ASC, created_at ASC, id ASC
  const sortedEvents = [...(work.events || [])].sort((a, b) => {
    const d1 = new Date(a.effective_at).getTime();
    const d2 = new Date(b.effective_at).getTime();
    if (d1 !== d2) return d1 - d2;
    const c1 = new Date(a.created_at).getTime();
    const c2 = new Date(b.created_at).getTime();
    if (c1 !== c2) return c1 - c2;
    return String(a.id).localeCompare(String(b.id));
  });

  const ordinaryStatuses = [
    'NEW_REQUEST', 'REQUIREMENT_REVIEW', 'NEEDS_PRICING', 'WAITING_CLIENT_RESPONSE',
    'NEEDS_FOLLOW_UP', 'AGREED', 'IN_PROGRESS', 'WAITING_CUSTOMER_INFO',
    'WAITING_REVIEW', 'REVISION_REQUIRED', 'PAUSED', 'COMPLETED', 'DELIVERED'
  ];

  const archiveDisplay = work.is_archived ? '✅ مؤرشف' : 'غير مؤرشف';

  return `
  <section class="detail-header">
    <div>
      <h2>${escapeHtml(work.title)}</h2>
      <div class="detail-meta">
        <span></span>
        <span>العميل: ${escapeHtml(customerName(work.customer_id))}</span>
        <span>العلاقة: ${work.relationship_kind === 'CHILD' ? 'تابع لعمل أكبر' : 'عمل مستقل'}</span>
        <span>${badgeForWork(work)}</span>
        <span class="badge ok">الحالة الحالية: ${escapeHtml(statusText)}</span>
        <span class="badge ${work.is_archived ? 'ok' : 'unset'}">الأرشفة: ${escapeHtml(archiveDisplay)}</span>
        <span class="badge ${work.confirmed_at ? 'ok' : 'unset'}">تاريخ التأكيد: ${escapeHtml(work.confirmed_at ? dateTimeLabel(work.confirmed_at) : 'غير مؤكد')}</span>
      </div>
    </div>
    ${cancelled ? '' : '<button class="button ghost" data-action="edit-work" type="button">تعديل العمل</button>'}
  </section>
  ${softWarningsMarkup(work)}
  ${cancelled ? '<section class="notice warning" data-cancelled-work-notice><strong>ملغى — الرصيد على العميل صفر</strong><p>حُفظ السعر والتاريخ والمدفوعات السابقة كما هي. توقفت العمليات العادية؛ المتاح هو القراءة والتصحيح التاريخي الموثق والأرشفة فقط.</p></section>' : ''}
  ${workPrimarySummaryMarkup(work)}
  ${workAttentionMarkup(work)}
  <details class="work-disclosure" data-work-disclosure="financial-details">
    <summary><span>تفاصيل السعر والنسبة والتاريخ المالي</span><span class="disclosure-hint">تفتح عند الحاجة</span></summary>
    <div class="work-disclosure-body">${financialMarkup(work)}</div>
  </details>
  <details class="work-disclosure" data-work-disclosure="collection-details">
    <summary><span>التحصيل والدفعات والتصحيح</span><span class="disclosure-hint">تفتح عند الحاجة</span></summary>
    <div class="work-disclosure-body">${s7WorkFinancialMarkup(work)}</div>
  </details>

  <section class="grid grid-2">
    <article class="card">
      <h2>البيانات الحالية</h2>
      <div class="fact-list">
        <li><strong>الدولة والجامعة</strong><span>${escapeHtml(catalogLabel('country', work.country))} — ${escapeHtml(work.university || 'غير متاحة')}</span></li>
        <li><strong>النوع والتخصص</strong><span>${escapeHtml(workTypeLabel(work.work_type_key))} — ${escapeHtml(catalogLabel('specialty', work.specialty_key))}</span></li>
        <li><strong>المادة/الرمز</strong><span>${escapeHtml(work.subject_or_course_code || 'غير متاح')}</span></li>
        <li><strong>الوصف</strong><span>${escapeHtml(work.description || 'لا يوجد وصف')}</span></li>
      </div>
    </article>
    <article class="card">
      <h2>أعمال مشابهة متاحة للقراءة</h2>
      <p>السعر المعروض هنا هو السعر الحالي المعتمد فقط.</p>
      ${similar.length ? `<ul class="fact-list">${similar.map(item => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(workTypeLabel(item.work_type_key))} — ${dateLabel(item.created_at)}</span><span data-similar-authoritative-price>السعر الحالي: ${escapeHtml(item.pricing_state === 'PRICE_UNSET' ? 'السعر غير محدد' : moneyLabel(item.current_price_halalas))}</span></li>`).join('')}</ul>` : empty('لا توجد أعمال مشابهة ضمن البيانات المتاحة.')}
    </article>
  </section>

  <details class="work-disclosure" data-work-disclosure="history">
    <summary><span>النشاط والتاريخ</span><span class="disclosure-hint">الأحداث وتغييرات العنوان والحالة</span></summary>
    <div class="work-disclosure-body">
  <!-- S5 PR-B BUSINESS FLOWS -->
  <section class="grid grid-2" style="margin-top: 1.5rem;">
    <!-- CARD 1: EVENTS -->
    <article class="card">
      <h2>أحداث العمل</h2>
      <p>تسجيل زمني لكافة الأنشطة والاتصالات المرتبطة بالعمل.</p>
      <form id="s5-event-form" ${cancelled ? 'hidden' : ''}  class="form-grid" style="margin-top: 1rem; margin-bottom: 1.5rem;">
        <div class="field">
          <label>النوع <span class="required">*</span></label>
          <input class="input" name="event_type" required placeholder="مثال: اتصال، اجتماع، استلام" />
        </div>
        <div class="field">
          <label>تاريخ ووقت الحدث <span class="required">*</span></label>
          <input class="input" name="effective_at" type="datetime-local" required />
        </div>
        <div class="field full">
          <label>الوصف <span class="required">*</span></label>
          <input class="input" name="description" required placeholder="تفاصيل الحدث..." />
        </div>
        <div class="form-actions full">
          <button class="button" type="submit" ${state.busy ? 'disabled' : ''}>إضافة حدث</button>
        </div>
      </form>
      <div id="s5-events-list">
        ${sortedEvents.length ? `
          <ul class="fact-list">
            ${sortedEvents.map(ev => `
              <li>
                <strong>${escapeHtml(ev.event_type)}</strong>
                <span>الوصف: ${escapeHtml(ev.description)}</span>
                <span style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                  بواسطة: ${escapeHtml(roleLabel(ev.actor_uid))} | وقت الحدث: ${dateTimeLabel(ev.effective_at)} | تاريخ التسجيل: ${dateTimeLabel(ev.created_at)}
                </span>
              </li>
            `).join('')}
          </ul>
        ` : empty('لا توجد أحداث مسجلة لهذا العمل.')}
      </div>
    </article>

    <!-- CARD 2: TITLE & EXECUTION STATUS CHANGES -->
    <article class="card">
      <!-- TITLE SECTION -->
      <h2>تغيير العنوان وتاريخه</h2>
      <p>يتطلب سببًا إلزاميًا لحفظ التغيير وتسجيله تاريخيًا.</p>
      <form id="s5-title-form" ${cancelled ? 'hidden' : ''}  class="form-grid" style="margin-top: 1rem; margin-bottom: 1.5rem;">
        <div class="field">
          <label>العنوان الجديد <span class="required">*</span></label>
          <input class="input" name="new_title" required placeholder="أدخل العنوان الجديد..." />
        </div>
        <div class="field">
          <label>سبب التغيير <span class="required">*</span></label>
          <input class="input" name="reason" required placeholder="السبب الإلزامي..." />
        </div>
        <div class="form-actions full" style="margin-top: 0.5rem;">
          <button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تحديث العنوان</button>
        </div>
      </form>
      <div id="s5-title-history" style="margin-bottom: 2rem;">
        <h4>سجل تغيير العناوين</h4>
        ${work.titleHistory && work.titleHistory.length ? `
          <ul class="fact-list">
            ${work.titleHistory.map(th => `
              <li>
                <strong>العنوان القديم: ${escapeHtml(th.old_title)} ← الجديد: ${escapeHtml(th.new_title)}</strong>
                <span>سبب التغيير: ${escapeHtml(th.reason)}</span>
                <span style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                  بواسطة: ${escapeHtml(roleLabel(th.changed_by))} | وقت التغيير: ${dateTimeLabel(th.changed_at)}
                </span>
              </li>
            `).join('')}
          </ul>
        ` : empty('لا يوجد تاريخ لتغييرات العنوان.')}
      </div>

      <hr style="border: 0; border-top: 1px solid var(--line); margin: 2rem 0;"/>

      <!-- STATUS SECTION -->
      <h2>تغيير حالة التنفيذ العادية</h2>
      <p>المسارات المباشرة للمراحل العادية للتنفيذ (تستثنى منها حالات الإلغاء).</p>
      <form id="s5-status-form" ${cancelled ? 'hidden' : ''}  class="form-grid" style="margin-top: 1rem; margin-bottom: 1.5rem;">
        <div class="field">
          <label>الحالة العادية <span class="required">*</span></label>
          <select class="select" name="status" required>
            <option value="">— اختر الحالة —</option>
            ${ordinaryStatuses.map(s => `<option value="${s}" ${work.status === s ? 'selected' : ''}>${escapeHtml(workStatusLabel(s))}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>سبب التغيير <span class="required">*</span></label>
          <input class="input" name="reason" required placeholder="السبب الإلزامي..." />
        </div>
        <div class="form-actions full" style="margin-top: 0.5rem;">
          <button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تحديث الحالة</button>
        </div>
      </form>
      <div id="s5-status-history">
        <h4>سجل تغيير حالات التنفيذ</h4>
        ${work.statusHistory && work.statusHistory.length ? `
          <ul class="fact-list">
            ${work.statusHistory.map(sh => `
              <li>
                <strong>الحالة القديمة: ${escapeHtml(workStatusLabel(sh.old_status))} ← الجديدة: ${escapeHtml(workStatusLabel(sh.new_status))}</strong>
                <span>السبب: ${escapeHtml(sh.reason)}</span>
                <span style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                  بواسطة: ${escapeHtml(roleLabel(sh.changed_by))} | وقت التغيير: ${dateTimeLabel(sh.changed_at)}
                </span>
              </li>
            `).join('')}
          </ul>
        ` : empty('لا يوجد تاريخ لتغييرات الحالة.')}
      </div>
    </article>
  </section>
    </div>
  </details>

  <details class="work-disclosure work-danger-zone" data-work-disclosure="danger">
    <summary><span>الإلغاء والأرشفة — إجراءات حساسة</span><span class="disclosure-hint">تأكيد وموافقة الحساب الآخر</span></summary>
    <div class="work-disclosure-body">
  <section class="grid grid-2" style="margin-top: 1.5rem;">
    <!-- CARD 3: REQUESTS GOVERNED FLOW (CANCEL / ARCHIVE) -->
    <article class="card">
      <h2>طلبات الإلغاء والأرشفة (تحتاج موافقة الحساب الآخر)</h2>
      <p>يتطلب الإلغاء والأرشفة موافقة ثنائية مستقلة من الحساب الآخر (المستندة إلى دورة موافقة الطرفين).</p>

      <!-- CANCEL REQUEST FORM -->
      <div style="background: var(--canvas); padding: 1rem; border-radius: 12px; margin-top: 1rem;">
        <h3>تقديم طلب إلغاء</h3>
        <form id="s5-cancel-form" ${cancelled ? 'hidden' : ''}  class="form-grid" style="margin-top: 0.5rem;">
          <div class="field">
            <label>الحالة المستهدفة لطلب الإلغاء <span class="required">*</span></label>
            <select class="select" name="target_execution_status" required>
              <option value="">— اختر الحالة المستهدفة —</option>
              <option value="CANCELLED_BEFORE_EXECUTION">${escapeHtml(WORK_STATUS_LABELS.CANCELLED_BEFORE_EXECUTION)}</option>
              <option value="PARTIALLY_STOPPED">${escapeHtml(WORK_STATUS_LABELS.PARTIALLY_STOPPED)}</option>
            </select>
          </div>
          <div class="field">
            <label>سبب طلب الإلغاء <span class="required">*</span></label>
            <input class="input" name="reason" required placeholder="السبب الإلزامي..." />
          </div>
          <div class="form-actions full" style="margin-top: 0.5rem;">
            <button class="button danger" type="submit" ${state.busy ? 'disabled' : ''}>تقديم طلب إلغاء</button>
          </div>
        </form>
      </div>

      <!-- ARCHIVE REQUEST FORM -->
      <div style="background: var(--canvas); padding: 1rem; border-radius: 12px; margin-top: 1rem; margin-bottom: 2rem;">
        <h3>تقديم طلب أرشفة</h3>
        <form id="s5-archive-form" class="form-grid" style="margin-top: 0.5rem;">
          <div class="field full">
            <label>سبب طلب الأرشفة <span class="required">*</span></label>
            <input class="input" name="reason" required placeholder="السبب الإلزامي..." />
          </div>
          <div class="form-actions full" style="margin-top: 0.5rem;">
            <button class="button" type="submit" ${state.busy ? 'disabled' : ''}>تقديم طلب أرشفة</button>
          </div>
        </form>
      </div>

      <div>
        <h4>قائمة طلبات الموافقة المعلقة والتاريخية</h4>
        ${work.requests && work.requests.length ? `
          <div class="fact-list" style="display: grid; gap: 0.75rem;">
            ${work.requests.map(req => {
              const isPending = req.state === 'PENDING';
              const isSelf = req.requested_by === state.auth.uid;
              const actionLabel = req.action === 'CANCEL' ? 'إلغاء' : 'أرشفة';
              const targetLabel = req.target_execution_status ? ` ← ${escapeHtml(workStatusLabel(req.target_execution_status))}` : '';
              return `
                <div style="border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem; background: ${isPending ? 'var(--warning-soft)' : 'var(--success-soft)'};">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
                    <strong>طلب ${actionLabel}${targetLabel}</strong>
                    <span class="badge ${isPending ? 'unset' : 'ok'}">${isPending ? 'معلق بانتظار الاعتماد' : 'تم الاعتماد ومطابقة الطلب'}</span>
                  </div>
                  <div style="font-size: 0.75rem; margin-top: 0.35rem;"><strong>السبب:</strong> ${escapeHtml(req.reason)}</div>
                  <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                    الطالب: ${escapeHtml(roleLabel(req.requested_by))} | وقت الطلب: ${dateTimeLabel(req.requested_at)}
                  </div>
                  ${req.approved_by ? `
                    <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.15rem;">
                      المعتمد: ${escapeHtml(roleLabel(req.approved_by))} | وقت الاعتماد: ${dateTimeLabel(req.approved_at)}
                    </div>
                  ` : ''}
                  ${isPending ? `
                    <div style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                      ${isSelf ? `
                        <span class="badge warn" style="font-size: 0.65rem;">بانتظار اعتماد الحساب الآخر (لا يمكنك اعتماد طلبك بموجب الموافقة الثنائية)</span>
                      ` : `
                        <button class="button" data-action="approve-request" data-request-id="${req.id}" style="background: var(--teal);" ${state.busy ? 'disabled' : ''}>اعتماد الطلب</button>
                      `}
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        ` : empty('لا توجد طلبات معلقة أو معتمدة.')}
      </div>
    </article>

    <!-- CARD 4: ARCHIVE HISTORY -->
    <article class="card">
      <h2>تاريخ عمليات الأرشفة</h2>
      <p>السجل الدائم والكامل لعمليات أرشفة هذا العمل (مستقل عن حالة التنفيذ الجارية).</p>
      <div id="s5-archive-history" style="margin-top: 1rem;">
        ${work.archiveHistory && work.archiveHistory.length ? `
          <ul class="fact-list">
            ${work.archiveHistory.map(ah => `
              <li>
                <strong>أرشفة كاملة ومؤمنة للعمل</strong>
                <span>السبب والمبرر: ${escapeHtml(ah.reason)}</span>
                <span style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                  بواسطة: ${escapeHtml(roleLabel(ah.archived_by))} | وقت الأرشفة: ${dateTimeLabel(ah.archived_at)}
                </span>
              </li>
            `).join('')}
          </ul>
        ` : empty('لم يتم أرشفة هذا العمل من قبل.')}
      </div>
    </article>
  </section>
    </div>
  </details>
  `;
}
function modalMarkup() {
  if (!state.modal) return '';
  const { type, data = {} } = state.modal;
  const title = type === 'confirmation' ? data.action : ({ customer: data.id ? 'تعديل بيانات العميل' : 'إضافة عميل', work: data.id ? 'تعديل العمل' : 'إضافة عمل', catalog: 'إضافة قيمة للقائمة', fact: 'إضافة واقعة موثقة', 'payment-reversal': 'طلب تصحيح أو إلغاء دفعة' }[type]);
  const content = type === 'confirmation' ? `<section class="notice warning"><p>${escapeHtml(data.effect)}</p></section><div class="form-actions"><button class="button danger" data-action="accept-confirmation" type="button">تأكيد</button><button class="button ghost" data-action="cancel-confirmation" type="button">إلغاء</button></div>` : type === 'customer' ? customerForm(data) : type === 'work' ? workForm(data) : type === 'catalog' ? catalogForm(data) : type === 'payment-reversal' ? paymentReversalForm(data) : factForm(data);
  return `<div class="dialog-backdrop" role="presentation"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="dialog-head"><h2 id="dialog-title">${title}</h2><button class="close" data-action="close-modal" type="button" aria-label="إغلاق">×</button></header>${content}</section></div>`;
}
function modalInvokerReference(invoker) {
  if (!invoker) return null;
  let selector = '';
  if (invoker.id) selector = `#${CSS.escape(invoker.id)}`;
  else if (invoker.dataset?.action) {
    selector = `[data-action="${CSS.escape(invoker.dataset.action)}"]`;
    for (const key of ['customerId', 'paymentId', 'workId']) {
      if (invoker.dataset[key]) selector += `[data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}="${CSS.escape(invoker.dataset[key])}"]`;
    }
  }
  return { element: invoker, selector };
}
function openModal(modal, invoker = document.activeElement) { modalInvoker = modalInvokerReference(invoker); state.modal = modal; render(); }
function closeModal() { if (pendingConfirmation) { resolveConfirmation(false); return; } const invoker = modalInvoker; state.modal = null; modalInvoker = null; render(); Promise.resolve().then(() => (invoker?.selector && document.querySelector(invoker.selector) || invoker?.element)?.focus?.()); }
function bindDialogAccessibility() {
  const dialog = document.querySelector('.dialog');
  if (!dialog) return;
  const focusable = () => [...(dialog.querySelectorAll?.('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])') || [])].filter(item => !item.hidden);
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (event.key !== 'Tab') return;
    const items = focusable(); if (!items.length) { event.preventDefault(); return; }
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  Promise.resolve().then(() => (dialog.querySelector?.('input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)') || focusable()[0] || dialog).focus?.());
}
function associateFieldLabels() {
  const fields = document.querySelectorAll?.('.field') || [];
  fields.forEach((field, index) => {
    const label = field.querySelector?.('label');
    const control = field.querySelector?.('input:not([type="hidden"]), select, textarea');
    if (!label || !control || label.contains?.(control) || control.getAttribute?.('aria-label') || control.getAttribute?.('aria-labelledby')) return;
    if (!control.id) control.id = `s9-${state.view}-${index}`;
    label.htmlFor = control.id;
  });
}
function options(kind, selected) { return `<option value="">— اختر عند توفر المعلومة —</option>${(state.catalogs[kind] || []).filter(item => item.active).map(item => `<option value="${escapeHtml(item.value_key)}" ${item.value_key === selected ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}`; }
function customerForm(customer = {}) {
  const duplicates = state.modal?.duplicateCandidates || [];
  const duplicateNotice = duplicates.length ? `<section class="notice warning" style="margin-bottom:1rem"><div><strong>يوجد عميل باسم مماثل.</strong><br/>${duplicates.map(item => `${escapeHtml(item.name || 'عميل دون اسم')} — ${escapeHtml(item.university || 'جامعة غير متاحة')}`).join('<br/>')}<br/><label><input type="checkbox" name="confirm_duplicate" value="yes" required/> راجعت السجلات وأؤكد أن هذا عميل جديد مستقل.</label></div></section>` : '';
  return `<form id="customer-form">${duplicateNotice}<input type="hidden" name="id" value="${escapeHtml(customer.id || '')}"/><input type="hidden" name="version" value="${escapeHtml(customer.version || '')}"/><div class="form-grid"><div class="field"><label>اسم العميل (عند توفره)</label><input class="input" name="name" value="${escapeHtml(customer.name || '')}"/><span class="hint">يمكن حفظ السجل دون اسم عندما لا تكون المعلومة متوفرة.</span></div><div class="field"><label>رقم التواصل</label><input class="input" name="contact" value="${escapeHtml(customer.contact || '')}" inputmode="tel"/></div><div class="field"><label>الدولة</label><select class="select" name="country">${options('country', customer.country)}</select></div><div class="field"><label>الجامعة</label><input class="input" name="university" value="${escapeHtml(customer.university || '')}"/><span class="hint">اختيارية عند عدم توفرها.</span></div><div class="field"><label>التخصص</label><select class="select" name="specialty">${options('specialty', customer.specialty)}</select><span class="hint">أدخله عند معرفته، دون منع حفظ المعلومة المفقودة.</span></div><div class="field"><label>حالة سجل العميل</label><div class="readonly-value" data-derived-customer-status="${escapeHtml(customer.status || 'normal')}">${escapeHtml(CUSTOMER_STATUS_LABELS[customer.status] || CUSTOMER_STATUS_LABELS.normal)}</div><span class="hint">تظهر التنبيهات من الوقائع المسجلة عند وجودها، ولا تحتاج إلى إدخال حالة يدويًا.</span></div><div class="field full"><label>ملاحظات</label><textarea class="textarea" name="notes">${escapeHtml(customer.notes || '')}</textarea></div></div><div class="form-actions"><button class="button" type="submit">حفظ</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }
function preAgreementCanSubmitNewWork(customerId) {
  const context = state.modal?.preAgreementContext;
  return Boolean(customerId && context?.customerId === customerId && context.status === 'VERIFIED');
}
function preAgreementContextMarkup(isNewWork, customerId) {
  if (!isNewWork) return '';
  const context = state.modal?.preAgreementContext || { customerId, status: customerId ? 'LOADING' : 'UNSELECTED', warnings: [], history: [] };
  if (context.status === 'LOADING') return '<section class="notice info" data-pre-agreement-context="loading" data-pre-agreement-warning="loading">جارٍ تجهيز سجل العميل قبل الحفظ…</section>';
  if (context.status === 'ERROR') return `<section class="notice warning" data-pre-agreement-context="error" data-pre-agreement-warning="error"><strong>تعذر تحميل سياق العميل قبل الحفظ.</strong><p>${escapeHtml(errorMessage('WARNING_CONTEXT_UNAVAILABLE'))}</p><button class="button secondary" type="button" data-action="retry-pre-agreement-context">إعادة تحميل السياق</button></section>`;
  if (context.status === 'UNSELECTED') return '<section class="notice info" data-pre-agreement-context="unselected" data-pre-agreement-warning="unselected">اختر العميل لعرض سجل التعامل قبل الحفظ.</section>';
  const warnings = context.warnings || [];
  const history = context.history || [];
  const warningMarkup = warnings.length
    ? `<section class="notice warning" data-pre-agreement-context="verified" data-pre-agreement-warning="present"><strong>تحذير قبل إنشاء العمل:</strong><div>${warnings.map(item => `${escapeHtml(customerFactLabel(item.warning_type))} — ${escapeHtml(item.source_ref)} (${dateTimeLabel(item.happened_at)})`).join('<br/>')}</div><p>راجع التنبيه قبل المتابعة.</p></section>`
    : '<section class="notice info" data-pre-agreement-context="verified" data-pre-agreement-warning="none">تم التحقق من التحذيرات المتاحة: لا توجد تحذيرات موثقة لهذا العميل.</section>';
  const historyMarkup = history.length
    ? `<section class="notice info" data-pre-agreement-history="present"><strong>تاريخ التعامل المتاح قبل الاتفاق:</strong><ul class="fact-list">${history.map(item => `<li><strong>${escapeHtml(customerFactLabel(item.fact_type))}</strong><span>المرجع: ${escapeHtml(item.source_ref || 'غير متاح')} — ${dateTimeLabel(item.happened_at)}</span></li>`).join('')}</ul></section>`
    : '<section class="notice info" data-pre-agreement-history="none">تم تحميل تاريخ التعامل المتاح: لا توجد وقائع موثقة لهذا العميل.</section>';
  return `${warningMarkup}${historyMarkup}`;
}
function workForm(work = {}) {
  const isNewWork = !work.id;
  const customerId = work.customer_id || state.modal?.customerId || state.selectedCustomer?.id || '';
  const customerWorks = state.works.filter(item => item.customer_id === customerId && item.id !== work.id);
  const selectedStatus = WORK_STATUS_LABELS[work.status] ? work.status : 'NEW_REQUEST';
  const statusOptions = Object.entries(WORK_STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${value === selectedStatus ? 'selected' : ''}>${label}</option>`).join('');
  const contextMarkup = preAgreementContextMarkup(isNewWork, customerId);
  const detailWarningsMarkup = softWarningsMarkup(work);
  const submitDisabled = isNewWork && !preAgreementCanSubmitNewWork(customerId);
  const submitHint = submitDisabled ? '<p class="hint" data-pre-agreement-submit-state="blocked">أكمل اختيار العميل ثم راجع سجل التعامل قبل الحفظ.</p>' : '';
  return `<form id="work-form">${contextMarkup}${detailWarningsMarkup}<input type="hidden" name="id" value="${escapeHtml(work.id || '')}"/><input type="hidden" name="version" value="${escapeHtml(work.version || '')}"/><div class="form-grid"><div class="field"><label>العميل <span class="required">*</span></label><select class="select" id="work-customer" name="customer_id" required ${work.id ? 'disabled' : ''}><option value="">— اختر العميل —</option>${state.customers.map(customer => `<option value="${escapeHtml(customer.id)}" ${customer.id === customerId ? 'selected' : ''}>${escapeHtml(customer.name || 'عميل غير مسمى')}</option>`).join('')}</select>${work.id ? `<input type="hidden" name="customer_id" value="${escapeHtml(customerId)}"/>` : ''}</div><div class="field"><label>العنوان <span class="required">*</span></label><input class="input" name="title" value="${escapeHtml(work.title || '')}" required/><span class="hint">لا يكتفى بعنوان عام عندما تكون التفاصيل متاحة.</span></div><div class="field"><label>الدولة <span class="required">*</span></label><select class="select" name="country" required>${options('country', work.country)}</select></div><div class="field"><label>الجامعة</label><input class="input" name="university" value="${escapeHtml(work.university || '')}"/></div><div class="field"><label>التخصص</label><select class="select" name="specialty_key">${options('specialty', work.specialty_key)}</select></div><div class="field"><label>نوع العمل</label><select class="select" name="work_type_key">${options('work_type', work.work_type_key)}</select></div><div class="field"><label>المادة أو الرمز</label><input class="input" name="subject_or_course_code" value="${escapeHtml(work.subject_or_course_code || '')}"/></div><div class="field"><label>الكمية</label><input class="input" name="quantity" type="number" min="1" value="${escapeHtml(work.quantity || '')}"/></div><div class="field"><label>الحالة الأساسية الحالية</label><select class="select" name="status" data-controlled-work-status>${statusOptions}</select><span class="hint">اختر الحالة الحالية للعمل.</span></div><div class="field"><label>علاقة العمل</label><select class="select" id="relationship-kind" name="relationship_kind"><option value="INDEPENDENT" ${work.relationship_kind !== 'CHILD' ? 'selected' : ''}>مستقل</option><option value="CHILD" ${work.relationship_kind === 'CHILD' ? 'selected' : ''}>تابع لعمل أكبر</option></select></div><div class="field" id="parent-field" ${work.relationship_kind === 'CHILD' ? '' : 'hidden'}><label>العمل الأصل</label><select class="select" name="parent_work_id"><option value="">— اختر العمل الأصل —</option>${customerWorks.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === work.parent_work_id ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select><span class="hint">اختر العمل الأصل الصحيح قبل الحفظ.</span></div><div class="field"><label>تاريخ التأكيد</label><input class="input" name="confirmed_at" type="text" inputmode="numeric" placeholder="مثال: 12/08/2026 10:00" value="${escapeHtml(dateTimeInputLabel(work.confirmed_at))}"/><span class="hint">اختياري: تاريخ موافقة العميل على السعر أو بدء التنفيذ. استخدم الصيغة يوم/شهر/سنة ساعة:دقيقة.</span></div><div class="field full"><label>الوصف والمطلوب</label><textarea class="textarea" name="description">${escapeHtml(work.description || '')}</textarea></div></div><section class="notice info" style="margin-top:1rem">عند الإضافة يبدأ العمل بعبارة <strong>السعر غير محدد</strong> حتى اعتماد سعر.</section>${submitHint}<div class="form-actions"><button class="button" type="submit" ${submitDisabled ? 'disabled aria-disabled="true"' : ''}>حفظ العمل</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`;
}
function paymentReversalForm(data = {}) { return `<form id="payment-reversal-form"><input type="hidden" name="payment_id" value="${escapeHtml(data.paymentId || '')}"/><div class="form-grid"><div class="field full"><label>سبب التصحيح أو الإلغاء</label><input class="input" name="reason" required placeholder="سبب موثق مطلوب"/></div></div><section class="notice warning">سيبقى التحصيل كما هو حتى يعتمد الحساب الآخر الطلب.</section><div class="form-actions"><button class="button danger" type="submit">تقديم طلب التصحيح</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }
function catalogForm(data) { return `<form id="catalog-form"><input type="hidden" name="kind" value="${escapeHtml(data.kind || '')}"/><div class="form-grid"><div class="field full"><label>الاسم الظاهر <span class="required">*</span></label><input class="input" name="label" required/><span class="hint">اكتب الاسم كما تريد أن يظهر في القوائم.</span></div></div><div class="form-actions"><button class="button" type="submit">إضافة واستخدام القيمة</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }
function factForm() { const customer = state.selectedCustomer; return `<form id="fact-form"><div class="form-grid"><div class="field"><label>نوع الواقعة <span class="required">*</span></label><select class="select" name="fact_type" required><option value="NON_PAYMENT">عدم دفع</option><option value="DELAY">تأخر</option><option value="BLOCKED">حظر/انقطاع</option><option value="DISPUTE">نزاع</option></select></div><div class="field"><label>العمل المرتبط (اختياري)</label><select class="select" name="work_id"><option value="">— دون عمل محدد —</option>${(customer.works || []).map(work => `<option value="${escapeHtml(work.id)}">${escapeHtml(work.title)}</option>`).join('')}</select></div><div class="field full"><label>المصدر أو الدليل <span class="required">*</span></label><input class="input" name="source_ref" required placeholder="مرجع موثق دون إدخال بيانات حساسة"/></div><div class="field"><label>وقت الواقعة <span class="required">*</span></label><input class="input" name="happened_at" type="datetime-local" required/></div><div class="field full"><label>تفاصيل مختصرة</label><textarea class="textarea" name="details"></textarea></div></div><section class="notice info" style="margin-top:1rem">لن يُنشأ تحذير يدوي؛ سيظهر التحذير فقط لأن هذه الواقعة الموثقة سجلت بنجاح.</section><div class="form-actions"><button class="button" type="submit">حفظ الواقعة</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }

function render() {
  if (state.auth.status !== 'signed_in') { root.innerHTML = authScreen(); associateFieldLabels(); bindAuth(); return; }
  const content = state.view === 'dashboard' ? dashboard() : state.view === 'customers' ? customersPage() : state.view === 'works' ? worksPage() : state.view === 'financial' ? financialPage() : state.view === 's8' ? s8SearchPage() : state.view === 'catalogs' ? catalogsPage() : state.view === 'audit' ? auditPage() : state.view === 'customer' ? customerPage() : workPage();
  root.innerHTML = shell(content); associateFieldLabels(); bindShell(); syncBusyControls(); bindDialogAccessibility();
}
function bindAuth() {
  const form = document.querySelector('#login-form');
  form?.addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(form); setBusy(true);
    try { await state.auth.tokenProvider?.signIn?.(String(data.get('email')), String(data.get('password'))); await authenticateExistingSession(); }
    catch { toast('تعذر تسجيل الدخول. تأكد من البيانات ثم أعد المحاولة.', 'error'); }
    finally { setBusy(false); }
  });
}
function bindShell() {
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', async () => { state.view = button.dataset.nav; state.selectedCustomer = null; state.selectedWork = null; await refreshForView(); }));
  document.querySelectorAll('[data-open-work-disclosure]').forEach(button => button.addEventListener('click', () => {
    const disclosure = document.querySelector(`[data-work-disclosure="${CSS.escape(button.dataset.openWorkDisclosure)}"]`);
    if (!disclosure) return;
    disclosure.open = true;
    disclosure.scrollIntoView({ behavior: 'smooth', block: 'start' });
    disclosure.querySelector('summary')?.focus();
  }));
  document.querySelector('#sign-out')?.addEventListener('click', async () => { await state.auth.tokenProvider?.signOut?.(); state.auth = { status: 'signed_out', tokenProvider: state.auth.tokenProvider, email: '', role: '' }; render(); });
  document.querySelectorAll('[data-customer]').forEach(button => button.addEventListener('click', () => openCustomer(button.dataset.customer)));
  document.querySelectorAll('[data-work]').forEach(button => button.addEventListener('click', () => openWork(button.dataset.work)));
  document.querySelectorAll('[data-action="new-customer"]').forEach(button => button.addEventListener('click', () => openModal({ type: 'customer', data: {} }, button)));
  document.querySelectorAll('[data-action="edit-customer"]').forEach(button => button.addEventListener('click', () => openModal({ type: 'customer', data: state.selectedCustomer }, button)));
  document.querySelectorAll('[data-action="new-work"]').forEach(button => button.addEventListener('click', () => { modalInvoker = modalInvokerReference(button); void openNewWork(button.dataset.customerId || ''); }));
  document.querySelectorAll('[data-action="edit-work"]').forEach(button => button.addEventListener('click', () => openModal({ type: 'work', data: state.selectedWork, customerId: state.selectedWork.customer_id }, button)));
  document.querySelectorAll('[data-action="new-catalog"]').forEach(button => button.addEventListener('click', () => openModal({ type: 'catalog', data: { kind: button.dataset.kind } }, button)));
  document.querySelectorAll('[data-action="new-fact"]').forEach(button => button.addEventListener('click', () => openModal({ type: 'fact', data: {} }, button)));
  document.querySelectorAll('[data-action="retry-pre-agreement-context"]').forEach(button => button.addEventListener('click', () => { const customerId = state.modal?.customerId; if (state.modal?.type === 'work' && !state.modal.data?.id && customerId) void refreshWorkCustomerContext(customerId, state.modal.data || {}); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach(button => button.addEventListener('click', closeModal));
  document.querySelector('[data-action="accept-confirmation"]')?.addEventListener('click', () => resolveConfirmation(true));
  document.querySelector('[data-action="cancel-confirmation"]')?.addEventListener('click', () => resolveConfirmation(false));
  document.querySelector('#customer-search')?.addEventListener('input', async event => { try { state.customers = await api(`/api/customers${queryString({ q: event.target.value })}`); render(); } catch (error) { toast(errorMessage(error.code), 'error'); } });
  document.querySelector('#s8-search-form')?.addEventListener('submit', s8ApplySearch);
  document.querySelector('#s8-alert-settings-form')?.addEventListener('submit', submitS8AlertSettings);
  document.querySelector('#s8-export-form')?.addEventListener('submit', submitS8Export);
  document.querySelector('[data-action="s8-refresh"]')?.addEventListener('click', () => { void submitFlow(async () => { await loadS8Workspace(); render(); }); });
  document.querySelector('[data-action="s8-analytics-refresh"]')?.addEventListener('click', s8RefreshAnalytics);
  document.querySelector('[data-action="s8-reset"]')?.addEventListener('click', () => { state.s8.filters = { ...state.s8.filters, q: '', month: '', year: '', status: '', customer_id: '', country: '', university: '', specialty_key: '', work_type_key: '', collection_status: '', include_archived: false }; state.s8.search.page = 1; void submitFlow(async () => { await loadS8Workspace(); render(); }); });
  document.querySelector('[data-action="audit-refresh"]')?.addEventListener('click', () => { void submitFlow(async () => { await loadAuditLog(); render(); }); });
  document.querySelectorAll('.account-email-form').forEach(form => form.addEventListener('submit', submitAccountEmail));
  document.querySelectorAll('.account-reset-form').forEach(form => form.addEventListener('submit', submitAccountReset));
  document.querySelector('[data-action="s8-prev"]')?.addEventListener('click', () => { state.s8.search.page = Math.max(1, state.s8.search.page - 1); void submitFlow(async () => { await loadS8Search(); render(); }); });
  document.querySelector('[data-action="s8-next"]')?.addEventListener('click', () => { state.s8.search.page += 1; void submitFlow(async () => { await loadS8Search(); render(); }); });
  bindModalForms();
  document.querySelector('#s5-event-form')?.addEventListener('submit', submitEvent);
  document.querySelector('#s5-title-form')?.addEventListener('submit', submitTitle);
  document.querySelector('#s5-status-form')?.addEventListener('submit', submitStatus);
  document.querySelector('#s5-cancel-form')?.addEventListener('submit', submitCancel);
  document.querySelector('#s5-archive-form')?.addEventListener('submit', submitArchive);
  document.querySelector('#s6-price-form')?.addEventListener('submit', submitPriceChange);
  document.querySelector('#s6-ratio-form')?.addEventListener('submit', submitRatioChange);
  document.querySelectorAll('[data-action="approve-request"]').forEach(button => button.addEventListener('click', () => handleApproveRequest(button.dataset.requestId)));
  document.querySelectorAll('[data-action="approve-price-request"]').forEach(button => button.addEventListener('click', () => handleApprovePriceRequest(button.dataset.requestId)));
  document.querySelectorAll('[data-action="approve-ratio-request"]').forEach(button => button.addEventListener('click', () => handleApproveRatioRequest(button.dataset.requestId)));
  document.querySelector('#s7-payment-form')?.addEventListener('submit', submitPayment);
  document.querySelector('#s7-transfer-form')?.addEventListener('submit', submitTransfer);
  document.querySelector('#s7-subscription-form')?.addEventListener('submit', submitSubscription);
  document.querySelector('#s7-expense-form')?.addEventListener('submit', submitExpense);
  document.querySelector('#s7-settlement-period-form')?.addEventListener('submit', submitSettlementPeriod);
  document.querySelector('#s7-settlement-close-form')?.addEventListener('submit', submitSettlementClose);
  document.querySelector('#s7-reopen-form')?.addEventListener('submit', submitSettlementReopen);
  document.querySelectorAll('[data-action="request-payment-reversal"]').forEach(button => button.addEventListener('click', () => openModal({ type: 'payment-reversal', data: { paymentId: button.dataset.paymentId } }, button)));
  document.querySelectorAll('[data-action="approve-payment-reversal"]').forEach(button => button.addEventListener('click', () => handleApprovePaymentReversal(button.dataset.requestId)));
  document.querySelectorAll('[data-action="approve-settlement-reopen"]').forEach(button => button.addEventListener('click', () => handleApproveSettlementReopen(button.dataset.requestId)));
}
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function nullable(value) { return value === '' ? null : value; }
function bindModalForms() {
  document.querySelector('#customer-form')?.addEventListener('submit', submitCustomer);
  document.querySelector('#work-form')?.addEventListener('submit', submitWork);
  document.querySelector('#catalog-form')?.addEventListener('submit', submitCatalog);
  document.querySelector('#fact-form')?.addEventListener('submit', submitFact);
  document.querySelector('#payment-reversal-form')?.addEventListener('submit', submitPaymentReversalRequest);
  document.querySelector('#relationship-kind')?.addEventListener('change', event => { const field = document.querySelector('#parent-field'); field.hidden = event.target.value !== 'CHILD'; });
  document.querySelector('#work-customer')?.addEventListener('change', event => {
    const form = document.querySelector('#work-form');
    if (!form) return;
    const next = formObject(form);
    void refreshWorkCustomerContext(event.target.value, next);
  });
}
async function submitCustomer(event) {
  event.preventDefault();
  const values = formObject(event.currentTarget);
  const body = { name: nullable(values.name), contact: nullable(values.contact), country: nullable(values.country), university: nullable(values.university), specialty: nullable(values.specialty), notes: nullable(values.notes) };
  await submitFlow(async () => {
    if (!values.id && values.confirm_duplicate !== 'yes' && body.name) {
      const candidates = await api(`/api/customers${queryString({ q: body.name })}`);
      const normalizedName = body.name.trim().toLocaleLowerCase('ar');
      const duplicates = candidates.filter(customer => String(customer.name || '').trim().toLocaleLowerCase('ar') === normalizedName);
      if (duplicates.length) {
        state.modal = { type: 'customer', data: body, duplicateCandidates: duplicates };
        render();
        toast(errorMessage('DUPLICATE_CUSTOMER_AMBIGUITY'), 'error');
        return;
      }
    }
    const result = values.id
      ? await api(`/api/customers/${encodeURIComponent(values.id)}`, { method: 'PATCH', body: { ...body, version: Number(values.version) } })
      : await api('/api/customers', { method: 'POST', body });
    state.modal = null;
    await loadDashboard();
    if (values.id) await openCustomer(result.id);
    else { state.view = 'customer'; await openCustomer(result.id); }
    toast('تم حفظ بيانات العميل.', '');
  });
}
async function submitWork(event) {
  event.preventDefault();
  const values = formObject(event.currentTarget);
  if (!values.id && !preAgreementCanSubmitNewWork(values.customer_id)) {
    toast(errorMessage('PRE_AGREEMENT_CONTEXT_REQUIRED'), 'error');
    return;
  }
  const confirmedAt = values.confirmed_at ? parseDateTimeInput(values.confirmed_at) : null;
  if (values.confirmed_at && !confirmedAt) { toast(errorMessage('EVENT_TIME_INVALID'), 'error'); return; }
  const body = { customer_id: values.customer_id, title: values.title, country: values.country, university: nullable(values.university), specialty_key: nullable(values.specialty_key), work_type_key: nullable(values.work_type_key), subject_or_course_code: nullable(values.subject_or_course_code), status: values.status, quantity: values.quantity ? Number(values.quantity) : null, relationship_kind: values.relationship_kind, parent_work_id: values.relationship_kind === 'CHILD' ? nullable(values.parent_work_id) : null, description: nullable(values.description), confirmed_at: confirmedAt };
  await submitFlow(async () => {
    const result = values.id ? await api(`/api/works/${encodeURIComponent(values.id)}`, { method: 'PATCH', body: { ...body, version: Number(values.version) } }) : await api('/api/works', { method: 'POST', body });
    state.modal = null;
    await loadDashboard();
    await refreshWorkAfterMutation(result.id, values.id ? 'تم تحديث العمل.' : 'تم إنشاء العمل بسعر غير محدد.');
  });
}
async function submitCatalog(event) { event.preventDefault(); const values = formObject(event.currentTarget); await submitFlow(async () => { await api(`/api/catalog/${encodeURIComponent(values.kind)}`, { method: 'POST', body: { label: values.label } }); state.modal = null; await loadCatalogs(); render(); toast('أضيفت القيمة وأصبحت متاحة للاستخدام.', ''); }); }
async function submitFact(event) { event.preventDefault(); const values = formObject(event.currentTarget); const parsed = new Date(values.happened_at); if (!Number.isFinite(parsed.getTime())) { toast(errorMessage('FACT_TIME_INVALID'), 'error'); return; } await submitFlow(async () => { await api('/api/facts', { method: 'POST', body: { customer_id: state.selectedCustomer.id, work_id: nullable(values.work_id), fact_type: values.fact_type, source_ref: values.source_ref, happened_at: parsed.toISOString(), details: values.details ? { note: values.details } : {} } }); state.modal = null; await openCustomer(state.selectedCustomer.id); toast('تم حفظ الواقعة؛ سيظهر التحذير المشتق عند انطباقه.', ''); }); }
async function openNewWork(customerId = '') {
  const preAgreementContext = { customerId, status: customerId ? 'LOADING' : 'UNSELECTED', warnings: [], history: [], error: null };
  state.modal = { type: 'work', data: {}, customerId, preAgreementContext };
  render();
  if (customerId) await refreshWorkCustomerContext(customerId, {});
}
async function refreshWorkCustomerContext(customerId, data = {}) {
  const preAgreementContext = { customerId, status: customerId ? 'LOADING' : 'UNSELECTED', warnings: [], history: [], error: null };
  state.modal = { type: 'work', data: { ...data, customer_id: customerId, parent_work_id: '' }, customerId, preAgreementContext };
  render();
  if (!customerId) return;
  const stillCurrent = () => state.modal?.type === 'work' && !state.modal.data?.id && state.modal.customerId === customerId;
  try {
    const [warnings, history] = await Promise.all([
      api(`/api/customers/${encodeURIComponent(customerId)}/warnings`),
      api(`/api/customers/${encodeURIComponent(customerId)}/history`),
    ]);
    if (!stillCurrent()) return;
    state.modal = { ...state.modal, preAgreementContext: { customerId, status: 'VERIFIED', warnings, history, error: null } };
    render();
  } catch (error) {
    if (!stillCurrent()) return;
    state.modal = { ...state.modal, preAgreementContext: { customerId, status: 'ERROR', warnings: [], history: [], error: error.code || 'WARNING_CONTEXT_UNAVAILABLE' } };
    render();
    toast(errorMessage('WARNING_CONTEXT_UNAVAILABLE'), 'error');
  }
}
async function submitFlow(action) { if (state.busy) return; setBusy(true); try { await action(); } catch (error) { toast(errorMessage(error.code), 'error'); } finally { setBusy(false); } }
async function refreshForView() { try { if (state.view === 'dashboard' || state.view === 'customers' || state.view === 'works') await loadDashboard(); if (state.view === 'financial') await loadFinancialWorkspace(); if (state.view === 's8') await loadS8Workspace(); if (state.view === 'catalogs') await loadCatalogs(); if (state.view === 'audit') { await loadAuditLog(); await loadAccountAdmin(); } render(); } catch (error) { toast(errorMessage(error.code), 'error'); } }
async function openCustomer(customerId) { try { state.selectedCustomer = null; state.view = 'customer'; render(); const [customer, works, history, warnings] = await Promise.all([api(`/api/customers/${encodeURIComponent(customerId)}`), api(`/api/works${queryString({ customer_id: customerId })}`), api(`/api/customers/${encodeURIComponent(customerId)}/history`), api(`/api/customers/${encodeURIComponent(customerId)}/warnings`)]); state.selectedCustomer = { ...customer, works, history, warnings }; render(); } catch (error) { toast(errorMessage(error.code), 'error'); state.view = 'customers'; render(); } }
async function refreshWorkAfterMutation(workId, successMessage) {
  const refreshed = await openWork(workId, { reason: 'post-mutation' });
  if (refreshed) toast(successMessage, '');
  return refreshed;
}
async function openWork(workId, { reason = 'navigation' } = {}) {
  try {
    state.selectedWork = null;
    state.view = 'work';
    render();
    const [work, similar, financials, events, titleHistory, statusHistory, archiveHistory, requests, payments, reversalRequests] = await Promise.all([
      api(`/api/works/${encodeURIComponent(workId)}`),
      api(`/api/works/${encodeURIComponent(workId)}/similar`),
      api(`/api/works/${encodeURIComponent(workId)}/financials`),
      api(`/api/works/${encodeURIComponent(workId)}/events`),
      api(`/api/works/${encodeURIComponent(workId)}/title-history`),
      api(`/api/works/${encodeURIComponent(workId)}/status-history`),
      api(`/api/works/${encodeURIComponent(workId)}/archive-history`),
      api(`/api/works/${encodeURIComponent(workId)}/requests`),
      api(`/api/works/${encodeURIComponent(workId)}/payments`),
      api(`/api/works/${encodeURIComponent(workId)}/payment-reversal-requests`)
    ]);
    state.selectedWork = {
      ...work,
      similar,
      financials,
      events,
      titleHistory,
      statusHistory,
      archiveHistory,
      requests,
      payments,
      reversalRequests
    };
    render();
    return true;
  } catch (error) {
    toast(errorMessage(reason === 'post-mutation' ? 'POST_MUTATION_REFRESH_FAILED' : error.code), 'error');
    state.view = 'works';
    render();
    return false;
  }
}

async function loadFinancialWorkspace(periodKey = state.financial.periodKey) {
  const period = String(periodKey || '').slice(0, 7);
  const [preview, snapshots, reopenRequests, transfers, subscriptions, expenses, participants] = await Promise.all([
    api(`/api/settlements/preview${queryString({ period_key: period })}`),
    api(`/api/settlements${queryString({ period_key: period })}`),
    api(`/api/settlements/${encodeURIComponent(period)}/reopen-requests`),
    api('/api/transfers'), api('/api/subscriptions'), api('/api/expenses'), api('/api/participants')
  ]);
  state.financial = { periodKey: period, preview, snapshots, reopenRequests, transfers, subscriptions, expenses, participants };
  return state.financial;
}
async function refreshFinancialAfterMutation(message) {
  try { await loadFinancialWorkspace(); render(); toast(message, ''); return true; }
  catch { toast(errorMessage('POST_MUTATION_REFRESH_FAILED'), 'error'); return false; }
}
function requiredIso(value) { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null; }
async function submitPayment(event) {
  event.preventDefault(); const values = formObject(event.currentTarget); const effectiveAt = requiredIso(values.effective_at);
  if (!effectiveAt) { toast(errorMessage('EVENT_TIME_INVALID'), 'error'); return; }
  if (!(await confirmSensitive('تسجيل دفعة فعلية', `المبلغ المطلوب ${values.amount_riyals} ريال؛ المتبقي قبل التسجيل ${moneyLabel(state.selectedWork.financials?.remaining_halalas)}`))) return;
  await submitFlow(async () => { await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/payments`, { method: 'POST', body: { version: state.selectedWork.version, amount_riyals: values.amount_riyals, effective_at: effectiveAt, payment_method: values.payment_method, received_by: values.received_by, note: nullable(values.note) } }); await refreshWorkAfterMutation(state.selectedWork.id, 'تم تسجيل الدفعة وتحديث التحصيل.'); });
}
async function submitPaymentReversalRequest(event) {
  event.preventDefault(); const values = formObject(event.currentTarget);
  if (!(await confirmSensitive('طلب تصحيح أو إلغاء دفعة', 'يبقى التحصيل الحالي كما هو حتى اعتماد الحساب الآخر'))) return;
  await submitFlow(async () => { await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/payment-reversal-requests`, { method: 'POST', body: { version: state.selectedWork.version, payment_id: values.payment_id, reason: values.reason } }); state.modal = null; await refreshWorkAfterMutation(state.selectedWork.id, 'تم تقديم طلب التصحيح؛ لا يتغير التحصيل قبل اعتماد الحساب الآخر.'); });
}
async function handleApprovePaymentReversal(requestIdToApprove) {
  if (!(await confirmSensitive('اعتماد تصحيح دفعة', 'سيُضاف قيد عكسي مستقل وتُعاد قراءة حالة التحصيل'))) return;
  await submitFlow(async () => { await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/payment-reversal-requests/${encodeURIComponent(requestIdToApprove)}/approve`, { method: 'POST', body: {} }); await refreshWorkAfterMutation(state.selectedWork.id, 'تم اعتماد التصحيح وإعادة جلب سجل التحصيل.'); });
}
async function submitTransfer(event) {
  event.preventDefault(); const values = formObject(event.currentTarget); const effectiveAt = requiredIso(values.effective_at);
  if (!effectiveAt) { toast(errorMessage('EVENT_TIME_INVALID'), 'error'); return; }
  if (!(await confirmSensitive('تسجيل تحويل بين الطرفين', `المبلغ ${values.amount_riyals} ريال والرسوم ${values.fee_riyals} ريال؛ ستتغير معاينة التسوية`))) return;
  await submitFlow(async () => { await api('/api/transfers', { method: 'POST', body: { amount_riyals: values.amount_riyals, fee_riyals: values.fee_riyals, effective_at: effectiveAt, from_party: values.from_party, to_party: values.to_party, fee_payer: 'person_1' } }); await refreshFinancialAfterMutation('تم تسجيل التحويل وإعادة جلب معاينة التسوية.'); });
}
async function submitSubscription(event) {
  event.preventDefault(); const values = formObject(event.currentTarget); const effectiveAt = requiredIso(values.effective_at);
  if (!effectiveAt) { toast(errorMessage('EVENT_TIME_INVALID'), 'error'); return; }
  if (!(await confirmSensitive('تغيير حالة الاشتراك', `القيمة الإجمالية ${values.aggregate_amount_riyals} ريال؛ لا تتغير التسويات السابقة`))) return;
  await submitFlow(async () => { await api('/api/subscriptions', { method: 'POST', body: { state: values.state, aggregate_amount_riyals: values.aggregate_amount_riyals, effective_at: effectiveAt } }); await refreshFinancialAfterMutation('تم تسجيل تاريخ الاشتراك الفعّال وإعادة جلب المعاينة.'); });
}
async function submitExpense(event) {
  event.preventDefault(); const values = formObject(event.currentTarget); const effectiveAt = requiredIso(values.effective_at);
  if (!effectiveAt) { toast(errorMessage('EVENT_TIME_INVALID'), 'error'); return; }
  if (!(await confirmSensitive('تسجيل مصروف مشترك', `المبلغ ${values.amount_riyals} ريال؛ قد يبقى الإقفال محجوبًا بلا قاعدة توزيع معتمدة`))) return;
  await submitFlow(async () => { await api('/api/expenses', { method: 'POST', body: { amount_riyals: values.amount_riyals, category: values.category, paid_by_uid: values.paid_by_uid, effective_at: effectiveAt } }); await refreshFinancialAfterMutation('تم حفظ المصروف كسجل واقعي؛ قد يبقى الإقفال محجوبًا بلا قاعدة توزيع معتمدة.'); });
}
async function submitSettlementPeriod(event) {
  event.preventDefault(); const period = String(formObject(event.currentTarget).period_key || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) { toast('اختر شهرًا صالحًا.', 'error'); return; }
  await submitFlow(async () => { await loadFinancialWorkspace(period); render(); });
}
async function submitSettlementClose(event) {
  event.preventDefault(); const period = state.financial.periodKey;
  if (!(await confirmSensitive('إقفال التسوية الشهرية', `الفترة ${period}؛ الرصيد النهائي ${moneyLabel(state.financial.preview?.final_balance_halalas)}؛ ستُحفظ نسخة غير قابلة للتعديل العادي`))) return;
  await submitFlow(async () => { await api(`/api/settlements/${encodeURIComponent(period)}/close`, { method: 'POST', body: {} }); await refreshFinancialAfterMutation('تم إقفال نسخة التسوية وتحديث الحالة.'); });
}
async function submitSettlementReopen(event) {
  event.preventDefault(); const values = formObject(event.currentTarget); const period = state.financial.periodKey;
  if (!(await confirmSensitive('طلب إعادة فتح التسوية', `الفترة ${period}؛ تبقى مقفلة حتى اعتماد الحساب الآخر`))) return;
  await submitFlow(async () => { await api(`/api/settlements/${encodeURIComponent(period)}/reopen-requests`, { method: 'POST', body: { reason: values.reason } }); await refreshFinancialAfterMutation('تم تقديم طلب إعادة الفتح؛ ستبقى الفترة مقفلة حتى يعتمد الحساب الآخر الطلب.'); });
}
async function handleApproveSettlementReopen(reopenId) {
  const period = state.financial.periodKey;
  if (!(await confirmSensitive('اعتماد إعادة فتح التسوية', `الفترة ${period}؛ ستعود الفترة إلى حالة مفتوحة`))) return;
  await submitFlow(async () => { await api(`/api/settlements/${encodeURIComponent(period)}/reopen-requests/${encodeURIComponent(reopenId)}/approve`, { method: 'POST', body: {} }); await refreshFinancialAfterMutation('تم اعتماد إعادة الفتح وتحديث الحالة.'); });
}

async function submitEvent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  const parsed = new Date(values.effective_at);
  if (!Number.isFinite(parsed.getTime())) {
    toast(errorMessage('EVENT_TIME_INVALID'), 'error');
    return;
  }
  await submitFlow(async () => {
    await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/events`, {
      method: 'POST',
      body: {
        event_type: values.event_type,
        description: values.description,
        effective_at: parsed.toISOString()
      }
    });
    await refreshWorkAfterMutation(state.selectedWork.id, 'تم تسجيل الحدث بنجاح.');
  });
}

async function submitTitle(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  const version = state.selectedWork.version;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/title`, {
        method: 'POST',
        body: {
          version,
          new_title: values.new_title,
          reason: values.reason
        }
      });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم تحديث عنوان العمل والتاريخ بنجاح.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') {
        toast(errorMessage('VERSION_CONFLICT'), 'error');
        await openWork(state.selectedWork.id);
      } else {
        throw error;
      }
    }
  });
}

async function submitStatus(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  const version = state.selectedWork.version;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/status`, {
        method: 'POST',
        body: {
          version,
          status: values.status,
          reason: values.reason
        }
      });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم تحديث حالة التنفيذ بنجاح.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') {
        toast(errorMessage('VERSION_CONFLICT'), 'error');
        await openWork(state.selectedWork.id);
      } else {
        throw error;
      }
    }
  });
}

async function submitCancel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  const version = state.selectedWork.version;
  if (!(await confirmSensitive('تقديم طلب إلغاء العمل', `الحالة الحالية ${WORK_STATUS_LABELS[state.selectedWork.status] || state.selectedWork.status} ← ${WORK_STATUS_LABELS[values.target_execution_status] || values.target_execution_status}؛ يبقى السجل محفوظًا`))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/requests`, {
        method: 'POST',
        body: {
          version,
          action: 'CANCEL',
          reason: values.reason,
          target_execution_status: values.target_execution_status
        }
      });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم تقديم طلب الإلغاء، بانتظار موافقة الحساب الآخر.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') {
        toast(errorMessage('VERSION_CONFLICT'), 'error');
        await openWork(state.selectedWork.id);
      } else {
        throw error;
      }
    }
  });
}

async function submitArchive(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  const version = state.selectedWork.version;
  if (!(await confirmSensitive('تقديم طلب أرشفة العمل', 'سيبقى السجل محفوظًا وقابلًا للبحث التاريخي بعد الاعتماد'))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/requests`, {
        method: 'POST',
        body: {
          version,
          action: 'ARCHIVE',
          reason: values.reason
        }
      });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم تقديم طلب الأرشفة، بانتظار موافقة الحساب الآخر.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') {
        toast(errorMessage('VERSION_CONFLICT'), 'error');
        await openWork(state.selectedWork.id);
      } else {
        throw error;
      }
    }
  });
}

function optionalIsoDate(value) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
async function submitPriceChange(event) {
  event.preventDefault();
  const values = formObject(event.currentTarget);
  const effectiveAt = optionalIsoDate(values.effective_at);
  if (values.effective_at && !effectiveAt) { toast(errorMessage('EVENT_TIME_INVALID'), 'error'); return; }
  const version = state.selectedWork.version;
  if (!(await confirmSensitive('تقديم طلب حركة سعر', `السعر الحالي ${moneyLabel(state.selectedWork.financials?.current_price_halalas)}؛ لا يتغير قبل الاعتماد`))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/price-requests`, { method: 'POST', body: { version, movement_type: values.movement_type, amount_riyals: values.amount_riyals, reason: values.reason, ...(effectiveAt ? { effective_at: effectiveAt } : {}) } });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم تقديم طلب حركة السعر؛ لا يتغير السعر المعتمد قبل موافقة الحساب الآخر.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') { toast(errorMessage('VERSION_CONFLICT'), 'error'); await openWork(state.selectedWork.id); } else throw error;
    }
  });
}
async function submitRatioChange(event) {
  event.preventDefault();
  const values = formObject(event.currentTarget);
  const version = state.selectedWork.version;
  const person1Bps = Number(values.person_1_bps) <= 100 ? Math.round(Number(values.person_1_bps) * 100) : Number(values.person_1_bps);
  const person2Bps = Number(values.person_2_bps) <= 100 ? Math.round(Number(values.person_2_bps) * 100) : Number(values.person_2_bps);
  if (!Number.isFinite(person1Bps) || !Number.isFinite(person2Bps) || person1Bps < 0 || person2Bps < 0 || person1Bps + person2Bps !== 10000) { toast('يجب أن يساوي مجموع النسب 100%.', 'error'); return; }
  if (!(await confirmSensitive('تقديم طلب استثناء نسبة', 'تبقى النسبة الحالية حتى الاعتماد الثنائي'))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/ratio-requests`, { method: 'POST', body: { version, person_1_bps: person1Bps, person_2_bps: person2Bps, reason: values.reason } });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم تقديم طلب استثناء النسبة؛ لا تتغير النسبة قبل الموافقة الثنائية.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') { toast(errorMessage('VERSION_CONFLICT'), 'error'); await openWork(state.selectedWork.id); } else throw error;
    }
  });
}
async function handleApprovePriceRequest(reqId) {
  const request = state.selectedWork.financials?.price_requests?.find(item => item.id === reqId);
  if (!(await confirmSensitive('اعتماد حركة السعر', 'سيتم اعتماد طلب حركة السعر وتحديث السعر الحالي وفق الحركة المطلوبة.'))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/price-requests/${encodeURIComponent(reqId)}/approve`, { method: 'POST', body: {} });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم اعتماد حركة السعر وتحديث السعر.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') { toast(errorMessage('VERSION_CONFLICT'), 'error'); await openWork(state.selectedWork.id); } else throw error;
    }
  });
}
async function handleApproveRatioRequest(reqId) {
  const request = state.selectedWork.financials?.ratio_requests?.find(item => item.id === reqId);
  if (!(await confirmSensitive('اعتماد استثناء النسبة', 'ستُعاد قراءة الحصص المعتمدة بعد الموافقة'))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/ratio-requests/${encodeURIComponent(reqId)}/approve`, { method: 'POST', body: {} });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم اعتماد استثناء النسبة وتحديث الحصص.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') { toast(errorMessage('VERSION_CONFLICT'), 'error'); await openWork(state.selectedWork.id); } else throw error;
    }
  });
}

async function handleApproveRequest(reqId) {
  const request = state.selectedWork.requests?.find(item => item.id === reqId);
  if (!(await confirmSensitive(`اعتماد طلب ${request?.action === 'ARCHIVE' ? 'الأرشفة' : 'الإلغاء'}`, `الحالة الحالية ${WORK_STATUS_LABELS[state.selectedWork.status] || state.selectedWork.status}؛ يبقى السجل والتاريخ محفوظين`))) return;
  await submitFlow(async () => {
    try {
      await api(`/api/works/${encodeURIComponent(state.selectedWork.id)}/requests/${encodeURIComponent(reqId)}/approve`, {
        method: 'POST',
        body: {}
      });
      await refreshWorkAfterMutation(state.selectedWork.id, 'تم اعتماد الطلب وتطبيقه بنجاح بموجب الموافقة الثنائية.');
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT' || error.code === 'STALE_VERSION') {
        toast(errorMessage('VERSION_CONFLICT'), 'error');
        await openWork(state.selectedWork.id);
      } else {
        throw error;
      }
    }
  });
}

if (window.__PRIVATE_WORK_APP_TEST__) Object.assign(window.__PRIVATE_WORK_APP_TEST__, { getState: () => state, customerForm, workForm, workPage, financialPage, s8SearchPage, s8SearchRows, s8AnalyticsMarkup, s8AlertsMarkup, s8AlertSetting, s8FilterParams, s8ExportPath, fetchS8CompleteExport, submitS8Export, submitS8AlertSettings, loadS8Search, loadS8Analytics, loadS8Workspace, s8ApplySearch, customerForm, workForm, workPage, financialPage, financialMarkup, s7WorkFinancialMarkup, settlementPreviewMarkup, settlementPeriodState, nextSettlementMonth, softWarningsMarkup, softWarningLabel, openWork, authenticateExistingSession, openNewWork, refreshWorkCustomerContext, preAgreementCanSubmitNewWork, preAgreementContextMarkup, submitWork, errorMessage, submitEvent, submitTitle, submitStatus, submitCancel, submitArchive, submitPriceChange, submitRatioChange, handleApproveRequest, handleApprovePriceRequest, handleApproveRatioRequest, loadFinancialWorkspace, submitPayment, submitPaymentReversalRequest, handleApprovePaymentReversal, submitTransfer, submitSubscription, submitExpense, submitSettlementPeriod, submitSettlementClose, submitSettlementReopen, handleApproveSettlementReopen });
authenticateExistingSession();
