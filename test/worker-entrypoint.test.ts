import assert from "node:assert/strict";
import test from "node:test";

import providerTarget from "../apps/provider-qualification-target/src/index.ts";
import replayArchiveWorker, { type Env as ReplayArchiveEnv } from "../apps/replay-archive-workload-qualification/src/index.ts";
import { handleAuthorityRequest } from "../apps/realm-worker/src/authority-edge.ts";
import { handleAnyamRealmOwnerRequest } from "../apps/realm-worker/src/passkey-owner.ts";
import { handleAnyamRealmMcpRequest, type AnyamRealmMcpEnv, type AnyamRealmMcpProps } from "../apps/realm-worker/src/mcp-handler.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneError, AuthorityPlaneCoordinator, authorityStateSummary, emptyAuthorityPlaneSnapshot, type AuthorityCommand } from "../src/cloudflare/authority-plane.ts";
import type { AnyamRealmOAuthEnv } from "../apps/realm-worker/src/oauth-provider.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

type StoredObject = { arrayBuffer(): Promise<ArrayBuffer> };

class MemoryKV {
  readonly values = new Map<string, string>();

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) as unknown : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function memoryR2(): { bucket: Record<string, unknown>; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, value: string): Promise<void> {
      objects.set(key, value);
    },
    async get(key: string): Promise<StoredObject | null> {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { arrayBuffer: async () => new TextEncoder().encode(value).buffer };
    },
    async delete(keys: string | string[]): Promise<void> {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async head(key: string): Promise<object | null> {
      return objects.has(key) ? {} : null;
    },
    async list(input: { prefix?: string }): Promise<{ objects: readonly { key: string }[]; truncated: false }> {
      return { objects: [...objects.keys()].filter((key) => !input.prefix || key.startsWith(input.prefix)).map((key) => ({ key })), truncated: false };
    },
  };
  return { bucket, objects };
}

test("provider Target entrypoint accepts the declared operation envelope and rejects malformed input", async () => {
  const invalid = await providerTarget.fetch(new Request("https://target.example/", { method: "POST", body: JSON.stringify({}) }));
  assert.equal(invalid.status, 422);

  const operationId = "operation:worker-entrypoint-test";
  const accepted = await providerTarget.fetch(new Request("https://target.example/", { method: "POST", body: JSON.stringify({ protocol: "anyam.customer-provider-operation/v1", operationId }) }));
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { protocol: "anyam.customer-provider-operation/v1", operationId, status: "accepted", target: "disposable-worker" });

  const readBack = await providerTarget.fetch(new Request(`https://target.example/?operationId=${encodeURIComponent(operationId)}`));
  assert.equal(readBack.status, 200);
  assert.equal((await readBack.json() as { operationId: string }).operationId, operationId);
});

test("replay archive qualification entrypoint enforces its binding-shaped credential boundary and exact cleanup", async () => {
  const { bucket, objects } = memoryR2();
  const env = { PUBLIC_GATEWAY_REPLAY_ARCHIVE: bucket, PROJECT_ID: "project:entrypoint-test", QUALIFICATION_TOKEN: "qualification-secret" } as unknown as ReplayArchiveEnv;
  const sample = {
    category: "terminal-denial",
    tombstone: {
      requestId: "request:entrypoint-test",
      payloadDigest: "sha256:payload-entrypoint-test",
      contributionId: "contribution:entrypoint-test",
      originalStatus: "denied",
      recordedAt: "2026-08-11T00:00:00.000Z",
      compactedAt: "2026-08-11T00:30:00.000Z",
      exportDigest: "sha256:export-entrypoint-test",
      receipt: "entrypoint=fixture; exact=true",
    },
  };
  const body = JSON.stringify({ samples: [sample] });
  const unauthenticated = await replayArchiveWorker.fetch(new Request("https://replay.example/measure", { method: "POST", body }), env);
  assert.equal(unauthenticated.status, 401);

  const headers = { authorization: "Bearer qualification-secret", "content-type": "application/json" };
  const measured = await replayArchiveWorker.fetch(new Request("https://replay.example/measure", { method: "POST", headers, body }), env);
  assert.equal(measured.status, 200);
  assert.equal((await measured.json() as { status: string }).status, "succeeded");
  assert.equal(objects.size, 1);

  const cleaned = await replayArchiveWorker.fetch(new Request("https://replay.example/cleanup", { method: "POST", headers, body }), env);
  assert.equal(cleaned.status, 200);
  assert.equal((await cleaned.json() as { status: string }).status, "succeeded");
  assert.equal(objects.size, 0);
});

test("Realm Worker Authority Plane runs an authenticated Project-to-Promotion command path through binding-shaped Durable Object state", async () => {
  const oauthKv = new MemoryKV();
  const ownerSessionId = "session:authority-test";
  let authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot("realm:authority-test"));
  const namespace = {
    idFromName: (_name: string): string => "authority-test-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        if (body.sessionId !== ownerSessionId) return new Response(JSON.stringify({ code: "session.invalid" }), { status: 403 });
        if (new URL(request.url).pathname === "/authority/recovery/export/internal") return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "recovery-exported", snapshot: authority.snapshot(), credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=exported; credentialFree=true; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
        if (new URL(request.url).pathname === "/authority/recovery/restore/internal") {
          authority = new AuthorityPlaneCoordinator(body.snapshot as never);
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "recovery-restored", credentialFree: true, canonicalWrite: false, receipt: "authorityRecovery=restored; state=replaced; credentialFree=true; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (new URL(request.url).pathname === "/authority/state/internal") return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", authority: authorityStateSummary(authority.snapshot()) }));
        if (new URL(request.url).pathname === "/authority/workspaces/internal") {
          const snapshot = authority.snapshot();
          const workspaceIds = Object.keys(snapshot.workspaces).filter((id) => body.workspaceId === undefined || id === body.workspaceId).filter((id) => body.projectId === undefined || snapshot.workspaces[id]?.projectId === body.projectId).sort();
          const workspaces = workspaceIds.map((id) => {
            const workspace = snapshot.workspaces[id]!;
            const project = snapshot.projects[workspace.projectId]!;
            return { workspace: { protocol: workspace.protocol, id: workspace.id, projectId: workspace.projectId, projectRevisionId: workspace.projectRevisionId, projectViewId: workspace.projectViewId, state: workspace.state, ...(workspace.changeId ? { changeId: workspace.changeId } : {}) }, project: { protocol: project.protocol, id: project.id, name: project.name, referenceType: project.referenceType }, mountCount: workspace.mounts.length };
          });
          if (body.workspaceId !== undefined && workspaces.length === 0) return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
          if (body.workspaceId !== undefined) return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...workspaces[0], receipt: "authority=coordinator; operation=workspace.inspect; readOnly=true; credentialFree=true; canonicalWrite=false" }));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", workspaces, receipt: `authority=coordinator; operation=workspace.list; workspaceCount=${workspaces.length}; ordering=workspace-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }));
        }
        if (new URL(request.url).pathname === "/authority/changes/internal") {
          const snapshot = authority.snapshot();
          const changeIds = Object.keys(snapshot.changes).filter((id) => body.changeId === undefined || id === body.changeId).filter((id) => body.projectId === undefined || snapshot.changes[id]?.projectId === body.projectId).filter((id) => body.workspaceId === undefined || snapshot.changes[id]?.workspaceId === body.workspaceId).sort();
          const summaries = changeIds.map((id) => {
            const change = snapshot.changes[id]!;
            const project = snapshot.projects[change.projectId]!;
            const revisions = Object.values(snapshot.changeRevisions).filter((revision) => revision.changeId === id).sort((left, right) => left.sequence - right.sequence).map((revision) => ({ protocol: revision.protocol, id: revision.id, changeId: revision.changeId, projectRevisionId: revision.projectRevisionId, projectViewId: revision.projectViewId, sequence: revision.sequence, ...(revision.parentRevisionId ? { parentRevisionId: revision.parentRevisionId } : {}), ...(revision.baseProjectRevisionId ? { baseProjectRevisionId: revision.baseProjectRevisionId } : {}), ...(revision.workspaceId ? { workspaceId: revision.workspaceId } : {}), declaredEffects: [...revision.declaredEffects], ...(revision.kind ? { kind: revision.kind } : {}) }));
            return { change: { protocol: change.protocol, id: change.id, projectId: change.projectId, intentId: change.intentId, baseProjectRevisionId: change.baseProjectRevisionId, status: change.status, latestRevisionId: change.latestRevisionId, ...(change.workspaceId ? { workspaceId: change.workspaceId } : {}) }, project: { protocol: project.protocol, id: project.id, name: project.name, referenceType: project.referenceType }, revisionCount: revisions.length, revisions };
          });
          if (body.changeId !== undefined && summaries.length === 0) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
          if (body.changeId !== undefined) return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...summaries[0], receipt: "authority=coordinator; operation=change.inspect; readOnly=true; credentialFree=true; canonicalWrite=false" }));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", changes: summaries.map(({ revisions, ...summary }) => ({ ...summary, revisionCount: revisions.length })), receipt: `authority=coordinator; operation=change.list; changeCount=${summaries.length}; ordering=change-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }));
        }
        if (new URL(request.url).pathname === "/authority/runs/internal") {
          const snapshot = authority.snapshot();
          const runId = typeof body.runId === "string" ? body.runId : "";
          const run = snapshot.runs[runId];
          if (!run) return new Response(JSON.stringify({ code: "not_found", receipt: "run=hidden; discoverable=false" }), { status: 404 });
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", run: { protocol: run.protocol, id: run.id, actionId: run.actionId, projectRevisionId: run.projectRevisionId, projectViewId: run.projectViewId, runnerId: run.runnerId, status: run.status, ...(run.attemptId ? { attemptId: run.attemptId } : {}) }, receipt: "authority=coordinator; operation=run.inspect; readOnly=true; completion=runner-only; credentialFree=true; canonicalWrite=false" }));
        }
        const command = { ...body, protocol: body.protocol, command: body.command, idempotencyKey: body.idempotencyKey, payload: body.payload } as unknown as AuthorityCommand;
        try {
          const result = authority.execute(command, { realmId: "realm:authority-test", principalId: "owner:authority-test", actorId: "actor:authority-test", sessionId: ownerSessionId, clientId: "client:anyam-web", authorizationEpoch: 1 });
          return new Response(JSON.stringify(result), { status: result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503, headers: { "content-type": "application/json" } });
        } catch (error) {
          if (error instanceof AuthorityPlaneError) return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", code: error.code, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt }), { status: error.code === "not_found" ? 404 : error.code === "stale_state" || error.code === "conflict" || error.code === "idempotency_conflict" ? 409 : 422, headers: { "content-type": "application/json" } });
          throw error;
        }
      },
    }),
  };
  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "authority-test",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-test.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;
  const hostSessionId = "host-session:authority-test";
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:authority-test",
    userId: "owner:authority-test",
    displayName: "Authority Test Owner",
    credentialId: "credential:authority-test",
    kernelSessionId: ownerSessionId,
    actorId: "actor:authority-test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
  const command = async (commandName: string, idempotencyKey: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await handleAuthorityRequest(new Request("https://realm.example/api/authority/command", {
      method: "POST",
      headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`, "content-type": "application/json" },
      body: JSON.stringify({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: commandName, idempotencyKey, payload }),
    }), env);
    assert.ok(response);
    const value = await response.json() as Record<string, unknown>;
    assert.ok(response.status === 200 || response.status === 409, JSON.stringify(value));
    return value;
  };
  const record = async (pathname: string, idempotencyKey: string, payload: Record<string, unknown>, method = "POST"): Promise<{ response: Response; value: Record<string, unknown> }> => {
    const init: RequestInit = {
      method,
      headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    };
    if (method !== "GET") init.body = JSON.stringify(payload);
    const response = await handleAuthorityRequest(new Request(`https://realm.example${pathname}`, init), env);
    assert.ok(response);
    return { response, value: await response.json() as Record<string, unknown> };
  };
  const bootstrap = async (pathname: string, idempotencyKey: string, payload: Record<string, unknown>, method = "POST"): Promise<{ response: Response; value: Record<string, unknown> }> => {
    const init: RequestInit = {
      method,
      headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`, "content-type": "application/json", "idempotency-key": idempotencyKey },
    };
    if (method !== "GET") init.body = JSON.stringify(payload);
    const response = await handleAuthorityRequest(new Request(`https://realm.example${pathname}`, init), env);
    assert.ok(response);
    return { response, value: await response.json() as Record<string, unknown> };
  };
  const state = async (): Promise<Record<string, unknown>> => {
    const response = await handleAuthorityRequest(new Request("https://realm.example/api/authority/state", { headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` } }), env);
    assert.ok(response);
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  };

  const projectBootstrap = await bootstrap("/api/projects", "idem:typed-project", { projectId: "project:typed-authority-test", name: "Typed Authority Test", referenceType: "git", sourceSpaces: [{ id: "source:typed-authority-test", name: "public", classification: "public", snapshotId: "git:base" }] });
  assert.equal(projectBootstrap.response.status, 200);
  assert.equal(projectBootstrap.value.status, "succeeded");
  assert.equal(projectBootstrap.value.canonicalWrite, "initialization-only");
  assert.equal(JSON.stringify(projectBootstrap.value).includes("sourceSpaceSnapshots"), false);
  const project = projectBootstrap.value.project as { id: string };
  const canonicalBefore = (projectBootstrap.value.canonicalRevision as { id: string }).id;
  const workspaceBootstrap = await bootstrap(`/api/projects/${encodeURIComponent(project.id)}/workspaces`, "idem:typed-workspace", { projectRevisionId: canonicalBefore, sourceSpaceIds: ["source:typed-authority-test"], mounts: ["source"] });
  assert.equal(workspaceBootstrap.response.status, 200);
  assert.equal(workspaceBootstrap.value.status, "succeeded");
  assert.equal(JSON.stringify(workspaceBootstrap.value).includes("mounts"), false);
  const workspace = workspaceBootstrap.value.workspace as { id: string; projectViewId: string };
  const workspaceListResponse = await namespace.get("authority-test-do").fetch(new Request("https://realm-coordinator/authority/workspaces/internal", { method: "POST", headers: { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "content-type": "application/json" }, body: JSON.stringify({ sessionId: ownerSessionId, projectId: project.id }) }));
  assert.equal(workspaceListResponse.status, 200);
  const workspaceList = await workspaceListResponse.json() as Record<string, unknown>;
  assert.deepEqual((workspaceList.workspaces as Array<Record<string, unknown>>).map((entry) => (entry.workspace as Record<string, unknown>).id), [workspace.id]);
  assert.equal(JSON.stringify(workspaceList).includes("mounts"), false);
  assert.equal(JSON.stringify(workspaceList).includes("actorId"), false);
  assert.match(String(workspaceList.receipt), /ordering=workspace-id-code-unit-ascending/);
  const workspaceInspectResponse = await namespace.get("authority-test-do").fetch(new Request("https://realm-coordinator/authority/workspaces/internal", { method: "POST", headers: { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "content-type": "application/json" }, body: JSON.stringify({ sessionId: ownerSessionId, workspaceId: workspace.id }) }));
  assert.equal(workspaceInspectResponse.status, 200);
  const workspaceInspect = await workspaceInspectResponse.json() as Record<string, unknown>;
  assert.equal(((workspaceInspect.workspace as Record<string, unknown>).id), workspace.id);
  assert.equal(JSON.stringify(workspaceInspect).includes("credential:"), false);
  const changeBootstrap = await bootstrap(`/api/projects/${encodeURIComponent(project.id)}/changes`, "idem:typed-change", { intentId: "intent:typed-authority-test", baseProjectRevisionId: canonicalBefore, workspaceId: workspace.id });
  assert.equal(changeBootstrap.response.status, 200);
  assert.equal(changeBootstrap.value.status, "succeeded");
  assert.equal(JSON.stringify(changeBootstrap.value).includes("\"author\":"), false);
  const change = changeBootstrap.value.change as { id: string };
  const revisionPayload = { projectId: project.id, changeId: change.id, workspaceId: workspace.id, projectViewId: workspace.projectViewId, projectRevisionId: "candidate:authority-test", sourceSpaceSnapshots: { "source:typed-authority-test": "git:candidate" }, declaredEffects: ["source.modify"] };
  const revisionRest = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision", revisionPayload);
  assert.equal(revisionRest.response.status, 200, JSON.stringify(revisionRest.value));
  assert.equal(revisionRest.value.status, "succeeded");
  assert.equal(revisionRest.value.credentialFree, true);
  assert.equal(revisionRest.value.canonicalWrite, false);
  assert.equal(JSON.stringify(revisionRest.value).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(revisionRest.value).includes("actor"), false);
  assert.match(String(revisionRest.value.receipt), /revision\.publish/);
  const revisionReplayRest = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision", revisionPayload);
  assert.deepEqual(revisionReplayRest.value, revisionRest.value);
  const revisionHidden = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision-hidden", { ...revisionPayload, projectId: "project:hidden" });
  assert.equal(revisionHidden.response.status, 404);
  assert.equal(revisionHidden.value.code, "revision_publish_not_found");
  assert.equal(JSON.stringify(revisionHidden.value).includes("project:hidden"), false);
  const revisionPathMismatch = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision-path-mismatch", { ...revisionPayload, changeId: "change:other" });
  assert.equal(revisionPathMismatch.response.status, 422);
  assert.equal(revisionPathMismatch.value.code, "invalid_request");
  const revisionKeyMismatch = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision-key-mismatch", { ...revisionPayload, idempotencyKey: "body-key" });
  assert.equal(revisionKeyMismatch.response.status, 422);
  assert.equal(revisionKeyMismatch.value.code, "invalid_request");
  const revisionUnknownField = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision-unknown", { ...revisionPayload, unsupported: true });
  assert.equal(revisionUnknownField.response.status, 422);
  assert.equal(revisionUnknownField.value.code, "invalid_request");
  const revisionWrongMethod = await record(`/api/changes/${encodeURIComponent(change.id)}/revisions`, "idem:revision-method", revisionPayload, "PUT");
  assert.equal(revisionWrongMethod.response.status, 405);
  assert.equal(revisionWrongMethod.value.code, "method_not_allowed");
  const revisionMissingKey = await handleAuthorityRequest(new Request(`https://realm.example/api/changes/${encodeURIComponent(change.id)}/revisions`, { method: "POST", headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`, "content-type": "application/json" }, body: JSON.stringify(revisionPayload) }), env);
  assert.ok(revisionMissingKey);
  assert.equal(revisionMissingKey.status, 422);
  assert.equal((await revisionMissingKey.json() as Record<string, unknown>).code, "invalid_request");
  const revisionMalformedJson = await handleAuthorityRequest(new Request(`https://realm.example/api/changes/${encodeURIComponent(change.id)}/revisions`, { method: "POST", headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`, "content-type": "application/json", "idempotency-key": "idem:revision-json" }, body: "{" }), env);
  assert.ok(revisionMalformedJson);
  assert.equal(revisionMalformedJson.status, 422);
  assert.equal((await revisionMalformedJson.json() as Record<string, unknown>).code, "invalid_request");
  const revision = (revisionRest.value.revision as { id: string });
  const changeListResponse = await namespace.get("authority-test-do").fetch(new Request("https://realm-coordinator/authority/changes/internal", { method: "POST", headers: { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "content-type": "application/json" }, body: JSON.stringify({ sessionId: ownerSessionId, projectId: project.id, workspaceId: workspace.id }) }));
  assert.equal(changeListResponse.status, 200);
  const changeList = await changeListResponse.json() as Record<string, unknown>;
  assert.deepEqual((changeList.changes as Array<Record<string, unknown>>).map((entry) => (entry.change as Record<string, unknown>).id), [change.id]);
  assert.equal(JSON.stringify(changeList).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changeList).includes("\"author\":"), false);
  assert.match(String(changeList.receipt), /ordering=change-id-code-unit-ascending/);
  const changeInspectResponse = await namespace.get("authority-test-do").fetch(new Request("https://realm-coordinator/authority/changes/internal", { method: "POST", headers: { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "content-type": "application/json" }, body: JSON.stringify({ sessionId: ownerSessionId, changeId: change.id }) }));
  assert.equal(changeInspectResponse.status, 200);
  const changeInspect = await changeInspectResponse.json() as Record<string, unknown>;
  assert.equal(((changeInspect.change as Record<string, unknown>).id), change.id);
  assert.deepEqual((changeInspect.revisions as Array<Record<string, unknown>>).map((entry) => entry.sequence), [1]);
  assert.equal(JSON.stringify(changeInspect).includes("sourceSpaceSnapshots"), false);
  const beforeLanding = await state();
  assert.equal(((beforeLanding.authority as Record<string, unknown>).canonicalByProject as Record<string, string>)[project.id], canonicalBefore);
  const runRequestPayload = { projectId: project.id, runId: "run:authority-request", actionId: "action:unit", actionContractDigest: "sha256:action-contract", verifierId: "verifier:unit", verifierContractDigest: "sha256:verifier-contract", projectRevisionId: "candidate:authority-test", projectViewId: workspace.projectViewId, changeRevisionId: revision.id, workspaceId: workspace.id, inputDigests: ["sha256:input"], outputDigests: ["dist/cli.archive=sha256:output"], policyVersion: "policy:authority-test", authorizationEpoch: "1", capabilityGrantId: "grant:authority-test" };
  const runRequestResponse = await namespace.get("authority-test-do").fetch(new Request("https://realm-coordinator/authority/command/internal", { method: "POST", headers: { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "content-type": "application/json" }, body: JSON.stringify({ protocol: "anyam.authority-command/v1", command: "run.request", idempotencyKey: "idem:run-request", payload: runRequestPayload, sessionId: ownerSessionId }) }));
  if (runRequestResponse.status !== 200) throw new Error(`run request failed: ${await runRequestResponse.text()}`);
  const runRequest = await runRequestResponse.json() as Record<string, unknown>;
  assert.equal(((runRequest.value as Record<string, unknown>).run as Record<string, unknown>).status, "queued");
  assert.equal(((runRequest.value as Record<string, unknown>).run as Record<string, unknown>).runnerId, "runner:unassigned");
  const runInspectResponse = await namespace.get("authority-test-do").fetch(new Request("https://realm-coordinator/authority/runs/internal", { method: "POST", headers: { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "content-type": "application/json" }, body: JSON.stringify({ sessionId: ownerSessionId, runId: "run:authority-request" }) }));
  assert.equal(runInspectResponse.status, 200);
  const runInspect = await runInspectResponse.json() as Record<string, unknown>;
  assert.equal(((runInspect.run as Record<string, unknown>).status), "queued");
  assert.match(String(runInspect.receipt), /completion=runner-only/u);

  const callerRun = await record("/api/runs", "idem:caller-run", { ...runRequestPayload, status: "succeeded", runnerId: "runner:caller", outputDigest: "sha256:forged" });
  assert.equal(callerRun.response.status, 410);
  assert.equal(callerRun.value.code, "runner_completion_only");
  const callerEvidence = await record("/api/evidence", "idem:caller-evidence", { projectId: project.id, runId: "run:authority-request", outcome: "passed" });
  assert.equal(callerEvidence.response.status, 410);
  assert.equal(callerEvidence.value.code, "runner_completion_only");
  const callerArtifact = await record("/api/artifacts", "idem:caller-artifact", { projectId: project.id, runId: "run:authority-request", digest: "sha256:forged", projectRevisionId: "candidate:authority-test", type: "cli.archive" });
  assert.equal(callerArtifact.response.status, 410);
  assert.equal(callerArtifact.value.code, "runner_completion_only");
});

test("Realm Worker exposes an authenticated project-scoped REST read through the Coordinator", async () => {
  const oauthKv = new MemoryKV();
  const ownerSessionId = "session:project-read-test";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const namespace = {
    idFromName: (_name: string): string => "project-read-test-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        calls.push({ path, body });
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        if (body.sessionId !== ownerSessionId) return new Response(JSON.stringify({ code: "session.invalid", receipt: "session=invalid; project=not-disclosed" }), { status: 403 });
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
        if (path === "/authority/changes/internal") {
          const changes = [
            {
              change: { protocol: "anyam.change/v1", id: "change:alpha", projectId: "project:alpha", intentId: "intent:alpha", baseProjectRevisionId: "project-revision:alpha:1", status: "active", latestRevisionId: null },
              project: { protocol: "anyam.project/v1", id: "project:alpha", name: "Alpha", referenceType: "git" },
              revisionCount: 0,
              revisions: [],
            },
            {
              change: { protocol: "anyam.change/v1", id: "change:video-player", projectId: "project:video-player", intentId: "intent:codec", baseProjectRevisionId: "project-revision:video-player:1", status: "submitted", latestRevisionId: "change-revision:video-player:2", workspaceId: "workspace:video-player" },
              project: { protocol: "anyam.project/v1", id: "project:video-player", name: "Video Player", referenceType: "git" },
              revisionCount: 2,
              revisions: [
                { protocol: "anyam.change/v1", id: "change-revision:video-player:1", changeId: "change:video-player", projectRevisionId: "candidate:video-player:1", projectViewId: "project-view:video-player:1", sequence: 1, baseProjectRevisionId: "project-revision:video-player:1", workspaceId: "workspace:video-player", declaredEffects: ["source.modify", "api.modify"], kind: "implementation" },
                { protocol: "anyam.change/v1", id: "change-revision:video-player:2", changeId: "change:video-player", projectRevisionId: "candidate:video-player:2", projectViewId: "project-view:video-player:1", sequence: 2, parentRevisionId: "change-revision:video-player:1", baseProjectRevisionId: "project-revision:video-player:1", workspaceId: "workspace:video-player", declaredEffects: ["source.modify"], kind: "rebase" },
              ],
            },
          ];
          if (body.changeId !== undefined) {
            const found = changes.find((entry) => entry.change.id === body.changeId);
            if (!found || (body.projectId !== undefined && found.change.projectId !== body.projectId) || (body.workspaceId !== undefined && found.change.workspaceId !== body.workspaceId)) return new Response(JSON.stringify({ code: "not_found", receipt: "change=hidden; discoverable=false" }), { status: 404 });
            return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", change: found.change, project: found.project, revisions: found.revisions, receipt: `authority=coordinator; operation=change.inspect; change=${found.change.id}; revisionCount=${found.revisionCount}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
          }
          const filtered = changes.filter((entry) => (body.projectId === undefined || entry.change.projectId === body.projectId) && (body.workspaceId === undefined || entry.change.workspaceId === body.workspaceId));
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", changes: filtered.map(({ revisions, ...summary }) => summary), receipt: `authority=coordinator; operation=change.list; changeCount=${filtered.length}; ordering=change-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
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
            if (!found || (body.projectId !== undefined && found.workspace.projectId !== body.projectId)) return new Response(JSON.stringify({ code: "not_found", receipt: "workspace=hidden; discoverable=false" }), { status: 404 });
            return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", ...found, receipt: `authority=coordinator; operation=workspace.inspect; workspace=${found.workspace.id}; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
          }
          const filtered = workspaces.filter((entry) => body.projectId === undefined || entry.workspace.projectId === body.projectId);
          return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "ready", workspaces: filtered, receipt: `authority=coordinator; operation=workspace.list; workspaceCount=${filtered.length}; ordering=workspace-id-code-unit-ascending; readOnly=true; credentialFree=true; canonicalWrite=false` }), { status: 200, headers: { "content-type": "application/json" } });
        }
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
  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "project-read-test",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-test.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;
  const hostSessionId = "host-session:project-read-test";
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:project-read-test",
    userId: "owner:project-read-test",
    displayName: "Project Read Test Owner",
    credentialId: "credential:project-read-test",
    kernelSessionId: ownerSessionId,
    actorId: "actor:project-read-test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
  const cookie = { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` };
  const unauthenticated = await handleAuthorityRequest(new Request("https://realm.example/api/projects/project%3Avideo-player"), env);
  assert.ok(unauthenticated);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as Record<string, unknown>).code, "owner_authentication_required");
  assert.equal(calls.length, 0);

  const response = await handleAuthorityRequest(new Request("https://realm.example/api/projects/project%3Avideo-player", { headers: cookie }), env);
  assert.ok(response);
  assert.equal(response.status, 200);
  const value = await response.json() as Record<string, unknown>;
  assert.equal((value.project as Record<string, unknown>).id, "project:video-player");
  assert.equal((value.canonicalRevision as Record<string, unknown>).id, "project-revision:video-player:1");
  assert.equal((value.counts as Record<string, unknown>).changes, 2);
  assert.match(String(value.receipt), /readOnly=true/);
  assert.match(String(value.receipt), /canonicalWrite=false/);
  assert.equal(JSON.stringify(value).includes("kernel-session"), false);
  assert.equal(JSON.stringify(value).includes("credential:project-read-test"), false);
  assert.deepEqual(calls[0], { path: "/authority/project/internal", body: { sessionId: ownerSessionId, projectId: "project:video-player" } });

  const hidden = await handleAuthorityRequest(new Request("https://realm.example/api/projects/project%3Aprivate", { headers: cookie }), env);
  assert.ok(hidden);
  assert.equal(hidden.status, 404);
  const hiddenBody = await hidden.json() as Record<string, unknown>;
  assert.equal(hiddenBody.code, "project_not_found");
  assert.equal(JSON.stringify(hiddenBody).includes("project:private"), false);
  assert.match(String(hiddenBody.receipt), /credentialFree=true/);
  assert.match(String(hiddenBody.receipt), /canonicalWrite=false/);

  const malformed = await handleAuthorityRequest(new Request("https://realm.example/api/projects/%E0%A4%A", { headers: cookie }), env);
  assert.ok(malformed);
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as Record<string, unknown>).code, "invalid_project_path");

  const callsBeforeUnauthenticatedList = calls.length;
  const unauthenticatedList = await handleAuthorityRequest(new Request("https://realm.example/api/projects"), env);
  assert.ok(unauthenticatedList);
  assert.equal(unauthenticatedList.status, 401);
  assert.equal((await unauthenticatedList.json() as Record<string, unknown>).code, "owner_authentication_required");
  assert.equal(calls.length, callsBeforeUnauthenticatedList);

  const unsupported = await handleAuthorityRequest(new Request("https://realm.example/api/projects/project%3Avideo-player", { method: "POST", headers: cookie }), env);
  assert.ok(unsupported);
  assert.equal(unsupported.status, 405);
  assert.equal((await unsupported.json() as Record<string, unknown>).code, "method_not_allowed");

  const list = await handleAuthorityRequest(new Request("https://realm.example/api/projects", { headers: cookie }), env);
  assert.ok(list);
  assert.equal(list.status, 200);
  const listBody = await list.json() as Record<string, unknown>;
  const projects = listBody.projects as Array<Record<string, unknown>>;
  assert.deepEqual(projects.map((entry) => (entry.project as Record<string, unknown>).id), ["project:alpha", "project:video-player"]);
  assert.equal(JSON.stringify(listBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(listBody).includes("credential:project-read-test"), false);
  assert.match(String(listBody.receipt), /ordering=project-id-code-unit-ascending/);
  assert.match(String(listBody.receipt), /projectCount=2/);
  assert.deepEqual(calls.at(-1), { path: "/authority/projects/internal", body: { sessionId: ownerSessionId } });

  const listUnsupported = await handleAuthorityRequest(new Request("https://realm.example/api/projects", { method: "PUT", headers: cookie }), env);
  assert.ok(listUnsupported);
  assert.equal(listUnsupported.status, 405);
  assert.equal((await listUnsupported.json() as Record<string, unknown>).code, "method_not_allowed");

  const callsBeforeUnauthenticatedChangeList = calls.length;
  const unauthenticatedChangeList = await handleAuthorityRequest(new Request("https://realm.example/api/changes"), env);
  assert.ok(unauthenticatedChangeList);
  assert.equal(unauthenticatedChangeList.status, 401);
  assert.equal((await unauthenticatedChangeList.json() as Record<string, unknown>).code, "owner_authentication_required");
  assert.equal(calls.length, callsBeforeUnauthenticatedChangeList);

  const changeListResponse = await handleAuthorityRequest(new Request("https://realm.example/api/changes?projectId=project%3Avideo-player&workspaceId=workspace%3Avideo-player", { headers: cookie }), env);
  assert.ok(changeListResponse);
  assert.equal(changeListResponse.status, 200);
  const changeListBody = await changeListResponse.json() as Record<string, unknown>;
  assert.deepEqual((changeListBody.changes as Array<Record<string, unknown>>).map((entry) => (entry.change as Record<string, unknown>).id), ["change:video-player"]);
  assert.match(String(changeListBody.receipt), /ordering=change-id-code-unit-ascending/);
  assert.equal(JSON.stringify(changeListBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changeListBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(changeListBody).includes("credential:project-read-test"), false);
  assert.deepEqual(calls.at(-1), { path: "/authority/changes/internal", body: { sessionId: ownerSessionId, projectId: "project:video-player", workspaceId: "workspace:video-player" } });

  const changeInspectResponse = await handleAuthorityRequest(new Request("https://realm.example/api/changes/change%3Avideo-player?projectId=project%3Avideo-player", { headers: cookie }), env);
  assert.ok(changeInspectResponse);
  assert.equal(changeInspectResponse.status, 200);
  const changeInspectBody = await changeInspectResponse.json() as Record<string, unknown>;
  assert.equal((changeInspectBody.change as Record<string, unknown>).id, "change:video-player");
  assert.deepEqual((changeInspectBody.revisions as Array<Record<string, unknown>>).map((revision) => revision.sequence), [1, 2]);
  assert.equal(JSON.stringify(changeInspectBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(changeInspectBody).includes("\"author\":"), false);
  assert.equal(JSON.stringify(changeInspectBody).includes("credential:"), false);
  assert.deepEqual(calls.at(-1), { path: "/authority/changes/internal", body: { sessionId: ownerSessionId, changeId: "change:video-player", projectId: "project:video-player" } });

  const hiddenChange = await handleAuthorityRequest(new Request("https://realm.example/api/changes/change%3Aprivate", { headers: cookie }), env);
  assert.ok(hiddenChange);
  assert.equal(hiddenChange.status, 404);
  const hiddenChangeBody = await hiddenChange.json() as Record<string, unknown>;
  assert.equal(hiddenChangeBody.code, "change_not_found");
  assert.equal(JSON.stringify(hiddenChangeBody).includes("change:private"), false);
  assert.match(String(hiddenChangeBody.receipt), /credentialFree=true/);

  const malformedChangePath = await handleAuthorityRequest(new Request("https://realm.example/api/changes/%E0%A4%A", { headers: cookie }), env);
  assert.ok(malformedChangePath);
  assert.equal(malformedChangePath.status, 400);
  assert.equal((await malformedChangePath.json() as Record<string, unknown>).code, "invalid_change_path");

  const extraChangePath = await handleAuthorityRequest(new Request("https://realm.example/api/changes/change%3Avideo-player/revisions", { headers: cookie }), env);
  assert.ok(extraChangePath);
  assert.equal(extraChangePath.status, 405);
  assert.equal((await extraChangePath.json() as Record<string, unknown>).code, "method_not_allowed");

  const malformedRevisionPath = await handleAuthorityRequest(new Request("https://realm.example/api/changes/change%3Avideo-player/revisions/extra", { headers: cookie }), env);
  assert.ok(malformedRevisionPath);
  assert.equal(malformedRevisionPath.status, 400);
  assert.equal((await malformedRevisionPath.json() as Record<string, unknown>).code, "invalid_change_path");

  const malformedChangeQuery = await handleAuthorityRequest(new Request("https://realm.example/api/changes?projectId=project%3Avideo-player&projectId=project%3Aalpha", { headers: cookie }), env);
  assert.ok(malformedChangeQuery);
  assert.equal(malformedChangeQuery.status, 400);
  assert.equal((await malformedChangeQuery.json() as Record<string, unknown>).code, "invalid_change_query");

  const unsupportedChangeQuery = await handleAuthorityRequest(new Request("https://realm.example/api/changes?intentId=intent%3Acodec", { headers: cookie }), env);
  assert.ok(unsupportedChangeQuery);
  assert.equal(unsupportedChangeQuery.status, 400);
  assert.equal((await unsupportedChangeQuery.json() as Record<string, unknown>).code, "invalid_change_query");

  const unsupportedChange = await handleAuthorityRequest(new Request("https://realm.example/api/changes/change%3Avideo-player", { method: "POST", headers: cookie }), env);
  assert.ok(unsupportedChange);
  assert.equal(unsupportedChange.status, 405);
  assert.equal((await unsupportedChange.json() as Record<string, unknown>).code, "method_not_allowed");

  const callsBeforeUnauthenticatedWorkspaceList = calls.length;
  const unauthenticatedWorkspaceList = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces"), env);
  assert.ok(unauthenticatedWorkspaceList);
  assert.equal(unauthenticatedWorkspaceList.status, 401);
  assert.equal((await unauthenticatedWorkspaceList.json() as Record<string, unknown>).code, "owner_authentication_required");
  assert.equal(calls.length, callsBeforeUnauthenticatedWorkspaceList);

  const workspaceListResponse = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces?projectId=project%3Avideo-player", { headers: cookie }), env);
  assert.ok(workspaceListResponse);
  assert.equal(workspaceListResponse.status, 200);
  const workspaceListBody = await workspaceListResponse.json() as Record<string, unknown>;
  assert.deepEqual((workspaceListBody.workspaces as Array<Record<string, unknown>>).map((entry) => (entry.workspace as Record<string, unknown>).id), ["workspace:video-player"]);
  assert.match(String(workspaceListBody.receipt), /ordering=workspace-id-code-unit-ascending/);
  assert.equal(JSON.stringify(workspaceListBody).includes("mounts"), false);
  assert.equal(JSON.stringify(workspaceListBody).includes("kernel-session"), false);
  assert.equal(JSON.stringify(workspaceListBody).includes("credential:project-read-test"), false);
  assert.deepEqual(calls.at(-1), { path: "/authority/workspaces/internal", body: { sessionId: ownerSessionId, projectId: "project:video-player" } });

  const workspaceInspectResponse = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces/workspace%3Avideo-player?projectId=project%3Avideo-player", { headers: cookie }), env);
  assert.ok(workspaceInspectResponse);
  assert.equal(workspaceInspectResponse.status, 200);
  const workspaceInspectBody = await workspaceInspectResponse.json() as Record<string, unknown>;
  assert.equal((workspaceInspectBody.workspace as Record<string, unknown>).id, "workspace:video-player");
  assert.equal((workspaceInspectBody.workspace as Record<string, unknown>).mounts, undefined);
  assert.equal(JSON.stringify(workspaceInspectBody).includes("sourceSpaceSnapshots"), false);
  assert.equal(JSON.stringify(workspaceInspectBody).includes("credential:"), false);
  assert.deepEqual(calls.at(-1), { path: "/authority/workspaces/internal", body: { sessionId: ownerSessionId, workspaceId: "workspace:video-player", projectId: "project:video-player" } });

  const hiddenWorkspace = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces/workspace%3Aprivate", { headers: cookie }), env);
  assert.ok(hiddenWorkspace);
  assert.equal(hiddenWorkspace.status, 404);
  const hiddenWorkspaceBody = await hiddenWorkspace.json() as Record<string, unknown>;
  assert.equal(hiddenWorkspaceBody.code, "workspace_not_found");
  assert.equal(JSON.stringify(hiddenWorkspaceBody).includes("workspace:private"), false);

  const malformedWorkspacePath = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces/%E0%A4%A", { headers: cookie }), env);
  assert.ok(malformedWorkspacePath);
  assert.equal(malformedWorkspacePath.status, 400);
  assert.equal((await malformedWorkspacePath.json() as Record<string, unknown>).code, "invalid_workspace_path");

  const extraWorkspacePath = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces/workspace%3Avideo-player/mounts", { headers: cookie }), env);
  assert.ok(extraWorkspacePath);
  assert.equal(extraWorkspacePath.status, 400);
  assert.equal((await extraWorkspacePath.json() as Record<string, unknown>).code, "invalid_workspace_path");

  const malformedWorkspaceQuery = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces?projectId=project%3Avideo-player&projectId=project%3Aalpha", { headers: cookie }), env);
  assert.ok(malformedWorkspaceQuery);
  assert.equal(malformedWorkspaceQuery.status, 400);
  assert.equal((await malformedWorkspaceQuery.json() as Record<string, unknown>).code, "invalid_workspace_query");

  const unsupportedWorkspaceQuery = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces?workspaceId=workspace%3Avideo-player", { headers: cookie }), env);
  assert.ok(unsupportedWorkspaceQuery);
  assert.equal(unsupportedWorkspaceQuery.status, 400);
  assert.equal((await unsupportedWorkspaceQuery.json() as Record<string, unknown>).code, "invalid_workspace_query");

  const unsupportedWorkspace = await handleAuthorityRequest(new Request("https://realm.example/api/workspaces/workspace%3Avideo-player", { method: "POST", headers: cookie }), env);
  assert.ok(unsupportedWorkspace);
  assert.equal(unsupportedWorkspace.status, 405);
  assert.equal((await unsupportedWorkspace.json() as Record<string, unknown>).code, "method_not_allowed");
});

test("Realm Worker MCP entrypoint scope-filters authenticated delivery tools", async () => {
  const env = { ANYAM_INSTALLATION_ID: "mcp-entrypoint-test", REALM_COORDINATOR: {} } as unknown as AnyamRealmMcpEnv;
  const props: AnyamRealmMcpProps = { scopes: ["landing.request", "release.create", "target.configure", "promotion.request"], kernelSessionId: "session:mcp-entrypoint", anyamGrantId: "grant:mcp-entrypoint" };
  const listed = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, props);
  assert.equal(listed.status, 200);
  const listedBody = await listed.json() as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(listedBody.result.tools.map((tool) => tool.name), ["landing.apply", "release.create", "target.configure", "promotion.request"]);

  const missingGrant = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), env, { scopes: ["project.read", ...props.scopes], kernelSessionId: "session:mcp-entrypoint" });
  assert.equal(missingGrant.status, 200);
  const missingGrantBody = await missingGrant.json() as { result: { tools: Array<{ name: string }> } };
  assert.deepEqual(missingGrantBody.result.tools.map((tool) => tool.name), ["project.list", "project.inspect"]);
});

test("Realm Worker MCP entrypoint validates the live delivery grant before authority mutation", async () => {
  const sessionId = "session:mcp-entrypoint-delivery";
  const calls: string[] = [];
  const namespace = {
    idFromName: (name: string): string => name,
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        const body = await request.json() as Record<string, unknown>;
        if (body.sessionId !== sessionId) return new Response(JSON.stringify({ code: "session.invalid" }), { status: 403 });
        if (path === "/identity/oauth-grant/validate-delivery") return new Response(JSON.stringify({ protocol: "anyam.realm-coordinator/v1", status: "delivery-grant-valid", credentialFree: true, canonicalWrite: false, providerExecution: "not-performed", receipt: "mcpDelivery=task-grant-live; oauthGrant=resource-bound; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
        if (path === "/authority/mcp-command/internal" || path === "/authority/command/internal") return new Response(JSON.stringify({ protocol: "anyam.authority-plane/v1", status: "succeeded", version: 1, value: {
          landing: { protocol: "anyam.landing/v1", id: "landing:entrypoint", projectId: "project:entrypoint", changeId: "change:entrypoint", changeRevisionId: "change-revision:entrypoint", previousProjectRevisionId: "project-revision:entrypoint:1", projectRevisionId: "project-revision:entrypoint:2" },
          canonicalRevision: { protocol: "anyam.kernel/v1", id: "project-revision:entrypoint:2", projectId: "project:entrypoint" },
          change: { protocol: "anyam.change/v1", id: "change:entrypoint", projectId: "project:entrypoint", intentId: "intent:entrypoint", baseProjectRevisionId: "project-revision:entrypoint:1", status: "landed", latestRevisionId: "change-revision:entrypoint" },
        }, receipt: "authority=entrypoint-fixture; operation=landing.apply; credentialFree=true; canonicalWrite=false" }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    }),
  };
  const env = { ANYAM_INSTALLATION_ID: "mcp-entrypoint-delivery-test", REALM_COORDINATOR: namespace } as unknown as AnyamRealmMcpEnv;
  const props: AnyamRealmMcpProps = { scopes: ["landing.request"], realmId: "realm:mcp-entrypoint-delivery-test", kernelSessionId: sessionId, resource: { realmId: "realm:mcp-entrypoint-delivery-test", projectId: "project:entrypoint" }, sourceSpaceIds: ["source:public"], anyamGrantId: "grant:mcp-entrypoint-delivery", mcpResource: "https://realm.example/mcp/projects/project:entrypoint?sourceSpaceId=source:public" };
  const response = await handleAnyamRealmMcpRequest(new Request("https://realm.example/mcp/projects/project:entrypoint", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "landing.apply", arguments: { idempotencyKey: "entrypoint-landing", projectId: "project:entrypoint", changeId: "change:entrypoint", changeRevisionId: "change-revision:entrypoint", expectedCanonicalProjectRevisionId: "project-revision:entrypoint:1", projectRevisionId: "project-revision:entrypoint:2" } } }) }), env, props);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal((body.result as Record<string, unknown>).isError, false);
  assert.equal(calls[0], "/identity/oauth-grant/validate-delivery");
  assert.equal(calls[1], "/authority/command/internal");
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(body).includes("grant:mcp-entrypoint-delivery"), false);
  assert.equal(JSON.stringify(body).includes("session:mcp-entrypoint-delivery"), false);
});

test("human delivery MCP authorization is reachable without delegated Agent fields", async () => {
  const installationId = "authorization-delivery-test";
  const realm = `realm:${installationId}`;
  const kernelSessionId = "session:human-delivery";
  const hostSessionId = "host-session:human-delivery";
  const oauthKv = new MemoryKV();
  await oauthKv.put(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: realm,
    userId: "owner:delivery",
    displayName: "Delivery Owner",
    credentialId: "credential:delivery",
    kernelSessionId,
    actorId: "actor:delivery",
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-08-23T00:00:00.000Z",
  }));
  const namespace = {
    idFromName: (): string => "delivery-do",
    get: () => ({
      fetch: async (request: Request): Promise<Response> => {
        assert.equal(request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER), REALM_COORDINATOR_INTERNAL_VALUE);
        assert.equal(new URL(request.url).pathname, "/identity/session/validate");
        return new Response(JSON.stringify({ protocol: "anyam.realm-coordinator/v1", status: "session-valid", session: { id: kernelSessionId, actorId: "actor:delivery", principalId: "owner:delivery" } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
  const env = { ANYAM_INSTALLATION_ID: installationId, OAUTH_KV: oauthKv, REALM_COORDINATOR: namespace } as unknown as AnyamRealmOAuthEnv;
  const resource = `https://realm.example/mcp/projects/project:demo?sourceSpaceId=source:public`;
  const result = await (await import("../apps/realm-worker/src/passkey-owner.ts")).anyamPasskeyOwnerAuthorization({
    env,
    rawRequest: new Request("https://realm.example/authorize", { headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` } }),
    request: { responseType: "code", clientId: "client:mcp", redirectUri: "https://client.example/callback", scope: ["landing.request"], state: "state", resource },
    client: { clientId: "client:mcp", clientName: "MCP client", redirectUris: ["https://client.example/callback"], tokenEndpointAuthMethod: "none" },
  });
  assert.equal(result.status, "authorized");
  if (result.status === "authorized") {
    assert.equal(result.props?.agentId, undefined);
    assert.equal(result.props?.taskId, undefined);
    assert.match(result.authorizationReceipt, /human-delivery-grant/);
  }
});

test("Realm Worker owner delegation edge keeps task authority bounded and credential-free", async () => {
  const oauthKv = new MemoryKV();
  const hostSessionId = "host-session:agent-delegation";
  const kernelSessionId = "session:agent-delegation";
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let delegationCount = 0;
  let delegationRevoked = false;
  const namespace = {
    idFromName: (_name: string): string => "agent-delegation-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        const path = new URL(request.url).pathname;
        const body = await request.json() as Record<string, unknown>;
        calls.push({ path, body });
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        if (path === "/identity/session/validate") return new Response(JSON.stringify({ protocol: "anyam.realm-coordinator/v1", status: "session-valid", session: { id: kernelSessionId, actorId: "actor:agent-delegation", principalId: "owner:agent-delegation", clientId: "client:anyam-web", status: "active" } }), { status: 200 });
        if (path === "/identity/agent/delegation") {
          if (body.effects && Array.isArray(body.effects) && body.effects.includes("canonical.write")) return new Response(JSON.stringify({ code: "delegation.effect_denied", receipt: "effect=canonical.write; canonicalWrite=false; delegation=not-created" }), { status: 422 });
          if (body.projectId === "project:hidden") return new Response(JSON.stringify({ code: "not_found", receipt: "delegation=authority-resource-mismatch; discoverable=false" }), { status: 404 });
          delegationCount += 1;
          const status = delegationCount === 1 ? "delegated" : "already-delegated";
          return new Response(JSON.stringify({
            protocol: "anyam.realm-coordinator/v1",
            status,
            agent: { id: "agent:codex", name: "Codex", runtime: "codex-cli", modelProvider: "openai", clientId: "client:agent:agent:codex", allowedCredentialClasses: ["git", "mcp"], status: "active" },
            session: { id: "session:agent-child", actorKind: "agent", agentId: "agent:codex", expiresAt: "2026-08-12T13:00:00.000Z", status: "active" },
            task: { id: "task:agent-child", purpose: body.purpose, workspaceId: body.workspaceId, changeId: body.changeId, modelProvider: "openai", agentId: "agent:codex", createdAt: "2026-08-12T12:00:00.000Z", status: "active" },
            grant: { id: "grant:agent-child", resource: { realmId: "realm:agent-delegation", projectId: body.projectId, workspaceId: body.workspaceId, changeId: body.changeId }, sourceSpaceIds: body.sourceSpaceIds, actions: body.actions, effects: body.effects ?? [], allowedCredentialClasses: ["git", "mcp"], budget: body.budget ?? {}, expiresAt: body.expiresAt, status: "active", agentId: "agent:codex" },
            credentialClasses: ["git", "mcp"],
            credentials: "not-issued",
            credentialExchange: "explicit-later",
            canonicalWrite: false,
            credentialMaterialStored: false,
            receipt: `delegation=${status}; credentials=not-issued; canonicalWrite=false; credentialMaterialStored=false`,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/identity/agent/delegation/credentials") {
          if (delegationRevoked || body.agentSessionId === "session:expired") return new Response(JSON.stringify({ code: "credential_exchange.chain_invalid", receipt: "credentialExchange=delegated-chain-required; credentialMaterialStored=false" }), { status: 422 });
          if (body.workspaceId === "workspace:wrong") return new Response(JSON.stringify({ code: "credential_exchange.chain_invalid", receipt: "resource=exact-match-required; credentialExchange=not-created" }), { status: 422 });
          if (Array.isArray(body.credentialClasses) && body.credentialClasses.includes("promotion")) return new Response(JSON.stringify({ code: "credential_exchange.audience_denied", receipt: "credentialExchange=not-created; credentialMaterialStored=false" }), { status: 422 });
          return new Response(JSON.stringify({
            protocol: "anyam.realm-coordinator/v1",
            status: "credentials-issued",
            agentId: body.agentId,
            agentSessionId: body.agentSessionId,
            taskId: body.taskId,
            grantId: body.grantId,
            resource: { realmId: "realm:agent-delegation", projectId: body.projectId, workspaceId: body.workspaceId, changeId: body.changeId, sourceSpaceIds: body.sourceSpaceIds },
            credentialClasses: body.credentialClasses,
            credentials: [{ id: "credential:explicit-git", class: "git", audience: "aud:anyam:git", token: "opaque-git-token", expiresAt: "2026-08-12T13:00:00.000Z" }],
            identity: { credentialFree: true },
            receipt: "credentialExchange=delegated-agent; tokenMaterial=returned-explicitly; credentialMaterialStored=false; canonicalWrite=false",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/identity/agent/delegation/revoke") {
          delegationRevoked = true;
          return new Response(JSON.stringify({ protocol: "anyam.realm-coordinator/v1", status: "delegation-revoked", agentId: body.agentId, revokedSessionCount: 1, revokedGrantCount: 1, revokedCredentialCount: 0, canonicalWrite: false, credentialMaterialStored: false, receipt: "agent=agent:codex; status=revoked; humanSessionUntouched=true; credentialMaterialStored=false" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ code: "not_found" }), { status: 404 });
      },
    }),
  };
  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "agent-delegation",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-test.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:agent-delegation",
    userId: "owner:agent-delegation",
    displayName: "Agent Delegation Owner",
    credentialId: "credential:agent-delegation",
    kernelSessionId,
    actorId: "actor:agent-delegation",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
  const cookie = { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` };
  const requestBody = {
    projectId: "project:video-player",
    workspaceId: "workspace:video-player",
    changeId: "change:video-player",
    sourceSpaceIds: ["source:public"],
    purpose: "add resumable playback controls",
    agentId: "agent:codex",
    agentName: "Codex",
    runtime: "codex-cli",
    modelProvider: "openai",
    actions: ["source.read", "workspace.write", "change.publish_revision", "run.invoke"],
    effects: ["source.read", "workspace.write", "run.invoke"],
    allowedCredentialClasses: ["git", "mcp"],
    budget: { modelCostUsd: 2 },
    expiresAt: "2026-08-12T13:00:00.000Z",
  };
  const unauthenticated = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody) }), env);
  assert.ok(unauthenticated);
  assert.equal(unauthenticated.status, 401);
  const delegated = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify(requestBody) }), env);
  assert.ok(delegated);
  assert.equal(delegated.status, 200);
  const delegatedBody = await delegated.json() as Record<string, unknown>;
  assert.equal(delegatedBody.status, "delegated");
  assert.equal(delegatedBody.credentials, "not-issued");
  assert.equal(delegatedBody.canonicalWrite, false);
  assert.equal(JSON.stringify(delegatedBody).includes("token"), false);
  assert.deepEqual(calls.at(-1), { path: "/identity/agent/delegation", body: { ...requestBody, humanSessionId: kernelSessionId } });

  const repeated = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify(requestBody) }), env);
  assert.ok(repeated);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json() as Record<string, unknown>).status, "already-delegated");

  const exchangeBody = { agentId: "agent:codex", agentSessionId: "session:agent-child", taskId: "task:agent-child", grantId: "grant:agent-child", projectId: requestBody.projectId, workspaceId: requestBody.workspaceId, changeId: requestBody.changeId, sourceSpaceIds: requestBody.sourceSpaceIds, credentialClasses: ["git"] };
  const exchange = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/credentials", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify(exchangeBody) }), env);
  assert.ok(exchange);
  assert.equal(exchange.status, 200);
  const exchangeBodyResult = await exchange.json() as Record<string, unknown>;
  assert.equal(exchangeBodyResult.status, "credentials-issued");
  assert.equal((exchangeBodyResult.credentials as Array<Record<string, unknown>>)[0]?.token, "opaque-git-token");
  assert.equal((exchangeBodyResult.identity as Record<string, unknown>).credentialFree, true);
  assert.equal(String(exchangeBodyResult.receipt).includes("tokenMaterial=returned-explicitly"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(calls.at(-1)?.body ?? {}, "token"), false);

  const wrongResource = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/credentials", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ ...exchangeBody, workspaceId: "workspace:wrong" }) }), env);
  assert.ok(wrongResource);
  assert.equal(wrongResource.status, 422);
  assert.equal((await wrongResource.json() as Record<string, unknown>).code, "credential_exchange_rejected");

  const deniedAudience = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/credentials", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ ...exchangeBody, credentialClasses: ["promotion"] }) }), env);
  assert.ok(deniedAudience);
  assert.equal(deniedAudience.status, 422);
  assert.equal((await deniedAudience.json() as Record<string, unknown>).code, "credential_exchange_rejected");

  const expired = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/credentials", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ ...exchangeBody, agentSessionId: "session:expired" }) }), env);
  assert.ok(expired);
  assert.equal(expired.status, 422);
  assert.equal((await expired.json() as Record<string, unknown>).code, "credential_exchange_rejected");

  const providerMaterial = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/credentials", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ ...exchangeBody, providerToken: "must-not-forward" }) }), env);
  assert.ok(providerMaterial);
  assert.equal(providerMaterial.status, 422);
  assert.equal((await providerMaterial.json() as Record<string, unknown>).code, "credential_exchange_material_rejected");

  const hidden = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ ...requestBody, projectId: "project:hidden" }) }), env);
  assert.ok(hidden);
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json() as Record<string, unknown>).code, "delegation_resource_not_found");

  const denied = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ ...requestBody, effects: ["canonical.write"] }) }), env);
  assert.ok(denied);
  assert.equal(denied.status, 422);
  assert.equal((await denied.json() as Record<string, unknown>).code, "delegation_rejected");

  const revoked = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/revoke", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify({ agentId: "agent:codex" }) }), env);
  assert.ok(revoked);
  assert.equal(revoked.status, 200);
  const revokedBody = await revoked.json() as Record<string, unknown>;
  assert.equal(revokedBody.status, "delegation-revoked");
  assert.equal(revokedBody.canonicalWrite, false);
  assert.match(String(revokedBody.receipt), /humanSessionUntouched=true/);

  const afterRevoke = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/agent/delegations/credentials", { method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: JSON.stringify(exchangeBody) }), env);
  assert.ok(afterRevoke);
  assert.equal(afterRevoke.status, 422);
  assert.equal((await afterRevoke.json() as Record<string, unknown>).code, "credential_exchange_rejected");
});

test("owner session download is owner-authenticated, same-origin, and attachment-only", async () => {
  const oauthKv = new MemoryKV();
  const hostSessionId = "host-session:download";
  const kernelSessionId = "session:download";
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:download",
    userId: "owner:download",
    displayName: "Download Owner",
    credentialId: "credential:download",
    kernelSessionId,
    actorId: "actor:download",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));
  const namespace = {
    idFromName: (_name: string): string => "download-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        const body = await request.json() as { sessionId?: string };
        if (new URL(request.url).pathname !== "/identity/session/validate" || body.sessionId !== kernelSessionId) return new Response(JSON.stringify({ code: "session.invalid" }), { status: 403 });
        return new Response(JSON.stringify({ session: { id: kernelSessionId, actorId: "actor:download", principalId: "owner:download", expiresAt: new Date(Date.now() + 60_000).toISOString() } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };
  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "download",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-download.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;
  const cookie = `anyam_owner_session=${encodeURIComponent(hostSessionId)}`;
  const exported = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/session/export", { method: "POST", headers: { cookie, origin: "https://realm.example", "sec-fetch-site": "same-origin" } }), env);
  assert.ok(exported);
  assert.equal(exported.status, 410);
  assert.equal((await exported.json() as Record<string, unknown>).code, "owner_session_export_removed");
  const crossOrigin = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/session/export", { method: "POST", headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" } }), env);
  assert.ok(crossOrigin);
  assert.equal(crossOrigin.status, 410);
  const unauthenticated = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/api/owner/session/export", { method: "POST", headers: { origin: "https://realm.example", "sec-fetch-site": "same-origin" } }), env);
  assert.ok(unauthenticated);
  assert.equal(unauthenticated.status, 410);
  const loginPage = await handleAnyamRealmOwnerRequest(new Request("https://realm.example/owner/login"), env);
  assert.ok(loginPage);
  const page = await loginPage.text();
  assert.doesNotMatch(page, /Download owner-session\.txt/u);
  assert.match(loginPage.headers.get("content-security-policy") ?? "", /form-action 'self'/u);
});
