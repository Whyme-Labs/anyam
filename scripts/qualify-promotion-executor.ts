import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { createPromotionExecutionContext } from "../src/cloudflare/promotion-execution.ts";
import { createPromotionExecutorHandler } from "../src/cloudflare/promotion-executor.ts";
import { CONTRACT_VERSIONS, type Artifact, type Release } from "../src/kernel/contracts.ts";

const protocol = "anyam.promotion-executor-qualification/v1" as const;
const session = {
  realmId: "realm:promotion-executor-qualification",
  principalId: "principal:qualification",
  actorId: "actor:qualification",
  sessionId: "session:qualification",
  clientId: "client:qualification",
  authorizationEpoch: 1,
};

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fixture(): { context: ReturnType<typeof createPromotionExecutionContext>; bytes: Uint8Array } {
  const snapshot = emptyAuthorityPlaneSnapshot(session.realmId);
  snapshot.version = 1;
  snapshot.projects["project:promotion-executor-qualification"] = { protocol: CONTRACT_VERSIONS.project, id: "project:promotion-executor-qualification", name: "Promotion executor qualification", referenceType: "git", sourceSpaceIds: ["source:promotion-executor-qualification"] };
  snapshot.sourceSpaces["source:promotion-executor-qualification"] = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:promotion-executor-qualification", name: "qualification", classification: "public" };
  snapshot.projectRevisions["project-revision:promotion-executor-qualification"] = { protocol: CONTRACT_VERSIONS.kernel, id: "project-revision:promotion-executor-qualification", projectId: "project:promotion-executor-qualification", sourceSpaceSnapshots: { "source:promotion-executor-qualification": "git:promotion-executor-qualification" } };
  snapshot.canonicalByProject["project:promotion-executor-qualification"] = "project-revision:promotion-executor-qualification";
  const bytes = new TextEncoder().encode("export default { fetch() { return new Response(JSON.stringify({ status: 'healthy', releaseId: 'release:promotion-executor-qualification' }), { headers: { 'content-type': 'application/json' } }); } };\n");
  const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:promotion-executor-qualification", type: "worker.bundle", digest: digest(bytes), projectRevisionId: "project-revision:promotion-executor-qualification", outputPath: "worker.js" };
  snapshot.artifacts[artifact.id] = artifact;
  const release: Release = { protocol: CONTRACT_VERSIONS.release, id: "release:promotion-executor-qualification", projectRevisionId: artifact.projectRevisionId, artifactIds: [artifact.id], evidenceIds: [], configurationDigests: ["sha256:promotion-executor-qualification"], stateAssumptions: ["disposable boundary; no customer data"], policyVersion: "policy:promotion-executor-qualification:v1", status: "ready" };
  snapshot.releases[release.id] = release;
  snapshot.targets["target:promotion-executor-qualification"] = { protocol: CONTRACT_VERSIONS.target, id: "target:promotion-executor-qualification", projectId: "project:promotion-executor-qualification", name: "Promotion executor qualification target", adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle"], requiredEvidenceKeys: [], state: "configured", currentReleaseId: null, releaseHistory: [] };
  snapshot.promotions["promotion:promotion-executor-qualification"] = { protocol: CONTRACT_VERSIONS.promotion, id: "promotion:promotion-executor-qualification", projectId: "project:promotion-executor-qualification", targetId: "target:promotion-executor-qualification", releaseId: release.id, releaseDigest: "declared:promotion-executor-qualification", previousReleaseId: null, expectedCurrentReleaseId: null, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: "request:promotion-executor-qualification", actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId }, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", receipt: "promotion=blocked" };
  return { context: createPromotionExecutionContext({ snapshot, promotionId: "promotion:promotion-executor-qualification", executionIdempotencyKey: "execute:promotion-executor-qualification", session }), bytes };
}

function fakeFetch(releaseId: string): typeof fetch {
  const versions: Array<{ id: string; tag: string }> = [];
  let sequence = 0;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/versions") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ result: { items: versions.map((version) => ({ id: version.id, metadata: { annotations: { "workers/tag": version.tag } } })) }, errors: [], messages: [] }), { status: 200 });
      if (url.pathname.endsWith("/versions") && init?.method === "POST") {
        const form = init.body as FormData;
        const metadata = JSON.parse(String(form.get("metadata"))) as { annotations: { "workers/tag": string } };
        const version = { id: `qualification-version-${++sequence}`, tag: metadata.annotations["workers/tag"] };
        versions.push(version);
        return new Response(JSON.stringify({ result: { id: version.id }, errors: [], messages: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/deployments") && init?.method === "POST") return new Response(JSON.stringify({ result: { id: `qualification-deployment-${++sequence}`, versions: [] }, errors: [], messages: [] }), { status: 200 });
    }
    if (url.pathname.endsWith("/health") || url.searchParams.get("anyam_preview") === "1") return new Response(JSON.stringify({ status: "healthy", releaseId }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`unexpected qualification request ${url.href}`);
  };
}

function containsCredentialMaterial(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return /(?:cfat_|bearer\s+|access[_-]?token|secret|password)/iu.test(value);
  if (Array.isArray(value)) return value.some(containsCredentialMaterial);
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).some(([key, entry]) => /(?:token|secret|password|credential|api[_-]?key)/iu.test(key) || containsCredentialMaterial(entry));
  return false;
}

async function remoteQualification(): Promise<Record<string, unknown> | undefined> {
  const url = process.env.ANYAM_PROMOTION_EXECUTOR_URL?.trim();
  const contextPath = process.env.ANYAM_PROMOTION_EXECUTOR_CONTEXT_FILE?.trim();
  if (!url && !contextPath) return undefined;
  if (!url || !contextPath) throw new Error("ANYAM_PROMOTION_EXECUTOR_URL and ANYAM_PROMOTION_EXECUTOR_CONTEXT_FILE must be set together for remote qualification");
  const context = JSON.parse(await readFile(contextPath, "utf8")) as unknown;
  if (containsCredentialMaterial(context)) throw new Error("remote qualification context contains credential-shaped material; refusing to send it");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1" }, body: JSON.stringify(context) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { mode: "remote", httpStatus: response.status, status: body.status ?? "unknown", receipt: body.receipt ?? "not-provided", credentialValues: "not-printed", contextFile: contextPath, providerDeployment: "customer-operated" };
}

async function localQualification(): Promise<Record<string, unknown>> {
  const { context, bytes } = fixture();
  const handler = createPromotionExecutorHandler({
    accountId: "account:promotion-executor-qualification",
    scriptName: "worker-promotion-executor-qualification",
    targetId: "target:promotion-executor-qualification",
    previewSubdomain: "qualification",
    providerToken: "qualification-token-kept-inside-executor",
    providerCredentialExpiresAt: "2099-01-01T00:00:00.000Z",
    fetch: fakeFetch(context.release.id),
    artifactStore: { async get(key) { return key === `artifacts/${context.artifacts[0]?.digest}` ? { arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer } : null; } },
  });
  const response = await handler(new Request("https://promotion-executor.example/execute", { method: "POST", headers: { "content-type": "application/json", "x-anyam-promotion-protocol": "anyam.promotion-execution/v1" }, body: JSON.stringify(context) }));
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || result.status !== "succeeded") throw new Error(`local executor qualification failed: HTTP ${response.status}; status=${String(result.status)}; receipt=${String(result.receipt)}`);
  return { mode: "local-boundary", status: "succeeded", resultStatus: result.status, targetCurrentReleaseId: (result.target as Record<string, unknown>)?.currentReleaseId, credentialValues: "not-printed", providerDeployment: "fixture-only", receipt: "executor=customer-operated-boundary; adapter=cloudflare.worker; artifactStore=digest-addressed; credentials=brokered-only; canonicalWrite=false; liveProvider=not-performed" };
}

try {
  const result = await remoteQualification() ?? await localQualification();
  console.log(JSON.stringify({ protocol, ...result, providerFactsAreNotAnyamLimits: true }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", recoveryAction: "repair the named executor boundary or context and rerun the same bounded qualification", receipt: "providerInvocation=not-established; canonicalWrite=false" }, null, 2));
  process.exitCode = 2;
}
