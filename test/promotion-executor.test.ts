import assert from "node:assert/strict";
import test from "node:test";

import { createPromotionExecutorHandler } from "../src/cloudflare/promotion-executor.ts";
import { createPromotionExecutionContext, PROMOTION_HANDOFF_TTL_MS, signPromotionHandoff } from "../src/cloudflare/promotion-execution.ts";
import { CONTRACT_VERSIONS, type Artifact, type Release } from "../src/kernel/contracts.ts";
import { createTargetDeploymentProfile } from "../src/delivery/target-deployment.ts";
import { emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { createHash } from "node:crypto";
import { createCloudflareWorkerReleaseManifest } from "../src/cloudflare/worker-release-manifest.ts";

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
  snapshot.evidence["evidence:executor"] = { protocol: CONTRACT_VERSIONS.evidence, version: "v1", id: "evidence:executor", key: "worker-build", criterion: "worker build", outcome: "passed", validityKey: "sha256:executor-validity", actionId: "action:worker-build", verifierId: "verifier:worker-build", toolchainDigest: "sha256:toolchain", dependencyDigest: "sha256:dependencies", environmentDigest: "sha256:environment", inputDigests: ["src/index.ts=sha256:source"], effectDigests: [], outputDigest: artifact.digest, createdAt: "2026-08-12T00:00:00.000Z", producer: { kind: "run", id: "run:executor", version: "v1" }, projectRevisionId: "project-revision:executor", projectViewId: "project-view:executor", runId: "run:executor", actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId }, runnerId: "runner:executor", policyVersion: "policy:executor", authorizationEpoch: "1", capabilityGrantId: "grant:executor", disclosure: { projectionId: "project-view:executor", classification: "project" }, receipt: "evidence=passed; credentialMaterialStored=false", invalidators: [], owner: "promotion-executor-test" };
  const release: Release = { protocol: CONTRACT_VERSIONS.release, id: "release:executor", projectRevisionId: "project-revision:executor", artifactIds: [artifact.id], evidenceIds: ["evidence:executor"], configurationDigests: ["sha256:configuration"], stateAssumptions: ["executor test"], policyVersion: "policy:executor", status: "ready" };
  snapshot.releases[release.id] = release;
  snapshot.targets["target:executor"] = { protocol: CONTRACT_VERSIONS.target, id: "target:executor", projectId: "project:executor", name: "Worker target", adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle"], requiredEvidenceKeys: [], state: "configured", deploymentProfile: createTargetDeploymentProfile({ environment: "staging", channel: "beta", audience: "executor", runtimeIdentity: "worker:executor", routeIdentities: ["route:executor"], bindingIdentities: [], dataResourceIdentities: [], configurationDigests: ["sha256:executor-config"], secretUseAliases: [], dataClass: "isolated", resourceSharing: "isolated" }), currentReleaseId: null, releaseHistory: [] };
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
        const metadataPart = form.get("metadata");
        const metadataText = metadataPart instanceof Blob ? await metadataPart.text() : String(metadataPart);
        const metadata = JSON.parse(metadataText) as { main_module?: string; annotations: { "workers/tag": string; "workers/message": string }; compatibility_date?: string; compatibility_flags?: readonly string[]; bindings?: readonly Readonly<Record<string, unknown>>[] };
        const version = {
          id: `version-executor-${++versionNumber}`,
          tag: metadata.annotations["workers/tag"],
          metadata: { annotations: metadata.annotations },
          resources: { bindings: metadata.bindings ?? [], script: { main_module: metadata.main_module ?? "worker.js", modules: [{ name: metadata.main_module ?? "worker.js" }] }, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [] } },
        };
        versions.push(version);
        return new Response(JSON.stringify({ result: { id: version.id }, errors: [], messages: [] }), { status: 200 });
      }
      if (url.pathname.includes("/versions/") && (init?.method ?? "GET") === "GET") {
        const versionId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const version = versions.find((candidate) => candidate.id === versionId);
        return new Response(JSON.stringify({ result: version, errors: [], messages: [] }), { status: version ? 200 : 404 });
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
  const claimed = new Set<string>();
  return createPromotionExecutorHandler({
    accountId: "account:executor",
    scriptName: "worker-executor",
    targetId: "target:executor",
    previewSubdomain: "customer",
    credentialBroker: {
      async probe() {
        return { credentialId: "credential:fixture", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credentialBroker=fixture; providerAuthorization=observed; credentialMaterialStored=false" };
      },
      async issue(input) {
        return { token: "provider-token-kept-in-executor", credentialId: `credential:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: `credentialBroker=fixture; operation=${input.operation}; providerAuthorization=observed; credentialMaterialStored=false` };
      },
    },
    handoffKeys: { active: { id: "handoff-key-v1", secret: "promotion-executor-test-handoff-secret" }, previous: { id: "handoff-key-v0", secret: "promotion-executor-test-previous-secret" } },
    handoffNonceStore: { async claim(input) { if (claimed.has(input.nonce)) return false; claimed.add(input.nonce); return true; } },
    fetch: fakeFetch(context.release.id),
    artifactStore: {
      async get(key) {
        return key === `artifacts/${context.artifacts[0]?.digest}` ? { arrayBuffer: async () => new Uint8Array(artifactBytes).buffer as ArrayBuffer } : null;
      },
    },
    workerReleaseManifest: ({ release }) => createCloudflareWorkerReleaseManifest({ release, compatibilityDate: "2026-01-01", bindings: [], healthPaths: ["/health"] }),
  });
}

async function signedRequest(context: ReturnType<typeof createPromotionExecutionContext>, body: unknown = context): Promise<Request> {
  const nonce = `nonce:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + PROMOTION_HANDOFF_TTL_MS).toISOString();
  const keyId = "handoff-key-v1";
  const signature = await signPromotionHandoff({ context, nonce, expiresAt, secret: "promotion-executor-test-handoff-secret", keyId });
  return new Request("https://executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1", "x-anyam-promotion-handoff": signature, "x-anyam-promotion-key-id": keyId, "x-anyam-promotion-nonce": nonce, "x-anyam-promotion-expires-at": expiresAt }, body: JSON.stringify(body) });
}

async function signedRequestWithKey(context: ReturnType<typeof createPromotionExecutionContext>, keyId: string, secret: string): Promise<Request> {
  const nonce = `nonce:${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + PROMOTION_HANDOFF_TTL_MS).toISOString();
  const signature = await signPromotionHandoff({ context, nonce, expiresAt, secret, keyId });
  return new Request("https://executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1", "x-anyam-promotion-handoff": signature, "x-anyam-promotion-key-id": keyId, "x-anyam-promotion-nonce": nonce, "x-anyam-promotion-expires-at": expiresAt }, body: JSON.stringify(context) });
}

test("customer-operated executor runs the qualified Worker Target and returns a credential-free result", async () => {
  const { context, artifactBytes } = fixture();
  const response = await handlerFor(context, artifactBytes)(await signedRequest(context));
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
  const response = await handlerFor(context, artifactBytes)(await signedRequest(context, requestContext));
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
  const response = await handlerFor(context, artifactBytes)(await signedRequest(wrongContext));
  assert.equal(response.status, 422);
  const result = await response.json() as Record<string, unknown>;
  assert.match(String(result.recoveryAction), /Target|adapter/i);
  assert.match(String(result.receipt), /providerInvocation=false/);
});

test("customer-operated executor rejects missing, altered, and replayed handoffs before provider invocation", async () => {
  const { context, artifactBytes } = fixture();
  const handler = handlerFor(context, artifactBytes);
  const missing = await handler(new Request("https://executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1" }, body: JSON.stringify(context) }));
  assert.equal(missing.status, 401);
  const valid = await signedRequest(context);
  const validBody = await valid.text();
  const first = await handler(new Request(valid.url, { method: "POST", headers: valid.headers, body: validBody }));
  assert.equal(first.status, 200);
  const replay = await handler(new Request(valid.url, { method: "POST", headers: valid.headers, body: validBody }));
  assert.equal(replay.status, 409);
  const signed = await signedRequest(context);
  const alteredResponse = await handler(new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify({ ...context, executionDigest: `sha256:${"0".repeat(64)}` }) }));
  assert.equal(alteredResponse.status, 401);
});

test("customer-operated executor accepts the previous handoff key only during rotation overlap", async () => {
  const { context, artifactBytes } = fixture();
  const handler = handlerFor(context, artifactBytes);
  const previous = await signedRequestWithKey(context, "handoff-key-v0", "promotion-executor-test-previous-secret");
  assert.equal((await handler(previous)).status, 200);
  const active = await signedRequestWithKey(context, "handoff-key-v1", "promotion-executor-test-handoff-secret");
  assert.equal((await handler(active)).status, 200);
  const unknown = await signedRequestWithKey(context, "handoff-key-vx", "promotion-executor-test-handoff-secret");
  assert.equal((await handler(unknown)).status, 401);
});

test("customer-operated executor routes two Targets to distinct provider configuration and credentials", async () => {
  const { context, artifactBytes } = fixture();
  const secondContext = {
    ...context,
    target: { ...context.target, id: "target:executor-beta" },
    promotion: { ...context.promotion, id: "promotion:executor-beta", targetId: "target:executor-beta" },
  };
  const providerRequests: Array<{ path: string; token: string }> = [];
  const versions = new Map<string, Record<string, unknown>>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    providerRequests.push({ path, token: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "") });
    if (url.hostname === "api.cloudflare.com") {
      const scriptName = path.split("/").at(-2) ?? "unknown";
      if (path.endsWith("/versions") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ result: { items: [] }, errors: [], messages: [] }), { status: 200 });
      if (path.endsWith("/versions") && init?.method === "POST") {
        const form = init.body as FormData;
        const metadataPart = form.get("metadata");
        const metadataText = metadataPart instanceof Blob ? await metadataPart.text() : String(metadataPart);
        const metadata = JSON.parse(metadataText) as { main_module?: string; annotations: Record<string, string>; compatibility_date: string; compatibility_flags: readonly string[]; bindings?: readonly Readonly<Record<string, unknown>>[] };
        const id = `version-${scriptName}`;
        versions.set(id, { id, metadata, resources: { bindings: metadata.bindings ?? [], script: { main_module: metadata.main_module ?? "worker.js", modules: [{ name: metadata.main_module ?? "worker.js" }] }, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags ?? [] } } });
        return new Response(JSON.stringify({ result: { id }, errors: [], messages: [] }), { status: 200 });
      }
      if (path.includes("/versions/") && (init?.method ?? "GET") === "GET") {
        const id = decodeURIComponent(path.split("/").at(-1) ?? "");
        return new Response(JSON.stringify({ result: versions.get(id), errors: [], messages: [] }), { status: versions.has(id) ? 200 : 404 });
      }
      if (path.endsWith("/deployments") && init?.method === "POST") return new Response(JSON.stringify({ result: { id: `deployment-${scriptName}`, versions: [] }, errors: [], messages: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "healthy", releaseId: context.release.id }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const credential = (token: string) => ({
    async probe() { return { credentialId: `credential:${token}`, expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; providerAuthorization=observed; credentialMaterialStored=false" }; },
    async issue(input: { operation: string; audience: string }) { return { token, credentialId: `credential:${token}:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience as "aud:anyam:deployment" | "aud:anyam:promotion", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; providerAuthorization=observed; credentialMaterialStored=false" }; },
  });
  const claimed = new Set<string>();
  const handler = createPromotionExecutorHandler({
    targetRoutes: [
      { targetId: "target:executor", accountId: "account:alpha", scriptName: "worker-alpha", previewSubdomain: "alpha", credentialBroker: credential("token-alpha") },
      { targetId: "target:executor-beta", accountId: "account:beta", scriptName: "worker-beta", previewSubdomain: "beta", credentialBroker: credential("token-beta") },
    ],
    workerReleaseManifest: ({ release }) => createCloudflareWorkerReleaseManifest({ release, compatibilityDate: "2026-01-01", bindings: [], healthPaths: ["/health"] }),
    handoffKeys: { active: { id: "handoff-key-v1", secret: "route-test-secret" } },
    handoffNonceStore: { async claim(input) { if (claimed.has(input.nonce)) return false; claimed.add(input.nonce); return true; } },
    artifactStore: { async get(key) { return key === `artifacts/${context.artifacts[0]?.digest}` ? { arrayBuffer: async () => new Uint8Array(artifactBytes).buffer as ArrayBuffer } : null; } },
    fetch: fetcher,
  });
  const alpha = await handler(await signedRequestWithKey(context, "handoff-key-v1", "route-test-secret"));
  const beta = await handler(await signedRequestWithKey(secondContext, "handoff-key-v1", "route-test-secret"));
  assert.equal(alpha.status, 200, await alpha.text());
  assert.equal(beta.status, 200, await beta.text());
  const alphaRequests = providerRequests.filter((request) => request.path.includes("worker-alpha"));
  const betaRequests = providerRequests.filter((request) => request.path.includes("worker-beta"));
  assert.ok(alphaRequests.length > 0);
  assert.ok(betaRequests.length > 0);
  assert.equal(alphaRequests.every((request) => request.token.includes("token-alpha")), true);
  assert.equal(betaRequests.every((request) => request.token.includes("token-beta")), true);
});
