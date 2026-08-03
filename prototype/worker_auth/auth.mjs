export class TokenVerificationError extends Error {}
export class AppAuthorizationError extends Error {}

export const FIREBASE_PUBLIC_CERTS_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

function decodeBase64Url(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TokenVerificationError("invalid base64url segment");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new TokenVerificationError("invalid base64url segment");
  }
}

function decodeJsonSegment(segment) {
  try {
    const bytes = decodeBase64Url(segment);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof TokenVerificationError) throw error;
    throw new TokenVerificationError("invalid JWT JSON segment");
  }
}

function parseCacheControlMaxAge(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function pemBodyToBytes(pem) {
  if (typeof pem !== "string") {
    throw new TokenVerificationError("public key is not PEM text");
  }
  const match = pem.match(
    /-----BEGIN (CERTIFICATE|PUBLIC KEY)-----([\s\S]+?)-----END \1-----/,
  );
  if (!match) {
    throw new TokenVerificationError("unsupported public key PEM");
  }
  try {
    const binary = atob(match[2].replace(/\s+/g, ""));
    return {
      kind: match[1],
      bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    };
  } catch {
    throw new TokenVerificationError("invalid public key PEM");
  }
}

function readDerElement(bytes, offset) {
  if (offset >= bytes.length) {
    throw new TokenVerificationError("truncated DER public certificate");
  }
  const start = offset;
  const tag = bytes[offset++];
  if (offset >= bytes.length) {
    throw new TokenVerificationError("truncated DER length");
  }
  let length = bytes[offset++];
  if ((length & 0x80) !== 0) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || offset + lengthBytes > bytes.length) {
      throw new TokenVerificationError("invalid DER length");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + bytes[offset++];
    }
  }
  const contentStart = offset;
  const end = contentStart + length;
  if (end > bytes.length) {
    throw new TokenVerificationError("truncated DER element");
  }
  return { tag, start, contentStart, end };
}

function extractSubjectPublicKeyInfo(certificateBytes) {
  const certificate = readDerElement(certificateBytes, 0);
  if (certificate.tag !== 0x30 || certificate.end !== certificateBytes.length) {
    throw new TokenVerificationError("invalid X.509 certificate sequence");
  }
  const tbsCertificate = readDerElement(certificateBytes, certificate.contentStart);
  if (tbsCertificate.tag !== 0x30) {
    throw new TokenVerificationError("invalid X.509 tbsCertificate");
  }
  let cursor = tbsCertificate.contentStart;
  let element = readDerElement(certificateBytes, cursor);
  if (element.tag === 0xa0) {
    cursor = element.end;
  }
  // serialNumber, signature, issuer, validity, subject
  for (let index = 0; index < 5; index += 1) {
    element = readDerElement(certificateBytes, cursor);
    cursor = element.end;
  }
  const subjectPublicKeyInfo = readDerElement(certificateBytes, cursor);
  if (subjectPublicKeyInfo.tag !== 0x30) {
    throw new TokenVerificationError("missing X.509 subjectPublicKeyInfo");
  }
  return certificateBytes.slice(subjectPublicKeyInfo.start, subjectPublicKeyInfo.end);
}

async function importVerificationKey(publicKey) {
  try {
    if (typeof CryptoKey !== "undefined" && publicKey instanceof CryptoKey) return publicKey;
    if (typeof publicKey === "object" && publicKey !== null) {
      return await crypto.subtle.importKey(
        "jwk",
        publicKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    }
    const { kind, bytes } = pemBodyToBytes(publicKey);
    const spki = kind === "CERTIFICATE" ? extractSubjectPublicKeyInfo(bytes) : bytes;
    return await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch (error) {
    if (error instanceof TokenVerificationError) throw error;
    throw new TokenVerificationError("unable to import Firebase public key");
  }
}

export class GooglePublicKeyCache {
  constructor({
    fetchImpl = fetch,
    certsUrl = FIREBASE_PUBLIC_CERTS_URL,
    nowMilliseconds = () => Date.now(),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.certsUrl = certsUrl;
    this.nowMilliseconds = nowMilliseconds;
    this.keys = new Map();
    this.expiresAtMilliseconds = 0;
  }

  async refresh() {
    let response;
    try {
      response = await this.fetchImpl(this.certsUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch {
      throw new TokenVerificationError("Firebase public key fetch failed");
    }
    if (!response?.ok) {
      throw new TokenVerificationError("Firebase public key endpoint rejected request");
    }

    const maxAge = parseCacheControlMaxAge(response.headers?.get("Cache-Control"));
    if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
      throw new TokenVerificationError("Firebase public key response lacks valid max-age");
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new TokenVerificationError("Firebase public key response is invalid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TokenVerificationError("Firebase public key response is invalid");
    }
    const entries = Object.entries(body).filter(
      ([kid, pem]) => typeof kid === "string" && kid.length > 0 && typeof pem === "string",
    );
    if (entries.length === 0) {
      throw new TokenVerificationError("Firebase public key response is empty");
    }

    this.keys = new Map(entries);
    this.expiresAtMilliseconds = this.nowMilliseconds() + maxAge * 1000;
  }

  async getPublicKey(kid) {
    if (typeof kid !== "string" || kid.length === 0) {
      throw new TokenVerificationError("missing Firebase key ID");
    }
    const now = this.nowMilliseconds();
    if (this.keys.size === 0 || now >= this.expiresAtMilliseconds) {
      await this.refresh();
    }
    if (!this.keys.has(kid)) {
      // Rotation can introduce a new kid before a previously cached max-age expires.
      await this.refresh();
    }
    const key = this.keys.get(kid);
    if (!key) {
      throw new TokenVerificationError("unknown Firebase key ID");
    }
    return key;
  }
}

export class StaticPublicKeyProvider {
  constructor(keys) {
    this.keys = new Map(Object.entries(keys));
  }

  async getPublicKey(kid) {
    if (typeof kid !== "string" || kid.length === 0) {
      throw new TokenVerificationError("missing Firebase key ID");
    }
    const key = this.keys.get(kid);
    if (!key) throw new TokenVerificationError("unknown Firebase key ID");
    return key;
  }
}

export async function verifyFirebaseIdToken({
  token,
  projectId,
  keyProvider,
  nowSeconds,
}) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new TokenVerificationError("missing Firebase project ID");
  }
  if (!keyProvider || typeof keyProvider.getPublicKey !== "function") {
    throw new TokenVerificationError("missing Firebase public key provider");
  }
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) {
    throw new TokenVerificationError("malformed JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonSegment(encodedHeader);
  const payload = decodeJsonSegment(encodedPayload);
  if (header.alg !== "RS256") {
    throw new TokenVerificationError("unexpected JWT algorithm");
  }
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new TokenVerificationError("missing Firebase key ID");
  }

  // The provider must select the public key whose identifier exactly matches header.kid.
  const publicKey = await keyProvider.getPublicKey(header.kid);
  const key = await importVerificationKey(publicKey);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = decodeBase64Url(encodedSignature);
  let validSignature = false;
  try {
    validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      signingInput,
    );
  } catch {
    throw new TokenVerificationError("Firebase signature verification failed");
  }
  if (!validSignature) {
    throw new TokenVerificationError("invalid JWT signature");
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId) {
    throw new TokenVerificationError("unexpected JWT audience");
  }
  if (payload.iss !== expectedIssuer) {
    throw new TokenVerificationError("unexpected JWT issuer");
  }
  if (!Number.isInteger(payload.exp) || payload.exp <= now) {
    throw new TokenVerificationError("expired JWT");
  }
  if (!Number.isInteger(payload.iat) || payload.iat > now) {
    throw new TokenVerificationError("invalid JWT issued-at time");
  }
  if (!Number.isInteger(payload.auth_time) || payload.auth_time > now) {
    throw new TokenVerificationError("invalid JWT authentication time");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new TokenVerificationError("missing Firebase UID");
  }
  return payload;
}

// Backward-compatible export name retained for the S2 prototype callers.
export const verifyFirebaseLikeToken = verifyFirebaseIdToken;

export function authorizeProvisionedUid(payload, provisionedUids) {
  if (!provisionedUids.has(payload.sub)) {
    throw new AppAuthorizationError("UID is not provisioned for this private app");
  }
  return payload.sub;
}

export async function requirePrivateApiAuthorization({
  token,
  projectId,
  keyProvider,
  provisionedUids,
  nowSeconds,
}) {
  // Deliberately no fallback or bypass: any parse, fetch, key, claim, signature,
  // or allowlist failure rejects the API request (fail closed).
  const payload = await verifyFirebaseIdToken({
    token,
    projectId,
    keyProvider,
    nowSeconds,
  });
  return authorizeProvisionedUid(payload, provisionedUids);
}
