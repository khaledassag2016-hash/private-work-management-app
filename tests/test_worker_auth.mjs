import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

import {
  AppAuthorizationError,
  TokenVerificationError,
  authorizeProvisionedUid,
  verifyFirebaseLikeToken,
} from "../prototype/worker_auth/auth.mjs";

globalThis.crypto ??= webcrypto;

function encodeBase64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function encodeJson(value) {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function fixture() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return { keyPair, publicJwk };
}

async function signToken({
  privateKey,
  projectId = "demo-project",
  uid = "uid-person-1",
  now = 2_000_000_000,
  overrides = {},
}) {
  const header = { alg: "RS256", kid: "test-key", typ: "JWT" };
  const payload = {
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: uid,
    iat: now - 30,
    exp: now + 3600,
    ...overrides,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

test("valid signed token for a provisioned UID is accepted", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({ privateKey: keyPair.privateKey });
  const payload = await verifyFirebaseLikeToken({
    token,
    projectId: "demo-project",
    publicJwk,
    nowSeconds: 2_000_000_000,
  });
  assert.equal(
    authorizeProvisionedUid(payload, new Set(["uid-person-1", "uid-person-2"])),
    "uid-person-1",
  );
});

test("valid token for an unprovisioned UID is denied", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({
    privateKey: keyPair.privateKey,
    uid: "uid-public",
  });
  const payload = await verifyFirebaseLikeToken({
    token,
    projectId: "demo-project",
    publicJwk,
    nowSeconds: 2_000_000_000,
  });
  assert.throws(
    () => authorizeProvisionedUid(payload, new Set(["uid-person-1", "uid-person-2"])),
    AppAuthorizationError,
  );
});

test("tampered token signature is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({ privateKey: keyPair.privateKey });
  const parts = token.split(".");
  parts[1] = encodeJson({
    aud: "demo-project",
    iss: "https://securetoken.google.com/demo-project",
    sub: "uid-person-2",
    iat: 1_999_999_970,
    exp: 2_000_003_600,
  });
  await assert.rejects(
    verifyFirebaseLikeToken({
      token: parts.join("."),
      projectId: "demo-project",
      publicJwk,
      nowSeconds: 2_000_000_000,
    }),
    TokenVerificationError,
  );
});

test("expired or wrong-audience token is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  const expired = await signToken({
    privateKey: keyPair.privateKey,
    overrides: { exp: 1_999_999_999 },
  });
  await assert.rejects(
    verifyFirebaseLikeToken({
      token: expired,
      projectId: "demo-project",
      publicJwk,
      nowSeconds: 2_000_000_000,
    }),
    TokenVerificationError,
  );

  const wrongAudience = await signToken({
    privateKey: keyPair.privateKey,
    overrides: { aud: "other-project" },
  });
  await assert.rejects(
    verifyFirebaseLikeToken({
      token: wrongAudience,
      projectId: "demo-project",
      publicJwk,
      nowSeconds: 2_000_000_000,
    }),
    TokenVerificationError,
  );
});
