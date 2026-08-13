import * as XLSX from './vendor/xlsx-0.20.3.mjs';

const MONEY_FORMAT = '0.00';

function safeText(value) { return value === null || value === undefined ? '' : String(value); }
function textCell(value) { return { t: 's', v: safeText(value) }; }
function exactSarText(halalas) {
  const amount = BigInt(halalas); const negative = amount < 0n; const absolute = negative ? -amount : amount;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
function moneyCell(halalas) {
  if (halalas === null || halalas === undefined) return textCell('');
  const amount = Number(halalas); if (!Number.isSafeInteger(amount)) throw new Error('MONEY_OVERFLOW');
  const sar = amount / 100;
  return Number.isSafeInteger(Math.round(sar * 100)) && Math.round(sar * 100) === amount ? { t: 'n', v: sar, z: MONEY_FORMAT } : textCell(exactSarText(amount));
}
function countCell(value) { return { t: 'n', v: Number(value || 0), z: '0' }; }
function rowRange(columnCount, rowCount) {
  return XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: Math.max(0, columnCount - 1), r: Math.max(0, rowCount) } });
}
function appendSheet(workbook, name, headers, rows, widths = []) {
  const worksheet = XLSX.utils.aoa_to_sheet([headers.map(textCell), ...rows]);
  worksheet['!autofilter'] = { ref: rowRange(headers.length, rows.length) };
  worksheet['!cols'] = headers.map((_, index) => ({ wch: widths[index] || 18 }));
  XLSX.utils.book_append_sheet(workbook, worksheet, name);
}
function createWorkbook() {
  const workbook = XLSX.utils.book_new();
  workbook.Workbook = { Views: [{ RTL: true }] };
  workbook.Props = { Title: 'S8 Export', Subject: 'Authoritative synthetic export', Author: 'Private Work Management App', Company: 'Private Work Management App', Comments: 'No external links, macros, credentials, or active content.' };
  return workbook;
}
function workRow(work) {
  return [
    textCell(work.id), textCell(work.customer_name), textCell(work.title), textCell(work.status), textCell(work.work_type_key || 'UNSPECIFIED'),
    textCell(work.specialty_key || 'UNSPECIFIED'), textCell(work.country || 'UNSPECIFIED'), textCell(work.university || 'UNSPECIFIED'),
    textCell(work.created_at), textCell(work.confirmed_at || ''), textCell(work.is_archived ? 'مؤرشف' : 'نشط'),
    moneyCell(work.current_price_halalas), moneyCell(work.approved_paid_halalas), moneyCell(work.remaining_halalas), textCell(work.collection_status),
  ];
}
const WORK_HEADERS = ['معرف العمل', 'العميل', 'العنوان', 'الحالة', 'نوع العمل', 'التخصص', 'الدولة', 'الجامعة', 'تاريخ الإنشاء UTC', 'تاريخ التأكيد UTC', 'حالة الأرشفة', 'السعر SAR', 'المدفوع SAR', 'المتبقي SAR', 'حالة التحصيل'];
function classificationRows(groups) {
  return groups.map(row => [textCell(row.bucket), countCell(row.work_count), countCell(row.active_work_count), countCell(row.archived_work_count), countCell(row.price_unset_work_count), moneyCell(row.current_price_halalas), moneyCell(row.approved_paid_halalas), moneyCell(row.remaining_halalas)]);
}
const CLASSIFICATION_HEADERS = ['الفئة', 'عدد الأعمال', 'أعمال نشطة', 'أعمال مؤرشفة', 'سعر غير محدد', 'إجمالي السعر SAR', 'إجمالي المدفوع SAR', 'إجمالي المتبقي SAR'];

function buildWorkWorkbook(dto) {
  const workbook = createWorkbook(); const { work } = dto;
  appendSheet(workbook, 'ملخص العمل', ['المعرف', 'العميل', 'العنوان', 'الحالة', 'نوع العمل', 'التخصص', 'الدولة', 'الجامعة', 'تاريخ الإنشاء UTC', 'تاريخ التأكيد UTC', 'الأرشفة', 'السعر SAR', 'المدفوع SAR', 'المتبقي SAR', 'التحصيل'], [workRow(work)], [22, 24, 36, 20, 20, 20, 16, 24, 25, 25, 14, 14, 14, 14, 22]);
  appendSheet(workbook, 'سجل العناوين', ['المعرف', 'العنوان السابق', 'العنوان الجديد', 'السبب', 'التاريخ UTC', 'المسجل'], dto.title_history.map(row => [textCell(row.id), textCell(row.old_title), textCell(row.new_title), textCell(row.reason), textCell(row.changed_at), textCell(row.changed_by)]), [22, 32, 32, 28, 25, 22]);
  appendSheet(workbook, 'سجل الحالة', ['المعرف', 'الحالة السابقة', 'الحالة الجديدة', 'السبب', 'التاريخ UTC', 'المسجل'], dto.status_history.map(row => [textCell(row.id), textCell(row.old_status), textCell(row.new_status), textCell(row.reason), textCell(row.changed_at), textCell(row.changed_by)]), [22, 24, 24, 28, 25, 22]);
  appendSheet(workbook, 'متابعة', ['المعرف', 'نوع الحدث', 'الوصف', 'التاريخ الفعلي UTC', 'تاريخ التسجيل UTC', 'المسجل'], dto.events.map(row => [textCell(row.id), textCell(row.event_type), textCell(row.description), textCell(row.effective_at), textCell(row.created_at), textCell(row.actor_uid)]), [22, 20, 42, 25, 25, 22]);
  appendSheet(workbook, 'التحصيل', ['معرف الدفعة', 'المبلغ SAR', 'التاريخ الفعلي UTC', 'الطريقة', 'ملاحظة', 'المستلم', 'المسجل', 'معرف العكس', 'مبلغ العكس SAR', 'تاريخ العكس UTC'], dto.payments.map(row => [textCell(row.id), moneyCell(row.amount_halalas), textCell(row.effective_at), textCell(row.payment_method), textCell(row.note), textCell(row.received_by), textCell(row.recorded_by), textCell(row.reversal_id || ''), moneyCell(row.reversal_amount_halalas), textCell(row.reversal_approved_at || '')]), [22, 14, 25, 18, 30, 20, 20, 22, 16, 25]);
  return workbook;
}
function buildMonthWorkbook(dto) {
  const workbook = createWorkbook();
  appendSheet(workbook, 'أعمال الشهر', WORK_HEADERS, dto.works.map(workRow), [22, 24, 36, 20, 20, 20, 16, 24, 25, 25, 14, 14, 14, 14, 22]);
  appendSheet(workbook, 'التحصيل', ['معرف العمل', 'العنوان', 'حالة التحصيل', 'المدفوع SAR', 'المتبقي SAR'], dto.works.map(row => [textCell(row.id), textCell(row.title), textCell(row.collection_status), moneyCell(row.approved_paid_halalas), moneyCell(row.remaining_halalas)]), [22, 36, 22, 16, 16]);
  appendSheet(workbook, 'التسوية', ['المعرف', 'الفترة', 'الإصدار', 'الحالة', 'أساس الفترة', 'عدد الأعمال', 'قيمة الأعمال SAR', 'حصة الشخص 1 من الأعمال SAR', 'حصة الشخص 2 من الأعمال SAR', 'التحصيل المعتمد SAR', 'إجمالي التحويلات SAR (غير موقّع؛ لا يُستنتج منه الاتجاه)', 'صافي التحويل للشخص 2 SAR (غير محفوظ في snapshot)', 'رسوم التحويل SAR', 'الاشتراكات SAR', 'المصروفات المحكومة SAR', 'الرصيد السابق SAR', 'الرصيد النهائي SAR (الموجب: الشخص 1 مدين للشخص 2)', 'حالة عدم الحسم'], dto.settlement_snapshots.map(row => [textCell(row.id), textCell(row.period_key), countCell(row.version), textCell(row.state), textCell(row.period_basis), countCell(row.work_count), moneyCell(row.total_work_value_halalas), moneyCell(row.person_1_work_share_halalas), moneyCell(row.person_2_work_share_halalas), moneyCell(row.approved_receipts_halalas), moneyCell(row.transfer_amount_halalas), row.transfer_net_person_2_halalas === null ? textCell('غير متاح؛ غير محفوظ في snapshot') : moneyCell(row.transfer_net_person_2_halalas), moneyCell(row.transfer_fee_halalas), moneyCell(row.subscription_total_halalas), moneyCell(row.governed_expense_total_halalas), moneyCell(row.prior_balance_halalas), moneyCell(row.final_balance_halalas), textCell(row.unresolved_code || '')]), [22, 15, 12, 16, 20, 14, 18, 22, 22, 18, 40, 40, 18, 18, 22, 18, 40, 36]);
  return workbook;
}
function buildFollowUpWorkbook(dto) {
  const workbook = createWorkbook();
  appendSheet(workbook, 'سجل المتابعة', ['معرف الحدث', 'معرف العمل', 'العنوان', 'العميل', 'نوع الحدث', 'الوصف', 'التاريخ الفعلي UTC', 'تاريخ التسجيل UTC', 'المسجل', 'الأرشفة'], dto.events.map(row => [textCell(row.id), textCell(row.work_id), textCell(row.work_title), textCell(row.customer_name), textCell(row.event_type), textCell(row.description), textCell(row.effective_at), textCell(row.created_at), textCell(row.actor_uid), textCell(row.is_archived ? 'مؤرشف' : 'نشط')]), [22, 22, 36, 24, 20, 42, 25, 25, 22, 14]);
  return workbook;
}
function buildCustomerWorkbook(dto) {
  const workbook = createWorkbook();
  const totals = dto.totals || dto.page_totals;
  appendSheet(workbook, 'تقرير العميل', ['معرف العميل', 'الاسم', 'عدد الأعمال', 'أعمال نشطة', 'أعمال مؤرشفة', 'سعر غير محدد', 'إجمالي المدفوع SAR', 'إجمالي المتبقي SAR'], [[textCell(dto.customer.id), textCell(dto.customer.name), countCell(totals.work_count), countCell(totals.active_work_count), countCell(totals.archived_work_count), countCell(totals.price_unset_work_count), moneyCell(totals.approved_paid_halalas), moneyCell(totals.remaining_halalas)]], [22, 32, 18, 14, 16, 16, 24, 24]);
  appendSheet(workbook, 'أعمال العميل', WORK_HEADERS, dto.works.map(workRow), [22, 24, 36, 20, 20, 20, 16, 24, 25, 25, 14, 14, 14, 14, 22]);
  appendSheet(workbook, 'التحصيل', ['معرف العمل', 'العنوان', 'حالة التحصيل', 'المدفوع SAR', 'المتبقي SAR'], dto.works.map(row => [textCell(row.id), textCell(row.title), textCell(row.collection_status), moneyCell(row.approved_paid_halalas), moneyCell(row.remaining_halalas)]), [22, 36, 22, 16, 16]);
  appendSheet(workbook, 'التحذيرات', ['معرف الحقيقة', 'معرف العمل', 'نوع التحذير', 'المرجع', 'التاريخ UTC', 'التفاصيل'], dto.warnings.map(row => [textCell(row.fact_id), textCell(row.work_id || ''), textCell(row.warning_type), textCell(row.source_ref), textCell(row.happened_at), textCell(row.details_json)]), [22, 22, 20, 28, 25, 42]);
  return workbook;
}
function buildClassificationWorkbook(dto) {
  const workbook = createWorkbook();
  const sheets = [['WORK_TYPE', 'حسب النوع'], ['SPECIALTY', 'حسب التخصص'], ['COUNTRY', 'حسب الدولة'], ['UNIVERSITY', 'حسب الجامعة'], ['PERIOD', 'حسب الفترة']];
  for (const [key, name] of sheets) appendSheet(workbook, name, CLASSIFICATION_HEADERS, classificationRows(dto.groups[key] || []), [28, 16, 16, 16, 16, 20, 20, 20]);
  return workbook;
}
function normalizeExportType(value) {
  const type = String(value || '').toUpperCase();
  if (!['WORK', 'MONTH', 'FOLLOW_UP', 'CUSTOMER', 'CLASSIFICATION'].includes(type)) throw new Error('S8_EXPORT_TYPE_INVALID');
  return type;
}
export function safeS8ExportFilename(type, identifier = '') {
  const safe = String(identifier || '').normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
  return `s8-${normalizeExportType(type).toLowerCase()}-${safe}.xlsx`;
}
export function generateS8Workbook(dto) {
  const type = normalizeExportType(dto?.export_type);
  const workbook = type === 'WORK' ? buildWorkWorkbook(dto)
    : type === 'MONTH' ? buildMonthWorkbook(dto)
      : type === 'FOLLOW_UP' ? buildFollowUpWorkbook(dto)
        : type === 'CUSTOMER' ? buildCustomerWorkbook(dto)
          : buildClassificationWorkbook(dto);
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', bookSST: true, compression: true }));
}
export function parseS8Workbook(bytes) { return XLSX.read(bytes, { type: 'array', cellStyles: true, cellNF: true }); }
