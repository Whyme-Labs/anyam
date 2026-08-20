import assert from "node:assert/strict";
import test from "node:test";

import { RealmAuthorityHttpClient, RealmAuthorityRequestError } from "../src/portability/realm-authority-client.ts";

test("Realm Authority client sends the owner session as a host cookie and preserves typed mirror routes", async () => {
  const calls: Array<{ url: string; method: string; cookie: string; body?: Record<string, unknown> }> = [];
  const client = new RealmAuthorityHttpClient({
    baseUrl: "https://realm.example/",
    ownerSession: "session:owner-qualification",
    fetchImpl: async (input, init) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url: String(input), method: init?.method ?? "GET", cookie: new Headers(init?.headers).get("cookie") ?? "", ...(body === undefined ? {} : { body }) });
      return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "succeeded", receipt: "credentialFree=true; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await client.inspectProject("project:qualification");
  await client.createProject({ projectId: "project:qualification" }, "qualification:project");
  await client.createWorkspace("project:qualification", { workspaceId: "workspace:qualification" }, "qualification:workspace");
  await client.configureMirror({ mirrorId: "mirror:qualification", projectId: "project:qualification" }, "qualification:configure");
  await client.syncMirror("mirror:qualification", { operationId: "operation:one" }, "qualification:sync");
  await client.reconcileMirror("mirror:qualification", { reconciliation: "canonical-wins" }, "qualification:reconcile");
  await client.inspectState();
  await client.inspectMirror("mirror:qualification");
  await client.exportAuthoritySnapshot();
  await client.restoreAuthoritySnapshot({ credentialFree: true });
  await client.command({ command: "release.create", payload: { projectId: "project:qualification" }, idempotencyKey: "qualification:release" });

  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ["GET", "/api/projects/project%3Aqualification"],
    ["POST", "/api/projects"],
    ["POST", "/api/projects/project%3Aqualification/workspaces"],
    ["POST", "/api/mirrors"],
    ["POST", "/api/mirrors/mirror%3Aqualification/sync"],
    ["POST", "/api/mirrors/mirror%3Aqualification/reconcile"],
    ["GET", "/api/authority/state"],
    ["GET", "/api/mirrors/mirror%3Aqualification"],
    ["POST", "/api/authority/recovery/export"],
    ["POST", "/api/authority/recovery/restore"],
    ["POST", "/api/authority/command"],
  ]);
  assert.equal(calls[0]?.cookie, "anyam_owner_session=session%3Aowner-qualification");
  assert.equal(calls[1]?.body?.projectId, "project:qualification");
  assert.equal(calls[2]?.body?.workspaceId, "workspace:qualification");
  assert.equal(calls[3]?.body?.mirrorId, "mirror:qualification");
  assert.equal(calls[4]?.body?.operationId, "operation:one");
  assert.equal(calls[5]?.body?.reconciliation, "canonical-wins");
  assert.equal(calls[9]?.body?.snapshot && (calls[9]?.body?.snapshot as Record<string, unknown>).credentialFree, true);
  assert.equal(calls[10]?.body?.command, "release.create");
  assert.equal(calls[10]?.body?.idempotencyKey, "qualification:release");
});

test("Realm Authority client redacts provider response bodies from typed request errors", async () => {
  const client = new RealmAuthorityHttpClient({
    baseUrl: "https://realm.example",
    ownerSession: "session:owner",
    fetchImpl: async () => new Response(JSON.stringify({ code: "owner_session_rejected", recoveryAction: "authenticate again", receipt: "credentialMaterialStored=false", secret: "do-not-leak" }), { status: 401 }),
  });

  await assert.rejects(
    () => client.inspectState(),
    (error: unknown) => {
      assert.ok(error instanceof RealmAuthorityRequestError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "owner_session_rejected");
      assert.equal(error.receipt, "credentialMaterialStored=false");
      assert.equal(String(error).includes("do-not-leak"), false);
      return true;
    },
  );
});

test("Realm Authority client can inspect an expected blocked command without hiding the typed result", async () => {
  const client = new RealmAuthorityHttpClient({
    baseUrl: "https://realm.example",
    ownerSession: "session:owner",
    fetchImpl: async () => new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "blocked", recoveryAction: "provider handoff is separate", receipt: "promotion=blocked; credentialFree=true" }), { status: 409, headers: { "content-type": "application/json" } }),
  });

  const result = await client.command({ command: "promotion.request", payload: { projectId: "project:qualification" }, idempotencyKey: "qualification:promotion", allowStatuses: [409] });
  assert.equal(result.status, "blocked");
  assert.equal(result.receipt, "promotion=blocked; credentialFree=true");
});

test("Realm Authority client returns expected blocked Mirror checkpoints as typed results", async () => {
  const client = new RealmAuthorityHttpClient({
    baseUrl: "https://realm.example",
    ownerSession: "session:owner",
    fetchImpl: async () => new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "blocked", recoveryAction: "choose canonical-wins after inspecting the explicit remote rewrite", receipt: "mirror=mirror:qualification; operation=force-push; state=blocked; credentialFree=true", value: { mirror: { id: "mirror:qualification", state: "blocked" } } }), { status: 409, headers: { "content-type": "application/json" } }),
  });

  const result = await client.syncMirror("mirror:qualification", { operationId: "operation:force-push" }, "qualification:force-push");
  assert.equal(result.status, "blocked");
  assert.equal((result.value as { mirror: { state: string } }).mirror.state, "blocked");
});

test("Realm Authority client does not reinterpret an unexpected Mirror 409 as a checkpoint", async () => {
  const client = new RealmAuthorityHttpClient({
    baseUrl: "https://realm.example",
    ownerSession: "session:owner",
    fetchImpl: async () => new Response(JSON.stringify({ code: "mirror_conflict", recoveryAction: "read the current Mirror checkpoint", receipt: "mirror=mirror:qualification; conflict=true; credentialFree=true" }), { status: 409, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    () => client.syncMirror("mirror:qualification", { operationId: "operation:unexpected-conflict" }, "qualification:unexpected-conflict"),
    (error: unknown) => error instanceof RealmAuthorityRequestError && error.status === 409 && error.code === "mirror_conflict",
  );
});

test("Realm Authority client refuses insecure remote endpoints and cookie-header injection", () => {
  assert.throws(
    () => new RealmAuthorityHttpClient({ baseUrl: "http://realm.example", ownerSession: "session:owner" }),
    /realm_authority_base_url_must_use_https/,
  );
  assert.throws(
    () => new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "session:owner; anyam_other=bad" }),
    /realm_authority_owner_session_invalid/,
  );
});
