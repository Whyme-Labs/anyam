import assert from "node:assert/strict";
import test from "node:test";

import { AnyamAuthError, loadAnyamAuthCredential, logoutAnyam } from "../packages/create-anyam/src/auth.ts";

const stored = JSON.stringify({ refreshToken: "refresh-secret", accessToken: "access-token", expiresAt: "2099-01-01T00:00:00.000Z", clientId: "client:test", scope: "qualification.github-app", resource: "https://realm.example/mcp" });

test("Anyam auth loads a valid OAuth access token from the OS-keychain adapter without returning refresh material", async () => {
  const result = await loadAnyamAuthCredential({ realm: "https://realm.example", readSecret: async () => stored, now: () => Date.parse("2026-08-29T00:00:00.000Z") });
  assert.equal(result.accessToken, "access-token");
  assert.equal(result.credentialStorage, "os-keychain");
  assert.equal(result.scope, "qualification.github-app");
  assert.equal(JSON.stringify(result).includes("refresh-secret"), false);
  assert.match(result.receipt, /source=os-keychain/u);
});

test("Anyam auth refreshes an expired keychain access token and rotates the stored refresh record", async () => {
  let saved = "";
  const result = await loadAnyamAuthCredential({
    realm: "https://realm.example",
    readSecret: async () => JSON.stringify({ ...JSON.parse(stored), expiresAt: "2020-01-01T00:00:00.000Z" }),
    storeSecret: async (_service, _account, value) => { saved = value; },
    fetchImpl: async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 600 }), { status: 200, headers: { "content-type": "application/json" } }),
    now: () => Date.parse("2026-08-29T00:00:00.000Z"),
  });
  assert.equal(result.accessToken, "fresh-access");
  assert.equal(result.expiresAt, "2026-08-29T00:10:00.000Z");
  assert.equal(JSON.parse(saved).refreshToken, "fresh-refresh");
  assert.match(result.receipt, /refresh=observed-or-refreshed/u);
});

test("Anyam auth treats an invalid stored expiry as stale and refreshes it", async () => {
  const result = await loadAnyamAuthCredential({
    realm: "https://realm.example",
    readSecret: async () => JSON.stringify({ ...JSON.parse(stored), expiresAt: "not-a-timestamp" }),
    storeSecret: async () => undefined,
    fetchImpl: async () => new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 600 }), { status: 200 }),
    now: () => Date.parse("2026-08-29T00:00:00.000Z"),
  });
  assert.equal(result.accessToken, "fresh-access");
});

test("Anyam auth logout deletes only the Realm keychain record", async () => {
  let deleted = "";
  const result = await logoutAnyam({ realm: "https://realm.example", readSecret: async () => undefined, deleteSecret: async (service, account) => { deleted = `${service}:${account}`; return true; } });
  assert.equal(result.status, "logged-out");
  assert.equal(deleted, "anyam.oauth.refresh:https://realm.example");
  assert.match(result.receipt, /deleted=true/u);
});

test("Anyam auth logout confirms provider revocation before deleting a stored credential", async () => {
  let deleted = false;
  const result = await logoutAnyam({
    realm: "https://realm.example",
    readSecret: async () => stored,
    deleteSecret: async () => { deleted = true; return true; },
    fetchImpl: async (_url, init) => {
      assert.match(String(init?.body), /token_type_hint=refresh_token/u);
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });
  assert.equal(deleted, true);
  assert.match(result.receipt, /revocation=confirmed/u);
});

test("Anyam auth reports a missing keychain record as an actionable qualification blocker", async () => {
  await assert.rejects(
    () => loadAnyamAuthCredential({ realm: "https://realm.example", readSecret: async () => undefined }),
    (error: unknown) => error instanceof AnyamAuthError && error.code === "auth.keychain_record_missing" && error.recoveryAction.includes("anyam auth login"),
  );
});
