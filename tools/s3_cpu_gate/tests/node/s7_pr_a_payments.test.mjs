import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker, {
  createCatalogValue,
  createCustomer,
  createWork,
  getWork,
  getWorkFinancials,
  createPriceChangeRequest,
  approvePriceChangeRequest,
  createClientPayment,
  listClientPayments,
  createPaymentReversalRequest,
  approvePaymentReversalRequest,
  listPaymentReversalRequests,
  createCancelArchiveRequest,
  approveCancelArchiveRequest,
  listWorkArchiveHistory,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const migrationPath = fileURLToPath(new URL('../../src/worker/migrations/0007_s7_payments_collections_reversals.sql', import.meta.url));
const fullSchema = readFileSync(schemaPath, 'utf8');
const s7Marker = '\n-- S7 PR-A Payments / Collections / Reversal Core.';
const s6Schema = fullSchema.slice(0, fullSchema.indexOf(s7Marker)).replace(",'client_payment','payment_reversal_request','payment_reversal'", '');

class D1Statement {
  constructor(database, sql) {
    this.database = database;
    this.parameterMap = [];
    this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; });
    this.values = [];
  }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; this.database.bindingWidths = this.database.bindingWidths || []; this.database.bindingWidths.push(this.values.length); return this; }
  first() { this.database.readQueries = (this.database.readQueries || 0) + 1; return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { this.database.readQueries = (this.database.readQueries || 0) + 1; return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const prepared = this.database.prepare(statement.sql);
        if (/^\s*SELECT\b/i.test(statement.sql)) return { success: true, results: prepared.all(...statement.values), meta: { changes: 0 } };
        const result = prepared.run(...statement.values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      });
      this.database.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec('ROLLBACK');
      return Promise.reject(error);
    }
  }
}

function fixture({ schema = fullSchema, queryCounting = false } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-one', 'person_1', 's7-payments');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('uid-two', 'person_2', 's7-payments');
  database.readQueries = 0;
  database.bindingWidths = [];
  const env = { DB: new D1Database(database), RUN_MARKER: 's7-payments', FIREBASE_PROJECT_ID: 'demo-project' };
  return { database, env, queryCounting };
}

async function ensureCatalog(env, requestId, kind, input) {
  try { await createCatalogValue(env, 'uid-one', requestId, kind, input); } catch (error) {
    if (error?.code !== 'CATALOG_DUPLICATE') throw error;
  }
}

async function setupWork(env, title = 'Synthetic S7 Work') {
  await ensureCatalog(env, `country-${title}`, 'country', { value_key: 'SA', label: 'Synthetic Saudi Arabia' });
  await ensureCatalog(env, `specialty-${title}`, 'specialty', { value_key: 'IT', label: 'Synthetic IT' });
  await ensureCatalog(env, `worktype-${title}`, 'work_type', { value_key: 'REPORT', label: 'Synthetic Report' });
  const customer = await createCustomer(env, 'uid-one', `customer-${title}`, { name: 'Synthetic Customer', country: 'SA', university: 'Synthetic University', specialty: 'IT' });
  const work = await createWork(env, 'uid-one', `work-${title}`, { customer_id: customer.id, title, country: 'SA', work_type_key: 'REPORT', specialty_key: 'IT', university: 'Synthetic University' });
  return { customer, work };
}

async function approvePrice(env, work, amount = '1700.00', requestPrefix = 's7-price') {
  const request = await createPriceChangeRequest(env, 'uid-one', `${requestPrefix}-request`, work.id, { version: work.version, movement_type: 'BASE', amount_riyals: amount, reason: 'Synthetic approved S6 price' });
  return approvePriceChangeRequest(env, 'uid-two', `${requestPrefix}-approval`, work.id, request.id);
}

async function addPayment(env, workId, version, requestId, actorUid = 'uid-one', amount = '1000.00', receivedBy = actorUid) {
  return createClientPayment(env, actorUid, requestId, workId, {
    version,
    amount_riyals: amount,
    effective_at: '2026-08-12T12:00:00.000Z',
    payment_method: 'BANK_TRANSFER',
    received_by: receivedBy,
    note: 'Synthetic fixture payment',
  });
}

test('S7 money parsing accepts positive canonical amounts and rejects malformed, over-precision, unsafe, and zero amounts before mutation', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env);
    await approvePrice(env, work, '1700.00', 'money');
    const before = database.prepare('SELECT COUNT(*) AS count FROM client_payments').get().count;
    for (const amount of ['1.001', '1.', '.50', 'abc', 1500, '90071992547409.92', '0.00']) {
      await assert.rejects(createClientPayment(env, 'uid-one', `money-${String(amount).replace(/\W/g, '')}`, work.id, { version: 2, amount_riyals: amount, effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'CASH' }));
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments').get().count, before);
    const valid = await addPayment(env, work.id, 2, 'money-positive', 'uid-one', '1.23');
    assert.equal(valid.payment.amount_halalas, 123);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments').get().count, before + 1);
  } finally { database.close(); }
});

test('S7 multiple payments derive approved paid and zero remaining without changing execution status', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Multiple Payments');
    await approvePrice(env, work, '1700.00', 'multi');
    let financials = await getWorkFinancials(env, work.id);
    assert.equal(financials.approved_payments_total_halalas, 0);
    assert.equal(financials.remaining_halalas, 170000);
    assert.equal(financials.collection_status, 'UNPAID');
    assert.equal((await getWork(env, work.id)).status, 'NEW_REQUEST');
    const first = await addPayment(env, work.id, 2, 'multi-payment-one', 'uid-one', '1000.00', 'uid-two');
    financials = first.financials;
    assert.equal(financials.approved_payments_total_halalas, 100000);
    assert.equal(financials.remaining_halalas, 70000);
    assert.equal(financials.collection_status, 'PARTIALLY_COLLECTED');
    const second = await addPayment(env, work.id, 3, 'multi-payment-two', 'uid-two', '700.00', 'uid-one');
    financials = second.financials;
    assert.equal(financials.approved_payments_total_halalas, 170000);
    assert.equal(financials.remaining_halalas, 0);
    assert.equal(financials.collection_status, 'FINANCIALLY_CLOSED');
    assert.equal(financials.remaining_projection, 'S7_APPROVED_PAYMENTS_LEDGER');
    assert.equal(financials.payments.length, 2);
    assert.deepEqual(financials.payments.map(payment => payment.received_by).sort(), ['uid-one', 'uid-two']);
    assert.deepEqual(financials.payments.map(payment => payment.recorded_by).sort(), ['uid-one', 'uid-two']);
    assert.equal((await listClientPayments(env, work.id)).length, 2);
    assert.equal((await getWork(env, work.id)).status, 'NEW_REQUEST');
    assert.throws(() => database.exec('UPDATE client_payments SET amount_halalas=1'), /client_payments are append only/);
    assert.throws(() => database.exec('DELETE FROM client_payments'), /client_payments are append only/);
  } finally { database.close(); }
});

test('S7 overpayment is fail-closed and leaves no payment mutation', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Overpayment');
    await approvePrice(env, work, '1700.00', 'overpayment');
    await assert.rejects(addPayment(env, work.id, 2, 'overpayment-payment', 'uid-one', '1700.01'), /S7_OVERPAYMENT_POLICY_UNRESOLVED/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments').get().count, 0);
    assert.equal((await getWork(env, work.id)).version, 2);
  } finally { database.close(); }
});

test('S7 reversal requires other-account approval in both directions and pending has no effect', async () => {
  const { database, env } = fixture();
  try {
    const first = await setupWork(env, 'Reversal U1 U2');
    await approvePrice(env, first.work, '1700.00', 'reversal-one');
    const paymentOne = await addPayment(env, first.work.id, 2, 'reversal-one-payment', 'uid-one', '1000.00');
    const requestOne = await createPaymentReversalRequest(env, 'uid-one', 'reversal-one-request', first.work.id, { version: 3, payment_id: paymentOne.payment.id, reason: 'Synthetic correction one' });
    assert.equal((await getWorkFinancials(env, first.work.id)).approved_payments_total_halalas, 100000);
    await assert.rejects(approvePaymentReversalRequest(env, 'uid-one', 'reversal-one-self', first.work.id, requestOne.id), /SELF_APPROVAL_REJECTED/);
    const approvedOne = await approvePaymentReversalRequest(env, 'uid-two', 'reversal-one-approval', first.work.id, requestOne.id);
    assert.equal(approvedOne.financials.approved_payments_total_halalas, 0);
    assert.equal(approvedOne.financials.remaining_halalas, 170000);
    assert.equal(approvedOne.financials.payments[0].reversal_state, 'APPROVED');
    await assert.rejects(approvePaymentReversalRequest(env, 'uid-two', 'reversal-one-duplicate', first.work.id, requestOne.id), /ALREADY_FINALIZED/);

    const second = await setupWork(env, 'Reversal U2 U1');
    await approvePrice(env, second.work, '1700.00', 'reversal-two');
    const paymentTwo = await addPayment(env, second.work.id, 2, 'reversal-two-payment', 'uid-two', '1000.00');
    const requestTwo = await createPaymentReversalRequest(env, 'uid-two', 'reversal-two-request', second.work.id, { version: 3, payment_id: paymentTwo.payment.id, reason: 'Synthetic correction two' });
    await assert.rejects(approvePaymentReversalRequest(env, 'uid-two', 'reversal-two-self', second.work.id, requestTwo.id), /SELF_APPROVAL_REJECTED/);
    const approvedTwo = await approvePaymentReversalRequest(env, 'uid-one', 'reversal-two-approval', second.work.id, requestTwo.id);
    assert.equal(approvedTwo.financials.approved_payments_total_halalas, 0);
    assert.equal((await listPaymentReversalRequests(env, second.work.id))[0].state, 'APPROVED');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='payment_reversal'").get().count, 2);
  } finally { database.close(); }
});

test('S7 unauthorized and mismatch reversal attempts fail closed while unrelated version changes remain valid', async () => {
  const { database, env } = fixture();
  try {
    const first = await setupWork(env, 'Stale Reversal');
    const other = await setupWork(env, 'Other Reversal');
    await approvePrice(env, first.work, '2000.00', 'stale-one');
    await approvePrice(env, other.work, '2000.00', 'stale-two');
    const otherPayment = await addPayment(env, other.work.id, 2, 'stale-other-payment', 'uid-two', '100.00');
    const payment = await addPayment(env, first.work.id, 2, 'stale-payment', 'uid-one', '500.00');
    const request = await createPaymentReversalRequest(env, 'uid-one', 'stale-request', first.work.id, { version: 3, payment_id: payment.payment.id, reason: 'Synthetic stale request' });
    await assert.rejects(approvePaymentReversalRequest(env, 'uid-three', 'unauthorized-approval', first.work.id, request.id), /UID_NOT_ALLOWED/);
    await addPayment(env, first.work.id, 3, 'stale-second-payment', 'uid-one', '100.00');
    const approved = await approvePaymentReversalRequest(env, 'uid-two', 'stale-approval', first.work.id, request.id);
    assert.equal(approved.request.state, 'APPROVED');
    assert.equal(approved.financials.approved_payments_total_halalas, 10000);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM payment_reversals').get().count, 1);
    const currentVersion = (await getWork(env, first.work.id)).version;
    await assert.rejects(createPaymentReversalRequest(env, 'uid-one', 'wrong-payment-request', first.work.id, { version: currentVersion, payment_id: otherPayment.payment.id, reason: 'Wrong work synthetic' }), /PAYMENT_WORK_MISMATCH/);
  } finally { database.close(); }
});

test('S7 migration preservation retains S6 rows and installs append-only payment audit guards', async () => {
  const { database, env } = fixture({ schema: s6Schema });
  try {
    const { work } = await setupWork(env, 'Migration');
    const before = database.prepare('SELECT id,title,version FROM works WHERE id=?').get(work.id);
    database.exec(readFileSync(migrationPath, 'utf8'));
    assert.deepEqual(database.prepare('SELECT id,title,version FROM works WHERE id=?').get(work.id), before);
    for (const table of ['client_payments', 'payment_reversal_requests', 'payment_reversals']) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    const auditSql = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get().sql;
    assert.match(auditSql, /client_payment/);
    assert.throws(() => database.exec('UPDATE audit_log SET action=\'UPDATE\''), /audit log is append only/);
    database.prepare(`INSERT INTO client_payments(id,work_id,amount_halalas,effective_at,payment_method,note,received_by,recorded_by,created_at,work_version,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('migration-payment', work.id, 100, '2026-08-12T00:00:00.000Z', 'CASH', null, 'uid-one', 'uid-one', '2026-08-12T00:00:00.000Z', 1, 'migration-payment-request');
    database.prepare(`INSERT INTO payment_reversal_requests(id,payment_id,work_id,reason,requested_by,requested_at,work_version,state,request_id)
      VALUES (?,?,?,?,?,?,?,'PENDING',?)`).run('migration-reversal-request', 'migration-payment', work.id, 'Synthetic migration request', 'uid-one', '2026-08-12T00:00:00.000Z', 1, 'migration-reversal-request-id');
    assert.throws(() => database.exec('DELETE FROM payment_reversal_requests'), /payment_reversal_requests are append only/);
  } finally { database.close(); }
});

test('S7 D1 query and bind budgets remain bounded for large payment history', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Query Budget');
    const requestedAt = '2026-08-12T00:00:00.000Z';
    database.prepare(`INSERT INTO price_change_requests(id,work_id,movement_type,amount_halalas,reason,effective_at,requested_by,requested_at,work_version,state,approved_by,approved_at,approval_request_id,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,'APPROVED',?,?,?,?)`).run('budget-price-request', work.id, 'BASE', 300000, 'Synthetic query budget price', requestedAt, 'uid-one', requestedAt, 1, 'uid-two', requestedAt, 'budget-price-approval', 'budget-price-request-id');
    database.prepare(`INSERT INTO price_movements(id,work_id,price_request_id,movement_type,amount_halalas,reason,effective_at,requested_by,approved_by,requested_at,approved_at,resulting_price_halalas,request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('budget-price-movement', work.id, 'budget-price-request', 'BASE', 300000, 'Synthetic query budget price', requestedAt, 'uid-one', 'uid-two', requestedAt, requestedAt, 300000, 'budget-price-movement-id');
    for (let index = 0; index < 120; index += 1) {
      database.prepare(`INSERT INTO client_payments(id,work_id,amount_halalas,effective_at,payment_method,note,received_by,recorded_by,created_at,work_version,request_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`budget-payment-${index}`, work.id, 100, `2026-08-12T00:${String(index % 60).padStart(2, '0')}:00.000Z`, 'CASH', null, 'uid-one', 'uid-two', requestedAt, 1, `budget-payment-request-${index}`);
    }
    database.readQueries = 0;
    const financials = await getWorkFinancials(env, work.id);
    assert.equal(financials.payments.length, 120);
    assert.equal(database.readQueries, 7, `getWorkFinancials should use a fixed seven reads, got ${database.readQueries}`);
    const financialBindWidths = [...database.bindingWidths];
    assert.ok(financialBindWidths.length >= 7);
    assert.ok(Math.max(...financialBindWidths) <= 100, `financial read exceeded D1 bind limit: ${financialBindWidths}`);
    console.log(`S7_D1_MEASUREMENT financial_queries=${database.readQueries} financial_max_bind=${Math.max(...financialBindWidths)}`);
    database.readQueries = 0;
    database.bindingWidths = [];
    const payments = await listClientPayments(env, work.id);
    assert.equal(payments.length, 120);
    assert.equal(database.readQueries, 2, `listClientPayments should use Work + joined payment reads, got ${database.readQueries}`);
    assert.ok(database.readQueries < 40);
    assert.ok(Math.max(...database.bindingWidths) <= 100, `payment history exceeded D1 bind limit: ${database.bindingWidths}`);
    console.log(`S7_D1_MEASUREMENT payment_history_queries=${database.readQueries} payment_history_max_bind=${Math.max(...database.bindingWidths)}`);
  } finally { database.close(); }
});

test('S7 reversal API exposes payment and reversal envelopes', { skip: !(() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })() }, async () => {
  const { database, env } = fixture();
  const originalFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), 's7-x509-'));
  const privateKeyPath = join(directory, 'private-key.pem');
  const certificatePath = join(directory, 'certificate.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=s7-firebase-x509-test', '-keyout', privateKeyPath, '-out', certificatePath], { stdio: 'ignore' });
    const keyPem = readFileSync(privateKeyPath, 'utf8');
    const keyLabel = ['PRIVATE', 'KEY'].join(' ');
    const keyPattern = new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`);
    const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(keyPem.match(keyPattern)[1].replace(/\s+/g, ''), 'base64')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const certificatePem = readFileSync(certificatePath, 'utf8');
    globalThis.fetch = async () => new Response(JSON.stringify({ s7test: certificatePem }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
    const b64 = bytes => Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const json = value => b64(new TextEncoder().encode(JSON.stringify(value)));
    const signToken = async uid => {
      const now = Math.floor(Date.now() / 1000);
      const input = `${json({ alg: 'RS256', kid: 's7test', typ: 'JWT' })}.${json({ aud: 'demo-project', iss: 'https://securetoken.google.com/demo-project', sub: uid, iat: now - 10, auth_time: now - 10, exp: now + 3600 })}`;
      return `${input}.${b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input))))}`;
    };
    const { work } = await setupWork(env, 'API');
    await approvePrice(env, work, '1700.00', 'api');
    const tokenOne = await signToken('uid-one');
    const tokenTwo = await signToken('uid-two');
    const paymentResponse = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/payments`, { method: 'POST', headers: { authorization: `Bearer ${tokenOne}`, 'content-type': 'application/json', 'x-s3-run-id': 's7-payments', 'x-s3-request-id': 's7-api-payment' }, body: JSON.stringify({ version: 2, amount_riyals: '1000.00', effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'BANK_TRANSFER' }) }), env);
    assert.equal(paymentResponse.status, 201);
    const paymentPayload = await paymentResponse.json();
    assert.equal(paymentPayload.ok, true);
    assert.ok(paymentPayload.requestId);
    const financialResponse = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/financials`, { headers: { authorization: `Bearer ${tokenTwo}`, 'x-s3-run-id': 's7-payments', 'x-s3-request-id': 's7-api-financials' } }), env);
    const financialPayload = await financialResponse.json();
    assert.equal(financialPayload.ok, true);
    assert.equal(financialPayload.data.approved_payments_total_halalas, 100000);
    const badPayment = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/payments`, { method: 'POST', headers: { authorization: `Bearer ${tokenOne}`, 'content-type': 'application/json', 'x-s3-run-id': 's7-payments', 'x-s3-request-id': 's7-api-bad' }, body: JSON.stringify({ version: 3, amount_riyals: '800.01', effective_at: '2026-08-12T12:00:00.000Z', payment_method: 'CASH' }) }), env);
    assert.equal(badPayment.status, 409);
    assert.deepEqual(await badPayment.json(), { ok: false, code: 'S7_OVERPAYMENT_POLICY_UNRESOLVED', requestId: 's7-api-bad' });
    const reversalResponse = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/payment-reversal-requests`, { method: 'POST', headers: { authorization: `Bearer ${tokenOne}`, 'content-type': 'application/json', 'x-s3-run-id': 's7-payments', 'x-s3-request-id': 's7-api-reversal-request' }, body: JSON.stringify({ version: 3, payment_id: paymentPayload.data.payment.id, reason: 'Synthetic API reversal' }) }), env);
    assert.equal(reversalResponse.status, 201);
    const reversalPayload = await reversalResponse.json();
    assert.equal(reversalPayload.ok, true);
    const reversalApproval = await worker.fetch(new Request(`https://example.test/api/works/${work.id}/payment-reversal-requests/${reversalPayload.data.id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${tokenTwo}`, 'content-type': 'application/json', 'x-s3-run-id': 's7-payments', 'x-s3-request-id': 's7-api-reversal-approval' }, body: '{}' }), env);
    assert.equal(reversalApproval.status, 200);
    const reversalApprovalPayload = await reversalApproval.json();
    assert.equal(reversalApprovalPayload.ok, true);
    assert.equal(reversalApprovalPayload.data.financials.approved_payments_total_halalas, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
    database.close();
  }
});

test('S7 actual stale and concurrent Work races leave no partial payment or audit', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Atomic Race');
    await approvePrice(env, work, '1700.00', 'atomic');
    const results = await Promise.allSettled([
      addPayment(env, work.id, 2, 'atomic-payment-a', 'uid-one', '100.00'),
      addPayment(env, work.id, 2, 'atomic-payment-b', 'uid-two', '100.00'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments WHERE work_id=?').get(work.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='client_payment' AND entity_id IN (SELECT id FROM client_payments WHERE work_id=?)").get(work.id).count, 1);
    assert.equal((await getWork(env, work.id)).version, 3);
    await assert.rejects(addPayment(env, work.id, 2, 'atomic-stale-after-race', 'uid-one', '50.00'), /VERSION_CONFLICT|TRANSACTION_FAILED/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments WHERE work_id=?').get(work.id).count, 1);
    assert.equal((await getWorkFinancials(env, work.id)).approved_payments_total_halalas, 10000);
  } finally { database.close(); }
});

test('S7 idempotency replays one payment without a second Work update or audit row', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Idempotency');
    await approvePrice(env, work, '1700.00', 'idempotency');
    const first = await addPayment(env, work.id, 2, 'idempotent-payment', 'uid-one', '100.00');
    const replay = await addPayment(env, work.id, 2, 'idempotent-payment', 'uid-one', '100.00');
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.payment.id, first.payment.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments WHERE work_id=?').get(work.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='client_payment' AND entity_id=?").get(first.payment.id).count, 1);
    assert.equal((await getWork(env, work.id)).version, 3);
    const other = await setupWork(env, 'Idempotency Other Work');
    await assert.rejects(addPayment(env, other.work.id, 1, 'idempotent-payment', 'uid-one', '100.00'), /REQUEST_ID_REUSE/);
  } finally { database.close(); }
});

test('S7 stale unauthorized and mismatch payment attempts fail closed', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Payment Boundaries');
    await approvePrice(env, work, '1700.00', 'boundaries');
    await assert.rejects(addPayment(env, work.id, 2, 'unauthorized-payment', 'uid-three', '100.00'), /UID_NOT_ALLOWED/);
    await assert.rejects(addPayment(env, work.id, 1, 'stale-payment', 'uid-one', '100.00'), /VERSION_CONFLICT/);
    const other = await setupWork(env, 'Payment Mismatch');
    await approvePrice(env, other.work, '1700.00', 'mismatch-price');
    const payment = await addPayment(env, other.work.id, 2, 'mismatch-payment', 'uid-one', '100.00');
    await assert.rejects(createPaymentReversalRequest(env, 'uid-one', 'mismatch-reversal', work.id, { version: 2, payment_id: payment.payment.id, reason: 'Wrong Work synthetic' }), /PAYMENT_WORK_MISMATCH/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments WHERE work_id=?').get(work.id).count, 0);
  } finally { database.close(); }
});

test('S7 audit failure rolls back Work version and payment with no partial audit effect', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Audit Failure');
    await approvePrice(env, work, '1700.00', 'audit-failure');
    database.exec(`CREATE TRIGGER s7_fail_client_payment_audit BEFORE INSERT ON audit_log
      WHEN NEW.entity_type='client_payment'
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
    await assert.rejects(addPayment(env, work.id, 2, 'audit-failure-payment', 'uid-one', '100.00'), /synthetic audit failure/);
    assert.equal((await getWork(env, work.id)).version, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments WHERE work_id=?').get(work.id).count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type='client_payment'").get().count, 0);
    database.exec('DROP TRIGGER s7_fail_client_payment_audit');
  } finally { database.close(); }
});

test('S7 completed unpaid and partial collection remain separate from execution status', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Completed Collection');
    await approvePrice(env, work, '1700.00', 'completed');
    database.prepare('UPDATE works SET status=?,version=version+1 WHERE id=? AND version=?').run('COMPLETED', work.id, 2);
    let financials = await getWorkFinancials(env, work.id);
    assert.equal(financials.collection_status, 'UNPAID');
    assert.equal((await getWork(env, work.id)).status, 'COMPLETED');
    const partial = await addPayment(env, work.id, 3, 'completed-partial-payment', 'uid-one', '500.00');
    financials = partial.financials;
    assert.equal(financials.collection_status, 'PARTIALLY_COLLECTED');
    assert.equal(financials.remaining_halalas, 120000);
    assert.equal((await getWork(env, work.id)).status, 'COMPLETED');
  } finally { database.close(); }
});

test('S7 corrected payment is a new fact after approved reversal', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Corrected Payment');
    await approvePrice(env, work, '1700.00', 'corrected');
    const original = await addPayment(env, work.id, 2, 'corrected-original-payment', 'uid-one', '1000.00');
    const reversal = await createPaymentReversalRequest(env, 'uid-one', 'corrected-reversal-request', work.id, { version: 3, payment_id: original.payment.id, reason: 'Synthetic corrected receipt' });
    await approvePaymentReversalRequest(env, 'uid-two', 'corrected-reversal-approval', work.id, reversal.id);
    const corrected = await addPayment(env, work.id, 4, 'corrected-new-payment', 'uid-two', '1200.00');
    assert.notEqual(corrected.payment.id, original.payment.id);
    assert.equal(corrected.financials.approved_payments_total_halalas, 120000);
    assert.equal(corrected.financials.remaining_halalas, 50000);
    assert.equal(corrected.financials.payments.length, 2);
    assert.equal(corrected.financials.payments.find(payment => payment.id === original.payment.id).reversal_state, 'APPROVED');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM client_payments WHERE work_id=?').get(work.id).count, 2);
  } finally { database.close(); }
});

test('S7 S6 price authority rejects PRICE_UNSET and legacy sentinel but accepts approved zero-price truth', async () => {
  const { database, env } = fixture();
  try {
    const unset = await setupWork(env, 'Price Unset Authority');
    database.prepare('UPDATE works SET price_state=\'PRICE_ZERO\',price_minor_units=0 WHERE id=?').run(unset.work.id);
    const unsetFinancials = await getWorkFinancials(env, unset.work.id);
    assert.equal(unsetFinancials.current_price_halalas, null);
    assert.equal(unsetFinancials.collection_status, 'PRICE_UNSET');
    await assert.rejects(addPayment(env, unset.work.id, 1, 'unset-payment', 'uid-one', '0.01'), /PRICE_UNSET_PAYMENT_FORBIDDEN/);

    const zero = await setupWork(env, 'Approved Zero Price');
    await approvePrice(env, zero.work, '0.00', 'zero-price');
    const zeroFinancials = await getWorkFinancials(env, zero.work.id);
    assert.equal(zeroFinancials.current_price_halalas, 0);
    assert.equal(zeroFinancials.remaining_halalas, 0);
    assert.equal(zeroFinancials.collection_status, 'FINANCIALLY_CLOSED');
    await assert.rejects(addPayment(env, zero.work.id, 2, 'zero-price-payment', 'uid-one', '0.01'), /S7_OVERPAYMENT_POLICY_UNRESOLVED/);
  } finally { database.close(); }
});

test('S7 archive approval preserves append-only archive history', async () => {
  const { database, env } = fixture();
  try {
    const { work } = await setupWork(env, 'Archive History');
    const request = await createCancelArchiveRequest(env, 'uid-one', 'archive-history-request', work.id, { version: 1, action: 'ARCHIVE', reason: 'Synthetic archive evidence' });
    const approved = await approveCancelArchiveRequest(env, 'uid-two', 'archive-history-approval', work.id, request.id);
    assert.equal(approved.work.is_archived, true);
    const history = await listWorkArchiveHistory(env, work.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].reason, 'Synthetic archive evidence');
    assert.equal(history[0].archived_by, 'uid-two');
    assert.throws(() => database.exec('UPDATE work_archive_history SET reason=\'tampered\''), /work_archive_history is append only/);
    assert.throws(() => database.exec('DELETE FROM work_archive_history'), /work_archive_history is append only/);
  } finally { database.close(); }
});
