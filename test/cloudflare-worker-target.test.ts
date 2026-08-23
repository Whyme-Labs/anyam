import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CloudflareWorkerTargetAdapter,
  createCloudflareWorkerRestTransport,
  type CloudflareWorkerApiRequest,
  type CloudflareWorkerApiResponse,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerTargetOperation,
  type CloudflareWorkerVersion,
  type CloudflareWorkerVersionList,
} from "../src/cloudflare/worker-target.ts";
import { createCloudflareWorkerReleaseManifest } from "../src/cloudflare/worker-release-manifest.ts";
import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";
import {
  createWorkerTarget,
  sealVerifiedRelease,
  WorkerPromotionCoordinator,
  type ImmutableRelease,
} from "../src/delivery/promotion.ts";
import { createTargetDeploymentProfile } from "../src/delivery/target-deployment.ts";
import {
  normalizeProjectManifest,
  runLocalRelease,
  targetFromManifest,
  type LocalExecutionContext,
} from "../src/execution/local.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const actor = {
  principalId: "principal:cloudflare-worker-target-test",
  actorId: "actor:cloudflare-worker-target-test",
  sessionId: "session:cloudflare-worker-target-test",
  clientId: "client:cloudflare-worker-target-test",
};

function context(directory: string): LocalExecutionContext {
  return {
    directory,
    projectRevisionId: "project-revision:cloudflare-worker-target:v1",
    projectViewId: "project-view:cloudflare-worker-target:project",
    sourceSpaceSnapshots: { "worker-source": "snapshot:cloudflare-worker-target:v1" },
    actor,
    runnerId: "runner:local",
    policyVersion: "policy:cloudflare-worker-target:v1",
    authorizationEpoch: "epoch:cloudflare-worker-target:v1",
    capabilityGrantId: "grant:cloudflare-worker-target",
    dependencyDigest: "sha256:cloudflare-worker-target-dependencies",
    toolchainDigest: "sha256:cloudflare-worker-target-toolchain",
    environmentDigest: "sha256:cloudflare-worker-target-environment",
    disclosure: { projectionId: "project-view:cloudflare-worker-target:project", classification: "project" },
    owner: "Cloudflare Worker Target deterministic test",
    changeRevisionId: "change-revision:cloudflare-worker-target:v1",
    workspaceId: "workspace:cloudflare-worker-target:v1",
    targetId: "target:worker",
    declaredEffects: ["artifact.create", "target.promote"],
  };
}

async function release(name: string): Promise<{ directory: string; release: ImmutableRelease }> {
  const directory = await mkdtemp(join(tmpdir(), `anyam-cloudflare-worker-target-${name}-`));
  await cp(join(fixtureRoot, "worker"), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8")) as unknown;
  const normalized = normalizeProjectManifest(manifest);
  const target = createWorkerTarget({
    target: targetFromManifest(normalized.targets[0]!, normalized.projectId),
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
  const result = await runLocalRelease({ manifest, context: context(directory), releaseName: name });
  return {
    directory,
    release: sealVerifiedRelease({ projectId: normalized.projectId, release: result.release, artifacts: result.artifacts, evidence: result.evidence, target }),
  };
}

type RecordedRequest = {
  method: CloudflareWorkerApiRequest["method"];
  path: string;
  token: string;
};

class InMemoryCloudflareWorkerApi {
  readonly requests: RecordedRequest[] = [];
  readonly versions: CloudflareWorkerVersion[] = [];
  readonly deployments: CloudflareWorkerDeployment[] = [];
  nextManifest: ReturnType<typeof createCloudflareWorkerReleaseManifest> | undefined;
  previewAvailable = true;
  private sequence = 0;

  async request<T>(request: CloudflareWorkerApiRequest): Promise<CloudflareWorkerApiResponse<T>> {
    this.requests.push({ method: request.method, path: request.path, token: request.token });
    if (request.method === "GET" && request.path.includes("/versions?")) {
      return { status: 200, ok: true, result: { items: [...this.versions] } as CloudflareWorkerVersionList as T, errors: [], messages: [] };
    }
    if (request.method === "GET" && /\/versions\/[^/]+$/u.test(request.path)) {
      const versionId = decodeURIComponent(request.path.split("/").at(-1) ?? "");
      const version = this.versions.find((candidate) => candidate.id === versionId);
      return version
        ? { status: 200, ok: true, result: version as T, errors: [], messages: [] }
        : { status: 404, ok: false, errors: [{ code: 1000, message: "version not found" }], messages: [] };
    }
    if (request.method === "POST" && request.path.endsWith("/versions")) {
      assert.ok(request.body instanceof FormData);
      const form = request.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as { main_module: string; annotations: { "workers/tag": string } };
      const file = form.get(metadata.main_module);
      assert.ok(file instanceof Blob);
      assert.ok((await file.arrayBuffer()).byteLength > 0);
      assert.ok(this.nextManifest);
      const manifest = this.nextManifest;
      const version: CloudflareWorkerVersion = {
        id: `version:${++this.sequence}`,
        metadata: { hasPreview: this.previewAvailable, annotations: metadata.annotations },
        resources: {
          bindings: manifest.bindings.map((binding) => ({ name: binding.name, type: binding.kind, ...(binding.providerFields ?? {}) })),
          script_runtime: { compatibility_date: manifest.compatibility.date, compatibility_flags: manifest.compatibility.flags },
          ...(manifest.staticAssets ? { assets: {} } : {}),
          ...(manifest.durableObjectMigrations ? { durable_object_migrations: { ...manifest.durableObjectMigrations } } : {}),
        },
      };
      this.versions.unshift(version);
      return { status: 200, ok: true, result: version as T, errors: [], messages: [] };
    }
    if (request.method === "POST" && request.path.endsWith("/deployments")) {
      const body = JSON.parse(String(request.body)) as { versions: readonly { version_id: string; percentage: number }[]; annotations?: Record<string, string> };
      assert.equal(body.annotations && "workers/triggered_by" in body.annotations, false);
      const deployment: CloudflareWorkerDeployment = { id: `deployment:${++this.sequence}`, versions: body.versions };
      this.deployments.unshift(deployment);
      return { status: 200, ok: true, result: deployment as T, errors: [], messages: [] };
    }
    return { status: 404, ok: false, errors: [{ code: 1000, message: "unknown test provider route" }], messages: [] };
  }
}

function manifestBuilder(api: InMemoryCloudflareWorkerApi) {
  return ({ release }: { release: ImmutableRelease; target: ReturnType<typeof createWorkerTarget> }) => {
    const manifest = createCloudflareWorkerReleaseManifest({ release, compatibilityDate: "2026-01-01", bindings: [], healthPaths: ["/health"] });
    api.nextManifest = manifest;
    return manifest;
  };
}

test("Cloudflare REST transport accepts successful responses that omit optional error arrays", async () => {
  const transport = createCloudflareWorkerRestTransport({
    apiBase: "https://api.example.test",
    fetch: async () => new Response(JSON.stringify({ success: true, result: { items: [] } }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const response = await transport.request<{ items: readonly unknown[] }>({
    method: "GET",
    path: "/accounts/account/versions",
    token: "provider-token",
  });
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { items: [] });
  assert.deepEqual(response.errors, []);
  assert.deepEqual(response.messages, []);
});

test("Cloudflare Worker Target uploads digest-bound versions, promotes after preview, and rolls back after unhealthy health", async () => {
  const first = await release("first");
  const second = await release("second");
  try {
    const api = new InMemoryCloudflareWorkerApi();
    const issued: Array<{ operation: CloudflareWorkerTargetOperation; audience: string }> = [];
    const productionHealthStates: readonly [number, number, number, number, number] = [404, 200, 503, 503, 200];
    let productionHealthIndex = 0;
    let previewRequestCount = 0;
    const firstArtifact = first.release.artifacts[0];
    const secondArtifact = second.release.artifacts[0];
    assert.ok(firstArtifact?.outputPath);
    assert.ok(secondArtifact?.outputPath);
    const firstBytes = new Uint8Array(await readFile(join(first.directory, firstArtifact.outputPath)));
    const secondBytes = new Uint8Array(await readFile(join(second.directory, secondArtifact.outputPath)));
    const configuredAdapter = new CloudflareWorkerTargetAdapter({
      accountId: "account:test",
      scriptName: "anyam-target-test",
      targetId: "target:worker",
      transport: api,
      credentialBroker: {
        async issue(input) {
          issued.push({ operation: input.operation, audience: input.audience });
          return { token: "provider-secret-never-in-receipt", credentialId: `credential:${issued.length}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: `credential=${input.operation}; providerAuthorization=observed; credentialMaterialStored=false` };
        },
        async probe() { return { credentialId: "credential:probe", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=probe; providerAuthorization=observed; credentialMaterialStored=false" }; },
      },
      workerReleaseManifest: manifestBuilder(api),
      artifactReader: {
        async read(artifact) {
          return artifact.id === firstArtifact.id ? firstBytes : secondBytes;
        },
      },
      previewUrlForVersion: (versionId) => `https://${versionId}.preview.workers.dev`,
      healthUrl: "https://anyam-target-test.workers.dev/health",
      healthResponseValidator: ({ status, body, release }) => {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { status?: string; releaseId?: string };
        const releaseMatches = parsed.releaseId === release.release.id;
        const healthy = status >= 200 && status < 300 && releaseMatches && parsed.status === "healthy";
        return {
          state: healthy ? "healthy" : "unhealthy",
          receipt: `healthValidation=${healthy ? "release-bound" : releaseMatches ? "status-mismatch" : "release-mismatch"}; expectedRelease=${release.release.id}; observedRelease=${parsed.releaseId ?? "missing"}`,
        };
      },
      routeReadinessRetry: { maxAttempts: 2, delayMs: 0, retryStatuses: [404] },
      rollbackRouteReadinessRetry: { maxAttempts: 2, delayMs: 0, retryStatuses: [404, 503] },
      fetch: async (url) => {
        const requestedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (requestedUrl.includes("preview")) {
          previewRequestCount += 1;
          if (previewRequestCount % 2 === 1) return new Response("preview-route-not-ready", { status: 404 });
          const releaseId = previewRequestCount <= 2 ? first.release.release.id : second.release.release.id;
          return new Response(JSON.stringify({ status: "healthy", releaseId }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const responseIndex = productionHealthIndex++;
        const status = productionHealthStates[responseIndex] ?? 200;
        const releaseId = responseIndex === 0 || responseIndex === 1 || responseIndex === 4 ? first.release.release.id : second.release.release.id;
        return new Response(JSON.stringify({ status: status === 200 ? "healthy" : "unhealthy", releaseId }), { status, headers: { "content-type": "application/json" } });
      },
      now: () => "2026-08-11T00:00:00.000Z",
    });

    const target = createWorkerTarget({
      target: {
        protocol: CONTRACT_VERSIONS.target,
        id: "target:worker",
        projectId: "project:worker",
        name: "Cloudflare Worker Target test",
        adapterId: "cloudflare.worker",
        acceptedArtifactTypes: ["worker.bundle"],
        requiredEvidenceKeys: [],
        state: "configured",
      },
      capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
    });
    const coordinator = new WorkerPromotionCoordinator({ projectId: "project:worker", target, adapter: configuredAdapter });
    coordinator.registerRelease(first.release);
    coordinator.registerRelease(second.release);

    const firstPromotion = await coordinator.promote({ releaseId: first.release.release.id, idempotencyKey: "ship:cloudflare:first", actor });
    assert.equal(firstPromotion.state, "healthy");
    assert.match(firstPromotion.health?.receipt ?? "", /routeReadinessAttempts=2/);
    assert.match(firstPromotion.health?.receipt ?? "", /healthValidation=release-bound|healthValidation=status-mismatch/);
    assert.match(firstPromotion.health?.receipt ?? "", /phase=candidate/);
    assert.equal(previewRequestCount, 2);
    const secondPromotion = await coordinator.promote({ releaseId: second.release.release.id, idempotencyKey: "ship:cloudflare:second", actor });
    assert.equal(secondPromotion.state, "rolled-back");
    assert.equal(secondPromotion.health?.state, "unhealthy");
    assert.equal(secondPromotion.rollbackHealth?.state, "healthy");
    assert.match(secondPromotion.rollbackHealth?.receipt ?? "", /phase=rollback/);
    assert.match(secondPromotion.rollbackHealth?.receipt ?? "", /routeReadinessAttempts=2/);
    assert.equal(coordinator.getTarget().currentReleaseId, first.release.release.id);
    assert.equal(coordinator.getTarget().state, "healthy");
    assert.equal(api.versions.length, 2);
    assert.equal(api.deployments.length, 3);
    assert.equal(issued.some((entry) => entry.operation === "version-upload" && entry.audience === "aud:anyam:deployment"), true);
    assert.equal(issued.some((entry) => entry.operation === "apply" && entry.audience === "aud:anyam:promotion"), true);
    assert.equal(issued.some((entry) => entry.operation === "rollback" && entry.audience === "aud:anyam:promotion"), true);
    assert.equal(JSON.stringify(secondPromotion).includes("provider-secret-never-in-receipt"), false);
    assert.equal(JSON.stringify(coordinator.listEvents()).includes("provider-secret-never-in-receipt"), false);
    assert.ok(api.requests.every((request) => request.token === "provider-secret-never-in-receipt"));
  } finally {
    await Promise.all([rm(first.directory, { recursive: true, force: true }), rm(second.directory, { recursive: true, force: true })]);
  }
});

test("Cloudflare Worker Target rejects a stale 2xx health response from a previous Release", async () => {
  const candidate = await release("stale-health");
  try {
    const api = new InMemoryCloudflareWorkerApi();
    const artifact = candidate.release.artifacts[0];
    assert.ok(artifact?.outputPath);
    const bytes = new Uint8Array(await readFile(join(candidate.directory, artifact.outputPath)));
    const target = createWorkerTarget({
      target: {
        protocol: CONTRACT_VERSIONS.target,
        id: "target:stale-health",
        projectId: "project:worker",
        name: "Stale health test",
        adapterId: "cloudflare.worker",
        acceptedArtifactTypes: ["worker.bundle"],
        requiredEvidenceKeys: [],
        state: "configured",
      },
      capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
    });
    const adapter = new CloudflareWorkerTargetAdapter({
      accountId: "account:stale-health",
      scriptName: "anyam-stale-health",
      targetId: "target:stale-health",
      transport: api,
      credentialBroker: {
        async issue(input) {
          return { token: "stale-health-token", credentialId: `credential:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=brokered; providerAuthorization=observed; credentialMaterialStored=false" };
        },
        async probe() { return { credentialId: "credential:probe", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=probe; providerAuthorization=observed; credentialMaterialStored=false" }; },
      },
      workerReleaseManifest: manifestBuilder(api),
      artifactReader: { async read() { return bytes; } },
      previewUrlForVersion: (versionId) => `https://${versionId}.preview.workers.dev`,
      healthUrl: "https://anyam-stale-health.workers.dev/health",
      healthResponseValidator: ({ status, body, release }) => {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as { status?: string; releaseId?: string };
        const releaseMatches = parsed.releaseId === release.release.id;
        return {
          state: status >= 200 && status < 300 && releaseMatches && parsed.status === "healthy" ? "healthy" : "unhealthy",
          receipt: `healthValidation=${releaseMatches ? "status-mismatch" : "release-mismatch"}; expectedRelease=${release.release.id}; observedRelease=${parsed.releaseId ?? "missing"}`,
        };
      },
      fetch: async () => new Response(JSON.stringify({ status: "healthy", releaseId: "release:previous" }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const deployment = await adapter.apply({ promotionId: "promotion:stale-health", attempt: 1, release: candidate.release, target });
    assert.equal(deployment.status, "succeeded");
    if (deployment.status === "succeeded") {
      const health = await adapter.health({ promotionId: "promotion:stale-health", attempt: 1, release: candidate.release, target, deploymentId: deployment.value.deploymentId });
      assert.equal(health.status, "succeeded");
      if (health.status === "succeeded") {
        assert.equal(health.value.state, "unhealthy");
        assert.match(health.value.receipt, /healthValidation=release-mismatch/);
      }
    }
  } finally {
    await rm(candidate.directory, { recursive: true, force: true });
  }
});

test("Cloudflare Worker Target retries transient preview transport failures when route readiness allows it", async () => {
  const candidate = await release("transport-retry");
  try {
    const api = new InMemoryCloudflareWorkerApi();
    const artifact = candidate.release.artifacts[0];
    assert.ok(artifact?.outputPath);
    const bytes = new Uint8Array(await readFile(join(candidate.directory, artifact.outputPath)));
    const target = createWorkerTarget({
      target: {
        protocol: CONTRACT_VERSIONS.target,
        id: "target:transport-retry",
        projectId: "project:worker",
        name: "Transport retry test",
        adapterId: "cloudflare.worker",
        acceptedArtifactTypes: ["worker.bundle"],
        requiredEvidenceKeys: [],
        state: "configured",
      },
      capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
    });
    let fetchAttempts = 0;
    const adapter = new CloudflareWorkerTargetAdapter({
      accountId: "account:transport-retry",
      scriptName: "anyam-transport-retry",
      targetId: "target:transport-retry",
      transport: api,
      credentialBroker: {
        async issue(input) {
          return { token: "transport-retry-token", credentialId: `credential:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=brokered; providerAuthorization=observed; credentialMaterialStored=false" };
        },
        async probe() { return { credentialId: "credential:probe", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=probe; providerAuthorization=observed; credentialMaterialStored=false" }; },
      },
      workerReleaseManifest: manifestBuilder(api),
      artifactReader: { async read() { return bytes; } },
      previewUrlForVersion: (versionId) => `https://${versionId}.preview.workers.dev`,
      healthUrl: "https://anyam-transport-retry.workers.dev/health",
      routeReadinessRetry: { maxAttempts: 2, delayMs: 0, retryStatuses: [404], retryTransportErrors: true },
      fetch: async () => {
        fetchAttempts += 1;
        if (fetchAttempts === 1) throw new Error("temporary DNS failure");
        return new Response("preview-ok", { status: 200 });
      },
    });
    const preview = await adapter.preview({ promotionId: "promotion:transport-retry", attempt: 1, release: candidate.release, target });
    assert.equal(preview.status, "succeeded");
    if (preview.status === "succeeded") assert.match(preview.receipt, /routeReadinessAttempts=2;.*routeReadinessRetryTransportErrors=true/);
  } finally {
    await rm(candidate.directory, { recursive: true, force: true });
  }
});

test("Cloudflare Worker Target fails a non-2xx preview before deployment", async () => {
  const candidate = await release("preview-failure");
  try {
    const api = new InMemoryCloudflareWorkerApi();
    const artifact = candidate.release.artifacts[0];
    assert.ok(artifact?.outputPath);
    const bytes = new Uint8Array(await readFile(join(candidate.directory, artifact.outputPath)));
    const adapter = new CloudflareWorkerTargetAdapter({
      accountId: "account:preview-failure",
      scriptName: "anyam-preview-failure",
      targetId: "target:preview-failure",
      transport: api,
      credentialBroker: {
        async issue(input) {
          return { token: "preview-token", credentialId: `credential:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=brokered; providerAuthorization=observed; credentialMaterialStored=false" };
        },
        async probe() { return { credentialId: "credential:probe", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=probe; providerAuthorization=observed; credentialMaterialStored=false" }; },
      },
      workerReleaseManifest: manifestBuilder(api),
      artifactReader: {
        async read() {
          return bytes;
        },
      },
      previewUrlForVersion: (versionId) => `https://${versionId}.preview.workers.dev`,
      healthUrl: "https://anyam-preview-failure.workers.dev/health",
      fetch: async () => new Response("preview-broken", { status: 503 }),
    });
    const result = await adapter.preview({ promotionId: "promotion:preview-failure", attempt: 1, release: candidate.release, target: createWorkerTarget({
      target: {
        protocol: CONTRACT_VERSIONS.target,
        id: "target:preview-failure",
        projectId: "project:worker",
        name: "Preview failure test",
        adapterId: "cloudflare.worker",
        acceptedArtifactTypes: ["worker.bundle"],
        requiredEvidenceKeys: [],
        state: "configured",
      },
      capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
    }) });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
      assert.equal(result.errorCode, "preview.unhealthy");
      assert.match(result.receipt, /providerVersionId=version:/);
      assert.match(result.receipt, /httpStatus=503/);
    }
    assert.equal(api.deployments.length, 0);
  } finally {
    await rm(candidate.directory, { recursive: true, force: true });
  }
});

test("Cloudflare Worker Target uses an explicit isolated preview strategy when version URLs are unavailable", async () => {
  const candidate = await release("isolated-preview");
  try {
    const api = new InMemoryCloudflareWorkerApi();
    api.previewAvailable = false;
    const artifact = candidate.release.artifacts[0];
    assert.ok(artifact?.outputPath);
    const bytes = new Uint8Array(await readFile(join(candidate.directory, artifact.outputPath)));
    const target = createWorkerTarget({
      target: {
        protocol: CONTRACT_VERSIONS.target,
        id: "target:isolated-preview",
        projectId: "project:worker",
        name: "Durable Object-safe isolated preview",
        adapterId: "cloudflare.worker",
        acceptedArtifactTypes: ["worker.bundle"],
        requiredEvidenceKeys: [],
        state: "configured",
        deploymentProfile: createTargetDeploymentProfile({
          environment: "staging",
          channel: "alpha",
          audience: "staging",
          runtimeIdentity: "worker:staging",
          routeIdentities: ["route:staging"],
          bindingIdentities: ["do:isolated"],
          dataResourceIdentities: ["d1:isolated"],
          configurationDigests: ["sha256:isolated-preview-config"],
          secretUseAliases: [],
          dataClass: "isolated",
          resourceSharing: "isolated",
          previewStrategy: { kind: "isolated-target", targetId: "target:isolated-preview" },
        }),
      },
      capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
    });
    const adapter = new CloudflareWorkerTargetAdapter({
      accountId: "account:isolated-preview",
      scriptName: "anyam-isolated-preview",
      targetId: target.id,
      transport: api,
      credentialBroker: {
        async issue(input) { return { token: "isolated-preview-token", credentialId: `credential:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; providerAuthorization=observed; credentialMaterialStored=false" }; },
        async probe() { return { credentialId: "credential:probe", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; providerAuthorization=observed; credentialMaterialStored=false" }; },
      },
      workerReleaseManifest: manifestBuilder(api),
      artifactReader: { async read() { return bytes; } },
      previewUrlForVersion: (versionId) => `https://${versionId}.preview.workers.dev`,
      previewUrlForStrategy: ({ strategy }) => strategy.kind === "isolated-target" ? "https://isolated-target.preview.example/health" : undefined,
      healthUrl: "https://isolated-target.example/health",
      fetch: async (url) => url.toString().includes("isolated-target.preview") ? new Response(JSON.stringify({ status: "healthy", releaseId: candidate.release.release.id }), { status: 200, headers: { "content-type": "application/json" } }) : new Response("unexpected", { status: 500 }),
    });
    const preview = await adapter.preview({ promotionId: "promotion:isolated-preview", attempt: 1, release: candidate.release, target });
    assert.equal(preview.status, "succeeded");
    if (preview.status === "succeeded") {
      assert.match(preview.receipt, /previewUrl=https:\/\/isolated-target\.preview\.example\/health/);
      assert.match(preview.receipt, /releaseDigest=/);
    }
  } finally {
    await rm(candidate.directory, { recursive: true, force: true });
  }
});
