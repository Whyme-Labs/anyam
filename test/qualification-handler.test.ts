import assert from "node:assert/strict";
import test from "node:test";

import { handleAnyamGitHubAppQualificationRequest } from "../apps/realm-worker/src/qualification-handler.ts";
import type { AnyamRealmMcpEnv, AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { ANYAM_GITHUB_APP_QUALIFICATION_PATH, ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, ANYAM_GITHUB_APP_QUALIFICATION_SCOPE } from "../apps/realm-worker/src/qualification-protocol.ts";

function fixture() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const env = {
    ANYAM_INSTALLATION_ID: "qualification",
    REALM_COORDINATOR: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async (request: Request) => {
        calls.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
        return new Response(JSON.stringify({ status: "succeeded", receipt: "qualification=fixture; credentialMaterialStored=false" }), { status: 200, headers: { "content-type": "application/json" } });
      } }),
    },
  } as unknown as AnyamRealmMcpEnv;
  const props: AnyamRealmMcpProps = { realmId: "realm:qualification", kernelSessionId: "session:owner", scopes: [ANYAM_GITHUB_APP_QUALIFICATION_SCOPE], mcpResource: "https://realm.example/mcp" };
  return { env, props, calls };
}

test("OAuth qualification capability forwards only the typed owner operation to Authority", async () => {
  const { env, props, calls } = fixture();
  const response = await handleAnyamGitHubAppQualificationRequest(new Request(`https://realm.example${ANYAM_GITHUB_APP_QUALIFICATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer never-returned" },
    body: JSON.stringify({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, operation: "authority.project.create", idempotencyKey: "qualification:project", payload: { projectId: "project:disposable" } }),
  }), env, props);
  assert.ok(response);
  assert.equal(response.status, 200);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.qualificationCapability, ANYAM_GITHUB_APP_QUALIFICATION_SCOPE);
  assert.equal(JSON.stringify(value).includes("never-returned"), false);
  assert.deepEqual(calls[0], { path: "/authority/command/internal", body: { protocol: "anyam.authority-command/v1", command: "project.create", idempotencyKey: "qualification:project", payload: { projectId: "project:disposable" }, sessionId: "session:owner" } });
});

test("OAuth qualification capability fails closed without its dedicated scope", async () => {
  const { env, props } = fixture();
  const response = await handleAnyamGitHubAppQualificationRequest(new Request(`https://realm.example${ANYAM_GITHUB_APP_QUALIFICATION_PATH}`, { method: "POST", body: JSON.stringify({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, operation: "authority.state.inspect" }) }), env, { ...props, scopes: ["project.read"] });
  assert.ok(response);
  assert.equal(response.status, 403);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "scope_denied");
  assert.match(String(value.receipt), /qualification\.github-app/u);
});

test("OAuth qualification capability rejects provider credential material before Coordinator dispatch", async () => {
  const { env, props, calls } = fixture();
  const response = await handleAnyamGitHubAppQualificationRequest(new Request(`https://realm.example${ANYAM_GITHUB_APP_QUALIFICATION_PATH}`, {
    method: "POST",
    body: JSON.stringify({ protocol: ANYAM_GITHUB_APP_QUALIFICATION_PROTOCOL, operation: "authority.state.inspect", accessToken: "must-not-cross" }),
  }), env, props);
  assert.ok(response);
  assert.equal(response.status, 422);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "credential_material_rejected");
  assert.equal(calls.length, 0);
  assert.equal(JSON.stringify(value).includes("must-not-cross"), false);
});
