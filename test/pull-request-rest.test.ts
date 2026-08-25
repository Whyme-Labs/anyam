import assert from "node:assert/strict";
import test from "node:test";

import { handleAuthorityRequest } from "../apps/realm-worker/src/authority-edge.ts";
import type { AnyamRealmOAuthEnv } from "../apps/realm-worker/src/oauth-provider.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneError, AuthorityPlaneCoordinator, emptyAuthorityPlaneSnapshot, type AuthorityCommand, type AuthorityCommandName } from "../src/cloudflare/authority-plane.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

class MemoryKV {
  readonly values = new Map<string, string>();
  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) as unknown : value;
  }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

test("owner REST exposes a disclosure-safe Pull Request projection over stable Change lineage", async () => {
  const oauthKv = new MemoryKV();
  const ownerSessionId = "session:pull-request-rest";
  let coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot("realm:pull-request-rest"));
  const session = { realmId: "realm:pull-request-rest", principalId: "owner:pull-request-rest", actorId: "actor:pull-request-rest", sessionId: ownerSessionId, clientId: "client:anyam-web", authorizationEpoch: 1, kind: "human" as const };
  const namespace = {
    idFromName: (_name: string): string => "pull-request-rest-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        if (body.sessionId !== ownerSessionId) return new Response(JSON.stringify({ code: "session.invalid" }), { status: 403 });
        const path = new URL(request.url).pathname;
        if (path === "/authority/pull-requests/internal") {
          const snapshot = coordinator.snapshot();
          const pullRequestId = typeof body.pullRequestId === "string" ? body.pullRequestId : undefined;
          const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
          const ids = Object.keys(snapshot.pullRequests).filter((id) => (pullRequestId === undefined || id === pullRequestId) && (projectId === undefined || snapshot.pullRequests[id]?.projectId === projectId));
          if (pullRequestId !== undefined && ids.length === 0) return new Response(JSON.stringify({ code: "not_found", receipt: "pullRequest=hidden; discoverable=false" }), { status: 404 });
          const summary = (id: string) => {
            const pullRequest = snapshot.pullRequests[id]!;
            const change = snapshot.changes[pullRequest.changeId]!;
            const project = snapshot.projects[pullRequest.projectId]!;
            return { pullRequest, change: { protocol: change.protocol, id: change.id, projectId: change.projectId, intentId: change.intentId, status: change.status, latestRevisionId: change.latestRevisionId }, project: { protocol: project.protocol, id: project.id, name: project.name, referenceType: project.referenceType }, revisions: pullRequest.revisionIds.map((revisionId) => snapshot.changeRevisions[revisionId]).filter((revision): revision is NonNullable<typeof revision> => revision !== undefined).map((revision) => ({ id: revision.id, sequence: revision.sequence, projectRevisionId: revision.projectRevisionId, kind: revision.kind })) };
          };
          if (pullRequestId !== undefined) return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...summary(pullRequestId), receipt: "authority=coordinator; operation=pullRequest.inspect; readOnly=true; credentialFree=true; canonicalWrite=false" }));
          const pullRequests = ids.sort().map((id) => ({ ...summary(id), revisionCount: summary(id).revisions.length }));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", pullRequests, receipt: `authority=coordinator; operation=pullRequest.list; pullRequestCount=${pullRequests.length}; readOnly=true; credentialFree=true; canonicalWrite=false` }));
        }
        const command = { protocol: body.protocol, command: body.command, idempotencyKey: body.idempotencyKey, payload: body.payload } as unknown as AuthorityCommand;
        try {
          const result = coordinator.execute(command, session);
          return new Response(JSON.stringify(result), { status: result.status === "succeeded" ? 200 : 409, headers: { "content-type": "application/json" } });
        } catch (error) {
          if (error instanceof AuthorityPlaneError) return new Response(JSON.stringify({ code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }), { status: error.code === "not_found" ? 404 : 409 });
          throw error;
        }
      },
    }),
  };
  const env = { ANYAM_HOSTING_MODE: "customer-operated", ANYAM_INSTALLATION_ID: "pull-request-rest", ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1", ANYAM_REALM_RP_ID: "realm-pull-request.example", REALM_COORDINATOR: namespace, OAUTH_KV: oauthKv, ANYAM_METADATA_DB: {}, ANYAM_EXPORTS: {}, ANYAM_EVENTS: {}, ANYAM_WORKFLOW: {} } as unknown as AnyamRealmOAuthEnv;
  const hostSessionId = "host-session:pull-request-rest";
  await oauthKv.put(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({ protocol: "anyam.passkey-owner/v1", sessionId: hostSessionId, realmId: session.realmId, userId: session.principalId, displayName: "Pull Request REST owner", credentialId: "credential:pull-request-rest", kernelSessionId: ownerSessionId, actorId: session.actorId, expiresAt: new Date(Date.now() + 60_000).toISOString(), createdAt: new Date().toISOString() }));
  const cookie = { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` };
  const authorityCommand = (command: AuthorityCommandName, idempotencyKey: string, payload: Record<string, unknown>) => coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command, idempotencyKey, payload }, session);
  assert.equal(authorityCommand("project.create", "project:create", { projectId: "project:pull-request-rest", name: "REST Pull Request", referenceType: "git", sourceSpaces: [{ id: "source:pull-request-rest", name: "public", classification: "public", snapshotId: "commit:base" }], projectRevisionId: "project-revision:base" }).status, "succeeded");
  const workspace = authorityCommand("workspace.create", "workspace:create", { projectId: "project:pull-request-rest", workspaceId: "workspace:pull-request-rest", projectRevisionId: "project-revision:base", sourceSpaceIds: ["source:pull-request-rest"], mounts: ["source"] });
  const projectViewId = (workspace.value.view as { id: string }).id;
  assert.equal(authorityCommand("change.create", "change:create", { projectId: "project:pull-request-rest", changeId: "change:pull-request-rest", intentId: "intent:pull-request-rest", baseProjectRevisionId: "project-revision:base", workspaceId: "workspace:pull-request-rest" }).status, "succeeded");
  const revision = authorityCommand("revision.publish", "revision:publish", { projectId: "project:pull-request-rest", changeId: "change:pull-request-rest", workspaceId: "workspace:pull-request-rest", projectViewId, projectRevisionId: "project-revision:candidate", sourceSpaceSnapshots: { "source:pull-request-rest": "commit:feature" }, declaredEffects: ["source.modify"] });
  const revisionId = (revision.value.revision as { id: string }).id;
  const request = async (path: string, method: "GET" | "POST", body: Record<string, unknown> = {}, idempotencyKey = "rest:pull-request"): Promise<{ response: Response; value: Record<string, unknown> }> => {
    const init: RequestInit = { method, headers: { ...cookie, "content-type": "application/json", "idempotency-key": idempotencyKey } };
    if (method === "POST") init.body = JSON.stringify(body);
    const response = await handleAuthorityRequest(new Request(`https://realm.example${path}`, init), env);
    assert.ok(response);
    return { response, value: await response.json() as Record<string, unknown> };
  };
  const opened = await request("/api/pull-requests", "POST", { projectId: "project:pull-request-rest", pullRequestId: "pr:rest", changeId: "change:pull-request-rest", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:feature", baseCommit: "commit:base", title: "REST Pull Request", disclosure: "public", revisionIds: [revisionId] }, "rest:open");
  assert.equal(opened.response.status, 200);
  assert.equal((opened.value.pullRequest as Record<string, unknown>).id, "pr:rest");
  const listed = await request("/api/pull-requests?projectId=project%3Apull-request-rest", "GET");
  assert.equal(listed.response.status, 200);
  assert.equal((listed.value.pullRequests as Array<Record<string, unknown>>).length, 1);
  const inspected = await request("/api/pull-requests/pr%3Arest", "GET");
  assert.equal(inspected.response.status, 200);
  assert.equal((inspected.value.pullRequest as Record<string, unknown>).changeId, "change:pull-request-rest");
  const reviewed = await request("/api/pull-requests/pr%3Arest/review", "POST", { reviewState: "approved", reviewDigest: "sha256:review" }, "rest:review");
  assert.equal((reviewed.value.pullRequest as Record<string, unknown>).reviewState, "approved");
  const closed = await request("/api/pull-requests/pr%3Arest/close", "POST", {}, "rest:close");
  assert.equal((closed.value.pullRequest as Record<string, unknown>).status, "closed");
  const reopened = await request("/api/pull-requests/pr%3Arest/reopen", "POST", {}, "rest:reopen");
  assert.equal((reopened.value.pullRequest as Record<string, unknown>).status, "open");
});
