import assert from "node:assert/strict";
import test from "node:test";

import { handleAnyamRealmMcpRequest, type AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

function post(value: unknown): Request {
  return new Request("https://realm.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}

async function body(response: Response): Promise<Record<string, unknown>> { return await response.json() as Record<string, unknown>; }

test("remote MCP exposes Pull Request compatibility tools with stable Change lineage", async () => {
  const pullRequests = new Map<string, Record<string, unknown>>();
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const namespace = {
    idFromName: (name: string): string => name,
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const requestBody = await request.json() as Record<string, unknown>;
        calls.push({ path, body: requestBody });
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        if (path === "/authority/pull-requests/internal") {
          const pullRequestId = typeof requestBody.pullRequestId === "string" ? requestBody.pullRequestId : undefined;
          const values = [...pullRequests.values()].filter((pullRequest) => pullRequestId === undefined || pullRequest.id === pullRequestId);
          if (pullRequestId !== undefined && values.length === 0) return new Response(JSON.stringify({ code: "not_found", receipt: "pullRequest=hidden; discoverable=false" }), { status: 404 });
          const summary = (pullRequest: Record<string, unknown>) => ({ pullRequest, change: { protocol: "anyam.change/v1", id: pullRequest.changeId, projectId: pullRequest.projectId, intentId: "intent:mcp-pr", status: "landed", latestRevisionId: "revision:mcp-pr" }, project: { protocol: "anyam.project/v1", id: pullRequest.projectId, name: "MCP PR", referenceType: "git" }, revisions: [{ id: "revision:mcp-pr", sequence: 1, projectRevisionId: "project-revision:mcp-pr", kind: "implementation" }] });
          if (pullRequestId !== undefined) return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...summary(values[0]!), receipt: "authority=coordinator; operation=pullRequest.inspect; readOnly=true; credentialFree=true; canonicalWrite=false" }));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", pullRequests: values.map((pullRequest) => ({ ...summary(pullRequest), revisionCount: 1 })), receipt: "authority=coordinator; operation=pullRequest.list; pullRequestCount=1; readOnly=true; credentialFree=true; canonicalWrite=false" }));
        }
        if (path === "/authority/mcp-command/internal") {
          const payload = requestBody.payload as Record<string, unknown>;
          const command = String(requestBody.command);
          const id = typeof payload.pullRequestId === "string" ? payload.pullRequestId : "pr:mcp";
          const existing = pullRequests.get(id);
          const next = command === "pullRequest.open"
            ? { protocol: "anyam.pull-request/v1", id, projectId: String(payload.projectId), changeId: String(payload.changeId), provider: String(payload.provider), headRef: String(payload.headRef), baseRef: String(payload.baseRef), headCommit: String(payload.headCommit), baseCommit: String(payload.baseCommit), title: String(payload.title), description: "", status: "open", reviewState: "pending", revisionIds: ["revision:mcp-pr"], disclosure: "project" }
            : command === "pullRequest.update" && existing
              ? { ...existing, headCommit: payload.headCommit ?? existing.headCommit, revisionIds: ["revision:mcp-pr"] }
              : command === "pullRequest.review" && existing
                ? { ...existing, reviewState: payload.reviewState, reviewDigest: payload.reviewDigest }
                : command === "pullRequest.close" && existing
                  ? { ...existing, status: "closed" }
                  : command === "pullRequest.reopen" && existing
                    ? { ...existing, status: "open" }
                    : command === "pullRequest.block" && existing
                      ? { ...existing, status: "blocked" }
                      : command === "pullRequest.merge" && existing
                        ? { ...existing, status: "merged" }
                        : existing;
          if (!next) return new Response(JSON.stringify({ code: "not_found", receipt: "pullRequest=hidden; discoverable=false" }), { status: 404 });
          pullRequests.set(id, next);
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "succeeded", value: { pullRequest: next }, receipt: `authority=coordinator; operation=${command}; credentialFree=true; canonicalWrite=false` }));
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    }),
  };
  const env = { ANYAM_INSTALLATION_ID: "pull-request-mcp", REALM_COORDINATOR: namespace } as never;
  const props: AnyamRealmMcpProps = { scopes: ["pullRequest.inspect", "pullRequest.write"], realmId: "realm:pull-request-mcp", kernelSessionId: "kernel-session:agent", agentId: "agent:pull-request", taskId: "task:pull-request", capabilityGrantId: "grant:pull-request", resource: { realmId: "realm:pull-request-mcp", projectId: "project:mcp-pr" }, sourceSpaceIds: ["source:mcp-pr"] };
  const listed = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), env, props);
  const tools = ((await body(listed)).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), ["pullRequest.list", "pullRequest.inspect", "pullRequest.open", "pullRequest.update", "pullRequest.review", "pullRequest.close", "pullRequest.reopen", "pullRequest.block", "pullRequest.merge"]);
  const open = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pullRequest.open", arguments: { idempotencyKey: "mcp-pr-open", pullRequestId: "pr:mcp", projectId: "project:mcp-pr", changeId: "change:mcp-pr", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:one", baseCommit: "commit:base", title: "MCP PR" } } }), env, props);
  assert.equal(((await body(open)).result as Record<string, unknown>).isError, false);
  assert.equal(calls.at(-1)?.body.capability, "pullRequest.write");
  const update = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pullRequest.update", arguments: { idempotencyKey: "mcp-pr-update", pullRequestId: "pr:mcp", headCommit: "commit:two" } } }), env, props);
  const updateContent = ((await body(update)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal(((updateContent.value as Record<string, unknown>).pullRequest as Record<string, unknown>).headCommit, "commit:two");
  const review = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pullRequest.review", arguments: { idempotencyKey: "mcp-pr-review", pullRequestId: "pr:mcp", reviewState: "approved", reviewDigest: "sha256:review" } } }), env, props);
  const reviewContent = ((await body(review)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal(((reviewContent.value as Record<string, unknown>).pullRequest as Record<string, unknown>).reviewState, "approved");
  const inspected = await handleAnyamRealmMcpRequest(post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pullRequest.inspect", arguments: { pullRequestId: "pr:mcp" } } }), env, props);
  const inspectedContent = ((await body(inspected)).result as Record<string, unknown>).structuredContent as Record<string, unknown>;
  assert.equal((inspectedContent.pullRequest as Record<string, unknown>).id, "pr:mcp");
});
