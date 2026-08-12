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
  scopes: ["project.read"],
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
  assert.deepEqual(tools.map((tool) => tool.name), ["project.list", "project.inspect"]);

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

  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "project.inspect", arguments: { projectId: "project:video-player" } } }), fixture.env, props);
  const inspectedBody = await body(inspected);
  const result = inspectedBody.result as Record<string, unknown>;
  assert.equal(result.isError, false);
  assert.equal((result.structuredContent as Record<string, unknown>).project && ((result.structuredContent as Record<string, unknown>).project as Record<string, unknown>).id, "project:video-player");
  assert.match(String((result.structuredContent as Record<string, unknown>).receipt), /read-only/);
  assert.equal(JSON.stringify(inspectedBody).includes("kernel-session"), false);
  assert.equal(fixture.calls[1]?.path, "/authority/project/internal");
  assert.equal(fixture.calls[1]?.body.sessionId, "kernel-session:owner");
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

  const noScope = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: "scope", method: "tools/list" }), fixture.env, { ...props, scopes: ["source.read"] });
  assert.equal(((await body(noScope)).error as Record<string, unknown>).code, -32001);
});

test("remote MCP requires POST and treats initialized notification as a no-content acknowledgement", async () => {
  const fixture = env();
  const get = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp"), fixture.env, props);
  assert.equal(get.status, 405);
  const notification = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", method: "notifications/initialized" }), fixture.env, props);
  assert.equal(notification.status, 202);
});
