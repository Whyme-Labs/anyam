import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { disclosureFixture } from "./fixtures/authority-disclosure-state.ts";
import { repositoryObservationDigest } from "../src/portability/repository-observation.ts";
import { isDeepStrictEqual } from "node:util";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";

const prepareFixture = () => {
  const fixture = disclosureFixture();
  for (const r of Object.values(fixture.identity.relationships)) if (r.principalId === fixture.members.public.principal.id) r.role = "contributor";
  fixture.identity.sourceSpacePolicies["source:public"].allowedCapabilities = ["source.read", "workspace.write", "change.publish_revision", "run.invoke"];
  fixture.state.projectRevisions["canonical:base"].sourceSpaceSnapshots["source:public"] = "a".repeat(40);
  for (const view of Object.values(fixture.state.projectViews)) if (view.disclosedSourceSpaceSnapshots["source:public"]) view.disclosedSourceSpaceSnapshots["source:public"] = "a".repeat(40);
  for (const w of Object.values(fixture.state.workspaces)) for (const m of w.mounts) if (m.sourceSpaceId === "source:public") m.snapshotId = "a".repeat(40);
  return fixture;
};
function repositoryObserver() {
  let count = 0;
  return { calls: () => count, async fetch(request) {
    const body = await request.json(); count++;
    const claims = { protocol: "anyam.repository-observation/v1", repositoryId: body.repositoryId, sourceSpaceId: body.sourceSpaceId, workspaceId: body.workspaceId, projectViewId: body.projectViewId, objectFormat: "sha1", symbolicRef: body.expectedSymbolicRef ?? "refs/heads/candidate", commitOid: body.expectedCommitOid, treeOid: "c".repeat(40), baseCommitOid: body.expectedBaseCommitOid, ancestryVerified: true, observedAt: new Date(Date.parse("2026-10-02T12:00:00Z") + count).toISOString(), receipt: "synthetic observed repository; no live provider" };
    return Response.json({ protocol: claims.protocol, status: "succeeded", observation: { ...claims, manifestDigest: await repositoryObservationDigest(claims) }, receipt: "synthetic observer response; no live provider" });
  } };
}
async function cli(directory, base, target, operation, payload, key, extra = []) {
  const path = join(directory, "request.json");
  if (payload !== undefined) await writeFile(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  const args = ["--import", "./node_modules/tsx/dist/loader.mjs", "packages/create-anyam/src/anyam.ts", "realm", target, operation, "--realm", base, "--session-stdin", "--json", ...(payload === undefined ? ["--id", key] : ["--input", path, "--idempotency-key", key]), ...extra];
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ANYAM_STATE_HOME: join(directory, "state") }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.on("error", error => { if (error.code !== "EPIPE") throw error; }); child.stdin.end("synthetic-public\n");
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.doesNotMatch(stdout + stderr, /synthetic-public|PRIVATE-|canonical:|projectRevisionId|projectViewId|"version"|SYNTHETIC-CREDENTIAL/u);
  return { code, value: JSON.parse(code === 0 ? stdout : stderr) };
}
test("fresh actual human CLI resolves disclosed selectors against the production Coordinator", async t => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-selector-clients-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const observer = repositoryObserver();
    const options = convertV4MiniflareOptions({ name: "selector-clients-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, serviceBindings: { ANYAM_REPOSITORY_OBSERVER: observer.fetch }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    const base = (await runtime.ready).toString();
    const fixture = prepareFixture();
    for (const r of Object.values(fixture.identity.relationships)) if (r.principalId === fixture.members.public.principal.id) r.role = "contributor";
    fixture.identity.sourceSpacePolicies["source:public"].allowedCapabilities = ["source.read", "workspace.write", "change.publish_revision", "run.invoke"];
    assert.equal((await fetch(new URL("/fixture/seed", base), { method: "POST", body: JSON.stringify(fixture) })).status, 200);
    const projectRead = await cli(directory, base, "project", "inspect", undefined, "project:fixture"); assert.equal(projectRead.code, 0, JSON.stringify(projectRead));
    const project = projectRead.value;
    const payloadPath = join(directory, "workspace.json");
    await writeFile(payloadPath, JSON.stringify({ projectId: project.project.id, projectViewRevisionId: project.projectViewRevision.id, sourceSpaceIds: ["source:public"] }));
    const child = spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "packages/create-anyam/src/anyam.ts", "realm", "workspace", "create", "--realm", base, "--input", payloadPath, "--idempotency-key", "fresh-cli-workspace", "--session-stdin", "--json"], { cwd: process.cwd(), env: { ...process.env, ANYAM_STATE_HOME: join(directory, "state") }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.end("synthetic-public\n");
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.status, "succeeded");
    assert.match(result.value.workspace.id, /^workspace:/u);
    assert.doesNotMatch(stdout + stderr, /synthetic-public|PRIVATE-|canonical:|projectRevisionId|projectViewId|"version"/u);

    const inspected = await cli(directory, base, "workspace", "inspect", undefined, result.value.workspace.id); assert.equal(inspected.code, 0);
    const workspaceId = result.value.workspace.id; const view = result.value.workspace.projectViewRevisionId;
    const change = await cli(directory, base, "change", "create", { projectId: "project:fixture", workspaceId, baseProjectViewRevisionId: view, intentId: "intent:collaboration" }, "cli-change"); assert.equal(change.code, 0, JSON.stringify(change));
    const publish = { projectId: "project:fixture", workspaceId, changeId: change.value.value.change.id, baseProjectViewRevisionId: view, sourceSpaceSnapshots: { "source:public": "b".repeat(40) }, declaredEffects: ["source.propose"] };
    const revision = await cli(directory, base, "revision", "publish", publish, "cli-publish"); assert.equal(revision.code, 0, JSON.stringify(revision));
    const runPayload = { projectId: "project:fixture", workspaceId, changeRevisionId: revision.value.value.revision.id, projectViewRevisionId: revision.value.value.revision.projectViewRevisionId, actionId: "action:synthetic", actionContractDigest: "sha256:synthetic-action", artifactOutputContract: { protocol: "anyam.action-artifact-outputs/v1", outputs: [{ path: "dist/worker.js", type: "worker.bundle" }] }, inputDigests: ["src/main.ts=sha256:synthetic-input"] };
    const run = await cli(directory, base, "run", "request", runPayload, "cli-run"); assert.equal(run.code, 0, JSON.stringify(run)); assert.equal(run.value.value.run.status, "queued"); assert.deepEqual(run.value.value.run.artifactOutputContract, runPayload.artifactOutputContract);
    assert.equal((await cli(directory, base, "run", "inspect", undefined, run.value.value.run.id)).value.run.status, "queued");
    const checkpoint = async () => await (await fetch(new URL("/fixture/checkpoint", base), { method: "POST", body: "{}" })).json();
    const before = await checkpoint();
    const reviewStarted = performance.now();
    const review = await cli(directory, base, "revision", "inspect", undefined, revision.value.value.revision.id);
    t.diagnostic(JSON.stringify({ protocol: "anyam.local-revision-read-timing/v1", client: "fresh-node-cli", syntheticLocalRealm: true, elapsedMs: performance.now() - reviewStarted }));
    assert.equal(review.code, 0, JSON.stringify(review));
    assert.deepEqual(review.value.projectViewRevision.sourceSpaceSnapshots, { "source:public": "b".repeat(40) });
    assert.equal(review.value.revision.isLatestForChange, true);
    assert.deepEqual(review.value.runs.map(value => ({ id: value.id, status: value.status, evidence: value.evidence })), [{ id: run.value.value.run.id, status: "queued", evidence: [] }]);
    const recorded = await cli(directory, base, "revision", "inspect", undefined, "revision:public");
    assert.deepEqual(recorded.value.runs[0].evidence, [{ id: "evidence:public", outcome: "passed" }]);
    const unavailableRevisions = [];
    for (const id of ["revision:hidden", "revision:mixed", "revision:absent"]) unavailableRevisions.push(await cli(directory, base, "revision", "inspect", undefined, id));
    assert.deepEqual(unavailableRevisions[0], unavailableRevisions[1]); assert.deepEqual(unavailableRevisions[1], unavailableRevisions[2]); assert.equal(unavailableRevisions[0].code, 1);
    assert.equal((await cli(directory, base, "change", "inspect", undefined, change.value.value.change.id)).code, 0);
    const runUnavailable = [];
    for (const runId of ["run:hidden", "run:absent"]) runUnavailable.push(await cli(directory, base, "run", "inspect", undefined, runId));
    assert.deepEqual(runUnavailable[0], runUnavailable[1]); assert.equal(runUnavailable[0].code, 1);
    assert.deepEqual((await cli(directory, base, "revision", "publish", publish, "cli-publish")).value, revision.value);
    assert.deepEqual((await cli(directory, base, "run", "request", runPayload, "cli-run")).value, run.value);
    assert.deepEqual(await checkpoint(), before); assert.equal(observer.calls(), 1);
    const unavailable = [];
    for (const sourceSpaceId of ["source:hidden", "source:absent"]) unavailable.push(await cli(directory, base, "workspace", "create", { projectId: "project:fixture", projectViewRevisionId: project.projectViewRevision.id, sourceSpaceIds: [sourceSpaceId] }, "cli-denied"));
    assert.deepEqual(unavailable[0], unavailable[1]); assert.equal(unavailable[0].code, 1); assert.deepEqual(await checkpoint(), before);
    for (const [payload, extra] of [[{ ...runPayload, capabilityGrantId: "PRIVATE-caller-grant" }, []], [runPayload, ["--owner-session", "SYNTHETIC-CREDENTIAL"]], ["{\"PRIVATE-malformed-secret\":", []], [runPayload, ["--input", "PRIVATE-duplicate-input"]]]) assert.equal((await cli(directory, base, "run", "request", payload, "cli-invalid", extra)).code, 1);

    const newer = await cli(directory, base, "revision", "publish", { ...publish, sourceSpaceSnapshots: { "source:public": "d".repeat(40) } }, "cli-next-revision");
    assert.equal(newer.code, 0, JSON.stringify(newer));
    const advanced = await checkpoint();
    const olderRead = await cli(directory, base, "revision", "inspect", undefined, revision.value.value.revision.id);
    assert.equal(olderRead.value.revision.isLatestForChange, false);
    assert.deepEqual(olderRead.value.projectViewRevision.sourceSpaceSnapshots, { "source:public": "b".repeat(40) });
    assert.equal(olderRead.value.runs[0].status, "queued");
    const latestRead = await cli(directory, base, "revision", "inspect", undefined, newer.value.value.revision.id);
    assert.equal(latestRead.value.revision.isLatestForChange, true);
    assert.deepEqual(latestRead.value.projectViewRevision.sourceSpaceSnapshots, { "source:public": "d".repeat(40) });
    assert.deepEqual(latestRead.value.runs, []);
    assert.deepEqual(await checkpoint(), advanced); assert.equal(observer.calls(), 2);
    for (const suffix of ["%", "revision%3Apublic/extra", "revision%3Apublic?unexpected=PRIVATE-query"]) {
      const invalid = await fetch(new URL(`/api/authority/revisions/${suffix}`, base), { headers: { cookie: "anyam_owner_session=synthetic-public" } });
      assert.equal(invalid.status, 404); assert.doesNotMatch(await invalid.text(), /PRIVATE-query/u);
    }
    const revoked = { ...fixture, identity: structuredClone(advanced.identity), state: structuredClone(advanced.authority) };
    revoked.identity.sourceSpacePolicies["source:public"].deniedCapabilities = ["source.read"];
    await fetch(new URL("/fixture/seed", base), { method: "POST", body: JSON.stringify(revoked) });
    const revokedBefore = await checkpoint();
    assert.equal((await cli(directory, base, "revision", "inspect", undefined, newer.value.value.revision.id)).code, 1);
    assert.deepEqual(await checkpoint(), revokedBefore);

  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("delegated MCP discovers and resolves fresh selectors under its actual Task and Grant", async t => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-selector-agent-")); let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/selector-clients-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const observer = repositoryObserver();
    const options = convertV4MiniflareOptions({ name: "selector-agent-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalSelectorRealm", useSQLite: true } }, serviceBindings: { ANYAM_REPOSITORY_OBSERVER: observer.fetch }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage"); runtime = new Miniflare(options);
    const base = (await runtime.ready).toString();
    const fixture = prepareFixture();
    fixture.identity.sourceSpacePolicies["source:public"].allowedCapabilities = ["source.read", "workspace.write", "change.publish_revision", "run.invoke"];
    const identity = new RealmIdentityPolicy({ realmId: fixture.identity.realm.id, relyingPartyId: "fixture.local", now: () => new Date("2026-10-02T12:00:00Z") }); identity.restoreOperationalSnapshot(fixture.identity);
    const owner = fixture.members.owner.session;
    const resource = { realmId: identity.realm.id, projectId: "project:fixture" };
    const task = identity.createTask({ principalId: owner.principalId, actorId: owner.actorId, sessionId: owner.id, purpose: "Synthetic selector delegation" });
    const parent = identity.createCapabilityGrant({ principalId: owner.principalId, actorId: owner.actorId, clientId: owner.clientId, sessionId: owner.id, taskId: task.id, resource, sourceSpaceIds: ["source:public"], actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke", "agent.delegate"], effects: ["source.propose"], allowedModelProviders: ["synthetic-local"], allowedCredentialClasses: ["mcp"] });
    identity.registerClient({ id: "client:synthetic-selector", kind: "mcp", allowedAudiences: ["mcp"], allowedOperations: ["source.read", "workspace.create", "change.create", "revision.publish", "run.request"] });
    const agent = identity.registerAgent({ principalId: owner.principalId, clientId: "client:synthetic-selector", name: "Synthetic agent A", runtime: "synthetic", modelProvider: "synthetic-local", allowedCredentialClasses: ["mcp"] });
    const delegated = identity.delegateAgent({ humanSessionId: owner.id, parentGrantId: parent.id, agentId: agent.id, purpose: "Synthetic scoped Source task", resource, sourceSpaceIds: ["source:public"], actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke"], effects: ["source.propose"], allowedCredentialClasses: ["mcp"] });
    const peerAgent = identity.registerAgent({ principalId: owner.principalId, clientId: "client:synthetic-selector", name: "Synthetic agent B", runtime: "synthetic", modelProvider: "synthetic-local", allowedCredentialClasses: ["mcp"] });
    const peer = identity.delegateAgent({ humanSessionId: owner.id, parentGrantId: parent.id, agentId: peerAgent.id, purpose: "Synthetic independent peer", resource, sourceSpaceIds: ["source:public"], actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke"], effects: ["source.propose"], allowedCredentialClasses: ["mcp"] });
    const bounded = identity.delegateAgent({ humanSessionId: owner.id, parentGrantId: parent.id, agentId: agent.id, purpose: "Synthetic fixed Workspace task", resource: { ...resource, workspaceId: "workspace:public", changeId: "change:public" }, workspaceId: "workspace:public", changeId: "change:public", sourceSpaceIds: ["source:public"], actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke"], effects: ["source.propose"], allowedCredentialClasses: ["mcp"] });
    const runBound = identity.delegateAgent({ humanSessionId: owner.id, parentGrantId: parent.id, agentId: peerAgent.id, purpose: "Synthetic Run-only read", resource: { ...resource, runId: "run:public" }, sourceSpaceIds: ["source:public"], actions: ["source.read"], effects: [], allowedCredentialClasses: ["mcp"] });
    fixture.identity = identity.getRecoverySnapshot();
    const invoke = async (path, body, headers = {}) => { const response = await fetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return await response.json(); };
    await invoke("/fixture/seed", fixture);
    const props = d => ({ scopes: ["project.read", "workspace.inspect", "workspace.write", "change.inspect", "change.write", "run.invoke", "intent.inspect", "pullRequest.inspect"], realmId: identity.realm.id, kernelSessionId: d.session.id, agentId: d.agent.id, taskId: d.task.id, capabilityGrantId: d.grant.id, delegatedBySessionId: owner.id, resource: d.grant.resource, sourceSpaceIds: ["source:public"] });
    const bindings = { a: props(delegated), b: props(peer), bounded: props(bounded), runBound: props(runBound) };
    await invoke("/fixture/selector-bindings", bindings);
    const rpc = (method, params, actor = "a") => invoke("/mcp", { jsonrpc: "2.0", id: 1, method, params }, { "x-fixture-agent": actor });
    const call = (name, argumentsValue, actor = "a") => rpc("tools/call", { name, arguments: argumentsValue }, actor);
    const checkpoint = () => invoke("/fixture/checkpoint", {});
    const initial = await checkpoint();
    assert.ok((await rpc("initialize", {})).result);
    const listed = await rpc("tools/list", {});
    assert.ok(listed.result.tools.some(tool => tool.name === "workspace.create_from_view"), "discoverable delegated selector tool");
    assert.ok(listed.result.tools.some(tool => tool.name === "change.revision.inspect"));
    const inspected = await rpc("tools/call", { name: "project.inspect", arguments: { projectId: "project:fixture" } });
    assert.ok(inspected.result, JSON.stringify(inspected));
    const project = inspected.result.structuredContent;
    assert.deepEqual(await checkpoint(), initial, "delegated read/list discovery does not mutate identity, audit, SQL or KV");
    assert.deepEqual(project.project.sourceSpaceIds, ["source:public"], "owner sees private Source, agent grant does not");
    const created = await rpc("tools/call", { name: "workspace.create_from_view", arguments: { idempotencyKey: "agent-fresh-workspace", projectId: "project:fixture", projectViewRevisionId: project.projectViewRevision.id, sourceSpaceIds: ["source:public"] } });
    assert.equal(created.result?.structuredContent.status, "succeeded", JSON.stringify(created));
    assert.doesNotMatch(JSON.stringify(created), /PRIVATE-|source:hidden|canonical:|projectRevisionId|projectViewId|kernelSession|capabilityGrantId|taskId/u);

    const workspace = created.result.structuredContent.value.workspace; const workspaceId = workspace.id;
    const args = { idempotencyKey: "agent-fresh-workspace", projectId: "project:fixture", projectViewRevisionId: project.projectViewRevision.id, sourceSpaceIds: ["source:public"] };
    const other = await call("workspace.create_from_view", args, "b"); assert.equal(other.result.structuredContent.status, "succeeded"); assert.notEqual(other.result.structuredContent.value.workspace.id, workspaceId, "same owner/key cannot reuse another Agent's accepted result");
    const change = await call("change.create_from_view", { idempotencyKey: "agent-change", projectId: "project:fixture", workspaceId, baseProjectViewRevisionId: workspace.projectViewRevisionId, intentId: "intent:collaboration" }); assert.equal(change.result?.structuredContent.status, "succeeded", JSON.stringify(change));
    const publish = { idempotencyKey: "agent-publish", projectId: "project:fixture", workspaceId, changeId: change.result.structuredContent.value.change.id, baseProjectViewRevisionId: workspace.projectViewRevisionId, sourceSpaceSnapshots: { "source:public": "b".repeat(40) }, declaredEffects: ["source.propose"] };
    const revision = await call("change.publish_revision_from_view", publish); assert.equal(revision.result?.structuredContent.status, "succeeded", JSON.stringify(revision));
    const runArgs = { idempotencyKey: "agent-run", projectId: "project:fixture", workspaceId, changeRevisionId: revision.result.structuredContent.value.revision.id, projectViewRevisionId: revision.result.structuredContent.value.revision.projectViewRevisionId, actionId: "action:synthetic", actionContractDigest: "sha256:synthetic-action", artifactOutputContract: { protocol: "anyam.action-artifact-outputs/v1", outputs: [{ path: "dist/worker.js", type: "worker.bundle" }] }, inputDigests: ["src/main.ts=sha256:synthetic-input"] };
    const run = await call("run.request_from_view", runArgs); assert.equal(run.result?.structuredContent.value.run.status, "queued", JSON.stringify(run));
    assert.deepEqual(run.result.structuredContent.value.run.artifactOutputContract, runArgs.artifactOutputContract);
    const runRead = await call("run.inspect", { runId: run.result.structuredContent.value.run.id }); assert.equal(runRead.result?.structuredContent.run.status, "queued", JSON.stringify(runRead));
    const accepted = await checkpoint(); const nativeRun = accepted.authority.runs[run.result.structuredContent.value.run.id];
    const reviewArgs = { changeRevisionId: revision.result.structuredContent.value.revision.id };
    const review = await call("change.revision.inspect", reviewArgs);
    assert.deepEqual(review.result?.structuredContent.projectViewRevision.sourceSpaceSnapshots, { "source:public": "b".repeat(40) });
    assert.equal(review.result?.structuredContent.revision.isLatestForChange, true);
    assert.deepEqual(review.result?.structuredContent.runs.map(value => ({ id: value.id, status: value.status, evidence: value.evidence })), [{ id: run.result.structuredContent.value.run.id, status: "queued", evidence: [] }]);
    const samples = [];
    for (let index = 0; index < 8; index++) { const started = performance.now(); assert.deepEqual(await call("change.revision.inspect", reviewArgs), review); samples.push(performance.now() - started); }
    t.diagnostic(JSON.stringify({ protocol: "anyam.local-revision-read-timing/v1", client: "delegated-http-mcp", syntheticLocalRealm: true, serialSamplesMs: samples }));
    assert.deepEqual((await call("change.revision.inspect", { changeRevisionId: "revision:public" })).result?.structuredContent.runs[0].evidence, [{ id: "evidence:public", outcome: "passed" }]);
    assert.ok((await call("run.inspect", { runId: "run:public" }, "runBound")).result);
    assert.equal((await call("change.revision.inspect", { changeRevisionId: "revision:public" }, "runBound")).error?.code, -32004);
    assert.equal((await call("change.revision.inspect", reviewArgs, "bounded")).error?.code, -32004);
    assert.equal((await call("change.revision.inspect", { ...reviewArgs, capabilityGrantId: "PRIVATE-caller-grant" })).error?.code, -32602);
    const unavailableRevisions = [];
    for (const changeRevisionId of ["revision:hidden", "revision:mixed", "revision:absent"]) unavailableRevisions.push(await call("change.revision.inspect", { changeRevisionId }));
    assert.deepEqual(unavailableRevisions[0], unavailableRevisions[1]); assert.deepEqual(unavailableRevisions[1], unavailableRevisions[2]); assert.equal(unavailableRevisions[0].error?.code, -32004);
    assert.doesNotMatch(JSON.stringify(review), /PRIVATE-|source:hidden|canonical:|projectRevisionId|projectViewId|kernelSession|capabilityGrantId|taskId|"version"/u);
    for (const [name, input] of [["project.list", {}], ["workspace.list", { projectId: "project:fixture" }], ["workspace.inspect", { workspaceId }], ["change.list", { projectId: "project:fixture" }], ["change.inspect", { changeId: change.result.structuredContent.value.change.id }], ["intent.list", { projectId: "project:fixture" }], ["intent.inspect", { intentId: "intent:collaboration" }], ["pullRequest.list", { projectId: "project:fixture" }], ["pullRequest.inspect", { pullRequestId: "pr:public" }]]) {
      const read = await call(name, input); assert.ok(read.result, name + JSON.stringify(read));
      assert.doesNotMatch(JSON.stringify(read), /PRIVATE-|source:hidden|canonical:|kernelSession|capabilityGrantId|taskId|"version"/u);
    }
    assert.deepEqual(await checkpoint(), accepted, "all native Agent read tools preserve identity, audit and SQL/KV");
    assert.equal(nativeRun.actor.actorId, delegated.actor.actorId); assert.equal(nativeRun.actor.sessionId, delegated.session.id); assert.equal(nativeRun.capabilityGrantId, delegated.grant.id);
    assert.equal(accepted.identity.grants[nativeRun.capabilityGrantId].taskId, delegated.task.id);
    assert.ok(accepted.identity.audit.some(event => event.eventType === "policy.evaluated" && event.taskId === delegated.task.id && event.grantId === delegated.grant.id && event.sessionId === delegated.session.id && event.actorId === delegated.actor.actorId && event.details.operation === "run.request" && event.outcome === "succeeded"), "native Task, Grant and Agent chain authorized the actual Run request");
    assert.deepEqual(Object.keys(accepted.identity.tasks).sort(), Object.keys(initial.identity.tasks).sort()); assert.deepEqual(Object.keys(accepted.identity.grants).sort(), Object.keys(initial.identity.grants).sort(), "no replacement human or Agent grant minted");
    assert.deepEqual(await call("change.publish_revision_from_view", publish), revision); assert.deepEqual(await call("run.request_from_view", runArgs), run); assert.equal(observer.calls(), 1); assert.deepEqual(await checkpoint(), accepted);
    assert.doesNotMatch(JSON.stringify([change, revision, run]), /PRIVATE-|source:hidden|canonical:|projectRevisionId|projectViewId|kernelSession|capabilityGrantId|taskId|"version"/u);
    const outcomes = [];
    for (const sourceSpaceId of ["source:hidden", "source:absent"]) outcomes.push(await call("workspace.create_from_view", { ...args, sourceSpaceIds: [sourceSpaceId] }));
    assert.deepEqual(outcomes[0], outcomes[1]); assert.equal(outcomes[0].error.code, -32004); assert.deepEqual(await checkpoint(), accepted);
    const hidden = { ...fixture, identity: structuredClone(accepted.identity), state: structuredClone(accepted.authority) };
    const visible = await call("project.inspect", { projectId: "project:fixture" });
    hidden.state.projectRevisions["PRIVATE-alternative-canonical"] = { ...hidden.state.projectRevisions["canonical:base"], id: "PRIVATE-alternative-canonical", sourceSpaceSnapshots: { "source:public": "a".repeat(40), "source:hidden": "PRIVATE-new-snapshot" } }; hidden.state.canonicalByProject["project:fixture"] = "PRIVATE-alternative-canonical"; hidden.state.version += 100;
    await invoke("/fixture/seed", hidden);
    assert.deepEqual(await call("project.inspect", { projectId: "project:fixture" }), visible, "hidden-only activity cannot change the agent's selectors/counts");
    assert.deepEqual(await call("run.request_from_view", runArgs), run); assert.deepEqual(await call("change.publish_revision_from_view", publish), revision); assert.equal(observer.calls(), 1);
    assert.deepEqual(await call("change.revision.inspect", reviewArgs), review, "hidden-only canonical activity does not alter selected candidate review");
    const good = { ...fixture, identity: structuredClone(accepted.identity), state: structuredClone(accepted.authority) };
    for (const [key, deniedCapability, resourceValue, name, input] of [
      ["source", "project.inspect", { ...resource, sourceSpaceId: "source:public" }, "project.inspect", { projectId: "project:fixture" }],
      ["workspace", "source.read", { ...resource, workspaceId }, "workspace.inspect", { workspaceId }],
      ["change", "change.inspect", { ...resource, changeId: change.result.structuredContent.value.change.id }, "change.inspect", { changeId: change.result.structuredContent.value.change.id }],
      ["run", "evidence.read", { ...resource, runId: run.result.structuredContent.value.run.id }, "run.request_from_view", runArgs],
    ]) {
      const scoped = structuredClone(good);
      scoped.identity.relationships[`relationship:scoped-${key}`] = { ...Object.values(scoped.identity.relationships).find(entry => entry.principalId === owner.principalId), id: `relationship:scoped-${key}`, resource: resourceValue, deniedCapabilities: [deniedCapability] };
      await invoke("/fixture/seed", scoped); const before = await checkpoint();
      const denied = await call(name, input);
      if (key === "source") {
        assert.deepEqual(denied.result?.structuredContent.project.sourceSpaceIds, []);
        assert.deepEqual(denied.result?.structuredContent.sourceSpaces, []);
        assert.equal(denied.result?.structuredContent.counts.workspaces, 0);
      } else assert.equal(denied.error?.code, -32004, key + JSON.stringify(denied));
      assert.deepEqual(await checkpoint(), before);
      assert.doesNotMatch(JSON.stringify(denied), /PRIVATE-|source:hidden|canonical:|taskId|capabilityGrantId/u);
    }
    for (const grantId of [delegated.grant.id, parent.id]) for (const [capability, name, input, replayTool, replayInput] of [
      ["project.inspect", "project.inspect", { projectId: "project:fixture" }, "workspace.create_from_view", args],
      ["workspace.inspect", "workspace.inspect", { workspaceId }, "workspace.create_from_view", args],
      ["change.inspect", "change.inspect", { changeId: change.result.structuredContent.value.change.id }, "change.create_from_view", { idempotencyKey: "agent-change", projectId: "project:fixture", workspaceId, baseProjectViewRevisionId: workspace.projectViewRevisionId, intentId: "intent:collaboration" }],
      ["evidence.read", "run.inspect", { runId: run.result.structuredContent.value.run.id }, "run.request_from_view", runArgs],
    ]) {
      const denied = structuredClone(good); denied.identity.grants[grantId].deniedActions = [capability]; await invoke("/fixture/seed", denied); const before = await checkpoint();
      for (const [tool, value] of [[name, input], [replayTool, replayInput]]) assert.equal((await call(tool, value)).error?.code, -32004, "native metadata deny: " + capability + " / " + tool);
      const candidate = await call("change.revision.inspect", reviewArgs);
      if (["project.inspect", "change.inspect"].includes(capability)) assert.equal(candidate.error?.code, -32004);
      else { assert.ok(candidate.result); if (capability === "evidence.read") assert.deepEqual(candidate.result.structuredContent.runs, []); }
      assert.deepEqual(await checkpoint(), before); assert.equal(observer.calls(), 1);
    }
    const mutations = [
      ["child grant revocation", f => { f.identity.grants[delegated.grant.id].status = "revoked"; }],
      ["parent grant revocation", f => { f.identity.grants[parent.id].status = "revoked"; }],
      ["parent Task cancellation", f => { f.identity.tasks[parent.taskId].status = "cancelled"; }],
      ["child Task cancellation", f => { f.identity.tasks[delegated.task.id].status = "cancelled"; }],
      ["read deny", f => { f.identity.sourceSpacePolicies["source:public"].deniedCapabilities = ["source.read"]; }],
      ["write deny", f => { f.identity.sourceSpacePolicies["source:public"].deniedCapabilities = ["change.publish_revision"]; }],
      ["model zone", f => { f.identity.sourceSpacePolicies["source:public"].allowedModelProviders = ["other-provider"]; }],
      ["grant read deny", f => { f.identity.grants[delegated.grant.id].deniedActions = ["source.read"]; }],
      ["parent write deny", f => { f.identity.grants[parent.id].deniedActions = ["change.publish_revision"]; }],
      ["parent Source scope narrowed", f => { f.identity.grants[parent.id].sourceSpaceIds = ["source:hidden"]; }],
      ["parent resource narrowed", f => { f.identity.grants[parent.id].resource.workspaceId = "workspace:hidden"; }],
      ["parent model narrowed", f => { f.identity.grants[parent.id].allowedModelProviders = ["other-provider"]; }],
      ["child audience narrowed", f => { f.identity.grants[delegated.grant.id].allowedCredentialClasses = ["realm-api"]; }],
      ["parent audience narrowed", f => { f.identity.grants[parent.id].allowedCredentialClasses = []; }],
      ["Agent audience narrowed", f => { f.identity.agents[agent.id].allowedCredentialClasses = []; }],
      ["client audience narrowed", f => { f.identity.clients[agent.clientId].allowedAudiences = ["realm-api"]; }],
      ["parent client audience narrowed", f => { f.identity.clients[owner.clientId].allowedAudiences = ["realm-api"]; }],
      ["parent client revoked", f => { f.identity.clients[owner.clientId].status = "revoked"; }],
      ["parent client different Realm", f => { f.identity.clients[owner.clientId].realmId = "realm:absent"; }],
      ["expired grant", f => { f.identity.grants[delegated.grant.id].expiresAt = "2026-10-02T11:59:59Z"; }],
      ["stale epoch", f => { f.identity.realm.authorizationEpoch++; }],
      ["inactive Actor", f => { f.identity.actors[delegated.actor.actorId].status = "revoked"; }],
    ];
    for (const [label, mutate] of mutations) {
      const denied = structuredClone(good); mutate(denied); await invoke("/fixture/seed", denied); const before = await checkpoint();
      for (const input of [publish, { ...publish, sourceSpaceSnapshots: { "source:public": "d".repeat(40) } }, { ...publish, idempotencyKey: `new-${label}` }]) { const result = await call("change.publish_revision_from_view", input); assert.equal(result.error?.code, -32004, label + JSON.stringify(result)); assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|taskId|grantId|source:hidden/u); }
      const candidate = await call("change.revision.inspect", reviewArgs);
      if (["write deny", "parent write deny"].includes(label)) assert.deepEqual(candidate, review, "write-only denial preserves authorized review");
      else assert.equal(candidate.error?.code, -32004, "current native read denial: " + label);
      assert.ok(isDeepStrictEqual(await checkpoint(), before), label); assert.equal(observer.calls(), 1, "deny before observation, including cached changed input");
    }
    await invoke("/fixture/seed", good);
    for (const altered of [{ ...bindings.a, taskId: peer.task.id }, { ...bindings.a, agentId: peer.agent.id }, { ...bindings.a, kernelSessionId: peer.session.id }, { ...bindings.a, capabilityGrantId: peer.grant.id }, { ...bindings.a, delegatedBySessionId: "session:absent" }, { ...bindings.a, sourceSpaceIds: ["source:hidden"] }, { ...bindings.a, resource: { ...resource, workspaceId: "workspace:hidden" } }]) {
      await invoke("/fixture/selector-bindings", { ...bindings, bad: altered }); const before = await checkpoint();
      const deniedRead = await call("project.inspect", { projectId: "project:fixture" }, "bad");
      if (altered.resource !== bindings.a.resource) {
        assert.deepEqual(deniedRead.result?.structuredContent.project.sourceSpaceIds, ["source:public"], "narrowed request retains only broad Grant's permitted Project discovery");
        assert.equal(deniedRead.result?.structuredContent.counts.workspaces, 0);
        assert.equal((await call("workspace.inspect", { workspaceId: "workspace:hidden" }, "bad")).error?.code, -32004);
      } else assert.equal(deniedRead.error?.code, -32004, "wrong native binding cannot disclose metadata: " + JSON.stringify(deniedRead));
      const denied = await call("run.request_from_view", runArgs, "bad"); assert.equal(denied.error?.code, -32004, JSON.stringify(denied)); assert.ok(isDeepStrictEqual(await checkpoint(), before));
      assert.equal((await call("change.revision.inspect", reviewArgs, "bad")).error?.code, -32004);
    }
    await invoke("/fixture/selector-bindings", bindings);
    for (const [name, input, expected] of [["change.publish_revision_from_view", { ...publish, idempotencyKey: "bad-effect", declaredEffects: ["source.propose", "deploy.production"] }, -32004], ["run.request_from_view", { ...runArgs, capabilityGrantId: "PRIVATE-caller-grant" }, -32602], ["run.request_from_view", { ...runArgs, inputDigests: ["Bearer SYNTHETIC-CREDENTIAL"] }, -32602], ["workspace.create_from_view", args, -32004]]) {
      const before = await checkpoint(); const response = await call(name, input, name === "workspace.create_from_view" ? "bounded" : "a"); assert.equal(response.error?.code, expected, JSON.stringify(response)); assert.doesNotMatch(JSON.stringify(response), /PRIVATE-|SYNTHETIC-CREDENTIAL/u); assert.ok(isDeepStrictEqual(await checkpoint(), before));
    }
    // Real observation finishes; current native expiry is rechecked before acceptance.
    await invoke("/fixture/expire-after-observation", {}); const beforeExpiry = await checkpoint();
    assert.equal((await call("change.publish_revision_from_view", { ...publish, idempotencyKey: "expiry-during-observation" })).error?.code, -32004);
    assert.equal(observer.calls(), 2); assert.deepEqual(await checkpoint(), beforeExpiry);
    await invoke("/fixture/seed", good);
    await invoke("/fixture/revoke", { sessionId: delegated.session.id }); const revoked = await checkpoint();
    assert.equal((await call("run.request_from_view", runArgs)).error.code, -32004); assert.deepEqual(await checkpoint(), revoked);
    assert.equal((await call("change.revision.inspect", reviewArgs)).error?.code, -32004); assert.deepEqual(await checkpoint(), revoked);
    assert.ok((await call("change.revision.inspect", reviewArgs, "b")).result, "authorized peer can continue candidate review");
    assert.ok((await call("project.inspect", { projectId: "project:fixture" }, "b")).result, "independent peer remains usable after selected Agent revocation");

    // A separately delegated two-Source task proves complete write containment.
    const wideFixture = structuredClone(good);
    const wideIdentity = new RealmIdentityPolicy({ realmId: identity.realm.id, relyingPartyId: "fixture.local", now: () => new Date("2026-10-02T12:00:00Z") }); wideIdentity.restoreOperationalSnapshot(wideFixture.identity);
    const wideParent = wideIdentity.createCapabilityGrant({ principalId: owner.principalId, actorId: owner.actorId, clientId: owner.clientId, sessionId: owner.id, taskId: task.id, resource, sourceSpaceIds: ["source:public", "source:hidden"], actions: ["source.read", "workspace.write", "agent.delegate"], effects: [], allowedModelProviders: ["synthetic-local"], allowedCredentialClasses: ["mcp"] });
    const wide = wideIdentity.delegateAgent({ humanSessionId: owner.id, parentGrantId: wideParent.id, agentId: peerAgent.id, purpose: "Synthetic two-Source task", resource, sourceSpaceIds: ["source:public", "source:hidden"], actions: ["source.read", "workspace.write"], effects: [], allowedCredentialClasses: ["mcp"] });
    wideFixture.identity = wideIdentity.getRecoverySnapshot(); wideFixture.identity.sourceSpacePolicies["source:hidden"].allowedCapabilities = ["source.read", "workspace.write"];
    await invoke("/fixture/seed", wideFixture); await invoke("/fixture/selector-bindings", { ...bindings, wide: { ...props(wide), sourceSpaceIds: ["source:public", "source:hidden"] } });
    const narrowBefore = await call("project.inspect", { projectId: "project:fixture" });
    const wideProject = await call("project.inspect", { projectId: "project:fixture" }, "wide"); assert.deepEqual(wideProject.result.structuredContent.project.sourceSpaceIds, ["source:hidden", "source:public"]);
    const wideArgs = { ...args, idempotencyKey: "wide-creation", projectViewRevisionId: wideProject.result.structuredContent.projectViewRevision.id, sourceSpaceIds: ["source:public", "source:hidden"] };
    assert.equal((await call("workspace.create_from_view", wideArgs, "wide")).result?.structuredContent.status, "succeeded");
    assert.deepEqual(await call("project.inspect", { projectId: "project:fixture" }), narrowBefore, "new private/mixed Workspace does not change the narrower audience's counts");
    const wideAccepted = await checkpoint(); wideFixture.identity = structuredClone(wideAccepted.identity); wideFixture.state = structuredClone(wideAccepted.authority); wideFixture.identity.sourceSpacePolicies["source:hidden"].deniedCapabilities = ["workspace.write"];
    await invoke("/fixture/seed", wideFixture); const wideDenied = await checkpoint();
    for (const input of [wideArgs, { ...wideArgs, idempotencyKey: "wide-new-denied" }]) assert.equal((await call("workspace.create_from_view", input, "wide")).error?.code, -32004, "second contributing Source deny blocks both first acceptance and replay");
    assert.deepEqual(await checkpoint(), wideDenied); assert.equal(observer.calls(), 2);

    // Reconnecting selects either immutable candidate after a newer publication.
    await invoke("/fixture/seed", good); await invoke("/fixture/selector-bindings", bindings);
    const nextRevision = await call("change.publish_revision_from_view", { ...publish, idempotencyKey: "agent-publish-next", sourceSpaceSnapshots: { "source:public": "d".repeat(40) } });
    assert.equal(nextRevision.result?.structuredContent.status, "succeeded", JSON.stringify(nextRevision));
    const afterNext = await checkpoint();
    const olderReview = await call("change.revision.inspect", reviewArgs);
    const latestReview = await call("change.revision.inspect", { changeRevisionId: nextRevision.result.structuredContent.value.revision.id });
    assert.equal(olderReview.result?.structuredContent.revision.isLatestForChange, false);
    assert.deepEqual(olderReview.result?.structuredContent.projectViewRevision.sourceSpaceSnapshots, { "source:public": "b".repeat(40) });
    assert.deepEqual(olderReview.result?.structuredContent.runs, review.result.structuredContent.runs);
    assert.equal(latestReview.result?.structuredContent.revision.isLatestForChange, true);
    assert.deepEqual(latestReview.result?.structuredContent.projectViewRevision.sourceSpaceSnapshots, { "source:public": "d".repeat(40) });
    assert.deepEqual(latestReview.result?.structuredContent.runs, []);
    assert.deepEqual(await checkpoint(), afterNext); assert.equal(observer.calls(), 3, "review performs no new observation");

  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
