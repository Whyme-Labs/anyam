import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

test("Realm owner Run-detail client returns the accepted contract through one encoded read without request payload", async () => {
  const detail = { protocol: "anyam.owner-run-detail/v1", status: "ready", run: { id: "run:accepted" }, proof: { signatureVerified: true, resultDigest: "sha256:recorded-result" } };
  const calls: { url: string; method: string; body: unknown; cache: unknown; redirect: unknown }[] = [];
  const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-session", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? "", body: options?.body, cache: options?.cache, redirect: options?.redirect });
    return Response.json(detail);
  } });
  assert.deepEqual(await client.inspectRunDetail("run:accepted"), detail);
  assert.deepEqual(calls, [{ url: "https://realm.example/api/authority/run-details/run%3Aaccepted", method: "GET", body: undefined, cache: "no-store", redirect: "error" }]);
});
test("hosted CLI Run detail uses only explicit Session stdin and preserves the accepted owner DTO", async t => {
  const detail = { protocol: "anyam.owner-run-detail/v1", status: "ready", proof: { signatureVerified: true, resultDigest: "sha256:recorded-result" } };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(String(url), "https://realm.example/api/authority/run-details/run%3Aaccepted");
    assert.equal(new Headers(options.headers).get("cookie"), "anyam_owner_session=synthetic-owner");
    assert.equal(options.method, "GET"); assert.equal(options.body, undefined);
    return Response.json(detail);
  });
  const value = await runRealmSourceCommand(["realm", "run", "detail", "--realm", "https://realm.example", "--id", "run:accepted", "--session-stdin", "--json"], Readable.from(["synthetic-owner\n"]));
  assert.deepEqual(value, detail);
});
test("hosted CLI Run detail rejects credential options and unrelated detail commands before reading stdin", async () => {
  for (const extra of [["--owner-session", "PRIVATE-session"], ["--session", "PRIVATE-session"], ["--input", "PRIVATE-path"], ["--id", "duplicate"], ["--unknown", "PRIVATE-field"]]) {
    const input = Readable.from(["PRIVATE-session"]);
    await assert.rejects(() => runRealmSourceCommand(["realm", "run", "detail", "--realm", "https://realm.example", "--id", "run:accepted", "--session-stdin", ...extra], input), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /realm_source_options_invalid/u); assert.doesNotMatch(error.message, /PRIVATE-/u);
      return true;
    });
    assert.equal(input.readableDidRead, false);
  }
  await assert.rejects(() => runRealmSourceCommand(["realm", "revision", "detail"], Readable.from([])), /realm_source_operation_invalid/u);
  await assert.rejects(() => runRealmSourceCommand(["realm", "run", "detail", "--realm", "https://realm.example", "--id", "run:accepted"], Readable.from([])), /supply --session-stdin/u);
});
test("Realm owner Run-detail failure preserves typed status without disclosing response payload or falling back", async () => {
  for (const status of [401, 404, 503]) {
    let calls = 0;
    const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-owner", fetchImpl: async () => {
      calls++; return Response.json({ code: status === 503 ? "run_detail_unavailable" : "not_found", recoveryAction: "inspect current authority", receipt: "detail=unavailable; credentialMaterialStored=false", secret: "PRIVATE-proof-payload" }, { status });
    } });
    await assert.rejects(() => client.inspectRunDetail("run:accepted"), error => {
      assert.ok(error instanceof RealmAuthorityRequestError); assert.equal(error.status, status); assert.doesNotMatch(error.message, /PRIVATE-/u); return true;
    });
    assert.equal(calls, 1);
  }
});
import { runRealmSourceCommand } from "../packages/create-anyam/src/realm-source-command.ts";

import { RealmAuthorityHttpClient, RealmAuthorityRequestError } from "../src/portability/realm-authority-client.ts";

test("Realm Authority client inspects a selected Revision with an encoded selector and no request body", async () => {
  const calls: { url: string; method: string; body: unknown; cache: unknown; redirect: unknown }[] = [];
  const client = new RealmAuthorityHttpClient({ baseUrl: "https://realm.example", ownerSession: "synthetic-session", fetchImpl: async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? "", body: options?.body, cache: options?.cache, redirect: options?.redirect });
    return Response.json({ status: "ready", revision: { id: "revision:public" } });
  } });
  assert.deepEqual(await client.inspectRevision("revision:public"), { status: "ready", revision: { id: "revision:public" } });
  assert.deepEqual(calls, [{ url: "https://realm.example/api/authority/revisions/revision%3Apublic", method: "GET", body: undefined, cache: "no-store", redirect: "error" }]);
});
test("hosted CLI recognizes Revision inspection and requires the documented safe input options", async () => {
  await assert.rejects(() => runRealmSourceCommand(["realm", "revision", "inspect"], Readable.from([])), /realm_source_option_required; supply --realm/u);
});

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
  await client.exportAuthorityRecovery();
  await client.restoreAuthorityRecovery({ protocol: "anyam.authority-recovery/v1", bundleId: "bundle:qualification", bundleDigest: "sha256:bundle" });
  await client.activateAuthorityRecovery("bundle:qualification", "sha256:bundle");
  await client.command({ command: "release.create", payload: { projectId: "project:qualification" }, idempotencyKey: "qualification:release" });
  await client.listIntents("project:qualification");
  await client.inspectIntent("intent:qualification");
  await client.createIntent({ projectId: "project:qualification", title: "Qualification Intent" }, "qualification:intent:create");
  await client.assignIntent("intent:qualification", { assigneePrincipalIds: ["principal:reviewer"] }, "qualification:intent:assign");
  await client.commentIntent("intent:qualification", { body: "Comment" }, "qualification:intent:comment");
  await client.closeIntent("intent:qualification", "qualification:intent:close");
  await client.reopenIntent("intent:qualification", "qualification:intent:reopen");
  await client.listPullRequests("project:qualification");
  await client.inspectPullRequest("pr:qualification");
  await client.openPullRequest({ projectId: "project:qualification", changeId: "change:qualification" }, "qualification:pr:open");
  await client.updatePullRequest("pr:qualification", { headCommit: "commit:two" }, "qualification:pr:update");
  await client.reviewPullRequest("pr:qualification", { reviewState: "approved", reviewDigest: "sha256:review" }, "qualification:pr:review");
  await client.closePullRequest("pr:qualification", "qualification:pr:close");
  await client.reopenPullRequest("pr:qualification", "qualification:pr:reopen");
  await client.blockPullRequest("pr:qualification", "qualification:pr:block");
  await client.mergePullRequest("pr:qualification", "qualification:pr:merge");

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
    ["POST", "/api/authority/recovery/activate"],
    ["POST", "/api/authority/command"],
    ["GET", "/api/intents"],
    ["GET", "/api/intents/intent%3Aqualification"],
    ["POST", "/api/intents"],
    ["POST", "/api/intents/intent%3Aqualification/assign"],
    ["POST", "/api/intents/intent%3Aqualification/comment"],
    ["POST", "/api/intents/intent%3Aqualification/close"],
    ["POST", "/api/intents/intent%3Aqualification/reopen"],
    ["GET", "/api/pull-requests"],
    ["GET", "/api/pull-requests/pr%3Aqualification"],
    ["POST", "/api/pull-requests"],
    ["POST", "/api/pull-requests/pr%3Aqualification/update"],
    ["POST", "/api/pull-requests/pr%3Aqualification/review"],
    ["POST", "/api/pull-requests/pr%3Aqualification/close"],
    ["POST", "/api/pull-requests/pr%3Aqualification/reopen"],
    ["POST", "/api/pull-requests/pr%3Aqualification/block"],
    ["POST", "/api/pull-requests/pr%3Aqualification/merge"],
  ]);
  assert.equal(calls[0]?.cookie, "anyam_owner_session=session%3Aowner-qualification");
  assert.equal(calls[1]?.body?.projectId, "project:qualification");
  assert.equal(calls[2]?.body?.workspaceId, "workspace:qualification");
  assert.equal(calls[3]?.body?.mirrorId, "mirror:qualification");
  assert.equal(calls[4]?.body?.operationId, "operation:one");
  assert.equal(calls[5]?.body?.reconciliation, "canonical-wins");
  assert.equal((calls[9]?.body?.bundle as Record<string, unknown> | undefined)?.bundleId, "bundle:qualification");
  assert.equal(calls[10]?.body?.bundleId, "bundle:qualification");
  assert.equal(calls[11]?.body?.command, "release.create");
  assert.equal(calls[11]?.body?.idempotencyKey, "qualification:release");
  assert.equal(new URL(calls[12]!.url).search, "?projectId=project%3Aqualification");
  assert.equal(calls[14]?.body?.title, "Qualification Intent");
  assert.equal((calls[15]?.body?.assigneePrincipalIds as string[] | undefined)?.[0], "principal:reviewer");
  assert.equal(calls[16]?.body?.body, "Comment");
  assert.equal(new URL(calls[19]!.url).search, "?projectId=project%3Aqualification");
  assert.equal(calls[21]?.body?.changeId, "change:qualification");
  assert.equal(calls[23]?.body?.reviewState, "approved");
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
