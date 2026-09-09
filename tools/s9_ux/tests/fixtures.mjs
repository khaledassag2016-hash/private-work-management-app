const now = '2026-08-13T09:00:00.000Z';

export const customer = { id: 'customer-1', version: 1, name: 'عميل اختباري', contact: 'synthetic-only', country: 'SA', university: 'جامعة الاختبار', specialty: 'IT', notes: 'بيانات اصطناعية فقط', status: 'normal' };
export const work = { id: 'work-1', version: 7, customer_id: customer.id, title: 'بحث اختبار تجربة الاستخدام', country: 'SA', university: 'جامعة الاختبار', specialty_key: 'IT', work_type_key: 'REPORT', subject_or_course_code: 'IT-UX', status: 'IN_PROGRESS', relationship_kind: 'INDEPENDENT', parent_work_id: null, description: 'سجل اصطناعي حاكم للاختبار', confirmed_at: '2026-08-10T08:00:00.000Z', created_at: '2026-08-09T08:00:00.000Z', is_archived: false, pricing_state: 'PRICE_APPROVED', current_price_halalas: 170000, approved_paid_halalas: 100000, remaining_halalas: 70000, collection_status: 'PARTIALLY_COLLECTED', soft_warnings: [] };

const financials = {
  price_state: 'PRICE_APPROVED', current_price_halalas: 170000, approved_payments_total_halalas: 100000, remaining_halalas: 70000, collection_status: 'PARTIALLY_COLLECTED',
  shares: { person_1_halalas: 51000, person_2_halalas: 119000 }, ratio: { person_1_bps: 3000, person_2_bps: 7000, source: 'DEFAULT' },
  movements: [{ id: 'movement-1', movement_type: 'BASE', amount_halalas: 170000, previous_price_halalas: 0, new_price_halalas: 170000, reason: 'سعر سلطوي اصطناعي', effective_at: now, requested_by: 'uid-one', approved_by: 'uid-two', approved_at: now }],
  ratio_history: [],
  price_requests: [{ id: 'price-request-1', state: 'PENDING', movement_type: 'INCREASE', amount_halalas: 10000, reason: 'طلب اصطناعي', requested_by: 'uid-two', requested_at: now, effective_at: now }],
  ratio_requests: [{ id: 'ratio-request-1', state: 'PENDING', person_1_bps: 4000, person_2_bps: 6000, reason: 'استثناء اصطناعي', requested_by: 'uid-two', requested_at: now }],
};

const payments = [{ id: 'payment-1', amount_halalas: 100000, effective_at: now, payment_method: 'BANK_TRANSFER', received_by: 'uid-one', recorded_by: 'uid-one', note: 'دفعة اصطناعية' }];
const requests = [{ id: 'request-1', state: 'PENDING', action: 'ARCHIVE', reason: 'طلب أرشفة اصطناعي', requested_by: 'uid-two', requested_at: now }];
const reversals = [{ id: 'reversal-1', state: 'PENDING', payment_id: 'payment-1', amount_halalas: 100000, reason: 'تصحيح اصطناعي', requested_by: 'uid-two', requested_at: now }];
const reopenRequests = [{ id: 'reopen-1', state: 'PENDING', reason: 'إعادة فتح اصطناعية', requested_by: 'uid-two', requested_at: now }];

const searchWork = { ...work, customer_name: customer.name, collection_status: 'PARTIALLY_COLLECTED', approved_paid_halalas: 100000, remaining_halalas: 70000 };
const group = [{ bucket: 'REPORT', work_count: 1, active_work_count: 1, archived_work_count: 0, price_unset_work_count: 0, current_price_halalas: 170000, approved_paid_halalas: 100000, remaining_halalas: 70000 }];
const preview = { period_key: '2026-08', work_count: 1, cumulative_work_count: 1, total_work_value_halalas: 170000, person_1_work_share_halalas: 51000, person_2_work_share_halalas: 119000, approved_receipts_halalas: 100000, approved_receipts_person_1_halalas: 100000, approved_receipts_person_2_halalas: 0, transfer_amount_halalas: 0, transfer_fee_halalas: 0, subscription_total_halalas: 13650, governed_expense_total_halalas: 0, prior_balance_halalas: 0, final_balance_halalas: 19000, unresolved_code: null };

function workExport() { return { export_type: 'WORK', work: searchWork, title_history: [], status_history: [], events: [], payments }; }
function monthExport() { return { export_type: 'MONTH', works: [searchWork], settlement_snapshots: [], next_cursor: null }; }
function followUpExport() { return { export_type: 'FOLLOW_UP', events: [{ id: 'event-1', work_id: work.id, work_title: work.title, customer_name: customer.name, event_type: 'FOLLOW_UP', description: 'متابعة اصطناعية', effective_at: now, created_at: now, actor_uid: 'uid-one', is_archived: false }], next_cursor: null }; }
function customerExport() { return { export_type: 'CUSTOMER', customer, works: [searchWork], warnings: [], totals: { work_count: 1, active_work_count: 1, archived_work_count: 0, price_unset_work_count: 0, approved_paid_halalas: 100000, remaining_halalas: 70000 }, next_cursor: null, warning_next_cursor: null }; }
function classificationExport() { return { export_type: 'CLASSIFICATION', groups: { WORK_TYPE: group, SPECIALTY: group, COUNTRY: group, UNIVERSITY: group, PERIOD: group } }; }


const previewCustomers = [
  customer,
  { ...customer, id: 'customer-2', name: 'عميل تجريبي ثان', university: 'جامعة تجريبية ثانية' },
  { ...customer, id: 'customer-3', name: 'عميل تجريبي ثالث', specialty: 'إدارة' },
];
const previewWorks = [
  work,
  { ...work, id: 'work-needs-pricing', customer_id: 'customer-2', title: 'عمل يحتاج تسعير', status: 'NEEDS_PRICING', pricing_state: 'PRICE_UNSET', current_price_halalas: null, approved_paid_halalas: 0, remaining_halalas: null, collection_status: 'PRICE_UNSET', confirmed_at: null },
  { ...work, id: 'work-paused', customer_id: 'customer-2', title: 'عمل متوقف مؤقتًا', status: 'PAUSED', current_price_halalas: 220000, approved_paid_halalas: 50000, remaining_halalas: 170000, collection_status: 'PARTIALLY_COLLECTED' },
  { ...work, id: 'work-archived', customer_id: 'customer-3', title: 'عمل مكتمل مؤرشف', status: 'COMPLETED', is_archived: true, current_price_halalas: 90000, approved_paid_halalas: 90000, remaining_halalas: 0, collection_status: 'FINANCIALLY_CLOSED' },
];
const cleanPreview = { ...preview, work_count: 0, cumulative_work_count: 0, total_work_value_halalas: 0, person_1_work_share_halalas: 0, person_2_work_share_halalas: 0, approved_receipts_halalas: 0, approved_receipts_person_1_halalas: 0, approved_receipts_person_2_halalas: 0, transfer_amount_halalas: 0, transfer_fee_halalas: 0, subscription_total_halalas: 0, governed_expense_total_halalas: 0, prior_balance_halalas: 0, final_balance_halalas: 0 };
function previewAccounts(identityMode) {
  return identityMode === 'D028_TARGET'
    ? [{ role: 'person_1', display_name: 'وليد', email: 'waleed.preview@example.test', active: true, disabled: false }, { role: 'person_2', display_name: 'خالد', email: 'khalid.preview@example.test', active: true, disabled: false }]
    : [{ role: 'person_1', display_name: 'خالد', email: 'khalid.preview@example.test', active: true, disabled: false }, { role: 'person_2', display_name: 'وليد', email: 'waleed.preview@example.test', active: true, disabled: false }];
}
function cleanPreviewDataFor(path, method, identity) {
  const uid = identity.uid || 'uid-one'; const role = identity.role || 'person_1'; const identityMode = identity.identityMode || 'D028_TARGET';
  if (path === '/private/ping') return { uid, role, identity_mode: identityMode };
  if (path.startsWith('/api/catalog/')) return [];
  if (path === '/api/customers' || path === '/api/works' || path === '/api/transfers' || path === '/api/subscriptions' || path === '/api/expenses' || path === '/api/audit' || path === '/api/settlements') return [];
  if (path === '/api/participants') return [{ uid: 'uid-one', role: 'person_1' }, { uid: 'uid-two', role: 'person_2' }];
  if (path === '/api/account-admin/accounts' && method === 'GET') return previewAccounts(identityMode);
  if (path === '/api/settlements/preview') return cleanPreview;
  if (path.startsWith('/api/settlements/') && path.endsWith('/reopen-requests')) return [];
  if (path === '/api/search/works') return { items: [], page: 1, page_size: 25, has_more: false };
  if (path === '/api/analytics') return { groups: { WORK_TYPE: [], SPECIALTY: [], COUNTRY: [], UNIVERSITY: [], PERIOD: [] }, totals: { work_count: 0, active_work_count: 0, archived_work_count: 0, price_unset_work_count: 0, current_price_halalas: 0, approved_paid_halalas: 0, remaining_halalas: 0 } };
  if (path === '/api/alerts') return { alerts: [] };
  if (path === '/api/alerts/settings') return [];
  if (path.startsWith('/api/exports/')) return {};
  return {};
}
function demoPreviewDataFor(path, method, identity) {
  const uid = identity.uid || 'uid-one'; const role = identity.role || 'person_1'; const identityMode = identity.identityMode || 'D028_TARGET';
  if (path === '/private/ping') return { uid, role, identity_mode: identityMode };
  if (path.startsWith('/api/catalog/')) return [{ value_key: path.endsWith('/country') ? 'SA' : path.endsWith('/specialty') ? 'IT' : 'REPORT', label: path.endsWith('/country') ? 'السعودية' : path.endsWith('/specialty') ? 'تقنية المعلومات' : 'تقرير', active: true }];
  if (path === '/api/customers' && method === 'GET') return previewCustomers;
  if (path === '/api/works' && method === 'GET') return previewWorks;
  if (path === '/api/participants') return [{ uid: 'uid-one', role: 'person_1' }, { uid: 'uid-two', role: 'person_2' }];
  if (path === '/api/account-admin/accounts' && method === 'GET') return previewAccounts(identityMode);
  if (path === '/api/audit') return [{ id: 'audit-1', entity_type: 'work', entity_id: work.id, action: 'UPDATE', actor_uid: 'uid-one', actor_role: 'person_1', created_at: now, before: { status: 'AGREED' }, after: { status: 'IN_PROGRESS' } }];
  if (path === '/api/transfers') return [{ id: 'transfer-demo', amount_halalas: 10000, effective_at: now, from_party: 'person_1', to_party: 'person_2', fee_halalas: 200, fee_payer: 'person_1' }];
  if (path === '/api/subscriptions') return [{ id: 'subscription-demo', state: 'ACTIVE', aggregate_amount_halalas: 13650, effective_at: '2026-07-01T00:00:00.000Z', paid_by_uid: 'uid-two' }];
  if (path === '/api/expenses') return [];
  if (path === '/api/settlements/preview') return { ...preview, work_count: 3, cumulative_work_count: 4, transfer_amount_halalas: 10000, transfer_fee_halalas: 200 };
  if (path === '/api/settlements') return [];
  if (path.startsWith('/api/settlements/') && path.endsWith('/reopen-requests')) return reopenRequests;
  if (path === '/api/search/works') return { items: previewWorks.map(item => ({ ...item, customer_name: previewCustomers.find(c => c.id === item.customer_id)?.name || customer.name, archived_at: item.is_archived ? now : null })), page: 1, page_size: 25, has_more: false };
  if (path === '/api/analytics') return { groups: { WORK_TYPE: group, SPECIALTY: group, COUNTRY: group, UNIVERSITY: group, PERIOD: group }, totals: group[0] };
  if (path === '/api/alerts') return { alerts: [{ alert_type: 'NO_PRICE', state: 'CONFIGURED', threshold_days: 7, items: [{ work_id: 'work-needs-pricing', title: 'عمل يحتاج تسعير', age_days: 8 }] }] };
  if (path === '/api/alerts/settings') return [{ alert_type: 'NO_PRICE', threshold_days: 7 }];
  const workMatch = path.match(/^\/api\/works\/([^/]+)(?:\/(.*))?$/);
  if (workMatch) {
    const item = previewWorks.find(candidate => candidate.id === workMatch[1]);
    const tail = workMatch[2] || '';
    if (!item) return {};
    if (!tail) return item;
    if (tail === 'financials') return item.id === work.id ? financials : { ...financials, price_state: item.pricing_state, current_price_halalas: item.current_price_halalas, approved_payments_total_halalas: item.approved_paid_halalas, remaining_halalas: item.remaining_halalas, collection_status: item.collection_status, price_requests: [], ratio_requests: [], ratio_history: [], payments: [] };
    if (tail === 'similar') return previewWorks.filter(candidate => candidate.id !== item.id).slice(0, 2);
    if (tail === 'events') return item.id === work.id ? [{ id: 'event-1', event_type: 'متابعة', description: 'متابعة تجريبية', effective_at: now, created_at: now, actor_uid: 'uid-one' }] : [];
    if (tail === 'title-history') return item.id === work.id ? [{ id: 'title-1', old_title: 'عنوان سابق ظاهر', new_title: item.title, reason: 'تغيير تجريبي', changed_at: now, changed_by: 'uid-one' }] : [];
    if (tail === 'status-history') return item.id === work.id ? [{ id: 'status-1', old_status: 'AGREED', new_status: item.status, reason: 'بدء التنفيذ', changed_at: now, changed_by: 'uid-one' }] : [];
    if (tail === 'archive-history') return item.is_archived ? [{ id: 'archive-1', reason: 'أرشفة تجريبية', archived_at: now, archived_by: 'uid-two' }] : [];
    if (tail === 'requests') return item.id === work.id ? requests : [];
    if (tail === 'payments') return item.id === work.id ? payments : [];
    if (tail === 'payment-reversal-requests') return item.id === work.id ? reversals : [];
  }
  if (path.startsWith('/api/exports/')) return {};
  return {};
}

export function dataFor(path, method, identity = {}) {
  const uid = identity.uid || 'uid-one';
  const role = identity.role || 'person_1';
  const identityMode = identity.identityMode || 'CURRENT';
  const previewMode = String(identity.dataMode || '').toUpperCase();
  if (previewMode === 'CLEAN') return cleanPreviewDataFor(path, method, identity);
  if (previewMode === 'DEMO') return demoPreviewDataFor(path, method, identity);
  if (path === '/private/ping') return { uid, role, identity_mode: identityMode };
  if (path.startsWith('/api/catalog/')) return [{ value_key: path.endsWith('/country') ? 'SA' : path.endsWith('/specialty') ? 'IT' : 'REPORT', label: path.endsWith('/country') ? 'السعودية' : path.endsWith('/specialty') ? 'تقنية المعلومات' : 'تقرير', active: true }];
  if (path === '/api/customers' && method === 'GET') return [customer];
  if (path === `/api/customers/${customer.id}`) return customer;
  if (path === `/api/customers/${customer.id}/history`) return [{ id: 'fact-1', fact_type: 'DELAY', source_ref: 'synthetic-reference', happened_at: now }];
  if (path === `/api/customers/${customer.id}/warnings`) return [{ warning_type: 'DELAY', source_ref: 'synthetic-reference', happened_at: now }];
  if (path === '/api/works' && method === 'GET') return [work];
  if (path === `/api/works/${work.id}/similar`) return [];
  if (path === `/api/works/${work.id}/financials`) return financials;
  if (path === `/api/works/${work.id}/events`) return [{ id: 'event-1', event_type: 'FOLLOW_UP', description: 'متابعة اصطناعية', effective_at: now, created_at: now, actor_uid: 'uid-one' }];
  if (path === `/api/works/${work.id}/title-history`) return [{ id: 'title-1', old_title: 'عنوان سابق ظاهر', new_title: work.title, reason: 'تغيير اصطناعي', changed_at: now, changed_by: 'uid-one' }];
  if (path === `/api/works/${work.id}/status-history`) return [{ id: 'status-1', old_status: 'AGREED', new_status: 'IN_PROGRESS', reason: 'بدء التنفيذ', changed_at: now, changed_by: 'uid-one' }];
  if (path === `/api/works/${work.id}/archive-history`) return [{ id: 'archive-1', reason: 'سجل تاريخي اصطناعي', archived_at: '2026-08-01T00:00:00.000Z', archived_by: 'uid-two' }];
  if (path === `/api/works/${work.id}/requests`) return requests;
  if (path === `/api/works/${work.id}/payments`) return payments;
  if (path === `/api/works/${work.id}/payment-reversal-requests`) return reversals;
  if (path === `/api/works/${work.id}`) return work;
  if (path === '/api/participants') return [{ uid: 'uid-one', role: 'person_1' }, { uid: 'uid-two', role: 'person_2' }];
  if (path === '/api/audit') return [{ id: 'audit-1', entity_type: 'work', entity_id: work.id, action: 'UPDATE', actor_uid: 'uid-one', actor_role: 'person_1', created_at: now, before: { status: 'AGREED', from_party: 'person_1' }, after: { status: 'IN_PROGRESS', to_party: 'person_2' } }];
  if (path === '/api/account-admin/accounts' && method === 'GET') return identityMode === 'D028_TARGET'
    ? [{ role: 'person_1', display_name: 'وليد', email: 'waleed@example.test', active: true, disabled: false }, { role: 'person_2', display_name: 'خالد', email: 'khalid@example.test', active: true, disabled: false }]
    : [{ role: 'person_1', display_name: 'خالد', email: 'khalid@example.test', active: true, disabled: false }, { role: 'person_2', display_name: 'وليد', email: 'waleed@example.test', active: true, disabled: false }];
  if (path === '/api/transfers' || path === '/api/subscriptions' || path === '/api/expenses') return [];
  if (path === '/api/settlements/preview') return preview;
  if (path === '/api/settlements') return [];
  if (path.startsWith('/api/settlements/') && path.endsWith('/reopen-requests')) return reopenRequests;
  if (path === '/api/search/works') return { items: [searchWork], page: 1, page_size: 25, has_more: false };
  if (path === '/api/analytics') return { groups: { WORK_TYPE: group, SPECIALTY: group, COUNTRY: group, UNIVERSITY: group, PERIOD: group }, totals: group[0] };
  if (path === '/api/alerts') return { alerts: ['NO_PRICE', 'NO_REPLY', 'NO_PAYMENT'].map(alert_type => ({ alert_type, state: 'CONFIGURED', threshold_days: 7, items: [{ work_id: work.id, title: work.title, age_days: 8 }] })) };
  if (path === '/api/alerts/settings') return ['NO_PRICE', 'NO_REPLY', 'NO_PAYMENT'].map(alert_type => ({ alert_type, threshold_days: 7 }));
  if (path.startsWith('/api/exports/work/')) return workExport();
  if (path === '/api/exports/month') return monthExport();
  if (path === '/api/exports/follow-up') return followUpExport();
  if (path.startsWith('/api/exports/customer/')) return customerExport();
  if (path === '/api/exports/classification') return classificationExport();
  return {};
}

export async function installHarness(page, identity = {}) {
  await page.addInitScript(({ email, dataMode, visualPreview }) => {
    window.__PRIVATE_WORK_APP_CONFIG__ = { apiBaseUrl: '', s8ExportModuleUrl: '/assets/s8-export.mjs', getIdToken: async () => 'synthetic-token', signOut: async () => {}, email, phase6VisualPreview: Boolean(visualPreview), phase6PreviewDataMode: String(dataMode || '').toUpperCase() };
  }, { email: identity.email || 'synthetic@example.test', dataMode: identity.dataMode || '', visualPreview: identity.visualPreview || false });
  const requestsLog = [];
  let nextFailure = null;
  let held = null;
  const settlementHarness = {
    snapshots: [],
    reopenRequests: reopenRequests.map(item => ({ ...item })),
  };
  await page.route('**/private/ping', route => handle(route));
  await page.route('**/api/**', route => handle(route));
  async function handle(route) {
    const request = route.request(); const url = new URL(request.url()); const entry = { method: request.method(), path: url.pathname, body: request.postDataJSON?.() };
    requestsLog.push(entry);
    if (nextFailure && (!nextFailure.path || nextFailure.path === entry.path)) {
      const failure = nextFailure; nextFailure = null;
      if (failure.abort) { await route.abort('failed'); return; }
      await route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify({ ok: false, code: failure.code }) }); return;
    }
    if (held && held.path === entry.path && held.method === entry.method) await held.promise;
    let data;
    const closeMatch = entry.path.match(/^\/api\/settlements\/([^/]+)\/close$/);
    const reopenMatch = entry.path.match(/^\/api\/settlements\/([^/]+)\/reopen-requests$/);
    const approveReopenMatch = entry.path.match(/^\/api\/settlements\/([^/]+)\/reopen-requests\/([^/]+)\/approve$/);
    if (entry.method === 'POST' && closeMatch) {
      const snapshot = { period_key: closeMatch[1], version: settlementHarness.snapshots.length + 1, state: 'CLOSED', final_balance_halalas: preview.final_balance_halalas, created_at: '2026-08-31T00:00:00.000Z' };
      settlementHarness.snapshots.push(snapshot);
      data = snapshot;
    } else if (entry.method === 'POST' && reopenMatch) {
      const requestItem = { id: `reopen-self-${settlementHarness.reopenRequests.length + 1}`, period_key: reopenMatch[1], state: 'PENDING', reason: entry.body?.reason || 'إعادة فتح', requested_by: 'uid-one', requested_at: '2026-08-31T12:00:00.000Z' };
      settlementHarness.reopenRequests.push(requestItem);
      data = requestItem;
    } else if (entry.method === 'POST' && approveReopenMatch) {
      const requestItem = settlementHarness.reopenRequests.find(item => item.id === approveReopenMatch[2]);
      if (requestItem) Object.assign(requestItem, { state: 'APPROVED', approved_by: 'uid-one', approved_at: '2026-09-01T00:00:00.000Z' });
      data = requestItem || {};
    } else if (entry.method === 'GET' && entry.path === '/api/settlements') {
      data = settlementHarness.snapshots;
    } else if (entry.method === 'GET' && /^\/api\/settlements\/[^/]+\/reopen-requests$/.test(entry.path)) {
      data = settlementHarness.reopenRequests;
    } else {
      data = dataFor(entry.path, entry.method, identity);
    }
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, data }) });
  }
  return {
    requests: requestsLog,
    count(method, path) { return requestsLog.filter(item => item.method === method && item.path === path).length; },
    failNext(status, code, path) { nextFailure = { status, code, path }; },
    abortNext(path) { nextFailure = { abort: true, path }; },
    holdNext(method, path) { let release; const promise = new Promise(resolve => { release = resolve; }); held = { method, path, promise }; return () => { held = null; release(); }; },
  };
}

export async function openApp(page) {
  await page.goto('/');
  await page.locator('.shell').waitFor();
}

export async function openWork(page) {
  await page.locator('[data-nav="works"]').click();
  await page.locator(`[data-work="${work.id}"]`).click();
  const financialDisclosureSummary = page.locator('[data-work-disclosure="financial-details"] summary');
  await financialDisclosureSummary.click();
  await page.locator('[data-s6-financial-core]').waitFor();
  await financialDisclosureSummary.click();
}
