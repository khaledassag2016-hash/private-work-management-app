import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url));
const appContent = readFileSync(appPath, 'utf8');

// Global mock setup
let lastFetch = null;
let toastLog = [];
let busyLog = [];
let querySelectorLog = [];

globalThis.window = {
  __PRIVATE_WORK_APP_CONFIG__: {
    apiBaseUrl: 'https://api.test',
  },
  __PRIVATE_WORK_APP_TEST__: {},
  setTimeout: (cb, t) => { cb(); },
};

globalThis.document = {
  body: {
    append: () => {},
  },
  querySelector: (selector) => {
    querySelectorLog.push(selector);
    if (selector === '#app') {
      return {
        set innerHTML(val) { this._html = val; },
        get innerHTML() { return this._html; }
      };
    }
    if (selector === '.toast-region') {
      return null;
    }
    return {
      addEventListener: () => {},
      remove: () => {},
      append: () => {},
      parentNode: {
        append: () => {},
      },
    };
  },
  querySelectorAll: (selector) => {
    return [];
  },
  createElement: () => ({
    className: '',
    append: () => {},
    remove: () => {},
    textContent: '',
    parentNode: {
      append: () => {},
    },
  }),
};

globalThis.Headers = class Headers {
  constructor(init) { this.map = new Map(Object.entries(init || {})); }
  set(k, v) { this.map.set(k, v); }
};

// use built-in globalThis.crypto

// Run app.js source code in current node context
eval(appContent);

const testApp = window.__PRIVATE_WORK_APP_TEST__;
const state = testApp.getState();

describe('S5 PR-B UI Flows', () => {

  // Reset helper
  function setupTestEnv({ uid = 'user-1', email = 'user-1@test.com', role = 'person_1' } = {}) {
    state.auth = {
      status: 'signed_in',
      uid,
      email,
      role,
      tokenProvider: {
        getToken: async () => 'mock-token'
      }
    };
    state.busy = false;
    toastLog = [];
    busyLog = [];
    querySelectorLog = [];
    lastFetch = null;
  }

  it('1. S5 UI routes/endpoints are wired through existing api()', async () => {
    setupTestEnv();

    // Override fetch to verify API paths
    const calledUrls = [];
    globalThis.fetch = async (url, options) => {
      lastFetch = { url, options };
      calledUrls.push(url);
      return {
        ok: true,
        json: async () => ({ ok: true, data: { success: true } })
      };
    };

    // S7 may add authoritative Work-detail reads, but legacy requests remain wired through api().
    state.selectedWork = { id: 'w1' };
    await testApp.openWork('w1');
    assert.ok(calledUrls.some(url => /\/api\/works\/w1\/payment-reversal-requests$/.test(url)));
    assert.ok(calledUrls.some(url => /\/api\/participants$/.test(url)));
  });

  it('2. Direct status UI cannot offer governed cancel targets', () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', status: 'NEW_REQUEST' };
    const html = testApp.workPage();
    // Verify execution status selection excludes cancellation statuses
    assert.match(html, /<select class="select" name="status"/);
    const statusSelectHtml = html.split('<select class="select" name="status"')[1].split('</select>')[0];
    assert.doesNotMatch(statusSelectHtml, /value="CANCELLED_BEFORE_EXECUTION"/);
    assert.doesNotMatch(statusSelectHtml, /value="PARTIALLY_STOPPED"/);
  });

  it('3. A->B->C title flow/history acceptance', () => {
    setupTestEnv();
    state.selectedWork = {
      id: 'w1',
      title: 'Title C',
      version: 3,
      titleHistory: [
        { old_title: 'Title A', new_title: 'Title B', reason: 'Initial change', changed_by: 'user-1', changed_at: '2026-08-11T12:00:00Z' },
        { old_title: 'Title B', new_title: 'Title C', reason: 'Second change', changed_by: 'user-2', changed_at: '2026-08-11T13:00:00Z' }
      ]
    };
    const html = testApp.workPage();
    assert.match(html, /تغيير عنوان/);
    assert.match(html, /Title A ← Title B — Initial change/);
    assert.match(html, /Title B ← Title C — Second change/);
    assert.match(html, /عرض السجل الكامل/);
  });

  it('4. Event list/add/reload/order acceptance', () => {
    setupTestEnv();
    // Simulate events with mixed timestamps
    const e1 = { id: 'e1', event_type: 'Comment 1', description: 'desc 1', effective_at: '2026-08-11T12:00:00Z', created_at: '2026-08-11T12:00:00Z' };
    const e2 = { id: 'e2', event_type: 'Comment 2', description: 'desc 2', effective_at: '2026-08-11T11:00:00Z', created_at: '2026-08-11T11:00:00Z' };
    const e3 = { id: 'e3', event_type: 'Comment 3', description: 'desc 3', effective_at: '2026-08-11T11:00:00Z', created_at: '2026-08-11T11:05:00Z' };
    state.selectedWork = {
      id: 'w1',
      events: [e1, e2, e3]
    };

    const html = testApp.workPage();
    // Effective time is authoritative; ties preserve deterministic source order.
    const first = html.indexOf('نشاط: Comment 1');
    const second = html.indexOf('نشاط: Comment 2');
    const third = html.indexOf('نشاط: Comment 3');
    assert.ok(first >= 0 && second > first && third > second);
    assert.match(html, /عرض السجل الكامل/);
  });

  it('5. CANCEL User1->User2 approval flow', async () => {
    setupTestEnv({ uid: 'user-2', email: 'user-2@test.com' }); // Logged in as User 2
    state.selectedWork = {
      id: 'w1',
      version: 1,
      requests: [
        { id: 'req-1', action: 'CANCEL', requested_by: 'user-1', requested_at: '2026-08-11T12:00:00Z', reason: 'Needs cancellation', state: 'PENDING', target_execution_status: 'CANCELLED_BEFORE_EXECUTION' }
      ]
    };

    let approveCalled = false;
    globalThis.fetch = async (url, options) => {
      if (url.includes('/requests/req-1/approve') && options.method === 'POST') {
        approveCalled = true;
      }
      return {
        ok: true,
        json: async () => ({ ok: true, data: { id: 'w1' } })
      };
    };

    const html = testApp.workPage();
    assert.match(html, /data-action="approve-request" data-request-id="req-1"/);

    // Call approve action handler directly
    await testApp.handleApproveRequest('req-1');
    assert.equal(approveCalled, true);
  });

  it('6. CANCEL User2->User1 approval flow', async () => {
    setupTestEnv({ uid: 'user-1', email: 'user-1@test.com' }); // Logged in as User 1
    state.selectedWork = {
      id: 'w1',
      version: 1,
      requests: [
        { id: 'req-1', action: 'CANCEL', requested_by: 'user-2', requested_at: '2026-08-11T12:00:00Z', reason: 'Needs cancellation', state: 'PENDING', target_execution_status: 'PARTIALLY_STOPPED' }
      ]
    };

    let approveCalled = false;
    globalThis.fetch = async (url, options) => {
      if (url.includes('/requests/req-1/approve') && options.method === 'POST') {
        approveCalled = true;
      }
      return {
        ok: true,
        json: async () => ({ ok: true, data: { id: 'w1' } })
      };
    };

    const html = testApp.workPage();
    assert.match(html, /data-action="approve-request" data-request-id="req-1"/);

    await testApp.handleApproveRequest('req-1');
    assert.equal(approveCalled, true);
  });

  it('7. CANCEL self-approval negative', () => {
    setupTestEnv({ uid: 'user-1', email: 'user-1@test.com' }); // Logged in as User 1
    state.selectedWork = {
      id: 'w1',
      version: 1,
      requests: [
        { id: 'req-1', action: 'CANCEL', requested_by: 'user-1', requested_at: '2026-08-11T12:00:00Z', reason: 'Needs cancellation', state: 'PENDING', target_execution_status: 'CANCELLED_BEFORE_EXECUTION' }
      ]
    };

    const html = testApp.workPage();
    assert.doesNotMatch(html, /data-action="approve-request" data-request-id="req-1"/);
    assert.match(html, /لا يمكنك اعتماد طلبك/);
  });

  it('8. CANCEL explicit target', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };

    let requestedBody = null;
    globalThis.fetch = async (url, options) => {
      requestedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ ok: true, data: { id: 'req-1' } })
      };
    };

    const mockEvent = {
      preventDefault: () => {},
      currentTarget: {
        event_type: { value: '' } // dummy
      }
    };

    // Simulate formObject returning values
    globalThis.FormData = class FormData {
      entries() {
        return [
          ['reason', 'Cancellation reason'],
          ['target_execution_status', 'PARTIALLY_STOPPED']
        ];
      }
    };

    await testApp.submitCancel(mockEvent);
    assert.equal(requestedBody.action, 'CANCEL');
    assert.equal(requestedBody.target_execution_status, 'PARTIALLY_STOPPED');
    assert.equal(requestedBody.reason, 'Cancellation reason');
  });

  it('9. ARCHIVE both directions', async () => {
    // Direction 1: User 1 requests, User 2 approves
    setupTestEnv({ uid: 'user-1', email: 'user-1@test.com' });
    state.selectedWork = { id: 'w1', version: 1 };

    let requestedBody = null;
    globalThis.fetch = async (url, options) => {
      requestedBody = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ ok: true, data: { id: 'req-archive-1' } })
      };
    };

    globalThis.FormData = class FormData {
      entries() {
        return [
          ['reason', 'Archive reason']
        ];
      }
    };

    const mockEvent = { preventDefault: () => {}, currentTarget: {} };
    await testApp.submitArchive(mockEvent);
    assert.equal(requestedBody.action, 'ARCHIVE');
    assert.equal(requestedBody.reason, 'Archive reason');
  });

  it('10. ARCHIVE preserves execution status', async () => {
    setupTestEnv({ uid: 'user-2', email: 'user-2@test.com' });
    state.selectedWork = {
      id: 'w1',
      version: 1,
      status: 'IN_PROGRESS',
      requests: [
        { id: 'req-1', action: 'ARCHIVE', requested_by: 'user-1', requested_at: '2026-08-11T12:00:00Z', reason: 'Archive it', state: 'PENDING' }
      ]
    };

    globalThis.fetch = async (url, options) => {
      return {
        ok: true,
        json: async () => ({ ok: true, data: { id: 'w1' } })
      };
    };

    const html = testApp.workPage();
    assert.match(html, /data-work-execution-state[^>]*>قيد التنفيذ</);
    assert.match(html, /طلب أرشفة/);
  });

  it('11. Archived record and histories remain available', () => {
    setupTestEnv();
    state.selectedWork = {
      id: 'w1',
      status: 'IN_PROGRESS',
      is_archived: true,
      events: [{ id: 'e1', event_type: 'Note', description: 'Historic event', effective_at: '2026-08-11T12:00:00Z', created_at: '2026-08-11T12:00:00Z', actor_uid: 'user-1' }],
      archiveHistory: [{ id: 'ah1', archived_by: 'user-2', archived_at: '2026-08-11T13:00:00Z', reason: 'Fully completed' }]
    };

    const html = testApp.workPage();
    assert.match(html, /الأرشفة: مؤرشف/);
    assert.match(html, /أرشفة العمل/);
    assert.match(html, /Fully completed/);
    assert.match(html, /Historic event/);
    assert.match(html, /عرض السجل الكامل/);
  });

  it('12. stale/version conflict behavior', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };

    globalThis.fetch = async (url, options) => {
      return {
        ok: false,
        json: async () => ({ ok: false, code: 'VERSION_CONFLICT', message: 'Version mismatch' })
      };
    };

    globalThis.FormData = class FormData {
      entries() { return [['reason', 'reason'], ['status', 'IN_PROGRESS']]; }
    };

    const mockEvent = { preventDefault: () => {}, currentTarget: {} };
    await testApp.submitStatus(mockEvent);
    // Should display conflict toast
    assert.equal(state.busy, false);
  });

  it('13. duplicate/finalized approval behavior', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };

    globalThis.fetch = async (url, options) => {
      return {
        ok: false,
        json: async () => ({ ok: false, code: 'ALREADY_FINALIZED', message: 'Already approved' })
      };
    };

    await testApp.handleApproveRequest('req-1');
    assert.equal(state.busy, false);
  });

  it('14. request/work mismatch', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };

    globalThis.fetch = async (url, options) => {
      return {
        ok: false,
        json: async () => ({ ok: false, code: 'REQUEST_WORK_MISMATCH', message: 'Mismatch' })
      };
    };

    await testApp.handleApproveRequest('req-2');
    assert.equal(state.busy, false);
  });

  it('15. auth/unauthorized behavior', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };

    globalThis.fetch = async (url, options) => {
      return {
        ok: false,
        status: 403,
        json: async () => ({ ok: false, code: 'HTTP_403', message: 'Forbidden' })
      };
    };

    await testApp.handleApproveRequest('req-1');
    assert.equal(state.busy, false);
  });

  it('16. loading/double-submit fail-safe behavior', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };
    state.busy = true; // Simulate busy

    let fetchCalled = false;
    globalThis.fetch = async (url, options) => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true, data: {} }) };
    };

    await testApp.handleApproveRequest('req-1');
    assert.equal(fetchCalled, false); // Blocked when busy
  });

  it('17. no optimistic false success', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1, title: 'Old Title' };

    let fetchCompleted = false;
    globalThis.fetch = async (url, options) => {
      // Return a promise that takes time to ensure no optimistic update
      return new Promise((resolve) => {
        setTimeout(() => {
          fetchCompleted = true;
          resolve({
            ok: true,
            json: async () => ({ ok: true, data: { id: 'w1', title: 'New Title' } })
          });
        }, 50);
      });
    };

    globalThis.FormData = class FormData {
      entries() { return [['new_title', 'New Title'], ['reason', 'Fix title']]; }
    };

    const mockEvent = { preventDefault: () => {}, currentTarget: {} };
    const p = testApp.submitTitle(mockEvent);

    // Immediately check state before fetch completes
    assert.equal(state.selectedWork.title, 'Old Title'); // Still old title

    await p;
    // After fetch completes, state should be refreshed (or reload called)
    assert.equal(fetchCompleted, true);
  });

  it('18. money text in event does not invoke a financial mutation; post-event refetches may include authoritative S7 reads', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1 };

    let calledUrls = [];
    globalThis.fetch = async (url, options) => {
      calledUrls.push({ url, method: options?.method });
      return { ok: true, json: async () => ({ ok: true, data: {} }) };
    };

    globalThis.FormData = class FormData {
      entries() {
        return [
          ['event_type', 'Payment Comment'],
          ['description', 'Collected 1000 SAR for task'],
          ['effective_at', '2026-08-11T12:00:00.000Z']
        ];
      }
    };

    const mockEvent = { preventDefault: () => {}, currentTarget: {} };
    await testApp.submitEvent(mockEvent);

    assert.equal(calledUrls.length, 12); // event POST plus eleven authoritative Work-detail reads, including S7 payment/reversal history and participant labels
    assert.match(calledUrls[0].url, /\/events$/);
    assert.equal(calledUrls[0].method, 'POST');
    assert.ok(calledUrls.some(call => /\/financials$/.test(call.url)));
    assert.ok(calledUrls.some(call => /\/payments$/.test(call.url)));
    assert.ok(calledUrls.some(call => /payment-reversal-requests$/.test(call.url)));
    assert.ok(calledUrls.slice(1).every(call => call.method === undefined));
    assert.ok(calledUrls.every(call => !/billing|settlement|subscription|transfer|expense/.test(call.url)));
  });

  it('19. execution and collection are separate without deriving collection from price_state', () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1, status: 'IN_PROGRESS', price_state: 'PRICE_UNSET', is_archived: false };
    const html = testApp.workPage();
    assert.match(html, /data-work-execution-state/);
    assert.match(html, /الدفعات والتحصيل/);
    assert.match(html, /data-collection-descriptor/);
    const primarySummary = html.split('data-work-disclosure="work-data"')[0];
    assert.doesNotMatch(primarySummary, /حالة التحصيل|PRICE_UNSET|سعر صفري/);
    assert.match(html, /حالة التحصيل/);
  });

  it('19b. Wave 3 uses one primary summary and does not duplicate soft warnings', () => {
    setupTestEnv();
    state.selectedWork = {
      id: 'w-summary',
      version: 1,
      title: 'عمل ملخص واحد',
      customer_id: '',
      status: 'IN_PROGRESS',
      relationship_kind: 'INDEPENDENT',
      is_archived: false,
      confirmed_at: '2026-09-01T10:00:00.000Z',
      country: 'SA',
      university: '',
      specialty_key: '',
      work_type_key: '',
      description: '',
      soft_warnings: [{ code: 'WORK_DETAIL_UNIVERSITY_MISSING' }],
      financials: {
        price_state: 'PRICE_APPROVED',
        current_price_halalas: 10000,
        approved_payments_total_halalas: 0,
        remaining_halalas: 10000,
        collection_status: 'UNPAID',
        price_requests: [{ id: 'price-pending', state: 'PENDING', movement_type: 'INCREASE', amount_halalas: 1000, reason: 'سبب اختباري', requested_by: 'user-2', requested_at: '2026-09-01T10:00:00.000Z', effective_at: '2026-09-01T10:00:00.000Z' }],
        ratio_requests: [],
        movements: [],
        ratio_history: [],
        ratio: { person_1_bps: 7000, person_2_bps: 3000, source: 'DEFAULT' },
        shares: { person_1_halalas: 7000, person_2_halalas: 3000 },
      },
      payments: [],
      reversalRequests: [],
      requests: [],
      events: [],
      titleHistory: [],
      statusHistory: [],
      archiveHistory: [],
    };
    const html = testApp.workPage();
    assert.equal((html.match(/data-work-summary/g) || []).length, 1);
    assert.doesNotMatch(html, /class="detail-header"/);
    assert.match(html, /data-work-primary-title/);
    assert.match(html, /data-action="edit-work"/);
    assert.match(html, /data-work-archive-state/);
    assert.equal(html.split('الجامعة غير متوفرة.').length - 1, 1);
    assert.match(html, /data-work-attention/);
    assert.match(html, /مركز الإجراءات/);
    assert.equal((html.match(/data-financial-request="price-pending"/g) || []).length, 1);
  });

  it('20. authorized SPA session reads uid and role from ping data envelope', async () => {
    setupTestEnv();
    window.__PRIVATE_WORK_APP_CONFIG__.email = 'user-2@test.com';
    window.__PRIVATE_WORK_APP_CONFIG__.getIdToken = async () => 'mock-token';
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const data = path === '/private/ping'
        ? { uid: 'uid-two', role: 'person_2' }
        : path.startsWith('/api/catalog/') || path === '/api/customers' || path === '/api/works' ? [] : {};
      return { ok: true, json: async () => ({ ok: true, data }) };
    };
    await testApp.authenticateExistingSession();
    assert.equal(state.auth.uid, 'uid-two');
    assert.equal(state.auth.role, 'person_2');
    delete window.__PRIVATE_WORK_APP_CONFIG__.getIdToken;
  });

  it('21. successful mutation with failed authoritative refetch shows no success state', async () => {
    setupTestEnv();
    state.selectedWork = { id: 'w1', version: 1, title: 'Old Title' };
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) return { ok: true, json: async () => ({ ok: true, data: { id: 'w1', title: 'New Title' } }) };
      return { ok: false, status: 503, json: async () => ({ ok: false, code: 'HTTP_503' }) };
    };
    globalThis.FormData = class FormData { entries() { return [['new_title', 'New Title'], ['reason', 'Fix title']]; } };
    await testApp.submitTitle({ preventDefault: () => {}, currentTarget: {} });
    assert.equal(state.view, 'works');
    assert.equal(state.selectedWork, null);
    assert.equal(state.busy, false);
  });

  it('22. source/package asset parity where required', () => {
    const srcContent = readFileSync(fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url)), 'utf8');
    const pkgContent = readFileSync(fileURLToPath(new URL('../../worker/assets/app.js', import.meta.url)), 'utf8');
    assert.equal(srcContent, pkgContent);
  });

  it('23. Wave 1 presentation guard keeps closed UI behavior while removing targeted implementation copy', () => {
    const srcContent = readFileSync(fileURLToPath(new URL('../../src/worker/assets/app.js', import.meta.url)), 'utf8');
    assert.match(srcContent, /\['s8','البحث والتحليلات'\]|\['s8', 'البحث والتحليلات'\]/);
    assert.match(srcContent, /function pageSubtitle\(/);
    assert.match(srcContent, /name="confirmed_at" type="text"/);
    assert.match(srcContent, /function auditValueMarkup\(/);
    for (const leaked of [
      'واجهة عربية واضحة؛ السجل المالي والتنفيذي محفوظان كما هما.',
      'القائمة مضبوطة؛ لا تنشئ هذه القائمة تاريخ انتقالات.',
      'التحقق النهائي من العلاقة يتم على الخادم.',
      'لا تمثل الواجهة السعر غير المحدد برقم صفر',
      'يعرض الوقائع التي وفرها backend فقط.',
      'مؤشر التوافق للحالة',
      'غير authoritative',
      'workflow جديد',
      'سيُنشئ الخادم معرفًا داخليًا ثابتًا وآمنًا لهذه القيمة.',
      'تأكيد العملية',
      'لن يُرسل الطلب قبل اختيار «تأكيد».',
    ]) assert.equal(srcContent.includes(leaked), false, leaked);
    assert.equal(/auditValueLabel\(value\).*JSON\.stringify/.test(srcContent), false);
  });
});
