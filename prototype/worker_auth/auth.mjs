export class TokenVerificationError extends Error {}
export class AppAuthorizationError extends Error {}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJsonSegment(segment) {
  const bytes = decodeBase64Url(segment);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function verifyFirebaseLikeToken({ token, projectId, publicJwk, nowSeconds }) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenVerificationError("malformed JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonSegment(encodedHeader);
  const payload = decodeJsonSegment(encodedPayload);
  if (header.alg !== "RS256") {
    throw new TokenVerificationError("unexpected JWT algorithm");
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = decodeBase64Url(encodedSignature);
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signingInput,
  );
  if (!validSignature) {
    throw new TokenVerificationError("invalid JWT signature");
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.aud !== projectId || payload.iss !== expectedIssuer) {
    throw new TokenVerificationError("unexpected JWT audience or issuer");
  }
  if (!Number.isInteger(payload.exp) || payload.exp <= now) {
    throw new TokenVerificationError("expired JWT");
  }
  if (!Number.isInteger(payload.iat) || payload.iat > now + 60) {
    throw new TokenVerificationError("invalid JWT issued-at time");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new TokenVerificationError("missing Firebase UID");
  }
  return payload;
}

export function authorizeProvisionedUid(payload, provisionedUids) {
  if (!provisionedUids.has(payload.sub)) {
    throw new AppAuthorizationError("UID is not provisioned for this private app");
  }
  return payload.sub;
}
