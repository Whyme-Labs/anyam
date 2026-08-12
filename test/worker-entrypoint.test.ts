import assert from "node:assert/strict";
import test from "node:test";

import providerTarget from "../apps/provider-qualification-target/src/index.ts";
import replayArchiveWorker, { type Env as ReplayArchiveEnv } from "../apps/replay-archive-workload-qualification/src/index.ts";
import { handleAuthorityRequest } from "../apps/realm-worker/src/authority-edge.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, authorityStateSummary, emptyAuthorityPlaneSnapshot, type AuthorityCommand } from "../src/cloudflare/authority-plane.ts";
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
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot("realm:authority-test"));
  const namespace = {
    idFromName: (_name: string): string => "authority-test-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        if (request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER) !== REALM_COORDINATOR_INTERNAL_VALUE) return new Response(JSON.stringify({ code: "internal_binding_required" }), { status: 403 });
        const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
        if (body.sessionId !== ownerSessionId) return new Response(JSON.stringify({ code: "session.invalid" }), { status: 403 });
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
        const command = { ...body, protocol: body.protocol, command: body.command, idempotencyKey: body.idempotencyKey, payload: body.payload } as unknown as AuthorityCommand;
        const result = authority.execute(command, { realmId: "realm:authority-test", principalId: "owner:authority-test", actorId: "actor:authority-test", sessionId: ownerSessionId, clientId: "client:anyam-web", authorizationEpoch: 1 });
        return new Response(JSON.stringify(result), { status: result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503, headers: { "content-type": "application/json" } });
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
  const state = async (): Promise<Record<string, unknown>> => {
    const response = await handleAuthorityRequest(new Request("https://realm.example/api/authority/state", { headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` } }), env);
    assert.ok(response);
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  };

  const projectResult = await command("project.create", "idem:project", { projectId: "project:authority-test", name: "Authority Test", referenceType: "git", sourceSpaces: [{ id: "source:authority-test", name: "public", classification: "public", snapshotId: "git:base" }] });
  const project = (projectResult.value as Record<string, unknown>).project as { id: string };
  const canonicalBefore = ((projectResult.value as Record<string, unknown>).canonicalRevision as { id: string }).id;
  const workspaceResult = await command("workspace.create", "idem:workspace", { projectId: project.id, projectRevisionId: canonicalBefore, sourceSpaceIds: ["source:authority-test"], mounts: ["source"] });
  const workspace = (workspaceResult.value as Record<string, unknown>).workspace as { id: string; projectViewId: string };
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
  const changeResult = await command("change.create", "idem:change", { projectId: project.id, intentId: "intent:authority-test", baseProjectRevisionId: canonicalBefore, workspaceId: workspace.id });
  const change = (changeResult.value as Record<string, unknown>).change as { id: string };
  const revisionResult = await command("revision.publish", "idem:revision", { changeId: change.id, workspaceId: workspace.id, projectViewId: workspace.projectViewId, projectRevisionId: "candidate:authority-test", sourceSpaceSnapshots: { "source:authority-test": "git:candidate" }, declaredEffects: ["source.modify"] });
  const revision = (revisionResult.value as Record<string, unknown>).revision as { id: string };
  const beforeLanding = await state();
  assert.equal(((beforeLanding.authority as Record<string, unknown>).canonicalByProject as Record<string, string>)[project.id], canonicalBefore);
  const runResult = await command("run.record", "idem:run", { runId: "run:authority-test", actionId: "action:unit", projectRevisionId: "candidate:authority-test", projectViewId: workspace.projectViewId, runnerId: "runner:binding-shaped", status: "succeeded", outputDigest: "sha256:run" });
  assert.equal(runResult.status, "succeeded");
  const evidenceResult = await command("evidence.record", "idem:evidence", { evidenceId: "evidence:authority-test", runId: "run:authority-test", key: "unit", criterion: "unit tests pass", validityKey: "valid:unit", actionId: "action:unit", verifierId: "verifier:unit", toolchainDigest: "sha256:toolchain", dependencyDigest: "sha256:deps", environmentDigest: "sha256:env", inputDigests: [], effectDigests: [], outputDigest: "sha256:run", policyVersion: "policy:authority-test", capabilityGrantId: "grant:authority-test", disclosure: { projectionId: "projection:authority-test", classification: "project" }, receipt: "verifier=fixture; passed=true", invalidators: [], owner: "owner:authority-test" });
  assert.equal(evidenceResult.status, "succeeded");
  const artifactResult = await command("artifact.record", "idem:artifact", { artifactId: "artifact:authority-test", type: "cli.archive", digest: "sha256:artifact", projectRevisionId: "candidate:authority-test", runId: "run:authority-test" });
  assert.equal(artifactResult.status, "succeeded");
  const landingResult = await command("landing.apply", "idem:landing", { changeRevisionId: revision.id, projectRevisionId: "candidate:authority-test", expectedCanonicalProjectRevisionId: canonicalBefore });
  assert.equal(landingResult.status, "succeeded");
  const landedRevision = ((landingResult.value as Record<string, unknown>).canonicalRevision as { id: string }).id;
  assert.notEqual(landedRevision, canonicalBefore);
  const releaseResult = await command("release.create", "idem:release", { releaseId: "release:authority-test", projectRevisionId: landedRevision, artifactIds: ["artifact:authority-test"], evidenceIds: ["evidence:authority-test"], policyVersion: "policy:authority-test", configurationDigests: [], stateAssumptions: [] });
  assert.equal(releaseResult.status, "succeeded");
  const targetResult = await command("target.configure", "idem:target", { targetId: "target:authority-test", projectId: project.id, name: "test target", adapterId: "target:unqualified", acceptedArtifactTypes: ["cli.archive"], requiredEvidenceKeys: [] });
  assert.equal(targetResult.status, "succeeded");
  const promotionResult = await command("promotion.request", "idem:promotion", { releaseId: "release:authority-test", targetId: "target:authority-test" });
  assert.equal(promotionResult.status, "blocked");
  assert.match(String(promotionResult.receipt), /canonicalWrite=false/);
  const repeatedProject = await command("project.create", "idem:project", { projectId: "project:authority-test", name: "Authority Test", referenceType: "git", sourceSpaces: [{ id: "source:authority-test", name: "public", classification: "public", snapshotId: "git:base" }] });
  assert.equal(((repeatedProject.value as Record<string, unknown>).project as { id: string }).id, project.id);
  const finalState = await state();
  assert.equal(((finalState.authority as Record<string, unknown>).canonicalByProject as Record<string, string>)[project.id], landedRevision);
  assert.equal(((finalState.authority as Record<string, unknown>).counts as Record<string, number>).audit, 11);
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

  const listUnsupported = await handleAuthorityRequest(new Request("https://realm.example/api/projects", { method: "POST", headers: cookie }), env);
  assert.ok(listUnsupported);
  assert.equal(listUnsupported.status, 405);
  assert.equal((await listUnsupported.json() as Record<string, unknown>).code, "method_not_allowed");
});
