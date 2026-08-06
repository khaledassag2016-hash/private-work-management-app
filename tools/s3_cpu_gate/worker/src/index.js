const DEFAULT_CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certificateCache = { expiresAt: 0, certificates: null };

function reject(status, code, requestId, cacheState = 'none', runMarker = '') {
  console.log(JSON.stringify({ event: 'auth_result', requestId, code, cacheState, allowed: false, runMarker }));
  return Response.json({ ok: false, code, requestId }, { status });
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
export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID(); const url = new URL(request.url);
    if (url.pathname === '/__test/reset-cache') {
      if (env.TEST_CONTROLS !== 'enabled') return reject(404, 'NOT_FOUND', requestId, 'none', env.RUN_MARKER);
      if (!env.TEST_RESET_NONCE || request.headers.get('x-s3-test-reset') !== env.TEST_RESET_NONCE) return reject(403, 'TEST_CONTROL_DENIED', requestId, 'none', env.RUN_MARKER);
      certificateCache = { expiresAt: 0, certificates: null };
      return Response.json({ ok: true, requestId });
    }
    if (url.pathname !== '/private/ping') return reject(404, 'NOT_FOUND', requestId, 'none', env.RUN_MARKER);
    const auth = request.headers.get('authorization') || '';
    if (!auth.startsWith('Bearer ')) return reject(401, 'TOKEN_MISSING', requestId, 'none', env.RUN_MARKER);
    try {
      const verified = await verifyJwt(auth.slice(7), env); const user = await allowed(env, verified.claims.sub);
      if (!user) return reject(403, 'UID_NOT_ALLOWED', requestId, verified.cacheState, env.RUN_MARKER);
      console.log(JSON.stringify({ event: 'auth_result', requestId, code: 'ALLOW', cacheState: verified.cacheState, allowed: true, runMarker: env.RUN_MARKER, uidHash: await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verified.claims.sub)).then(x => Array.from(new Uint8Array(x)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')) }));
      return Response.json({ ok: true, requestId, role: user.role });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'AUTH_FAILED';
      return reject(401, code, requestId, 'none', env.RUN_MARKER);
    }
  }
};
