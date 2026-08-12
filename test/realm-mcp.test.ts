import assert from "node:assert/strict";
import test from "node:test";

import { handleAnyamRealmMcpRequest, type AnyamRealmMcpEnv, type AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

type JsonRpcBody = Record<string, unknown>;

function env(): { env: AnyamRealmMcpEnv; calls: Array<{ path: string; body: Record<string, unknown> }> } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const idempotency = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
  const namespace = {
    idFromName: (name: string): string => name,
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        calls.push({ path, body });
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        if (body.sessionId !== "kernel-session:owner") return new Response(JSON.stringify({ code: "session.invalid", receipt: "session=invalid; project=not-disclosed" }), { status: 403 });
        if (path === "/authority/command/internal") {
          if (body.protocol !== "anyam.authority-command/v1" || typeof body.command !== "string" || typeof body.idempotencyKey !== "string" || body.payload === null || typeof body.payload !== "object" || Array.isArray(body.payload)) return new Response(JSON.stringify({ code: "invalid_request", receipt: "command=typed-required; credentialFree=true" }), { status: 422 });
          const key = `${String(body.command)}:${String(body.idempotencyKey)}`;
          const fingerprint = JSON.stringify({ command: body.command, payload: body.payload, expectedVersion: body.expectedVersion });
          const prior = idempotency.get(key);
          if (prior) {
            if (prior.fingerprint !== fingerprint) return new Response(JSON.stringify({ code: "idempotency_conflict", recoveryAction: "reuse the original idempotency payload", receipt: "idempotency=conflict; credentialFree=true; canonicalWrite=false" }), { status: 409 });
            return new Response(JSON.stringify(prior.result), { status: 200, headers: { "content-type": "application/json" } });
          }
          const payload = body.payload as Record<string, unknown>;
          let value: Record<string, unknown>;
          if (body.command === "project.create") {
            value = {
              project: { protocol: "anyam.project/v1", id: typeof payload.projectId === "string" ? payload.projectId : "project:mcp", name: "MCP Project", referenceType: "git", sourceSpaceIds: ["source:mcp-public"] },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:mcp:1", projectId: "project:mcp", sourceSpaceSnapshots: { "source:mcp-public": "git:mcp-base" } },
              sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:mcp-public", name: "public", classification: "public", snapshotId: "git:mcp-base" }],
            };
          } else if (body.command === "workspace.create") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            value = {
              workspace: { protocol: "anyam.workspace/v1", id: "workspace:mcp", projectId: String(payload.projectId), projectRevisionId: String(payload.projectRevisionId), projectViewId: "project-view:mcp:1", state: "active", changeId: payload.changeId },
              view: { protocol: "anyam.project-view/v1", id: "project-view:mcp:1", projectId: String(payload.projectId), projectRevisionId: String(payload.projectRevisionId), projectionId: "projection:mcp:1", classification: "public", visibleSourceSpaceIds: ["source:mcp-public"], mounts: payload.mounts },
            };
          } else if (body.command === "change.create") {
            value = {
              change: { protocol: "anyam.change/v1", id: typeof payload.changeId === "string" ? payload.changeId : "change:mcp", projectId: String(payload.projectId), intentId: String(payload.intentId), baseProjectRevisionId: typeof payload.baseProjectRevisionId === "string" ? payload.baseProjectRevisionId : "project-revision:mcp:1", status: "active", latestRevisionId: null, workspaceId: payload.workspaceId, author: { id: "owner:private" } },
            };
          } else if (body.command === "revision.publish") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "revision=hidden; discoverable=false" }), { status: 404 });
            value = {
              revision: { protocol: "anyam.change/v1", id: typeof payload.revisionId === "string" ? payload.revisionId : "change-revision:mcp:1", changeId: String(payload.changeId), projectRevisionId: String(payload.projectRevisionId), projectViewId: String(payload.projectViewId), sequence: 1, parentRevisionId: undefined, baseProjectRevisionId: "project-revision:mcp:1", workspaceId: String(payload.workspaceId), declaredEffects: payload.declaredEffects, sourceSpaceSnapshots: payload.sourceSpaceSnapshots, affectedSourceSpaceIds: Object.keys(payload.sourceSpaceSnapshots as Record<string, unknown>), author: { id: "owner:private" }, kind: payload.kind ?? "implementation" },
                change: { protocol: "anyam.change/v1", id: String(payload.changeId), projectId: String(payload.projectId), intentId: "intent:mcp", baseProjectRevisionId: "project-revision:mcp:1", status: "submitted", latestRevisionId: typeof payload.revisionId === "string" ? payload.revisionId : "change-revision:mcp:1", workspaceId: String(payload.workspaceId), author: { id: "owner:private" } },
            };
          } else if (body.command === "run.record") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "run=hidden; discoverable=false" }), { status: 404 });
            value = {
              run: { protocol: "anyam.run/v1", id: typeof payload.runId === "string" ? payload.runId : "run:mcp:1", actionId: String(payload.actionId), projectRevisionId: String(payload.projectRevisionId), projectViewId: String(payload.projectViewId), runnerId: String(payload.runnerId), status: String(payload.status), outputDigest: payload.outputDigest, changeRevisionId: String(payload.changeRevisionId), workspaceId: String(payload.workspaceId), inputDigests: payload.inputDigests, outputDigests: payload.outputDigests, actor: { id: "owner:private" } },
            };
          } else if (body.command === "evidence.record") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "evidence=hidden; discoverable=false" }), { status: 404 });
            value = {
              evidence: { protocol: "anyam.evidence/v1", version: "v1", id: typeof payload.evidenceId === "string" ? payload.evidenceId : "evidence:mcp:1", key: String(payload.key), criterion: String(payload.criterion), outcome: String(payload.outcome), validityKey: String(payload.validityKey), actionId: String(payload.actionId), verifierId: String(payload.verifierId), toolchainDigest: String(payload.toolchainDigest), dependencyDigest: String(payload.dependencyDigest), environmentDigest: String(payload.environmentDigest), inputDigests: payload.inputDigests, effectDigests: payload.effectDigests, outputDigest: String(payload.outputDigest), createdAt: "2026-08-12T00:00:00.000Z", producer: { kind: "run", id: String(payload.runId), version: "anyam.run/v1" }, projectRevisionId: String(payload.projectRevisionId), projectViewId: String(payload.projectViewId), changeRevisionId: String(payload.changeRevisionId), runId: String(payload.runId), actor: { id: "owner:private" }, runnerId: String(payload.runnerId), policyVersion: String(payload.policyVersion), authorizationEpoch: String(payload.authorizationEpoch), capabilityGrantId: String(payload.capabilityGrantId), disclosure: payload.disclosure, receipt: String(payload.receipt), invalidators: payload.invalidators, owner: String(payload.owner), targetId: payload.targetId, workspaceId: String(payload.workspaceId) },
            };
          } else if (body.command === "artifact.record") {
            if (payload.projectId === "project:missing") return new Response(JSON.stringify({ code: "not_found", receipt: "artifact=hidden; discoverable=false" }), { status: 404 });
            value = {
              artifact: { protocol: "anyam.artifact/v1", id: typeof payload.artifactId === "string" ? payload.artifactId : "artifact:mcp:1", type: String(payload.type), digest: String(payload.digest), projectRevisionId: String(payload.projectRevisionId), changeRevisionId: payload.changeRevisionId, runId: payload.runId, actionId: payload.actionId, outputPath: payload.outputPath, provenanceDigest: payload.provenanceDigest, disclosure: payload.disclosure },
            };
          } else return new Response(JSON.stringify({ code: "invalid_request", receipt: "command=unsupported; credentialFree=true" }), { status: 422 });
          const result = { protocol: "anyam.authority-plane/v1", status: "succeeded", version: 1, value, receipt: `authority=coordinator; operation=${String(body.command)}; credentialFree=true; canonicalWrite=false` };
          idempotency.set(key, { fingerprint, result });
          return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/authority/projects/internal") return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          status: "ready",
          projects: [
            {
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git", sourceSpaceIds: ["source:public"] },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:alpha:1", projectId: "project:alpha", sourceSpaceSnapshots: { "source:public": "git:alpha-1" } },
              sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:public", name: "public", classification: "public" }],
              counts: { workspaces: 0, changes: 0, revisions: 0, runs: 0, evidence: 0, artifacts: 0, releases: 0, targets: 0, promotions: 0 },
            },
            {
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git", sourceSpaceIds: ["source:public"] },
              canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:video-player:1", projectId: "project:video-player", sourceSpaceSnapshots: { "source:public": "git:public-1" } },
              sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:public", name: "public", classification: "public" }],
              counts: { workspaces: 1, changes: 2, revisions: 3, runs: 4, evidence: 4, artifacts: 1, releases: 1, targets: 1, promotions: 1 },
            },
          ],
          receipt: "authority=coordinator; operation=project.list; projectCount=2; ordering=project-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false",
        }), { status: 200, headers: { "content-type": "application/json" } });
        if (path === "/authority/workspaces/internal") {
          const workspaces = [
            {
              workspace: { protocol: "anyam.workspace/v1", id: "workspace:alpha", projectId: "project:alpha", projectRevisionId: "project-revision:alpha:1", projectViewId: "project-view:alpha:1", state: "active" },
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git" },
              mountCount: 1,
            },
            {
              workspace: { protocol: "anyam.workspace/v1", id: "workspace:video-player", projectId: "project:video-player", projectRevisionId: "project-revision:video-player:1", projectViewId: "project-view:video-player:1", state: "active", changeId: "change:video-player" },
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git" },
              mountCount: 1,
            },
          ];
          if (body.workspaceId !== undefined) {
            const found = workspaces.find((entry) => entry.workspace.id === body.workspaceId);
            if (!found) return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            if (body.projectId !== undefined && found.workspace.projectId !== body.projectId) return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...found, receipt: `authority=coordinator; operation=workspace.inspect; workspace=${found.workspace.id}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
          }
          const filtered = body.projectId === undefined ? workspaces : workspaces.filter((entry) => entry.workspace.projectId === body.projectId);
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", workspaces: filtered, receipt: `authority=coordinator; operation=workspace.list; workspaceCount=${filtered.length}; ordering=workspace-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/authority/changes/internal") {
          const changes = [
            {
              change: { protocol: "anyam.change/v1", id: "change:alpha", projectId: "project:alpha", intentId: "intent:alpha", baseProjectRevisionId: "project-revision:alpha:1", status: "active", latestRevisionId: null },
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git" },
              revisionCount: 0,
            },
            {
              change: { protocol: "anyam.change/v1", id: "change:video-player", projectId: "project:video-player", intentId: "intent:codec", baseProjectRevisionId: "project-revision:video-player:1", status: "submitted", latestRevisionId: "change-revision:video-player:2", workspaceId: "workspace:video-player" },
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git" },
              revisionCount: 2,
            },
          ];
          if (body.changeId !== undefined) {
            const found = changes.find((entry) => entry.change.id === body.changeId);
            if (!found) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            const revisions = found.change.id === "change:video-player" ? [
              { protocol: "anyam.change/v1", id: "change-revision:video-player:1", changeId: "change:video-player", projectRevisionId: "candidate:video-player:1", projectViewId: "project-view:video-player:1", sequence: 1, baseProjectRevisionId: "project-revision:video-player:1", workspaceId: "workspace:video-player", declaredEffects: ["source.modify", "api.modify"], kind: "implementation" },
              { protocol: "anyam.change/v1", id: "change-revision:video-player:2", changeId: "change:video-player", projectRevisionId: "candidate:video-player:2", projectViewId: "project-view:video-player:1", sequence: 2, parentRevisionId: "change-revision:video-player:1", baseProjectRevisionId: "project-revision:video-player:1", workspaceId: "workspace:video-player", declaredEffects: ["source.modify"], kind: "rebase" },
            ] : [];
            if (body.projectId !== undefined && found.change.projectId !== body.projectId) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            if (body.workspaceId !== undefined && found.change.workspaceId !== body.workspaceId) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...found, revisions, receipt: `authority=coordinator; operation=change.inspect; change=${found.change.id}; revisionCount=${found.revisionCount}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
          }
          const filtered = changes.filter((entry) => (body.projectId === undefined || entry.change.projectId === body.projectId) && (body.workspaceId === undefined || entry.change.workspaceId === body.workspaceId));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", changes: filtered, receipt: `authority=coordinator; operation=change.list; changeCount=${filtered.length}; ordering=change-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path !== "/authority/project/internal") return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
        if (body.projectId !== "project:video-player") return new Response(JSON.stringify({ code: "not_found", receipt: `project=${String(body.projectId)}; discoverable=false` }), { status: 404 });
        return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          status: "ready",
          project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git", sourceSpaceIds: ["source:public"] },
          canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:video-player:1", projectId: "project:video-player", sourceSpaceSnapshots: { "source:public": "git:public-1" } },
          sourceSpaces: [{ protocol: "anyam.source-space/v1", id: "source:public", name: "public", classification: "public" }],
          counts: { workspaces: 1, changes: 2, revisions: 3, runs: 4, evidence: 4, artifacts: 1, releases: 1, targets: 1, promotions: 1 },
          receipt: "authority=coordinator; operation=project.inspect; project=project:video-player; readOnly=true; credentialFree=true; canonicalWrite=false",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
  return {
    env: {
      ANYAM_INSTALLATION_ID: "mcp-test",
      REALM_COORDINATOR: namespace,
    },
    calls,
  };
}

const props: AnyamRealmMcpProps = {
  scopes: ["project.read", "workspace.inspect", "change.inspect"],
  kernelSessionId: "kernel-session:owner",
};

async function body(response: Response): Promise<JsonRpcBody> {
  return await response.json() as JsonRpcBody;
}

function post(value: unknown): Request {
  return new Request("https://realm.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

test("remote MCP exposes an authenticated read-only project tool through the coordinator", async () => {
  const fixture = env();
  const initialized = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), fixture.env, props);
  assert.equal(initialized.status, 200);
  assert.equal(((await body(initialized)).result as Record<string, unknown>).protocolVersion, "2025-06-18");

  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), fixture.env, props);
  const listedBody = await body(listed);
  const tools = (listedBody.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["project.list", "project.inspect", "workspace.list", "workspace.inspect", "change.list", "change.inspect"]);

  const discovered = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project.list", arguments: {} } }), fixture.env, props);
  const discoveredBody = await body(discovered);
  const discoveredResult = discoveredBody.result as Record<string, unknown>;
  const discoveredContent = discoveredResult.structuredContent as Record<string, unknown>;
  assert.equal(discoveredResult.isError, false);
  assert.deepEqual((discoveredContent.projects as Array<Record<string, unknown>>).map((entry) => (entry.project as Record<string, unknown>).id), ["project:alpha", "project:video-player"]);
  assert.match(String(discoveredContent.receipt), /projectCount=2/);
  assert.equal(JSON.stringify(discoveredBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(discoveredBody).includes("credential:"), false);
  assert.equal(fixture.calls[0]?.path, "/authority/projects/internal");
  assert.equal(fixture.calls[0]?.body.sessionId, "kernel-session:owner");

  const workspaces = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "workspaces", method: "tools/call", params: { name: "workspace.list", arguments: { projectId: "project:video-player" } } }), fixture.env, props);
  const workspacesBody = await body(workspaces);
  const workspacesResult = workspacesBody.result as Record<string, unknown>;
  const workspaceContent = workspacesResult.structuredContent as Record<string, unknown>;
  assert.equal(workspacesResult.isError, false);
  assert.deepEqual((workspaceContent.workspaces as Array<Record<string, unknown>>).map((entry) => (entry.workspace as Record<string, unknown>).id), ["workspace:video-player"]);
  assert.match(String(workspaceContent.receipt), /workspaceCount=1/);
  assert.equal(JSON.stringify(workspacesBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(workspacesBody).includes("credential:"), false);
  assert.equal(JSON.stringify(workspacesBody).includes("sourceSpace"), false);
  assert.equal(fixture.calls[1]?.path, "/authority/workspaces/internal");
  assert.deepEqual(fixture.calls[1]?.body, { sessionId: "kernel-session:owner", projectId: "project:video-player" });

  const changes = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "changes", method: "tools/call", params: { name: "change.list", arguments: { projectId: "project:video-player", workspaceId: "workspace:video-player" } } }), fixture.env, props);
  const changesBody = await body(changes);
  const changesResult = changesBody.result as Record<string, unknown>;
  const changesContent = changesResult.structuredContent as Record<string, unknown>;
  assert.equal(changesResult.isError, false);
  assert.deepEqual((changesContent.changes as Array<Record<string, unknown>>).map((entry) => (entry.change as Record<string, unknown>).id), ["change:video-player"]);
  assert.match(String(changesContent.receipt), /changeCount=1/);
  assert.equal(JSON.stringify(changesBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(changesBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changesBody).includes("credential:"), false);
  assert.equal(fixture.calls[2]?.path, "/authority/changes/internal");
  assert.deepEqual(fixture.calls[2]?.body, { sessionId: "kernel-session:owner", projectId: "project:video-player", workspaceId: "workspace:video-player" });

  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project.inspect", arguments: { projectId: "project:video-player" } } }), fixture.env, props);
  const inspectedBody = await body(inspected);
  const result = inspectedBody.result as Record<string, unknown>;
  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as Record<string, unknown>).project && ((result.structuredContent as Record<string, unknown>).project as Record<string, unknown>).id, "project:video-player");
  assert.match(String((result.structuredContent as Record<string, unknown>).receipt), /read-only/);
  assert.equal(JSON.stringify(inspectedBody).includes("kernel-session"), false);
  assert.equal(fixture.calls[3]?.path, "/authority/project/internal");
  assert.equal(fixture.calls[3]?.body.sessionId, "kernel-session:owner");

  const workspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workspace.inspect", arguments: { workspaceId: "workspace:video-player" } } }), fixture.env, props);
  const workspaceBody = await body(workspace);
  const workspaceResult = workspaceBody.result as Record<string, unknown>;
  assert.equal(workspaceResult.isError, false);
  assert.equal(((workspaceResult.structuredContent as Record<string, unknown>).workspace as Record<string, unknown>).id, "workspace:video-player");
  assert.equal(((workspaceResult.structuredContent as Record<string, unknown>).workspace as Record<string, unknown>).mounts, undefined);
  assert.equal(JSON.stringify(workspaceBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(workspaceBody).includes("credential:"), false);
  assert.equal(fixture.calls[4]?.path, "/authority/workspaces/internal");
  assert.deepEqual(fixture.calls[4]?.body, { sessionId: "kernel-session:owner", workspaceId: "workspace:video-player" });

  const change = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "change.inspect", arguments: { changeId: "change:video-player" } } }), fixture.env, props);
  const changeBody = await body(change);
  const changeResult = changeBody.result as Record<string, unknown>;
  const changeContent = changeResult.structuredContent as Record<string, unknown>;
  assert.equal(changeResult.isError, false);
  assert.equal((changeContent.change as Record<string, unknown>).id, "change:video-player");
  assert.deepEqual((changeContent.revisions as Array<Record<string, unknown>>).map((revision) => revision.sequence), [1, 2]);
  assert.equal(JSON.stringify(changeBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changeBody).includes("\"author\":"), false);
  assert.equal(JSON.stringify(changeBody).includes("credential:"), false);
  assert.equal(fixture.calls[5]?.path, "/authority/changes/internal");
  assert.deepEqual(fixture.calls[5]?.body, { sessionId: "kernel-session:owner", changeId: "change:video-player" });
});

test("remote MCP exposes scope-filtered typed bootstrap mutations with idempotency and safe projections", async () => {
  const fixture = env();
  const writeProps: AnyamRealmMcpProps = { scopes: ["project.write", "workspace.write", "change.write"], kernelSessionId: "kernel-session:owner" };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixture.env, writeProps);
  const listedTools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(listedTools.map((tool) => tool.name), ["project.create", "workspace.create", "change.create", "change.publish_revision"]);

  const projectArguments = { idempotencyKey: "mcp-project-1", projectId: "project:mcp", name: "MCP Project", referenceType: "git", sourceSpaces: [{ id: "source:mcp-public", name: "public", classification: "public", snapshotId: "git:mcp-base" }] };
  const createdProject = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project.create", arguments: projectArguments } }), fixture.env, writeProps);
  const projectBody = await body(createdProject);
  const projectResult = projectBody.result as Record<string, unknown>;
  const projectContent = projectResult.structuredContent as Record<string, unknown>;
  assert.equal(projectResult.isError, false);
  assert.equal(projectContent.protocol, "anyam.remote-mcp/v1");
  assert.equal(projectContent.canonicalWrite, "initialization-only");
  assert.equal(((projectContent.project as Record<string, unknown>).id), "project:mcp");
  assert.equal(JSON.stringify(projectBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(projectBody).includes("git:mcp-base"), false);
  assert.equal(JSON.stringify(projectBody).includes("coordinatorReceipt"), false);
  assert.equal(JSON.stringify(projectBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(projectBody).includes("credential:"), false);
  assert.equal(fixture.calls.at(-1)?.path, "/authority/command/internal");
  assert.equal(fixture.calls.at(-1)?.body.protocol, "anyam.authority-command/v1");
  assert.equal(fixture.calls.at(-1)?.body.command, "project.create");
  assert.equal((fixture.calls.at(-1)?.body.payload as Record<string, unknown>).name, "MCP Project");
  assert.equal((fixture.calls.at(-1)?.body as Record<string, unknown>).command && JSON.stringify(fixture.calls.at(-1)?.body).includes("mcp-project-1"), true);

  const replay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "project.create", arguments: projectArguments } }), fixture.env, writeProps);
  const replayBody = await body(replay);
  assert.equal((replayBody.result as Record<string, unknown>).isError, false);
  assert.deepEqual((replayBody.result as Record<string, unknown>).structuredContent, projectContent);

  const conflict = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project.create", arguments: { ...projectArguments, name: "Different" } } }), fixture.env, writeProps);
  const conflictError = (await body(conflict)).error as Record<string, unknown>;
  assert.equal(conflictError.code, -32009);
  assert.equal((conflictError.data as Record<string, unknown>).code, "mcp.bootstrap_conflict");
  assert.equal(JSON.stringify(conflictError).includes("Different"), false);

  const createdWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workspace.create", arguments: { idempotencyKey: "mcp-workspace-1", projectId: "project:mcp", projectRevisionId: "project-revision:mcp:1", sourceSpaceIds: ["source:mcp-public"], mounts: ["private-codec"] } } }), fixture.env, writeProps);
  const workspaceBody = await body(createdWorkspace);
  const workspaceContent = (workspaceBody.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal((workspaceBody.result as Record<string, unknown>).isError, false);
  assert.equal((workspaceContent.workspace as Record<string, unknown>).id, "workspace:mcp");
  assert.equal((workspaceContent.workspace as Record<string, unknown>).mounts, undefined);
  assert.equal((workspaceContent.view as Record<string, unknown>).mounts, undefined);
  assert.equal(JSON.stringify(workspaceBody).includes("private-codec"), false);

  const createdChange = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "change.create", arguments: { idempotencyKey: "mcp-change-1", projectId: "project:mcp", intentId: "intent:mcp", baseProjectRevisionId: "project-revision:mcp:1", workspaceId: "workspace:mcp" } } }), fixture.env, writeProps);
  const changeBody = await body(createdChange);
  const changeContent = (changeBody.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal((changeBody.result as Record<string, unknown>).isError, false);
  assert.equal((changeContent.change as Record<string, unknown>).id, "change:mcp");
  assert.equal((changeContent.change as Record<string, unknown>).author, undefined);
  assert.equal(JSON.stringify(changeBody).includes("owner:private"), false);

  const revisionArguments = { idempotencyKey: "mcp-revision-1", projectId: "project:mcp", changeId: "change:mcp", workspaceId: "workspace:mcp", projectViewId: "project-view:mcp:1", projectRevisionId: "candidate:mcp:1", sourceSpaceSnapshots: { "source:mcp-public": "git:mcp-candidate" }, declaredEffects: ["source.modify"], kind: "implementation" };
  const published = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.1, method: "tools/call", params: { name: "change.publish_revision", arguments: revisionArguments } }), fixture.env, writeProps);
  const publishedBody = await body(published);
  const publishedResult = publishedBody.result as Record<string, unknown>;
  const publishedContent = publishedResult.structuredContent as Record<string, unknown>;
  assert.equal(publishedResult.isError, false);
  assert.equal(publishedContent.protocol, "anyam.remote-mcp/v1");
  assert.equal(publishedContent.canonicalWrite, false);
  assert.equal(((publishedContent.revision as Record<string, unknown>).id), "change-revision:mcp:1");
  assert.equal(((publishedContent.change as Record<string, unknown>).status), "submitted");
  assert.equal(JSON.stringify(publishedBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(publishedBody).includes("git:mcp-candidate"), false);
  assert.equal(JSON.stringify(publishedBody).includes("owner:private"), false);
  assert.equal(fixture.calls.at(-1)?.body.command, "revision.publish");

  const publishedReplay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.2, method: "tools/call", params: { name: "change.publish_revision", arguments: revisionArguments } }), fixture.env, writeProps);
  assert.deepEqual(((await body(publishedReplay)).result as Record<string, unknown>).structuredContent, publishedContent);
  const publishedConflict = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.3, method: "tools/call", params: { name: "change.publish_revision", arguments: { ...revisionArguments, projectRevisionId: "candidate:other" } } }), fixture.env, writeProps);
  assert.equal((((await body(publishedConflict)).error as Record<string, unknown>).code), -32009);

  const revisionReadOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.4, method: "tools/list" }), fixture.env, props);
  assert.equal((((await body(revisionReadOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>).some((tool) => tool.name === "change.publish_revision"), false);
  const revisionScopeDenied = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.45, method: "tools/call", params: { name: "change.publish_revision", arguments: revisionArguments } }), fixture.env, props);
  assert.equal((((await body(revisionScopeDenied)).error as Record<string, unknown>).code), -32001);
  const revisionHidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.46, method: "tools/call", params: { name: "change.publish_revision", arguments: { ...revisionArguments, idempotencyKey: "mcp-revision-hidden", projectId: "project:missing" } } }), fixture.env, writeProps);
  const revisionHiddenError = (await body(revisionHidden)).error as Record<string, unknown>;
  assert.equal(revisionHiddenError.code, -32004);
  assert.equal(JSON.stringify(revisionHiddenError).includes("project:missing"), false);
  const beforeRevisionInvalid = fixture.calls.length;
  const revisionInvalid = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.5, method: "tools/call", params: { name: "change.publish_revision", arguments: { ...revisionArguments, unsupported: true } } }), fixture.env, writeProps);
  assert.equal((((await body(revisionInvalid)).error as Record<string, unknown>).code), -32602);
  assert.equal(fixture.calls.length, beforeRevisionInvalid);

  const beforeInvalid = fixture.calls.length;
  const malformed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "project.create", arguments: { ...projectArguments, command: "raw" } } }), fixture.env, writeProps);
  const malformedError = (await body(malformed)).error as Record<string, unknown>;
  assert.equal(malformedError.code, -32602);
  assert.equal(fixture.calls.length, beforeInvalid);

  const missingKey = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "change.create", arguments: { projectId: "project:mcp", intentId: "intent:mcp" } } }), fixture.env, writeProps);
  assert.equal(((await body(missingKey)).error as Record<string, unknown>).code, -32602);
  assert.equal(fixture.calls.length, beforeInvalid);

  const hidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace.create", arguments: { idempotencyKey: "mcp-hidden", projectId: "project:missing", projectRevisionId: "project-revision:hidden", sourceSpaceIds: ["source:hidden"] } } }), fixture.env, writeProps);
  const hiddenError = (await body(hidden)).error as Record<string, unknown>;
  assert.equal(hiddenError.code, -32004);
  assert.equal(JSON.stringify(hiddenError).includes("project:missing"), false);

  const readOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 10, method: "tools/list" }), fixture.env, props);
  const readOnlyTools = ((await body(readOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(readOnlyTools.map((tool) => tool.name), ["project.list", "project.inspect", "workspace.list", "workspace.inspect", "change.list", "change.inspect"]);
  const projectWriteOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 11, method: "tools/list" }), fixture.env, { ...writeProps, scopes: ["project.write"] });
  assert.deepEqual((((await body(projectWriteOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>).map((tool) => tool.name), ["project.create"]);
  const changeWriteOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 12, method: "tools/list" }), fixture.env, { ...writeProps, scopes: ["change.write"] });
  assert.deepEqual((((await body(changeWriteOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>).map((tool) => tool.name), ["change.create", "change.publish_revision"]);
});

test("remote MCP exposes typed Run and Evidence recording under run.invoke with safe idempotent projections", async () => {
  const fixture = env();
  const runProps: AnyamRealmMcpProps = { scopes: ["run.invoke"], kernelSessionId: "kernel-session:owner" };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), fixture.env, runProps);
  const tools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["run.record", "evidence.record", "artifact.record"]);

  const runArguments = { idempotencyKey: "mcp-run-1", projectId: "project:mcp", runId: "run:mcp:1", actionId: "action:unit", projectRevisionId: "candidate:mcp:1", projectViewId: "project-view:mcp:1", runnerId: "runner:mcp", status: "succeeded", outputDigest: "sha256:run", changeRevisionId: "change-revision:mcp:1", workspaceId: "workspace:mcp", inputDigests: ["sha256:input"], outputDigests: ["sha256:run"] };
  const recordedRun = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run.record", arguments: runArguments } }), fixture.env, runProps);
  const runBody = await body(recordedRun);
  const runResult = runBody.result as Record<string, unknown>;
  const runContent = runResult.structuredContent as Record<string, unknown>;
  assert.equal(runResult.isError, false);
  assert.equal(runContent.protocol, "anyam.remote-mcp/v1");
  assert.equal(runContent.canonicalWrite, false);
  assert.equal(((runContent.run as Record<string, unknown>).id), "run:mcp:1");
  assert.equal(((runContent.run as Record<string, unknown>).actor), undefined);
  assert.equal(JSON.stringify(runBody).includes("owner:private"), false);
  assert.equal(JSON.stringify(runBody).includes("kernel-session"), false);
  assert.equal(fixture.calls.at(-1)?.body.command, "run.record");

  const runReplay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run.record", arguments: runArguments } }), fixture.env, runProps);
  assert.deepEqual(((await body(runReplay)).result as Record<string, unknown>).structuredContent, runContent);
  const runConflict = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run.record", arguments: { ...runArguments, status: "failed" } } }), fixture.env, runProps);
  assert.equal((((await body(runConflict)).error as Record<string, unknown>).code), -32009);

  const evidenceArguments = { idempotencyKey: "mcp-evidence-1", projectId: "project:mcp", evidenceId: "evidence:mcp:1", runId: "run:mcp:1", key: "unit", criterion: "unit tests pass", outcome: "passed", validityKey: "candidate:mcp:1:action:unit:verifier:unit", actionId: "action:unit", verifierId: "verifier:unit", toolchainDigest: "sha256:toolchain", dependencyDigest: "sha256:deps", environmentDigest: "sha256:env", inputDigests: ["sha256:input"], effectDigests: ["sha256:effect"], outputDigest: "sha256:run", projectRevisionId: "candidate:mcp:1", projectViewId: "project-view:mcp:1", changeRevisionId: "change-revision:mcp:1", runnerId: "runner:mcp", policyVersion: "policy:mcp", authorizationEpoch: "1", capabilityGrantId: "grant:mcp", disclosure: { projectionId: "project-view:mcp:1", classification: "project" }, receipt: "verifier=fixture; passed=true", invalidators: ["source-revision-change"], owner: "owner:mcp", targetId: "target:mcp", workspaceId: "workspace:mcp" };
  const recordedEvidence = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "evidence.record", arguments: evidenceArguments } }), fixture.env, runProps);
  const evidenceBody = await body(recordedEvidence);
  const evidenceResult = evidenceBody.result as Record<string, unknown>;
  const evidenceContent = evidenceResult.structuredContent as Record<string, unknown>;
  assert.equal(evidenceResult.isError, false);
  assert.equal(evidenceContent.canonicalWrite, false);
  assert.equal(((evidenceContent.evidence as Record<string, unknown>).id), "evidence:mcp:1");
  assert.equal(((evidenceContent.evidence as Record<string, unknown>).receipt), undefined);
  assert.equal(JSON.stringify(evidenceBody).includes("owner:private"), false);
  assert.equal(JSON.stringify(evidenceBody).includes("sha256:deps"), false);
  assert.equal(fixture.calls.at(-1)?.body.command, "evidence.record");

  const evidenceReplay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "evidence.record", arguments: evidenceArguments } }), fixture.env, runProps);
  assert.deepEqual(((await body(evidenceReplay)).result as Record<string, unknown>).structuredContent, evidenceContent);
  const artifactArguments = { idempotencyKey: "mcp-artifact-1", projectId: "project:mcp", artifactId: "artifact:mcp:1", type: "cli.archive", digest: "sha256:artifact", projectRevisionId: "candidate:mcp:1", changeRevisionId: "change-revision:mcp:1", runId: "run:mcp:1", actionId: "action:unit", outputPath: "dist/cli.archive", disclosure: { projectionId: "project-view:mcp:1", classification: "project" } };
  const recordedArtifact = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.1, method: "tools/call", params: { name: "artifact.record", arguments: artifactArguments } }), fixture.env, runProps);
  const artifactBody = await body(recordedArtifact);
  const artifactResult = artifactBody.result as Record<string, unknown>;
  const artifactContent = artifactResult.structuredContent as Record<string, unknown>;
  assert.equal(artifactResult.isError, false);
  assert.equal(artifactContent.canonicalWrite, false);
  assert.equal(((artifactContent.artifact as Record<string, unknown>).id), "artifact:mcp:1");
  assert.equal(((artifactContent.artifact as Record<string, unknown>).outputPath), undefined);
  assert.equal(JSON.stringify(artifactBody).includes("sha256:provenance"), false);
  assert.equal(fixture.calls.at(-1)?.body.command, "artifact.record");
  const artifactReplay = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 6.2, method: "tools/call", params: { name: "artifact.record", arguments: artifactArguments } }), fixture.env, runProps);
  assert.deepEqual(((await body(artifactReplay)).result as Record<string, unknown>).structuredContent, artifactContent);
  const beforeMalformed = fixture.calls.length;
  const malformed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run.record", arguments: { ...runArguments, unsupported: true } } }), fixture.env, runProps);
  assert.equal((((await body(malformed)).error as Record<string, unknown>).code), -32602);
  assert.equal(fixture.calls.length, beforeMalformed);
  const hidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "run.record", arguments: { ...runArguments, idempotencyKey: "mcp-run-hidden", projectId: "project:missing" } } }), fixture.env, runProps);
  const hiddenError = (await body(hidden)).error as Record<string, unknown>;
  assert.equal(hiddenError.code, -32004);
  assert.equal(JSON.stringify(hiddenError).includes("project:missing"), false);

  const denied = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run.record", arguments: runArguments } }), fixture.env, props);
  assert.equal((((await body(denied)).error as Record<string, unknown>).code), -32001);
  const artifactDenied = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "artifact.record", arguments: artifactArguments } }), fixture.env, props);
  assert.equal((((await body(artifactDenied)).error as Record<string, unknown>).code), -32001);
});

test("remote MCP fails closed for malformed requests, unknown methods, mutations, and undiscoverable projects", async () => {
  const fixture = env();
  const malformed = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp", { method: "POST", body: "{" }), fixture.env, props);
  const malformedBody = await body(malformed);
  assert.equal((malformedBody.error as Record<string, unknown>).code, -32700);

  const unknown = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "unknown", method: "secrets.read" }), fixture.env, props);
  assert.equal(((await body(unknown)).error as Record<string, unknown>).code, -32601);

  const mutation = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "mutate", method: "tools/call", params: { name: "landing.apply", arguments: {} } }), fixture.env, props);
  const mutationError = (await body(mutation)).error as Record<string, unknown>;
  assert.equal(mutationError.code, -32003);
  assert.match(String(mutationError.data && (mutationError.data as Record<string, unknown>).receipt), /canonicalWrite=false/);

  const hidden = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "hidden", method: "tools/call", params: { name: "project.inspect", arguments: { projectId: "project:private" } } }), fixture.env, props);
  const hiddenError = (await body(hidden)).error as Record<string, unknown>;
  assert.equal(hiddenError.code, -32004);
  assert.match(JSON.stringify(hiddenError), /not available/);
  assert.equal(JSON.stringify(hiddenError).includes("project:private"), false);

  const hiddenWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "hidden-workspace", method: "tools/call", params: { name: "workspace.inspect", arguments: { workspaceId: "workspace:private" } } }), fixture.env, props);
  const hiddenWorkspaceError = (await body(hiddenWorkspace)).error as Record<string, unknown>;
  assert.equal(hiddenWorkspaceError.code, -32004);
  assert.equal(JSON.stringify(hiddenWorkspaceError).includes("workspace:private"), false);

  const malformedWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "malformed-workspace", method: "tools/call", params: { name: "workspace.inspect", arguments: {} } }), fixture.env, props);
  assert.equal(((await body(malformedWorkspace)).error as Record<string, unknown>).code, -32602);

  const hiddenChange = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "hidden-change", method: "tools/call", params: { name: "change.inspect", arguments: { changeId: "change:private" } } }), fixture.env, props);
  const hiddenChangeError = (await body(hiddenChange)).error as Record<string, unknown>;
  assert.equal(hiddenChangeError.code, -32004);
  assert.equal(JSON.stringify(hiddenChangeError).includes("change:private"), false);

  const malformedChange = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "malformed-change", method: "tools/call", params: { name: "change.inspect", arguments: {} } }), fixture.env, props);
  assert.equal(((await body(malformedChange)).error as Record<string, unknown>).code, -32602);

  const noScope = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["source.read"] });
  assert.equal(((await body(noScope)).error as Record<string, unknown>).code, -32001);

  const workspaceOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "workspace-scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["workspace.inspect"] });
  const workspaceOnlyTools = ((await body(workspaceOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(workspaceOnlyTools.map((tool) => tool.name), ["workspace.list", "workspace.inspect"]);
  const deniedProject = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "denied-project", method: "tools/call", params: { name: "project.list", arguments: {} } }), fixture.env, { ...props, scopes: ["workspace.inspect"] });
  assert.equal(((await body(deniedProject)).error as Record<string, unknown>).code, -32001);

  const changeOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "change-scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["change.inspect"] });
  const changeOnlyTools = ((await body(changeOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(changeOnlyTools.map((tool) => tool.name), ["change.list", "change.inspect"]);
  const deniedWorkspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "denied-workspace", method: "tools/call", params: { name: "workspace.list", arguments: {} } }), fixture.env, { ...props, scopes: ["change.inspect"] });
  assert.equal(((await body(deniedWorkspace)).error as Record<string, unknown>).code, -32001);
});

test("remote MCP requires POST and treats initialized notification as a no-content acknowledgement", async () => {
  const fixture = env();
  const get = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp"), fixture.env, props);
  assert.equal(get.status, 405);
  const notification = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), fixture.env, props);
  assert.equal(notification.status, 202);
});
