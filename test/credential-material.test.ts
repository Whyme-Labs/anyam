import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialMaterialReceipt,
  isCredentialFree,
  scanCredentialMaterial,
  containsKnownTextMaterial,
} from "../src/security/credential-material.ts";

test("the shared scanner accepts redacted markers and non-secret metadata", () => {
  assert.equal(isCredentialFree({ credentialFree: true, credentialMaterialStored: false, providerCredentials: "brokered-only", tokenCount: 2, secretUseAliases: ["payments-staging"], accessToken: "not-printed" }), true);
  assert.equal(scanCredentialMaterial("qualification=provider-token-refresh; provider=fixture"), undefined);
});

test("the shared scanner rejects compound sensitive keys regardless of casing or separators", () => {
  const keys = ["token", "accessToken", "access_token", "ACCESS-TOKEN", "refreshToken", "providerToken", "githubToken", "secret", "clientSecret", "apiKey", "password", "authorization", "privateKey", "webhook-secret", "credentials"];
  for (const key of keys) {
    const finding = scanCredentialMaterial({ envelope: [{ [key]: "real-secret-value" }] });
    assert.equal(finding?.kind, "sensitive-key", key);
    assert.equal(finding?.path, `value.envelope[0].${key}`, key);
  }
});

test("the shared scanner detects header, token, PEM, URL, and encoded credential shapes", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Bearer", "AUTHORIZATION :   Bearer abcdefghijklmnop"],
    ["Basic", "Basic dXNlcjpwYXNz"],
    ["JWT", "eyJhbGciOiJFZDI1NTE5In0.eyJzdWIiOiIxIn0.signature"],
    ["PEM", "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"],
    ["cloud token", "cfat_abcdefghijklmnop"],
    ["userinfo URL", "https://user:password@example.test/callback"],
    ["assignment", "provider_token = actual-secret"],
    ["percent encoding", "%61ccessToken%3Dactual-secret"],
    ["base64 encoding", Buffer.from("accessToken=actual-secret", "utf8").toString("base64")],
  ];
  for (const [label, value] of cases) assert.ok(scanCredentialMaterial(value), label);
});

test("scanner receipts expose only a path and category, never the matched value", () => {
  const secret = "cfat_super-secret-value-123456";
  const finding = scanCredentialMaterial({ nested: { providerToken: secret } });
  assert.ok(finding);
  const receipt = credentialMaterialReceipt(finding, "return a digest-only receipt");
  assert.match(receipt, /scanner=anyam\.credential-material-scanner\/v1/u);
  assert.match(receipt, /field=value\.nested\.providerToken/u);
  assert.equal(receipt.includes(secret), false);
});

test("known handle matching covers every Base64 substring alignment and one URI layer", () => {
  const handle = "session:synthetic-known-handle";
  const matches = (value: unknown) => containsKnownTextMaterial(value, text => text.includes(handle));
  for (const encoding of ["base64", "base64url"] as const) for (const prefix of ["", "p", "pr", "pre", "prefix"]) {
    const alias = prefix + Buffer.from(handle).toString(encoding) + "suffix";
    assert.equal(matches([alias]), true); assert.equal(matches({ [alias]: "key" }), true);
  }
  assert.equal(matches(`prefix${encodeURIComponent(handle)}suffix`), true);
  assert.equal(matches({ reference: "session:ordinary", digest: "sha256:" + "a".repeat(64) }), false);
  const cycle: { value: string; self?: unknown } = { value: "safe" }; cycle.self = cycle;
  assert.equal(matches(cycle), false);
  const twice = Buffer.from(Buffer.from(handle).toString("base64")).toString("base64");
  assert.equal(matches(twice), false, "only the documented single layer is decoded");
});
