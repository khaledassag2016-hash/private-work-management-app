import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCatalogValue, createCustomer, createWork, createPriceChangeRequest, approvePriceChangeRequest,
  createClientPayment, createInterPartyTransfer, listInterPartyTransfers,
  createSubscriptionHistory, listSubscriptionHistory, createCommonExpense, listCommonExpenses,
  getSettlementPreview, closeSettlement, listSettlementSnapshots,
  createSettlementReopenRequest, approveSettlementReopenRequest, listSettlementReopenRequests,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const migration7Path = fileURLToPath(new URL('../../src/worker/migrations/0007_s7_payments_collections_reversals.sql', import.meta.url));
const migration8Path = fileURLToPath(new URL('../../src/worker/migrations/0008_s7_pr_b_settlement_core.sql', import.meta.url));
const fullSchema = readFileSync(schemaPath, 'utf8');
const s7Marker = '\n-- S7 PR-A Payments / Collections / Reversal Core.';
const s6Schema = fullSchema.slice(0, fullSchema.indexOf(s7Marker));

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
  const work = await createWork(env, 'uid-one', `work-${title}`, { customer_id: customer.id, title, country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University' });
  return { customer, work };
}
async function price(env, work, request = 'prb-price') {
  const req = await createPriceChangeRequest(env, 'uid-one', `${request}-request`, work.id, { version: work.version, movement_type: 'BASE', amount_riyals: '1700.00', reason: 'Synthetic approved S6 price', effective_at: '2026-08-12T00:00:00.000Z' });
  return approvePriceChangeRequest(env, 'uid-two', `${request}-approval`, work.id, req.id);
}
const settlementInput = (extra = {}) => ({ period_basis: 'WORK_CREATED_AT', balance_formula: 'PERSON_2_NET_POSITION_BEFORE_RECEIPTS', ...extra });

test('PR-B transfers preserve explicit direction and P-03 fee separation', async () => {
  const { database, env } = fixture();
  try {
    const transfer = await createInterPartyTransfer(env, 'uid-one', 'prb-transfer-1', { amount_riyals: '100.00', fee_riyals: '1.01', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1', note: 'Synthetic transfer' });
    assert.equal(transfer.amount_halalas, 10000); assert.equal(transfer.fee_halalas, 101); assert.equal(transfer.from_party, 'person_1'); assert.equal((await listInterPartyTransfers(env)).length, 1);
    assert.throws(() => database.exec('UPDATE inter_party_transfers SET amount_halalas=1'), /inter_party_transfers are append only/);
    assert.throws(() => database.exec('DELETE FROM inter_party_transfers'), /inter_party_transfers are append only/);
    const preview = await getSettlementPreview(env, '2026-08', settlementInput());
    assert.equal(preview.transfer_amount_halalas, 10000); assert.equal(preview.transfer_fee_halalas, 101); assert.equal(preview.subscription_effect_person_1_halalas, -6825); assert.equal(preview.subscription_effect_person_2_halalas, 6825);
  } finally { database.close(); }
});

test('PR-B subscriptions preserve P-01 13650 baseline and prospective P-02 burden', async () => {
  const { database, env } = fixture();
  try {
    assert.equal((await getSettlementPreview(env, '2026-08', settlementInput())).subscription_total_halalas, 13650);
    const active = await createSubscriptionHistory(env, 'uid-two', 'prb-sub-baseline', { aggregate_amount_riyals: '136.50', effective_at: '2026-08-01T00:00:00.000Z' });
    assert.equal(active.subscription_count, 2); assert.equal(active.aggregate_amount_halalas, 13650); assert.equal(active.paid_by_uid, 'uid-two');
    await createSubscriptionHistory(env, 'uid-two', 'prb-sub-change', { aggregate_amount_riyals: '200.00', effective_at: '2026-09-01T00:00:00.000Z' });
    await createSubscriptionHistory(env, 'uid-two', 'prb-sub-cancel', { state: 'CANCELLED', effective_at: '2026-10-01T00:00:00.000Z' });
    assert.equal((await listSubscriptionHistory(env)).length, 3); assert.equal((await getSettlementPreview(env, '2026-09', settlementInput())).subscription_total_halalas, 20000); assert.equal((await getSettlementPreview(env, '2026-10', settlementInput())).subscription_total_halalas, 0);
    assert.ok(!('name' in active) && !('item_amounts' in active));
  } finally { database.close(); }
});

test('PR-B generic expenses preserve facts and fail closed on invented allocation', async () => {
  const { database, env } = fixture();
  try {
    const expense = await createCommonExpense(env, 'uid-one', 'prb-expense-1', { amount_riyals: '50.00', effective_at: '2026-08-12T09:00:00.000Z', category: 'Synthetic shared expense', paid_by_uid: 'uid-two' });
    assert.equal(expense.amount_halalas, 5000); assert.equal(expense.allocation_policy, 'UNRESOLVED'); assert.equal((await listCommonExpenses(env)).length, 1);
    const preview = await getSettlementPreview(env, '2026-08', settlementInput()); assert.equal(preview.governed_expense_total_halalas, 5000); assert.equal(preview.generic_expense_allocation, 'UNRESOLVED'); assert.equal(preview.unresolved_code, 'S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED');
    assert.throws(() => database.exec('UPDATE common_expenses SET amount_halalas=1'), /common_expenses are append only/); assert.throws(() => database.exec('DELETE FROM common_expenses'), /common_expenses are append only/);
  } finally { database.close(); }
});

test('PR-B settlement components consume S6 price authority, receipts, transfers, subscriptions, and D-012 rounding', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Settlement Components'); await price(env, work, 'prb-components');
    await createClientPayment(env, 'uid-one', 'prb-components-payment', work.id, { version: 2, amount_riyals: '1000.00', effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'BANK_TRANSFER' });
    await createInterPartyTransfer(env, 'uid-one', 'prb-components-transfer', { amount_riyals: '100.00', fee_riyals: '1.01', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' });
    const preview = await getSettlementPreview(env, '2026-08', settlementInput({ prior_balance_riyals: '10.00' }));
    assert.equal(preview.work_count, 1); assert.equal(preview.total_work_value_halalas, 170000); assert.equal(preview.person_1_work_share_halalas, 51000); assert.equal(preview.person_2_work_share_halalas, 119000); assert.equal(preview.approved_receipts_halalas, 100000); assert.equal(preview.final_balance_halalas, 72548); assert.equal(preview.unresolved_code, null);
  } finally { database.close(); }
});

test('PR-B D-011 soft-close and reopen require dual approval in both directions and preserve history', async () => {
  const { database, env } = fixture();
  try {
    const closed = await closeSettlement(env, 'uid-one', 'prb-close-aug', '2026-08', settlementInput()); assert.equal(closed.state, 'CLOSED'); assert.equal((await listSettlementSnapshots(env, '2026-08')).length, 1);
    await assert.rejects(createInterPartyTransfer(env, 'uid-one', 'prb-closed-transfer', { amount_riyals: '10.00', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' }), /CLOSED_PERIOD_MUTATION_FORBIDDEN/);
    const first = await createSettlementReopenRequest(env, 'uid-one', 'prb-reopen-aug', '2026-08', { reason: 'Synthetic reopen' }); assert.equal((await listSettlementReopenRequests(env, '2026-08'))[0].state, 'PENDING'); await assert.rejects(approveSettlementReopenRequest(env, 'uid-one', 'prb-reopen-self', '2026-08', first.id), /SELF_APPROVAL_REJECTED/); await approveSettlementReopenRequest(env, 'uid-two', 'prb-reopen-aug-approval', '2026-08', first.id); await assert.rejects(approveSettlementReopenRequest(env, 'uid-two', 'prb-reopen-duplicate', '2026-08', first.id), /ALREADY_FINALIZED/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM settlement_reopen_history WHERE period_key=?').get('2026-08').count, 1);
    assert.equal((await createInterPartyTransfer(env, 'uid-one', 'prb-after-reopen-transfer', { amount_riyals: '10.00', effective_at: '2026-08-12T10:00:00.000Z', from_party: 'person_1', to_party: 'person_2', fee_payer: 'person_1' })).amount_halalas, 1000);
    await closeSettlement(env, 'uid-two', 'prb-close-sep', '2026-09', settlementInput()); const second = await createSettlementReopenRequest(env, 'uid-two', 'prb-reopen-sep', '2026-09', { reason: 'Synthetic reverse direction' }); await approveSettlementReopenRequest(env, 'uid-one', 'prb-reopen-sep-approval', '2026-09', second.id);
  } finally { database.close(); }
});

test('PR-B migration preservation retains PR-A/S6 rows and installs append-only transfer and settlement audit guards', async () => {
  const { database, env } = fixture(s6Schema);
  try {
    await setupWork(env, 'PR-B Migration'); const before = database.prepare('SELECT COUNT(*) AS count FROM works').get().count; database.exec(readFileSync(migration7Path, 'utf8')); database.exec(readFileSync(migration8Path, 'utf8')); assert.equal(database.prepare('SELECT COUNT(*) AS count FROM works').get().count, before);
    for (const table of ['inter_party_transfers','subscription_history','common_expenses','settlement_snapshots','settlement_reopen_requests','settlement_reopen_history']) assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    const auditSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get().sql; assert.match(auditSql, /settlement_snapshot/); assert.throws(() => database.exec("UPDATE audit_log SET action='UPDATE'"), /audit log is append only/); const triggerSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_settlement_snapshots_no_delete'").get().sql; assert.match(triggerSql, /settlement_snapshots are append only/);
  } finally { database.close(); }
});

test('PR-B D1 query and bind budgets remain bounded for large settlement and child histories', async () => {
  const { database, env } = fixture();
  try {
    const { customer } = await setupWork(env, 'PR-B Query Budget Seed'); const createdAt = '2026-08-12T00:00:00.000Z';
    for (let i = 0; i < 70; i += 1) database.prepare(`INSERT INTO works(id,customer_id,title,country,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,?,?,?,1)`).run(`budget-work-${i}`, customer.id, `Synthetic Budget Work ${i}`, 'SA', 'uid-one', createdAt, 'uid-one', createdAt);
    database.readQueries = 0; database.bindingWidths = []; const preview = await getSettlementPreview(env, '2026-08', settlementInput()); assert.equal(preview.work_count, 71); assert.equal(database.readQueries, 8); const maxBind = Math.max(...database.bindingWidths); assert.ok(maxBind <= 100); console.log(`S7_PR_B_D1_MEASUREMENT settlement_queries=${database.readQueries} settlement_max_bind=${maxBind} works=${preview.work_count}`);
    database.readQueries = 0; await listInterPartyTransfers(env); const transferQueries = database.readQueries; database.readQueries = 0; await listSubscriptionHistory(env); const subscriptionQueries = database.readQueries; database.readQueries = 0; await listCommonExpenses(env); const expenseQueries = database.readQueries; assert.equal(transferQueries, 1); assert.equal(subscriptionQueries, 1); assert.equal(expenseQueries, 1); console.log(`S7_PR_B_D1_MEASUREMENT transfer_queries=${transferQueries} subscription_queries=${subscriptionQueries} expense_queries=${expenseQueries}`);
  } finally { database.close(); }
});
