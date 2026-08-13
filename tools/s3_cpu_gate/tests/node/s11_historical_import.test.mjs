import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import XLSX from '../../src/worker/assets/vendor/xlsx-0.20.3.mjs';
import {
  buildPlan,
  calculateGovernedFinancialEffect,
  deactivateBatch,
  dryRun,
  importPlan,
  normalizeRecord,
  parsePreparationWorkbook,
  reconcileBatch,
  searchHistoricalRecords,
} from '../../src/worker/src/s11-historical-import.mjs';

const MIGRATION = await readFile(new URL('../../src/worker/migrations/0011_s11_historical_import.sql', import.meta.url), 'utf8');
const sha = (text) => Array.from(new Uint8Array(awaitableHash(text))).map((value) => value.toString(16).padStart(2, '0')).join('');
function awaitableHash(text) {
  let hash = 2166136261;
  for (const byte of Buffer.from(text)) hash = Math.imul(hash ^ byte, 16777619);
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) result[index] = (hash >>> ((index % 4) * 8)) & 0xff;
  return result;
}
const STORE_SHA = sha('synthetic-s11-store-v1');
const NOW = '2026-08-13T00:00:00.000Z';

function db() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(MIGRATION);
  return database;
}

function workbookBuffer() {
  const workHeaders = [
    'ID_مؤقت', 'معرف_العميل_يدوي', 'حالة_معرف_العميل', 'النص_الأصلي_للعمل', 'العنوان_المنظم',
    'حالة_العنوان', 'نوع_العمل', 'حالة_نوع_العمل', 'التخصص', 'حالة_التخصص', 'المادة_او_رمز_المقرر',
    'حالة_المادة', 'الجامعة', 'حالة_الجامعة', 'الدولة', 'حالة_الدولة', 'العلاقة', 'حالة_العلاقة',
    'الكمية', 'حالة_الكمية', 'السعر_النهائي_ريال', 'حالة_السعر', 'تاريخ_الاتفاق', 'حالة_تاريخ_الاتفاق',
    'تاريخ_الإنجاز_والتسليم', 'حالة_تاريخ_التسليم', 'حالة_العمل', 'حالة_حقل_العمل', 'المدفوع_حتى_2026_08_13',
    'حالة_الدفع', 'المصدر', 'حالة_مراجعة_السجل', 'جاهزية_الاستيراد', 'ملاحظات_تحضيرية',
  ];
  const workRow = [
    'SYN-WORK-001', 'customer-synthetic-1', 'CONFIRMED', 'نص عربي English historical work', 'عنوان منظم',
    'CONFIRMED', 'بحث', 'CONFIRMED', '', 'UNKNOWN', '', 'UNKNOWN', '', 'UNKNOWN', 'السعودية', 'CONFIRMED',
    'INDEPENDENT', 'CONFIRMED', 1, 'CONFIRMED', '100.00 ر.س', 'CONFIRMED', '2021-08-06', 'CONFIRMED',
    '2021-08-06', 'CONFIRMED', 'DELIVERED', 'CONFIRMED', '0.00 ر.س', 'CONFIRMED', 'SYN-SRC-001',
    'CONFIRMED', 'CONFIRMED', '',
  ];
  const financeHeaders = ['ID_مالي', 'الفئة', 'الوصف', 'شهر_التسوية', 'المبلغ_الأصلي_ريال', 'الدافع', 'المستفيد_او_المعنى', 'قاعدة_المعالجة', 'الأثر_على_مستحق_الشخص2_ريال', 'حالة_الحقيقة', 'المصدر', 'جاهزية_الاستيراد'];
  const financeRow = ['FIN-SYN-OPEN-001', 'LEGACY_OPENING_BALANCE_CANDIDATE', 'رصيد تاريخي اصطناعي', 'OPENING-2021-08', '3,741.00 ر.س', 'NOT_APPLICABLE', 'person_2', 'review first', '3,741.00 ر.س', 'CONFIRMED', 'SYN-FIN-001', 'PENDING_REVIEW'];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['synthetic'], workHeaders, workRow]), 'الأعمال');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['synthetic'], financeHeaders, financeRow]), 'مالية_أغسطس');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function baseRecord(overrides = {}) {
  return {
    sourceRecordId: 'SYN-001',
    sourceContainer: 'synthetic',
    sourceLocation: 'synthetic!A1',
    originalText: 'Synthetic original text عربي English',
    normalized: { title: 'Synthetic' },
    recordType: 'WORK',
    reviewStatus: 'CONFIRMED',
    customerMappingStatus: 'CONFIRMED',
    dateText: '2026-08-06',
    financialAmountHalalas: null,
    financialActivationState: 'NONE',
    uncertaintyFlags: [],
    ...overrides,
  };
}

test('parser preserves prepared source text, dates and the separate opening balance', () => {
  const plan = parsePreparationWorkbook(workbookBuffer(), { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA });
  assert.equal(plan.records.length, 2);
  const work = plan.records.find((record) => record.sourceRecordId === 'SYN-WORK-001');
  const opening = plan.records.find((record) => record.sourceRecordId === 'FIN-SYN-OPEN-001');
  assert.equal(work.originalText, 'نص عربي English historical work');
  assert.equal(work.dateCompleteness, 'COMPLETE_DAY');
  assert.equal(work.importDecision, 'PENDING_REVIEW');
  assert.match(work.decisionReason, /financial activation/);
  assert.equal(opening.recordType, 'OPENING_HISTORICAL_BALANCE');
  assert.equal(opening.importDecision, 'PENDING_REVIEW');
  assert.equal(opening.financialAmountHalalas, 374100);
  assert.equal(opening.financialActivationState, 'PENDING_REVIEW');
  assert.equal(opening.normalized.preparedEffectHalalas, 374100);
});

test('date completeness is deterministic and never invents a year', () => {
  assert.equal(normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE-MONTH', dateText: '2026-08' })).dateCompleteness, 'COMPLETE_MONTH');
  assert.equal(normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE-DAY', dateText: '2026-08-06' })).dateCompleteness, 'COMPLETE_DAY');
  assert.equal(normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE-YEAR', dateText: '2026' })).dateCompleteness, 'YEAR_ONLY');
  assert.equal(normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE-NOYEAR', dateText: '06/08' })).dateCompleteness, 'MISSING_YEAR');
  assert.equal(normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE-ARABIC-NOYEAR', dateText: 'أغسطس' })).dateCompleteness, 'MISSING_YEAR');
  assert.equal(normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE-EMPTY', dateText: '' })).dateCompleteness, 'MISSING');
});

test('D-015 financial effect uses governed rules, not raw historical prices', () => {
  const work = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-RAW-WORK', recordType: 'WORK', financialAmountHalalas: 50000 }));
  const workShare = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-SHARE', recordType: 'HISTORICAL_SETTLEMENT', financialAmountHalalas: 50000 }));
  const subscription = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-SUB', recordType: 'SUBSCRIPTION_EXPENSE', financialAmountHalalas: 13650 }));
  const transfer = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-TRANSFER', recordType: 'TRANSFER_FEE', financialAmountHalalas: 2000 }));
  const unreviewed = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-UNREVIEWED', recordType: 'HISTORICAL_SETTLEMENT', financialAmountHalalas: 50000, reviewStatus: 'PENDING_REVIEW' }));
  assert.equal(calculateGovernedFinancialEffect(workShare, { accountingEffectRule: { kind: 'WORK_SHARE', shareRateBps: 7000 }, approved: true }), 35000);
  assert.equal(calculateGovernedFinancialEffect(subscription, { accountingEffectRule: { kind: 'HALF_SUBSCRIPTION' }, approved: true }), 6825);
  assert.equal(calculateGovernedFinancialEffect(transfer, { accountingEffectRule: { kind: 'HALF_TRANSFER_FEE' }, approved: true }), -1000);
  assert.equal(calculateGovernedFinancialEffect(work, { accountingEffectRule: { kind: 'RAW_WORK_PRICE' }, approved: true }), 0);
  assert.equal(calculateGovernedFinancialEffect(unreviewed, { accountingEffectRule: { kind: 'WORK_SHARE', shareRateBps: 7000 }, approved: true }), 0);
  assert.equal(calculateGovernedFinancialEffect(workShare, { accountingEffectRule: null, approved: true }), 0);
});

test('missing year is never guessed and zero price requires an explicit reason', () => {
  const missingYear = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-DATE', dateText: '06/08', financialAmountHalalas: null }));
  assert.equal(missingYear.dateCompleteness, 'MISSING_YEAR');
  assert.equal(missingYear.importDecision, 'PENDING_REVIEW');
  const zeroUnknown = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-ZERO-UNKNOWN', financialAmountHalalas: 0 }));
  assert.equal(zeroUnknown.importDecision, 'PENDING_REVIEW');
  assert.match(zeroUnknown.decisionReason, /zero price/);
  const zeroFree = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-ZERO-FREE', financialAmountHalalas: 0, zeroPriceReason: 'FREE' }));
  assert.equal(zeroFree.importDecision, 'ACCEPTED');
});

test('works, totals, settlements and notes remain distinct record types', () => {
  const total = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-TOTAL', recordType: 'TOTAL_OR_SUMMARY_ROW', originalText: 'Total: 100', financialAmountHalalas: 10000 }));
  const note = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-NOTE', recordType: 'FREE_NOTE', originalText: 'Note: 100', financialAmountHalalas: null }));
  const settlement = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-SETTLE', recordType: 'HISTORICAL_SETTLEMENT', originalText: 'Settlement 100', financialAmountHalalas: 10000 }));
  assert.equal(total.recordType, 'TOTAL_OR_SUMMARY_ROW');
  assert.equal(note.recordType, 'FREE_NOTE');
  assert.equal(settlement.recordType, 'HISTORICAL_SETTLEMENT');
  assert.equal(total.importDecision, 'PENDING_REVIEW');
  assert.equal(settlement.importDecision, 'PENDING_REVIEW');
});

test('dry-run is mutation-safe and produces accepted/rejected/pending report', () => {
  const plan = buildPlan([
    baseRecord({ sourceRecordId: 'SYN-A', financialAmountHalalas: null }),
    baseRecord({ sourceRecordId: 'SYN-R', reviewStatus: 'REJECTED', customerMappingStatus: 'NOT_APPLICABLE' }),
    baseRecord({ sourceRecordId: 'SYN-P', customerMappingStatus: 'UNKNOWN', financialAmountHalalas: 5000 }),
  ], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW });
  const database = db();
  const before = database.prepare('SELECT COUNT(*) AS count FROM s11_historical_records').get().count;
  const result = dryRun(plan);
  const after = database.prepare('SELECT COUNT(*) AS count FROM s11_historical_records').get().count;
  assert.equal(result.mutatesAuthoritativeData, false);
  assert.deepEqual(result.report.counts, { ACCEPTED: 1, REJECTED: 1, PENDING_REVIEW: 1, UNKNOWN: 0 });
  assert.equal(before, after);
  assert.equal(result.report.operationalEffectHalalas, 0);
});

test('AC-14 keeps unapproved financial records non-operational and approval is explicit', () => {
  const pending = buildPlan([baseRecord({ sourceRecordId: 'SYN-FIN-PENDING', recordType: 'PAYMENT_OR_RECEIPT', customerMappingStatus: 'NOT_APPLICABLE', financialAmountHalalas: 374100, financialActivationState: 'PENDING_REVIEW' })], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW });
  const database = db();
  const imported = importPlan(database, pending, { batchKey: 'pending-batch', now: NOW });
  assert.equal(imported.report.operationalEffectHalalas, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM s11_financial_activations').get().count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM s11_historical_records WHERE operational_effect_halalas <> 0').get().count, 0);
  const approvedPlan = buildPlan([baseRecord({ sourceRecordId: 'SYN-FIN-APPROVED', recordType: 'SUBSCRIPTION_EXPENSE', customerMappingStatus: 'NOT_APPLICABLE', financialAmountHalalas: 13650, financialActivationState: 'PENDING_REVIEW' })], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW });
  const approved = importPlan(database, approvedPlan, {
    batchKey: 'approved-batch',
    now: NOW,
    approvals: { 'SYN-FIN-APPROVED': { approvedBy: 'supervisor-synthetic', approvedAt: NOW, reason: 'synthetic acceptance approval', accountingEffectRule: { kind: 'HALF_SUBSCRIPTION' } } },
  });
  assert.equal(approved.report.operationalEffectHalalas, 6825);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM s11_financial_activations WHERE state = \'APPROVED\'').get().count, 1);
  assert.equal(searchHistoricalRecords(database, { batchId: approved.batchId, query: 'SYN-FIN-APPROVED' }).length, 1);
  const rawWork = importPlan(database, buildPlan([baseRecord({ sourceRecordId: 'SYN-RAW-WORK-IMPORT', recordType: 'WORK', financialAmountHalalas: 50000 })], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW }), {
    batchKey: 'raw-work-no-double-count',
    now: NOW,
    approvals: { 'SYN-RAW-WORK-IMPORT': { approvedBy: 'supervisor-synthetic', approvedAt: NOW, reason: 'raw Work price is not a settlement effect', accountingEffectRule: { kind: 'RAW_WORK_PRICE' } } },
  });
  assert.equal(rawWork.report.operationalEffectHalalas, 0);
  assert.equal(rawWork.report.counts.PENDING_REVIEW, 1);
});

test('same batch is idempotent, conflicting source is rejected, and duplicate rows are blocked', () => {
  const plan = buildPlan([baseRecord({ sourceRecordId: 'SYN-IDEMP' })], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW });
  const database = db();
  const first = importPlan(database, plan, { batchKey: 'same-batch', now: NOW });
  const second = importPlan(database, plan, { batchKey: 'same-batch', now: NOW });
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.batchId, first.batchId);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM s11_historical_records').get().count, 1);
  assert.throws(() => buildPlan([baseRecord({ sourceRecordId: 'SYN-DUP' }), baseRecord({ sourceRecordId: 'SYN-DUP' })], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA }), /duplicate source record/);
  const conflictingPlan = buildPlan([baseRecord({ sourceRecordId: 'SYN-IDEMP', originalText: 'changed source' })], { sourceStoreId: 'other-store', sourceStoreSha256: 'b'.repeat(64), now: NOW });
  assert.throws(() => importPlan(database, conflictingPlan, { batchKey: 'other-batch', now: NOW }), /source record conflict/);
});

test('rollback deactivates the batch, restores zero operational effect, and retains provenance/events', () => {
  const plan = buildPlan([baseRecord({ sourceRecordId: 'SYN-ROLLBACK', recordType: 'TRANSFER_FEE', customerMappingStatus: 'NOT_APPLICABLE', financialAmountHalalas: 2000, financialActivationState: 'PENDING_REVIEW' })], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW });
  const database = db();
  const imported = importPlan(database, plan, {
    batchKey: 'rollback-batch',
    now: NOW,
    approvals: { 'SYN-ROLLBACK': { approvedBy: 'supervisor-synthetic', approvedAt: NOW, reason: 'synthetic approval', accountingEffectRule: { kind: 'HALF_TRANSFER_FEE' } } },
  });
  assert.equal(reconcileBatch(database, imported.batchId).operationalEffectHalalas, -1000);
  const result = deactivateBatch(database, imported.batchId, { now: NOW });
  assert.equal(result.deactivated, true);
  const reconciled = reconcileBatch(database, imported.batchId);
  assert.equal(reconciled.active, 0);
  assert.equal(reconciled.operationalEffectHalalas, 0);
  assert.equal(database.prepare('SELECT original_text FROM s11_historical_records WHERE batch_id = ?').get(imported.batchId).original_text, 'Synthetic original text عربي English');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM s11_import_events WHERE event_type = 'BATCH_DEACTIVATED'").get().count, 1);
  assert.throws(() => database.prepare('DELETE FROM s11_historical_records WHERE batch_id = ?').run(imported.batchId), /reversible, not deletable/);
});

test('source provenance is immutable and integer financial values are exact halalas', () => {
  const record = normalizeRecord(baseRecord({ sourceRecordId: 'SYN-HALALAS', financialAmountHalalas: 13650 }));
  assert.equal(record.financialAmountHalalas, 13650);
  assert.equal(Number.isInteger(record.financialAmountHalalas), true);
  const database = db();
  const imported = importPlan(database, buildPlan([record], { sourceStoreId: 'synthetic-store', sourceStoreSha256: STORE_SHA, now: NOW }), { batchKey: 'immutable', now: NOW });
  assert.throws(() => database.prepare("UPDATE s11_historical_records SET original_text = 'changed' WHERE batch_id = ?").run(imported.batchId), /immutable/);
});
