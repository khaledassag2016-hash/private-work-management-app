import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AppAuthorizationError,
  GooglePublicKeyCache,
  StaticPublicKeyProvider,
  TokenVerificationError,
  authorizeProvisionedUid,
  requirePrivateApiAuthorization,
  verifyFirebaseIdToken,
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

function pem(label, bytes) {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function privateKeyPemToBytes(privateKeyPem) {
  const keyLabel = ["PRIVATE", "KEY"].join(" ");
  const match = privateKeyPem.match(
    new RegExp(`-----BEGIN ${keyLabel}-----([\\s\\S]+?)-----END ${keyLabel}-----`),
  );
  assert.ok(match, "OpenSSL must emit an unencrypted PKCS#8 private key");
  return Uint8Array.from(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
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
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  return { keyPair, publicJwk, publicKeyPem: pem("PUBLIC KEY", spki) };
}

async function x509Fixture() {
  const directory = mkdtempSync(join(tmpdir(), "s2-x509-"));
  const privateKeyPath = join(directory, "private-key.pem");
  const certificatePath = join(directory, "certificate.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-subj",
        "/CN=s2-firebase-x509-test",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
      ],
      { stdio: "ignore" },
    );
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      privateKeyPemToBytes(readFileSync(privateKeyPath, "utf8")),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const certificatePem = readFileSync(certificatePath, "utf8");
    assert.match(certificatePem, /-----BEGIN CERTIFICATE-----/);
    return { privateKey, certificatePem };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function signToken({
  privateKey,
  projectId = "demo-project",
  uid = "uid-person-1",
  now = 2_000_000_000,
  headerOverrides = {},
  payloadOverrides = {},
}) {
  const header = { alg: "RS256", kid: "test-key", typ: "JWT", ...headerOverrides };
  const payload = {
    aud: projectId,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: uid,
    iat: now - 30,
    auth_time: now - 60,
    exp: now + 3600,
    ...payloadOverrides,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function provider(publicJwk, kid = "test-key") {
  return new StaticPublicKeyProvider({ [kid]: publicJwk });
}

async function expectRejected(options) {
  await assert.rejects(verifyFirebaseIdToken(options), TokenVerificationError);
}

test("valid signed token for a provisioned UID is accepted", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({ privateKey: keyPair.privateKey });
  const uid = await requirePrivateApiAuthorization({
    token,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    provisionedUids: new Set(["uid-person-1", "uid-person-2"]),
    nowSeconds: 2_000_000_000,
  });
  assert.equal(uid, "uid-person-1");
});

test("valid token for an unprovisioned UID is denied", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({ privateKey: keyPair.privateKey, uid: "uid-public" });
  const payload = await verifyFirebaseIdToken({
    token,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
  assert.throws(
    () => authorizeProvisionedUid(payload, new Set(["uid-person-1", "uid-person-2"])),
    AppAuthorizationError,
  );
});

test("kid selects the matching cached Google public key and obeys max-age", async () => {
  const first = await fixture();
  const second = await fixture();
  const token = await signToken({
    privateKey: second.keyPair.privateKey,
    headerOverrides: { kid: "rotated-key" },
  });
  let fetchCount = 0;
  let nowMilliseconds = 10_000;
  const keyCache = new GooglePublicKeyCache({
    nowMilliseconds: () => nowMilliseconds,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({
          "old-key": first.publicKeyPem,
          "rotated-key": second.publicKeyPem,
        }),
        { status: 200, headers: { "Cache-Control": "public, max-age=120" } },
      );
    },
  });
  await verifyFirebaseIdToken({
    token,
    projectId: "demo-project",
    keyProvider: keyCache,
    nowSeconds: 2_000_000_000,
  });
  await verifyFirebaseIdToken({
    token,
    projectId: "demo-project",
    keyProvider: keyCache,
    nowSeconds: 2_000_000_000,
  });
  assert.equal(fetchCount, 1);
  nowMilliseconds += 121_000;
  await keyCache.getPublicKey("rotated-key");
  assert.equal(fetchCount, 2);
});

test("X.509 certificate path verifies a signed token through GooglePublicKeyCache", async () => {
  const { privateKey, certificatePem } = await x509Fixture();
  const token = await signToken({
    privateKey,
    headerOverrides: { kid: "x509-test-key" },
  });
  let fetchCount = 0;
  const keyCache = new GooglePublicKeyCache({
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(
        JSON.stringify({ "x509-test-key": certificatePem }),
        { status: 200, headers: { "Cache-Control": "public, max-age=300" } },
      );
    },
  });
  const payload = await verifyFirebaseIdToken({
    token,
    projectId: "demo-project",
    keyProvider: keyCache,
    nowSeconds: 2_000_000_000,
  });
  assert.equal(payload.sub, "uid-person-1");
  assert.equal(fetchCount, 1);
});

test("missing or unknown kid is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  const missingKid = await signToken({
    privateKey: keyPair.privateKey,
    headerOverrides: { kid: undefined },
  });
  await expectRejected({
    token: missingKid,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });

  const unknownKid = await signToken({
    privateKey: keyPair.privateKey,
    headerOverrides: { kid: "unknown" },
  });
  await expectRejected({
    token: unknownKid,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
});

test("auth_time missing or in the future is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  const missing = await signToken({
    privateKey: keyPair.privateKey,
    payloadOverrides: { auth_time: undefined },
  });
  await expectRejected({
    token: missing,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
  const future = await signToken({
    privateKey: keyPair.privateKey,
    payloadOverrides: { auth_time: 2_000_000_001 },
  });
  await expectRejected({
    token: future,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
});

test("wrong issuer is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({
    privateKey: keyPair.privateKey,
    payloadOverrides: { iss: "https://securetoken.google.com/other-project" },
  });
  await expectRejected({
    token,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
});

test("algorithm other than RS256 is rejected before key use", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({
    privateKey: keyPair.privateKey,
    headerOverrides: { alg: "HS256" },
  });
  await expectRejected({
    token,
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
});

test("missing or empty sub is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  for (const sub of [undefined, ""]) {
    const token = await signToken({
      privateKey: keyPair.privateKey,
      payloadOverrides: { sub },
    });
    await expectRejected({
      token,
      projectId: "demo-project",
      keyProvider: provider(publicJwk),
      nowSeconds: 2_000_000_000,
    });
  }
});

test("tampered token signature is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  const token = await signToken({ privateKey: keyPair.privateKey });
  const parts = token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  parts[1] = encodeJson({ ...payload, sub: "uid-person-2" });
  await expectRejected({
    token: parts.join("."),
    projectId: "demo-project",
    keyProvider: provider(publicJwk),
    nowSeconds: 2_000_000_000,
  });
});

test("expired, future-issued, or wrong-audience token is rejected", async () => {
  const { keyPair, publicJwk } = await fixture();
  for (const payloadOverrides of [
    { exp: 1_999_999_999 },
    { iat: 2_000_000_001 },
    { aud: "other-project" },
  ]) {
    const token = await signToken({ privateKey: keyPair.privateKey, payloadOverrides });
    await expectRejected({
      token,
      projectId: "demo-project",
      keyProvider: provider(publicJwk),
      nowSeconds: 2_000_000_000,
    });
  }
});

test("public-key retrieval or cache metadata failure fails closed", async () => {
  const { keyPair } = await fixture();
  const token = await signToken({ privateKey: keyPair.privateKey });
  for (const fetchImpl of [
    async () => {
      throw new Error("network down");
    },
    async () => new Response("{}", { status: 503 }),
    async () => new Response(JSON.stringify({ "test-key": "bad" }), { status: 200 }),
  ]) {
    await expectRejected({
      token,
      projectId: "demo-project",
      keyProvider: new GooglePublicKeyCache({ fetchImpl }),
      nowSeconds: 2_000_000_000,
    });
  }
});
