import assert from "node:assert/strict";
import test from "node:test";

import { handleAnyamRealmMcpRequest, type AnyamRealmMcpEnv, type AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

type JsonRpcBody = Record<string, unknown>;

function env(): { env: AnyamRealmMcpEnv; calls: Array<{ path: string; body: Record<string, unknown> }> } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const namespace = {
    idFromName: (name: string): string => name,
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        calls.push({ path, body });
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        if (body.sessionId !== "kernel-session:owner") return new Response(JSON.stringify({ code: "session.invalid", receipt: "session=invalid; project=not-disclosed" }), { status: 403 });
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
  scopes: ["project.read", "workspace.inspect"],
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
  assert.deepEqual(tools.map((tool) => tool.name), ["project.list", "project.inspect", "workspace.list", "workspace.inspect"]);

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

  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project.inspect", arguments: { projectId: "project:video-player" } } }), fixture.env, props);
  const inspectedBody = await body(inspected);
  const result = inspectedBody.result as Record<string, unknown>;
  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as Record<string, unknown>).project && ((result.structuredContent as Record<string, unknown>).project as Record<string, unknown>).id, "project:video-player");
  assert.match(String((result.structuredContent as Record<string, unknown>).receipt), /read-only/);
  assert.equal(JSON.stringify(inspectedBody).includes("kernel-session"), false);
  assert.equal(fixture.calls[2]?.path, "/authority/project/internal");
  assert.equal(fixture.calls[2]?.body.sessionId, "kernel-session:owner");

  const workspace = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "workspace.inspect", arguments: { workspaceId: "workspace:video-player" } } }), fixture.env, props);
  const workspaceBody = await body(workspace);
  const workspaceResult = workspaceBody.result as Record<string, unknown>;
  assert.equal(workspaceResult.isError, false);
  assert.equal(((workspaceResult.structuredContent as Record<string, unknown>).workspace as Record<string, unknown>).id, "workspace:video-player");
  assert.equal(((workspaceResult.structuredContent as Record<string, unknown>).workspace as Record<string, unknown>).mounts, undefined);
  assert.equal(JSON.stringify(workspaceBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(workspaceBody).includes("credential:"), false);
  assert.equal(fixture.calls[3]?.path, "/authority/workspaces/internal");
  assert.deepEqual(fixture.calls[3]?.body, { sessionId: "kernel-session:owner", workspaceId: "workspace:video-player" });
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

  const noScope = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["source.read"] });
  assert.equal(((await body(noScope)).error as Record<string, unknown>).code, -32001);

  const workspaceOnly = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "workspace-scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["workspace.inspect"] });
  const workspaceOnlyTools = ((await body(workspaceOnly)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(workspaceOnlyTools.map((tool) => tool.name), ["workspace.list", "workspace.inspect"]);
  const deniedProject = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "denied-project", method: "tools/call", params: { name: "project.list", arguments: {} } }), fixture.env, { ...props, scopes: ["workspace.inspect"] });
  assert.equal(((await body(deniedProject)).error as Record<string, unknown>).code, -32001);
});

test("remote MCP requires POST and treats initialized notification as a no-content acknowledgement", async () => {
  const fixture = env();
  const get = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp"), fixture.env, props);
  assert.equal(get.status, 405);
  const notification = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), fixture.env, props);
  assert.equal(notification.status, 202);
});
