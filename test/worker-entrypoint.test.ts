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
