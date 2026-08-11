import { createHash } from "node:crypto";

import {
  CloudflareWorkerTargetAdapter,
  createCloudflareWorkerRestTransport,
  createMapWorkerArtifactReader,
  type CloudflareWorkerApiResponse,
  type CloudflareWorkerCredential,
} from "../src/cloudflare/worker-target.ts";
import {
  CONTRACT_VERSIONS,
  type Artifact,
  type Release,
} from "../src/kernel/contracts.ts";
import {
  createWorkerTarget,
  sealVerifiedRelease,
  WorkerPromotionCoordinator,
  type ImmutableRelease,
} from "../src/delivery/promotion.ts";

const protocol = "anyam.cloudflare-worker-target-qualification/v1" as const;
const projectId = "project:cloudflare-worker-target-qualification";
const qualificationPrefix = "anyam-worker-target-qualification-";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer; received ${raw}`);
  return value;
}

function nonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number; received ${raw}`);
  return value;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function responseErrors<T>(response: CloudflareWorkerApiResponse<T>): string {
  return [...response.errors, ...response.messages].map((error) => `${error.code ?? "unknown"}:${error.message}`).join(" | ") || `http-${response.status}`;
}

function workerModule(failing: boolean): Uint8Array {
  const source = `export default { fetch(request) { const preview = new URL(request.url).searchParams.get("anyam_preview") === "1"; const failing = ${failing ? "true" : "false"}; const status = failing && !preview ? 503 : 200; return new Response(JSON.stringify({ status: status === 200 ? "healthy" : "unhealthy" }), { status, headers: { "content-type": "application/json" } }); } };\n`;
  return new TextEncoder().encode(source);
}

function workerModuleUpload(bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js" })], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([Buffer.from(bytes)], { type: "application/javascript+module" }), "worker.js");
  return form;
}

function release(input: { id: string; fileName: string; bytes: Uint8Array }): { immutable: ImmutableRelease; artifact: Artifact } {
  const artifact: Artifact = {
    protocol: CONTRACT_VERSIONS.artifact,
    id: `artifact:${input.id}`,
    type: "worker.bundle",
    digest: digest(input.bytes),
    projectRevisionId: `${projectId}:revision`,
    outputPath: input.fileName,
  };
  const base: Release = {
    protocol: CONTRACT_VERSIONS.release,
    id: `release:${input.id}`,
    projectRevisionId: artifact.projectRevisionId,
    artifactIds: [artifact.id],
    evidenceIds: [],
    configurationDigests: ["sha256:cloudflare-worker-target-qualification-config"],
    stateAssumptions: ["disposable Worker; no customer data; cleanup is required"],
    policyVersion: "policy:cloudflare-worker-target-qualification:v1",
    status: "ready",
    name: input.id,
  };
  const target = createWorkerTarget({
    target: {
      protocol: CONTRACT_VERSIONS.target,
      id: "target:cloudflare-worker-target-qualification",
      projectId,
      name: "Disposable Cloudflare Worker Target qualification",
      adapterId: "cloudflare.worker",
      acceptedArtifactTypes: ["worker.bundle"],
      requiredEvidenceKeys: [],
      state: "configured",
    },
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
  return { artifact, immutable: sealVerifiedRelease({ projectId, release: base, artifacts: [artifact], evidence: [], target }) };
}

/** Build a broker without putting the token into any Anyam state or receipt. */
function qualificationBroker(token: string): { issue(input: { accountId: string; scriptName: string; operation: "preview" | "apply" | "health" | "rollback" | "version-read"; audience: CloudflareWorkerCredential["audience"] }): Promise<CloudflareWorkerCredential> } {
  return {
    async issue(input) {
      return {
        token,
        credentialId: `credential:qualification:${input.operation}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        audience: input.audience,
        receipt: `credential=brokered; operation=${input.operation}; token=redacted; credentialMaterialStored=false`,
      };
    },
  };
}

async function run(): Promise<Record<string, unknown>> {
  const accountId = required("ANYAM_WORKER_TARGET_ACCOUNT_ID");
  const token = required("ANYAM_WORKER_TARGET_API_TOKEN");
  const scriptName = required("ANYAM_WORKER_TARGET_SCRIPT_NAME");
  const previewSubdomain = required("ANYAM_WORKER_TARGET_PREVIEW_SUBDOMAIN");
  if (!scriptName.startsWith(qualificationPrefix)) throw new Error(`ANYAM_WORKER_TARGET_SCRIPT_NAME must start with ${qualificationPrefix} so cleanup cannot target an existing Worker`);
  const healthUrl = process.env.ANYAM_WORKER_TARGET_HEALTH_URL?.trim() || `https://${scriptName}.${previewSubdomain}.workers.dev/health`;
  // Cloudflare can briefly return 404 for the workers.dev route immediately
  // after a successful deployment. These are qualification-only defaults, not
  // Anyam production limits; retain the receipt so they can be remeasured.
  const routeReadinessRetry = {
    maxAttempts: positiveInteger("ANYAM_WORKER_TARGET_HEALTH_RETRY_ATTEMPTS", 10),
    delayMs: nonNegativeNumber("ANYAM_WORKER_TARGET_HEALTH_RETRY_DELAY_MS", 1000),
    retryStatuses: [404] as const,
  };
  const rollbackRouteReadinessRetry = {
    ...routeReadinessRetry,
    retryStatuses: [404, 503] as const,
  };
  const transport = createCloudflareWorkerRestTransport({});
  const healthyBytes = workerModule(false);
  const failingBytes = workerModule(true);
  const seeded = await transport.request<unknown>({
    method: "PUT",
    path: `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`,
    token,
    // The direct script-upload endpoint needs multipart metadata to distinguish
    // an ES module from service-worker syntax. The provider otherwise parses
    // the raw body as a service worker and rejects the `export` declaration.
    body: workerModuleUpload(healthyBytes),
  });
  if (!seeded.ok) throw new Error(`seed Worker upload returned HTTP ${seeded.status}: ${responseErrors(seeded)}`);
  const subdomain = await transport.request<{ enabled: boolean; previews_enabled: boolean }>({
    method: "POST",
    path: `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: true }),
  });
  if (!subdomain.ok || !subdomain.result?.enabled || !subdomain.result.previews_enabled) {
    throw new Error(`Worker subdomain preview enablement failed: HTTP ${subdomain.status}: ${responseErrors(subdomain)}`);
  }

  const first = release({ id: "healthy", fileName: "healthy.js", bytes: healthyBytes });
  const second = release({ id: "failing", fileName: "failing.js", bytes: failingBytes });
  const contents = new Map<string, Uint8Array>([[first.artifact.digest, healthyBytes], [second.artifact.digest, failingBytes]]);
  const adapter = new CloudflareWorkerTargetAdapter({
    accountId,
    scriptName,
    transport,
    credentialBroker: qualificationBroker(token),
    artifactReader: createMapWorkerArtifactReader(contents),
    previewUrlForVersion: (versionId) => `https://${versionId.slice(0, 8)}-${scriptName}.${previewSubdomain}.workers.dev/?anyam_preview=1`,
    healthUrl,
    routeReadinessRetry,
    rollbackRouteReadinessRetry,
  });
  const target = createWorkerTarget({
    target: {
      protocol: CONTRACT_VERSIONS.target,
      id: "target:cloudflare-worker-target-qualification",
      projectId,
      name: "Disposable Cloudflare Worker Target qualification",
      adapterId: "cloudflare.worker",
      acceptedArtifactTypes: ["worker.bundle"],
      requiredEvidenceKeys: [],
      state: "configured",
    },
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
  const coordinator = new WorkerPromotionCoordinator({ projectId, target, adapter });
  coordinator.registerRelease(first.immutable);
  coordinator.registerRelease(second.immutable);
  const healthyPromotion = await coordinator.promote({ releaseId: first.immutable.release.id, idempotencyKey: "qualification:healthy", actor: { principalId: "principal:qualification", actorId: "actor:qualification", sessionId: "session:qualification", clientId: "client:qualification" } });
  if (healthyPromotion.state !== "healthy") throw new Error(`healthy promotion did not reach healthy state: ${healthyPromotion.state}; receipt=${healthyPromotion.receipt}; recoveryAction=${healthyPromotion.recoveryAction}`);
  const failingPromotion = await coordinator.promote({ releaseId: second.immutable.release.id, idempotencyKey: "qualification:failing", actor: { principalId: "principal:qualification", actorId: "actor:qualification", sessionId: "session:qualification", clientId: "client:qualification" } });
  if (failingPromotion.state !== "rolled-back" || failingPromotion.health?.state !== "unhealthy" || failingPromotion.rollbackHealth?.state !== "healthy") {
    throw new Error(`failed health did not preserve the known-good Release: state=${failingPromotion.state}; health=${failingPromotion.health?.state}; rollbackHealth=${failingPromotion.rollbackHealth?.state}; receipt=${failingPromotion.receipt}; recoveryAction=${failingPromotion.recoveryAction ?? "not-provided"}`);
  }
  return { protocol, status: "succeeded", scriptName, accountId, healthyPromotion: { state: healthyPromotion.state, releaseDigest: healthyPromotion.releaseDigest }, failingPromotion: { state: failingPromotion.state, health: failingPromotion.health?.state, rollbackHealth: failingPromotion.rollbackHealth?.state }, targetReleaseId: coordinator.getTarget().currentReleaseId, routeReadiness: { candidate: { retryStatuses: routeReadinessRetry.retryStatuses, maxAttempts: routeReadinessRetry.maxAttempts, delayMs: routeReadinessRetry.delayMs }, rollback: { retryStatuses: rollbackRouteReadinessRetry.retryStatuses, maxAttempts: rollbackRouteReadinessRetry.maxAttempts, delayMs: rollbackRouteReadinessRetry.delayMs }, receipt: "qualification-tripwire; preview-and-production-route-readiness; rollback-503-is-transient-only-after-known-good-release; remeasure-before-production" }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true };
}

async function cleanup(): Promise<{ status: "succeeded" | "blocked"; receipt: string }> {
  const accountId = process.env.ANYAM_WORKER_TARGET_ACCOUNT_ID?.trim();
  const token = process.env.ANYAM_WORKER_TARGET_API_TOKEN?.trim();
  const scriptName = process.env.ANYAM_WORKER_TARGET_SCRIPT_NAME?.trim();
  if (!accountId || !token || !scriptName || !scriptName.startsWith(qualificationPrefix)) return { status: "blocked", receipt: "cleanup=not-attempted; recovery=set the same disposable qualification inputs before deleting anything" };
  const transport = createCloudflareWorkerRestTransport({});
  const response = await transport.request<unknown>({ method: "DELETE", path: `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}`, token });
  return response.ok ? { status: "succeeded", receipt: `cleanup=worker-deleted; scriptName=${scriptName}; credentialMaterialStored=false` } : { status: "blocked", receipt: `cleanup=blocked; scriptName=${scriptName}; httpStatus=${response.status}; error=${responseErrors(response)}; credentialMaterialStored=false` };
}

let result: Record<string, unknown> | undefined;
let runError: string | undefined;
try {
  result = await run();
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
}
const cleanupResult = await cleanup().catch((error) => ({ status: "blocked" as const, receipt: `cleanup=blocked; error=${error instanceof Error ? error.message : String(error)}; credentialMaterialStored=false` }));
if (runError || cleanupResult.status !== "succeeded") {
  console.log(JSON.stringify({ protocol, status: "blocked", ...(runError ? { error: runError } : {}), ...(result ?? {}), cleanup: cleanupResult, credentialValues: "not-printed", recoveryAction: "inspect the provider receipt and reconcile the named disposable Worker before retrying the same qualification" }, null, 2));
  process.exitCode = 2;
} else {
  console.log(JSON.stringify({ ...(result ?? { protocol }), cleanup: cleanupResult }, null, 2));
}
