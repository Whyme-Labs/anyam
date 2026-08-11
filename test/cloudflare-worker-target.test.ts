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
import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";
import {
  createWorkerTarget,
  sealVerifiedRelease,
  WorkerPromotionCoordinator,
  type ImmutableRelease,
} from "../src/delivery/promotion.ts";
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
  private sequence = 0;

  async request<T>(request: CloudflareWorkerApiRequest): Promise<CloudflareWorkerApiResponse<T>> {
    this.requests.push({ method: request.method, path: request.path, token: request.token });
    if (request.method === "GET" && request.path.includes("/versions?")) {
      return { status: 200, ok: true, result: { items: [...this.versions] } as CloudflareWorkerVersionList as T, errors: [], messages: [] };
    }
    if (request.method === "POST" && request.path.endsWith("/versions")) {
      assert.ok(request.body instanceof FormData);
      const form = request.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as { main_module: string; annotations: { "workers/tag": string } };
      const file = form.get(metadata.main_module);
      assert.ok(file instanceof Blob);
      assert.ok((await file.arrayBuffer()).byteLength > 0);
      const version: CloudflareWorkerVersion = {
        id: `version:${++this.sequence}`,
        metadata: { hasPreview: true, annotations: metadata.annotations },
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
      transport: api,
      credentialBroker: {
        async issue(input) {
          issued.push({ operation: input.operation, audience: input.audience });
          return { token: "provider-secret-never-in-receipt", credentialId: `credential:${issued.length}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, receipt: `credential=${input.operation}; token=redacted` };
        },
      },
      artifactReader: {
        async read(artifact) {
          return artifact.id === firstArtifact.id ? firstBytes : secondBytes;
        },
      },
      previewUrlForVersion: (versionId) => `https://${versionId}.preview.workers.dev`,
      healthUrl: "https://anyam-target-test.workers.dev/health",
      routeReadinessRetry: { maxAttempts: 2, delayMs: 0, retryStatuses: [404] },
      rollbackRouteReadinessRetry: { maxAttempts: 2, delayMs: 0, retryStatuses: [404, 503] },
      fetch: async (url) => {
        const requestedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        if (requestedUrl.includes("preview")) {
          previewRequestCount += 1;
          if (previewRequestCount % 2 === 1) return new Response("preview-route-not-ready", { status: 404 });
          return new Response("preview-ok", { status: 200 });
        }
        const status = productionHealthStates[productionHealthIndex++] ?? 200;
        return new Response(status === 200 ? "healthy" : "broken", { status });
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
    assert.equal(issued.some((entry) => entry.operation === "apply" && entry.audience === "aud:anyam:promotion"), true);
    assert.equal(issued.some((entry) => entry.operation === "rollback" && entry.audience === "aud:anyam:promotion"), true);
    assert.equal(JSON.stringify(secondPromotion).includes("provider-secret-never-in-receipt"), false);
    assert.equal(JSON.stringify(coordinator.listEvents()).includes("provider-secret-never-in-receipt"), false);
    assert.ok(api.requests.every((request) => request.token === "provider-secret-never-in-receipt"));
  } finally {
    await Promise.all([rm(first.directory, { recursive: true, force: true }), rm(second.directory, { recursive: true, force: true })]);
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
      transport: api,
      credentialBroker: {
        async issue(input) {
          return { token: "preview-token", credentialId: `credential:${input.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, receipt: "credential=brokered; token=redacted" };
        },
      },
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
