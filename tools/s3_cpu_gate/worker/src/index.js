const DEFAULT_CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certificateCache = { expiresAt: 0, certificates: null };

class DomainError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

function reject(status, code, requestId, cacheState = 'none', runMarker = '', scenario = '') {
  const s3Correlation = { runId: runMarker, requestId, scenario };
  console.log(JSON.stringify({ event: 'auth_result', requestId, code, cacheState, allowed: false, runId: runMarker, scenario, s3Correlation }));
  return Response.json({ ok: false, code, requestId }, { status });
}

function jsonError(error, requestId, runMarker = '', scenario = '') {
  const code = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
  const status = error instanceof DomainError ? error.status : 500;
  return reject(status, code, requestId, 'none', runMarker, scenario);
}

function b64urlBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const raw = atob(padded); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function b64urlJson(value) { return JSON.parse(new TextDecoder().decode(b64urlBytes(value))); }
function pemToDer(pem) {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  const raw = atob(body); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
function readTlv(bytes, offset) {
  if (offset + 2 > bytes.length) throw new Error('DER_TRUNCATED');
  const start = offset; const tag = bytes[offset++]; let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f; if (count === 0 || count > 4 || offset + count > bytes.length) throw new Error('DER_LENGTH');
    length = 0; for (let i = 0; i < count; i++) length = (length << 8) | bytes[offset++];
  }
  const headerEnd = offset; const end = headerEnd + length;
  if (end > bytes.length) throw new Error('DER_TRUNCATED');
  return { tag, start, headerEnd, end };
}
function extractSpki(certDer) {
  const cert = readTlv(certDer, 0); if (cert.tag !== 0x30) throw new Error('X509_CERT_SEQUENCE');
  const tbs = readTlv(certDer, cert.headerEnd); if (tbs.tag !== 0x30) throw new Error('X509_TBS_SEQUENCE');
  let pos = tbs.headerEnd; let item = readTlv(certDer, pos);
  if (item.tag === 0xa0) pos = item.end;
  for (let i = 0; i < 5; i++) { item = readTlv(certDer, pos); pos = item.end; }
  const spki = readTlv(certDer, pos); if (spki.tag !== 0x30) throw new Error('X509_SPKI_SEQUENCE');
  return certDer.slice(spki.start, spki.end);
}
function maxAge(headers) {
  const value = headers.get('cache-control') || ''; const match = /(?:^|,)\s*max-age=(\d+)/i.exec(value);
  if (!match) throw new Error('CACHE_CONTROL_MISSING'); return Number(match[1]);
}
async function getCertificates(env, force = false) {
  const now = Date.now();
  if (!force && certificateCache.certificates && now < certificateCache.expiresAt) return { certificates: certificateCache.certificates, state: 'hit' };
  const url = env.CERT_URL_OVERRIDE || DEFAULT_CERT_URL;
  const response = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error('CERT_FETCH_FAILED');
  if (env.FORCE_CACHE_METADATA_INVALID === 'true') throw new Error('CACHE_METADATA_INVALID');
  const ttl = maxAge(response.headers); const certificates = await response.json();
  if (!certificates || typeof certificates !== 'object' || Array.isArray(certificates)) throw new Error('CERT_METADATA_INVALID');
  certificateCache = { certificates, expiresAt: now + ttl * 1000 };
  return { certificates, state: 'miss' };
}
async function verifyJwt(token, env) {
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('JWT_FORMAT');
  const header = b64urlJson(parts[0]); const claims = b64urlJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new Error('JWT_HEADER');
  let certSet = await getCertificates(env, false); let pem = certSet.certificates[header.kid];
  if (!pem && certSet.state === 'hit') { certSet = await getCertificates(env, true); pem = certSet.certificates[header.kid]; }
  if (!pem) throw new Error('KID_UNKNOWN');
  const spki = extractSpki(pemToDer(pem));
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed);
  if (!valid) throw new Error('SIGNATURE_INVALID');
  const audienceProjectId = env.EXPECTED_AUDIENCE_OVERRIDE || env.FIREBASE_PROJECT_ID;
  const issuerProjectId = env.EXPECTED_ISSUER_PROJECT_OVERRIDE || env.FIREBASE_PROJECT_ID;
  const now = Math.floor(Date.now() / 1000) + Number(env.TEST_NOW_OFFSET_SECONDS || 0);
  if (claims.aud !== audienceProjectId) throw new Error('AUD_INVALID');
  if (claims.iss !== `https://securetoken.google.com/${issuerProjectId}`) throw new Error('ISS_INVALID');
  if (!Number.isFinite(claims.exp) || claims.exp <= now) throw new Error('EXP_INVALID');
  if (!Number.isFinite(claims.iat) || claims.iat > now) throw new Error('IAT_INVALID');
  if (!Number.isFinite(claims.auth_time) || claims.auth_time > now) throw new Error('AUTH_TIME_INVALID');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('SUB_INVALID');
  return { claims, cacheState: certSet.state };
}

async function allowed(env, uid) {
  const row = await env.DB.prepare('SELECT uid, role FROM app_users WHERE uid = ?1 AND active = 1').bind(uid).first();
  return row || null;
}

function nowIso() { return new Date().toISOString(); }
// Documented facts and customer_warning_projection are the factual source of truth.
// customer.status is deliberately neutral/non-authoritative: the governing S4 reference defines no latest-wins, priority, or frequency rule.
const WORK_STATUS_ALLOWLIST = Object.freeze([
  'NEW_REQUEST',
  'REQUIREMENT_REVIEW',
  'NEEDS_PRICING',
  'WAITING_CLIENT_RESPONSE',
  'NEEDS_FOLLOW_UP',
  'AGREED',
  'IN_PROGRESS',
  'WAITING_CUSTOMER_INFO',
  'WAITING_REVIEW',
  'REVISION_REQUIRED',
  'PAUSED',
  'CANCELLED_BEFORE_EXECUTION',
  'PARTIALLY_STOPPED',
  'COMPLETED',
  'DELIVERED',
]);
function newId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function requiredString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new DomainError(code, 400);
  return value.trim();
}
function optionalString(value, code) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new DomainError(code, 400);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
function canonicalFactTimestamp(value) {
  const raw = requiredString(value, 'FACT_TIME_REQUIRED');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})Z$/.test(raw)) throw new DomainError('FACT_TIME_INVALID', 400);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== raw) throw new DomainError('FACT_TIME_INVALID', 400);
  return raw;
}
function validateCustomerStatus(value) {
  const status = value === undefined ? 'normal' : requiredString(value, 'CUSTOMER_STATUS_INVALID');
  if (status !== 'normal') throw new DomainError('CUSTOMER_STATUS_DERIVED', 400);
  return status;
}
function validateWorkStatus(value, fallback = 'NEW_REQUEST') {
  const status = value === undefined ? fallback : requiredString(value, 'WORK_STATUS_INVALID');
  if (!WORK_STATUS_ALLOWLIST.includes(status) || status === 'ARCHIVED') throw new DomainError('WORK_STATUS_INVALID', 400);
  if (status === 'CANCELLED_BEFORE_EXECUTION' || status === 'PARTIALLY_STOPPED') throw new DomainError('WORK_STATUS_DIRECT_FORBIDDEN', 400);
  return status;
}
function positiveVersion(value) {
  if (!Number.isInteger(value) || value < 1) throw new DomainError('VERSION_REQUIRED', 400);
  return value;
}
function allowedCatalogKind(kind) {
  if (!['country', 'specialty', 'work_type'].includes(kind)) throw new DomainError('CATALOG_KIND_INVALID', 400);
  return kind;
}
async function catalogExists(env, kind, key) {
  if (!key) return true;
  const row = await env.DB.prepare('SELECT id FROM catalog_values WHERE kind = ?1 AND value_key = ?2 AND active = 1').bind(kind, key).first();
  if (!row) throw new DomainError('CATALOG_VALUE_INVALID', 400);
  return true;
}
async function ensureActor(env, actorUid) {
  const user = await allowed(env, actorUid);
  if (!user) throw new DomainError('UID_NOT_ALLOWED', 403);
  return user;
}
async function parseRequestJson(request) {
  try { return asObject(await request.json()); } catch { throw new DomainError('JSON_INVALID', 400); }
}
function auditStatement(env, entityType, entityId, action, actorUid, before, after, runMarker, requestId, createdAt, conditional = false) {
  const sql = conditional
    ? `INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
       SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE changes() = 1`
    : `INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`;
  return env.DB.prepare(sql).bind(entityType, entityId, action, actorUid, createdAt, before === null ? null : JSON.stringify(before), JSON.stringify(after), runMarker, requestId);
}
function auditStatementWhen(env, entityType, entityId, action, actorUid, before, after, runMarker, requestId, createdAt, predicate, predicateValues) {
  return env.DB.prepare(`INSERT INTO audit_log(entity_type,entity_id,action,actor_uid,created_at,before_json,after_json,run_marker,request_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE ${predicate}`)
    .bind(entityType, entityId, action, actorUid, createdAt, before === null ? null : JSON.stringify(before), JSON.stringify(after), runMarker, requestId, ...predicateValues);
}
async function executeBatch(env, statements) {
  return env.DB.batch(statements);
}
function customerAfter(input, id, actorUid, createdAt) {
  return { id, name: input.name ?? null, contact: input.contact ?? null, country: input.country ?? null, university: input.university ?? null, specialty: input.specialty ?? null, notes: input.notes ?? null, status: input.status ?? 'normal', created_by: actorUid, created_at: createdAt, updated_by: actorUid, updated_at: createdAt, version: 1 };
}
async function getCustomerRaw(env, id) {
  const row = await env.DB.prepare('SELECT * FROM customers WHERE id = ?1').bind(id).first();
  if (!row) throw new DomainError('CUSTOMER_NOT_FOUND', 404);
  return row;
}
function projectCustomerStatus(row) {
  return { ...row, status: 'normal' };
}

export async function createCustomer(env, actorUid, requestId, input) {
  await ensureActor(env, actorUid);
  const name = optionalString(input.name, 'CUSTOMER_NAME_INVALID');
  const contact = optionalString(input.contact, 'CUSTOMER_CONTACT_INVALID');
  const country = optionalString(input.country, 'CUSTOMER_COUNTRY_INVALID');
  const university = optionalString(input.university, 'CUSTOMER_UNIVERSITY_INVALID');
  const specialty = optionalString(input.specialty, 'CUSTOMER_SPECIALTY_INVALID');
  const notes = optionalString(input.notes, 'CUSTOMER_NOTES_INVALID');
  const status = validateCustomerStatus(input.status);
  if (country) await catalogExists(env, 'country', country);
  if (specialty) await catalogExists(env, 'specialty', specialty);
  const id = newId('customer'); const createdAt = nowIso();
  const after = customerAfter({ name, contact, country, university, specialty, notes, status }, id, actorUid, createdAt);
  const mutation = env.DB.prepare(`INSERT INTO customers(id,name,contact,country,university,specialty,notes,status,created_by,created_at,updated_by,updated_at,version)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?9,?10,1)`).bind(id, name, contact, country, university, specialty, notes, status, actorUid, createdAt);
  const audit = auditStatement(env, 'customer', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
  await executeBatch(env, [mutation, audit]);
  return projectCustomerStatus(after);
}

export async function getCustomer(env, id) {
  return projectCustomerStatus(await getCustomerRaw(env, id));
}

export async function listCustomers(env, query = '') {
  const q = typeof query === 'string' ? query.trim() : '';
  const result = !q
    ? (await env.DB.prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 100').all()).results || []
    : (await env.DB.prepare('SELECT * FROM customers WHERE name LIKE ?1 OR university LIKE ?1 OR specialty LIKE ?1 ORDER BY created_at DESC LIMIT 100').bind(`%${q}%`).all()).results || [];
  return result.map(projectCustomerStatus);
}

export async function updateCustomer(env, actorUid, requestId, id, input) {
  await ensureActor(env, actorUid);
  const before = await getCustomerRaw(env, id);
  const version = positiveVersion(input.version);
  if (version !== before.version) throw new DomainError('VERSION_CONFLICT', 409);
  const next = { ...before };
  for (const key of ['name', 'contact', 'country', 'university', 'specialty', 'notes']) {
    if (input[key] !== undefined) next[key] = optionalString(input[key], `CUSTOMER_${key.toUpperCase()}_INVALID`);
  }
  next.status = validateCustomerStatus(input.status);
  if (next.country) await catalogExists(env, 'country', next.country);
  if (next.specialty) await catalogExists(env, 'specialty', next.specialty);
  const updatedAt = nowIso();
  const mutation = env.DB.prepare(`UPDATE customers SET name=?1,contact=?2,country=?3,university=?4,specialty=?5,notes=?6,status=?7,updated_by=?8,updated_at=?9,version=version+1
    WHERE id=?10 AND version=?11`).bind(next.name, next.contact, next.country, next.university, next.specialty, next.notes, next.status, actorUid, updatedAt, id, version);
  const after = { ...next, updated_by: actorUid, updated_at: updatedAt, version: version + 1 };
  const audit = auditStatement(env, 'customer', id, 'UPDATE', actorUid, before, after, env.RUN_MARKER, requestId, updatedAt, true);
  const results = await executeBatch(env, [mutation, audit]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1) throw new DomainError('VERSION_CONFLICT', 409);
  return projectCustomerStatus(after);
}

function softWorkDetailWarnings(work) {
  const warnings = [];
  if (!work.university) warnings.push({ code: 'WORK_DETAIL_UNIVERSITY_MISSING', field: 'university', severity: 'SOFT_WARNING' });
  if (!work.specialty_key) warnings.push({ code: 'WORK_DETAIL_SPECIALTY_MISSING', field: 'specialty_key', severity: 'SOFT_WARNING' });
  return warnings;
}
function workReadModel(work) {
  return { ...work, is_archived: Boolean(work.archived_at), soft_warnings: softWorkDetailWarnings(work) };
}
function workPricingReadModel(work, currentPriceHalalas) {
  return {
    ...workReadModel(work),
    pricing_state: currentPriceHalalas === null ? 'PRICE_UNSET' : 'PRICE_APPROVED',
    current_price_halalas: currentPriceHalalas,
    pricing_source: 'S6_APPROVED_PRICE_MOVEMENTS',
    legacy_price_state: work.price_state,
    legacy_price_minor_units: work.price_minor_units,
  };
}
async function authoritativeWorkReadModel(env, work) {
  const movements = await listApprovedPriceMovementsRaw(env, work.id);
  return workPricingReadModel(work, sumApprovedPriceMovements(movements));
}
const MAX_BULK_PRICE_LOOKUP_BINDINGS = 100;
async function bulkCurrentPriceMap(env, works) {
  const workIds = [...new Set(works.map(work => work.id).filter(Boolean))];
  const currentByWork = new Map();
  for (let offset = 0; offset < workIds.length; offset += MAX_BULK_PRICE_LOOKUP_BINDINGS) {
    const chunk = workIds.slice(offset, offset + MAX_BULK_PRICE_LOOKUP_BINDINGS);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(',');
    const rows = (await env.DB.prepare(`SELECT work_id, amount_halalas, approved_at, id
      FROM price_movements WHERE work_id IN (${placeholders}) ORDER BY work_id ASC, approved_at ASC, id ASC`).bind(...chunk).all()).results || [];
    for (const row of rows) {
      const previous = currentByWork.has(row.work_id) ? currentByWork.get(row.work_id) : 0;
      currentByWork.set(row.work_id, safeFinancialAdd(previous, Number(row.amount_halalas)));
    }
  }
  return currentByWork;
}
async function bulkAuthoritativeWorkReadModels(env, works) {
  const currentByWork = await bulkCurrentPriceMap(env, works);
  return works.map(work => workPricingReadModel(work, currentByWork.has(work.id) ? currentByWork.get(work.id) : null));
}
function workMutationResponse(work) {
  return workReadModel(work);
}

async function validateWorkInput(env, input, current = null) {
  const title = input.title === undefined && current ? current.title : requiredString(input.title, 'WORK_TITLE_REQUIRED');
  const customerId = input.customer_id === undefined && current ? current.customer_id : requiredString(input.customer_id, 'CUSTOMER_ID_REQUIRED');
  const country = input.country === undefined && current ? current.country : requiredString(input.country, 'WORK_COUNTRY_REQUIRED');
  const workTypeKey = input.work_type_key === undefined && current ? current.work_type_key : optionalString(input.work_type_key, 'WORK_TYPE_INVALID');
  const specialtyKey = input.specialty_key === undefined && current ? current.specialty_key : optionalString(input.specialty_key, 'SPECIALTY_INVALID');
  const subject = input.subject_or_course_code === undefined && current ? current.subject_or_course_code : optionalString(input.subject_or_course_code, 'SUBJECT_INVALID');
  const university = input.university === undefined && current ? current.university : optionalString(input.university, 'UNIVERSITY_INVALID');
  const description = input.description === undefined && current ? current.description : optionalString(input.description, 'DESCRIPTION_INVALID');
  let quantity;
  if (input.quantity === undefined) quantity = current ? current.quantity : null;
  else if (input.quantity === null) quantity = null;
  else if (Number.isInteger(input.quantity) && input.quantity >= 1) quantity = input.quantity;
  else throw new DomainError('QUANTITY_INVALID', 400);
  const status = input.status === undefined && current ? current.status : validateWorkStatus(input.status, current?.status || 'NEW_REQUEST');
  const parentWorkId = input.parent_work_id === undefined && current ? current.parent_work_id : optionalString(input.parent_work_id, 'PARENT_WORK_INVALID');
  const relationshipKind = input.relationship_kind === undefined && current ? current.relationship_kind : (input.relationship_kind === undefined ? 'INDEPENDENT' : requiredString(input.relationship_kind, 'RELATIONSHIP_KIND_INVALID').toUpperCase());
  if (!['INDEPENDENT', 'CHILD'].includes(relationshipKind)) throw new DomainError('RELATIONSHIP_KIND_INVALID', 400);
  if (relationshipKind === 'INDEPENDENT' && parentWorkId) throw new DomainError('PARENT_FOR_INDEPENDENT', 400);
  if (relationshipKind === 'CHILD' && !parentWorkId) throw new DomainError('PARENT_REQUIRED', 400);
  const customer = await env.DB.prepare('SELECT id FROM customers WHERE id=?1').bind(customerId).first();
  if (!customer) throw new DomainError('CUSTOMER_NOT_FOUND', 404);
  await catalogExists(env, 'country', country);
  if (workTypeKey) await catalogExists(env, 'work_type', workTypeKey);
  if (specialtyKey) await catalogExists(env, 'specialty', specialtyKey);
  if (parentWorkId) {
    if (current && parentWorkId === current.id) throw new DomainError('SELF_PARENT', 400);
    const parent = await env.DB.prepare('SELECT id,customer_id,parent_work_id FROM works WHERE id=?1').bind(parentWorkId).first();
    if (!parent) throw new DomainError('PARENT_NOT_FOUND', 404);
    if (parent.customer_id !== customerId) throw new DomainError('CROSS_CUSTOMER_PARENT', 400);
    const visited = new Set(); let cursor = parent;
    while (cursor?.parent_work_id) {
      if (visited.has(cursor.id)) throw new DomainError('PARENT_CYCLE', 400);
      visited.add(cursor.id);
      if (current && cursor.parent_work_id === current.id) throw new DomainError('PARENT_CYCLE', 400);
      cursor = await env.DB.prepare('SELECT id,parent_work_id FROM works WHERE id=?1').bind(cursor.parent_work_id).first();
    }
  }
  return { title, customerId, country, workTypeKey, specialtyKey, subject, university, description, quantity, status, parentWorkId, relationshipKind };
}

export async function createWork(env, actorUid, requestId, input) {
  await ensureActor(env, actorUid);
  const validated = await validateWorkInput(env, input);
  const priceState = input.price_state === undefined ? 'PRICE_UNSET' : requiredString(input.price_state, 'PRICE_STATE_INVALID');
  if (!['PRICE_UNSET', 'PRICE_ZERO'].includes(priceState)) throw new DomainError('PRICE_STATE_INVALID', 400);
  if (priceState === 'PRICE_ZERO' && input.price_minor_units !== 0) throw new DomainError('PRICE_ZERO_VALUE_REQUIRED', 400);
  if (priceState === 'PRICE_UNSET' && input.price_minor_units !== undefined && input.price_minor_units !== null) throw new DomainError('PRICE_UNSET_VALUE_FORBIDDEN', 400);
  const id = newId('work'); const createdAt = nowIso();
  const after = { id, customer_id: validated.customerId, parent_work_id: validated.parentWorkId, relationship_kind: validated.relationshipKind, title: validated.title, work_type_key: validated.workTypeKey, specialty_key: validated.specialtyKey, subject_or_course_code: validated.subject, country: validated.country, university: validated.university, status: validated.status, description: validated.description, quantity: validated.quantity, price_state: priceState, price_minor_units: priceState === 'PRICE_ZERO' ? 0 : null, created_by: actorUid, created_at: createdAt, updated_by: actorUid, updated_at: createdAt, version: 1 };
  const mutation = env.DB.prepare(`INSERT INTO works(id,customer_id,parent_work_id,relationship_kind,title,work_type_key,specialty_key,subject_or_course_code,country,university,status,description,quantity,price_state,price_minor_units,created_by,created_at,updated_by,updated_at,version)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?16,?17,1)`).bind(id, after.customer_id, after.parent_work_id, after.relationship_kind, after.title, after.work_type_key, after.specialty_key, after.subject_or_course_code, after.country, after.university, after.status, after.description, after.quantity, after.price_state, after.price_minor_units, actorUid, createdAt);
  const audit = auditStatement(env, 'work', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
  await executeBatch(env, [mutation, audit]);
  return workMutationResponse(after);
}

async function getWorkRaw(env, id) {
  const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?1').bind(id).first();
  if (!row) throw new DomainError('WORK_NOT_FOUND', 404);
  return row;
}

export async function getWork(env, id) {
  return authoritativeWorkReadModel(env, await getWorkRaw(env, id));
}

export async function listWorks(env, query = {}) {
  const clauses = []; const values = [];
  for (const [key, value] of [['customer_id', query.customer_id], ['status', query.status], ['country', query.country], ['work_type_key', query.work_type_key], ['specialty_key', query.specialty_key]]) {
    if (value) { values.push(value); clauses.push(`${key} = ?${values.length}`); }
  }
  const sql = `SELECT * FROM works ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`;
  const rows = (await env.DB.prepare(sql).bind(...values).all()).results || [];
  return bulkAuthoritativeWorkReadModels(env, rows);
}

export async function updateWork(env, actorUid, requestId, id, input) {
  await ensureActor(env, actorUid);
  const before = await getWorkRaw(env, id);
  const version = positiveVersion(input.version);
  if (version !== before.version) throw new DomainError('VERSION_CONFLICT', 409);
  if (input.price_state !== undefined || input.price_minor_units !== undefined) throw new DomainError('PRICING_OUT_OF_SCOPE', 400);
  if (input.title !== undefined && input.title !== before.title) throw new DomainError('TITLE_CHANGE_OUT_OF_SCOPE', 400);
  const validated = await validateWorkInput(env, { ...input, customer_id: before.customer_id }, before);
  if (input.status !== undefined && input.status !== before.status) throw new DomainError('STATUS_CHANGE_OUT_OF_SCOPE', 400);
  const updatedAt = nowIso();
  const after = { ...before, parent_work_id: validated.parentWorkId, relationship_kind: validated.relationshipKind, title: validated.title, work_type_key: validated.workTypeKey, specialty_key: validated.specialtyKey, subject_or_course_code: validated.subject, country: validated.country, university: validated.university, status: validated.status, description: validated.description, quantity: validated.quantity, updated_by: actorUid, updated_at: updatedAt, version: version + 1 };
  const mutation = env.DB.prepare(`UPDATE works SET parent_work_id=?1,relationship_kind=?2,title=?3,work_type_key=?4,specialty_key=?5,subject_or_course_code=?6,country=?7,university=?8,status=?9,description=?10,quantity=?11,updated_by=?12,updated_at=?13,version=version+1 WHERE id=?14 AND version=?15`).bind(after.parent_work_id, after.relationship_kind, after.title, after.work_type_key, after.specialty_key, after.subject_or_course_code, after.country, after.university, after.status, after.description, after.quantity, actorUid, updatedAt, id, version);
  const audit = auditStatement(env, 'work', id, 'UPDATE', actorUid, before, after, env.RUN_MARKER, requestId, updatedAt, true);
  const results = await executeBatch(env, [mutation, audit]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1) throw new DomainError('VERSION_CONFLICT', 409);
  return workMutationResponse(after);
}

export async function listCatalog(env, kind) {
  allowedCatalogKind(kind);
  return (await env.DB.prepare('SELECT * FROM catalog_values WHERE kind=?1 ORDER BY active DESC,label').bind(kind).all()).results || [];
}

export async function createCatalogValue(env, actorUid, requestId, kind, input) {
  await ensureActor(env, actorUid);
  allowedCatalogKind(kind);
  const valueKey = requiredString(input.value_key, 'CATALOG_VALUE_REQUIRED');
  const label = requiredString(input.label, 'CATALOG_LABEL_REQUIRED');
  const existing = await env.DB.prepare('SELECT id FROM catalog_values WHERE kind=?1 AND value_key=?2').bind(kind, valueKey).first();
  if (existing) throw new DomainError('CATALOG_DUPLICATE', 409);
  const id = newId('catalog'); const createdAt = nowIso();
  const after = { id, kind, value_key: valueKey, label, active: 1, created_by: actorUid, created_at: createdAt };
  const mutation = env.DB.prepare('INSERT INTO catalog_values(id,kind,value_key,label,active,created_by,created_at) VALUES (?1,?2,?3,?4,1,?5,?6)').bind(id, kind, valueKey, label, actorUid, createdAt);
  const audit = auditStatement(env, 'catalog_value', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
  await executeBatch(env, [mutation, audit]);
  return after;
}

export async function createDocumentedFact(env, actorUid, requestId, input) {
  await ensureActor(env, actorUid);
  const customerId = requiredString(input.customer_id, 'CUSTOMER_ID_REQUIRED');
  const customer = await env.DB.prepare('SELECT id FROM customers WHERE id=?1').bind(customerId).first();
  if (!customer) throw new DomainError('CUSTOMER_NOT_FOUND', 404);
  const workId = optionalString(input.work_id, 'WORK_ID_INVALID');
  if (workId) {
    const work = await env.DB.prepare('SELECT id,customer_id FROM works WHERE id=?1').bind(workId).first();
    if (!work) throw new DomainError('WORK_NOT_FOUND', 404);
    if (work.customer_id !== customerId) throw new DomainError('CROSS_CUSTOMER_WORK', 400);
  }
  const factType = requiredString(input.fact_type, 'FACT_TYPE_REQUIRED');
  if (!['NON_PAYMENT', 'DELAY', 'BLOCKED', 'DISPUTE'].includes(factType)) throw new DomainError('FACT_TYPE_UNSUPPORTED', 400);
  const sourceRef = requiredString(input.source_ref, 'FACT_SOURCE_REQUIRED');
  const happenedAt = canonicalFactTimestamp(input.happened_at);
  const details = asObject(input.details);
  const id = newId('fact'); const createdAt = nowIso();
  const after = { id, customer_id: customerId, work_id: workId, fact_type: factType, source_ref: sourceRef, details_json: details, happened_at: happenedAt, created_by: actorUid, created_at: createdAt, version: 1 };
  const mutation = env.DB.prepare('INSERT INTO documented_facts(id,customer_id,work_id,fact_type,source_ref,details_json,happened_at,created_by,created_at,version) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)').bind(id, customerId, workId, factType, sourceRef, JSON.stringify(details), happenedAt, actorUid, createdAt);
  const audit = auditStatement(env, 'documented_fact', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
  await executeBatch(env, [mutation, audit]);
  return after;
}

export async function getCustomerHistory(env, customerId) {
  await getCustomer(env, customerId);
  return (await env.DB.prepare('SELECT id,work_id,fact_type,source_ref,details_json,happened_at,created_by,created_at FROM documented_facts WHERE customer_id=?1 ORDER BY happened_at ASC,id ASC').bind(customerId).all()).results || [];
}

export async function getCustomerWarnings(env, customerId) {
  await getCustomer(env, customerId);
  return (await env.DB.prepare('SELECT fact_id,customer_id,work_id,warning_type,source_ref,happened_at,details_json FROM customer_warning_projection WHERE customer_id=?1 ORDER BY happened_at ASC,fact_id ASC').bind(customerId).all()).results || [];
}

export async function getSimilarWorks(env, workId) {
  const work = await getWorkRaw(env, workId);
  const rows = (await env.DB.prepare(`SELECT id,customer_id,title,work_type_key,specialty_key,country,university,status,price_state,price_minor_units,created_at
    FROM works WHERE id <> ?1 AND country = ?2 AND (?3 IS NULL OR work_type_key = ?3) AND (?4 IS NULL OR specialty_key = ?4) ORDER BY created_at DESC LIMIT 50`).bind(workId, work.country, work.work_type_key, work.specialty_key).all()).results || [];
  return bulkAuthoritativeWorkReadModels(env, rows);
}

export async function applyAuditMutation(env, actorUid, requestId, value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error('AUDIT_VALUE_INVALID');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error('AUDIT_REQUEST_ID_INVALID');
  const entityId = `acceptance-probe-${env.RUN_MARKER}`;
  const valueJson = JSON.stringify({ value });
  const mutation = env.DB.prepare(`
    INSERT INTO s3_audit_probe(entity_id,value_json,version,updated_by,changed_at,run_marker,request_id)
    VALUES (?1,?2,1,?3,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?4,?5)
    ON CONFLICT(entity_id) DO UPDATE SET
      value_json=excluded.value_json,
      version=s3_audit_probe.version+1,
      updated_by=excluded.updated_by,
      changed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      run_marker=excluded.run_marker,
      request_id=excluded.request_id
  `).bind(entityId, valueJson, actorUid, env.RUN_MARKER, requestId);
  const evidence = env.DB.prepare(`
    SELECT action, actor_uid, created_at, before_json, after_json, run_marker, request_id
    FROM audit_log WHERE request_id = ?1 AND run_marker = ?2
  `).bind(requestId, env.RUN_MARKER);
  const batch = await env.DB.batch([mutation, evidence]);
  const audit = batch?.[1]?.results?.[0];
  if (!audit || audit.actor_uid !== actorUid || audit.request_id !== requestId || audit.run_marker !== env.RUN_MARKER) {
    throw new Error('AUDIT_EVIDENCE_MISSING');
  }
  return { action: audit.action, actorUid: audit.actor_uid, createdAt: audit.created_at, before: audit.before_json === null ? null : JSON.parse(audit.before_json), after: JSON.parse(audit.after_json), runId: audit.run_marker, requestId: audit.request_id };
}

async function readAuthorized(request, env, requestId, scenario) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw new DomainError('TOKEN_MISSING', 401);
  try {
    const verified = await verifyJwt(auth.slice(7), env);
    const user = await allowed(env, verified.claims.sub);
    if (!user) throw new DomainError('UID_NOT_ALLOWED', 403);
    const requestedRunId = request.headers.get('x-s3-run-id') || '';
    const runId = requestedRunId === env.RUN_MARKER ? requestedRunId : '';
    const s3Correlation = { runId, requestId, scenario };
    console.log(JSON.stringify({ event: 'auth_result', requestId, code: 'ALLOW', cacheState: verified.cacheState, allowed: true, runId, scenario, s3Correlation, uidHash: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verified.claims.sub)).then(x => Array.from(new Uint8Array(x)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')) }));
    return { user, cacheState: verified.cacheState };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(error instanceof Error ? error.message : 'AUTH_FAILED', 401);
  }
}

async function handleApi(request, env, requestId, scenario, user) {
  const url = new URL(request.url); const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method.toUpperCase(); const body = method === 'POST' || method === 'PATCH' ? await parseRequestJson(request) : {};
  if (parts[1] === 'customers' && parts.length === 2) {
    if (method === 'GET') return Response.json({ ok: true, data: await listCustomers(env, url.searchParams.get('q') || '') , requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await createCustomer(env, user.uid, requestId, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'customers' && parts.length >= 3) {
    const customerId = decodeURIComponent(parts[2]);
    if (parts[3] === 'history' && method === 'GET') return Response.json({ ok: true, data: await getCustomerHistory(env, customerId), requestId });
    if (parts[3] === 'warnings' && method === 'GET') return Response.json({ ok: true, data: await getCustomerWarnings(env, customerId), requestId });
    if (parts.length === 3 && method === 'GET') return Response.json({ ok: true, data: await getCustomer(env, customerId), requestId });
    if (parts.length === 3 && method === 'PATCH') return Response.json({ ok: true, data: await updateCustomer(env, user.uid, requestId, customerId, body), requestId });
  }
  if (parts[1] === 'works' && parts.length === 2) {
    if (method === 'GET') return Response.json({ ok: true, data: await listWorks(env, Object.fromEntries(url.searchParams.entries())), requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await createWork(env, user.uid, requestId, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'works' && parts.length >= 3) {
    const workId = decodeURIComponent(parts[2]);
    if (parts[3] === 'similar' && method === 'GET') return Response.json({ ok: true, data: await getSimilarWorks(env, workId), requestId });
    if (parts[3] === 'financials' && method === 'GET') return Response.json({ ok: true, data: await getWorkFinancials(env, workId), requestId });
    if (parts[3] === 'price-movements' && method === 'GET') return Response.json({ ok: true, data: await listPriceMovements(env, workId), requestId });
    if (parts[3] === 'price-requests') {
      if (parts.length === 4) {
        if (method === 'GET') return Response.json({ ok: true, data: await listPriceChangeRequests(env, workId), requestId });
        if (method === 'POST') return Response.json({ ok: true, data: await createPriceChangeRequest(env, user.uid, requestId, workId, body), requestId }, { status: 201 });
      }
      if (parts.length === 6 && parts[5] === 'approve' && method === 'POST') {
        const reqId = decodeURIComponent(parts[4]);
        return Response.json({ ok: true, data: await approvePriceChangeRequest(env, user.uid, requestId, workId, reqId), requestId });
      }
    }
    if (parts[3] === 'ratio-history' && method === 'GET') return Response.json({ ok: true, data: await listRatioHistory(env, workId), requestId });
    if (parts[3] === 'ratio-requests') {
      if (parts.length === 4) {
        if (method === 'GET') return Response.json({ ok: true, data: await listRatioChangeRequests(env, workId), requestId });
        if (method === 'POST') return Response.json({ ok: true, data: await createRatioChangeRequest(env, user.uid, requestId, workId, body), requestId }, { status: 201 });
      }
      if (parts.length === 6 && parts[5] === 'approve' && method === 'POST') {
        const reqId = decodeURIComponent(parts[4]);
        return Response.json({ ok: true, data: await approveRatioChangeRequest(env, user.uid, requestId, workId, reqId), requestId });
      }
    }

    if (parts[3] === 'events') {
      if (method === 'GET') return Response.json({ ok: true, data: await listWorkEvents(env, workId), requestId });
      if (method === 'POST') return Response.json({ ok: true, data: await createWorkEvent(env, user.uid, requestId, workId, body), requestId }, { status: 201 });
    }
    if (parts[3] === 'title') {
      if (method === 'POST') return Response.json({ ok: true, data: await changeWorkTitle(env, user.uid, requestId, workId, body), requestId });
    }
    if (parts[3] === 'title-history' && method === 'GET') {
      return Response.json({ ok: true, data: await listWorkTitleHistory(env, workId), requestId });
    }
    if (parts[3] === 'status') {
      if (method === 'POST') return Response.json({ ok: true, data: await changeWorkStatus(env, user.uid, requestId, workId, body), requestId });
    }
    if (parts[3] === 'status-history' && method === 'GET') {
      return Response.json({ ok: true, data: await listWorkStatusHistory(env, workId), requestId });
    }
    if (parts[3] === 'archive-history' && method === 'GET') {
      return Response.json({ ok: true, data: await listWorkArchiveHistory(env, workId), requestId });
    }
    if (parts[3] === 'requests') {
      if (parts.length === 4) {
        if (method === 'GET') return Response.json({ ok: true, data: await listCancelArchiveRequests(env, workId), requestId });
        if (method === 'POST') return Response.json({ ok: true, data: await createCancelArchiveRequest(env, user.uid, requestId, workId, body), requestId }, { status: 201 });
      }
    }
    if (parts[3] === 'requests' && parts.length === 6 && parts[5] === 'approve') {
      const reqId = decodeURIComponent(parts[4]);
      if (method === 'POST') return Response.json({ ok: true, data: await approveCancelArchiveRequest(env, user.uid, requestId, workId, reqId), requestId });
    }

    if (parts.length === 3 && method === 'GET') return Response.json({ ok: true, data: await getWork(env, workId), requestId });
    if (parts.length === 3 && method === 'PATCH') return Response.json({ ok: true, data: await updateWork(env, user.uid, requestId, workId, body), requestId });
  }
  if (parts[1] === 'catalog' && parts.length === 3) {
    const kind = decodeURIComponent(parts[2]);
    if (method === 'GET') return Response.json({ ok: true, data: await listCatalog(env, kind), requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await createCatalogValue(env, user.uid, requestId, kind, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'facts' && parts.length === 2 && method === 'POST') return Response.json({ ok: true, data: await createDocumentedFact(env, user.uid, requestId, body), requestId }, { status: 201 });
  throw new DomainError('NOT_FOUND', 404);
}

function canonicalEventTimestamp(value) {
  const raw = requiredString(value, 'EVENT_TIME_REQUIRED');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)) throw new DomainError('EVENT_TIME_INVALID', 400);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new DomainError('EVENT_TIME_INVALID', 400);
  return date.toISOString();
}

export async function createWorkEvent(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  await getWorkRaw(env, workId);
  const eventType = requiredString(input.event_type, 'EVENT_TYPE_REQUIRED');
  const description = requiredString(input.description, 'EVENT_DESCRIPTION_REQUIRED');
  const effectiveAt = canonicalEventTimestamp(input.effective_at);
  const id = newId('event');
  const createdAt = nowIso();
  const after = { id, work_id: workId, event_type: eventType, description, effective_at: effectiveAt, created_at: createdAt, actor_uid: actorUid };
  const mutation = env.DB.prepare(`INSERT INTO work_events(id, work_id, event_type, description, effective_at, created_at, actor_uid, request_id)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(id, workId, eventType, description, effectiveAt, createdAt, actorUid, requestId);
  const audit = auditStatement(env, 'work_event', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
  await executeBatch(env, [mutation, audit]);
  return after;
}

export async function listWorkEvents(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare('SELECT id, work_id, event_type, description, effective_at, created_at, actor_uid FROM work_events WHERE work_id = ?1 ORDER BY effective_at ASC, created_at ASC, id ASC').bind(workId).all()).results || [];
}

export async function changeWorkTitle(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const before = await getWorkRaw(env, workId);
  const version = positiveVersion(input.version);
  if (version !== before.version) throw new DomainError('VERSION_CONFLICT', 409);
  const newTitle = requiredString(input.new_title, 'TITLE_REQUIRED');
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  const changedAt = nowIso();
  const historyId = newId('title_hist');
  const workMutation = env.DB.prepare(`UPDATE works SET title=?1, version=version+1, updated_by=?2, updated_at=?3 WHERE id=?4 AND version=?5`).bind(newTitle, actorUid, changedAt, workId, version);
  const historyMutation = env.DB.prepare(`INSERT INTO work_title_history(id, work_id, old_title, new_title, reason, changed_at, changed_by, request_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE changes() = 1 AND EXISTS (SELECT 1 FROM works WHERE id=?2 AND version=?9 AND title=?4)`).bind(historyId, workId, before.title, newTitle, reason, changedAt, actorUid, requestId, version + 1);
  const after = { ...before, title: newTitle, updated_by: actorUid, updated_at: changedAt, version: version + 1 };
  const audit = auditStatement(env, 'work', workId, 'UPDATE', actorUid, before, after, env.RUN_MARKER, requestId, changedAt, true);
  const results = await executeBatch(env, [workMutation, historyMutation, audit]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1) throw new DomainError('VERSION_CONFLICT', 409);
  return workMutationResponse(after);
}

export async function listWorkTitleHistory(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare('SELECT id, work_id, old_title, new_title, reason, changed_at, changed_by FROM work_title_history WHERE work_id = ?1 ORDER BY changed_at ASC, id ASC').bind(workId).all()).results || [];
}

export async function changeWorkStatus(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const before = await getWorkRaw(env, workId);
  const version = positiveVersion(input.version);
  if (version !== before.version) throw new DomainError('VERSION_CONFLICT', 409);
  const newStatus = validateWorkStatus(input.status);
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  const changedAt = nowIso();
  const historyId = newId('status_hist');
  const workMutation = env.DB.prepare(`UPDATE works SET status=?1, version=version+1, updated_by=?2, updated_at=?3 WHERE id=?4 AND version=?5`).bind(newStatus, actorUid, changedAt, workId, version);
  const historyMutation = env.DB.prepare(`INSERT INTO work_status_history(id, work_id, old_status, new_status, reason, changed_at, changed_by, request_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE changes() = 1 AND EXISTS (SELECT 1 FROM works WHERE id=?2 AND version=?9 AND status=?4)`).bind(historyId, workId, before.status, newStatus, reason, changedAt, actorUid, requestId, version + 1);
  const after = { ...before, status: newStatus, updated_by: actorUid, updated_at: changedAt, version: version + 1 };
  const audit = auditStatement(env, 'work', workId, 'UPDATE', actorUid, before, after, env.RUN_MARKER, requestId, changedAt, true);
  const results = await executeBatch(env, [workMutation, historyMutation, audit]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1) throw new DomainError('VERSION_CONFLICT', 409);
  return workMutationResponse(after);
}

export async function listWorkStatusHistory(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare('SELECT id, work_id, old_status, new_status, reason, changed_at, changed_by FROM work_status_history WHERE work_id = ?1 ORDER BY changed_at ASC, id ASC').bind(workId).all()).results || [];
}

export async function createCancelArchiveRequest(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const before = await getWorkRaw(env, workId);
  const version = positiveVersion(input.version);
  if (version !== before.version) throw new DomainError('VERSION_CONFLICT', 409);
  const action = requiredString(input.action, 'ACTION_REQUIRED');
  if (!['CANCEL', 'ARCHIVE'].includes(action)) throw new DomainError('ACTION_INVALID', 400);
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  let targetStatus = null;
  if (action === 'CANCEL') {
    targetStatus = requiredString(input.target_execution_status, 'TARGET_STATUS_REQUIRED');
    if (!['CANCELLED_BEFORE_EXECUTION', 'PARTIALLY_STOPPED'].includes(targetStatus)) throw new DomainError('TARGET_STATUS_INVALID', 400);
  } else {
    if (input.target_execution_status !== undefined && input.target_execution_status !== null) {
      throw new DomainError('TARGET_STATUS_FORBIDDEN_FOR_ARCHIVE', 400);
    }
  }
  const id = newId('req');
  const requestedAt = nowIso();
  const after = { id, work_id: workId, action, requested_by: actorUid, requested_at: requestedAt, reason, work_version: version, state: 'PENDING', approved_by: null, approved_at: null, target_execution_status: targetStatus };
  const mutation = env.DB.prepare(`INSERT INTO cancel_archive_requests(id, work_id, action, requested_by, requested_at, reason, work_version, state, approved_by, approved_at, request_id, target_execution_status)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'PENDING', NULL, NULL, ?8, ?9)`).bind(id, workId, action, actorUid, requestedAt, reason, version, requestId, targetStatus);
  const audit = auditStatement(env, 'cancel_archive_request', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, requestedAt);
  await executeBatch(env, [mutation, audit]);
  return after;
}

export async function approveCancelArchiveRequest(env, actorUid, requestId, workId, reqId) {
  await ensureActor(env, actorUid);
  const requestRow = await env.DB.prepare('SELECT * FROM cancel_archive_requests WHERE id = ?1').bind(reqId).first();
  if (!requestRow) throw new DomainError('REQUEST_NOT_FOUND', 404);
  if (requestRow.work_id !== workId) throw new DomainError('REQUEST_WORK_MISMATCH', 404);
  if (requestRow.state !== 'PENDING') throw new DomainError('ALREADY_FINALIZED', 400);
  if (requestRow.requested_by === actorUid) throw new DomainError('SELF_APPROVAL_REJECTED', 400);
  const beforeWork = await getWorkRaw(env, workId);
  if (beforeWork.version !== requestRow.work_version) throw new DomainError('STALE_VERSION', 409);
  const approvedAt = nowIso();
  const newStatus = requestRow.action === 'CANCEL' ? requestRow.target_execution_status : beforeWork.status;
  const statusHistId = newId('status_hist');
  const archiveHistId = newId('archive_hist');

  const workMutation = env.DB.prepare(`UPDATE works SET
      status=?1,
      archived_at=CASE WHEN ?2='ARCHIVE' THEN ?3 ELSE archived_at END,
      archived_by=CASE WHEN ?2='ARCHIVE' THEN ?4 ELSE archived_by END,
      archive_request_id=CASE WHEN ?2='ARCHIVE' THEN ?5 ELSE archive_request_id END,
      version=version+1, updated_by=?4, updated_at=?3
    WHERE id=?6 AND version=?7
      AND EXISTS (SELECT 1 FROM cancel_archive_requests WHERE id=?5 AND work_id=?6 AND state='PENDING' AND work_version=?7 AND requested_by<>?4)`)
    .bind(newStatus, requestRow.action, approvedAt, actorUid, reqId, workId, beforeWork.version);
  const requestMutation = env.DB.prepare(`UPDATE cancel_archive_requests
    SET state='APPROVED', approved_by=?1, approved_at=?2, approval_request_id=?3
    WHERE id=?4 AND work_id=?5 AND state='PENDING' AND work_version=?6
      AND EXISTS (SELECT 1 FROM works WHERE id=?5 AND version=?7)`)
    .bind(actorUid, approvedAt, requestId, reqId, workId, beforeWork.version, beforeWork.version + 1);
  const historyMutation = env.DB.prepare(`INSERT INTO work_status_history(id, work_id, old_status, new_status, reason, changed_at, changed_by, request_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE ?9='CANCEL' AND EXISTS (SELECT 1 FROM cancel_archive_requests WHERE id=?10 AND state='APPROVED' AND approved_by=?7 AND approval_request_id=?8)`)
    .bind(statusHistId, workId, beforeWork.status, newStatus, `Approved ${requestRow.action} request: ${requestRow.reason}`, approvedAt, actorUid, requestId, requestRow.action, reqId);
  const archiveHistoryMutation = env.DB.prepare(`INSERT INTO work_archive_history(id, work_id, archived_at, archived_by, reason, request_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6
    WHERE ?7='ARCHIVE' AND EXISTS (SELECT 1 FROM cancel_archive_requests WHERE id=?8 AND approval_request_id=?9)`)
    .bind(archiveHistId, workId, approvedAt, actorUid, requestRow.reason, requestId, requestRow.action, reqId, requestId);

  const afterWork = {
    ...beforeWork,
    status: newStatus,
    archived_at: requestRow.action === 'ARCHIVE' ? approvedAt : beforeWork.archived_at,
    archived_by: requestRow.action === 'ARCHIVE' ? actorUid : beforeWork.archived_by,
    archive_request_id: requestRow.action === 'ARCHIVE' ? reqId : beforeWork.archive_request_id,
    updated_by: actorUid,
    updated_at: approvedAt,
    version: beforeWork.version + 1,
  };
  const afterRequest = { ...requestRow, state: 'APPROVED', approved_by: actorUid, approved_at: approvedAt, approval_request_id: requestId };

  const auditRequest = auditStatementWhen(env, 'cancel_archive_request', reqId, 'UPDATE', actorUid, requestRow, afterRequest, env.RUN_MARKER, requestId + ':req', approvedAt,
    'EXISTS (SELECT 1 FROM cancel_archive_requests WHERE id=?10 AND work_id=?11 AND state=\'APPROVED\' AND approved_by=?12 AND approval_request_id=?13)',
    [reqId, workId, actorUid, requestId]);
  const auditWork = auditStatementWhen(env, 'work', workId, 'UPDATE', actorUid, beforeWork, afterWork, env.RUN_MARKER, requestId + ':work', approvedAt,
    'EXISTS (SELECT 1 FROM work_status_history WHERE work_id=?10 AND request_id=?11 AND new_status=?12) OR EXISTS (SELECT 1 FROM work_archive_history WHERE work_id=?10 AND request_id=?11)',
    [workId, requestId, newStatus]);

  const results = await executeBatch(env, [workMutation, requestMutation, historyMutation, archiveHistoryMutation, auditRequest, auditWork]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1 || (requestRow.action === 'CANCEL' && Number(results[2]?.meta?.changes) !== 1) || (requestRow.action === 'ARCHIVE' && Number(results[3]?.meta?.changes) !== 1)) {
    throw new DomainError('TRANSACTION_FAILED', 409);
  }
  return { request: afterRequest, work: workReadModel(afterWork) };
}

export async function listWorkArchiveHistory(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare('SELECT id, work_id, archived_at, archived_by, reason, request_id FROM work_archive_history WHERE work_id = ?1 ORDER BY archived_at ASC, id ASC').bind(workId).all()).results || [];
}

export async function listCancelArchiveRequests(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare('SELECT id, work_id, action, requested_by, requested_at, reason, work_version, state, approved_by, approved_at, approval_request_id, target_execution_status FROM cancel_archive_requests WHERE work_id = ?1 ORDER BY requested_at ASC, id ASC').bind(workId).all()).results || [];
}

async function serveStaticAsset(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  const response = await env.ASSETS.fetch(request);
  return response.status === 404 ? null : response;
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get('x-s3-request-id') || crypto.randomUUID();
    const scenario = request.headers.get('x-s3-scenario') || '';
    const requestedRunId = request.headers.get('x-s3-run-id') || '';
    const runId = requestedRunId === env.RUN_MARKER ? requestedRunId : '';
    const url = new URL(request.url);
    const isStaticAssetRequest = request.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'));
    if (isStaticAssetRequest) {
      const staticResponse = await serveStaticAsset(request, env);
      if (staticResponse) return staticResponse;
    }
    if (url.pathname === '/__test/reset-cache') {
      if (env.TEST_CONTROLS !== 'enabled') return reject(404, 'NOT_FOUND', requestId, 'none', env.RUN_MARKER, scenario);
      if (!env.TEST_RESET_NONCE || request.headers.get('x-s3-test-reset') !== env.TEST_RESET_NONCE) return reject(403, 'TEST_CONTROL_DENIED', requestId, 'none', env.RUN_MARKER, scenario);
      certificateCache = { expiresAt: 0, certificates: null };
      return Response.json({ ok: true, requestId });
    }
    const isAuditMutation = url.pathname === '/__test/audit-mutation';
    if (url.pathname !== '/private/ping' && !isAuditMutation && !url.pathname.startsWith('/api/')) return reject(404, 'NOT_FOUND', requestId, 'none', env.RUN_MARKER, scenario);
    if (isAuditMutation) {
      if (env.TEST_CONTROLS !== 'enabled') return reject(404, 'NOT_FOUND', requestId, 'none', env.RUN_MARKER, scenario);
      if (request.method !== 'POST') return reject(405, 'METHOD_NOT_ALLOWED', requestId, 'none', env.RUN_MARKER, scenario);
      if (!env.TEST_RESET_NONCE || request.headers.get('x-s3-test-reset') !== env.TEST_RESET_NONCE) return reject(403, 'TEST_CONTROL_DENIED', requestId, 'none', env.RUN_MARKER, scenario);
    }
    try {
      const auth = await readAuthorized(request, env, requestId, scenario);
      if (url.pathname === '/private/ping') return Response.json({ ok: true, data: { role: auth.user.role, uid: auth.user.uid }, requestId });
      if (isAuditMutation) {
        const body = await parseRequestJson(request);
        const audit = await applyAuditMutation(env, auth.user.uid, requestId, body.value);
        return Response.json({ ok: true, requestId, role: auth.user.role, audit });
      }
      return await handleApi(request, env, requestId, scenario, auth.user);
    } catch (error) {
      return jsonError(error, requestId, runId, scenario);
    }
  }
};


// S6 PR-A Financial Core: integer-halalah math and governed approval paths.
const MAX_SAFE_HALALAS = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_HALALAS_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_PERSON_1_BPS = 3000;
const DEFAULT_PERSON_2_BPS = 7000;
const PRICE_MOVEMENT_TYPES = Object.freeze(['BASE', 'INCREASE', 'DECREASE', 'DISCOUNT']);

function safeFinancialInteger(value, code = 'MONEY_OVERFLOW') {
  if (!Number.isSafeInteger(value)) throw new DomainError(code, 400);
  return value;
}

function parseMoneyHalalas(value) {
  if (typeof value !== 'string') throw new DomainError('MONEY_TEXT_REQUIRED', 400);
  const raw = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) throw new DomainError('MONEY_FORMAT_INVALID', 400);
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || '').padEnd(2, '0') || '0');
  const halalas = sign * (whole * 100n + fraction);
  if (halalas < -MAX_SAFE_HALALAS_BIGINT || halalas > MAX_SAFE_HALALAS_BIGINT) throw new DomainError('MONEY_OVERFLOW', 400);
  return Number(halalas);
}

function safeFinancialAdd(left, right) {
  const result = BigInt(safeFinancialInteger(left)) + BigInt(safeFinancialInteger(right));
  if (result < -MAX_SAFE_HALALAS_BIGINT || result > MAX_SAFE_HALALAS_BIGINT) throw new DomainError('MONEY_OVERFLOW', 400);
  return Number(result);
}

function roundHalfUpNumerator(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function calculateShareHalalas(priceHalalas, ratioBps) {
  if (priceHalalas === null) return null;
  const numerator = BigInt(safeFinancialInteger(priceHalalas)) * BigInt(ratioBps);
  const rounded = roundHalfUpNumerator(numerator, 10000n);
  if (rounded > MAX_SAFE_HALALAS_BIGINT) throw new DomainError('MONEY_OVERFLOW', 400);
  return Number(rounded);
}

function validateRatioBps(person1, person2) {
  if (!Number.isInteger(person1) || !Number.isInteger(person2) || person1 < 0 || person2 < 0 || person1 > 10000 || person2 > 10000 || person1 + person2 !== 10000) {
    throw new DomainError('RATIO_INVALID', 400);
  }
  return { person_1_bps: person1, person_2_bps: person2 };
}

function validatePriceMovementType(value) {
  const movementType = requiredString(value, 'MOVEMENT_TYPE_REQUIRED').toUpperCase();
  if (!PRICE_MOVEMENT_TYPES.includes(movementType)) throw new DomainError('MOVEMENT_TYPE_INVALID', 400);
  return movementType;
}

function validateMovementAmount(movementType, amountHalalas) {
  safeFinancialInteger(amountHalalas);
  if ((movementType === 'BASE' || movementType === 'INCREASE') && amountHalalas < 0) throw new DomainError('MOVEMENT_SIGN_INVALID', 400);
  if ((movementType === 'DECREASE' || movementType === 'DISCOUNT') && amountHalalas > 0) throw new DomainError('MOVEMENT_SIGN_INVALID', 400);
  return amountHalalas;
}

async function listApprovedPriceMovementsRaw(env, workId) {
  const rows = (await env.DB.prepare(`SELECT id, work_id, price_request_id, movement_type, amount_halalas, reason, effective_at, requested_by, approved_by, requested_at, approved_at, resulting_price_halalas, request_id
    FROM price_movements WHERE work_id=?1 ORDER BY approved_at ASC, id ASC`).bind(workId).all()).results || [];
  let current = null;
  return rows.map(row => {
    const previous = current;
    const next = safeFinancialAdd(previous === null ? 0 : previous, Number(row.amount_halalas));
    current = next;
    return { ...row, previous_price_halalas: previous, new_price_halalas: next };
  });
}

function sumApprovedPriceMovements(movements) {
  let total = 0;
  for (const movement of movements) total = safeFinancialAdd(total, Number(movement.amount_halalas));
  return movements.length ? total : null;
}

async function currentRatio(env, workId) {
  const row = await env.DB.prepare(`SELECT new_person_1_bps, new_person_2_bps FROM ratio_history WHERE work_id=?1 ORDER BY approved_at DESC, id DESC LIMIT 1`).bind(workId).first();
  return row ? { person_1_bps: Number(row.new_person_1_bps), person_2_bps: Number(row.new_person_2_bps), source: 'APPROVED_HISTORY' } : { person_1_bps: DEFAULT_PERSON_1_BPS, person_2_bps: DEFAULT_PERSON_2_BPS, source: 'DEFAULT' };
}

export async function getWorkFinancials(env, workId) {
  await getWorkRaw(env, workId);
  const [movements, priceRequests, ratioRequests, ratioHistory] = await Promise.all([
    listApprovedPriceMovementsRaw(env, workId),
    listPriceChangeRequests(env, workId),
    listRatioChangeRequests(env, workId),
    listRatioHistory(env, workId),
  ]);
  const currentPriceHalalas = sumApprovedPriceMovements(movements);
  const ratio = await currentRatio(env, workId);
  const person1Share = calculateShareHalalas(currentPriceHalalas, ratio.person_1_bps);
  const person2Share = calculateShareHalalas(currentPriceHalalas, ratio.person_2_bps);
  return {
    work_id: workId,
    price_state: currentPriceHalalas === null ? 'PRICE_UNSET' : 'PRICE_APPROVED',
    current_price_halalas: currentPriceHalalas,
    ratio,
    shares: { person_1_halalas: person1Share, person_2_halalas: person2Share },
    approved_payments_total_halalas: 0,
    remaining_halalas: currentPriceHalalas,
    remaining_projection: 'PRE_S7_APPROVED_PAYMENTS_ZERO',
    movements,
    price_requests: priceRequests,
    ratio_requests: ratioRequests,
    ratio_history: ratioHistory,
  };
}

export async function listPriceMovements(env, workId) {
  await getWorkRaw(env, workId);
  return listApprovedPriceMovementsRaw(env, workId);
}

export async function listPriceChangeRequests(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare(`SELECT id, work_id, movement_type, amount_halalas, reason, effective_at, requested_by, requested_at, work_version, state, approved_by, approved_at, approval_request_id, request_id
    FROM price_change_requests WHERE work_id=?1 ORDER BY requested_at ASC, id ASC`).bind(workId).all()).results || [];
}

export async function createPriceChangeRequest(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const beforeWork = await getWorkRaw(env, workId);
  const version = positiveVersion(input.version);
  if (version !== beforeWork.version) throw new DomainError('VERSION_CONFLICT', 409);
  const movementType = validatePriceMovementType(input.movement_type);
  const amountHalalas = validateMovementAmount(movementType, parseMoneyHalalas(input.amount_riyals));
  const currentMovements = await listApprovedPriceMovementsRaw(env, workId);
  if (!currentMovements.length && movementType !== 'BASE') throw new DomainError('BASE_REQUIRED', 400);
  if (currentMovements.length && movementType === 'BASE') throw new DomainError('BASE_ALREADY_SET', 400);
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  const effectiveAt = canonicalEventTimestamp(input.effective_at === undefined ? nowIso() : input.effective_at);
  const id = newId('price_req');
  const requestedAt = nowIso();
  const after = { id, work_id: workId, movement_type: movementType, amount_halalas: amountHalalas, reason, effective_at: effectiveAt, requested_by: actorUid, requested_at: requestedAt, work_version: version, state: 'PENDING', approved_by: null, approved_at: null, approval_request_id: null, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO price_change_requests(id,work_id,movement_type,amount_halalas,reason,effective_at,requested_by,requested_at,work_version,state,request_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'PENDING',?10)`).bind(id, workId, movementType, amountHalalas, reason, effectiveAt, actorUid, requestedAt, version, requestId);
  const audit = auditStatement(env, 'price_change_request', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, requestedAt);
  await executeBatch(env, [mutation, audit]);
  return after;
}

export async function approvePriceChangeRequest(env, actorUid, requestId, workId, requestIdToApprove) {
  await ensureActor(env, actorUid);
  const requestRow = await env.DB.prepare('SELECT * FROM price_change_requests WHERE id=?1').bind(requestIdToApprove).first();
  if (!requestRow) throw new DomainError('PRICE_REQUEST_NOT_FOUND', 404);
  if (requestRow.work_id !== workId) throw new DomainError('REQUEST_WORK_MISMATCH', 404);
  if (requestRow.state !== 'PENDING') throw new DomainError('ALREADY_FINALIZED', 400);
  if (requestRow.requested_by === actorUid) throw new DomainError('SELF_APPROVAL_REJECTED', 400);
  const beforeWork = await getWorkRaw(env, workId);
  if (beforeWork.version !== requestRow.work_version) throw new DomainError('STALE_VERSION', 409);
  const movements = await listApprovedPriceMovementsRaw(env, workId);
  if (requestRow.movement_type === 'BASE' && movements.length) throw new DomainError('BASE_ALREADY_SET', 409);
  if (requestRow.movement_type !== 'BASE' && !movements.length) throw new DomainError('BASE_REQUIRED', 409);
  const previousPrice = sumApprovedPriceMovements(movements) === null ? 0 : sumApprovedPriceMovements(movements);
  const resultingPrice = safeFinancialAdd(previousPrice, Number(requestRow.amount_halalas));
  if (resultingPrice < 0) throw new DomainError('S6_NEGATIVE_FINAL_PRICE_POLICY_UNRESOLVED', 409);
  const approvedAt = nowIso();
  const movementId = newId('price_move');
  const afterRequest = { ...requestRow, state: 'APPROVED', approved_by: actorUid, approved_at: approvedAt, approval_request_id: requestId };
  const afterMovement = { id: movementId, work_id: workId, price_request_id: requestIdToApprove, movement_type: requestRow.movement_type, amount_halalas: Number(requestRow.amount_halalas), reason: requestRow.reason, effective_at: requestRow.effective_at, requested_by: requestRow.requested_by, approved_by: actorUid, requested_at: requestRow.requested_at, approved_at: approvedAt, resulting_price_halalas: resultingPrice, request_id: requestId };
  const workMutation = env.DB.prepare(`UPDATE works SET version=version+1, updated_by=?1, updated_at=?2 WHERE id=?3 AND version=?4 AND EXISTS (SELECT 1 FROM price_change_requests WHERE id=?5 AND state='PENDING' AND work_version=?4 AND requested_by<>?1)`).bind(actorUid, approvedAt, workId, beforeWork.version, requestIdToApprove);
  const requestMutation = env.DB.prepare(`UPDATE price_change_requests SET state='APPROVED', approved_by=?1, approved_at=?2, approval_request_id=?3 WHERE id=?4 AND work_id=?5 AND state='PENDING' AND work_version=?6 AND EXISTS (SELECT 1 FROM works WHERE id=?5 AND version=?7)`).bind(actorUid, approvedAt, requestId, requestIdToApprove, workId, beforeWork.version, beforeWork.version + 1);
  const movementMutation = env.DB.prepare(`INSERT INTO price_movements(id,work_id,price_request_id,movement_type,amount_halalas,reason,effective_at,requested_by,approved_by,requested_at,approved_at,resulting_price_halalas,request_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE EXISTS (SELECT 1 FROM price_change_requests WHERE id=?3 AND state='APPROVED' AND approval_request_id=?13)`).bind(movementId, workId, requestIdToApprove, requestRow.movement_type, Number(requestRow.amount_halalas), requestRow.reason, requestRow.effective_at, requestRow.requested_by, actorUid, requestRow.requested_at, approvedAt, resultingPrice, requestId);
  const auditRequest = auditStatementWhen(env, 'price_change_request', requestIdToApprove, 'UPDATE', actorUid, requestRow, afterRequest, env.RUN_MARKER, `${requestId}:price_request`, approvedAt,
    'EXISTS (SELECT 1 FROM price_change_requests WHERE id=?10 AND state=\'APPROVED\' AND approved_by=?11 AND approval_request_id=?12)', [requestIdToApprove, actorUid, requestId]);
  const auditMovement = auditStatementWhen(env, 'price_movement', movementId, 'CREATE', actorUid, null, afterMovement, env.RUN_MARKER, `${requestId}:price_movement`, approvedAt,
    'EXISTS (SELECT 1 FROM price_movements WHERE id=?10 AND work_id=?11 AND request_id=?12 AND resulting_price_halalas=?13)', [movementId, workId, requestId, resultingPrice]);
  const results = await executeBatch(env, [workMutation, requestMutation, movementMutation, auditRequest, auditMovement]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1 || !results[2]?.meta || Number(results[2].meta.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return { request: afterRequest, movement: afterMovement, financials: await getWorkFinancials(env, workId) };
}

export async function listRatioChangeRequests(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare(`SELECT id, work_id, person_1_bps, person_2_bps, reason, requested_by, requested_at, work_version, state, approved_by, approved_at, approval_request_id, request_id
    FROM ratio_change_requests WHERE work_id=?1 ORDER BY requested_at ASC, id ASC`).bind(workId).all()).results || [];
}

export async function listRatioHistory(env, workId) {
  await getWorkRaw(env, workId);
  return (await env.DB.prepare(`SELECT id, work_id, old_person_1_bps, old_person_2_bps, new_person_1_bps, new_person_2_bps, reason, requested_by, approved_by, requested_at, approved_at, ratio_request_id, request_id
    FROM ratio_history WHERE work_id=?1 ORDER BY approved_at ASC, id ASC`).bind(workId).all()).results || [];
}

export async function createRatioChangeRequest(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const beforeWork = await getWorkRaw(env, workId);
  const version = positiveVersion(input.version);
  if (version !== beforeWork.version) throw new DomainError('VERSION_CONFLICT', 409);
  const nextRatio = validateRatioBps(input.person_1_bps, input.person_2_bps);
  const oldRatio = await currentRatio(env, workId);
  if (nextRatio.person_1_bps === oldRatio.person_1_bps && nextRatio.person_2_bps === oldRatio.person_2_bps) throw new DomainError('RATIO_UNCHANGED', 400);
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  const id = newId('ratio_req');
  const requestedAt = nowIso();
  const after = { id, work_id: workId, person_1_bps: nextRatio.person_1_bps, person_2_bps: nextRatio.person_2_bps, reason, requested_by: actorUid, requested_at: requestedAt, work_version: version, state: 'PENDING', approved_by: null, approved_at: null, approval_request_id: null, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO ratio_change_requests(id,work_id,person_1_bps,person_2_bps,reason,requested_by,requested_at,work_version,state,request_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'PENDING',?9)`).bind(id, workId, nextRatio.person_1_bps, nextRatio.person_2_bps, reason, actorUid, requestedAt, version, requestId);
  const audit = auditStatement(env, 'ratio_change_request', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, requestedAt);
  await executeBatch(env, [mutation, audit]);
  return after;
}

export async function approveRatioChangeRequest(env, actorUid, requestId, workId, requestIdToApprove) {
  await ensureActor(env, actorUid);
  const requestRow = await env.DB.prepare('SELECT * FROM ratio_change_requests WHERE id=?1').bind(requestIdToApprove).first();
  if (!requestRow) throw new DomainError('RATIO_REQUEST_NOT_FOUND', 404);
  if (requestRow.work_id !== workId) throw new DomainError('REQUEST_WORK_MISMATCH', 404);
  if (requestRow.state !== 'PENDING') throw new DomainError('ALREADY_FINALIZED', 400);
  if (requestRow.requested_by === actorUid) throw new DomainError('SELF_APPROVAL_REJECTED', 400);
  const beforeWork = await getWorkRaw(env, workId);
  if (beforeWork.version !== requestRow.work_version) throw new DomainError('STALE_VERSION', 409);
  const oldRatio = await currentRatio(env, workId);
  const approvedAt = nowIso();
  const historyId = newId('ratio_hist');
  const afterRequest = { ...requestRow, state: 'APPROVED', approved_by: actorUid, approved_at: approvedAt, approval_request_id: requestId };
  const afterHistory = { id: historyId, work_id: workId, old_person_1_bps: oldRatio.person_1_bps, old_person_2_bps: oldRatio.person_2_bps, new_person_1_bps: Number(requestRow.person_1_bps), new_person_2_bps: Number(requestRow.person_2_bps), reason: requestRow.reason, requested_by: requestRow.requested_by, approved_by: actorUid, requested_at: requestRow.requested_at, approved_at: approvedAt, ratio_request_id: requestIdToApprove, request_id: requestId };
  const workMutation = env.DB.prepare(`UPDATE works SET version=version+1, updated_by=?1, updated_at=?2 WHERE id=?3 AND version=?4 AND EXISTS (SELECT 1 FROM ratio_change_requests WHERE id=?5 AND state='PENDING' AND work_version=?4 AND requested_by<>?1)`).bind(actorUid, approvedAt, workId, beforeWork.version, requestIdToApprove);
  const requestMutation = env.DB.prepare(`UPDATE ratio_change_requests SET state='APPROVED', approved_by=?1, approved_at=?2, approval_request_id=?3 WHERE id=?4 AND work_id=?5 AND state='PENDING' AND work_version=?6 AND EXISTS (SELECT 1 FROM works WHERE id=?5 AND version=?7)`).bind(actorUid, approvedAt, requestId, requestIdToApprove, workId, beforeWork.version, beforeWork.version + 1);
  const historyMutation = env.DB.prepare(`INSERT INTO ratio_history(id,work_id,old_person_1_bps,old_person_2_bps,new_person_1_bps,new_person_2_bps,reason,requested_by,approved_by,requested_at,approved_at,ratio_request_id,request_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE EXISTS (SELECT 1 FROM ratio_change_requests WHERE id=?12 AND state='APPROVED' AND approval_request_id=?13)`).bind(historyId, workId, oldRatio.person_1_bps, oldRatio.person_2_bps, Number(requestRow.person_1_bps), Number(requestRow.person_2_bps), requestRow.reason, requestRow.requested_by, actorUid, requestRow.requested_at, approvedAt, requestIdToApprove, requestId);
  const auditRequest = auditStatementWhen(env, 'ratio_change_request', requestIdToApprove, 'UPDATE', actorUid, requestRow, afterRequest, env.RUN_MARKER, `${requestId}:ratio_request`, approvedAt,
    'EXISTS (SELECT 1 FROM ratio_change_requests WHERE id=?10 AND state=\'APPROVED\' AND approved_by=?11 AND approval_request_id=?12)', [requestIdToApprove, actorUid, requestId]);
  const auditHistory = auditStatementWhen(env, 'ratio_history', historyId, 'CREATE', actorUid, null, afterHistory, env.RUN_MARKER, `${requestId}:ratio_history`, approvedAt,
    'EXISTS (SELECT 1 FROM ratio_history WHERE id=?10 AND work_id=?11 AND request_id=?12 AND new_person_1_bps=?13)', [historyId, workId, requestId, Number(requestRow.person_1_bps)]);
  const results = await executeBatch(env, [workMutation, requestMutation, historyMutation, auditRequest, auditHistory]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1 || !results[2]?.meta || Number(results[2].meta.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return { request: afterRequest, history: afterHistory, financials: await getWorkFinancials(env, workId) };
}
