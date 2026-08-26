import assert from "node:assert/strict";
import test from "node:test";

import { handleAuthorityRequest } from "../apps/realm-worker/src/authority-edge.ts";
import type { AnyamRealmOAuthEnv } from "../apps/realm-worker/src/oauth-provider.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

class MemoryKV {
  readonly values = new Map<string, string>();

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === "json" ? JSON.parse(value) as unknown : value;
  }
}

test("owner Promotion execution forwards only the typed handoff identity to the internal executor boundary", async () => {
  const oauthKv = new MemoryKV();
  const hostSessionId = "host-session:promotion-execution-edge";
  const kernelSessionId = "session:promotion-execution-edge";
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:promotion-execution-edge",
    userId: "owner:promotion-execution-edge",
    displayName: "Promotion Execution Edge Owner",
    credentialId: "credential:promotion-execution-edge",
    kernelSessionId,
    actorId: "actor:promotion-execution-edge",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));

  let forwardedPath: string | undefined;
  let forwarded: Record<string, unknown> | undefined;
  const namespace = {
    idFromName: (_name: string): string => "promotion-execution-edge-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        forwardedPath = new URL(request.url).pathname;
        assert.equal(request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER), REALM_COORDINATOR_INTERNAL_VALUE);
        forwarded = await request.json() as Record<string, unknown>;
        return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          status: "blocked",
          code: "provider_executor_not_bound",
          message: "No trusted Promotion executor service is bound.",
          recoveryAction: "bind the qualified Target execution service",
          receipt: "providerExecutor=not-bound; credentialFree=true; canonicalWrite=false",
        }), { status: 503, headers: { "content-type": "application/json" } });
      },
    }),
  };

  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "promotion-execution-edge",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-edge.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;

  const response = await handleAuthorityRequest(new Request("https://realm.example/api/promotions/promotion%3Aedge/execute", {
    method: "POST",
    headers: {
      cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`,
      "content-type": "application/json",
      "idempotency-key": "execute:edge:1",
    },
    body: JSON.stringify({ expectedVersion: 7 }),
  }), env);

  assert.ok(response);
  assert.equal(response.status, 503);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "authority_coordinator_rejected");
  assert.match(String(value.receipt), /operation=promotion\.execute/);
  assert.match(String(value.receipt), /providerExecution=trusted-handoff/);
  assert.equal(forwardedPath, "/authority/promotion/execute/internal");
  assert.deepEqual(forwarded, {
    sessionId: kernelSessionId,
    promotionId: "promotion:edge",
    executionIdempotencyKey: "execute:edge:1",
    expectedVersion: 7,
  });
  assert.equal(JSON.stringify(forwarded).includes("provider"), false);
  assert.equal(JSON.stringify(value).includes("credential"), true);
});

test("owner Mirror configuration preserves the coordinator receipt when the Durable Object rejects the command", async () => {
  const oauthKv = new MemoryKV();
  const hostSessionId = "host-session:mirror-detail";
  const kernelSessionId = "session:mirror-detail";
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:mirror-detail",
    userId: "owner:mirror-detail",
    displayName: "Mirror Detail Owner",
    credentialId: "credential:mirror-detail",
    kernelSessionId,
    actorId: "actor:mirror-detail",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));

  const namespace = {
    idFromName: (_name: string): string => "mirror-detail-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        assert.equal(new URL(request.url).pathname, "/authority/command/internal");
        assert.equal(request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER), REALM_COORDINATOR_INTERNAL_VALUE);
        const body = await request.json() as Record<string, unknown>;
        const payload = body.payload as Record<string, unknown> | undefined;
        if (payload?.operationId === "operation:blocked") {
          return new Response(JSON.stringify({
            protocol: "anyam.authority-plane/v1",
            status: "blocked",
            recoveryAction: "choose canonical-wins after inspecting the explicit remote rewrite",
            receipt: "mirror=mirror:detail; operation=force-push; state=blocked; credentialFree=true",
            value: { mirror: { id: "mirror:detail", state: "blocked" } },
          }), { status: 409, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          code: "conflict",
          message: "Repository Mirror mirror:detail already exists.",
          recoveryAction: "reuse the original idempotency key or choose a new Mirror identity",
          receipt: "mirror=mirror:detail; exists=true; transition=not-applied; credentialFree=true",
        }), { status: 409, headers: { "content-type": "application/json" } });
      },
    }),
  };

  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "mirror-detail",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-edge.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;

  const response = await handleAuthorityRequest(new Request("https://realm.example/api/mirrors", {
    method: "POST",
    headers: {
      cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`,
      "content-type": "application/json",
      "idempotency-key": "mirror:detail:configure",
    },
    body: JSON.stringify({
      mirrorId: "mirror:detail",
      projectId: "project:detail",
      sourceSpaceId: "source:detail",
      provider: "github",
      remoteRepository: "Whyme-Labs/detail",
      refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
      disclosure: "public",
      canonicalProjectRevisionId: "project-revision:detail",
      canonicalRefs: [],
      remoteGeneration: "qualification:empty",
      remoteRefs: [],
      pendingInboundChangeIds: [],
      receipt: "qualification=mirror-detail; credentialMaterialStored=false",
    }),
  }), env);

  if (!response) throw new Error("mirror authority edge did not return a response");
  assert.equal(response.status, 409);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.code, "mirror_conflict");
  assert.match(String(value.receipt), /coordinatorDetail=/);
  assert.match(decodeURIComponent(String(value.receipt)), /Repository Mirror mirror:detail already exists/);
  assert.match(decodeURIComponent(String(value.receipt)), /transition=not-applied/);
  assert.equal(JSON.stringify(value).includes("credentialMaterial"), false);

  const blockedResponse = await handleAuthorityRequest(new Request("https://realm.example/api/mirrors/mirror%3Adetail/sync", {
    method: "POST",
    headers: {
      cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}`,
      "content-type": "application/json",
      "idempotency-key": "mirror:detail:blocked",
    },
    body: JSON.stringify({
      mirrorId: "mirror:detail",
      projectId: "project:detail",
      sourceSpaceId: "source:detail",
      provider: "github",
      remoteRepository: "Whyme-Labs/detail",
      refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
      disclosure: "public",
      canonicalProjectRevisionId: "project-revision:detail",
      canonicalRefs: [],
      expectedRemoteGeneration: "qualification:force-push",
      remoteGeneration: "qualification:force-push",
      remoteRefs: [],
      operationId: "operation:blocked",
      checkpointId: "checkpoint:blocked",
      operationState: "failed",
      mirrorState: "divergent",
      pendingInboundChangeIds: [],
      receipt: "qualification=mirror-detail; operation=force-push; credentialMaterialStored=false",
    }),
  }), env);

  if (!blockedResponse) throw new Error("mirror authority edge did not return the blocked response");
  assert.equal(blockedResponse.status, 410);
  const blockedValue = await blockedResponse.json() as Record<string, unknown>;
  assert.equal(blockedValue.status, "blocked");
  assert.equal(blockedValue.code, "mirror_ingestion_internal_only");
  assert.match(String(blockedValue.receipt), /providerObservation=required/);
});

test("owner Promotion status is a read-only credential-free surface", async () => {
  const oauthKv = new MemoryKV();
  const hostSessionId = "host-session:promotion-status-edge";
  const kernelSessionId = "session:promotion-status-edge";
  oauthKv.values.set(`anyam:passkey:session:${hostSessionId}`, JSON.stringify({
    protocol: "anyam.passkey-owner/v1",
    sessionId: hostSessionId,
    realmId: "realm:promotion-status-edge",
    userId: "owner:promotion-status-edge",
    displayName: "Promotion Status Edge Owner",
    credentialId: "credential:promotion-status-edge",
    kernelSessionId,
    actorId: "actor:promotion-status-edge",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }));

  let forwardedPath: string | undefined;
  let forwarded: Record<string, unknown> | undefined;
  const namespace = {
    idFromName: (_name: string): string => "promotion-status-edge-do",
    get: (_id: string) => ({
      fetch: async (request: Request): Promise<Response> => {
        forwardedPath = new URL(request.url).pathname;
        assert.equal(request.headers.get(REALM_COORDINATOR_INTERNAL_HEADER), REALM_COORDINATOR_INTERNAL_VALUE);
        forwarded = await request.json() as Record<string, unknown>;
        return new Response(JSON.stringify({
          protocol: "anyam.authority-plane/v1",
          status: "ready",
          version: 4,
          promotion: {
            protocol: "anyam.promotion/v1",
            id: "promotion:edge",
            projectId: "project:edge",
            targetId: "target:edge",
            releaseId: "release:edge",
            releaseDigest: "sha256:release",
            previousReleaseId: null,
            expectedCurrentReleaseId: null,
            state: "degraded",
            attempt: 1,
            kind: "promotion",
            executionIdempotencyKey: "execute:edge:1",
            recoveryAction: "reconcile the provider operation",
            reconciliationCheckpoint: { idempotencyKey: "execute:edge:1", attempt: 1, stage: "reconcile", providerOperationIds: [], executionDigest: "sha256:execution", releaseId: "release:edge", targetId: "target:edge", status: "indeterminate", updatedAt: new Date().toISOString(), receipt: "checkpoint=durable" },
          },
          target: { protocol: "anyam.target/v1", id: "target:edge", projectId: "project:edge", name: "Edge Target", adapterId: "cloudflare.worker", state: "degraded", currentReleaseId: null, releaseHistory: [] },
          release: { protocol: "anyam.release/v1", id: "release:edge", projectRevisionId: "project-revision:edge", status: "ready" },
          checkpoint: { idempotencyKey: "execute:edge:1", attempt: 1, stage: "reconcile", providerOperationIds: [], executionDigest: "sha256:execution", releaseId: "release:edge", targetId: "target:edge", status: "indeterminate", updatedAt: new Date().toISOString(), receipt: "checkpoint=durable" },
          receipt: "operation=promotion.status; readOnly=true; credentialFree=true; canonicalWrite=false",
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  };

  const env = {
    ANYAM_HOSTING_MODE: "customer-operated",
    ANYAM_INSTALLATION_ID: "promotion-status-edge",
    ANYAM_PROTOCOL_VERSION: "anyam.customer-realm-worker/v1",
    ANYAM_REALM_RP_ID: "realm-edge.example",
    REALM_COORDINATOR: namespace,
    OAUTH_KV: oauthKv,
    ANYAM_METADATA_DB: {},
    ANYAM_EXPORTS: {},
    ANYAM_EVENTS: {},
    ANYAM_WORKFLOW: {},
  } as unknown as AnyamRealmOAuthEnv;

  const response = await handleAuthorityRequest(new Request("https://realm.example/api/promotions/promotion%3Aedge", {
    method: "GET",
    headers: { cookie: `anyam_owner_session=${encodeURIComponent(hostSessionId)}` },
  }), env);
  assert.ok(response);
  assert.equal(response.status, 200);
  const value = await response.json() as Record<string, unknown>;
  assert.equal(value.status, "ready");
  assert.equal(value.credentialFree, true);
  assert.equal(value.canonicalWrite, false);
  assert.equal((value.promotion as Record<string, unknown>).state, "degraded");
  assert.equal(((value.target as Record<string, unknown>).currentReleaseId), null);
  assert.equal(forwardedPath, "/authority/promotion/status/internal");
  assert.deepEqual(forwarded, { sessionId: kernelSessionId, promotionId: "promotion:edge" });
  assert.equal(JSON.stringify(value).includes("provider-token"), false);
});
