const DEFAULT_CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

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
  console.log({ event: 'auth_result', requestId, code, cacheState, allowed: false, runId: runMarker, scenario, s3Correlation });
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
function certificateCacheApi() {
  const cache = globalThis.caches?.default;
  return cache && typeof cache.match === 'function' && typeof cache.put === 'function' ? cache : null;
}
function certificateCacheKey(env) {
  return new Request(env.CERT_URL_OVERRIDE || DEFAULT_CERT_URL, { method: 'GET' });
}
function validCertificateMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}
export async function getCertificates(env, force = false) {
  const url = env.CERT_URL_OVERRIDE || DEFAULT_CERT_URL;
  const cache = certificateCacheApi(); const cacheKey = certificateCacheKey(env);
  if (!force && cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const certificates = await cached.json();
      if (!validCertificateMetadata(certificates)) throw new Error('CERT_METADATA_INVALID');
      return { certificates, state: 'hit' };
    }
  }
  const response = await fetch(url, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error('CERT_FETCH_FAILED');
  if (env.FORCE_CACHE_METADATA_INVALID === 'true') throw new Error('CACHE_METADATA_INVALID');
  const ttl = maxAge(response.headers); const certificates = await response.json();
  if (!validCertificateMetadata(certificates)) throw new Error('CERT_METADATA_INVALID');
  if (cache) {
    await cache.put(cacheKey, new Response(JSON.stringify(certificates), { headers: { 'Cache-Control': `public, max-age=${ttl}`, 'Content-Type': 'application/json' } }));
  }
  return { certificates, state: 'miss' };
}
async function clearCertificateCache(env) {
  const cache = certificateCacheApi();
  if (cache && typeof cache.delete === 'function') await cache.delete(certificateCacheKey(env));
}
async function verifyJwt(token, env, forceRefresh = false) {
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('JWT_FORMAT');
  const header = b64urlJson(parts[0]); const claims = b64urlJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) throw new Error('JWT_HEADER');
  let certSet = await getCertificates(env, forceRefresh); let pem = certSet.certificates[header.kid];
  if (!pem && !forceRefresh && certSet.state === 'hit') { certSet = await getCertificates(env, true); pem = certSet.certificates[header.kid]; }
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
  const row = await env.DB.prepare('SELECT uid, role, auth_valid_since FROM app_users WHERE uid = ?1 AND active = 1').bind(uid).first();
  return row || null;
}

let lastIssuedTimestampMs = 0;
function nowIso() {
  const currentMs = Date.now();
  const issuedMs = Math.max(currentMs, lastIssuedTimestampMs + 1);
  lastIssuedTimestampMs = issuedMs;
  return new Date(issuedMs).toISOString();
}
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
  return { ...work, is_archived: Boolean(work.archived_at), is_cancelled: isCancelledWorkStatus(work.status), soft_warnings: softWorkDetailWarnings(work) };
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
  const confirmedAt = input.confirmed_at === undefined || input.confirmed_at === null ? null : canonicalEventTimestamp(input.confirmed_at);
  await prbEnsureWorkAffectedPeriods(env, null, confirmedAt);
  const after = { id, customer_id: validated.customerId, parent_work_id: validated.parentWorkId, relationship_kind: validated.relationshipKind, title: validated.title, work_type_key: validated.workTypeKey, specialty_key: validated.specialtyKey, subject_or_course_code: validated.subject, country: validated.country, university: validated.university, status: validated.status, description: validated.description, quantity: validated.quantity, price_state: priceState, price_minor_units: priceState === 'PRICE_ZERO' ? 0 : null, created_by: actorUid, created_at: createdAt, updated_by: actorUid, updated_at: createdAt, confirmed_at: confirmedAt, version: 1 };
  const mutation = env.DB.prepare(`INSERT INTO works(id,customer_id,parent_work_id,relationship_kind,title,work_type_key,specialty_key,subject_or_course_code,country,university,status,description,quantity,price_state,price_minor_units,created_by,created_at,updated_by,updated_at,confirmed_at,version)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?16,?17,?18,1)`).bind(id, after.customer_id, after.parent_work_id, after.relationship_kind, after.title, after.work_type_key, after.specialty_key, after.subject_or_course_code, after.country, after.university, after.status, after.description, after.quantity, after.price_state, after.price_minor_units, actorUid, createdAt, confirmedAt);
  const audit = auditStatement(env, 'work', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
  try {
    await executeBatch(env, [mutation, audit]);
  } catch (error) {
    if (!(error instanceof Error) || !/no column named confirmed_at/.test(error.message)) throw error;
    const legacyMutation = env.DB.prepare(`INSERT INTO works(id,customer_id,parent_work_id,relationship_kind,title,work_type_key,specialty_key,subject_or_course_code,country,university,status,description,quantity,price_state,price_minor_units,created_by,created_at,updated_by,updated_at,version)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?16,?17,1)`).bind(id, after.customer_id, after.parent_work_id, after.relationship_kind, after.title, after.work_type_key, after.specialty_key, after.subject_or_course_code, after.country, after.university, after.status, after.description, after.quantity, after.price_state, after.price_minor_units, actorUid, createdAt);
    await executeBatch(env, [legacyMutation, audit]);
  }
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

const S8_ALERT_TYPES = Object.freeze(['NO_PRICE', 'NO_REPLY', 'NO_PAYMENT']);
const S8_PERIOD_BASES = Object.freeze(['CREATED_AT', 'CONFIRMED_AT']);
const S8_SEARCH_DEFAULT_PAGE_SIZE = 50;
const S8_SEARCH_MAX_PAGE_SIZE = 100;

function s8RequiredAlertType(value) {
  const type = requiredString(value, 'S8_ALERT_TYPE_REQUIRED').toUpperCase();
  if (!S8_ALERT_TYPES.includes(type)) throw new DomainError('S8_ALERT_TYPE_INVALID', 400);
  return type;
}
function s8PositiveThresholdDays(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 36500) throw new DomainError('S8_ALERT_THRESHOLD_INVALID', 400);
  return parsed;
}
function s8PageValue(value, code, fallback, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new DomainError(code, 400);
  return parsed;
}
function s8LikePattern(value) { return `%${String(value).replace(/[\\%_]/g, character => `\\${character}`)}%`; }
function s8PeriodFilter(input) {
  const month = input.month === undefined || input.month === null || input.month === '' ? null : String(input.month).padStart(2, '0');
  const year = input.year === undefined || input.year === null || input.year === '' ? null : String(input.year);
  const requestedBasis = input.period_basis === undefined || input.period_basis === null || input.period_basis === '' ? null : String(input.period_basis).toUpperCase();
  if ((month || year) && !requestedBasis) throw new DomainError('S8_PERIOD_BASIS_REQUIRED', 400);
  if (requestedBasis && !S8_PERIOD_BASES.includes(requestedBasis)) throw new DomainError('S8_PERIOD_BASIS_INVALID', 400);
  if (month && !/^(0[1-9]|1[0-2])$/.test(month)) throw new DomainError('S8_MONTH_INVALID', 400);
  if (year && !/^\d{4}$/.test(year)) throw new DomainError('S8_YEAR_INVALID', 400);
  return { month, year, basis: requestedBasis, column: requestedBasis === 'CONFIRMED_AT' ? 'w.confirmed_at' : 'w.created_at' };
}
function s8IncludeArchived(value) {
  if (value === undefined || value === null || value === '') return true;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new DomainError('S8_INCLUDE_ARCHIVED_INVALID', 400);
}
function s8CollectionSql() {
  return `CASE
    WHEN w.status='CANCELLED_BEFORE_EXECUTION' THEN 'CANCELLED_ZERO_BALANCE'
    WHEN COALESCE(p.price_movement_count,0)=0 THEN 'PRICE_UNSET'
    WHEN COALESCE(pay.approved_paid_halalas,0)>p.current_price_halalas THEN 'OVERPAYMENT_UNRESOLVED'
    WHEN p.current_price_halalas=0 OR COALESCE(pay.approved_paid_halalas,0)=p.current_price_halalas THEN 'FINANCIALLY_CLOSED'
    WHEN COALESCE(pay.approved_paid_halalas,0)=0 THEN 'UNPAID'
    ELSE 'PARTIALLY_COLLECTED'
  END`;
}
export async function searchWorksS8(env, input = {}) {
  const page = s8PageValue(input.page, 'S8_PAGE_INVALID', 1, 1000000);
  const pageSize = s8PageValue(input.page_size, 'S8_PAGE_SIZE_INVALID', S8_SEARCH_DEFAULT_PAGE_SIZE, S8_SEARCH_MAX_PAGE_SIZE);
  const includeArchived = s8IncludeArchived(input.include_archived);
  const period = s8PeriodFilter(input);
  const values = [];
  const add = value => { values.push(value); return `?${values.length}`; };
  const clauses = [];
  if (!includeArchived) clauses.push('w.archived_at IS NULL');
  for (const [column, value] of [['w.customer_id', input.customer_id], ['w.status', input.status], ['w.country', input.country], ['w.university', input.university], ['w.specialty_key', input.specialty_key], ['w.work_type_key', input.work_type_key]]) {
    if (value !== undefined && value !== null && value !== '') clauses.push(`${column}=${add(String(value))}`);
  }
  if (period.month) clauses.push(`strftime('%m',${period.column})=${add(period.month)}`);
  if (period.year) clauses.push(`strftime('%Y',${period.column})=${add(period.year)}`);
  if (input.q !== undefined && input.q !== null && String(input.q) !== '') {
    const pattern = s8LikePattern(input.q);
    const current = add(pattern); const historicalOld = add(pattern); const historicalNew = add(pattern);
    clauses.push(`(w.title LIKE ${current} ESCAPE '\\' OR EXISTS (SELECT 1 FROM work_title_history th WHERE th.work_id=w.id AND (th.old_title LIKE ${historicalOld} ESCAPE '\\' OR th.new_title LIKE ${historicalNew} ESCAPE '\\')))`);
  }
  const collection = input.collection_status === undefined || input.collection_status === null || input.collection_status === '' ? null : String(input.collection_status).toUpperCase();
  if (collection && !['PRICE_UNSET', 'UNPAID', 'PARTIALLY_COLLECTED', 'FINANCIALLY_CLOSED', 'OVERPAYMENT_UNRESOLVED', 'CANCELLED_ZERO_BALANCE'].includes(collection)) throw new DomainError('S8_COLLECTION_INVALID', 400);
  const baseWhere = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const collectionWhere = collection ? `WHERE collection_status=${add(collection)}` : '';
  const limit = add(pageSize); const offset = add((page - 1) * pageSize);
  const sql = `WITH price_totals AS (
      SELECT work_id,COUNT(*) AS price_movement_count,SUM(amount_halalas) AS current_price_halalas FROM price_movements GROUP BY work_id
    ), payment_totals AS (
      SELECT p.work_id,COALESCE(SUM(p.amount_halalas),0)-COALESCE(SUM(r.amount_halalas),0) AS approved_paid_halalas
      FROM client_payments p LEFT JOIN payment_reversals r ON r.payment_id=p.id GROUP BY p.work_id
    ), projected AS (
      SELECT w.id,w.customer_id,w.title,w.status,w.country,w.university,w.specialty_key,w.work_type_key,w.created_at,w.confirmed_at,w.archived_at,
        c.name AS customer_name,COALESCE(p.current_price_halalas,NULL) AS current_price_halalas,COALESCE(pay.approved_paid_halalas,0) AS approved_paid_halalas,
        ${s8CollectionSql()} AS collection_status
      FROM works w JOIN customers c ON c.id=w.customer_id
      LEFT JOIN price_totals p ON p.work_id=w.id LEFT JOIN payment_totals pay ON pay.work_id=w.id
      ${baseWhere}
    ), filtered AS (SELECT * FROM projected ${collectionWhere})
    SELECT *,COUNT(*) OVER() AS total_count FROM filtered ORDER BY created_at ASC,id ASC LIMIT ${limit} OFFSET ${offset}`;
  const rows = (await env.DB.prepare(sql).bind(...values).all()).results || [];
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const items = rows.map(row => ({ ...row, is_archived: Boolean(row.archived_at), current_price_halalas: row.current_price_halalas === null ? null : Number(row.current_price_halalas), approved_paid_halalas: Number(row.approved_paid_halalas) }));
  return { items, page, page_size: pageSize, has_more: page * pageSize < total };
}
export async function listS8AlertSettings(env) {
  const rows = (await env.DB.prepare('SELECT alert_type,threshold_days,updated_by,updated_at,request_id FROM s8_alert_settings ORDER BY alert_type ASC').all()).results || [];
  const byType = new Map(rows.map(row => [row.alert_type, { ...row, state: 'CONFIGURED', threshold_days: Number(row.threshold_days) }]));
  return S8_ALERT_TYPES.map(alertType => byType.get(alertType) || { alert_type: alertType, state: 'NOT_CONFIGURED', threshold_days: null, updated_by: null, updated_at: null, request_id: null });
}
export async function upsertS8AlertSetting(env, actorUid, requestId, input) {
  await ensureActor(env, actorUid);
  const alertType = s8RequiredAlertType(input.alert_type); const thresholdDays = s8PositiveThresholdDays(input.threshold_days);
  const replay = await env.DB.prepare('SELECT alert_type,threshold_days,updated_by,updated_at,request_id FROM s8_alert_settings WHERE request_id=?1').bind(requestId).first();
  if (replay) {
    if (replay.alert_type !== alertType || Number(replay.threshold_days) !== thresholdDays) throw new DomainError('S8_ALERT_REQUEST_ID_REUSE', 409);
    return { ...replay, threshold_days: Number(replay.threshold_days), idempotent_replay: true };
  }
  const before = await env.DB.prepare('SELECT alert_type,threshold_days,updated_by,updated_at,request_id FROM s8_alert_settings WHERE alert_type=?1').bind(alertType).first();
  const updatedAt = nowIso(); const after = { alert_type: alertType, threshold_days: thresholdDays, updated_by: actorUid, updated_at: updatedAt, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO s8_alert_settings(alert_type,threshold_days,updated_by,updated_at,request_id)
      VALUES (?1,?2,?3,?4,?5) ON CONFLICT(alert_type) DO UPDATE SET threshold_days=excluded.threshold_days,updated_by=excluded.updated_by,updated_at=excluded.updated_at,request_id=excluded.request_id`).bind(alertType, thresholdDays, actorUid, updatedAt, requestId);
  await executeBatch(env, [mutation, auditStatement(env, 's8_alert_setting', alertType, before ? 'UPDATE' : 'CREATE', actorUid, before, after, env.RUN_MARKER, requestId, updatedAt)]);
  return { ...after, idempotent_replay: false };
}
function s8AlertNow(internal = {}) {
  const injected = internal && Object.prototype.hasOwnProperty.call(internal, 'testNow') ? internal.testNow : undefined;
  return injected === undefined || injected === null || injected === '' ? nowIso() : canonicalEventTimestamp(injected);
}
function s8AlertAgeDays(anchorAt, now) {
  const age = new Date(now).getTime() - new Date(anchorAt).getTime();
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.floor(age / 86400000);
}
export async function getS8Alerts(env, input = {}, internal = {}) {
  const requested = input.alert_type === undefined || input.alert_type === null || input.alert_type === '' ? [...S8_ALERT_TYPES] : [s8RequiredAlertType(input.alert_type)];
  const now = s8AlertNow(internal); const settings = await listS8AlertSettings(env); const byType = new Map(settings.map(setting => [setting.alert_type, setting]));
  const configured = requested.filter(alertType => byType.get(alertType)?.threshold_days !== null);
  const itemsByType = new Map(configured.map(alertType => [alertType, []]));
  if (configured.length) {
    const candidatesSql = `WITH price_totals AS (
        SELECT work_id,SUM(amount_halalas) AS current_price_halalas FROM price_movements GROUP BY work_id
      ), payment_totals AS (
        SELECT p.work_id,COALESCE(SUM(p.amount_halalas),0)-COALESCE(SUM(r.amount_halalas),0) AS approved_paid_halalas
        FROM client_payments p LEFT JOIN payment_reversals r ON r.payment_id=p.id GROUP BY p.work_id
      ), reply_anchors AS (
        SELECT work_id,MAX(changed_at) AS anchor_at FROM work_status_history WHERE new_status='WAITING_CLIENT_RESPONSE' GROUP BY work_id
      ), candidates AS (
        SELECT 'NO_PRICE' AS alert_type,w.id AS work_id,w.customer_id,w.title,w.created_at AS anchor_at,NULL AS current_price_halalas,0 AS approved_paid_halalas
        FROM works w LEFT JOIN price_totals pt ON pt.work_id=w.id
        WHERE w.archived_at IS NULL AND w.status NOT IN ('CANCELLED_BEFORE_EXECUTION','PARTIALLY_STOPPED') AND pt.current_price_halalas IS NULL
        UNION ALL
        SELECT 'NO_REPLY' AS alert_type,w.id AS work_id,w.customer_id,w.title,COALESCE(ra.anchor_at,w.created_at) AS anchor_at,NULL AS current_price_halalas,0 AS approved_paid_halalas
        FROM works w LEFT JOIN reply_anchors ra ON ra.work_id=w.id
        WHERE w.archived_at IS NULL AND w.status='WAITING_CLIENT_RESPONSE'
        UNION ALL
        SELECT 'NO_PAYMENT' AS alert_type,w.id AS work_id,w.customer_id,w.title,w.confirmed_at AS anchor_at,pt.current_price_halalas,COALESCE(pay.approved_paid_halalas,0) AS approved_paid_halalas
        FROM works w JOIN price_totals pt ON pt.work_id=w.id LEFT JOIN payment_totals pay ON pay.work_id=w.id
        WHERE w.archived_at IS NULL AND w.status NOT IN ('CANCELLED_BEFORE_EXECUTION','PARTIALLY_STOPPED') AND w.confirmed_at IS NOT NULL AND pt.current_price_halalas>0 AND COALESCE(pay.approved_paid_halalas,0)=0
      )
      SELECT c.alert_type,c.work_id,c.customer_id,c.title,c.anchor_at,c.current_price_halalas,c.approved_paid_halalas,s.threshold_days
      FROM candidates c JOIN s8_alert_settings s ON s.alert_type=c.alert_type
      WHERE c.alert_type IN (${configured.map(() => '?').join(',')}) AND datetime(c.anchor_at,'+' || s.threshold_days || ' days')<=datetime(?)
      ORDER BY c.alert_type ASC,c.anchor_at ASC,c.work_id ASC`;
    const rows = (await env.DB.prepare(candidatesSql).bind(...configured, now).all()).results || [];
    for (const row of rows) itemsByType.get(row.alert_type)?.push({ work_id: row.work_id, customer_id: row.customer_id, title: row.title, anchor_at: row.anchor_at, age_days: s8AlertAgeDays(row.anchor_at, now), current_price_halalas: row.current_price_halalas === null ? null : Number(row.current_price_halalas), approved_paid_halalas: Number(row.approved_paid_halalas) });
  }
  return { now, alerts: requested.map(alertType => {
    const setting = byType.get(alertType);
    if (!setting || setting.state === 'NOT_CONFIGURED') return { alert_type: alertType, state: 'NOT_CONFIGURED', threshold_days: null, items: [] };
    return { alert_type: alertType, state: 'CONFIGURED', threshold_days: setting.threshold_days, items: itemsByType.get(alertType) || [] };
  }) };
}

function s8AnalyticsInput(input = {}) {
  const period = s8PeriodFilter(input);
  if (!period.basis) throw new DomainError('S8_ANALYTICS_PERIOD_BASIS_REQUIRED', 400);
  return { period, includeArchived: s8IncludeArchived(input.include_archived) };
}
const S8_EXPORT_DEFAULT_PAGE_SIZE = 500;
const S8_EXPORT_MAX_PAGE_SIZE = 1000;
function s8ExportPageSize(input = {}) { return s8PageValue(input.page_size, 'S8_EXPORT_PAGE_SIZE_INVALID', S8_EXPORT_DEFAULT_PAGE_SIZE, S8_EXPORT_MAX_PAGE_SIZE); }
function s8CursorEncode(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function s8CursorDecode(value, timestampKey, code) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlBytes(String(value))));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || parsed.id === '' || typeof parsed[timestampKey] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[timestampKey]) || new Date(parsed[timestampKey]).toISOString() !== parsed[timestampKey]) throw new Error('invalid');
    return { id: parsed.id, [timestampKey]: parsed[timestampKey] };
  } catch { throw new DomainError(code, 400); }
}
function s8JsonAmounts(value) {
  if (value === null || value === undefined || value === '') return [];
  try {
    const values = JSON.parse(value);
    if (!Array.isArray(values)) throw new Error('invalid');
    return values.map(safeFinancialInteger);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('MONEY_OVERFLOW', 400);
  }
}
function s8SumAmounts(values) { return values.reduce((total, value) => safeFinancialAdd(total, value), 0); }
function s8FinancialRow(row) {
  const priceAmounts = s8JsonAmounts(row.price_amounts_json); const paymentAmounts = s8JsonAmounts(row.payment_amounts_json); const reversalAmounts = s8JsonAmounts(row.reversal_amounts_json);
  const currentPrice = priceAmounts.length ? s8SumAmounts(priceAmounts) : null;
  const approvedPaid = safeFinancialAdd(s8SumAmounts(paymentAmounts), -s8SumAmounts(reversalAmounts));
  return {
    ...row,
    is_archived: Boolean(row.archived_at),
    current_price_halalas: currentPrice,
    approved_paid_halalas: approvedPaid,
    remaining_halalas: row.status === 'CANCELLED_BEFORE_EXECUTION' ? 0 : currentPrice === null ? null : safeFinancialAdd(currentPrice, -approvedPaid),
    collection_status: paymentCollectionStatus(currentPrice, approvedPaid, row.status),
  };
}
function s8EligibleWorkSql(input = {}, required = {}) {
  const { period, includeArchived } = s8AnalyticsInput(input); const values = []; const add = value => { values.push(value); return `?${values.length}`; };
  const clauses = [];
  if (!includeArchived) clauses.push('w.archived_at IS NULL');
  if (period.basis === 'CONFIRMED_AT') clauses.push('w.confirmed_at IS NOT NULL');
  if (required.workId) clauses.push(`w.id=${add(required.workId)}`);
  if (required.customerId) clauses.push(`w.customer_id=${add(required.customerId)}`);
  if (period.month) clauses.push(`strftime('%m',${period.column})=${add(period.month)}`);
  if (period.year) clauses.push(`strftime('%Y',${period.column})=${add(period.year)}`);
  const sql = `WITH eligible AS (
    SELECT w.id,w.customer_id,w.title,w.status,w.country,w.university,w.specialty_key,w.work_type_key,w.created_at,w.confirmed_at,w.archived_at,c.name AS customer_name,
      (SELECT json_group_array(amount_halalas) FROM price_movements WHERE work_id=w.id) AS price_amounts_json,
      (SELECT json_group_array(amount_halalas) FROM client_payments WHERE work_id=w.id) AS payment_amounts_json,
      (SELECT json_group_array(amount_halalas) FROM payment_reversals WHERE work_id=w.id) AS reversal_amounts_json
    FROM works w JOIN customers c ON c.id=w.customer_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
  )`;
  return { sql, values, period, includeArchived, add };
}
function s8AggregateRows(rows, dimension, bucketFor) {
  const buckets = new Map();
  for (const row of rows) {
    const bucket = bucketFor(row) || 'UNSPECIFIED'; let aggregate = buckets.get(bucket);
    if (!aggregate) { aggregate = { dimension, bucket, work_count: 0, active_work_count: 0, archived_work_count: 0, price_unset_work_count: 0, current_price_halalas: 0, approved_paid_halalas: 0, remaining_halalas: 0 }; buckets.set(bucket, aggregate); }
    aggregate.work_count += 1; aggregate.active_work_count += row.is_archived ? 0 : 1; aggregate.archived_work_count += row.is_archived ? 1 : 0; aggregate.price_unset_work_count += row.current_price_halalas === null ? 1 : 0;
    if (row.current_price_halalas !== null) aggregate.current_price_halalas = safeFinancialAdd(aggregate.current_price_halalas, row.current_price_halalas);
    aggregate.approved_paid_halalas = safeFinancialAdd(aggregate.approved_paid_halalas, row.approved_paid_halalas);
    if (row.remaining_halalas !== null) aggregate.remaining_halalas = safeFinancialAdd(aggregate.remaining_halalas, row.remaining_halalas);
  }
  return [...buckets.values()].sort((left, right) => left.bucket.localeCompare(right.bucket));
}
export async function getS8Analytics(env, input = {}) {
  const query = s8EligibleWorkSql(input); const rows = ((await env.DB.prepare(`${query.sql} SELECT * FROM eligible ORDER BY created_at ASC,id ASC`).bind(...query.values).all()).results || []).map(s8FinancialRow);
  const periodKey = query.period.basis === 'CONFIRMED_AT' ? row => row.confirmed_at?.slice(0, 7) : row => row.created_at.slice(0, 7);
  return {
    period_basis: query.period.basis, month: query.period.month, year: query.period.year, include_archived: query.includeArchived,
    financial_authority: 'S6_APPROVED_PRICE_MOVEMENTS_AND_S7_APPROVED_PAYMENTS_MINUS_REVERSALS',
    groups: { WORK_TYPE: s8AggregateRows(rows, 'WORK_TYPE', row => row.work_type_key), SPECIALTY: s8AggregateRows(rows, 'SPECIALTY', row => row.specialty_key), COUNTRY: s8AggregateRows(rows, 'COUNTRY', row => row.country), UNIVERSITY: s8AggregateRows(rows, 'UNIVERSITY', row => row.university), PERIOD: s8AggregateRows(rows, 'PERIOD', periodKey) },
  };
}
async function s8ExportWorks(env, input = {}, required = {}) {
  const query = s8EligibleWorkSql(input, required); const pageSize = s8ExportPageSize(input); const cursor = s8CursorDecode(input.cursor, 'created_at', 'S8_EXPORT_CURSOR_INVALID'); const after = cursor ? `(created_at>${query.add(cursor.created_at)} OR (created_at=${query.add(cursor.created_at)} AND id>${query.add(cursor.id)}))` : '1=1'; const readLimit = query.add(pageSize + 1);
  const rawRows = (await env.DB.prepare(`${query.sql} SELECT * FROM eligible WHERE ${after} ORDER BY created_at ASC,id ASC LIMIT ${readLimit}`).bind(...query.values).all()).results || [];
  const hasMore = rawRows.length > pageSize; const rows = rawRows.slice(0, pageSize).map(s8FinancialRow); const last = rows.at(-1);
  return { rows, page_size: pageSize, next_cursor: hasMore && last ? s8CursorEncode({ created_at: last.created_at, id: last.id }) : null, period: query.period, includeArchived: query.includeArchived };
}
function s8SnapshotRow(row) {
  if (!row) return null;
  const numeric = ['work_count','cumulative_work_count','total_work_value_halalas','person_1_work_share_halalas','person_2_work_share_halalas','approved_receipts_halalas','approved_receipts_person_1_halalas','approved_receipts_person_2_halalas','transfer_amount_halalas','transfer_fee_halalas','subscription_total_halalas','subscription_effect_person_1_halalas','subscription_effect_person_2_halalas','governed_expense_total_halalas','settlement_adjustment_person_1_halalas','settlement_adjustment_person_2_halalas','prior_balance_halalas','final_balance_halalas','version'];
  return { ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, numeric.includes(key) && value !== null ? Number(value) : value])), transfer_net_person_2_halalas: null, transfer_net_person_2_authority: 'UNAVAILABLE_NOT_PERSISTED_IN_SNAPSHOT' };
}
export async function getS8WorkExportDto(env, workId) {
  const result = await s8ExportWorks(env, { period_basis: 'CREATED_AT', include_archived: true, page_size: 1 }, { workId });
  if (!result.rows.length) throw new DomainError('WORK_NOT_FOUND', 404);
  const work = result.rows[0];
  const [titles, statuses, events, payments] = await Promise.all([
    env.DB.prepare('SELECT id,old_title,new_title,reason,changed_at,changed_by,request_id FROM work_title_history WHERE work_id=?1 ORDER BY changed_at ASC,id ASC').bind(workId).all(),
    env.DB.prepare('SELECT id,old_status,new_status,reason,changed_at,changed_by,request_id FROM work_status_history WHERE work_id=?1 ORDER BY changed_at ASC,id ASC').bind(workId).all(),
    env.DB.prepare('SELECT id,event_type,description,effective_at,created_at,actor_uid,request_id FROM work_events WHERE work_id=?1 ORDER BY effective_at ASC,id ASC').bind(workId).all(),
    env.DB.prepare(`SELECT p.id,p.amount_halalas,p.effective_at,p.payment_method,p.note,p.received_by,p.recorded_by,p.created_at,p.request_id,r.id AS reversal_id,r.amount_halalas AS reversal_amount_halalas,r.approved_at AS reversal_approved_at
      FROM client_payments p LEFT JOIN payment_reversals r ON r.payment_id=p.id WHERE p.work_id=?1 ORDER BY p.effective_at ASC,p.id ASC`).bind(workId).all(),
  ]);
  return {
    export_type: 'WORK', financial_authority: 'S6_APPROVED_PRICE_MOVEMENTS_AND_S7_APPROVED_PAYMENTS_MINUS_REVERSALS', work,
    title_history: titles.results || [], status_history: statuses.results || [], events: events.results || [],
    payments: (payments.results || []).map(row => ({ ...row, amount_halalas: Number(row.amount_halalas), reversal_amount_halalas: row.reversal_amount_halalas === null ? null : Number(row.reversal_amount_halalas) })),
  };
}
export async function getS8MonthExportDto(env, input = {}) {
  const result = await s8ExportWorks(env, input);
  if (!result.period.month || !result.period.year) throw new DomainError('S8_EXPORT_PERIOD_REQUIRED', 400);
  const periodKey = `${result.period.year}-${result.period.month}`;
  const snapshots = (await env.DB.prepare('SELECT * FROM settlement_snapshots WHERE period_key=?1 ORDER BY version ASC').bind(periodKey).all()).results || [];
  return {
    export_type: 'MONTH', period_key: periodKey, period_basis: result.period.basis, include_archived: result.includeArchived, page_size: result.page_size, next_cursor: result.next_cursor,
    financial_authority: 'S6_APPROVED_PRICE_MOVEMENTS_AND_S7_APPROVED_PAYMENTS_MINUS_REVERSALS', works: result.rows, settlement_snapshots: snapshots.map(s8SnapshotRow),
  };
}
export async function getS8FollowUpExportDto(env, input = {}) {
  const includeArchived = s8IncludeArchived(input.include_archived); const pageSize = s8ExportPageSize(input); const cursor = s8CursorDecode(input.cursor, 'effective_at', 'S8_FOLLOW_UP_CURSOR_INVALID'); const values = []; const add = value => { values.push(value); return `?${values.length}`; }; const clauses = [];
  if (!includeArchived) clauses.push('w.archived_at IS NULL');
  if (input.work_id) clauses.push(`e.work_id=${add(String(input.work_id))}`);
  if (input.from) clauses.push(`e.effective_at>=${add(canonicalEventTimestamp(input.from))}`);
  if (input.to) clauses.push(`e.effective_at<${add(canonicalEventTimestamp(input.to))}`);
  if (cursor) clauses.push(`(e.effective_at>${add(cursor.effective_at)} OR (e.effective_at=${add(cursor.effective_at)} AND e.id>${add(cursor.id)}))`);
  const readLimit = add(pageSize + 1);
  const rawRows = (await env.DB.prepare(`SELECT e.id,e.work_id,w.title AS work_title,c.name AS customer_name,e.event_type,e.description,e.effective_at,e.created_at,e.actor_uid,e.request_id,w.archived_at
    FROM work_events e JOIN works w ON w.id=e.work_id JOIN customers c ON c.id=w.customer_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY e.effective_at ASC,e.id ASC LIMIT ${readLimit}`).bind(...values).all()).results || [];
  const hasMore = rawRows.length > pageSize; const events = rawRows.slice(0, pageSize).map(row => ({ ...row, is_archived: Boolean(row.archived_at) })); const last = events.at(-1);
  return { export_type: 'FOLLOW_UP', include_archived: includeArchived, page_size: pageSize, next_cursor: hasMore && last ? s8CursorEncode({ effective_at: last.effective_at, id: last.id }) : null, events };
}
function s8CustomerTotals(rows) {
  return rows.reduce((acc, row) => ({ work_count: acc.work_count + 1, active_work_count: acc.active_work_count + (row.is_archived ? 0 : 1), archived_work_count: acc.archived_work_count + (row.is_archived ? 1 : 0), price_unset_work_count: acc.price_unset_work_count + (row.current_price_halalas === null ? 1 : 0), approved_paid_halalas: safeFinancialAdd(acc.approved_paid_halalas, row.approved_paid_halalas), remaining_halalas: row.remaining_halalas === null ? acc.remaining_halalas : safeFinancialAdd(acc.remaining_halalas, row.remaining_halalas) }), { work_count: 0, active_work_count: 0, archived_work_count: 0, price_unset_work_count: 0, approved_paid_halalas: 0, remaining_halalas: 0 });
}
export async function getS8CustomerExportDto(env, customerId, input = {}) {
  const customer = await env.DB.prepare('SELECT id,name,contact,country,university,specialty,status FROM customers WHERE id=?1').bind(customerId).first();
  if (!customer) throw new DomainError('CUSTOMER_NOT_FOUND', 404);
  const result = await s8ExportWorks(env, input, { customerId }); const totalsQuery = s8EligibleWorkSql(input, { customerId });
  const allRows = ((await env.DB.prepare(`${totalsQuery.sql} SELECT * FROM eligible ORDER BY created_at ASC,id ASC`).bind(...totalsQuery.values).all()).results || []).map(s8FinancialRow);
  const warningCursor = s8CursorDecode(input.warning_cursor, 'happened_at', 'S8_WARNING_CURSOR_INVALID'); const warningValues = [customerId]; const warningAdd = value => { warningValues.push(value); return `?${warningValues.length}`; }; const warningAfter = warningCursor ? `(happened_at>${warningAdd(warningCursor.happened_at)} OR (happened_at=${warningAdd(warningCursor.happened_at)} AND fact_id>${warningAdd(warningCursor.id)}))` : '1=1'; const warningReadLimit = warningAdd(result.page_size + 1);
  const rawWarnings = (await env.DB.prepare(`SELECT fact_id,work_id,warning_type,source_ref,happened_at,details_json FROM customer_warning_projection WHERE customer_id=?1 AND ${warningAfter} ORDER BY happened_at ASC,fact_id ASC LIMIT ${warningReadLimit}`).bind(...warningValues).all()).results || [];
  const hasMoreWarnings = rawWarnings.length > result.page_size; const warnings = rawWarnings.slice(0, result.page_size); const lastWarning = warnings.at(-1); const totals = s8CustomerTotals(allRows);
  return { export_type: 'CUSTOMER', customer, period_basis: result.period.basis, month: result.period.month, year: result.period.year, include_archived: result.includeArchived, page_size: result.page_size, next_cursor: result.next_cursor, warning_next_cursor: hasMoreWarnings && lastWarning ? s8CursorEncode({ happened_at: lastWarning.happened_at, id: lastWarning.fact_id }) : null, financial_authority: 'S6_APPROVED_PRICE_MOVEMENTS_AND_S7_APPROVED_PAYMENTS_MINUS_REVERSALS', totals, page_totals: totals, works: result.rows, warnings };
}
export async function getS8ClassificationExportDto(env, input = {}) {
  return { export_type: 'CLASSIFICATION', ...(await getS8Analytics(env, input)) };
}

export async function updateWork(env, actorUid, requestId, id, input) {
  await ensureActor(env, actorUid);
  const before = await getWorkRaw(env, id);
  assertWorkOperational(before);
  const nextConfirmedAt = input.confirmed_at === undefined ? (before.confirmed_at ?? null) : (input.confirmed_at === null ? null : canonicalEventTimestamp(input.confirmed_at));
  await prbEnsureWorkAffectedPeriods(env, before.confirmed_at ?? null, nextConfirmedAt);
  const version = positiveVersion(input.version);
  if (version !== before.version) throw new DomainError('VERSION_CONFLICT', 409);
  if (input.price_state !== undefined || input.price_minor_units !== undefined) throw new DomainError('PRICING_OUT_OF_SCOPE', 400);
  if (input.title !== undefined && input.title !== before.title) throw new DomainError('TITLE_CHANGE_OUT_OF_SCOPE', 400);
  const validated = await validateWorkInput(env, { ...input, customer_id: before.customer_id }, before);
  if (input.status !== undefined && input.status !== before.status) throw new DomainError('STATUS_CHANGE_OUT_OF_SCOPE', 400);
  const updatedAt = nowIso();
  const after = { ...before, parent_work_id: validated.parentWorkId, relationship_kind: validated.relationshipKind, title: validated.title, work_type_key: validated.workTypeKey, specialty_key: validated.specialtyKey, subject_or_course_code: validated.subject, country: validated.country, university: validated.university, status: validated.status, description: validated.description, quantity: validated.quantity, confirmed_at: nextConfirmedAt, updated_by: actorUid, updated_at: updatedAt, version: version + 1 };
  const mutation = env.DB.prepare(`UPDATE works SET parent_work_id=?1,relationship_kind=?2,title=?3,work_type_key=?4,specialty_key=?5,subject_or_course_code=?6,country=?7,university=?8,status=?9,description=?10,quantity=?11,confirmed_at=?12,updated_by=?13,updated_at=?14,version=version+1 WHERE id=?15 AND version=?16`).bind(after.parent_work_id, after.relationship_kind, after.title, after.work_type_key, after.specialty_key, after.subject_or_course_code, after.country, after.university, after.status, after.description, after.quantity, nextConfirmedAt, actorUid, updatedAt, id, version);
  const audit = auditStatement(env, 'work', id, 'UPDATE', actorUid, before, after, env.RUN_MARKER, requestId, updatedAt, true);
  let results;
  try {
    results = await executeBatch(env, [mutation, audit]);
  } catch (error) {
    if (!(error instanceof Error) || !/no such column: confirmed_at/.test(error.message)) throw error;
    const legacyMutation = env.DB.prepare(`UPDATE works SET parent_work_id=?1,relationship_kind=?2,title=?3,work_type_key=?4,specialty_key=?5,subject_or_course_code=?6,country=?7,university=?8,status=?9,description=?10,quantity=?11,updated_by=?12,updated_at=?13,version=version+1 WHERE id=?14 AND version=?15`).bind(after.parent_work_id, after.relationship_kind, after.title, after.work_type_key, after.specialty_key, after.subject_or_course_code, after.country, after.university, after.status, after.description, after.quantity, actorUid, updatedAt, id, version);
    results = await executeBatch(env, [legacyMutation, audit]);
  }
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
  const label = requiredString(input.label, 'CATALOG_LABEL_REQUIRED');
  const valueKey = input.value_key === undefined ? `custom_${crypto.randomUUID()}` : requiredString(input.value_key, 'CATALOG_VALUE_REQUIRED');
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
    const forceCertificateRefresh = request.headers.get('x-s3-force-certificate-refresh') === 'true';
    if (forceCertificateRefresh && (env.TEST_CONTROLS !== 'enabled' || !env.TEST_RESET_NONCE || request.headers.get('x-s3-test-reset') !== env.TEST_RESET_NONCE)) throw new DomainError('TEST_CONTROL_DENIED', 403);
    const verified = await verifyJwt(auth.slice(7), env, forceCertificateRefresh);
    const user = await allowed(env, verified.claims.sub);
    if (!user) throw new DomainError('UID_NOT_ALLOWED', 403);
    const authValidSince = Number(user.auth_valid_since || 0);
    if (authValidSince > 0 && Number(verified.claims.iat || 0) <= authValidSince) throw new DomainError('TOKEN_REVOKED', 401);
    const requestedRunId = request.headers.get('x-s3-run-id') || '';
    const runId = requestedRunId === env.RUN_MARKER ? requestedRunId : '';
    const cacheState = verified.cacheState;
    const s3Correlation = { runId, requestId, scenario };
    console.log({ event: 'auth_result', requestId, code: 'ALLOW', cacheState, allowed: true, runId, scenario, s3Correlation, uidHash: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verified.claims.sub)).then(x => Array.from(new Uint8Array(x)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')) });
    return { user, cacheState };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(error instanceof Error ? error.message : 'AUTH_FAILED', 401);
  }
}

export async function listActiveParticipants(env) {
  const rows = (await env.DB.prepare(`SELECT uid,role FROM app_users WHERE active=1 AND role IN ('person_1','person_2') ORDER BY CASE role WHEN 'person_1' THEN 1 ELSE 2 END,uid ASC`).all()).results || [];
  return rows.map(row => ({ uid: row.uid, role: row.role }));
}

async function requireAccountAdmin(env, actorUid) {
  const actor = await ensureActor(env, actorUid);
  if (actor.role !== 'person_1') throw new DomainError('ACCOUNT_ADMIN_FORBIDDEN', 403);
  return actor;
}
function accountDisplayName(role) {
  return role === 'person_1' ? 'خالد' : role === 'person_2' ? 'وليد' : 'مستخدم';
}
async function accountAdminTarget(env, role) {
  if (role !== 'person_1' && role !== 'person_2') throw new DomainError('ACCOUNT_TARGET_NOT_FOUND', 404);
  const target = await env.DB.prepare("SELECT uid,role,active,auth_valid_since FROM app_users WHERE role=?1 AND active=1").bind(role).first();
  if (!target) throw new DomainError('ACCOUNT_TARGET_NOT_FOUND', 404);
  return target;
}
function b64urlEncodeBytes(bytes) {
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlEncodeJson(value) { return b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify(value))); }
function privateKeyPemToDer(pem) {
  const normalized = pem.replace(/\\n/g, '\n');
  const body = normalized.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  if (!body) throw new DomainError('ACCOUNT_ADMIN_NOT_CONFIGURED', 503);
  const raw = atob(body); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
let firebaseAdminTokenCache = null;
async function firebaseAdminAccessToken(env) {
  if (env.TEST_CONTROLS === 'enabled' && typeof env.FIREBASE_ADMIN_ACCESS_TOKEN === 'string' && env.FIREBASE_ADMIN_ACCESS_TOKEN.trim()) return env.FIREBASE_ADMIN_ACCESS_TOKEN.trim();
  const clientEmail = requiredString(env.FIREBASE_SERVICE_ACCOUNT_CLIENT_EMAIL, 'ACCOUNT_ADMIN_NOT_CONFIGURED');
  const privateKey = requiredString(env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY, 'ACCOUNT_ADMIN_NOT_CONFIGURED');
  const now = Math.floor(Date.now() / 1000);
  if (firebaseAdminTokenCache?.clientEmail === clientEmail && firebaseAdminTokenCache.expiresAt > now + 60) return firebaseAdminTokenCache.accessToken;
  const header = b64urlEncodeJson({ alg: 'RS256', typ: 'JWT' });
  const claim = b64urlEncodeJson({ iss: clientEmail, scope: 'https://www.googleapis.com/auth/identitytoolkit', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const unsigned = new TextEncoder().encode(`${header}.${claim}`);
  let key;
  try { key = await crypto.subtle.importKey('pkcs8', privateKeyPemToDer(privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']); }
  catch { throw new DomainError('ACCOUNT_ADMIN_NOT_CONFIGURED', 503); }
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, unsigned));
  const assertion = `${header}.${claim}.${b64urlEncodeBytes(signature)}`;
  let response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  } catch { throw new DomainError('ACCOUNT_PROVIDER_UNAVAILABLE', 503); }
  if (!response.ok) throw new DomainError('ACCOUNT_PROVIDER_REJECTED', 502);
  const payload = await response.json();
  if (typeof payload?.access_token !== 'string' || !payload.access_token) throw new DomainError('ACCOUNT_PROVIDER_REJECTED', 502);
  const expiresIn = Number(payload.expires_in || 3600);
  firebaseAdminTokenCache = { clientEmail, accessToken: payload.access_token, expiresAt: now + (Number.isFinite(expiresIn) ? expiresIn : 3600) };
  return payload.access_token;
}
async function firebaseAdminIdentityRequest(env, operation, body) {
  const projectId = requiredString(env.FIREBASE_PROJECT_ID, 'ACCOUNT_ADMIN_NOT_CONFIGURED');
  const token = await firebaseAdminAccessToken(env);
  let response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new DomainError('ACCOUNT_PROVIDER_UNAVAILABLE', 503); }
  if (!response.ok) throw new DomainError('ACCOUNT_PROVIDER_REJECTED', 502);
  return response.json();
}
async function firebaseAdminLookupUser(env, uid) {
  const payload = await firebaseAdminIdentityRequest(env, 'accounts:lookup', { localId: [uid] });
  const user = Array.isArray(payload?.users) ? payload.users.find(item => item?.localId === uid) : null;
  if (!user) throw new DomainError('ACCOUNT_TARGET_NOT_FOUND', 404);
  return { uid, email: typeof user.email === 'string' ? user.email : '', disabled: Boolean(user.disabled) };
}
function accountAdminAuditStatement(env, actorUid, targetUid, action, before, after, requestId, createdAt = nowIso()) {
  const id = newId('account-audit');
  return {
    record: { id, actor_uid: actorUid, target_uid: targetUid, action, created_at: createdAt, before, after, request_id: requestId },
    statement: env.DB.prepare(`INSERT INTO account_admin_audit(id,actor_uid,target_uid,action,created_at,before_json,after_json,request_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`).bind(id, actorUid, targetUid, action, createdAt, before === null ? null : JSON.stringify(before), JSON.stringify(after), requestId),
  };
}
export async function listAccountAdminAccounts(env, actorUid) {
  await requireAccountAdmin(env, actorUid);
  const targets = (await env.DB.prepare("SELECT uid,role,active FROM app_users WHERE active=1 AND role IN ('person_1','person_2') ORDER BY CASE role WHEN 'person_1' THEN 1 ELSE 2 END").all()).results || [];
  return Promise.all(targets.map(async target => {
    const provider = await firebaseAdminLookupUser(env, target.uid);
    return { role: target.role, display_name: accountDisplayName(target.role), email: provider.email, active: Boolean(target.active), disabled: provider.disabled };
  }));
}
export async function changeAccountEmail(env, actorUid, requestId, role, input) {
  await requireAccountAdmin(env, actorUid);
  const target = await accountAdminTarget(env, role);
  const providerBefore = await firebaseAdminLookupUser(env, target.uid);
  const email = requiredString(input.email, 'ACCOUNT_EMAIL_REQUIRED');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError('ACCOUNT_EMAIL_INVALID', 400);
  if (providerBefore.email.toLowerCase() === email.toLowerCase()) throw new DomainError('ACCOUNT_EMAIL_UNCHANGED', 400);
  const validSince = Math.floor(Date.now() / 1000);
  await firebaseAdminIdentityRequest(env, 'accounts:update', { localId: target.uid, email, emailVerified: false, validSince: String(validSince) });
  const before = { role: target.role, display_name: accountDisplayName(target.role), email: providerBefore.email, active: true, disabled: providerBefore.disabled };
  const after = { role: target.role, display_name: accountDisplayName(target.role), email, active: true, disabled: providerBefore.disabled, sessions_revoked: true };
  const audit = accountAdminAuditStatement(env, actorUid, target.uid, 'CHANGE_EMAIL', before, after, requestId);
  const updateSessionCutoff = env.DB.prepare('UPDATE app_users SET auth_valid_since=?1 WHERE uid=?2 AND role=?3 AND active=1').bind(validSince, target.uid, target.role);
  const results = await executeBatch(env, [updateSessionCutoff, audit.statement]);
  if (Number(results[0]?.meta?.changes) !== 1 || Number(results[1]?.meta?.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return { role: target.role, display_name: accountDisplayName(target.role), email, sessions_revoked: true, audit: audit.record };
}
export async function sendAccountPasswordReset(env, actorUid, requestId, role) {
  await requireAccountAdmin(env, actorUid);
  const target = await accountAdminTarget(env, role);
  const provider = await firebaseAdminLookupUser(env, target.uid);
  if (!provider.email) throw new DomainError('ACCOUNT_EMAIL_REQUIRED', 409);
  await firebaseAdminIdentityRequest(env, 'accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email: provider.email });
  const before = { role: target.role, display_name: accountDisplayName(target.role), email: provider.email, active: true, disabled: provider.disabled };
  const after = { ...before, password_reset_sent: true };
  const audit = accountAdminAuditStatement(env, actorUid, target.uid, 'SEND_PASSWORD_RESET', before, after, requestId);
  const results = await executeBatch(env, [audit.statement]);
  if (Number(results[0]?.meta?.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return { role: target.role, display_name: accountDisplayName(target.role), email: provider.email, password_reset_sent: true, audit: audit.record };
}
export function uatResetPolicy(env) {
  return { allowed: env?.APP_ENVIRONMENT === 'uat' && env?.ALLOW_UAT_RESET === 'true' && typeof env?.UAT_RESET_NONCE === 'string' && env.UAT_RESET_NONCE.length >= 16, destructive: false };
}

function auditReadLimit(url) {
  const raw = url.searchParams.get('limit');
  if (raw === null) return 50;
  if (!/^\d+$/.test(raw)) throw new DomainError('AUDIT_LIMIT_INVALID', 400);
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new DomainError('AUDIT_LIMIT_INVALID', 400);
  return Math.min(limit, 100);
}

export async function listAuditLog(env, url) {
  const limit = auditReadLimit(url);
  const rows = (await env.DB.prepare(`
    SELECT a.id, a.entity_type, a.entity_id, a.action, a.actor_uid, u.role AS actor_role,
           a.created_at, a.before_json, a.after_json
    FROM audit_log AS a
    LEFT JOIN app_users AS u ON u.uid = a.actor_uid
    ORDER BY a.id DESC
    LIMIT ?1
  `).bind(limit).all()).results || [];
  return rows.map(row => ({
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    actor_uid: row.actor_uid,
    actor_role: row.actor_role || null,
    created_at: row.created_at,
    before: row.before_json === null ? null : JSON.parse(row.before_json),
    after: JSON.parse(row.after_json),
  }));
}

export async function handleApi(request, env, requestId, scenario, user) {
  const url = new URL(request.url); const parts = url.pathname.split('/').filter(Boolean);
  const method = request.method.toUpperCase(); const body = method === 'POST' || method === 'PATCH' ? await parseRequestJson(request) : {};
  if (parts[1] === 'account-admin' && parts[2] === 'accounts') {
    if (parts.length === 3 && method === 'GET') return Response.json({ ok: true, data: await listAccountAdminAccounts(env, user.uid), requestId });
    if (parts.length === 5 && parts[4] === 'email' && method === 'POST') return Response.json({ ok: true, data: await changeAccountEmail(env, user.uid, requestId, decodeURIComponent(parts[3]), body), requestId });
    if (parts.length === 5 && parts[4] === 'password-reset' && method === 'POST') return Response.json({ ok: true, data: await sendAccountPasswordReset(env, user.uid, requestId, decodeURIComponent(parts[3])), requestId });
  }
  if (parts[1] === 'audit' && parts.length === 2) {
    if (method !== 'GET') throw new DomainError('METHOD_NOT_ALLOWED', 405);
    return Response.json({ ok: true, data: await listAuditLog(env, url), requestId });
  }
  if (parts[1] === 'participants' && parts.length === 2 && method === 'GET') return Response.json({ ok: true, data: await listActiveParticipants(env), requestId });
  if (parts[1] === 'search' && parts[2] === 'works' && parts.length === 3 && method === 'GET') return Response.json({ ok: true, data: await searchWorksS8(env, Object.fromEntries(url.searchParams.entries())), requestId });
  if (parts[1] === 'alerts' && parts.length === 2) {
    if (method === 'GET') return Response.json({ ok: true, data: await getS8Alerts(env, Object.fromEntries(url.searchParams.entries())), requestId });
  }
  if (parts[1] === 'alerts' && parts[2] === 'settings' && parts.length === 3) {
    if (method === 'GET') return Response.json({ ok: true, data: await listS8AlertSettings(env), requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await upsertS8AlertSetting(env, user.uid, requestId, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'analytics' && parts.length === 2 && method === 'GET') return Response.json({ ok: true, data: await getS8Analytics(env, Object.fromEntries(url.searchParams.entries())), requestId });
  if (parts[1] === 'exports' && method === 'GET') {
    const query = Object.fromEntries(url.searchParams.entries());
    if (parts.length === 4 && parts[2] === 'work') return Response.json({ ok: true, data: await getS8WorkExportDto(env, decodeURIComponent(parts[3])), requestId });
    if (parts.length === 3 && parts[2] === 'month') return Response.json({ ok: true, data: await getS8MonthExportDto(env, query), requestId });
    if (parts.length === 3 && parts[2] === 'follow-up') return Response.json({ ok: true, data: await getS8FollowUpExportDto(env, query), requestId });
    if (parts.length === 4 && parts[2] === 'customer') return Response.json({ ok: true, data: await getS8CustomerExportDto(env, decodeURIComponent(parts[3]), query), requestId });
    if (parts.length === 3 && parts[2] === 'classification') return Response.json({ ok: true, data: await getS8ClassificationExportDto(env, query), requestId });
  }
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
  if (parts[1] === 'transfers' && parts.length === 2) {
    if (method === 'GET') return Response.json({ ok: true, data: await listInterPartyTransfers(env, Object.fromEntries(url.searchParams.entries())), requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await createInterPartyTransfer(env, user.uid, requestId, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'subscriptions' && parts.length === 2) {
    if (method === 'GET') return Response.json({ ok: true, data: await listSubscriptionHistory(env), requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await createSubscriptionHistory(env, user.uid, requestId, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'expenses' && parts.length === 2) {
    if (method === 'GET') return Response.json({ ok: true, data: await listCommonExpenses(env), requestId });
    if (method === 'POST') return Response.json({ ok: true, data: await createCommonExpense(env, user.uid, requestId, body), requestId }, { status: 201 });
  }
  if (parts[1] === 'settlements') {
    if (parts.length === 2 && method === 'GET') return Response.json({ ok: true, data: await listSettlementSnapshots(env, url.searchParams.get('period_key') || ''), requestId });
    if (parts.length === 3 && parts[2] === 'preview' && method === 'GET') return Response.json({ ok: true, data: await getSettlementPreview(env, url.searchParams.get('period_key') || '', Object.fromEntries(url.searchParams.entries())), requestId });
    if (parts.length === 4 && parts[3] === 'close' && method === 'POST') return Response.json({ ok: true, data: await closeSettlement(env, user.uid, requestId, decodeURIComponent(parts[2]), body), requestId }, { status: 201 });
    if (parts.length === 4 && parts[3] === 'reopen-requests') {
      if (method === 'GET') return Response.json({ ok: true, data: await listSettlementReopenRequests(env, decodeURIComponent(parts[2])), requestId });
      if (method === 'POST') return Response.json({ ok: true, data: await createSettlementReopenRequest(env, user.uid, requestId, decodeURIComponent(parts[2]), body), requestId }, { status: 201 });
    }
    if (parts.length === 6 && parts[3] === 'reopen-requests' && parts[5] === 'approve' && method === 'POST') return Response.json({ ok: true, data: await approveSettlementReopenRequest(env, user.uid, requestId, decodeURIComponent(parts[2]), decodeURIComponent(parts[4])), requestId });
  }
  if (parts[1] === 'works' && parts.length >= 3) {
    const workId = decodeURIComponent(parts[2]);
    if (parts[3] === 'similar' && method === 'GET') return Response.json({ ok: true, data: await getSimilarWorks(env, workId), requestId });
    if (parts[3] === 'financials' && method === 'GET') return Response.json({ ok: true, data: await getWorkFinancials(env, workId), requestId });
    if (parts[3] === 'payments') {
      if (parts.length === 4 && method === 'GET') return Response.json({ ok: true, data: await listClientPayments(env, workId), requestId });
      if (parts.length === 4 && method === 'POST') return Response.json({ ok: true, data: await createClientPayment(env, user.uid, requestId, workId, body), requestId }, { status: 201 });
    }
    if (parts[3] === 'payment-reversal-requests') {
      if (parts.length === 4 && method === 'GET') return Response.json({ ok: true, data: await listPaymentReversalRequests(env, workId), requestId });
      if (parts.length === 4 && method === 'POST') return Response.json({ ok: true, data: await createPaymentReversalRequest(env, user.uid, requestId, workId, body), requestId }, { status: 201 });
      if (parts.length === 6 && parts[5] === 'approve' && method === 'POST') {
        const reversalRequestId = decodeURIComponent(parts[4]);
        return Response.json({ ok: true, data: await approvePaymentReversalRequest(env, user.uid, requestId, workId, reversalRequestId), requestId });
      }
    }
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
  const work = await getWorkRaw(env, workId);
  assertWorkOperational(work);
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
  assertWorkOperational(before);
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
  assertWorkOperational(before);
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
  if (requestRow.action === 'CANCEL' && isCancelledWorkStatus(beforeWork.status)) throw new DomainError('CANCELLED_WORK_OPERATION_FORBIDDEN', 409);
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

  const adjustment = requestRow.action === 'CANCEL' ? await prbPrepareCancellationAdjustment(env, beforeWork, reqId, actorUid, approvedAt, requestId) : null;
  const statements = [workMutation, requestMutation, historyMutation, archiveHistoryMutation, auditRequest, auditWork];
  if (adjustment) statements.push(adjustment.statement);
  const results = await executeBatch(env, statements);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1 || (requestRow.action === 'CANCEL' && Number(results[2]?.meta?.changes) !== 1) || (requestRow.action === 'ARCHIVE' && Number(results[3]?.meta?.changes) !== 1) || (adjustment && Number(results[6]?.meta?.changes) !== 1)) {
    throw new DomainError('TRANSACTION_FAILED', 409);
  }
  return { request: afterRequest, work: workReadModel(afterWork), settlement_adjustment: adjustment?.record || null };
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

function servePublicAppConfig(env) {
  const firebaseConfig = {
    apiKey: env.FIREBASE_API_KEY || "",
    authDomain: env.FIREBASE_AUTH_DOMAIN || "",
    projectId: env.FIREBASE_PROJECT_ID || "",
    appId: env.FIREBASE_APP_ID || ""
  };
  const configured = Object.values(firebaseConfig).every((value) => typeof value === "string" && value.length > 0);
  const publicConfig = configured ? { apiBaseUrl: "", firebaseConfig } : { apiBaseUrl: "" };
  return new Response(`window.__PRIVATE_WORK_APP_CONFIG__ = Object.freeze(${JSON.stringify(publicConfig)});`, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export default {
  async fetch(request, env) {
    const requestId = request.headers.get('x-s3-request-id') || crypto.randomUUID();
    const scenario = request.headers.get('x-s3-scenario') || '';
    const requestedRunId = request.headers.get('x-s3-run-id') || '';
    const runId = requestedRunId === env.RUN_MARKER ? requestedRunId : '';
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/app-config.js") return servePublicAppConfig(env);
    const isStaticAssetRequest = request.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'));
    if (isStaticAssetRequest) {
      const staticResponse = await serveStaticAsset(request, env);
      if (staticResponse) return staticResponse;
    }
    if (url.pathname === '/__test/reset-cache') {
      if (env.TEST_CONTROLS !== 'enabled') return reject(404, 'NOT_FOUND', requestId, 'none', env.RUN_MARKER, scenario);
      if (!env.TEST_RESET_NONCE || request.headers.get('x-s3-test-reset') !== env.TEST_RESET_NONCE) return reject(403, 'TEST_CONTROL_DENIED', requestId, 'none', env.RUN_MARKER, scenario);
      await clearCertificateCache(env);
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
const DEFAULT_PERSON_1_BPS = 7000;
const DEFAULT_PERSON_2_BPS = 3000;
const PRICE_MOVEMENT_TYPES = Object.freeze(['BASE', 'INCREASE', 'DECREASE', 'DISCOUNT']);

function isCancelledWorkStatus(status) {
  return status === 'CANCELLED_BEFORE_EXECUTION' || status === 'PARTIALLY_STOPPED';
}

function assertWorkOperational(work) {
  if (isCancelledWorkStatus(work?.status)) throw new DomainError('CANCELLED_WORK_OPERATION_FORBIDDEN', 409);
}

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

const PAYMENT_METHOD_MAX_LENGTH = 64;

function validatePaymentMethod(value) {
  const method = requiredString(value, 'PAYMENT_METHOD_REQUIRED');
  if (method.length > PAYMENT_METHOD_MAX_LENGTH) throw new DomainError('PAYMENT_METHOD_INVALID', 400);
  return method;
}

function paymentCollectionStatus(currentPriceHalalas, approvedPaidTotalHalalas, workStatus = null) {
  if (workStatus === 'CANCELLED_BEFORE_EXECUTION') return 'CANCELLED_ZERO_BALANCE';
  if (currentPriceHalalas === null) return 'PRICE_UNSET';
  if (approvedPaidTotalHalalas > currentPriceHalalas) return 'OVERPAYMENT_UNRESOLVED';
  if (currentPriceHalalas === 0 || approvedPaidTotalHalalas === currentPriceHalalas) return 'FINANCIALLY_CLOSED';
  if (approvedPaidTotalHalalas === 0) return 'UNPAID';
  return 'PARTIALLY_COLLECTED';
}

async function listPaymentRowsRaw(env, workId) {
  const rows = (await env.DB.prepare(`SELECT
      p.id, p.work_id, p.amount_halalas, p.effective_at, p.payment_method, p.note,
      p.received_by, p.recorded_by, p.created_at, p.work_version, p.request_id,
      rr.id AS reversal_request_id, rr.reason AS reversal_reason,
      rr.requested_by AS reversal_requested_by, rr.requested_at AS reversal_requested_at,
      rr.state AS reversal_request_state, rr.approved_by AS reversal_approved_by,
      rr.approved_at AS reversal_approved_at, rr.approval_request_id AS reversal_approval_request_id,
      r.id AS reversal_id, r.amount_halalas AS reversal_amount_halalas,
      r.approved_at AS reversal_recorded_at, r.request_id AS reversal_request_id_final
    FROM client_payments p
    LEFT JOIN payment_reversal_requests rr ON rr.payment_id = p.id
    LEFT JOIN payment_reversals r ON r.payment_id = p.id
    WHERE p.work_id = ?1
    ORDER BY p.effective_at ASC, p.id ASC`).bind(workId).all()).results || [];
  return rows.map(row => ({
    ...row,
    reversal_state: row.reversal_id ? 'APPROVED' : (row.reversal_request_id ? 'PENDING' : null),
    reversal_amount_halalas: row.reversal_id ? Number(row.reversal_amount_halalas) : null,
  }));
}

function paymentTotals(rows) {
  let gross = 0;
  let reversed = 0;
  for (const row of rows) {
    gross = safeFinancialAdd(gross, safeFinancialInteger(Number(row.amount_halalas)));
    if (row.reversal_state === 'APPROVED') reversed = safeFinancialAdd(reversed, safeFinancialInteger(Number(row.reversal_amount_halalas)));
  }
  return { gross, reversed, approvedPaid: safeFinancialAdd(gross, -reversed) };
}

function paymentReadModel(row) {
  return {
    id: row.id,
    work_id: row.work_id,
    amount_halalas: Number(row.amount_halalas),
    effective_at: row.effective_at,
    payment_method: row.payment_method,
    note: row.note,
    received_by: row.received_by,
    recorded_by: row.recorded_by,
    created_at: row.created_at,
    work_version: Number(row.work_version),
    request_id: row.request_id,
    reversal_state: row.reversal_state,
    reversal_request_id: row.reversal_request_id,
    reversal_reason: row.reversal_reason,
    reversal_requested_by: row.reversal_requested_by,
    reversal_requested_at: row.reversal_requested_at,
    reversal_approved_by: row.reversal_approved_by,
    reversal_approved_at: row.reversal_approved_at,
    reversal_approval_request_id: row.reversal_approval_request_id,
    reversal_id: row.reversal_id,
    reversal_amount_halalas: row.reversal_amount_halalas,
    reversal_recorded_at: row.reversal_recorded_at,
    reversal_request_id_final: row.reversal_request_id_final,
  };
}

export async function listClientPayments(env, workId) {
  await getWorkRaw(env, workId);
  return (await listPaymentRowsRaw(env, workId)).map(paymentReadModel);
}

export async function createClientPayment(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const existing = await env.DB.prepare('SELECT * FROM client_payments WHERE request_id=?1').bind(requestId).first();
  if (existing) {
    if (existing.work_id !== workId) throw new DomainError('REQUEST_ID_REUSE', 409);
    return { payment: paymentReadModel(existing), financials: await getWorkFinancials(env, workId), idempotent_replay: true };
  }
  const beforeWork = await getWorkRaw(env, workId);
  assertWorkOperational(beforeWork);
  const version = positiveVersion(input.version);
  if (version !== beforeWork.version) throw new DomainError('VERSION_CONFLICT', 409);
  const amountHalalas = parseMoneyHalalas(input.amount_riyals);
  if (amountHalalas <= 0) throw new DomainError('PAYMENT_AMOUNT_INVALID', 400);
  const effectiveAt = canonicalEventTimestamp(input.effective_at);
  await prbEnsurePeriodOpen(env, effectiveAt);
  const paymentMethod = validatePaymentMethod(input.payment_method);
  const note = optionalString(input.note, 'PAYMENT_NOTE_INVALID');
  const receivedBy = input.received_by === undefined ? actorUid : requiredString(input.received_by, 'RECEIVED_BY_REQUIRED');
  await ensureActor(env, receivedBy);
  const currentPrice = sumApprovedPriceMovements(await listApprovedPriceMovementsRaw(env, workId));
  if (currentPrice === null) throw new DomainError('PRICE_UNSET_PAYMENT_FORBIDDEN', 409);
  const totals = paymentTotals(await listPaymentRowsRaw(env, workId));
  const nextApprovedPaid = safeFinancialAdd(totals.approvedPaid, amountHalalas);
  if (nextApprovedPaid > currentPrice) throw new DomainError('S7_OVERPAYMENT_POLICY_UNRESOLVED', 409);
  const id = newId('payment');
  const createdAt = nowIso();
  const after = { id, work_id: workId, amount_halalas: amountHalalas, effective_at: effectiveAt, payment_method: paymentMethod, note, received_by: receivedBy, recorded_by: actorUid, created_at: createdAt, work_version: version, request_id: requestId };
  const workMutation = env.DB.prepare(`UPDATE works SET version=version+1, updated_by=?1, updated_at=?2
    WHERE id=?3 AND version=?4`).bind(actorUid, createdAt, workId, version);
  const paymentMutation = env.DB.prepare(`INSERT INTO client_payments(id,work_id,amount_halalas,effective_at,payment_method,note,received_by,recorded_by,created_at,work_version,request_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
    WHERE EXISTS (SELECT 1 FROM works WHERE id=?12 AND version=?13 AND updated_by=?14 AND updated_at=?15)`)
    .bind(id, workId, amountHalalas, effectiveAt, paymentMethod, note, receivedBy, actorUid, createdAt, version, requestId, workId, version + 1, actorUid, createdAt);
  const audit = auditStatementWhen(env, 'client_payment', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, `${requestId}:payment`, createdAt,
    'EXISTS (SELECT 1 FROM client_payments WHERE id=?10 AND request_id=?11) AND EXISTS (SELECT 1 FROM works WHERE id=?12 AND version=?13 AND updated_by=?14 AND updated_at=?15)',
    [id, requestId, workId, version + 1, actorUid, createdAt]);
  const results = await executeBatch(env, [workMutation, paymentMutation, audit]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1 || !results[2]?.meta || Number(results[2].meta.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return { payment: after, financials: await getWorkFinancials(env, workId), idempotent_replay: false };
}

export async function getWorkFinancials(env, workId) {
  const work = await getWorkRaw(env, workId);
  const [movements, priceRequests, ratioRequests, ratioHistory, paymentRows] = await Promise.all([
    listApprovedPriceMovementsRaw(env, workId),
    listPriceChangeRequestsRaw(env, workId),
    listRatioChangeRequestsRaw(env, workId),
    listRatioHistoryRaw(env, workId),
    listPaymentRowsRaw(env, workId),
  ]);
  const currentPriceHalalas = sumApprovedPriceMovements(movements);
  const ratio = await currentRatio(env, workId);
  const totals = paymentTotals(paymentRows);
  const hasS7Payments = paymentRows.length > 0;
  const cancelled = isCancelledWorkStatus(work.status);
  const cancelledBeforeExecution = work.status === 'CANCELLED_BEFORE_EXECUTION';
  const shareBasisHalalas = cancelled ? totals.approvedPaid : currentPriceHalalas;
  const person1Share = calculateShareHalalas(shareBasisHalalas, ratio.person_1_bps);
  const person2Share = calculateShareHalalas(shareBasisHalalas, ratio.person_2_bps);
  const remainingHalalas = cancelledBeforeExecution ? 0 : currentPriceHalalas === null ? null : safeFinancialAdd(currentPriceHalalas, -totals.approvedPaid);
  return {
    work_id: workId,
    price_state: currentPriceHalalas === null ? 'PRICE_UNSET' : 'PRICE_APPROVED',
    current_price_halalas: currentPriceHalalas,
    ratio,
    shares: { person_1_halalas: person1Share, person_2_halalas: person2Share },
    approved_payments_total_halalas: totals.approvedPaid,
    remaining_halalas: remainingHalalas,
    customer_remaining_halalas: remainingHalalas,
    internal_share_basis_halalas: shareBasisHalalas,
    internal_share_basis: cancelled ? 'NET_APPROVED_RECEIPTS_AFTER_REVERSALS' : 'CURRENT_APPROVED_PRICE',
    collection_status: paymentCollectionStatus(currentPriceHalalas, totals.approvedPaid, work.status),
    remaining_projection: hasS7Payments ? 'S7_APPROVED_PAYMENTS_LEDGER' : 'PRE_S7_APPROVED_PAYMENTS_ZERO',
    payments: paymentRows.map(paymentReadModel),
    payment_totals: { gross_paid_halalas: totals.gross, reversed_paid_halalas: totals.reversed, approved_paid_halalas: totals.approvedPaid },
    movements,
    price_requests: priceRequests.map(row => row.state === 'PENDING' && (cancelled || Number(row.work_version) !== Number(work.version)) ? { ...row, state: 'SUPERSEDED' } : row),
    ratio_requests: cancelled ? ratioRequests.map(row => row.state === 'PENDING' ? { ...row, state: 'SUPERSEDED' } : row) : ratioRequests,
    ratio_history: ratioHistory,
  };
}

export async function listPaymentReversalRequests(env, workId) {
  await getWorkRaw(env, workId);
  const rows = (await env.DB.prepare(`SELECT rr.id, rr.payment_id, rr.work_id, rr.reason, rr.requested_by, rr.requested_at,
      rr.work_version, rr.state, rr.approved_by, rr.approved_at, rr.approval_request_id, rr.request_id,
      p.amount_halalas, p.effective_at, r.id AS reversal_id, r.amount_halalas AS reversal_amount_halalas
    FROM payment_reversal_requests rr
    JOIN client_payments p ON p.id = rr.payment_id
    LEFT JOIN payment_reversals r ON r.reversal_request_id = rr.id
    WHERE rr.work_id=?1 ORDER BY rr.requested_at ASC, rr.id ASC`).bind(workId).all()).results || [];
  return rows.map(row => ({ ...row, amount_halalas: Number(row.amount_halalas), reversal_amount_halalas: row.reversal_amount_halalas === null ? null : Number(row.reversal_amount_halalas) }));
}

export async function createPaymentReversalRequest(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const beforeWork = await getWorkRaw(env, workId);
  const version = positiveVersion(input.version);
  if (version !== beforeWork.version) throw new DomainError('VERSION_CONFLICT', 409);
  const paymentId = requiredString(input.payment_id, 'PAYMENT_ID_REQUIRED');
  const payment = await env.DB.prepare('SELECT * FROM client_payments WHERE id=?1').bind(paymentId).first();
  if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 404);
  if (payment.work_id !== workId) throw new DomainError('PAYMENT_WORK_MISMATCH', 404);
  if (!isCancelledWorkStatus(beforeWork.status)) await prbEnsurePeriodOpen(env, payment.effective_at);
  const existing = await env.DB.prepare('SELECT state FROM payment_reversal_requests WHERE payment_id=?1 ORDER BY requested_at DESC,id DESC LIMIT 1').bind(paymentId).first();
  if (existing?.state === 'PENDING') throw new DomainError('REVERSAL_ALREADY_PENDING', 409);
  if (existing?.state === 'APPROVED') throw new DomainError('REVERSAL_ALREADY_APPROVED', 409);
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  const id = newId('payment_reversal_req');
  const requestedAt = nowIso();
  const after = { id, payment_id: paymentId, work_id: workId, reason, requested_by: actorUid, requested_at: requestedAt, work_version: version, state: 'PENDING', approved_by: null, approved_at: null, approval_request_id: null, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO payment_reversal_requests(id,payment_id,work_id,reason,requested_by,requested_at,work_version,state,request_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'PENDING',?8)`).bind(id, paymentId, workId, reason, actorUid, requestedAt, version, requestId);
  const audit = auditStatement(env, 'payment_reversal_request', id, 'CREATE', actorUid, null, after, env.RUN_MARKER, `${requestId}:reversal_request`, requestedAt);
  const results = await executeBatch(env, [mutation, audit]);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return after;
}

export async function approvePaymentReversalRequest(env, actorUid, requestId, workId, requestIdToApprove) {
  await ensureActor(env, actorUid);
  const requestRow = await env.DB.prepare('SELECT * FROM payment_reversal_requests WHERE id=?1').bind(requestIdToApprove).first();
  if (!requestRow) throw new DomainError('REVERSAL_REQUEST_NOT_FOUND', 404);
  if (requestRow.work_id !== workId) throw new DomainError('REQUEST_WORK_MISMATCH', 404);
  if (requestRow.state !== 'PENDING') throw new DomainError('ALREADY_FINALIZED', 400);
  if (requestRow.requested_by === actorUid) throw new DomainError('SELF_APPROVAL_REJECTED', 400);
  const payment = await env.DB.prepare('SELECT * FROM client_payments WHERE id=?1 AND work_id=?2').bind(requestRow.payment_id, workId).first();
  if (!payment) throw new DomainError('PAYMENT_NOT_FOUND', 404);
  const beforeWork = await getWorkRaw(env, workId);
  const cancelled = isCancelledWorkStatus(beforeWork.status);
  if (!cancelled) await prbEnsurePeriodOpen(env, payment.effective_at);
  const existingReversal = await env.DB.prepare('SELECT id FROM payment_reversals WHERE payment_id=?1 OR reversal_request_id=?2 LIMIT 1').bind(payment.id, requestIdToApprove).first();
  if (existingReversal) throw new DomainError('REVERSAL_ALREADY_APPROVED', 409);
  const approvedAt = nowIso();
  const reversalId = newId('payment_reversal');
  const afterRequest = { ...requestRow, state: 'APPROVED', approved_by: actorUid, approved_at: approvedAt, approval_request_id: requestId };
  const afterReversal = { id: reversalId, payment_id: payment.id, reversal_request_id: requestIdToApprove, work_id: workId, amount_halalas: Number(payment.amount_halalas), reason: requestRow.reason, requested_by: requestRow.requested_by, approved_by: actorUid, requested_at: requestRow.requested_at, approved_at: approvedAt, request_id: requestId };
  const workMutation = env.DB.prepare(`UPDATE works SET version=version+1, updated_by=?1, updated_at=?2
    WHERE id=?3 AND version=?4 AND EXISTS (SELECT 1 FROM payment_reversal_requests WHERE id=?5 AND work_id=?3 AND state='PENDING' AND requested_by<>?1)`).bind(actorUid, approvedAt, workId, beforeWork.version, requestIdToApprove);
  const requestMutation = env.DB.prepare(`UPDATE payment_reversal_requests SET state='APPROVED', approved_by=?1, approved_at=?2, approval_request_id=?3
    WHERE id=?4 AND work_id=?5 AND payment_id=?6 AND state='PENDING' AND requested_by<>?1
      AND EXISTS (SELECT 1 FROM works WHERE id=?5 AND version=?7)`).bind(actorUid, approvedAt, requestId, requestIdToApprove, workId, payment.id, beforeWork.version + 1);
  const reversalMutation = env.DB.prepare(`INSERT INTO payment_reversals(id,payment_id,reversal_request_id,work_id,amount_halalas,reason,requested_by,approved_by,requested_at,approved_at,request_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
    WHERE EXISTS (SELECT 1 FROM payment_reversal_requests WHERE id=?3 AND state='APPROVED' AND approval_request_id=?11)`).bind(reversalId, payment.id, requestIdToApprove, workId, Number(payment.amount_halalas), requestRow.reason, requestRow.requested_by, actorUid, requestRow.requested_at, approvedAt, requestId);
  const auditRequest = auditStatementWhen(env, 'payment_reversal_request', requestIdToApprove, 'UPDATE', actorUid, requestRow, afterRequest, env.RUN_MARKER, `${requestId}:reversal_request`, approvedAt,
    'EXISTS (SELECT 1 FROM payment_reversal_requests WHERE id=?10 AND state=\'APPROVED\' AND approved_by=?11 AND approval_request_id=?12)', [requestIdToApprove, actorUid, requestId]);
  const auditReversal = auditStatementWhen(env, 'payment_reversal', reversalId, 'CREATE', actorUid, null, afterReversal, env.RUN_MARKER, `${requestId}:reversal`, approvedAt,
    'EXISTS (SELECT 1 FROM payment_reversals WHERE id=?10 AND payment_id=?11 AND request_id=?12)', [reversalId, payment.id, requestId]);
  const adjustment = cancelled ? await prbPreparePostCancelReversalAdjustment(env, beforeWork, payment, reversalId, actorUid, approvedAt, requestId) : null;
  const statements = [workMutation, requestMutation, reversalMutation, auditRequest, auditReversal];
  if (adjustment) statements.push(adjustment.statement);
  const results = await executeBatch(env, statements);
  if (!results[0]?.meta || Number(results[0].meta.changes) !== 1 || !results[1]?.meta || Number(results[1].meta.changes) !== 1 || !results[2]?.meta || Number(results[2].meta.changes) !== 1 || !results[3]?.meta || Number(results[3].meta.changes) !== 1 || !results[4]?.meta || Number(results[4].meta.changes) !== 1 || (adjustment && Number(results[5]?.meta?.changes) !== 1)) throw new DomainError('TRANSACTION_FAILED', 409);
  return { request: afterRequest, reversal: afterReversal, settlement_adjustment: adjustment?.record || null, financials: await getWorkFinancials(env, workId) };
}

export async function listPriceMovements(env, workId) {
  await getWorkRaw(env, workId);
  return listApprovedPriceMovementsRaw(env, workId);
}

async function listPriceChangeRequestsRaw(env, workId) {
  return (await env.DB.prepare(`SELECT id, work_id, movement_type, amount_halalas, reason, effective_at, requested_by, requested_at, work_version, state, approved_by, approved_at, approval_request_id, request_id
    FROM price_change_requests WHERE work_id=?1 ORDER BY requested_at ASC, id ASC`).bind(workId).all()).results || [];
}

export async function listPriceChangeRequests(env, workId) {
  const work = await getWorkRaw(env, workId);
  const rows = await listPriceChangeRequestsRaw(env, workId);
  const cancelled = isCancelledWorkStatus(work.status);
  return rows.map(row => row.state === 'PENDING' && (cancelled || Number(row.work_version) !== Number(work.version)) ? { ...row, state: 'SUPERSEDED' } : row);
}

export async function createPriceChangeRequest(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const beforeWork = await getWorkRaw(env, workId);
  assertWorkOperational(beforeWork);
  const version = positiveVersion(input.version);
  if (version !== beforeWork.version) throw new DomainError('VERSION_CONFLICT', 409);
  const movementType = validatePriceMovementType(input.movement_type);
  const amountHalalas = validateMovementAmount(movementType, parseMoneyHalalas(input.amount_riyals));
  const currentMovements = await listApprovedPriceMovementsRaw(env, workId);
  if (!currentMovements.length && movementType !== 'BASE') throw new DomainError('BASE_REQUIRED', 400);
  if (currentMovements.length && movementType === 'BASE') throw new DomainError('BASE_ALREADY_SET', 400);
  const reason = requiredString(input.reason, 'REASON_REQUIRED');
  const effectiveAt = canonicalEventTimestamp(input.effective_at === undefined ? nowIso() : input.effective_at);
  await prbEnsurePeriodOpen(env, effectiveAt);
  const existingPending = await env.DB.prepare(`SELECT id FROM price_change_requests WHERE work_id=?1 AND state='PENDING' AND work_version=?2 LIMIT 1`).bind(workId, version).first();
  if (existingPending) throw new DomainError('PRICE_REQUEST_ALREADY_PENDING', 409);
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
  await prbEnsurePeriodOpen(env, requestRow.effective_at);
  if (requestRow.state !== 'PENDING') throw new DomainError('ALREADY_FINALIZED', 400);
  if (requestRow.requested_by === actorUid) throw new DomainError('SELF_APPROVAL_REJECTED', 400);
  const beforeWork = await getWorkRaw(env, workId);
  assertWorkOperational(beforeWork);
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

async function listRatioChangeRequestsRaw(env, workId) {
  return (await env.DB.prepare(`SELECT id, work_id, person_1_bps, person_2_bps, reason, requested_by, requested_at, work_version, state, approved_by, approved_at, approval_request_id, request_id
    FROM ratio_change_requests WHERE work_id=?1 ORDER BY requested_at ASC, id ASC`).bind(workId).all()).results || [];
}

export async function listRatioChangeRequests(env, workId) {
  const work = await getWorkRaw(env, workId);
  const rows = await listRatioChangeRequestsRaw(env, workId);
  return isCancelledWorkStatus(work.status) ? rows.map(row => row.state === 'PENDING' ? { ...row, state: 'SUPERSEDED' } : row) : rows;
}

async function listRatioHistoryRaw(env, workId) {
  return (await env.DB.prepare(`SELECT id, work_id, old_person_1_bps, old_person_2_bps, new_person_1_bps, new_person_2_bps, reason, requested_by, approved_by, requested_at, approved_at, ratio_request_id, request_id
    FROM ratio_history WHERE work_id=?1 ORDER BY approved_at ASC, id ASC`).bind(workId).all()).results || [];
}

export async function listRatioHistory(env, workId) {
  await getWorkRaw(env, workId);
  return listRatioHistoryRaw(env, workId);
}

export async function createRatioChangeRequest(env, actorUid, requestId, workId, input) {
  await ensureActor(env, actorUid);
  const beforeWork = await getWorkRaw(env, workId);
  assertWorkOperational(beforeWork);
  await prbEnsureWorkAffectedPeriods(env, null, beforeWork.confirmed_at);
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
  assertWorkOperational(beforeWork);
  if (beforeWork.version !== requestRow.work_version) throw new DomainError('STALE_VERSION', 409);
  await prbEnsureWorkAffectedPeriods(env, null, beforeWork.confirmed_at);
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

// S7 PR-B Transfers / Subscriptions / Expenses / Settlement Core.

function prbParty(value, code = 'PARTY_INVALID') {
  const party = requiredString(value, code);
  if (party !== 'person_1' && party !== 'person_2') throw new DomainError(code, 400);
  return party;
}
function prbPositiveMoney(value, code = 'MONEY_INVALID') {
  const amount = parseMoneyHalalas(value);
  if (amount <= 0) throw new DomainError(code, 400);
  return amount;
}
function prbPeriodKey(value) {
  const key = requiredString(value, 'SETTLEMENT_PERIOD_REQUIRED');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) throw new DomainError('SETTLEMENT_PERIOD_INVALID', 400);
  return key;
}
function prbPeriodBounds(periodKey) {
  const key = prbPeriodKey(periodKey);
  const [year, month] = key.split('-').map(Number);
  const start = `${key}-01T00:00:00.000Z`;
  const next = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  return { periodKey: key, start, end: next.toISOString() };
}
function prbPartyRoleUid(env, role) {
  return env.DB.prepare('SELECT uid FROM app_users WHERE role=?1 AND active=1').bind(role).first();
}
async function prbEnsurePeriodOpen(env, effectiveAt) {
  const key = effectiveAt.slice(0, 7);
  try {
    const closed = await env.DB.prepare(`SELECT s.id FROM settlement_snapshots s
      WHERE s.period_key=?1 AND s.state='CLOSED'
        AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at)
      LIMIT 1`).bind(key).first();
    if (closed) throw new DomainError('CLOSED_PERIOD_MUTATION_FORBIDDEN', 409);
  } catch (error) {
    if (error instanceof Error && /no such table:\s*settlement_snapshots/.test(error.message)) return;
    throw error;
  }
}
async function prbEnsureWorkAffectedPeriods(env, oldConfirmedAt, newConfirmedAt) {
  const keys = [...new Set([oldConfirmedAt, newConfirmedAt].filter(value => typeof value === 'string' && value.length >= 7).map(value => value.slice(0, 7)))];
  if (!keys.length) return;
  try {
    const closed = await env.DB.prepare(`SELECT s.id FROM settlement_snapshots s
      WHERE s.period_key IN (${prbInClause(keys)}) AND s.state='CLOSED'
        AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at)
      LIMIT 1`).bind(...keys).first();
    if (closed) throw new DomainError('CLOSED_PERIOD_MUTATION_FORBIDDEN', 409);
  } catch (error) {
    if (error instanceof Error && /no such table:\s*settlement_snapshots/.test(error.message)) return;
    throw error;
  }
}

function prbNextPeriodKey(periodKey) {
  const [year, month] = prbPeriodKey(periodKey).split('-').map(Number);
  const next = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1));
  return next.toISOString().slice(0, 7);
}
async function prbActiveClosedSnapshotForPeriod(env, periodKey) {
  return env.DB.prepare(`SELECT s.* FROM settlement_snapshots s
    WHERE s.period_key=?1 AND s.state='CLOSED'
      AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at)
    ORDER BY s.version DESC LIMIT 1`).bind(periodKey).first();
}
async function prbFirstOpenPeriodKey(env, startPeriodKey) {
  let key = prbPeriodKey(startPeriodKey);
  for (let i = 0; i < 240; i++) {
    if (!(await prbActiveClosedSnapshotForPeriod(env, key))) return key;
    key = prbNextPeriodKey(key);
  }
  throw new DomainError('SETTLEMENT_ADJUSTMENT_OPEN_PERIOD_NOT_FOUND', 409);
}
async function prbPriceAt(env, workId, approvedAt) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(amount_halalas),0) AS total FROM price_movements WHERE work_id=?1 AND approved_at<=?2').bind(workId, approvedAt).first();
  return Number(row?.count || 0) ? Number(row.total || 0) : 0;
}
function prbDefaultRatioAt(approvedAt) {
  return approvedAt < '2026-09-03T00:00:00.000Z'
    ? { person_1_bps: 3000, person_2_bps: 7000, source: 'HISTORICAL_DEFAULT_PRE_D023' }
    : { person_1_bps: DEFAULT_PERSON_1_BPS, person_2_bps: DEFAULT_PERSON_2_BPS, source: 'DEFAULT_D023' };
}
async function prbRatioAt(env, workId, approvedAt) {
  const row = await env.DB.prepare('SELECT new_person_1_bps,new_person_2_bps FROM ratio_history WHERE work_id=?1 AND approved_at<=?2 ORDER BY approved_at DESC,id DESC LIMIT 1').bind(workId, approvedAt).first();
  return row ? { person_1_bps: Number(row.new_person_1_bps), person_2_bps: Number(row.new_person_2_bps), source: 'APPROVED_HISTORY' } : prbDefaultRatioAt(approvedAt);
}
async function prbNetApprovedReceiptsForWork(env, workId) {
  return paymentTotals(await listPaymentRowsRaw(env, workId)).approvedPaid;
}
function prbSettlementAdjustment(env, { periodKey, sourcePeriodKey, sourceSnapshotId, workId, adjustmentType, sourceEventId, recognizedPerson1, recognizedPerson2, correctedPerson1, correctedPerson2, actorUid, createdAt, requestId, reason }) {
  const person1Delta = safeFinancialAdd(correctedPerson1, -recognizedPerson1);
  const person2Delta = safeFinancialAdd(correctedPerson2, -recognizedPerson2);
  if (person1Delta === 0 && person2Delta === 0) return null;
  const id = newId('settlement-adjustment');
  const record = { id, period_key: periodKey, source_period_key: sourcePeriodKey, source_snapshot_id: sourceSnapshotId, work_id: workId, adjustment_type: adjustmentType, source_event_id: sourceEventId, person_1_delta_halalas: person1Delta, person_2_delta_halalas: person2Delta, recognized_person_1_before_halalas: recognizedPerson1, recognized_person_2_before_halalas: recognizedPerson2, corrected_person_1_after_halalas: correctedPerson1, corrected_person_2_after_halalas: correctedPerson2, reason, created_by: actorUid, created_at: createdAt, request_id: requestId };
  const statement = env.DB.prepare(`INSERT INTO settlement_adjustments(id,period_key,source_period_key,source_snapshot_id,work_id,adjustment_type,source_event_id,person_1_delta_halalas,person_2_delta_halalas,recognized_person_1_before_halalas,recognized_person_2_before_halalas,corrected_person_1_after_halalas,corrected_person_2_after_halalas,reason,created_by,created_at,request_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`).bind(id, periodKey, sourcePeriodKey, sourceSnapshotId, workId, adjustmentType, sourceEventId, person1Delta, person2Delta, recognizedPerson1, recognizedPerson2, correctedPerson1, correctedPerson2, reason, actorUid, createdAt, requestId);
  return { record, statement };
}
async function prbPrepareCancellationAdjustment(env, beforeWork, sourceEventId, actorUid, approvedAt, requestId) {
  if (!beforeWork.confirmed_at) return null;
  const sourcePeriodKey = beforeWork.confirmed_at.slice(0, 7);
  const sourceSnapshot = await prbActiveClosedSnapshotForPeriod(env, sourcePeriodKey);
  if (!sourceSnapshot) return null;
  const recognizedPrice = await prbPriceAt(env, beforeWork.id, sourceSnapshot.created_at);
  const recognizedRatio = await prbRatioAt(env, beforeWork.id, sourceSnapshot.created_at);
  const correctedRatio = await currentRatio(env, beforeWork.id);
  const netReceipts = await prbNetApprovedReceiptsForWork(env, beforeWork.id);
  const recognizedPerson1 = calculateShareHalalas(recognizedPrice, recognizedRatio.person_1_bps);
  const recognizedPerson2 = calculateShareHalalas(recognizedPrice, recognizedRatio.person_2_bps);
  const correctedPerson1 = calculateShareHalalas(netReceipts, correctedRatio.person_1_bps);
  const correctedPerson2 = calculateShareHalalas(netReceipts, correctedRatio.person_2_bps);
  const periodKey = await prbFirstOpenPeriodKey(env, approvedAt.slice(0, 7));
  return prbSettlementAdjustment(env, { periodKey, sourcePeriodKey, sourceSnapshotId: sourceSnapshot.id, workId: beforeWork.id, adjustmentType: 'CANCELLATION', sourceEventId, recognizedPerson1, recognizedPerson2, correctedPerson1, correctedPerson2, actorUid, createdAt: approvedAt, requestId: `${requestId}:settlement-adjustment`, reason: 'D-024 cancellation adjustment: closed snapshot preserved; receipt-based share carried to first open period' });
}
async function prbPreparePostCancelReversalAdjustment(env, beforeWork, payment, sourceEventId, actorUid, approvedAt, requestId) {
  if (!beforeWork.confirmed_at) return null;
  const sourcePeriodKey = beforeWork.confirmed_at.slice(0, 7);
  const sourceSnapshot = await prbActiveClosedSnapshotForPeriod(env, sourcePeriodKey);
  if (!sourceSnapshot) return null;
  const ratio = await currentRatio(env, beforeWork.id);
  const beforeNet = await prbNetApprovedReceiptsForWork(env, beforeWork.id);
  const afterNet = safeFinancialAdd(beforeNet, -Number(payment.amount_halalas));
  const recognizedPerson1 = calculateShareHalalas(beforeNet, ratio.person_1_bps);
  const recognizedPerson2 = calculateShareHalalas(beforeNet, ratio.person_2_bps);
  const correctedPerson1 = calculateShareHalalas(afterNet, ratio.person_1_bps);
  const correctedPerson2 = calculateShareHalalas(afterNet, ratio.person_2_bps);
  const periodKey = await prbFirstOpenPeriodKey(env, approvedAt.slice(0, 7));
  return prbSettlementAdjustment(env, { periodKey, sourcePeriodKey, sourceSnapshotId: sourceSnapshot.id, workId: beforeWork.id, adjustmentType: 'POST_CANCEL_REVERSAL', sourceEventId, recognizedPerson1, recognizedPerson2, correctedPerson1, correctedPerson2, actorUid, createdAt: approvedAt, requestId: `${requestId}:settlement-adjustment`, reason: 'D-024 post-cancellation reversal adjustment: closed snapshot preserved; delta carried to first open period' });
}
export async function listSettlementAdjustments(env, periodKey = '') {
  const key = periodKey ? prbPeriodKey(periodKey) : null;
  const rows = (await env.DB.prepare(`SELECT a.* FROM settlement_adjustments a
    JOIN settlement_snapshots s ON s.id=a.source_snapshot_id
    WHERE (?1 IS NULL OR a.period_key=?1)
      AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at)
    ORDER BY a.created_at ASC,a.id ASC`).bind(key).all()).results || [];
  return rows.map(row => ({ ...row, person_1_delta_halalas: Number(row.person_1_delta_halalas), person_2_delta_halalas: Number(row.person_2_delta_halalas), recognized_person_1_before_halalas: Number(row.recognized_person_1_before_halalas), recognized_person_2_before_halalas: Number(row.recognized_person_2_before_halalas), corrected_person_1_after_halalas: Number(row.corrected_person_1_after_halalas), corrected_person_2_after_halalas: Number(row.corrected_person_2_after_halalas) }));
}

function prbAudit(env, type, id, actorUid, after, requestId, createdAt) {
  return auditStatement(env, type, id, 'CREATE', actorUid, null, after, env.RUN_MARKER, requestId, createdAt);
}

export async function createInterPartyTransfer(env, actorUid, requestId, input) {
  await ensureActor(env, actorUid);
  const amount = prbPositiveMoney(input.amount_riyals, 'TRANSFER_AMOUNT_INVALID');
  const fee = input.fee_riyals === undefined ? 0 : parseMoneyHalalas(input.fee_riyals);
  if (fee < 0) throw new DomainError('TRANSFER_FEE_INVALID', 400);
  const effectiveAt = canonicalEventTimestamp(input.effective_at);
  await prbEnsurePeriodOpen(env, effectiveAt);
  const fromParty = prbParty(input.from_party, 'TRANSFER_FROM_REQUIRED');
  const toParty = prbParty(input.to_party, 'TRANSFER_TO_REQUIRED');
  if (fromParty === toParty) throw new DomainError('TRANSFER_DIRECTION_INVALID', 400);
  const feePayer = prbParty(input.fee_payer === undefined ? 'person_1' : input.fee_payer, 'TRANSFER_FEE_PAYER_INVALID');
  if (feePayer !== 'person_1') throw new DomainError('TRANSFER_FEE_PAYER_INVALID', 400);
  const note = optionalString(input.note, 'TRANSFER_NOTE_INVALID');
  const id = newId('transfer');
  const createdAt = nowIso();
  const after = { id, amount_halalas: amount, effective_at: effectiveAt, from_party: fromParty, to_party: toParty, fee_halalas: fee, fee_payer: feePayer, note, recorded_by: actorUid, created_at: createdAt, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO inter_party_transfers(id,amount_halalas,effective_at,from_party,to_party,fee_halalas,fee_payer,note,recorded_by,created_at,request_id)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`).bind(id, amount, effectiveAt, fromParty, toParty, fee, feePayer, note, actorUid, createdAt, requestId);
  await executeBatch(env, [mutation, prbAudit(env, 'inter_party_transfer', id, actorUid, after, `${requestId}:audit`, createdAt)]);
  return after;
}
export async function listInterPartyTransfers(env, query = {}) {
  const from = query.from ? canonicalEventTimestamp(query.from) : null;
  const to = query.to ? canonicalEventTimestamp(query.to) : null;
  const rows = (await env.DB.prepare(`SELECT id,amount_halalas,effective_at,from_party,to_party,fee_halalas,fee_payer,note,recorded_by,created_at,request_id
    FROM inter_party_transfers WHERE (?1 IS NULL OR effective_at>=?1) AND (?2 IS NULL OR effective_at<?2) ORDER BY effective_at ASC,id ASC`).bind(from, to).all()).results || [];
  return rows.map(row => ({ ...row, amount_halalas: Number(row.amount_halalas), fee_halalas: Number(row.fee_halalas) }));
}

export async function createSubscriptionHistory(env, actorUid, requestId, input) {
  const actor = await ensureActor(env, actorUid);
  if (actor.role !== 'person_2') throw new DomainError('SUBSCRIPTION_PAYER_MUST_BE_PERSON_2', 403);
  const effectiveAt = canonicalEventTimestamp(input.effective_at);
  await prbEnsurePeriodOpen(env, effectiveAt);
  const state = input.state === undefined ? 'ACTIVE' : requiredString(input.state, 'SUBSCRIPTION_STATE_INVALID').toUpperCase();
  if (state !== 'ACTIVE' && state !== 'CANCELLED') throw new DomainError('SUBSCRIPTION_STATE_INVALID', 400);
  const amount = state === 'CANCELLED' ? 0 : prbPositiveMoney(input.aggregate_amount_riyals, 'SUBSCRIPTION_AMOUNT_INVALID');
  const paidBy = await prbPartyRoleUid(env, 'person_2');
  const id = newId('subscription');
  const createdAt = nowIso();
  const after = { id, subscription_count: 2, aggregate_amount_halalas: amount, effective_at: effectiveAt, state, paid_by_uid: paidBy.uid, recorded_by: actorUid, note: optionalString(input.note, 'SUBSCRIPTION_NOTE_INVALID'), created_at: createdAt, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO subscription_history(id,subscription_count,aggregate_amount_halalas,effective_at,state,paid_by_uid,recorded_by,note,created_at,request_id)
    VALUES (?1,2,?2,?3,?4,?5,?6,?7,?8,?9)`).bind(id, amount, effectiveAt, state, paidBy.uid, actorUid, after.note, createdAt, requestId);
  await executeBatch(env, [mutation, prbAudit(env, 'subscription_history', id, actorUid, after, `${requestId}:audit`, createdAt)]);
  return after;
}
export async function listSubscriptionHistory(env) {
  const rows = (await env.DB.prepare(`SELECT id,subscription_count,aggregate_amount_halalas,effective_at,state,paid_by_uid,recorded_by,note,created_at,request_id
    FROM subscription_history ORDER BY effective_at ASC,id ASC`).bind().all()).results || [];
  return rows.map(row => ({ ...row, subscription_count: Number(row.subscription_count), aggregate_amount_halalas: Number(row.aggregate_amount_halalas) }));
}

export async function createCommonExpense(env, actorUid, requestId, input) {
  await ensureActor(env, actorUid);
  const amount = prbPositiveMoney(input.amount_riyals, 'EXPENSE_AMOUNT_INVALID');
  const effectiveAt = canonicalEventTimestamp(input.effective_at);
  await prbEnsurePeriodOpen(env, effectiveAt);
  const category = requiredString(input.category, 'EXPENSE_CATEGORY_REQUIRED');
  const paidBy = requiredString(input.paid_by_uid, 'EXPENSE_PAYER_REQUIRED');
  await ensureActor(env, paidBy);
  const note = optionalString(input.note, 'EXPENSE_NOTE_INVALID');
  const id = newId('expense');
  const createdAt = nowIso();
  const after = { id, amount_halalas: amount, effective_at: effectiveAt, category, paid_by_uid: paidBy, allocation_policy: 'UNRESOLVED', note, recorded_by: actorUid, created_at: createdAt, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO common_expenses(id,amount_halalas,effective_at,category,paid_by_uid,allocation_policy,note,recorded_by,created_at,request_id)
    VALUES (?1,?2,?3,?4,?5,'UNRESOLVED',?6,?7,?8,?9)`).bind(id, amount, effectiveAt, category, paidBy, note, actorUid, createdAt, requestId);
  await executeBatch(env, [mutation, prbAudit(env, 'common_expense', id, actorUid, after, `${requestId}:audit`, createdAt)]);
  return after;
}
export async function listCommonExpenses(env) {
  const rows = (await env.DB.prepare(`SELECT id,amount_halalas,effective_at,category,paid_by_uid,allocation_policy,note,recorded_by,created_at,request_id
    FROM common_expenses ORDER BY effective_at ASC,id ASC`).bind().all()).results || [];
  return rows.map(row => ({ ...row, amount_halalas: Number(row.amount_halalas) }));
}

function prbInClause(values) { return values.map(() => '?').join(','); }
async function prbSettlementComponents(env, bounds) {
  const works = (await env.DB.prepare(`SELECT id,status,confirmed_at FROM works WHERE confirmed_at>=?1 AND confirmed_at<?2 ORDER BY confirmed_at ASC,id ASC`).bind(bounds.start, bounds.end).all()).results || [];
  const cumulativeRow = (await env.DB.prepare(`SELECT COUNT(*) AS count,
      (SELECT s.period_key FROM settlement_snapshots s WHERE s.state='CLOSED' AND s.unresolved_code IS NULL AND s.final_balance_halalas IS NOT NULL AND s.period_end<=?2 AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at) ORDER BY s.period_end DESC,s.version DESC LIMIT 1) AS prior_period_key,
      (SELECT s.version FROM settlement_snapshots s WHERE s.state='CLOSED' AND s.unresolved_code IS NULL AND s.final_balance_halalas IS NOT NULL AND s.period_end<=?2 AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at) ORDER BY s.period_end DESC,s.version DESC LIMIT 1) AS prior_version,
      (SELECT s.final_balance_halalas FROM settlement_snapshots s WHERE s.state='CLOSED' AND s.unresolved_code IS NULL AND s.final_balance_halalas IS NOT NULL AND s.period_end<=?2 AND NOT EXISTS (SELECT 1 FROM settlement_reopen_history r WHERE r.period_key=s.period_key AND r.approved_at>s.created_at) ORDER BY s.period_end DESC,s.version DESC LIMIT 1) AS prior_final_balance
    FROM works WHERE confirmed_at<?1`).bind(bounds.end, bounds.start).first()) || { count: 0, prior_period_key: null, prior_version: null, prior_final_balance: null };
  const cumulative = cumulativeRow.count || 0;
  const ids = works.map(row => row.id);
  const prices = works.length
    ? ((await env.DB.prepare(`SELECT work_id,effective_at,approved_at,resulting_price_halalas FROM price_movements WHERE work_id IN (${prbInClause(ids)}) ORDER BY effective_at ASC,approved_at ASC,id ASC`).bind(...ids).all()).results || [])
    : [];
  const ratios = works.length
    ? ((await env.DB.prepare(`SELECT work_id,approved_at,new_person_1_bps,new_person_2_bps FROM ratio_history WHERE work_id IN (${prbInClause(ids)}) ORDER BY approved_at ASC,id ASC`).bind(...ids).all()).results || [])
    : [];
  const receipts = works.length
    ? ((await env.DB.prepare(`SELECT p.work_id,
        COALESCE(SUM(CASE WHEN u.role='person_1' THEN p.amount_halalas ELSE 0 END),0)-COALESCE(SUM(CASE WHEN u.role='person_1' THEN r.amount_halalas ELSE 0 END),0) AS approved_paid_person_1,
        COALESCE(SUM(CASE WHEN u.role='person_2' THEN p.amount_halalas ELSE 0 END),0)-COALESCE(SUM(CASE WHEN u.role='person_2' THEN r.amount_halalas ELSE 0 END),0) AS approved_paid_person_2
      FROM client_payments p JOIN app_users u ON u.uid=p.received_by LEFT JOIN payment_reversals r ON r.payment_id=p.id
      WHERE p.work_id IN (${prbInClause(ids)}) GROUP BY p.work_id`).bind(...ids).all()).results || [])
    : [];
  const transfer = (await env.DB.prepare(`SELECT COALESCE(SUM(amount_halalas),0) AS amount,COALESCE(SUM(fee_halalas),0) AS fee,COALESCE(SUM(CASE WHEN to_party='person_2' THEN amount_halalas WHEN from_party='person_2' THEN -amount_halalas ELSE 0 END),0) AS net_person_2 FROM inter_party_transfers WHERE effective_at>=?1 AND effective_at<?2`).bind(bounds.start, bounds.end).first()) || { amount: 0, fee: 0, net_person_2: 0 };
  const subscriptionHistory = (await env.DB.prepare(`SELECT id,subscription_count,aggregate_amount_halalas,effective_at,state,paid_by_uid,recorded_by,note,created_at,request_id FROM subscription_history WHERE effective_at<?1 ORDER BY effective_at ASC,id ASC`).bind(bounds.end).all()).results || [];
  const priorSettlement = cumulativeRow.prior_period_key ? { period_key: cumulativeRow.prior_period_key, version: Number(cumulativeRow.prior_version), final_balance_halalas: Number(cumulativeRow.prior_final_balance) } : null;
  const expense = (await env.DB.prepare(`SELECT COALESCE(SUM(amount_halalas),0) AS amount FROM common_expenses WHERE effective_at>=?1 AND effective_at<?2`).bind(bounds.start, bounds.end).first()) || { amount: 0 };
  const adjustments = await listSettlementAdjustments(env, bounds.periodKey);
  const adjustmentPerson1 = adjustments.reduce((total, row) => safeFinancialAdd(total, row.person_1_delta_halalas), 0);
  const adjustmentPerson2 = adjustments.reduce((total, row) => safeFinancialAdd(total, row.person_2_delta_halalas), 0);
  return {
    works,
    cumulativeWorkCount: Number(cumulative),
    prices,
    ratios,
    receipts,
    transferAmount: Number(transfer.amount),
    transferNetPerson2: Number(transfer.net_person_2),
    transferFee: Number(transfer.fee),
    subscriptionHistory,
    priorBalance: priorSettlement ? Number(priorSettlement.final_balance_halalas) : 0,
    priorSettlement,
    expenseTotal: Number(expense.amount),
    adjustments,
    adjustmentPerson1,
    adjustmentPerson2,
  };
}
function prbRoundHalf(value) {
  return calculateShareHalalas(safeFinancialInteger(value), 5000);
}
async function prbBuildSettlementPreview(env, periodKey, input = {}) {
  const bounds = prbPeriodBounds(periodKey);
  const components = await prbSettlementComponents(env, bounds);
  const prices = new Map();
  for (const row of components.prices || []) prices.set(row.work_id, Number(row.resulting_price_halalas));
  const ratios = new Map();
  for (const row of components.ratios || []) ratios.set(row.work_id, { person_1_bps: Number(row.new_person_1_bps), person_2_bps: Number(row.new_person_2_bps) });
  const receipts = new Map();
  for (const row of components.receipts || []) receipts.set(row.work_id, { person_1: Number(row.approved_paid_person_1), person_2: Number(row.approved_paid_person_2) });
  let totalWork = 0; let person1 = 0; let person2 = 0; let receiptsPerson1 = 0; let receiptsPerson2 = 0;
  for (const work of components.works) {
    const price = prices.get(work.id) ?? 0;
    const ratio = ratios.get(work.id) || { person_1_bps: DEFAULT_PERSON_1_BPS, person_2_bps: DEFAULT_PERSON_2_BPS };
    const receipt = receipts.get(work.id) || { person_1: 0, person_2: 0 };
    const shareBasis = isCancelledWorkStatus(work.status) ? safeFinancialAdd(receipt.person_1, receipt.person_2) : price;
    totalWork = safeFinancialAdd(totalWork, price);
    person1 = safeFinancialAdd(person1, calculateShareHalalas(shareBasis, ratio.person_1_bps));
    person2 = safeFinancialAdd(person2, calculateShareHalalas(shareBasis, ratio.person_2_bps));
    receiptsPerson1 = safeFinancialAdd(receiptsPerson1, receipt.person_1);
    receiptsPerson2 = safeFinancialAdd(receiptsPerson2, receipt.person_2);
  }
  const subscriptionHistory = (components.subscriptionHistory || []).map(row => ({ ...row, subscription_count: Number(row.subscription_count), aggregate_amount_halalas: Number(row.aggregate_amount_halalas) }));
  const priorSubscription = [...subscriptionHistory].filter(row => row.effective_at < bounds.start).at(-1);
  const subscriptionTotal = priorSubscription ? (priorSubscription.state === 'CANCELLED' ? 0 : priorSubscription.aggregate_amount_halalas) : 13650;
  const subscriptionHalf = prbRoundHalf(subscriptionTotal);
  const subscriptionEffectPerson1 = subscriptionHalf === 0 ? 0 : -subscriptionHalf;
  const subscriptionEffectPerson2 = subscriptionHalf;
  const feeHalf = prbRoundHalf(components.transferFee);
  const feeEffectPerson1 = -feeHalf;
  const feeEffectPerson2 = feeHalf;
  const expenseEffectPerson2 = components.expenseTotal > 0 ? null : 0;
  const unresolvedCodes = components.expenseTotal > 0 ? ['S7_GENERIC_SHARED_EXPENSE_ALLOCATION_RULE_UNRESOLVED'] : [];
  const approvedReceipts = safeFinancialAdd(receiptsPerson1, receiptsPerson2);
  let finalBalance = null;
  if (!unresolvedCodes.length) {
    finalBalance = safeFinancialAdd(components.priorBalance, person2);
    finalBalance = safeFinancialAdd(finalBalance, -receiptsPerson2);
    finalBalance = safeFinancialAdd(finalBalance, -components.transferNetPerson2);
    finalBalance = safeFinancialAdd(finalBalance, subscriptionHalf);
    finalBalance = safeFinancialAdd(finalBalance, -feeHalf);
    finalBalance = safeFinancialAdd(finalBalance, components.adjustmentPerson2);
  }
  return {
    period_key: bounds.periodKey,
    period_start: bounds.start,
    period_end: bounds.end,
    period_basis: 'CONFIRMED_AT',
    balance_formula: 'D-015_PERSON_1_OWES_PERSON_2_POSITIVE',
    work_count: components.works.length,
    cumulative_work_count: components.cumulativeWorkCount,
    total_work_value_halalas: totalWork,
    person_1_work_share_halalas: person1,
    person_2_work_share_halalas: person2,
    approved_receipts_halalas: approvedReceipts,
    approved_receipts_person_1_halalas: receiptsPerson1,
    approved_receipts_person_2_halalas: receiptsPerson2,
    transfer_amount_halalas: components.transferAmount,
    transfer_net_person_2_halalas: components.transferNetPerson2,
    transfer_fee_halalas: components.transferFee,
    subscription_total_halalas: subscriptionTotal,
    subscription_history: subscriptionHistory,
    subscription_effect_person_1_halalas: subscriptionEffectPerson1,
    subscription_effect_person_2_halalas: subscriptionEffectPerson2,
    transfer_fee_effect_person_1_halalas: feeEffectPerson1,
    transfer_fee_effect_person_2_halalas: feeEffectPerson2,
    governed_expense_total_halalas: components.expenseTotal,
    governed_expense_net_effect_to_person_2_halalas: expenseEffectPerson2,
    settlement_adjustment_person_1_halalas: components.adjustmentPerson1,
    settlement_adjustment_person_2_halalas: components.adjustmentPerson2,
    settlement_adjustments: components.adjustments,
    generic_expense_allocation: components.expenseTotal > 0 ? 'UNRESOLVED' : 'NOT_PRESENT',
    prior_balance_halalas: components.priorBalance,
    prior_balance_authority: components.priorSettlement ? 'LATEST_VALID_PRIOR_MONTHLY_SETTLEMENT' : 'ZERO_NO_PRIOR_SETTLEMENT',
    final_balance_halalas: finalBalance,
    unresolved_code: unresolvedCodes[0] || null,
    unresolved_codes: unresolvedCodes,
    component_formula: 'PRIOR_BALANCE + PERSON_2_WORK_SHARE - APPROVED_RECEIPTS_RECEIVED_BY_PERSON_2 - NET_TRANSFERS_TO_PERSON_2 + HALF_SUBSCRIPTION - HALF_TRANSFER_FEES + GOVERNED_EXPENSE_NET_EFFECT_TO_PERSON_2 + SETTLEMENT_ADJUSTMENT_PERSON_2',
  };
}
export async function getSettlementPreview(env, periodKey, input = {}) { return prbBuildSettlementPreview(env, periodKey, input); }
async function prbEnsureSettlementCloseAllowed(env, periodKey) {
  const latest = await env.DB.prepare('SELECT id,state,version,created_at FROM settlement_snapshots WHERE period_key=?1 ORDER BY version DESC LIMIT 1').bind(periodKey).first();
  if (!latest || latest.state !== 'CLOSED') return latest;
  const reopened = await env.DB.prepare('SELECT id FROM settlement_reopen_history WHERE period_key=?1 AND approved_at>?2 ORDER BY approved_at ASC,id ASC LIMIT 1').bind(periodKey, latest.created_at).first();
  if (!reopened) throw new DomainError('SETTLEMENT_ALREADY_CLOSED', 409);
  return latest;
}
export async function closeSettlement(env, actorUid, requestId, periodKey, input) {
  await ensureActor(env, actorUid);
  const latest = await prbEnsureSettlementCloseAllowed(env, periodKey);
  const preview = await prbBuildSettlementPreview(env, periodKey, input);
  if (preview.unresolved_code) throw new DomainError(preview.unresolved_code, 409);
  const version = Number(latest?.version || 0) + 1;
  const id = newId('settlement'); const createdAt = nowIso();
  const after = { ...preview, id, state: 'CLOSED', version, created_by: actorUid, created_at: createdAt, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO settlement_snapshots(id,period_key,period_start,period_end,period_basis,balance_formula,state,work_count,cumulative_work_count,total_work_value_halalas,person_1_work_share_halalas,person_2_work_share_halalas,approved_receipts_halalas,approved_receipts_person_1_halalas,approved_receipts_person_2_halalas,transfer_amount_halalas,transfer_fee_halalas,subscription_total_halalas,subscription_effect_person_1_halalas,subscription_effect_person_2_halalas,governed_expense_total_halalas,settlement_adjustment_person_1_halalas,settlement_adjustment_person_2_halalas,prior_balance_halalas,final_balance_halalas,unresolved_code,version,created_by,created_at,request_id)
    VALUES (?1,?2,?3,?4,?5,?6,'CLOSED',?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,NULL,?25,?26,?27,?28)`).bind(id, periodKey, preview.period_start, preview.period_end, preview.period_basis, preview.balance_formula, preview.work_count, preview.cumulative_work_count, preview.total_work_value_halalas, preview.person_1_work_share_halalas, preview.person_2_work_share_halalas, preview.approved_receipts_halalas, preview.approved_receipts_person_1_halalas, preview.approved_receipts_person_2_halalas, preview.transfer_amount_halalas, preview.transfer_fee_halalas, preview.subscription_total_halalas, preview.subscription_effect_person_1_halalas, preview.subscription_effect_person_2_halalas, preview.governed_expense_total_halalas, preview.settlement_adjustment_person_1_halalas, preview.settlement_adjustment_person_2_halalas, preview.prior_balance_halalas, preview.final_balance_halalas, version, actorUid, createdAt, requestId);
  await executeBatch(env, [mutation, prbAudit(env, 'settlement_snapshot', id, actorUid, after, `${requestId}:audit`, createdAt)]);
  return after;
}
export async function listSettlementSnapshots(env, periodKey) {
  const rows = (await env.DB.prepare(`SELECT * FROM settlement_snapshots WHERE period_key=?1 ORDER BY version ASC`).bind(periodKey).all()).results || [];
  return rows;
}
export async function createSettlementReopenRequest(env, actorUid, requestId, periodKey, input) {
  await ensureActor(env, actorUid);
  const latest = await env.DB.prepare(`SELECT id FROM settlement_snapshots WHERE period_key=?1 AND state='CLOSED' ORDER BY version DESC LIMIT 1`).bind(periodKey).first();
  if (!latest) throw new DomainError('SETTLEMENT_NOT_CLOSED', 409);
  const reason = requiredString(input.reason, 'REOPEN_REASON_REQUIRED'); const id = newId('reopen'); const requestedAt = nowIso();
  const after = { id, period_key: periodKey, reason, requested_by: actorUid, requested_at: requestedAt, state: 'PENDING', approved_by: null, approved_at: null, approval_request_id: null, request_id: requestId };
  const mutation = env.DB.prepare(`INSERT INTO settlement_reopen_requests(id,period_key,reason,requested_by,requested_at,state,request_id) VALUES (?1,?2,?3,?4,?5,'PENDING',?6)`).bind(id, periodKey, reason, actorUid, requestedAt, requestId);
  await executeBatch(env, [mutation, prbAudit(env, 'settlement_reopen_request', id, actorUid, after, `${requestId}:audit`, requestedAt)]);
  return after;
}
export async function approveSettlementReopenRequest(env, actorUid, requestId, periodKey, reopenId) {
  await ensureActor(env, actorUid);
  const req = await env.DB.prepare('SELECT * FROM settlement_reopen_requests WHERE id=?1 AND period_key=?2').bind(reopenId, periodKey).first();
  if (!req) throw new DomainError('REOPEN_REQUEST_NOT_FOUND', 404);
  if (req.state !== 'PENDING') throw new DomainError('ALREADY_FINALIZED', 400);
  if (req.requested_by === actorUid) throw new DomainError('SELF_APPROVAL_REJECTED', 400);
  const approvedAt = nowIso();
  const after = { ...req, state: 'APPROVED', approved_by: actorUid, approved_at: approvedAt, approval_request_id: requestId };
  const update = env.DB.prepare(`UPDATE settlement_reopen_requests SET state='APPROVED',approved_by=?1,approved_at=?2,approval_request_id=?3 WHERE id=?4 AND period_key=?5 AND state='PENDING' AND requested_by<>?1`).bind(actorUid, approvedAt, requestId, reopenId, periodKey);
  const history = env.DB.prepare(`INSERT INTO settlement_reopen_history(id,period_key,reopen_request_id,reason,requested_by,approved_by,requested_at,approved_at,request_id)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE EXISTS (SELECT 1 FROM settlement_reopen_requests WHERE id=?3 AND state='APPROVED' AND approval_request_id=?9)`).bind(newId('reopen-history'), periodKey, reopenId, req.reason, req.requested_by, actorUid, req.requested_at, approvedAt, requestId);
  const audit = auditStatementWhen(env, 'settlement_reopen_request', reopenId, 'UPDATE', actorUid, req, after, env.RUN_MARKER, `${requestId}:audit`, approvedAt,
    'EXISTS (SELECT 1 FROM settlement_reopen_history WHERE reopen_request_id=?10 AND request_id=?11)', [reopenId, requestId]);
  const results = await executeBatch(env, [update, history, audit]);
  if (Number(results[0]?.meta?.changes) !== 1 || Number(results[1]?.meta?.changes) !== 1 || Number(results[2]?.meta?.changes) !== 1) throw new DomainError('TRANSACTION_FAILED', 409);
  return after;
}
export async function listSettlementReopenRequests(env, periodKey) {
  return (await env.DB.prepare('SELECT * FROM settlement_reopen_requests WHERE period_key=?1 ORDER BY requested_at ASC,id ASC').bind(periodKey).all()).results || [];
}
