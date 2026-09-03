import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCatalogValue, createCustomer, createWork, updateWork,
  createPriceChangeRequest, approvePriceChangeRequest,
  createRatioChangeRequest, approveRatioChangeRequest,
  createClientPayment, createPaymentReversalRequest, approvePaymentReversalRequest,
  createInterPartyTransfer, listInterPartyTransfers,
  createSubscriptionHistory, listSubscriptionHistory, createCommonExpense, listCommonExpenses,
  getSettlementPreview, closeSettlement, listSettlementSnapshots,
  createSettlementReopenRequest, approveSettlementReopenRequest, listSettlementReopenRequests,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const migration7Path = fileURLToPath(new URL('../../src/worker/migrations/0007_s7_payments_collections_reversals.sql', import.meta.url));
const migration8Path = fileURLToPath(new URL('../../src/worker/migrations/0008_s7_pr_b_settlement_core.sql', import.meta.url));
const migration9Path = fileURLToPath(new URL('../../src/worker/migrations/0009_s7_d014_d016_authoritative_settlement.sql', import.meta.url));
const fullSchema = readFileSync(schemaPath, 'utf8');
const s7Marker = '\n-- S7 PR-A Payments / Collections / Reversal Core.';
const s6Schema = fullSchema.slice(0, fullSchema.indexOf(s7Marker)).replace(/  confirmed_at TEXT,\r?\n/, '');

class D1Statement {
  constructor(database, sql) { this.database = database; this.parameterMap = []; this.sql = sql.replace(/\?(\d+)/g, (_, i) => { this.parameterMap.push(Number(i)); return '?'; }); this.values = []; }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(i => values[i - 1]) : values; this.database.bindingWidths.push(this.values.length); return this; }
  first() { this.database.readQueries += 1; return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { this.database.readQueries += 1; return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) { this.database.exec('BEGIN IMMEDIATE'); try { const results = statements.map(s => { const r = this.database.prepare(s.sql).run(...s.values); return { success: true, results: [], meta: { changes: Number(r.changes) } }; }); this.database.exec('COMMIT'); return Promise.resolve(results); } catch (e) { this.database.exec('ROLLBACK'); return Promise.reject(e); } }
}
function fixture(schema = fullSchema) {
  const database = new DatabaseSync(':memory:'); database.exec(schema);
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 'prb-test');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 'prb-test');
  database.readQueries = 0; database.bindingWidths = [];
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 'prb-test', FIREBASE_PROJECT_ID: 'demo-project' } };
}
async function catalog(env, requestId, kind, valueKey, label) { try { return await createCatalogValue(env, 'uid-one', requestId, kind, { value_key: valueKey, label }); } catch (e) { if (e?.code !== 'CATALOG_DUPLICATE') throw e; } }
async function setupWork(env, title = 'PR-B Synthetic Work') {
  await catalog(env, `country-${title}`, 'country', 'SA', 'Synthetic Saudi Arabia');
  await catalog(env, `specialty-${title}`, 'specialty', 'IT', 'Synthetic IT');
  await catalog(env, `type-${title}`, 'work_type', 'REPORT', 'Synthetic Report');
  const customer = await createCustomer(env, 'uid-one', `customer-${title}`, { name: 'Synthetic Customer', country: 'SA', university: 'Synthetic University', specialty: 'IT' });
  const work = await createWork(env, 'uid-one', `work-${title}`, { customer_id: customer.id, title, country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University', confirmed_at: '2026-08-12T00:00:00.000Z' });
  return { customer, work };
}
async function price(env, work, request = 'prb-price') {
  const req = await createPriceChangeRequest(env, 'uid-one', `${request}-request`, work.id, { version: work.version, movement_type: 'BASE', amount_riyals: '1700.00', reason: 'Synthetic approved S6 price', effective_at: '2026-08-12T00:00:00.000Z' });
  return approvePriceChangeRequest(env, 'uid-two', `${request}-approval`, work.id, req.id);
}
const settlementInput = (extra = {}) => ({ period_basis: 'CONFIRMED_AT', balance_formula: 'D-015_PERSON_1_OWES_PERSON_2_POSITIVE', ...extra });
function seedPreS7Work(database) {
  database.prepare('INSERT INTO customers(id,name,status,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,?,?,1)').run('pre-s7-customer', 'Pre-S7 Customer', 'normal', 'uid-one', '2026-07-01T00:00:00.000Z', 'uid-one', '2026-07-01T00:00:00.000Z');
  database.prepare('INSERT INTO works(id,customer_id,relationship_kind,title,country,status,price_state,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,\'NEW_REQUEST\',\'PRICE_UNSET\',?,?,?,?,1)').run('pre-s7-work', 'pre-s7-customer', 'INDEPENDENT', 'Pre-S7 Work', 'SA', 'uid-one', '2026-07-01T00:00:00.000Z', 'uid-one', '2026-07-01T00:00:00.000Z');
}
function seedClosedSnapshot(database, periodKey, requestId = `seed-close-${periodKey}`) {
  const end = `${periodKey}-28T00:00:00.000Z`;
  database.prepare(`INSERT INTO settlement_snapshots(
    id,period_key,period_start,period_end,period_basis,balance_formula,state,work_count,cumulative_work_count,
    total_work_value_halalas,person_1_work_share_halalas,person_2_work_share_halalas,approved_receipts_halalas,
    approved_receipts_person_1_halalas,approved_receipts_person_2_halalas,transfer_amount_halalas,transfer_fee_halalas,subscription_total_halalas,subscription_effect_person_1_halalas,
    subscription_effect_person_2_halalas,governed_expense_total_halalas,prior_balance_halalas,final_balance_halalas,
    unresolved_code,version,created_by,created_at,request_id
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `snapshot-${periodKey}`, periodKey, `${periodKey}-01T00:00:00.000Z`, end, 'LEGACY_UNRESOLVED_BASIS', 'LEGACY_UNRESOLVED_FORMULA', 'CLOSED',
    ...Array(15).fill(0), null, 'LEGACY', 1, 'uid-one', '2026-08-01T00:00:00.000Z', requestId,
  );
}


test('PR-B transfers preserve explicit direction and P-03 fee separation', async () => {
  const { database, env } = fixture();
  try {
    const transfer = await createInterPartyTransfer(env, 'uid-one', 'prb-transfer-1', { amount_riyals: '100.00', fee_riyals: '1.01', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1', note: 'Synthetic transfer' });
    assert.equal(transfer.amount_halalas, 10000); assert.equal(transfer.fee_halalas, 101); assert.equal(transfer.from_party, 'person_1'); assert.equal((await listInterPartyTransfers(env)).length, 1);
    assert.throws(() => database.exec('UPDATE inter_party_transfers SET amount_halalas=1'), /inter_party_transfers are append only/);
    assert.throws(() => database.exec('DELETE FROM inter_party_transfers'), /inter_party_transfers are append only/);
    const preview = await getSettlementPreview(env, '2026-08', settlementInput());
    assert.equal(preview.transfer_amount_halalas, 10000); assert.equal(preview.transfer_fee_halalas, 101); assert.equal(preview.subscription_effect_person_1_halalas, -6825); assert.equal(preview.subscription_effect_person_2_halalas, 6825); assert.equal(preview.final_balance_halalas, -3226);
  } finally { database.close(); }
});

test('PR-B subscriptions preserve P-01 13650 baseline and prospective P-02 burden', async () => {
  const { database, env } = fixture();
  try {
    const beforeHistory = await getSettlementPreview(env, '2026-08', settlementInput());
    assert.equal(beforeHistory.subscription_total_halalas, 13650); assert.deepEqual(beforeHistory.subscription_history, []); assert.equal(beforeHistory.unresolved_code, null);
    const active = await createSubscriptionHistory(env, 'uid-two', 'prb-sub-baseline', { aggregate_amount_riyals: '136.50', effective_at: '2026-08-01T00:00:00.000Z' });
    assert.equal(active.subscription_count, 2); assert.equal(active.aggregate_amount_halalas, 13650); assert.equal(active.paid_by_uid, 'uid-two');
    await createSubscriptionHistory(env, 'uid-two', 'prb-sub-change', { aggregate_amount_riyals: '200.00', effective_at: '2026-09-01T00:00:00.000Z' });
    await createSubscriptionHistory(env, 'uid-two', 'prb-sub-cancel', { state: 'CANCELLED', effective_at: '2026-10-01T00:00:00.000Z' });
    assert.equal((await listSubscriptionHistory(env)).length, 3);
    const august = await getSettlementPreview(env, '2026-08', settlementInput());
    const september = await getSettlementPreview(env, '2026-09', settlementInput());
    const october = await getSettlementPreview(env, '2026-10', settlementInput());
    const november = await getSettlementPreview(env, '2026-11', settlementInput());
    assert.equal(august.subscription_total_halalas, 13650); assert.equal(august.subscription_effect_person_1_halalas, -6825); assert.equal(august.subscription_effect_person_2_halalas, 6825); assert.equal(august.unresolved_code, null);
    assert.equal(september.subscription_total_halalas, 13650); assert.equal(september.subscription_history.length, 2); assert.equal(september.subscription_history[1].aggregate_amount_halalas, 20000);
    assert.equal(october.subscription_total_halalas, 20000); assert.equal(october.subscription_history.length, 3); assert.equal(october.subscription_history[2].state, 'CANCELLED');
    assert.equal(november.subscription_total_halalas, 0); assert.equal(november.subscription_effect_person_1_halalas, 0); assert.equal(november.subscription_effect_person_2_halalas, 0);
    assert.ok(!('name' in active) && !('item_amounts' in active));
  } finally { database.close(); }
});

test('PR-B generic expenses preserve facts and fail closed on invented allocation', async () => {
  const { database, env } = fixture();
  try {
    const expense = await createCommonExpense(env, 'uid-one', 'prb-expense-1', { amount_riyals: '50.00', effective_at: '2026-08-12T09:00:00.000Z', category: 'Synthetic shared expense', paid_by_uid: 'uid-two' });
    assert.equal(expense.amount_halalas, 5000); assert.equal(expense.allocation_policy, 'UNRESOLVED'); assert.equal((await listCommonExpenses(env)).length, 1);
    const preview = await getSettlementPreview(env, '2026-08', settlementInput()); assert.equal(preview.governed_expense_total_halalas, 5000); assert.equal(preview.generic_expense_allocation, 'UNRESOLVED'); assert.equal(preview.unresolved_code, 'S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED');
    await assert.rejects(closeSettlement(env, 'uid-one', 'prb-expense-close', '2026-08', settlementInput()), /S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED/);
    assert.throws(() => database.exec('UPDATE common_expenses SET amount_halalas=1'), /common_expenses are append only/); assert.throws(() => database.exec('DELETE FROM common_expenses'), /common_expenses are append only/);
  } finally { database.close(); }
});

test('PR-B settlement components consume S6 price authority, receipts, transfers, subscriptions, and D-012 rounding', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Settlement Components'); await price(env, work, 'prb-components');
    await createClientPayment(env, 'uid-one', 'prb-components-payment-p1', work.id, { version: 2, amount_riyals: '1000.00', effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'BANK_TRANSFER', received_by: 'uid-one' });
    await createClientPayment(env, 'uid-one', 'prb-components-payment-p2', work.id, { version: 3, amount_riyals: '100.00', effective_at: '2026-08-12T12:30:00.000Z', payment_method: 'BANK_TRANSFER', received_by: 'uid-two' });
    await createInterPartyTransfer(env, 'uid-one', 'prb-components-transfer', { amount_riyals: '100.00', fee_riyals: '1.01', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' });
    const preview = await getSettlementPreview(env, '2026-08', settlementInput({ prior_balance_riyals: '999999.99' }));
    assert.equal(preview.work_count, 1); assert.equal(preview.total_work_value_halalas, 170000); assert.equal(preview.person_1_work_share_halalas, 119000); assert.equal(preview.person_2_work_share_halalas, 51000); assert.equal(preview.approved_receipts_halalas, 110000); assert.equal(preview.approved_receipts_person_1_halalas, 100000); assert.equal(preview.approved_receipts_person_2_halalas, 10000); assert.equal(preview.transfer_fee_halalas, 101); assert.equal(preview.prior_balance_halalas, 0); assert.equal(preview.prior_balance_authority, 'ZERO_NO_PRIOR_SETTLEMENT'); assert.equal(preview.final_balance_halalas, 37774); assert.equal(preview.period_basis, 'CONFIRMED_AT'); assert.equal(preview.balance_formula, 'D-015_PERSON_1_OWES_PERSON_2_POSITIVE');
    const closed = await closeSettlement(env, 'uid-one', 'prb-components-close', '2026-08', settlementInput({ prior_balance_riyals: '999999.99' }));
    assert.equal(closed.final_balance_halalas, 37774); assert.equal((await listSettlementSnapshots(env, '2026-08')).length, 1);
  } finally { database.close(); }
});

test('PR-B D-011 soft-close and reopen require dual approval in both directions and preserve history', async () => {
  const { database, env } = fixture();
  try {
    seedClosedSnapshot(database, '2026-08');
    await assert.rejects(closeSettlement(env, 'uid-one', 'prb-close-aug-again', '2026-08', settlementInput()), /SETTLEMENT_ALREADY_CLOSED/);
    const first = await createSettlementReopenRequest(env, 'uid-one', 'prb-reopen-aug', '2026-08', { reason: 'Synthetic reopen' });
    assert.equal((await listSettlementReopenRequests(env, '2026-08'))[0].state, 'PENDING');
    await assert.rejects(approveSettlementReopenRequest(env, 'uid-one', 'prb-reopen-self', '2026-08', first.id), /SELF_APPROVAL_REJECTED/);
    await approveSettlementReopenRequest(env, 'uid-two', 'prb-reopen-aug-approval', '2026-08', first.id);
    await assert.rejects(approveSettlementReopenRequest(env, 'uid-two', 'prb-reopen-duplicate', '2026-08', first.id), /ALREADY_FINALIZED/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM settlement_reopen_history WHERE period_key=?').get('2026-08').count, 1);
    assert.equal((await createInterPartyTransfer(env, 'uid-one', 'prb-after-reopen-transfer', { amount_riyals: '10.00', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' })).amount_halalas, 1000);
    const reopenedClose = await closeSettlement(env, 'uid-two', 'prb-close-after-reopen', '2026-08', settlementInput());
    assert.equal(reopenedClose.version, 2); assert.equal((await listSettlementSnapshots(env, '2026-08')).length, 2);

    seedClosedSnapshot(database, '2026-09');
    const second = await createSettlementReopenRequest(env, 'uid-two', 'prb-reopen-sep', '2026-09', { reason: 'Synthetic reverse direction' });
    await approveSettlementReopenRequest(env, 'uid-one', 'prb-reopen-sep-approval', '2026-09', second.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM settlement_reopen_history WHERE period_key=?').get('2026-09').count, 1);
  } finally { database.close(); }
});

test('PR-B D-011 re-close rejects sequentially and only an approved reopen can clear the state gate', async () => {
  const { database, env } = fixture();
  try {
    seedClosedSnapshot(database, '2026-11');
    await assert.rejects(closeSettlement(env, 'uid-two', 'prb-reclose-1', '2026-11', settlementInput()), /SETTLEMENT_ALREADY_CLOSED/);
    const req = await createSettlementReopenRequest(env, 'uid-one', 'prb-reclose-reopen', '2026-11', { reason: 'Synthetic approved reopen' });
    await approveSettlementReopenRequest(env, 'uid-two', 'prb-reclose-approve', '2026-11', req.id);
    const reopenedClose = await closeSettlement(env, 'uid-two', 'prb-reclose-2', '2026-11', settlementInput());
    assert.equal(reopenedClose.version, 2); assert.equal((await listSettlementSnapshots(env, '2026-11')).length, 2);
  } finally { database.close(); }
});

test('PR-B D-011 concurrent reopen approvals yield one transition, one history row, one audit, and zero loser side effects', async () => {
  const { database, env } = fixture();
  try {
    seedClosedSnapshot(database, '2026-12');
    const req = await createSettlementReopenRequest(env, 'uid-one', 'prb-race-request', '2026-12', { reason: 'Synthetic concurrent approval' });
    const attempts = await Promise.allSettled([
      approveSettlementReopenRequest(env, 'uid-two', 'prb-race-approval-a', '2026-12', req.id),
      approveSettlementReopenRequest(env, 'uid-two', 'prb-race-approval-b', '2026-12', req.id),
    ]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'TRANSACTION_FAILED');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM settlement_reopen_requests WHERE id=? AND state=\'APPROVED\'').get(req.id).count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM settlement_reopen_history WHERE reopen_request_id=?').get(req.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='settlement_reopen_request' AND entity_id=? AND action='UPDATE'").get(req.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='settlement_reopen_request' AND entity_id=? AND action='UPDATE' AND request_id IN ('prb-race-approval-a:audit','prb-race-approval-b:audit')").get(req.id).count, 1);
  } finally { database.close(); }
});

test('PR-B P-01 effective-dated history is reported without retroactive full-period aggregation', async () => {
  const { database, env } = fixture();
  try {
    await createSubscriptionHistory(env, 'uid-two', 'prb-p01-aug', { aggregate_amount_riyals: '136.50', effective_at: '2026-08-15T00:00:00.000Z' });
    const august = await getSettlementPreview(env, '2026-08', settlementInput());
    assert.equal(august.subscription_history.length, 1); assert.equal(august.subscription_history[0].effective_at, '2026-08-15T00:00:00.000Z'); assert.equal(august.subscription_total_halalas, 13650); assert.equal(august.subscription_effect_person_1_halalas, -6825); assert.equal(august.subscription_effect_person_2_halalas, 6825);
    await createSubscriptionHistory(env, 'uid-two', 'prb-p01-sep', { aggregate_amount_riyals: '200.00', effective_at: '2026-09-15T00:00:00.000Z' });
    const september = await getSettlementPreview(env, '2026-09', settlementInput());
    const october = await getSettlementPreview(env, '2026-10', settlementInput());
    assert.deepEqual(september.subscription_history.map(row => row.effective_at), ['2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z']); assert.equal(september.subscription_total_halalas, 13650); assert.equal(october.subscription_total_halalas, 20000); assert.equal(october.final_balance_halalas, 10000);
  } finally { database.close(); }
});

test('PR-B closed-period cross-stage mutations are blocked across Work, S6 approvals, payments, reversals, and PR-B facts', async () => {
  const { database, env } = fixture();
  try {
    const { customer, work } = await setupWork(env, 'Closed Cross Stage');
    await price(env, work, 'prb-cross-stage-base');
    const payment = await createClientPayment(env, 'uid-one', 'prb-cross-stage-payment', work.id, { version: 2, amount_riyals: '100.00', effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'BANK_TRANSFER' });
    const priceReq = await createPriceChangeRequest(env, 'uid-one', 'prb-cross-stage-price-request', work.id, { version: 3, movement_type: 'INCREASE', amount_riyals: '10.00', reason: 'Synthetic pending price', effective_at: '2026-08-12T13:00:00.000Z' });
    const ratioReq = await createRatioChangeRequest(env, 'uid-one', 'prb-cross-stage-ratio-request', work.id, { version: 3, person_1_bps: 4000, person_2_bps: 6000, reason: 'Synthetic pending ratio' });
    const reversalReq = await createPaymentReversalRequest(env, 'uid-one', 'prb-cross-stage-reversal-request', work.id, { version: 3, payment_id: payment.payment.id, reason: 'Synthetic pending reversal' });
    seedClosedSnapshot(database, '2026-08', 'prb-cross-stage-seed');

    const unconfirmedWork = await createWork(env, 'uid-one', 'prb-cross-stage-work-create', { customer_id: customer.id, title: 'Unconfirmed Work Outside Settlement', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University' });
    assert.equal(unconfirmedWork.confirmed_at, null);
    await assert.rejects(createWork(env, 'uid-one', 'prb-cross-stage-work-confirmed-create', { customer_id: customer.id, title: 'Blocked Confirmed Work', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University', confirmed_at: '2026-08-20T00:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(updateWork(env, 'uid-one', 'prb-cross-stage-work-update', work.id, { version: 3, description: 'Blocked update' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createClientPayment(env, 'uid-one', 'prb-cross-stage-payment-after-close', work.id, { version: 3, amount_riyals: '10.00', effective_at: '2026-08-12T14:00:00.000Z', payment_method: 'BANK_TRANSFER' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createPaymentReversalRequest(env, 'uid-one', 'prb-cross-stage-reversal-after-close', work.id, { version: 3, payment_id: payment.payment.id, reason: 'Blocked reversal' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(approvePaymentReversalRequest(env, 'uid-two', 'prb-cross-stage-reversal-approve', work.id, reversalReq.id), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createPriceChangeRequest(env, 'uid-one', 'prb-cross-stage-price-after-close', work.id, { version: 3, movement_type: 'INCREASE', amount_riyals: '10.00', reason: 'Blocked price', effective_at: '2026-08-12T14:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(approvePriceChangeRequest(env, 'uid-two', 'prb-cross-stage-price-approve', work.id, priceReq.id), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createRatioChangeRequest(env, 'uid-one', 'prb-cross-stage-ratio-after-close', work.id, { version: 3, person_1_bps: 4000, person_2_bps: 6000, reason: 'Blocked ratio' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(approveRatioChangeRequest(env, 'uid-two', 'prb-cross-stage-ratio-approve', work.id, ratioReq.id), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createInterPartyTransfer(env, 'uid-one', 'prb-cross-stage-transfer-after-close', { amount_riyals: '10.00', effective_at: '2026-08-12T14:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createSubscriptionHistory(env, 'uid-two', 'prb-cross-stage-subscription-after-close', { aggregate_amount_riyals: '136.50', effective_at: '2026-08-12T14:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createCommonExpense(env, 'uid-one', 'prb-cross-stage-expense-after-close', { amount_riyals: '10.00', effective_at: '2026-08-12T14:00:00.000Z', category: 'Blocked expense', paid_by_uid: 'uid-two' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
  } finally { database.close(); }
});

test('PR-B D-014 confirmation month inclusion/exclusion and old/new closed guards', async () => {
  const { database, env } = fixture();
  try {
    const { customer, work } = await setupWork(env, 'D014 Confirmation Base');
    const unconfirmed = await createWork(env, 'uid-one', 'd014-unconfirmed', { customer_id: customer.id, title: 'Unconfirmed Work', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University' });
    const september = await createWork(env, 'uid-one', 'd014-september', { customer_id: customer.id, title: 'September Work', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University', confirmed_at: '2026-09-15T00:00:00.000Z' });
    assert.equal((await getSettlementPreview(env, '2026-08', settlementInput())).work_count, 1);
    assert.equal((await getSettlementPreview(env, '2026-09', settlementInput())).work_count, 1);
    assert.equal(database.prepare('SELECT confirmed_at FROM works WHERE id=?').get(unconfirmed.id).confirmed_at, null);
    seedClosedSnapshot(database, '2026-08', 'd014-closed-aug');
    const unconfirmedAfterClose = await createWork(env, 'uid-one', 'd014-unconfirmed-after-close', { customer_id: customer.id, title: 'Unconfirmed After Closed Month', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University' });
    const editedUnconfirmed = await updateWork(env, 'uid-one', 'd014-edit-unconfirmed-after-close', unconfirmedAfterClose.id, { version: unconfirmedAfterClose.version, description: 'Still outside settlement until confirmed' });
    assert.equal(editedUnconfirmed.confirmed_at, null);
    await assert.rejects(updateWork(env, 'uid-one', 'd014-confirm-unconfirmed-into-closed', unconfirmedAfterClose.id, { version: editedUnconfirmed.version, confirmed_at: '2026-08-20T00:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(updateWork(env, 'uid-one', 'd014-sep-to-aug', september.id, { version: september.version, confirmed_at: '2026-08-15T00:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(updateWork(env, 'uid-one', 'd014-aug-to-sep', work.id, { version: work.version, confirmed_at: '2026-09-15T00:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    await assert.rejects(createWork(env, 'uid-one', 'd014-create-closed-aug', { customer_id: customer.id, title: 'Closed Confirmation Work', country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University', confirmed_at: '2026-08-20T00:00:00.000Z' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
  } finally { database.close(); }
  const auditFixture = fixture();
  try {
    const { work } = await setupWork(auditFixture.env, 'D014 Audit Version');
    const changed = await updateWork(auditFixture.env, 'uid-one', 'd014-audit-confirm', work.id, { version: work.version, confirmed_at: '2026-09-15T00:00:00.000Z' });
    assert.equal(changed.confirmed_at, '2026-09-15T00:00:00.000Z'); assert.equal(changed.version, 2);
    const audit = auditFixture.database.prepare("SELECT before_json,after_json FROM audit_log WHERE entity_type='work' AND entity_id=? AND action='UPDATE'").get(work.id);
    assert.equal(JSON.parse(audit.before_json).confirmed_at, '2026-08-12T00:00:00.000Z'); assert.equal(JSON.parse(audit.after_json).confirmed_at, '2026-09-15T00:00:00.000Z');
  } finally { auditFixture.database.close(); }
});

test('PR-B D-015 receipts split by received_by, exclude approved reversals, and preserve balance direction', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'D015 Receipts Reversal'); await price(env, work, 'd015-receipts');
    await createClientPayment(env, 'uid-one', 'd015-receipt-p1', work.id, { version: 2, amount_riyals: '100.00', effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'BANK_TRANSFER', received_by: 'uid-one' });
    await createClientPayment(env, 'uid-one', 'd015-receipt-p2', work.id, { version: 3, amount_riyals: '200.00', effective_at: '2026-08-12T12:30:00.000Z', payment_method: 'BANK_TRANSFER', received_by: 'uid-two' });
    const reversalRequest = await createPaymentReversalRequest(env, 'uid-one', 'd015-receipt-reversal-request', work.id, { version: 4, payment_id: database.prepare('SELECT id FROM client_payments WHERE request_id=?').get('d015-receipt-p1').id, reason: 'Synthetic approved reversal' });
    await approvePaymentReversalRequest(env, 'uid-two', 'd015-receipt-reversal-approve', work.id, reversalRequest.id);
    const preview = await getSettlementPreview(env, '2026-08', settlementInput());
    assert.equal(preview.approved_receipts_person_1_halalas, 0); assert.equal(preview.approved_receipts_person_2_halalas, 20000); assert.equal(preview.approved_receipts_halalas, 20000); assert.equal(preview.final_balance_halalas, 37825);
  } finally { database.close(); }
});

test('PR-B D-015 first settlement prior is zero and next settlement carries latest valid final balance', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'D015 Carry'); await price(env, work, 'd015-carry');
    const firstPreview = await getSettlementPreview(env, '2026-08', settlementInput());
    assert.equal(firstPreview.prior_balance_halalas, 0); assert.equal(firstPreview.prior_balance_authority, 'ZERO_NO_PRIOR_SETTLEMENT'); assert.equal(firstPreview.final_balance_halalas, 57825);
    const firstClosed = await closeSettlement(env, 'uid-one', 'd015-carry-close-aug', '2026-08', settlementInput());
    const nextPreview = await getSettlementPreview(env, '2026-09', settlementInput());
    assert.equal(nextPreview.prior_balance_halalas, 57825); assert.equal(nextPreview.prior_balance_authority, 'LATEST_VALID_PRIOR_MONTHLY_SETTLEMENT'); assert.equal(nextPreview.final_balance_halalas, 64650); assert.equal(firstClosed.final_balance_halalas, 57825);
  } finally { database.close(); }
});

test('PR-B D-015 reopened prior snapshots are invalid until re-closed and latest valid carry resumes', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'D015 Reopened Prior'); await price(env, work, 'd015-reopened-prior');
    const first = await closeSettlement(env, 'uid-one', 'd015-reopened-prior-close-aug', '2026-08', settlementInput());
    assert.equal(first.final_balance_halalas, 57825);
    const reopen = await createSettlementReopenRequest(env, 'uid-one', 'd015-reopened-prior-request', '2026-08', { reason: 'Synthetic prior invalidation' });
    await approveSettlementReopenRequest(env, 'uid-two', 'd015-reopened-prior-approve', '2026-08', reopen.id);
    const beforeReclose = await getSettlementPreview(env, '2026-09', settlementInput());
    assert.equal(beforeReclose.prior_balance_halalas, 0); assert.equal(beforeReclose.prior_balance_authority, 'ZERO_NO_PRIOR_SETTLEMENT'); assert.equal(beforeReclose.final_balance_halalas, 6825);
    await createInterPartyTransfer(env, 'uid-one', 'd015-reopened-prior-transfer', { amount_riyals: '10.00', effective_at: '2026-08-20T00:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' });
    const reclosed = await closeSettlement(env, 'uid-two', 'd015-reopened-prior-reclose-aug', '2026-08', settlementInput());
    assert.equal(reclosed.version, 2); assert.equal(reclosed.final_balance_halalas, 56825);
    const afterReclose = await getSettlementPreview(env, '2026-09', settlementInput());
    assert.equal(afterReclose.prior_balance_halalas, 56825); assert.equal(afterReclose.prior_balance_authority, 'LATEST_VALID_PRIOR_MONTHLY_SETTLEMENT'); assert.equal(afterReclose.final_balance_halalas, 63650);
    const nextClosed = await closeSettlement(env, 'uid-one', 'd015-reopened-prior-close-sep', '2026-09', settlementInput());
    assert.equal(nextClosed.prior_balance_halalas, 56825); assert.equal(nextClosed.final_balance_halalas, 63650);
  } finally { database.close(); }
});

test('PR-B migration preservation retains PR-A/S6 rows and installs append-only transfer and settlement audit guards', async () => {
  const { database, env } = fixture(s6Schema);
  try {
    seedPreS7Work(database); const before = database.prepare('SELECT COUNT(*) AS count FROM works').get().count; database.exec(readFileSync(migration7Path, 'utf8')); database.exec(readFileSync(migration8Path, 'utf8')); database.exec(readFileSync(migration9Path, 'utf8')); assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, before);
    for (const table of ['inter_party_transfers','subscription_history','common_expenses','settlement_snapshots','settlement_reopen_requests','settlement_reopen_history']) assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    assert.ok(database.prepare("SELECT confirmed_at FROM works WHERE id='pre-s7-work'").get()); assert.ok(database.prepare("SELECT name FROM pragma_table_info('settlement_snapshots') WHERE name='approved_receipts_person_2_halalas'").get());
    const auditSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get().sql; assert.match(auditSql, /settlement_snapshot/); database.prepare("INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id) VALUES ('s3_audit_probe','migration-probe','CREATE','uid-one','2026-08-12T00:00:00.000Z',NULL,'{}','prb-test','migration-audit')").run(); assert.throws(() => database.exec("UPDATE audit_log SET action='UPDATE'"), /audit log is append only/); const triggerSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_settlement_snapshots_no_delete'").get().sql; assert.match(triggerSql, /settlement_snapshots are append only/);
  } finally { database.close(); }
});

test('PR-B D1 query and bind budgets remain bounded for large settlement and child histories', async () => {
  const { database, env } = fixture();
  try {
    const { customer } = await setupWork(env, 'PR-B Query Budget Seed'); const createdAt = '2026-08-12T00:00:00.000Z';
    for (let i = 0; i < 70; i += 1) database.prepare(`INSERT INTO works(id,customer_id,title,country,created_by,created_at,updated_by,updated_at,confirmed_at,version) VALUES (?,?,?,?,?,?,?,?,?,1)`).run(`budget-work-${i}`, customer.id, `Synthetic Budget Work ${i}`, 'SA', 'uid-one', createdAt, 'uid-one', createdAt, createdAt);
    database.readQueries = 0; database.bindingWidths = []; const preview = await getSettlementPreview(env, '2026-08', settlementInput()); assert.equal(preview.work_count, 71); assert.equal(database.readQueries, 9); const maxBind = Math.max(...database.bindingWidths); assert.ok(maxBind <= 100); console.log(`S7_PR_B_D1_MEASUREMENT settlement_queries=${database.readQueries} settlement_max_bind=${maxBind} works=${preview.work_count}`);
    database.readQueries = 0; await listInterPartyTransfers(env); const transferQueries = database.readQueries; database.readQueries = 0; await listSubscriptionHistory(env); const subscriptionQueries = database.readQueries; database.readQueries = 0; await listCommonExpenses(env); const expenseQueries = database.readQueries; assert.equal(transferQueries, 1); assert.equal(subscriptionQueries, 1); assert.equal(expenseQueries, 1); console.log(`S7_PR_B_D1_MEASUREMENT transfer_queries=${transferQueries} subscription_queries=${subscriptionQueries} expense_queries=${expenseQueries}`);
  } finally { database.close(); }
});
