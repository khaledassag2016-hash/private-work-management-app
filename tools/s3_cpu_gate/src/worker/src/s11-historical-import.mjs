import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import XLSX from '../assets/vendor/xlsx-0.20.3.mjs';

export const RECORD_TYPES = Object.freeze([
  'WORK',
  'CUSTOMER',
  'PRICE_OR_PRICE_MOVEMENT',
  'PAYMENT_OR_RECEIPT',
  'FOLLOW_UP_EVENT',
  'HISTORICAL_SETTLEMENT',
  'OPENING_HISTORICAL_BALANCE',
  'SUBSCRIPTION_EXPENSE',
  'TRANSFER_FEE',
  'OTHER_GOVERNED_EXPENSE',
  'TOTAL_OR_SUMMARY_ROW',
  'FREE_NOTE',
  'UNKNOWN',
]);

export const REVIEW_STATUSES = Object.freeze([
  'CONFIRMED',
  'PENDING_REVIEW',
  'UNKNOWN',
  'NOT_APPLICABLE',
  'REJECTED',
]);

const IMPORT_DECISIONS = new Set(['ACCEPTED', 'REJECTED', 'PENDING_REVIEW', 'UNKNOWN']);
const DATE_COMPLETENESS = new Set(['COMPLETE_DAY', 'COMPLETE_MONTH', 'YEAR_ONLY', 'MISSING_YEAR', 'MISSING']);
const CUSTOMER_MAPPING = new Set(['CONFIRMED', 'PENDING_REVIEW', 'UNKNOWN', 'NOT_APPLICABLE']);
const ZERO_PRICE_REASONS = new Set([
  'FREE',
  'INCLUDED_IN_LARGER_AGREEMENT',
  'PRICE_UNSET',
  'REFUSED_PAYMENT',
  'SOURCE_ERROR',
  'OTHER_REVIEWED_REASON',
]);

const WORK_HEADERS = [
  'ID_مؤقت', 'معرف_العميل_يدوي', 'حالة_معرف_العميل', 'النص_الأصلي_للعمل', 'العنوان_المنظم',
  'حالة_العنوان', 'نوع_العمل', 'حالة_نوع_العمل', 'التخصص', 'حالة_التخصص', 'المادة_او_رمز_المقرر',
  'حالة_المادة', 'الجامعة', 'حالة_الجامعة', 'الدولة', 'حالة_الدولة', 'العلاقة', 'حالة_العلاقة',
  'الكمية', 'حالة_الكمية', 'السعر_النهائي_ريال', 'حالة_السعر', 'تاريخ_الاتفاق', 'حالة_تاريخ_الاتفاق',
  'تاريخ_الإنجاز_والتسليم', 'حالة_تاريخ_التسليم', 'حالة_العمل', 'حالة_حقل_العمل',
  'المدفوع_حتى_2026_08_13', 'حالة_الدفع', 'المصدر', 'حالة_مراجعة_السجل', 'جاهزية_الاستيراد', 'ملاحظات_تحضيرية',
];

const FINANCIAL_HEADERS = [
  'ID_مالي', 'الفئة', 'الوصف', 'شهر_التسوية', 'المبلغ_الأصلي_ريال', 'الدافع', 'المستفيد_او_المعنى',
  'قاعدة_المعالجة', 'الأثر_على_مستحق_الشخص2_ريال', 'حالة_الحقيقة', 'المصدر', 'جاهزية_الاستيراد',
];

const isoNow = (now = new Date()) => new Date(now).toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, Object.keys(value).sort());
const asText = (value) => (value === null || value === undefined ? '' : String(value));

function normalizedDateText(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return asText(value).trim();
}

function mapRows(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  return rows.map((row) => row.map((value) => (value === undefined ? null : value)));
}

function findHeaderRow(rows, firstHeader) {
  return rows.findIndex((row) => row.includes(firstHeader));
}

function rowToObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? null]));
}

function normalizeMoneyHalalas(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const raw = asText(value).trim().replace(/[,،]/g, '').replace(/ر\.س|SAR/gi, '').trim();
  const match = raw.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`${fieldName} must be an exact decimal SAR string`);
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || '').padEnd(2, '0') || '0');
  const halalas = sign * (whole * 100n + fraction);
  const number = Number(halalas);
  if (!Number.isSafeInteger(number)) throw new Error(`${fieldName} exceeds safe integer range`);
  return number;
}

function dateCompleteness(dateText) {
  const text = asText(dateText).trim();
  if (!text) return 'MISSING';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{4}\/\d{2}\/\d{2}$/.test(text)) return 'COMPLETE_DAY';
  if (/^\d{4}-\d{2}$/.test(text) || /^\d{4}\/\d{2}$/.test(text)) return 'COMPLETE_MONTH';
  if (/^\d{4}$/.test(text)) return 'YEAR_ONLY';
  if (/^\d{1,2}[/-]\d{1,2}$/.test(text) || /أغسطس|يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|سبتمبر|أكتوبر|نوفمبر|ديسمبر/.test(text)) return 'MISSING_YEAR';
  return 'MISSING_YEAR';
}

function classifyFinancialCategory(category) {
  const value = asText(category).trim();
  if (value === 'AUGUST_WORK_SHARE') return 'HISTORICAL_SETTLEMENT';
  if (value === 'SUBSCRIPTION') return 'SUBSCRIPTION_EXPENSE';
  if (value === 'TRANSFER_FEE') return 'TRANSFER_FEE';
  if (value === 'LEGACY_OPENING_BALANCE_CANDIDATE') return 'OPENING_HISTORICAL_BALANCE';
  if (value === 'CLIENT_RECEIPTS_SNAPSHOT') return 'PAYMENT_OR_RECEIPT';
  return 'OTHER_GOVERNED_EXPENSE';
}

function statusForPreparedRow(sourceReview, importReadiness, customerMapping) {
  if (sourceReview === 'REJECTED') return 'REJECTED';
  if (importReadiness === 'PENDING_REVIEW' || importReadiness === 'UNKNOWN') return importReadiness;
  if (customerMapping === 'UNKNOWN' || customerMapping === 'PENDING_REVIEW') return 'PENDING_REVIEW';
  return sourceReview || 'UNKNOWN';
}

function decisionForRecord(record) {
  const reasons = [];
  if (!record.originalText) return { importDecision: 'REJECTED', decisionReason: 'original source text is missing' };
  if (record.dateCompleteness === 'MISSING_YEAR') reasons.push('date year is missing');
  if (record.dateCompleteness === 'MISSING') reasons.push('date is missing');
  if (record.recordType === 'WORK' && record.customerMappingStatus !== 'CONFIRMED') reasons.push('customer mapping is unresolved');
  if (record.financialAmountHalalas !== null && record.financialAmountHalalas !== 0 && record.financialActivationState !== 'APPROVED') reasons.push('financial activation is not explicitly approved');
  if (record.financialAmountHalalas === 0 && record.zeroPriceReason === null && ['WORK', 'PRICE_OR_PRICE_MOVEMENT'].includes(record.recordType)) reasons.push('zero price has no explicit reason');
  if (record.reviewStatus === 'REJECTED') return { importDecision: 'REJECTED', decisionReason: 'source preparation marks the row rejected' };
  if (record.reviewStatus === 'UNKNOWN') reasons.push('source review is unknown');
  if (record.reviewStatus === 'PENDING_REVIEW') reasons.push('source row remains pending review');
  if (reasons.length > 0) return { importDecision: 'PENDING_REVIEW', decisionReason: reasons.join('; ') };
  return { importDecision: 'ACCEPTED', decisionReason: 'prepared record satisfies deterministic S11 rules' };
}

export function normalizeRecord(input) {
  const recordType = asText(input.recordType).trim() || 'UNKNOWN';
  if (!RECORD_TYPES.includes(recordType)) throw new Error(`unsupported record type: ${recordType}`);
  const reviewStatus = asText(input.reviewStatus).trim() || 'UNKNOWN';
  if (!REVIEW_STATUSES.includes(reviewStatus)) throw new Error(`unsupported review status: ${reviewStatus}`);
  const customerMappingStatus = asText(input.customerMappingStatus).trim() || 'NOT_APPLICABLE';
  if (!CUSTOMER_MAPPING.has(customerMappingStatus)) throw new Error(`unsupported customer mapping status: ${customerMappingStatus}`);
  const financialAmountHalalas = input.financialAmountHalalas === null || input.financialAmountHalalas === undefined
    ? null
    : Number(input.financialAmountHalalas);
  if (financialAmountHalalas !== null && (!Number.isSafeInteger(financialAmountHalalas))) throw new Error('financial amount must be an integer halala amount');
  const zeroPriceReason = input.zeroPriceReason ? asText(input.zeroPriceReason).trim() : null;
  if (zeroPriceReason !== null && !ZERO_PRICE_REASONS.has(zeroPriceReason)) throw new Error(`unsupported zero price reason: ${zeroPriceReason}`);
  const record = {
    sourceRecordId: asText(input.sourceRecordId).trim(),
    sourceContainer: asText(input.sourceContainer).trim(),
    sourceLocation: asText(input.sourceLocation).trim(),
    originalText: asText(input.originalText),
    normalized: input.normalized ?? {},
    recordType,
    reviewStatus,
    sourceReviewStatus: input.sourceReviewStatus ?? reviewStatus,
    importReadiness: input.importReadiness ?? reviewStatus,
    reviewerUid: input.reviewerUid ?? null,
    reviewedAt: input.reviewedAt ?? null,
    dateText: input.dateText === null || input.dateText === undefined ? null : normalizedDateText(input.dateText),
    dateCompleteness: input.dateCompleteness ?? dateCompleteness(normalizedDateText(input.dateText)),
    uncertaintyFlags: [...new Set(input.uncertaintyFlags ?? [])].sort(),
    customerMappingStatus,
    financialAmountHalalas,
    financialActivationState: input.financialActivationState ?? (financialAmountHalalas === null || financialAmountHalalas === 0 ? 'NONE' : 'PENDING_REVIEW'),
    zeroPriceReason,
    importDecision: input.importDecision ?? null,
    decisionReason: input.decisionReason ?? null,
  };
  if (!record.sourceRecordId || !record.sourceContainer || !record.sourceLocation) throw new Error('source identity is required');
  if (!DATE_COMPLETENESS.has(record.dateCompleteness)) throw new Error(`unsupported date completeness: ${record.dateCompleteness}`);
  if (!['NONE', 'PENDING_REVIEW', 'APPROVED', 'REVOKED'].includes(record.financialActivationState)) throw new Error('unsupported financial activation state');
  const decision = decisionForRecord(record);
  record.importDecision = decision.importDecision;
  record.decisionReason = decision.decisionReason;
  return Object.freeze(record);
}

export function parsePreparationWorkbook(buffer, { sourceStoreId, sourceStoreSha256 }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('preparation store must be supplied as a Buffer');
  if (!sourceStoreSha256 || !/^[a-f0-9]{64}$/.test(sourceStoreSha256)) throw new Error('source store SHA-256 is required');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true, bookVBA: false });
  const workRows = mapRows(workbook.Sheets['الأعمال']);
  const workHeaderIndex = findHeaderRow(workRows, 'ID_مؤقت');
  if (workHeaderIndex < 0) throw new Error('preparation store is missing the الأعمال table');
  const workHeaders = workRows[workHeaderIndex];
  const records = [];
  for (let i = workHeaderIndex + 1; i < workRows.length; i += 1) {
    const row = rowToObject(workHeaders, workRows[i]);
    if (!asText(row.ID_مؤقت).trim()) continue;
    const price = normalizeMoneyHalalas(row['السعر_النهائي_ريال'], 'work price');
    const status = statusForPreparedRow(row['حالة_مراجعة_السجل'], row['جاهزية_الاستيراد'], row['حالة_معرف_العميل']);
    records.push(normalizeRecord({
      sourceRecordId: row.ID_مؤقت,
      sourceContainer: 'الأعمال',
      sourceLocation: `الأعمال!A${i + 1}`,
      originalText: row['النص_الأصلي_للعمل'],
      normalized: {
        title: row['العنوان_المنظم'],
        workType: row['نوع_العمل'],
        country: row['الدولة'],
        quantity: row['الكمية'],
        priceHalalas: price,
        agreementDateText: row['تاريخ_الاتفاق'],
        deliveryDateText: row['تاريخ_الإنجاز_والتسليم'],
        status: row['حالة_العمل'],
        sourceId: row['المصدر'],
      },
      recordType: 'WORK',
      reviewStatus: status,
      sourceReviewStatus: row['حالة_مراجعة_السجل'],
      importReadiness: row['جاهزية_الاستيراد'],
      dateText: row['تاريخ_الإنجاز_والتسليم'],
      customerMappingStatus: row['حالة_معرف_العميل'] === 'CONFIRMED' ? 'CONFIRMED' : 'UNKNOWN',
      financialAmountHalalas: price,
      uncertaintyFlags: [
        row['حالة_نوع_العمل'] !== 'CONFIRMED' ? 'WORK_TYPE_UNCONFIRMED' : null,
        row['حالة_التخصص'] !== 'CONFIRMED' ? 'SPECIALTY_UNCONFIRMED' : null,
        row['حالة_المادة'] !== 'CONFIRMED' ? 'SUBJECT_UNCONFIRMED' : null,
        row['حالة_الجامعة'] !== 'CONFIRMED' ? 'UNIVERSITY_UNCONFIRMED' : null,
        row['حالة_معرف_العميل'] !== 'CONFIRMED' ? 'CUSTOMER_MAPPING_UNRESOLVED' : null,
      ].filter(Boolean),
    }));
  }

  const financialRows = mapRows(workbook.Sheets['مالية_أغسطس']);
  const financialHeaderIndex = findHeaderRow(financialRows, 'ID_مالي');
  if (financialHeaderIndex < 0) throw new Error('preparation store is missing the مالية_أغسطس table');
  const financialHeaders = financialRows[financialHeaderIndex];
  for (let i = financialHeaderIndex + 1; i < financialRows.length; i += 1) {
    const row = rowToObject(financialHeaders, financialRows[i]);
    if (!/^FIN-[A-Z0-9-]+$/.test(asText(row.ID_مالي).trim())) continue;
    const amount = normalizeMoneyHalalas(row['المبلغ_الأصلي_ريال'], 'financial amount');
    const effect = normalizeMoneyHalalas(row['الأثر_على_مستحق_الشخص2_ريال'], 'financial effect');
    const recordType = classifyFinancialCategory(row['الفئة']);
    const readiness = asText(row['جاهزية_الاستيراد']).trim() || 'PENDING_REVIEW';
    const reviewStatus = readiness === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : readiness;
    records.push(normalizeRecord({
      sourceRecordId: row.ID_مالي,
      sourceContainer: 'مالية_أغسطس',
      sourceLocation: `مالية_أغسطس!A${i + 1}`,
      originalText: row['الوصف'],
      normalized: {
        category: row['الفئة'],
        month: row['شهر_التسوية'],
        amountHalalas: amount,
        payer: row['الدافع'],
        meaning: row['المستفيد_او_المعنى'],
        rule: row['قاعدة_المعالجة'],
        preparedEffectHalalas: effect,
        sourceId: row['المصدر'],
      },
      recordType,
      reviewStatus,
      sourceReviewStatus: row['حالة_الحقيقة'],
      importReadiness: readiness,
      dateText: row['شهر_التسوية'],
      dateCompleteness: 'COMPLETE_MONTH',
      customerMappingStatus: 'NOT_APPLICABLE',
      financialAmountHalalas: amount,
      financialActivationState: amount && amount !== 0 ? 'PENDING_REVIEW' : 'NONE',
      uncertaintyFlags: readiness === 'PENDING_REVIEW' ? ['FINANCIAL_IMPORT_REVIEW_REQUIRED'] : [],
    }));
  }
  return buildPlan(records, { sourceStoreId, sourceStoreSha256 });
}

export function buildPlan(records, { sourceStoreId, sourceStoreSha256, now = '2026-08-13T00:00:00.000Z' }) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('S11 plan must contain records');
  const normalized = records.map((record) => (Object.isFrozen(record) ? record : normalizeRecord(record))).sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));
  const ids = new Set();
  for (const record of normalized) {
    if (ids.has(record.sourceRecordId)) throw new Error(`duplicate source record in plan: ${record.sourceRecordId}`);
    ids.add(record.sourceRecordId);
  }
  const payload = normalized.map((record) => ({
    sourceRecordId: record.sourceRecordId,
    sourceContainer: record.sourceContainer,
    sourceLocation: record.sourceLocation,
    originalText: record.originalText,
    normalized: record.normalized,
    recordType: record.recordType,
    reviewStatus: record.reviewStatus,
    sourceReviewStatus: record.sourceReviewStatus,
    importReadiness: record.importReadiness,
    dateText: record.dateText,
    dateCompleteness: record.dateCompleteness,
    uncertaintyFlags: record.uncertaintyFlags,
    customerMappingStatus: record.customerMappingStatus,
    financialAmountHalalas: record.financialAmountHalalas,
    financialActivationState: record.financialActivationState,
    zeroPriceReason: record.zeroPriceReason,
    importDecision: record.importDecision,
    decisionReason: record.decisionReason,
  }));
  return Object.freeze({
    sourceStoreId: sourceStoreId || 'S11_PRIVATE_PREPARATION_STORE',
    sourceStoreSha256,
    generatedAt: now,
    records: Object.freeze(normalized),
    planSha256: sha256(JSON.stringify(payload)),
  });
}

function reportFor(plan) {
  const counts = { ACCEPTED: 0, REJECTED: 0, PENDING_REVIEW: 0, UNKNOWN: 0 };
  const byType = {};
  const unresolvedCustomerMappings = [];
  const incompleteDates = [];
  const zeroPriceWithoutReason = [];
  const financialNonOperational = [];
  const duplicates = [];
  for (const record of plan.records) {
    counts[record.importDecision] += 1;
    byType[record.recordType] = (byType[record.recordType] || 0) + 1;
    if (record.customerMappingStatus !== 'CONFIRMED' && record.customerMappingStatus !== 'NOT_APPLICABLE') unresolvedCustomerMappings.push(record.sourceRecordId);
    if (!['COMPLETE_DAY', 'COMPLETE_MONTH', 'YEAR_ONLY'].includes(record.dateCompleteness)) incompleteDates.push(record.sourceRecordId);
    if ((record.financialAmountHalalas === 0) && !record.zeroPriceReason && record.recordType === 'WORK') zeroPriceWithoutReason.push(record.sourceRecordId);
    if (record.financialAmountHalalas !== null && record.financialActivationState !== 'APPROVED') financialNonOperational.push(record.sourceRecordId);
  }
  return {
    planSha256: plan.planSha256,
    total: plan.records.length,
    counts,
    byType,
    unresolvedCustomerMappings,
    incompleteDates,
    zeroPriceWithoutReason,
    financialNonOperational,
    duplicates,
    plannedLinks: plan.records.map((record) => ({ sourceRecordId: record.sourceRecordId, recordType: record.recordType, link: record.customerMappingStatus === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING_REVIEW' })),
    operationalEffectHalalas: plan.records.reduce((sum, record) => sum + (record.financialActivationState === 'APPROVED' ? record.financialAmountHalalas || 0 : 0), 0),
  };
}

export function dryRun(plan) {
  return Object.freeze({ mode: 'DRY_RUN', mutatesAuthoritativeData: false, report: reportFor(plan) });
}

function runInTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function importPlan(db, plan, { batchKey, actorUid = 's11-manus', now = plan.generatedAt, approvals = {} } = {}) {
  if (!batchKey) throw new Error('batchKey is required');
  return runInTransaction(db, () => {
    const existing = db.prepare('SELECT id, plan_sha256, status FROM s11_import_batches WHERE source_store_sha256 = ? AND batch_key = ?').get(plan.sourceStoreSha256, batchKey);
    if (existing) {
      if (existing.plan_sha256 !== plan.planSha256) throw new Error('same batch key has a conflicting plan');
      db.prepare('INSERT INTO s11_import_events(batch_id, record_id, event_type, actor_uid, occurred_at, details_json) VALUES (?, NULL, ?, ?, ?, ?)').run(existing.id, 'DUPLICATE_REPLAY', actorUid, isoNow(now), JSON.stringify({ batchKey, status: existing.status }));
      return { mode: 'IMPORT', idempotentReplay: true, batchId: existing.id, report: reportFromDb(db, existing.id) };
    }
    const batchId = `s11-${sha256(`${plan.sourceStoreSha256}:${batchKey}`).slice(0, 24)}`;
    db.prepare('INSERT INTO s11_import_batches(id, source_store_id, source_store_sha256, batch_key, mode, status, plan_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(batchId, plan.sourceStoreId, plan.sourceStoreSha256, batchKey, 'IMPORT', 'IMPORTED', plan.planSha256, isoNow(now));
    const findSource = db.prepare('SELECT id, source_store_sha256 FROM s11_historical_records WHERE source_record_id = ? LIMIT 1');
    const insertRecord = db.prepare(`INSERT INTO s11_historical_records(
      id, batch_id, source_store_sha256, source_record_id, source_container, source_location, original_text,
      normalized_json, record_type, review_status, import_decision, decision_reason, reviewer_uid, reviewed_at,
      date_completeness, uncertainty_flags_json, customer_mapping_status, financial_amount_halalas,
      financial_activation_state, operational_effect_halalas, is_active, staged_at, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
    const insertActivation = db.prepare('INSERT INTO s11_financial_activations(id, record_id, batch_id, amount_halalas, approved_by, approved_at, approval_reason, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertEvent = db.prepare('INSERT INTO s11_import_events(batch_id, record_id, event_type, actor_uid, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?)');
    for (const record of plan.records) {
      const conflict = findSource.get(record.sourceRecordId);
      if (conflict && conflict.source_store_sha256 !== plan.sourceStoreSha256) {
        insertEvent.run(batchId, null, 'SOURCE_CONFLICT', actorUid, isoNow(now), JSON.stringify({ sourceRecordId: record.sourceRecordId, existingStoreSha256: conflict.source_store_sha256 }));
        throw new Error(`source record conflict: ${record.sourceRecordId}`);
      }
      const approval = approvals[record.sourceRecordId];
      const approved = approval && record.financialAmountHalalas !== null && record.reviewStatus === 'CONFIRMED' && record.importDecision !== 'REJECTED';
      const activationState = approved ? 'APPROVED' : record.financialActivationState;
      const operationalEffect = approved ? record.financialAmountHalalas : 0;
      const storedDecision = approved ? 'ACCEPTED' : record.importDecision;
      const storedReason = approved ? `explicit approval: ${approval.reason}` : record.decisionReason;
      const recordId = `s11-record-${sha256(`${plan.sourceStoreSha256}:${record.sourceRecordId}`).slice(0, 24)}`;
      insertRecord.run(
        recordId, batchId, plan.sourceStoreSha256, record.sourceRecordId, record.sourceContainer, record.sourceLocation,
        record.originalText, JSON.stringify(record.normalized), record.recordType, record.reviewStatus,
        storedDecision, storedReason, record.reviewerUid, record.reviewedAt, record.dateCompleteness,
        JSON.stringify(record.uncertaintyFlags), record.customerMappingStatus, record.financialAmountHalalas,
        activationState, operationalEffect, isoNow(now), isoNow(now),
      );
      if (approved) {
        insertActivation.run(`s11-activation-${recordId}`, recordId, batchId, record.financialAmountHalalas, approval.approvedBy, approval.approvedAt, approval.reason, 'APPROVED');
        insertEvent.run(batchId, recordId, 'FINANCIAL_ACTIVATION_APPROVED', actorUid, isoNow(now), JSON.stringify({ approvedBy: approval.approvedBy, amountHalalas: record.financialAmountHalalas }));
      }
      insertEvent.run(batchId, recordId, 'STAGED', actorUid, isoNow(now), JSON.stringify({ decision: storedDecision, operationalEffectHalalas: operationalEffect }));
      insertEvent.run(batchId, recordId, 'IMPORTED', actorUid, isoNow(now), JSON.stringify({ recordType: record.recordType }));
    }
    db.prepare('UPDATE s11_import_batches SET finalized_at = ? WHERE id = ?').run(isoNow(now), batchId);
    return { mode: 'IMPORT', idempotentReplay: false, batchId, report: reportFromDb(db, batchId) };
  });
}

function reportFromDb(db, batchId) {
  const records = db.prepare('SELECT import_decision, record_type, customer_mapping_status, date_completeness, financial_amount_halalas, financial_activation_state, source_record_id FROM s11_historical_records WHERE batch_id = ? ORDER BY source_record_id').all(batchId);
  const counts = { ACCEPTED: 0, REJECTED: 0, PENDING_REVIEW: 0, UNKNOWN: 0 };
  const byType = {};
  const unresolvedCustomerMappings = [];
  const incompleteDates = [];
  const financialNonOperational = [];
  for (const row of records) {
    counts[row.import_decision] += 1;
    byType[row.record_type] = (byType[row.record_type] || 0) + 1;
    if (!['CONFIRMED', 'NOT_APPLICABLE'].includes(row.customer_mapping_status)) unresolvedCustomerMappings.push(row.source_record_id);
    if (!['COMPLETE_DAY', 'COMPLETE_MONTH', 'YEAR_ONLY'].includes(row.date_completeness)) incompleteDates.push(row.source_record_id);
    if (row.financial_amount_halalas !== null && row.financial_activation_state !== 'APPROVED') financialNonOperational.push(row.source_record_id);
  }
  return { total: records.length, counts, byType, unresolvedCustomerMappings, incompleteDates, financialNonOperational, operationalEffectHalalas: records.reduce((sum, row) => sum + (row.financial_activation_state === 'APPROVED' ? row.financial_amount_halalas || 0 : 0), 0) };
}

export function deactivateBatch(db, batchId, { actorUid = 's11-manus', now = new Date() } = {}) {
  return runInTransaction(db, () => {
    const batch = db.prepare('SELECT id, status FROM s11_import_batches WHERE id = ?').get(batchId);
    if (!batch) throw new Error('unknown S11 batch');
    if (batch.status === 'DEACTIVATED') return { deactivated: false, batchId, reason: 'already deactivated' };
    const timestamp = isoNow(now);
    db.prepare('UPDATE s11_historical_records SET is_active = 0, deactivated_at = ?, operational_effect_halalas = 0, financial_activation_state = CASE WHEN financial_activation_state = \'APPROVED\' THEN \'REVOKED\' ELSE financial_activation_state END WHERE batch_id = ?').run(timestamp, batchId);
    db.prepare('UPDATE s11_financial_activations SET state = \'REVOKED\' WHERE batch_id = ? AND state = \'APPROVED\'').run(batchId);
    db.prepare('UPDATE s11_import_batches SET status = \'DEACTIVATED\', deactivated_at = ? WHERE id = ?').run(timestamp, batchId);
    db.prepare('INSERT INTO s11_import_events(batch_id, record_id, event_type, actor_uid, occurred_at, details_json) VALUES (?, NULL, ?, ?, ?, ?)').run(batchId, 'BATCH_DEACTIVATED', actorUid, timestamp, JSON.stringify({ reason: 'governed reversible deactivation' }));
    return { deactivated: true, batchId };
  });
}

export function reconcileBatch(db, batchId) {
  const row = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active, COALESCE(SUM(CASE WHEN operational_effect_halalas <> 0 THEN operational_effect_halalas ELSE 0 END), 0) AS operational_effect_halalas FROM s11_historical_records WHERE batch_id = ?').get(batchId);
  return { total: row.total, active: row.active, operationalEffectHalalas: row.operational_effect_halalas };
}

export function searchHistoricalRecords(db, { batchId = null, query = '' } = {}) {
  const pattern = `%${String(query)}%`;
  const rows = batchId
    ? db.prepare('SELECT source_record_id, record_type, original_text, normalized_json, review_status, import_decision, is_active FROM s11_historical_records WHERE batch_id = ? AND is_active = 1 AND (source_record_id LIKE ? OR original_text LIKE ? OR normalized_json LIKE ?) ORDER BY source_record_id').all(batchId, pattern, pattern, pattern)
    : db.prepare('SELECT source_record_id, record_type, original_text, normalized_json, review_status, import_decision, is_active FROM s11_historical_records WHERE is_active = 1 AND (source_record_id LIKE ? OR original_text LIKE ? OR normalized_json LIKE ?) ORDER BY source_record_id').all(pattern, pattern, pattern);
  return rows;
}

export async function loadPreparationStore(path, { sourceStoreId, sourceStoreSha256 }) {
  const buffer = await readFile(path);
  const actual = sha256(buffer);
  if (actual !== sourceStoreSha256) throw new Error('private preparation store SHA-256 mismatch');
  return parsePreparationWorkbook(buffer, { sourceStoreId, sourceStoreSha256 });
}
