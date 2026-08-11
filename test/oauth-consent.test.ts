import assert from "node:assert/strict";
import test from "node:test";

import { intersectOAuthScopes, isOAuthConsentDecision, oauthConsentBindingMatches } from "../src/identity/oauth-consent.ts";

test("OAuth consent grants only the requested/allowed intersection in request order", () => {
  assert.deepEqual(intersectOAuthScopes(["run.invoke", "source.read", "run.invoke", "admin"], ["source.read", "project.read", "run.invoke"]), ["run.invoke", "source.read"]);
});

test("OAuth consent binding rejects a different session or CSRF token", () => {
  const record = { realmId: "realm:test", principalId: "owner:test", sessionId: "session:test", csrfToken: "csrf:test" } as const;
  assert.equal(oauthConsentBindingMatches(record, { realmId: "realm:test", principalId: "owner:test", sessionId: "session:test" }), true);
  assert.equal(oauthConsentBindingMatches(record, { realmId: "realm:test", principalId: "owner:test", sessionId: "session:other" }), false);
  assert.equal(oauthConsentBindingMatches(record, { realmId: "realm:test", principalId: "owner:test", sessionId: "session:test", csrfToken: "csrf:other" }), false);
});

test("OAuth consent decision parser fails closed", () => {
  assert.equal(isOAuthConsentDecision("approve"), true);
  assert.equal(isOAuthConsentDecision("deny"), true);
  assert.equal(isOAuthConsentDecision("edit"), false);
  assert.equal(isOAuthConsentDecision(null), false);
});
