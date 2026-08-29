import assert from "node:assert/strict";
import test from "node:test";

import { intersectOAuthScopes, isOAuthConsentDecision, oauthConsentBindingMatches, oauthConsentContentSecurityPolicy } from "../src/identity/oauth-consent.ts";
import { renderOAuthConsentPage } from "../src/identity/oauth-consent-page.ts";
import { isAnyamOAuthPath } from "../src/cloudflare/oauth-path.ts";

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

test("OAuth consent allows the registered loopback redirect and prevents duplicate submissions", async () => {
  const redirectUri = "http://127.0.0.1:62026/oauth/callback";
  const response = renderOAuthConsentPage({
    consentId: "consent:test",
    csrfToken: "csrf:test",
    clientName: "Anyam CLI",
    requestedScopes: ["qualification.github-app"],
    allowedScopes: ["qualification.github-app"],
    redirectUri,
  });
  assert.equal(response.status, 200);
  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  assert.match(contentSecurityPolicy, /^default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-[A-Za-z0-9_-]+'; form-action 'self' http:\/\/127\.0\.0\.1:62026; base-uri 'none'$/u);
  const html = await response.text();
  assert.match(html, /id="oauth-consent-form"/u);
  assert.match(html, /addEventListener\("submit"/u);
  assert.match(html, /event\.submitter/u);
  assert.match(html, /form\.dataset\.submitting/u);
  assert.match(html, /if \(button !== submitter\) button\.disabled = true/u);
  assert.equal(oauthConsentContentSecurityPolicy(redirectUri, "nonce-test"), "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-nonce-test'; form-action 'self' http://127.0.0.1:62026; base-uri 'none'");
});

test("OAuth routing includes the authenticated MCP qualification subtree", () => {
  assert.equal(isAnyamOAuthPath("/mcp"), true);
  assert.equal(isAnyamOAuthPath("/mcp/qualification/github-app"), true);
  assert.equal(isAnyamOAuthPath("/mcp-not-a-resource"), false);
});
