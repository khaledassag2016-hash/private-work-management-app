import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from '../../src/worker/assets/vendor/xlsx-0.20.3.mjs';
import { generateS8Workbook, parseS8Workbook, safeS8ExportFilename } from '../../src/worker/assets/s8-export.mjs';
import worker, {
  createCatalogValue,
  getS8Analytics,
  getS8ClassificationExportDto,
  getS8CustomerExportDto,
  getS8FollowUpExportDto,
  getS8MonthExportDto,
  getS8WorkExportDto,
  getWorkFinancials,
} from '../../src/worker/src/index.js';

const schemaPath = fileURLToPath(new URL('../../src/worker/schema.sql', import.meta.url));
const vendorPath = fileURLToPath(new URL('../../src/worker/assets/vendor/xlsx-0.20.3.mjs', import.meta.url));
const vendorHashPath = fileURLToPath(new URL('../../src/worker/assets/vendor/XLSX-0.20.3-SHA256.txt', import.meta.url));
const schema = readFileSync(schemaPath, 'utf8');

class D1Statement {
  constructor(database, sql) { this.database = database; this.parameterMap = []; this.sql = sql.replace(/\?(\d+)/g, (_, index) => { this.parameterMap.push(Number(index)); return '?'; }); this.values = []; }
  bind(...values) { this.values = this.parameterMap.length ? this.parameterMap.map(index => values[index - 1]) : values; this.database.bindingWidths.push(this.values.length); return this; }
  first() { this.database.readQueries += 1; return this.database.prepare(this.sql).get(...this.values) || null; }
  all() { this.database.readQueries += 1; return { results: this.database.prepare(this.sql).all(...this.values) }; }
}
class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => {
        const prepared = this.database.prepare(statement.sql); const result = /^\s*SELECT\b/i.test(statement.sql) ? null : prepared.run(...statement.values);
        return { success: true, results: result ? [] : prepared.all(...statement.values), meta: { changes: result ? Number(result.changes) : 0 } };
      });
      this.database.exec('COMMIT'); return Promise.resolve(results);
    } catch (error) { this.database.exec('ROLLBACK'); return Promise.reject(error); }
  }
}
function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(schema); database.readQueries = 0; database.bindingWidths = [];
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('s8b-one', 'person_1', 's8-pr-b');
  database.prepare('INSERT INTO app_users(uid,role,active,run_marker) VALUES (?,?,1,?)').run('s8b-two', 'person_2', 's8-pr-b');
  return { database, env: { DB: new D1Database(database), RUN_MARKER: 's8-pr-b', FIREBASE_PROJECT_ID: 'demo-project' } };
}
function customer(database, id, name) {
  database.prepare('INSERT INTO customers(id,name,country,university,specialty,status,created_by,created_at,updated_by,updated_at,version) VALUES (?,?,?,?,?,\'normal\',?,?,?,?,1)').run(id, name, 'S8B_COUNTRY_A', 'Synthetic University A', 'S8B_SPECIALTY_A', 's8b-one', '2026-01-01T00:00:00.000Z', 's8b-one', '2026-01-01T00:00:00.000Z');
}
function work(database, id, { customerId = 'CUST-S8B-A', title = id, createdAt = '2026-08-10T00:00:00.000Z', confirmedAt = '2026-08-12T00:00:00.000Z', workType = 'TYPE_A', specialty = 'SPEC_A', country = 'S8B_COUNTRY_A', university = 'Synthetic University A', archivedAt = null } = {}) {
  database.prepare(`INSERT INTO works(id,customer_id,parent_work_id,relationship_kind,title,work_type_key,specialty_key,subject_or_course_code,country,university,status,description,quantity,price_state,price_minor_units,created_by,created_at,updated_by,updated_at,confirmed_at,version,archived_at,archived_by,archive_request_id)
    VALUES (?,?,NULL,'INDEPENDENT',?,?,?,?,?,?,'IN_PROGRESS',?,NULL,'PRICE_UNSET',NULL,?,?,?,?,?,1,?,?,?)`).run(id, customerId, title, workType, specialty, `COURSE-${id}`, country, university, `Synthetic description ${id}`, 's8b-one', createdAt, 's8b-one', createdAt, confirmedAt, archivedAt, archivedAt ? 's8b-two' : null, archivedAt ? `archive-${id}` : null);
}
function approvedPrice(database, workId, amount, suffix = workId) {
  const time = '2026-08-10T00:00:00.000Z'; const requestId = `price-req-${suffix}`;
  database.prepare('INSERT INTO price_change_requests(id,work_id,movement_type,amount_halalas,reason,effective_at,requested_by,requested_at,work_version,state,approved_by,approved_at,approval_request_id,request_id) VALUES (?,?,?,?,?,?,?,?,?,\'APPROVED\',?,?,?,?)').run(requestId, workId, 'BASE', amount, 'Synthetic approved price', time, 's8b-one', time, 1, 's8b-two', time, `price-approval-${suffix}`, `price-request-${suffix}`);
  database.prepare('INSERT INTO price_movements(id,work_id,price_request_id,movement_type,amount_halalas,reason,effective_at,requested_by,approved_by,requested_at,approved_at,resulting_price_halalas,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`price-move-${suffix}`, workId, requestId, 'BASE', amount, 'Synthetic approved price', time, 's8b-one', 's8b-two', time, time, amount, `price-move-request-${suffix}`);
}
function payment(database, workId, id, amount, { reversed = 0, note = 'Synthetic payment' } = {}) {
  const time = '2026-08-13T00:00:00.000Z';
  database.prepare('INSERT INTO client_payments(id,work_id,amount_halalas,effective_at,payment_method,note,received_by,recorded_by,created_at,work_version,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, workId, amount, time, 'BANK_TRANSFER', note, 's8b-two', 's8b-one', time, 1, `payment-request-${id}`);
  if (reversed) {
    const requestId = `reversal-request-${id}`;
    database.prepare('INSERT INTO payment_reversal_requests(id,payment_id,work_id,reason,requested_by,requested_at,work_version,state,approved_by,approved_at,approval_request_id,request_id) VALUES (?,?,?,?,?,?,?,\'APPROVED\',?,?,?,?)').run(requestId, id, workId, 'Synthetic correction', 's8b-one', time, 1, 's8b-two', time, `reversal-approval-${id}`, `reversal-request-id-${id}`);
    database.prepare('INSERT INTO payment_reversals(id,payment_id,reversal_request_id,work_id,amount_halalas,reason,requested_by,approved_by,requested_at,approved_at,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(`reversal-${id}`, id, requestId, workId, reversed, 'Synthetic correction', 's8b-one', 's8b-two', time, time, `reversal-final-${id}`);
  }
}
function event(database, workId, id, description = 'Synthetic follow-up') {
  database.prepare('INSERT INTO work_events(id,work_id,event_type,description,effective_at,created_at,actor_uid,request_id) VALUES (?,?,?,?,?,?,?,?)').run(id, workId, 'FOLLOW_UP', description, '2026-08-14T00:00:00.000Z', '2026-08-14T00:01:00.000Z', 's8b-one', `event-request-${id}`);
}
function seedAnalyticsFixture(database) {
  customer(database, 'CUST-S8B-A', 'Synthetic Customer A'); customer(database, 'CUST-S8B-B', 'Synthetic Customer B');
  work(database, 'WORK-S8B-A', { title: 'Synthetic Type A' }); approvedPrice(database, 'WORK-S8B-A', 10000); payment(database, 'WORK-S8B-A', 'PAY-S8B-A', 6000, { note: '=HYPERLINK("https://invalid.example","Synthetic")' }); event(database, 'WORK-S8B-A', 'EVENT-S8B-A', '=SUM(1,1)');
  work(database, 'WORK-S8B-B', { customerId: 'CUST-S8B-B', title: 'Synthetic Type B archived', workType: 'TYPE_B', specialty: 'SPEC_B', country: 'S8B_COUNTRY_B', university: 'Synthetic University B', archivedAt: '2026-08-20T00:00:00.000Z' }); approvedPrice(database, 'WORK-S8B-B', 10000); payment(database, 'WORK-S8B-B', 'PAY-S8B-B', 10000, { reversed: 2500 }); event(database, 'WORK-S8B-B', 'EVENT-S8B-B');
  work(database, 'WORK-S8B-D', { customerId: 'CUST-S8B-B', title: 'Synthetic Type A second price', workType: 'TYPE_A', specialty: 'SPEC_A', country: 'S8B_COUNTRY_A', university: 'Synthetic University A' }); approvedPrice(database, 'WORK-S8B-D', 5000);
  work(database, 'WORK-S8B-C', { customerId: 'CUST-S8B-B', title: 'Synthetic unspecified historical', createdAt: '2025-12-31T23:59:59.000Z', confirmedAt: null, workType: null, specialty: null, country: 'S8B_COUNTRY_A', university: null });
  database.prepare('INSERT INTO work_title_history(id,work_id,old_title,new_title,reason,changed_at,changed_by,request_id) VALUES (?,?,?,?,?,?,?,?)').run('TITLE-S8B-A', 'WORK-S8B-A', 'Synthetic old title', 'Synthetic Type A', 'Synthetic title history', '2026-08-11T00:00:00.000Z', 's8b-one', 'title-s8b-a');
  database.prepare('INSERT INTO work_status_history(id,work_id,old_status,new_status,reason,changed_at,changed_by,request_id) VALUES (?,?,?,?,?,?,?,?)').run('STATUS-S8B-A', 'WORK-S8B-A', 'NEW_REQUEST', 'IN_PROGRESS', 'Synthetic status history', '2026-08-11T00:00:00.000Z', 's8b-one', 'status-s8b-a');
  database.prepare('INSERT INTO documented_facts(id,customer_id,work_id,fact_type,source_ref,details_json,happened_at,created_by,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,1)').run('FACT-S8B-A', 'CUST-S8B-A', 'WORK-S8B-A', 'DELAY', 'Synthetic factual reference', '{"note":"synthetic"}', '2026-08-15T00:00:00.000Z', 's8b-one', '2026-08-15T00:01:00.000Z');
  database.prepare(`INSERT INTO settlement_snapshots(id,period_key,period_start,period_end,period_basis,balance_formula,state,work_count,cumulative_work_count,total_work_value_halalas,person_1_work_share_halalas,person_2_work_share_halalas,approved_receipts_halalas,approved_receipts_person_1_halalas,approved_receipts_person_2_halalas,transfer_amount_halalas,transfer_fee_halalas,subscription_total_halalas,subscription_effect_person_1_halalas,subscription_effect_person_2_halalas,governed_expense_total_halalas,prior_balance_halalas,final_balance_halalas,unresolved_code,version,created_by,created_at,request_id)
    VALUES (?,?,?,?,?,?,\'CLOSED\',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('SETTLEMENT-S8B-AUG', '2026-08', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'CONFIRMED_AT', 'D-015_PERSON_1_OWES_PERSON_2_POSITIVE', 3, 3, 25000, 12500, 12500, 13500, 0, 13500, 0, 0, 0, 0, 0, 0, 0, 1500, null, 1, 's8b-one', '2026-09-01T00:00:00.000Z', 'settlement-s8b-aug');
}
function group(groups, key, bucket) { return groups[key].find(row => row.bucket === bucket); }
function rawArchive(bytes) { return XLSX.CFB.read(bytes, { type: 'buffer' }); }
function rawPart(bytes, path) { const archive = rawArchive(bytes); const entry = XLSX.CFB.find(archive, `Root Entry/${path}`); assert.ok(entry, `missing OOXML part ${path}`); return new TextDecoder().decode(entry.content); }
function assertWorkbook(bytes, expectedNames) {
  assert.ok(bytes instanceof Uint8Array); assert.ok(bytes.length > 2000);
  const reopened = parseS8Workbook(bytes); assert.deepEqual(reopened.SheetNames, expectedNames);
  const archive = rawArchive(bytes); const paths = archive.FullPaths.map(path => path.toLowerCase()); const workbookXml = rawPart(bytes, 'xl/workbook.xml'); const coreXml = rawPart(bytes, 'docProps/core.xml');
  assert.ok(!paths.some(path => path.includes('externallinks') || path.includes('vbaproject') || path.includes('activex')));
  assert.ok(!/(token|firebase|cloudflare|\/home\/)/i.test(coreXml)); assert.ok(!workbookXml.includes('externalLink'));
  for (let index = 0; index < expectedNames.length; index += 1) { const sheetXml = rawPart(bytes, `xl/worksheets/sheet${index + 1}.xml`); assert.match(sheetXml, /rightToLeft=\"1\"/); assert.match(sheetXml, /<autoFilter /); assert.match(sheetXml, /<cols>/); assert.ok(!/<f(?: |>)/.test(sheetXml)); }
  return reopened;
}

test('S8 PR-B analytics groups classifications, period, archives, and authoritative S6/S7 integer totals against an independent oracle', async () => {
  const { database, env } = fixture();
  try {
    seedAnalyticsFixture(database);
    const analytics = await getS8Analytics(env, { period_basis: 'CREATED_AT', year: '2026', month: '08', include_archived: true });
    assert.equal(analytics.period_basis, 'CREATED_AT'); assert.equal(analytics.financial_authority, 'S6_APPROVED_PRICE_MOVEMENTS_AND_S7_APPROVED_PAYMENTS_MINUS_REVERSALS');
    assert.deepEqual(group(analytics.groups, 'WORK_TYPE', 'TYPE_A'), { dimension: 'WORK_TYPE', bucket: 'TYPE_A', work_count: 2, active_work_count: 2, archived_work_count: 0, price_unset_work_count: 0, current_price_halalas: 15000, approved_paid_halalas: 6000, remaining_halalas: 9000 });
    assert.deepEqual(group(analytics.groups, 'WORK_TYPE', 'TYPE_B'), { dimension: 'WORK_TYPE', bucket: 'TYPE_B', work_count: 1, active_work_count: 0, archived_work_count: 1, price_unset_work_count: 0, current_price_halalas: 10000, approved_paid_halalas: 7500, remaining_halalas: 2500 });
    assert.deepEqual(analytics.groups.PERIOD.map(row => row.bucket), ['2026-08']);
    assert.equal(group(analytics.groups, 'SPECIALTY', 'SPEC_A').work_count, 2); assert.equal(group(analytics.groups, 'COUNTRY', 'S8B_COUNTRY_B').archived_work_count, 1); assert.equal(group(analytics.groups, 'UNIVERSITY', 'Synthetic University B').approved_paid_halalas, 7500);
    const activeOnly = await getS8Analytics(env, { period_basis: 'CREATED_AT', year: '2026', month: '08', include_archived: false }); assert.equal(group(activeOnly.groups, 'WORK_TYPE', 'TYPE_B'), undefined);
    const confirmedOnly = await getS8Analytics(env, { period_basis: 'CONFIRMED_AT', include_archived: true }); assert.equal(group(confirmedOnly.groups, 'WORK_TYPE', 'UNSPECIFIED'), undefined); assert.equal(group(confirmedOnly.groups, 'PERIOD', '2026-08').work_count, 3);
    const financials = await getWorkFinancials(env, 'WORK-S8B-B'); assert.equal(financials.current_price_halalas, 10000); assert.equal(financials.approved_payments_total_halalas, 7500); assert.equal(financials.remaining_halalas, 2500);
    const historical = await getS8Analytics(env, { period_basis: 'CREATED_AT', year: '2025', include_archived: true }); assert.equal(group(historical.groups, 'WORK_TYPE', 'UNSPECIFIED').price_unset_work_count, 1);
    await createCatalogValue(env, 's8b-one', 's8b-dynamic-country', 'country', { value_key: 'S8B_DYNAMIC_COUNTRY', label: 'Synthetic Dynamic Country' });
    work(database, 'WORK-S8B-DYNAMIC', { title: 'Synthetic dynamic catalog analytics', country: 'S8B_DYNAMIC_COUNTRY' });
    const dynamic = await getS8Analytics(env, { period_basis: 'CREATED_AT', year: '2026', month: '08', include_archived: true }); assert.equal(group(dynamic.groups, 'COUNTRY', 'S8B_DYNAMIC_COUNTRY').work_count, 1);
  } finally { database.close(); }
});

test('S8 PR-B export DTOs remain authoritative, archive-aware, bounded, and expose every required export type', async () => {
  const { database, env } = fixture();
  try {
    seedAnalyticsFixture(database);
    const workDto = await getS8WorkExportDto(env, 'WORK-S8B-A'); assert.equal(workDto.export_type, 'WORK'); assert.equal(workDto.work.current_price_halalas, 10000); assert.equal(workDto.payments[0].amount_halalas, 6000); assert.equal(workDto.events[0].description, '=SUM(1,1)');
    const monthDto = await getS8MonthExportDto(env, { period_basis: 'CONFIRMED_AT', year: '2026', month: '08', include_archived: true }); assert.equal(monthDto.export_type, 'MONTH'); assert.deepEqual(monthDto.works.map(row => row.id), ['WORK-S8B-A', 'WORK-S8B-B', 'WORK-S8B-D']); assert.equal(monthDto.settlement_snapshots[0].total_work_value_halalas, 25000);
    const followUpDto = await getS8FollowUpExportDto(env, { include_archived: true }); assert.equal(followUpDto.export_type, 'FOLLOW_UP'); assert.equal(followUpDto.events.length, 2); assert.equal(followUpDto.events.filter(row => row.is_archived).length, 1);
    const customerDto = await getS8CustomerExportDto(env, 'CUST-S8B-A', { period_basis: 'CREATED_AT', include_archived: true }); assert.equal(customerDto.export_type, 'CUSTOMER'); assert.deepEqual(customerDto.page_totals, { work_count: 1, active_work_count: 1, archived_work_count: 0, price_unset_work_count: 0, approved_paid_halalas: 6000, remaining_halalas: 4000 }); assert.equal(customerDto.warnings[0].warning_type, 'DELAY');
    const classificationDto = await getS8ClassificationExportDto(env, { period_basis: 'CREATED_AT', include_archived: true }); assert.equal(classificationDto.export_type, 'CLASSIFICATION'); assert.equal(group(classificationDto.groups, 'WORK_TYPE', 'UNSPECIFIED').work_count, 1);
    await assert.rejects(getS8MonthExportDto(env, { period_basis: 'CREATED_AT', year: '2026' }), /S8_EXPORT_PERIOD_REQUIRED/);
    await assert.rejects(getS8Analytics(env, { year: '2026' }), /S8_PERIOD_BASIS_REQUIRED/);
  } finally { database.close(); }
});

test('S8 PR-B generates real secure RTL XLSX workbooks with exact sheets, Arabic headers, numeric money, and safe formula-like text', async () => {
  const { database, env } = fixture();
  try {
    seedAnalyticsFixture(database);
    const cases = [
      [await getS8WorkExportDto(env, 'WORK-S8B-A'), ['ملخص العمل', 'سجل العناوين', 'سجل الحالة', 'متابعة', 'التحصيل']],
      [await getS8MonthExportDto(env, { period_basis: 'CONFIRMED_AT', year: '2026', month: '08', include_archived: true }), ['أعمال الشهر', 'التحصيل', 'التسوية']],
      [await getS8FollowUpExportDto(env, { include_archived: true }), ['سجل المتابعة']],
      [await getS8CustomerExportDto(env, 'CUST-S8B-A', { period_basis: 'CREATED_AT', include_archived: true }), ['تقرير العميل', 'أعمال العميل', 'التحصيل', 'التحذيرات']],
      [await getS8ClassificationExportDto(env, { period_basis: 'CREATED_AT', include_archived: true }), ['حسب النوع', 'حسب التخصص', 'حسب الدولة', 'حسب الجامعة', 'حسب الفترة']],
    ];
    for (const [dto, expectedNames] of cases) {
      const reopened = assertWorkbook(generateS8Workbook(dto), expectedNames); assert.equal(reopened.Sheets[expectedNames[0]].A1.t, 's'); assert.ok(reopened.Sheets[expectedNames[0]]['!ref']);
    }
    const workBook = assertWorkbook(generateS8Workbook(cases[0][0]), cases[0][1]); const summary = workBook.Sheets['ملخص العمل']; assert.equal(Math.round(summary.L2.v * 100), 10000); assert.equal(summary.L2.t, 'n'); assert.equal(summary.A2.t, 's'); assert.equal(XLSX.utils.decode_range(summary['!ref']).e.r, 1);
    const followUpBook = assertWorkbook(generateS8Workbook(cases[2][0]), cases[2][1]); const safeEvent = followUpBook.Sheets['سجل المتابعة'].F2; assert.equal(safeEvent.f, undefined); assert.equal(safeEvent.v, '=SUM(1,1)');
    const settlementSheet = parseS8Workbook(generateS8Workbook(cases[1][0])).Sheets['التسوية']; assert.equal(settlementSheet.H1.v, 'حصة الشخص 1 من الأعمال SAR'); assert.equal(settlementSheet.I1.v, 'حصة الشخص 2 من الأعمال SAR'); assert.match(settlementSheet.K1.v, /غير موقّع؛ لا يُستنتج منه الاتجاه/); assert.match(settlementSheet.L1.v, /غير محفوظ في snapshot/); assert.equal(settlementSheet.L2.v, 'غير متاح؛ غير محفوظ في snapshot'); assert.match(settlementSheet.Q1.v, /الموجب: الشخص 1 مدين للشخص 2/);
    const edgeDto = structuredClone(cases[0][0]); edgeDto.work.current_price_halalas = 9007199254740990; edgeDto.work.approved_paid_halalas = 0; edgeDto.work.remaining_halalas = 9007199254740990; const edgeBook = parseS8Workbook(generateS8Workbook(edgeDto)); const edgePrice = edgeBook.Sheets['ملخص العمل'].L2; assert.equal(edgePrice.t, 's'); assert.equal(edgePrice.v, '90071992547409.90');
    assert.equal(safeS8ExportFilename('WORK', '../../unsafe/اسم'), 's8-work-unsafe.xlsx'); assert.throws(() => safeS8ExportFilename('INVALID', 'x'), /S8_EXPORT_TYPE_INVALID/);
  } finally { database.close(); }
});

test('S8 PR-B analytics and export API routes retain authenticated authoritative envelopes', { skip: !(() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })() }, async () => {
  const { database, env } = fixture(); const originalFetch = globalThis.fetch; const directory = mkdtempSync(join(tmpdir(), 's8b-x509-')); const privateKeyPath = join(directory, 'private-key.pem'); const certificatePath = join(directory, 'certificate.pem');
  try {
    seedAnalyticsFixture(database); execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=s8b-firebase-test', '-keyout', privateKeyPath, '-out', certificatePath], { stdio: 'ignore' });
    const keyPem = readFileSync(privateKeyPath, 'utf8'); const keyLabel = ['PRIVATE', 'KEY'].join(' '); const keyPattern = new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`); const privateKey = await crypto.subtle.importKey('pkcs8', Uint8Array.from(Buffer.from(keyPem.match(keyPattern)[1].replace(/\\s+/g, ''), 'base64')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const certificatePem = readFileSync(certificatePath, 'utf8'); globalThis.fetch = async () => new Response(JSON.stringify({ s8btest: certificatePem }), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
    const b64 = bytes => Buffer.from(bytes).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); const json = value => b64(new TextEncoder().encode(JSON.stringify(value))); const now = Math.floor(Date.now() / 1000); const signed = `${json({ alg: 'RS256', kid: 's8btest', typ: 'JWT' })}.${json({ aud: 'demo-project', iss: 'https://securetoken.google.com/demo-project', sub: 's8b-one', iat: now - 10, auth_time: now - 10, exp: now + 3600 })}`; const token = `${signed}.${b64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signed))))}`;
    const headers = { authorization: `Bearer ${token}`, 'x-s3-run-id': 's8-pr-b', 'x-s3-request-id': 's8b-api-analytics' };
    const analyticsResponse = await worker.fetch(new Request('https://example.test/api/analytics?period_basis=CREATED_AT&year=2026&month=08', { headers }), env); assert.equal(analyticsResponse.status, 200); const analyticsPayload = await analyticsResponse.json(); assert.equal(analyticsPayload.ok, true); assert.equal(analyticsPayload.requestId, 's8b-api-analytics'); assert.equal(analyticsPayload.data.groups.WORK_TYPE[0].dimension, 'WORK_TYPE');
    const monthResponse = await worker.fetch(new Request('https://example.test/api/exports/month?period_basis=CONFIRMED_AT&year=2026&month=08', { headers: { ...headers, 'x-s3-request-id': 's8b-api-month' } }), env); assert.equal(monthResponse.status, 200); const monthPayload = await monthResponse.json(); assert.equal(monthPayload.ok, true); assert.equal(monthPayload.data.export_type, 'MONTH');
    const denied = await worker.fetch(new Request('https://example.test/api/analytics?period_basis=CREATED_AT'), env); assert.equal(denied.status, 401); const deniedPayload = await denied.json(); assert.equal(deniedPayload.ok, false); assert.equal(deniedPayload.code, 'TOKEN_MISSING');
  } finally { globalThis.fetch = originalFetch; database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('S8 PR-B money aggregation fails closed above the safe-integer domain and SheetJS vendor bytes are pinned', async () => {
  const { database, env } = fixture();
  try {
    seedAnalyticsFixture(database); work(database, 'WORK-S8B-OVERFLOW-1', { title: 'Synthetic overflow 1', workType: 'OVERFLOW_TYPE' }); work(database, 'WORK-S8B-OVERFLOW-2', { title: 'Synthetic overflow 2', workType: 'OVERFLOW_TYPE' }); approvedPrice(database, 'WORK-S8B-OVERFLOW-1', 9007199254740990); approvedPrice(database, 'WORK-S8B-OVERFLOW-2', 9007199254740990);
    await assert.rejects(getS8Analytics(env, { period_basis: 'CREATED_AT', include_archived: true }), /MONEY_OVERFLOW/);
    const recordedHash = readFileSync(vendorHashPath, 'utf8').trim().split(/\s+/)[0]; assert.equal(recordedHash, '1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db'); assert.equal(createHash('sha256').update(readFileSync(vendorPath)).digest('hex'), recordedHash);
  } finally { database.close(); }
});

test('S8 PR-B analytics and export DTO D1 query and bind budgets stay fixed on continuation pages above 1000 synthetic Works', async () => {
  const { database, env } = fixture();
  try {
    seedAnalyticsFixture(database);
    for (let index = 0; index < 1001; index += 1) { work(database, `WORK-S8B-LARGE-${String(index).padStart(4, '0')}`, { title: `Synthetic large ${index}`, createdAt: '2026-08-11T00:00:00.000Z', confirmedAt: '2026-08-12T00:00:00.000Z', workType: index % 2 ? 'TYPE_A' : 'TYPE_B', specialty: index % 2 ? 'SPEC_A' : 'SPEC_B' }); event(database, 'WORK-S8B-A', `EVENT-S8B-LARGE-${String(index).padStart(4, '0')}`); }
    database.readQueries = 0; database.bindingWidths = []; await getS8Analytics(env, { period_basis: 'CREATED_AT', year: '2026', month: '08', include_archived: true }); const analyticsQueries = database.readQueries; const analyticsMaxBind = Math.max(...database.bindingWidths, 0);
    database.readQueries = 0; database.bindingWidths = []; const firstMonthPage = await getS8MonthExportDto(env, { period_basis: 'CONFIRMED_AT', year: '2026', month: '08', include_archived: true, page_size: 200 }); const monthQueries = database.readQueries; const monthMaxBind = Math.max(...database.bindingWidths, 0);
    const walked = []; let cursor = null; do { const page = await getS8MonthExportDto(env, { period_basis: 'CONFIRMED_AT', year: '2026', month: '08', include_archived: true, page_size: 200, cursor }); walked.push(...page.works.map(row => row.id)); cursor = page.next_cursor; } while (cursor);
    database.readQueries = 0; database.bindingWidths = []; const firstCustomerPage = await getS8CustomerExportDto(env, 'CUST-S8B-A', { period_basis: 'CREATED_AT', include_archived: true, page_size: 200 }); const customerQueries = database.readQueries; const customerMaxBind = Math.max(...database.bindingWidths, 0);
    const walkedCustomer = []; const customerPages = []; let customerCursor = null; do { const page = await getS8CustomerExportDto(env, 'CUST-S8B-A', { period_basis: 'CREATED_AT', include_archived: true, page_size: 200, cursor: customerCursor }); customerPages.push(page); walkedCustomer.push(...page.works.map(row => row.id)); customerCursor = page.next_cursor; } while (customerCursor);
    const walkedFollowUp = []; let followUpCursor = null; do { const page = await getS8FollowUpExportDto(env, { include_archived: true, page_size: 200, cursor: followUpCursor }); walkedFollowUp.push(...page.events.map(row => row.id)); followUpCursor = page.next_cursor; } while (followUpCursor);
    assert.equal(firstMonthPage.page_size, 200); assert.ok(firstMonthPage.next_cursor); assert.equal(walked.length, 1004); assert.equal(new Set(walked).size, 1004); assert.deepEqual(walked, [...walked].sort()); assert.equal(walkedCustomer.length, 1002); assert.equal(new Set(walkedCustomer).size, 1002); assert.deepEqual(walkedCustomer, [...walkedCustomer].sort()); const fullCustomerTotals = { work_count: 1002, active_work_count: 1002, archived_work_count: 0, price_unset_work_count: 1001, approved_paid_halalas: 6000, remaining_halalas: 4000 }; assert.deepEqual(firstCustomerPage.totals, fullCustomerTotals); assert.ok(customerPages.every(page => JSON.stringify(page.totals) === JSON.stringify(fullCustomerTotals))); assert.equal(walkedFollowUp.length, 1003); assert.equal(new Set(walkedFollowUp).size, 1003); assert.deepEqual(walkedFollowUp, [...walkedFollowUp].sort()); assert.equal(analyticsQueries, 1); assert.ok(monthQueries <= 2); assert.ok(customerQueries <= 4); assert.ok(Math.max(analyticsMaxBind, monthMaxBind, customerMaxBind) <= 100);
    console.log(`S8_PR_B_D1_MEASUREMENT analytics_queries=${analyticsQueries} analytics_max_bind=${analyticsMaxBind} month_export_queries=${monthQueries} month_export_max_bind=${monthMaxBind} customer_export_queries=${customerQueries} customer_export_max_bind=${customerMaxBind} works=1004 totals=full`);
  } finally { database.close(); }
});
