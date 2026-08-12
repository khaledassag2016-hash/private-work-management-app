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
  modal: null,
  busy: false,
};

const labels = {
  TOKEN_MISSING: 'يلزم تسجيل الدخول للوصول إلى البيانات الخاصة.',
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
  POST_MUTATION_REFRESH_FAILED: 'تم حفظ التغيير في الخادم، لكن تعذر تحديث العرض الحالي. أعد فتح العمل أو حدّث الصفحة للتحقق من الحالة السلطوية.',
  HTTP_401: 'انتهت الجلسة أو يلزم تسجيل الدخول مجددًا.',
  HTTP_403: 'لا تملك صلاحية تنفيذ هذه العملية.',
  HTTP_404: 'السجل المطلوب غير موجود أو لم يعد متاحًا.',
  HTTP_409: 'توجد حالة تعارض. حدّث البيانات ثم أعد المحاولة.',
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
const CUSTOMER_STATUS_LABELS = Object.freeze({ normal: 'محايد للتوافق؛ الوقائع والتحذيرات الموثقة هي مصدر الحقيقة' });

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
function dateLabel(value) {
  if (!value) return 'غير متاح';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium' }).format(date);
}
function idLabel(value) { return value ? `${String(value).slice(0, 8)}…` : '—'; }
function dateTimeLabel(value) {
  if (!value) return 'غير متاح';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function requestId() { return crypto.randomUUID(); }
function toast(message, kind = '') {
  const region = document.querySelector('.toast-region') || Object.assign(document.createElement('div'), { className: 'toast-region' });
  if (!region.parentNode) document.body.append(region);
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), 4400);
}
function setBusy(value) { state.busy = value; }
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
  return {
    async getToken() { return auth.currentUser ? auth.currentUser.getIdToken() : null; },
    signIn(email, password) { return signInWithEmailAndPassword(auth, email, password); },
    signOut() { return signOut(auth); },
    observe(callback) { return onAuthStateChanged(auth, callback); },
    email: auth.currentUser?.email || '',
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
async function loadDashboard() {
  const [customers, works] = await Promise.all([api('/api/customers'), api('/api/works')]);
  state.customers = customers; state.works = works;
}
async function authenticateExistingSession() {
  try {
    const adapter = await createFirebaseAdapter();
    if (!adapter) { state.auth.status = 'needs_configuration'; render(); return; }
    state.auth.tokenProvider = adapter;
    const token = await adapter.getToken();
    if (!token) { state.auth.status = 'signed_out'; render(); return; }
    const ping = await api('/private/ping');
    state.auth.status = 'signed_in';
    state.auth.uid = ping.uid || '';
    state.auth.email = adapter.email || '';
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
  const message = state.auth.status === 'forbidden' ? 'تم التحقق من الحساب، لكنه غير موجود في قائمة السماح المكونة من الشخصين.' : configured ? 'سجّل الدخول بحساب Firebase الذي أنشأه المشرف. لا توجد شاشة تسجيل حسابات جديدة.' : 'تحتاج الواجهة إلى تهيئة Firebase العامة وقت النشر. لا تُدرج هذه التهيئة أي كلمة مرور أو token أو مفتاح خدمة.';
  return `<section class="auth-screen"><div class="auth-card">
    <div class="brand-lockup"><div class="brand-mark">إ</div><div><h1>إدارة الأعمال الخاصة</h1><p>مساحة مغلقة لشخصين فقط</p></div></div>
    <h2>${state.auth.status === 'forbidden' ? 'الوصول غير مصرح' : 'تسجيل الدخول'}</h2><p>${message}</p>
    ${configured && state.auth.status !== 'forbidden' ? `<form id="login-form" class="grid"><div class="field"><label for="email">البريد الإلكتروني</label><input id="email" class="input" type="email" required autocomplete="email" /></div><div class="field"><label for="password">كلمة المرور</label><input id="password" class="input" type="password" required autocomplete="current-password" /></div><button class="button" type="submit">تسجيل الدخول</button></form>` : ''}
  </div></section>`;
}

function shell(content) {
  const nav = [
    ['dashboard', 'نظرة عامة'], ['customers', 'العملاء'], ['works', 'الأعمال'], ['catalogs', 'القوائم'],
  ].map(([id, label]) => `<button class="nav-item" data-nav="${id}" ${state.view === id ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  return `<div class="shell"><aside class="sidebar"><div class="brand-lockup"><div class="brand-mark">إ</div><div><h1>إدارة الأعمال</h1><p>العملاء والأعمال</p></div></div><nav class="nav-list" aria-label="التنقل الرئيسي">${nav}</nav><div class="sidebar-footer">يُعالج التفويض والتحقق في Worker. لا تمنح الواجهة صلاحية إضافية ولا تصل إلى D1 مباشرة.</div></aside><section class="content"><header class="topbar"><div><h1>${pageTitle()}</h1><p>واجهة S4 العملية — الحالة الحالية والوقائع الموثقة فقط</p></div><div class="identity"><div><strong>${escapeHtml(state.auth.email || 'حساب مصرح')}</strong><br/><span>${escapeHtml(state.auth.role || 'مستخدم مسموح')}</span></div><div class="avatar">${escapeHtml((state.auth.email || 'م').slice(0, 1))}</div><button class="button ghost" id="sign-out" type="button">خروج</button></div></header>${content}</section></div>${modalMarkup()}`;
}
function pageTitle() { return ({ dashboard: 'نظرة عامة', customers: 'العملاء', works: 'الأعمال', catalogs: 'القوائم', customer: 'سجل العميل', work: 'تفاصيل العمل' }[state.view] || 'إدارة الأعمال'); }
function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function loading(message = 'جارٍ تحميل البيانات…') { return `<div class="loading"><span class="spinner"></span>${escapeHtml(message)}</div>`; }
function badgeForWork(work) { return work.price_state === 'PRICE_UNSET' ? '<span class="badge unset">السعر غير محدد</span>' : '<span class="badge zero">سعر صفري</span>'; }
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
function dashboard() {
  const followUp = state.works.filter(work => work.price_state === 'PRICE_UNSET');
  return `<div class="grid grid-3"><div class="stat"><small>العملاء المسجلون</small><strong>${state.customers.length}</strong></div><div class="stat"><small>الأعمال الحالية</small><strong>${state.works.length}</strong></div><div class="stat"><small>تحتاج متابعة سعر</small><strong class="accent">${followUp.length}</strong></div></div>
  <section class="card" style="margin-top:1rem"><div class="toolbar"><div><h2>أعمال بلا سعر</h2><p>هذه قائمة متابعة تشغيلية فقط؛ لا تمثل سعرًا بقيمة صفر.</p></div><button class="button" data-action="new-work" type="button">إضافة عمل</button></div>${followUp.length ? worksTable(followUp) : empty('لا توجد أعمال بسعر غير محدد حاليًا.')}</section>`;
}
function worksTable(works) { return `<div class="table-wrap"><table><thead><tr><th>العنوان</th><th>العميل</th><th>النوع</th><th>الحالة</th><th>السعر</th><th></th></tr></thead><tbody>${works.map(work => `<tr><td>${escapeHtml(work.title)}</td><td>${escapeHtml(customerName(work.customer_id))}</td><td>${escapeHtml(work.work_type_key || 'غير محدد')}</td><td>${escapeHtml(work.status)}</td><td>${badgeForWork(work)}</td><td><button class="row-action" data-work="${escapeHtml(work.id)}">عرض</button></td></tr>`).join('')}</tbody></table></div>`; }
function customersTable(customers) { return `<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الدولة</th><th>الجامعة</th><th>التخصص</th><th>الأعمال</th><th></th></tr></thead><tbody>${customers.map(customer => `<tr><td>${escapeHtml(customer.name || 'اسم غير متاح')}</td><td>${escapeHtml(customer.country || '—')}</td><td>${escapeHtml(customer.university || '—')}</td><td>${escapeHtml(customer.specialty || '—')}</td><td>${state.works.filter(work => work.customer_id === customer.id).length}</td><td><button class="row-action" data-customer="${escapeHtml(customer.id)}">فتح السجل</button></td></tr>`).join('')}</tbody></table></div>`; }
function customerName(id) { return state.customers.find(customer => customer.id === id)?.name || idLabel(id); }
function customersPage() { return `<section class="card"><div class="toolbar"><div><h2>العملاء</h2><p>بيانات العميل الأساسية وسجل الوقائع المتاح.</p></div><div class="toolbar-right"><input class="input" id="customer-search" placeholder="ابحث بالاسم أو الجامعة أو التخصص" style="width:260px" /><button class="button" data-action="new-customer" type="button">إضافة عميل</button></div></div>${customersTable(state.customers)}</section>`; }
function worksPage() { return `<section class="card"><div class="toolbar"><div><h2>الأعمال</h2><p>كل عمل سجل مستقل، حتى عند وجود علاقة تابع/أصل.</p></div><button class="button" data-action="new-work" type="button">إضافة عمل</button></div>${state.works.length ? worksTable(state.works) : empty('لا توجد أعمال بعد. أنشئ أول عمل من هنا أو من سجل العميل.')}</section>`; }
function catalogsPage() { return `<section class="grid grid-3">${['country', 'specialty', 'work_type'].map(kind => `<article class="card"><div class="toolbar"><h2>${({ country: 'الدول', specialty: 'التخصصات', work_type: 'أنواع الأعمال' }[kind])}</h2><button class="button secondary" data-action="new-catalog" data-kind="${kind}" type="button">إضافة قيمة</button></div>${catalogList(kind)}</article>`).join('')}</section>`; }
function catalogList(kind) { const values = state.catalogs[kind] || []; return values.length ? `<div class="fact-list">${values.map(value => `<li><strong>${escapeHtml(value.label)}</strong><span>${escapeHtml(value.value_key)} ${value.active ? '' : '— غير نشط'}</span></li>`).join('')}</div>` : empty('لا توجد قيم بعد.'); }
function customerPage() {
  const customer = state.selectedCustomer; if (!customer) return loading();
  const works = customer.works || []; const warnings = customer.warnings || []; const history = customer.history || [];
  return `<section class="detail-header"><div><h2>${escapeHtml(customer.name || 'عميل دون اسم')}</h2><div class="detail-meta"><span>الدولة: ${escapeHtml(customer.country || 'غير متاحة')}</span><span>الجامعة: ${escapeHtml(customer.university || 'غير متاحة')}</span><span>التخصص: ${escapeHtml(customer.specialty || 'غير متاح')}</span></div></div><div class="toolbar-right"><button class="button ghost" data-action="edit-customer" type="button">تعديل العميل</button><button class="button" data-action="new-work" data-customer-id="${escapeHtml(customer.id)}" type="button">إضافة عمل</button></div></section>
  ${warnings.length ? `<section class="notice warning" style="margin-bottom:1rem"><strong>تنبيه مبني على وقائع موثقة:</strong><div>${warnings.map(item => `${escapeHtml(item.warning_type)} — ${escapeHtml(item.source_ref)} (${dateLabel(item.happened_at)})`).join('<br/>')}</div></section>` : '<section class="notice info" style="margin-bottom:1rem">لا توجد تحذيرات موثقة لهذا العميل.</section>'}
  <section class="grid grid-2"><article class="card"><div class="toolbar"><div><h2>أعمال العميل</h2><p>لكل عمل هوية وسجل مستقلان.</p></div></div>${works.length ? worksTable(works) : empty('لا توجد أعمال مسجلة لهذا العميل.')}</article><article class="card"><div class="toolbar"><div><h2>تاريخ التعامل المتاح</h2><p>يعرض الوقائع التي وفرها backend فقط.</p></div><button class="button secondary" data-action="new-fact" type="button">إضافة واقعة موثقة</button></div>${history.length ? `<ul class="fact-list">${history.map(item => `<li><strong>${escapeHtml(item.fact_type)} — ${escapeHtml(item.source_ref)}</strong><span>${dateLabel(item.happened_at)}</span></li>`).join('')}</ul>` : empty('لا توجد وقائع موثقة بعد.')}</article></section>`;
}
function workPage() {
  const work = state.selectedWork; if (!work) return loading(); const similar = work.similar || [];
  const statusText = WORK_STATUS_LABELS[work.status] || work.status;

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
        <span>المعرف: ${escapeHtml(idLabel(work.id))}</span>
        <span>العميل: ${escapeHtml(customerName(work.customer_id))}</span>
        <span>العلاقة: ${escapeHtml(work.relationship_kind)}</span>
        <span>${badgeForWork(work)}</span>
        <span class="badge ok">الحالة الحالية: ${escapeHtml(statusText)}</span>
        <span class="badge ${work.is_archived ? 'ok' : 'unset'}">الأرشفة: ${escapeHtml(archiveDisplay)}</span>
        <span class="badge ok">الإصدار: ${escapeHtml(work.version)}</span>
      </div>
    </div>
    <button class="button ghost" data-action="edit-work" type="button">تعديل العمل</button>
  </section>
  ${softWarningsMarkup(work)}

  <section class="grid grid-2" data-execution-collection-separation>
    <article class="card" data-execution-status>
      <h2>حالة التنفيذ</h2>
      <p>الحالة السلطوية الحالية للعمل هي:</p>
      <div class="badge ok">${escapeHtml(statusText)}</div>
      <p class="hint">تُغيّر عبر مسارات التنفيذ وسجل الحالات فقط.</p>
    </article>
    <article class="card" data-collection-status>
      <h2>حالة التحصيل</h2>
      <p>لا توجد حالة تحصيل مشتقة أو مخترعة داخل S5.</p>
      <p class="hint">المصدر المالي الحاكم غير متاح ضمن S5؛ سيأتي من S7. لا تُشتق هذه الحدود من <code>price_state</code>.</p>
    </article>
  </section>

  <section class="grid grid-2">
    <article class="card">
      <h2>البيانات الحالية</h2>
      <div class="fact-list">
        <li><strong>الدولة والجامعة</strong><span>${escapeHtml(work.country || '—')} — ${escapeHtml(work.university || 'غير متاحة')}</span></li>
        <li><strong>النوع والتخصص</strong><span>${escapeHtml(work.work_type_key || 'غير محدد')} — ${escapeHtml(work.specialty_key || 'غير محدد')}</span></li>
        <li><strong>المادة/الرمز</strong><span>${escapeHtml(work.subject_or_course_code || 'غير متاح')}</span></li>
        <li><strong>الوصف</strong><span>${escapeHtml(work.description || 'لا يوجد وصف')}</span></li>
      </div>
    </article>
    <article class="card">
      <h2>أعمال مشابهة متاحة للقراءة</h2>
      <p>لا تظهر أي حركة تسعير أو موافقات؛ هذه حدود قراءة S4 فقط.</p>
      ${similar.length ? `<ul class="fact-list">${similar.map(item => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.work_type_key || 'غير محدد')} — ${dateLabel(item.created_at)} — ${item.price_state === 'PRICE_UNSET' ? 'سعر غير حدد' : 'سعر صفري'}</span></li>`).join('')}</ul>` : empty('لا توجد أعمال مشابهة ضمن البيانات المتاحة.')}
    </article>
  </section>

  <!-- S5 PR-B BUSINESS FLOWS -->
  <section class="grid grid-2" style="margin-top: 1.5rem;">
    <!-- CARD 1: EVENTS -->
    <article class="card">
      <h2>أحداث العمل</h2>
      <p>تسجيل زمني لكافة الأنشطة والاتصالات المرتبطة بالعمل.</p>
      <form id="s5-event-form" class="form-grid" style="margin-top: 1rem; margin-bottom: 1.5rem;">
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
                  بواسطة: ${escapeHtml(idLabel(ev.actor_uid))} | وقت الحدث: ${dateTimeLabel(ev.effective_at)} | تاريخ التسجيل: ${dateTimeLabel(ev.created_at)}
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
      <form id="s5-title-form" class="form-grid" style="margin-top: 1rem; margin-bottom: 1.5rem;">
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
                  بواسطة: ${escapeHtml(idLabel(th.changed_by))} | وقت التغيير: ${dateTimeLabel(th.changed_at)}
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
      <form id="s5-status-form" class="form-grid" style="margin-top: 1rem; margin-bottom: 1.5rem;">
        <div class="field">
          <label>الحالة العادية <span class="required">*</span></label>
          <select class="select" name="status" required>
            <option value="">— اختر الحالة —</option>
            ${ordinaryStatuses.map(s => `<option value="${s}" ${work.status === s ? 'selected' : ''}>${escapeHtml(WORK_STATUS_LABELS[s] || s)}</option>`).join('')}
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
                <strong>الحالة القديمة: ${escapeHtml(WORK_STATUS_LABELS[sh.old_status] || sh.old_status)} ← الجديدة: ${escapeHtml(WORK_STATUS_LABELS[sh.new_status] || sh.new_status)}</strong>
                <span>السبب: ${escapeHtml(sh.reason)}</span>
                <span style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                  بواسطة: ${escapeHtml(idLabel(sh.changed_by))} | وقت التغيير: ${dateTimeLabel(sh.changed_at)}
                </span>
              </li>
            `).join('')}
          </ul>
        ` : empty('لا يوجد تاريخ لتغييرات الحالة.')}
      </div>
    </article>
  </section>

  <section class="grid grid-2" style="margin-top: 1.5rem;">
    <!-- CARD 3: REQUESTS GOVERNED FLOW (CANCEL / ARCHIVE) -->
    <article class="card">
      <h2>طلبات الإلغاء والأرشفة (تحتاج موافقة الحساب الآخر)</h2>
      <p>يتطلب الإلغاء والأرشفة موافقة ثنائية مستقلة من الحساب الآخر (المستندة إلى دورة موافقة الطرفين).</p>

      <!-- CANCEL REQUEST FORM -->
      <div style="background: var(--canvas); padding: 1rem; border-radius: 12px; margin-top: 1rem;">
        <h3>تقديم طلب إلغاء</h3>
        <form id="s5-cancel-form" class="form-grid" style="margin-top: 0.5rem;">
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
              const targetLabel = req.target_execution_status ? ` ← ${escapeHtml(WORK_STATUS_LABELS[req.target_execution_status] || req.target_execution_status)}` : '';
              return `
                <div style="border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem; background: ${isPending ? 'var(--warning-soft)' : 'var(--success-soft)'};">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap;">
                    <strong>طلب ${actionLabel}${targetLabel}</strong>
                    <span class="badge ${isPending ? 'unset' : 'ok'}">${isPending ? 'معلق بانتظار الاعتماد' : 'تم الاعتماد ومطابقة الطلب'}</span>
                  </div>
                  <div style="font-size: 0.75rem; margin-top: 0.35rem;"><strong>السبب:</strong> ${escapeHtml(req.reason)}</div>
                  <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">
                    الطالب: ${escapeHtml(idLabel(req.requested_by))} | وقت الطلب: ${dateTimeLabel(req.requested_at)}
                  </div>
                  ${req.approved_by ? `
                    <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.15rem;">
                      المعتمد: ${escapeHtml(idLabel(req.approved_by))} | وقت الاعتماد: ${dateTimeLabel(req.approved_at)}
                    </div>
                  ` : ''}
                  ${isPending ? `
                    <div style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
                      ${isSelf ? `
                        <span class="badge warn" style="font-size: 0.65rem;">بانتظار اعتماد الحساب الآخر (لا يمكنك اعتماد طلبك بموجب الموافقة الثنائية)</span>
                      ` : `
                        <button class="button" data-action="approve-request" data-request-id="${req.id}" style="min-height: 28px; padding: 0.2rem 0.6rem; font-size: 0.7rem; background: var(--teal);" ${state.busy ? 'disabled' : ''}>اعتماد الطلب</button>
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
                  بواسطة: ${escapeHtml(idLabel(ah.archived_by))} | وقت الأرشفة: ${dateTimeLabel(ah.archived_at)}
                </span>
              </li>
            `).join('')}
          </ul>
        ` : empty('لم يتم أرشفة هذا العمل من قبل.')}
      </div>
    </article>
  </section>
  `;
}
function modalMarkup() {
  if (!state.modal) return '';
  const { type, data = {} } = state.modal;
  return `<div class="dialog-backdrop" role="presentation"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header class="dialog-head"><h2 id="dialog-title">${({ customer: data.id ? 'تعديل بيانات العميل' : 'إضافة عميل', work: data.id ? 'تعديل العمل' : 'إضافة عمل', catalog: 'إضافة قيمة للقائمة', fact: 'إضافة واقعة موثقة' }[type])}</h2><button class="close" data-action="close-modal" type="button" aria-label="إغلاق">×</button></header>${type === 'customer' ? customerForm(data) : type === 'work' ? workForm(data) : type === 'catalog' ? catalogForm(data) : factForm(data)}</section></div>`;
}
function options(kind, selected) { return `<option value="">— اختر عند توفر المعلومة —</option>${(state.catalogs[kind] || []).filter(item => item.active).map(item => `<option value="${escapeHtml(item.value_key)}" ${item.value_key === selected ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}`; }
function customerForm(customer = {}) {
  const duplicates = state.modal?.duplicateCandidates || [];
  const duplicateNotice = duplicates.length ? `<section class="notice warning" style="margin-bottom:1rem"><div><strong>يوجد عميل باسم مماثل.</strong><br/>${duplicates.map(item => `${escapeHtml(item.name || 'عميل دون اسم')} — ${escapeHtml(item.university || 'جامعة غير متاحة')}`).join('<br/>')}<br/><label><input type="checkbox" name="confirm_duplicate" value="yes" required/> راجعت السجلات وأؤكد أن هذا عميل جديد مستقل.</label></div></section>` : '';
  return `<form id="customer-form">${duplicateNotice}<input type="hidden" name="id" value="${escapeHtml(customer.id || '')}"/><input type="hidden" name="version" value="${escapeHtml(customer.version || '')}"/><div class="form-grid"><div class="field"><label>اسم العميل (عند توفره)</label><input class="input" name="name" value="${escapeHtml(customer.name || '')}"/><span class="hint">يمكن حفظ السجل دون اسم عندما لا تكون المعلومة متوفرة.</span></div><div class="field"><label>رقم التواصل</label><input class="input" name="contact" value="${escapeHtml(customer.contact || '')}" inputmode="tel"/></div><div class="field"><label>الدولة</label><select class="select" name="country">${options('country', customer.country)}</select></div><div class="field"><label>الجامعة</label><input class="input" name="university" value="${escapeHtml(customer.university || '')}"/><span class="hint">اختيارية عند عدم توفرها.</span></div><div class="field"><label>التخصص</label><select class="select" name="specialty">${options('specialty', customer.specialty)}</select><span class="hint">أدخله عند معرفته، دون منع حفظ المعلومة المفقودة.</span></div><div class="field"><label>مؤشر التوافق للحالة</label><div class="readonly-value" data-derived-customer-status="${escapeHtml(customer.status || 'normal')}">${escapeHtml(CUSTOMER_STATUS_LABELS[customer.status] || CUSTOMER_STATUS_LABELS.normal)}</div><span class="hint">هذا الحقل محايد وغير authoritative؛ الوقائع والتحذيرات الموثقة هي مصدر الحقيقة ولا يمكن إدخال حالة وقائعية يدويًا.</span></div><div class="field full"><label>ملاحظات</label><textarea class="textarea" name="notes">${escapeHtml(customer.notes || '')}</textarea></div></div><div class="form-actions"><button class="button" type="submit">حفظ</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }
function preAgreementCanSubmitNewWork(customerId) {
  const context = state.modal?.preAgreementContext;
  return Boolean(customerId && context?.customerId === customerId && context.status === 'VERIFIED');
}
function preAgreementContextMarkup(isNewWork, customerId) {
  if (!isNewWork) return '';
  const context = state.modal?.preAgreementContext || { customerId, status: customerId ? 'LOADING' : 'UNSELECTED', warnings: [], history: [] };
  if (context.status === 'LOADING') return '<section class="notice info" data-pre-agreement-context="loading" data-pre-agreement-warning="loading">جارٍ تحميل تحذيرات العميل وتاريخ التعامل المتاح قبل بدء العمل. لا يمكن الحفظ حتى يكتمل التحقق.</section>';
  if (context.status === 'ERROR') return `<section class="notice warning" data-pre-agreement-context="error" data-pre-agreement-warning="error"><strong>تعذر تحميل سياق العميل قبل الحفظ.</strong><p>${escapeHtml(errorMessage('WARNING_CONTEXT_UNAVAILABLE'))}</p><button class="button secondary" type="button" data-action="retry-pre-agreement-context">إعادة تحميل السياق</button></section>`;
  if (context.status === 'UNSELECTED') return '<section class="notice info" data-pre-agreement-context="unselected" data-pre-agreement-warning="unselected">اختر العميل أولًا لتحميل التحذيرات وتاريخ التعامل المتاح قبل الحفظ.</section>';
  const warnings = context.warnings || [];
  const history = context.history || [];
  const warningMarkup = warnings.length
    ? `<section class="notice warning" data-pre-agreement-context="verified" data-pre-agreement-warning="present"><strong>تحذير قبل إنشاء العمل:</strong><div>${warnings.map(item => `${escapeHtml(item.warning_type)} — ${escapeHtml(item.source_ref)} (${dateTimeLabel(item.happened_at)})`).join('<br/>')}</div><p>ظهر التحذير من واقعة موثقة. يمكنك المتابعة؛ لا توجد موافقة إضافية أو workflow جديد.</p></section>`
    : '<section class="notice info" data-pre-agreement-context="verified" data-pre-agreement-warning="none">تم التحقق من التحذيرات المتاحة: لا توجد تحذيرات موثقة لهذا العميل.</section>';
  const historyMarkup = history.length
    ? `<section class="notice info" data-pre-agreement-history="present"><strong>تاريخ التعامل المتاح قبل الاتفاق:</strong><ul class="fact-list">${history.map(item => `<li><strong>${escapeHtml(item.fact_type)}</strong><span>المصدر/المرجع: ${escapeHtml(item.source_ref || 'غير متاح')} — ${dateTimeLabel(item.happened_at)}</span></li>`).join('')}</ul></section>`
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
  const submitHint = submitDisabled ? '<p class="hint" data-pre-agreement-submit-state="blocked">يُفعّل الحفظ بعد اختيار العميل والتحقق من التحذيرات وتاريخ التعامل المتاحين.</p>' : '';
  return `<form id="work-form">${contextMarkup}${detailWarningsMarkup}<input type="hidden" name="id" value="${escapeHtml(work.id || '')}"/><input type="hidden" name="version" value="${escapeHtml(work.version || '')}"/><div class="form-grid"><div class="field"><label>العميل <span class="required">*</span></label><select class="select" id="work-customer" name="customer_id" required ${work.id ? 'disabled' : ''}><option value="">— اختر العميل —</option>${state.customers.map(customer => `<option value="${escapeHtml(customer.id)}" ${customer.id === customerId ? 'selected' : ''}>${escapeHtml(customer.name || idLabel(customer.id))}</option>`).join('')}</select>${work.id ? `<input type="hidden" name="customer_id" value="${escapeHtml(customerId)}"/>` : ''}</div><div class="field"><label>العنوان <span class="required">*</span></label><input class="input" name="title" value="${escapeHtml(work.title || '')}" required/><span class="hint">لا يكتفى بعنوان عام عندما تكون التفاصيل متاحة.</span></div><div class="field"><label>الدولة <span class="required">*</span></label><select class="select" name="country" required>${options('country', work.country)}</select></div><div class="field"><label>الجامعة</label><input class="input" name="university" value="${escapeHtml(work.university || '')}"/></div><div class="field"><label>التخصص</label><select class="select" name="specialty_key">${options('specialty', work.specialty_key)}</select></div><div class="field"><label>نوع العمل</label><select class="select" name="work_type_key">${options('work_type', work.work_type_key)}</select></div><div class="field"><label>المادة أو الرمز</label><input class="input" name="subject_or_course_code" value="${escapeHtml(work.subject_or_course_code || '')}"/></div><div class="field"><label>الكمية</label><input class="input" name="quantity" type="number" min="1" value="${escapeHtml(work.quantity || '')}"/></div><div class="field"><label>الحالة الأساسية الحالية</label><select class="select" name="status" data-controlled-work-status>${statusOptions}</select><span class="hint">قائمة S4 مضبوطة؛ لا تنشئ سجل انتقالات أو timeline.</span></div><div class="field"><label>علاقة العمل</label><select class="select" id="relationship-kind" name="relationship_kind"><option value="INDEPENDENT" ${work.relationship_kind !== 'CHILD' ? 'selected' : ''}>مستقل</option><option value="CHILD" ${work.relationship_kind === 'CHILD' ? 'selected' : ''}>تابع لعمل أكبر</option></select></div><div class="field" id="parent-field" ${work.relationship_kind === 'CHILD' ? '' : 'hidden'}><label>العمل الأصل</label><select class="select" name="parent_work_id"><option value="">— اختر العمل الأصل —</option>${customerWorks.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === work.parent_work_id ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select><span class="hint">التحقق النهائي من العلاقة يتم على الخادم.</span></div><div class="field full"><label>الوصف والمطلوب</label><textarea class="textarea" name="description">${escapeHtml(work.description || '')}</textarea></div></div><section class="notice info" style="margin-top:1rem">ينشأ العمل هنا بحالة <strong>PRICE_UNSET</strong> عند الإضافة. لا تمثل الواجهة السعر غير المحدد برقم 0 ولا تقدم workflow للتسعير.</section>${submitHint}<div class="form-actions"><button class="button" type="submit" ${submitDisabled ? 'disabled aria-disabled="true"' : ''}>حفظ العمل</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`;
}
function catalogForm(data) { return `<form id="catalog-form"><input type="hidden" name="kind" value="${escapeHtml(data.kind || '')}"/><div class="form-grid"><div class="field"><label>المعرف النصي <span class="required">*</span></label><input class="input" name="value_key" required pattern="[A-Za-z0-9_-]+"/><span class="hint">قيمة مستقرة فريدة للاستخدام الداخلي.</span></div><div class="field"><label>الاسم الظاهر <span class="required">*</span></label><input class="input" name="label" required/></div></div><div class="form-actions"><button class="button" type="submit">إضافة واستخدام القيمة</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }
function factForm() { const customer = state.selectedCustomer; return `<form id="fact-form"><div class="form-grid"><div class="field"><label>نوع الواقعة <span class="required">*</span></label><select class="select" name="fact_type" required><option value="NON_PAYMENT">عدم دفع</option><option value="DELAY">تأخر</option><option value="BLOCKED">حظر/انقطاع</option><option value="DISPUTE">نزاع</option></select></div><div class="field"><label>العمل المرتبط (اختياري)</label><select class="select" name="work_id"><option value="">— دون عمل محدد —</option>${(customer.works || []).map(work => `<option value="${escapeHtml(work.id)}">${escapeHtml(work.title)}</option>`).join('')}</select></div><div class="field full"><label>المصدر أو الدليل <span class="required">*</span></label><input class="input" name="source_ref" required placeholder="مرجع موثق دون إدخال بيانات حساسة"/></div><div class="field"><label>وقت الواقعة <span class="required">*</span></label><input class="input" name="happened_at" type="datetime-local" required/></div><div class="field full"><label>تفاصيل مختصرة</label><textarea class="textarea" name="details"></textarea></div></div><section class="notice info" style="margin-top:1rem">لن يُنشأ تحذير يدوي؛ سيظهر التحذير فقط لأن هذه الواقعة الموثقة سجلت بنجاح.</section><div class="form-actions"><button class="button" type="submit">حفظ الواقعة</button><button class="button ghost" data-action="close-modal" type="button">إلغاء</button></div></form>`; }

function render() {
  if (state.auth.status !== 'signed_in') { root.innerHTML = authScreen(); bindAuth(); return; }
  const content = state.view === 'dashboard' ? dashboard() : state.view === 'customers' ? customersPage() : state.view === 'works' ? worksPage() : state.view === 'catalogs' ? catalogsPage() : state.view === 'customer' ? customerPage() : workPage();
  root.innerHTML = shell(content); bindShell();
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
  document.querySelector('#sign-out')?.addEventListener('click', async () => { await state.auth.tokenProvider?.signOut?.(); state.auth = { status: 'signed_out', tokenProvider: state.auth.tokenProvider, email: '', role: '' }; render(); });
  document.querySelectorAll('[data-customer]').forEach(button => button.addEventListener('click', () => openCustomer(button.dataset.customer)));
  document.querySelectorAll('[data-work]').forEach(button => button.addEventListener('click', () => openWork(button.dataset.work)));
  document.querySelectorAll('[data-action="new-customer"]').forEach(button => button.addEventListener('click', () => { state.modal = { type: 'customer', data: {} }; render(); }));
  document.querySelectorAll('[data-action="edit-customer"]').forEach(button => button.addEventListener('click', () => { state.modal = { type: 'customer', data: state.selectedCustomer }; render(); }));
  document.querySelectorAll('[data-action="new-work"]').forEach(button => button.addEventListener('click', () => { void openNewWork(button.dataset.customerId || ''); }));
  document.querySelectorAll('[data-action="edit-work"]').forEach(button => button.addEventListener('click', () => { state.modal = { type: 'work', data: state.selectedWork, customerId: state.selectedWork.customer_id }; render(); }));
  document.querySelectorAll('[data-action="new-catalog"]').forEach(button => button.addEventListener('click', () => { state.modal = { type: 'catalog', data: { kind: button.dataset.kind } }; render(); }));
  document.querySelectorAll('[data-action="new-fact"]').forEach(button => button.addEventListener('click', () => { state.modal = { type: 'fact', data: {} }; render(); }));
  document.querySelectorAll('[data-action="retry-pre-agreement-context"]').forEach(button => button.addEventListener('click', () => { const customerId = state.modal?.customerId; if (state.modal?.type === 'work' && !state.modal.data?.id && customerId) void refreshWorkCustomerContext(customerId, state.modal.data || {}); }));
  document.querySelectorAll('[data-action="close-modal"]').forEach(button => button.addEventListener('click', () => { state.modal = null; render(); }));
  document.querySelector('#customer-search')?.addEventListener('input', async event => { try { state.customers = await api(`/api/customers${queryString({ q: event.target.value })}`); render(); } catch (error) { toast(errorMessage(error.code), 'error'); } });
  bindModalForms();
  document.querySelector('#s5-event-form')?.addEventListener('submit', submitEvent);
  document.querySelector('#s5-title-form')?.addEventListener('submit', submitTitle);
  document.querySelector('#s5-status-form')?.addEventListener('submit', submitStatus);
  document.querySelector('#s5-cancel-form')?.addEventListener('submit', submitCancel);
  document.querySelector('#s5-archive-form')?.addEventListener('submit', submitArchive);
  document.querySelectorAll('[data-action="approve-request"]').forEach(button => button.addEventListener('click', () => handleApproveRequest(button.dataset.requestId)));
}
function formObject(form) { return Object.fromEntries(new FormData(form).entries()); }
function nullable(value) { return value === '' ? null : value; }
function bindModalForms() {
  document.querySelector('#customer-form')?.addEventListener('submit', submitCustomer);
  document.querySelector('#work-form')?.addEventListener('submit', submitWork);
  document.querySelector('#catalog-form')?.addEventListener('submit', submitCatalog);
  document.querySelector('#fact-form')?.addEventListener('submit', submitFact);
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
  const body = { customer_id: values.customer_id, title: values.title, country: values.country, university: nullable(values.university), specialty_key: nullable(values.specialty_key), work_type_key: nullable(values.work_type_key), subject_or_course_code: nullable(values.subject_or_course_code), status: values.status, quantity: values.quantity ? Number(values.quantity) : null, relationship_kind: values.relationship_kind, parent_work_id: values.relationship_kind === 'CHILD' ? nullable(values.parent_work_id) : null, description: nullable(values.description) };
  await submitFlow(async () => {
    const result = values.id ? await api(`/api/works/${encodeURIComponent(values.id)}`, { method: 'PATCH', body: { ...body, version: Number(values.version) } }) : await api('/api/works', { method: 'POST', body });
    state.modal = null;
    await loadDashboard();
    await refreshWorkAfterMutation(result.id, values.id ? 'تم تحديث العمل.' : 'تم إنشاء العمل بسعر غير محدد.');
  });
}
async function submitCatalog(event) { event.preventDefault(); const values = formObject(event.currentTarget); await submitFlow(async () => { await api(`/api/catalog/${encodeURIComponent(values.kind)}`, { method: 'POST', body: { value_key: values.value_key, label: values.label } }); state.modal = null; await loadCatalogs(); render(); toast('أضيفت القيمة وأصبحت متاحة دون تعديل source code.', ''); }); }
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
async function refreshForView() { try { if (state.view === 'dashboard' || state.view === 'customers' || state.view === 'works') await loadDashboard(); if (state.view === 'catalogs') await loadCatalogs(); render(); } catch (error) { toast(errorMessage(error.code), 'error'); } }
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
    const [work, similar, events, titleHistory, statusHistory, archiveHistory, requests] = await Promise.all([
      api(`/api/works/${encodeURIComponent(workId)}`),
      api(`/api/works/${encodeURIComponent(workId)}/similar`),
      api(`/api/works/${encodeURIComponent(workId)}/events`),
      api(`/api/works/${encodeURIComponent(workId)}/title-history`),
      api(`/api/works/${encodeURIComponent(workId)}/status-history`),
      api(`/api/works/${encodeURIComponent(workId)}/archive-history`),
      api(`/api/works/${encodeURIComponent(workId)}/requests`)
    ]);
    state.selectedWork = {
      ...work,
      similar,
      events,
      titleHistory,
      statusHistory,
      archiveHistory,
      requests
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

async function handleApproveRequest(reqId) {
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

if (window.__PRIVATE_WORK_APP_TEST__) Object.assign(window.__PRIVATE_WORK_APP_TEST__, { getState: () => state, customerForm, workForm, workPage, softWarningsMarkup, softWarningLabel, openWork, authenticateExistingSession, openNewWork, refreshWorkCustomerContext, preAgreementCanSubmitNewWork, preAgreementContextMarkup, submitWork, errorMessage, submitEvent, submitTitle, submitStatus, submitCancel, submitArchive, handleApproveRequest });
authenticateExistingSession();
