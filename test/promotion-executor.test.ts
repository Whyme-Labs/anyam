import assert from "node:assert/strict";
import test from "node:test";

import { createPromotionExecutorHandler } from "../src/cloudflare/promotion-executor.ts";
import { createPromotionExecutionContext } from "../src/cloudflare/promotion-execution.ts";
import { CONTRACT_VERSIONS, type Artifact, type Release } from "../src/kernel/contracts.ts";
import { emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { createHash } from "node:crypto";

const session = {
  realmId: "realm:promotion-executor-test",
  principalId: "principal:owner",
  actorId: "actor:owner",
  sessionId: "session:owner",
  clientId: "client:anyam-web",
  authorizationEpoch: 1,
};

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture(): { context: ReturnType<typeof createPromotionExecutionContext>; artifactBytes: Uint8Array } {
  const snapshot = emptyAuthorityPlaneSnapshot(session.realmId);
  snapshot.version = 3;
  snapshot.projects["project:executor"] = { protocol: CONTRACT_VERSIONS.project, id: "project:executor", name: "Executor", referenceType: "git", sourceSpaceIds: ["source:executor"] };
  snapshot.sourceSpaces["source:executor"] = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:executor", name: "public", classification: "public" };
  snapshot.projectRevisions["project-revision:executor"] = { protocol: CONTRACT_VERSIONS.kernel, id: "project-revision:executor", projectId: "project:executor", sourceSpaceSnapshots: { "source:executor": "git:executor" } };
  snapshot.canonicalByProject["project:executor"] = "project-revision:executor";
  const artifactBytes = new TextEncoder().encode("export default { fetch() { return new Response(JSON.stringify({ status: 'healthy', releaseId: 'release:executor' }), { headers: { 'content-type': 'application/json' } }); } };\n");
  const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:executor", type: "worker.bundle", digest: sha256(artifactBytes), projectRevisionId: "project-revision:executor", outputPath: "worker.js" };
  snapshot.artifacts[artifact.id] = artifact;
  snapshot.evidence = {};
  const release: Release = { protocol: CONTRACT_VERSIONS.release, id: "release:executor", projectRevisionId: "project-revision:executor", artifactIds: [artifact.id], evidenceIds: [], configurationDigests: ["sha256:configuration"], stateAssumptions: ["executor test"], policyVersion: "policy:executor", status: "ready" };
  snapshot.releases[release.id] = release;
  snapshot.targets["target:executor"] = { protocol: CONTRACT_VERSIONS.target, id: "target:executor", projectId: "project:executor", name: "Worker target", adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle"], requiredEvidenceKeys: [], state: "configured", currentReleaseId: null, releaseHistory: [] };
  snapshot.promotions["promotion:executor"] = { protocol: CONTRACT_VERSIONS.promotion, id: "promotion:executor", projectId: "project:executor", targetId: "target:executor", releaseId: release.id, releaseDigest: "declared:release:executor", previousReleaseId: null, expectedCurrentReleaseId: null, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: "request:executor", actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId }, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", receipt: "promotion=blocked" };
  return { context: createPromotionExecutionContext({ snapshot, promotionId: "promotion:executor", executionIdempotencyKey: "execute:executor:1", session }), artifactBytes };
}

function fakeFetch(releaseId: string): typeof fetch {
  const versions: Array<{ id: string; tag: string }> = [];
  let versionNumber = 0;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/versions") && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ result: { items: versions.map((version) => ({ id: version.id, metadata: { annotations: { "workers/tag": version.tag } } })) }, errors: [], messages: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/versions") && init?.method === "POST") {
        const form = init.body as FormData;
        const metadata = JSON.parse(String(form.get("metadata"))) as { annotations: { "workers/tag": string } };
        const version = { id: `version-executor-${++versionNumber}`, tag: metadata.annotations["workers/tag"] };
        versions.push(version);
        return new Response(JSON.stringify({ result: { id: version.id }, errors: [], messages: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/deployments") && init?.method === "POST") {
        return new Response(JSON.stringify({ result: { id: `deployment-executor-${++versionNumber}`, versions: [] }, errors: [], messages: [] }), { status: 200 });
      }
    }
    if (url.pathname.endsWith("/health") || url.searchParams.get("anyam_preview") === "1") {
      return new Response(JSON.stringify({ status: "healthy", releaseId }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };
}

function handlerFor(context: ReturnType<typeof createPromotionExecutionContext>, artifactBytes: Uint8Array) {
  return createPromotionExecutorHandler({
    accountId: "account:executor",
    scriptName: "worker-executor",
    targetId: "target:executor",
    previewSubdomain: "customer",
    providerToken: "provider-token-kept-in-executor",
    providerCredentialExpiresAt: "2099-01-01T00:00:00.000Z",
    fetch: fakeFetch(context.release.id),
    artifactStore: {
      async get(key) {
        return key === `artifacts/${context.artifacts[0]?.digest}` ? { arrayBuffer: async () => new Uint8Array(artifactBytes).buffer as ArrayBuffer } : null;
      },
    },
  });
}

test("customer-operated executor runs the qualified Worker Target and returns a credential-free result", async () => {
  const { context, artifactBytes } = fixture();
  const response = await handlerFor(context, artifactBytes)(new Request("https://executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1" }, body: JSON.stringify(context) }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const result = JSON.parse(body) as Record<string, unknown>;
  assert.equal(result.status, "succeeded");
  assert.equal((result.target as Record<string, unknown>).currentReleaseId, "release:executor");
  assert.equal(JSON.stringify(result).includes("provider-token"), false);
  assert.equal(JSON.stringify(result).includes("credentialMaterialStored=false"), true);
});

test("customer-operated executor rejects caller-supplied provider credentials before provider invocation", async () => {
  const { context, artifactBytes } = fixture();
  const requestContext = { ...context, providerToken: "cfat_attacker" };
  const response = await handlerFor(context, artifactBytes)(new Request("https://executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1" }, body: JSON.stringify(requestContext) }));
  assert.equal(response.status, 422);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.status, "blocked");
  assert.match(String(result.receipt), /providerInvocation=false/);
  assert.equal(JSON.stringify(result).includes("cfat_attacker"), false);
});

test("customer-operated executor rejects a Target routed to the wrong adapter", async () => {
  const { context, artifactBytes } = fixture();
  const wrongTarget = { ...context.target, adapterId: "other.provider" };
  const wrongContext = { ...context, target: wrongTarget };
  const response = await handlerFor(context, artifactBytes)(new Request("https://executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1" }, body: JSON.stringify(wrongContext) }));
  assert.equal(response.status, 422);
  const result = await response.json() as Record<string, unknown>;
  assert.match(String(result.recoveryAction), /Target|adapter/i);
  assert.match(String(result.receipt), /providerInvocation=false/);
});
