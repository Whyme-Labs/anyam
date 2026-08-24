import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareWorkerStaticAssetUploader } from "../src/cloudflare/worker-assets.ts";
import { createTargetDeploymentProfile } from "../src/delivery/target-deployment.ts";
import { createWorkerTarget } from "../src/delivery/promotion.ts";
import { CONTRACT_VERSIONS, type Artifact } from "../src/kernel/contracts.ts";

test("Cloudflare static asset uploader uses the account token for the session and the returned JWT for content", async () => {
  const bytes = new TextEncoder().encode("<main>golden</main>\n");
  const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:asset", type: "worker.asset", digest: "sha256:asset", projectRevisionId: "project-revision:asset", outputPath: "dist/assets/index.html" };
  const target = createWorkerTarget({
    target: {
      protocol: CONTRACT_VERSIONS.target,
      id: "target:asset",
      projectId: "project:asset",
      name: "Asset Target",
      adapterId: "cloudflare.worker",
      acceptedArtifactTypes: ["worker.asset"],
      requiredEvidenceKeys: [],
      state: "configured",
      deploymentProfile: createTargetDeploymentProfile({ environment: "staging", channel: "beta", audience: "asset", runtimeIdentity: "worker:asset", routeIdentities: ["route:asset"], bindingIdentities: [], dataResourceIdentities: [], configurationDigests: ["sha256:asset-config"], secretUseAliases: [], dataClass: "isolated", resourceSharing: "isolated" }),
    },
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
  const requests: Array<{ path: string; token: string; body?: unknown }> = [];
  const transport = {
    async request<T>(request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; token: string; body?: BodyInit; headers?: Readonly<Record<string, string>> }) {
      requests.push({ path: request.path, token: request.token, ...(request.body instanceof FormData ? { body: request.body } : request.body !== undefined ? { body: String(request.body) } : {}) });
      if (request.path.endsWith("/assets-upload-session")) {
        const payload = JSON.parse(String(request.body)) as { manifest: Record<string, { hash: string }> };
        const hash = Object.values(payload.manifest)[0]?.hash;
        return { status: 200, ok: true, result: { jwt: "session-jwt", buckets: hash ? [[hash]] : [] } as T, errors: [], messages: [] };
      }
      if (request.path.endsWith("/assets/upload?base64=true")) return { status: 200, ok: true, result: { jwt: "completion-jwt" } as T, errors: [], messages: [] };
      return { status: 404, ok: false, errors: [{ code: 1000, message: "unexpected" }], messages: [] };
    },
  };
  const uploader = createCloudflareWorkerStaticAssetUploader({
    accountId: "account:asset",
    scriptName: "worker-asset",
    transport,
    credentialBroker: {
      async issue(input) {
        assert.equal(input.targetId, target.id);
        return { token: "account-token", credentialId: "credential:asset", expiresAt: "2099-01-01T00:00:00.000Z", audience: input.audience, scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; credentialMaterialStored=false" };
      },
      async probe() { return { credentialId: "credential:asset", expiresAt: "2099-01-01T00:00:00.000Z", scopes: ["workers:read", "workers:write"], providerAuthorization: "observed" as const, receipt: "credential=fixture; credentialMaterialStored=false" }; },
    },
  });
  const result = await uploader({
    manifest: { protocol: "anyam.worker-release-manifest/v1", mainModule: "dist/index.js", applicationArtifactDigest: "sha256:application", modules: [{ name: "dist/index.js", type: "es-module", digest: "sha256:module" }], staticAssets: { manifestDigest: "sha256:asset-manifest", namespaceDigest: "sha256:asset-namespace", artifactDigests: [artifact.digest] }, compatibility: { date: "2026-01-01", flags: [] }, bindings: [], healthContract: { paths: ["/health"], expectedReleaseIdentity: "release:asset" }, digest: "sha256:manifest" },
    artifacts: [artifact],
    readArtifact: async () => bytes,
    operation: "preview",
    target,
  });
  assert.equal(result.jwt, "completion-jwt");
  assert.match(result.receipt, /assets=1/);
  assert.equal(result.receipt.includes("account-token"), false);
  assert.equal(requests[0]?.token, "account-token");
  assert.equal(requests[1]?.token, "session-jwt");
  assert.equal(requests[1]?.body instanceof FormData, true);
  const uploadForm = requests[1]?.body;
  assert.equal(uploadForm instanceof FormData, true);
  if (!(uploadForm instanceof FormData)) throw new Error("asset upload did not use multipart form data");
  const firstKey = uploadForm.keys().next();
  assert.equal(firstKey.done, false);
  if (firstKey.done) throw new Error("asset upload form was empty");
  const uploaded = uploadForm.get(firstKey.value);
  assert.equal(uploaded instanceof File, true);
  if (!(uploaded instanceof File)) throw new Error("asset upload part is not a File");
  assert.equal(uploaded.name.length, 32);
  assert.equal(uploaded.type, "text/html; charset=utf-8");
  assert.equal(await uploaded.text(), btoa(String.fromCharCode(...bytes)));
});
