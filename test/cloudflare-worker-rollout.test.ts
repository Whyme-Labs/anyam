import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CloudflareWorkerTargetAdapter,
  type CloudflareWorkerApiRequest,
  type CloudflareWorkerApiResponse,
  type CloudflareWorkerDeployment,
  type CloudflareWorkerVersion,
  type CloudflareWorkerVersionList,
  type CloudflareWorkerProviderIdentity,
} from "../src/cloudflare/worker-target.ts";
import { createCloudflareWorkerReleaseManifest } from "../src/cloudflare/worker-release-manifest.ts";
import { CONTRACT_VERSIONS, type Artifact, type Release } from "../src/kernel/contracts.ts";
import { createTargetDeploymentProfile } from "../src/delivery/target-deployment.ts";
import { createWorkerTarget, type ImmutableRelease } from "../src/delivery/promotion.ts";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture(): { release: ImmutableRelease; target: ReturnType<typeof createWorkerTarget>; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode("export default { fetch() { return new Response('ok'); } };\n");
  const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:rollout", type: "worker.bundle", digest: digest(new TextDecoder().decode(bytes)), projectRevisionId: "project-revision:rollout", outputPath: "worker.js" };
  const release: Release = { protocol: CONTRACT_VERSIONS.release, id: "release:rollout", projectRevisionId: artifact.projectRevisionId, artifactIds: [artifact.id], evidenceIds: [], configurationDigests: [digest("config")], stateAssumptions: ["rollout test"], policyVersion: "policy:rollout", status: "ready" };
  const target = createWorkerTarget({ target: { protocol: CONTRACT_VERSIONS.target, id: "target:rollout", projectId: "project:rollout", name: "Rollout Target", adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle"], requiredEvidenceKeys: [], state: "configured", deploymentProfile: createTargetDeploymentProfile({ environment: "staging", channel: "beta", audience: "rollout", runtimeIdentity: "worker:rollout", routeIdentities: ["route:rollout"], bindingIdentities: [], dataResourceIdentities: [], configurationDigests: [digest("config")], secretUseAliases: [], dataClass: "isolated", resourceSharing: "isolated" }) }, capabilities: { preview: true, promote: true, healthCheck: true, rollback: true } });
  return { bytes, target, release: { protocol: CONTRACT_VERSIONS.verifiedRelease, id: "verified-release:rollout", projectId: "project:rollout", release, artifacts: [artifact], evidence: [], releaseDigest: digest("release:rollout"), receipt: "fixture=rollout" } };
}

class RolloutProvider {
  readonly requests: CloudflareWorkerApiRequest[] = [];
  readonly versions = new Map<string, CloudflareWorkerVersion>();
  readonly deployments: Array<{ id: string; percentage: number; versionId: string }> = [];
  responseLossAtPercentage: number | undefined;
  listShouldFail = false;
  private sequence = 0;

  async request<T>(request: CloudflareWorkerApiRequest): Promise<CloudflareWorkerApiResponse<T>> {
    this.requests.push(request);
    if (request.method === "GET" && request.path.includes("/versions?")) {
      if (this.listShouldFail) throw new Error("version list unavailable");
      const page = new URL(`https://provider.test${request.path}`).searchParams.get("page") ?? "1";
      const items = page === "1" ? [...this.versions.values()].slice(0, 100) : [...this.versions.values()].slice(100);
      return { status: 200, ok: true, result: { items } as CloudflareWorkerVersionList as T, errors: [], messages: [] };
    }
    if (request.method === "GET" && request.path.includes("/versions/")) {
      const id = decodeURIComponent(request.path.split("/").at(-1) ?? "");
      const version = this.versions.get(id);
      return version ? { status: 200, ok: true, result: version as T, errors: [], messages: [] } : { status: 404, ok: false, errors: [{ code: 1000, message: "version not found" }], messages: [] };
    }
    if (request.method === "POST" && request.path.endsWith("/versions")) {
      const form = request.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as { annotations: { "workers/tag": string; "workers/message": string }; compatibility_date: string; compatibility_flags: readonly string[]; bindings?: readonly Readonly<Record<string, unknown>>[] };
      const id = `version:${++this.sequence}`;
      this.versions.set(id, { id, metadata: { annotations: metadata.annotations, hasPreview: true }, resources: { bindings: metadata.bindings ?? [], script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } });
      return { status: 200, ok: true, result: { id } as T, errors: [], messages: [] };
    }
    if (request.method === "POST" && request.path.endsWith("/deployments")) {
      const body = JSON.parse(String(request.body)) as { versions: readonly [{ percentage: number; version_id: string }] };
      const step = body.versions[0];
      if (this.responseLossAtPercentage === step.percentage) throw new Error("provider response lost after deployment");
      const id = `deployment:${++this.sequence}`;
      this.deployments.push({ id, percentage: step.percentage, versionId: step.version_id });
      return { status: 200, ok: true, result: { id, versions: body.versions } as CloudflareWorkerDeployment as T, errors: [], messages: [] };
    }
    return { status: 404, ok: false, errors: [{ code: 1000, message: "unknown provider route" }], messages: [] };
  }
}

function adapter(provider: RolloutProvider, input: ReturnType<typeof fixture>, ledger?: Map<string, CloudflareWorkerProviderIdentity>, rolloutPolicy?: { steps: readonly { percentage: number; minimumObservationMs: number }[]; versionAffinityRequired: boolean }, observer?: (percentage: number) => "continue" | "abort") {
  return new CloudflareWorkerTargetAdapter({
    accountId: "account:rollout",
    scriptName: "worker-rollout",
    targetId: input.target.id,
    transport: provider,
    credentialBroker: {
      async issue(request) { return { token: "rollout-token", credentialId: `credential:${request.operation}`, expiresAt: "2099-01-01T00:00:00.000Z", audience: request.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; providerAuthorization=observed; credentialMaterialStored=false" }; },
      async probe() { return { credentialId: "credential:probe", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; providerAuthorization=observed; credentialMaterialStored=false" }; },
    },
    workerReleaseManifest: ({ release }) => createCloudflareWorkerReleaseManifest({ release, compatibilityDate: "2026-01-01", bindings: [] }),
    ...(ledger ? { providerIdentityLedger: { async load(key: { targetId: string; releaseDigest: string }) { return ledger.get(`${key.targetId}:${key.releaseDigest}`); }, async save(identity: CloudflareWorkerProviderIdentity) { ledger.set(`${identity.targetId}:${identity.releaseDigest}`, identity); } } } : {}),
    ...(rolloutPolicy ? { rolloutPolicy } : {}),
    ...(observer ? { rolloutObserver: async ({ step }: { step: { percentage: number } }) => ({ status: observer(step.percentage), receipt: `observer=fixture; percentage=${step.percentage}` }) } : {}),
    artifactReader: { async read() { return input.bytes; } },
    previewUrlForVersion: (versionId) => `https://${versionId}.preview.example`,
    healthUrl: "https://worker-rollout.example/health",
    fetch: async () => new Response("healthy", { status: 200 }),
  });
}

test("Worker rollout records staged provider identities, preserves version affinity, and reuses the exact ledger identity", async () => {
  const input = fixture();
  const provider = new RolloutProvider();
  const ledger = new Map<string, CloudflareWorkerProviderIdentity>();
  const policy = { steps: [{ percentage: 1, minimumObservationMs: 1 }, { percentage: 100, minimumObservationMs: 0 }], versionAffinityRequired: true } as const;
  const result = await adapter(provider, input, ledger, policy, () => "continue").apply({ promotionId: "promotion:rollout", attempt: 1, release: input.release, target: input.target });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(provider.deployments.map((deployment) => deployment.percentage), [1, 100]);
  assert.equal(new Set(provider.deployments.map((deployment) => deployment.versionId)).size, 1);
  assert.equal(ledger.size, 1);
  provider.listShouldFail = true;
  const health = await adapter(provider, input, ledger).health({ promotionId: "promotion:rollout", attempt: 1, release: input.release, target: input.target });
  assert.equal(health.status, "succeeded");
});

test("Worker rollout aborts or becomes indeterminate on observation and response-loss failures", async () => {
  const input = fixture();
  const policy = { steps: [{ percentage: 1, minimumObservationMs: 1 }, { percentage: 100, minimumObservationMs: 0 }], versionAffinityRequired: true } as const;
  const abortedProvider = new RolloutProvider();
  const aborted = await adapter(abortedProvider, input, undefined, policy, () => "abort").apply({ promotionId: "promotion:abort", attempt: 1, release: input.release, target: input.target });
  assert.equal(aborted.status, "failed");
  if (aborted.status === "failed") assert.equal(aborted.errorCode, "rollout.aborted");
  const lostProvider = new RolloutProvider();
  lostProvider.responseLossAtPercentage = 100;
  const lost = await adapter(lostProvider, input, undefined, policy, () => "continue").apply({ promotionId: "promotion:lost", attempt: 1, release: input.release, target: input.target });
  assert.equal(lost.status, "failed");
  if (lost.status === "failed") {
    assert.equal(lost.outcome, "indeterminate");
    assert.match(lost.receipt, /rolloutStepsCompleted=1/);
  }
});
