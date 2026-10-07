import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { disclosureFixture } from "./fixtures/authority-disclosure-state.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

test("actual local Coordinator SQLite REST and MCP enforce current Source disclosure, stable projections and owner recovery boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-disclosure-runtime-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "disclosure-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    const invoke = async (path, body, member = "public") => {
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-member": member, [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const f = disclosureFixture();
    assert.equal((await invoke("/fixture/seed", f)).status, 200);
    const readPaths = ["/api/projects", "/api/projects/project%3Afixture", "/api/workspaces", "/api/workspaces/workspace%3Apublic", "/api/changes", "/api/changes/change%3Apublic", "/api/intents", "/api/intents/intent%3Acollaboration", "/api/pull-requests", "/api/pull-requests/pr%3Apublic", "/api/mirrors", "/api/mirrors/mirror%3Apublic", "/api/promotions/promotion%3Apublic"];
    const baseline = [];
    for (const path of readPaths) {
      const result = await invoke(path); assert.equal(result.status, 200, path);
      assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE-|canonical:|candidate:|source:hidden|run:hidden|run:mixed/u, path);
      baseline.push(result);
    }
    const run = await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: "run:public" });
    assert.equal(run.status, 200); assert.equal(run.value.run.status, "succeeded"); assert.doesNotMatch(JSON.stringify(run.value), /PRIVATE-|Digest|runnerId|verifierId/u);
    const tool = async (name, args, member = "public") => invoke("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, member);
    for (const [name, args] of [["project.inspect", { projectId: "project:fixture" }], ["workspace.inspect", { workspaceId: "workspace:public" }], ["change.inspect", { changeId: "change:public" }], ["intent.inspect", { intentId: "intent:collaboration" }], ["pullRequest.inspect", { pullRequestId: "pr:public" }], ["run.inspect", { runId: "run:public" }]]) {
      const result = await tool(name, args); assert.equal(result.status, 200); assert.ok(result.value.result, JSON.stringify(result)); assert.equal(result.value.error, undefined);
      assert.doesNotMatch(JSON.stringify(result.value), /PRIVATE-|canonical:|candidate:|source:hidden/u, name);
    }
    for (const kind of ["hidden", "mixed"]) {
      for (const [route, prefix] of [["workspaces", "workspace"], ["changes", "change"], ["pull-requests", "pr"], ["promotions", "promotion"]]) {
        const hidden = await invoke(`/api/${route}/${prefix}%3A${kind}`); const absent = await invoke(`/api/${route}/${prefix}%3Aabsent`);
        assert.equal(hidden.status, 404, `${route} ${kind}`); assert.deepEqual(hidden, absent, `${route} hidden and absent errors`);
      }
      const hidden = await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: `run:${kind}` });
      const absent = await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: "run:absent" });
      assert.equal(hidden.status, 404); assert.deepEqual(hidden, absent);
      const mcp = await tool("run.inspect", { runId: `run:${kind}` }); const unknown = await tool("run.inspect", { runId: "run:absent" });
      assert.deepEqual(mcp, unknown); assert.ok(mcp.value.error);
    }
    assert.equal((await invoke("/api/projects", undefined, "unrelated")).value.projects.length, 0);
    assert.equal((await invoke("/api/projects/project%3Afixture", undefined, "unrelated")).status, 404);
    assert.equal((await invoke("/authority/runs/internal", { sessionId: f.members.private.session.id, runId: "run:mixed" })).status, 200);
    const ownerState = await invoke("/authority/state/internal", { sessionId: f.members.owner.session.id }); assert.equal(ownerState.status, 200);
    const projectOwnerState = await invoke("/authority/state/internal", { sessionId: f.members.projectOwner.session.id }); assert.equal(projectOwnerState.status, 422);
    const projectOwnerExport = await invoke("/authority/recovery/export/internal", { sessionId: f.members.projectOwner.session.id }); assert.equal(projectOwnerExport.status, 422); assert.equal(projectOwnerExport.value.code, "authority.owner_denied");
    const altered = structuredClone(f); altered.state.version += 100; altered.state.sourceSpaces["source:hidden"].name = "PRIVATE-altered";
    altered.state.projectRevisions["canonical:base"].sourceSpaceSnapshots["source:hidden"] = "PRIVATE-new-snapshot";
    altered.state.projectViews[altered.state.workspaces["workspace:hidden"].projectViewId].projectionId = altered.state.projectViews[altered.state.workspaces["workspace:public"].projectViewId].projectionId;
    altered.state.intentComments["comment:hidden"].body = "PRIVATE-new-comment"; altered.state.intents["intent:collaboration"].updatedAt = "2099-01-01";
    await invoke("/fixture/seed", altered);
    for (let i = 0; i < readPaths.length; i++) assert.deepEqual(await invoke(readPaths[i]), baseline[i], readPaths[i]);
    assert.deepEqual(await invoke("/authority/runs/internal", { sessionId: f.members.public.session.id, runId: "run:public" }), run);
    const deniedOwner = structuredClone(f); deniedOwner.identity.sourceSpacePolicies["source:hidden"].readerPrincipalIds = [f.members.private.principal.id];
    await invoke("/fixture/seed", deniedOwner);
    const limitedState = await invoke("/authority/state/internal", { sessionId: f.members.owner.session.id }); assert.equal(limitedState.status, 200); assert.doesNotMatch(JSON.stringify(limitedState.value), /PRIVATE-|snapshotVersion|sql|rowCount|version/u);
    assert.equal((await invoke("/authority/recovery/export/internal", { sessionId: f.members.owner.session.id })).status, 404);
    const revoked = structuredClone(f); revoked.identity.sourceSpacePolicies["source:public"].readerPrincipalIds = [f.members.owner.principal.id];
    await invoke("/fixture/seed", revoked);
    assert.equal((await invoke("/api/workspaces/workspace%3Apublic")).status, 404);
    assert.equal((await tool("run.inspect", { runId: "run:public" })).value.error.code, -32004);
    assert.equal((await invoke("/api/projects/project%3Afixture")).value.counts.runs, 0);
    await invoke("/fixture/seed", f); await invoke("/fixture/revoke", { sessionId: f.members.public.session.id });
    assert.notEqual((await invoke("/api/projects/project%3Afixture")).status, 200);
    assert.ok((await tool("run.inspect", { runId: "run:public" })).value.error);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
