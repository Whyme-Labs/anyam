import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  CloudflareWorkerTargetAdapter,
  createCloudflareWorkerRestTransport,
  createMapWorkerArtifactReader,
  type CloudflareWorkerApiRequest,
  type CloudflareWorkerApiTransport,
  type CloudflareWorkerRolloutPolicy,
} from "../src/cloudflare/worker-target.ts";
import { createCloudflareApiTokenCredentialBroker } from "../src/cloudflare/promotion-credential-broker.ts";
import { createCloudflareWorkerReleaseManifest, workerReleaseManifestUploadMetadata, workerReleaseModuleContentType } from "../src/cloudflare/worker-release-manifest.ts";
import { createCloudflareWorkerStaticAssetUploader } from "../src/cloudflare/worker-assets.ts";
import { createMigrationPlan } from "../src/delivery/migration-plan.ts";
import { createWorkerTarget, sealVerifiedRelease, WorkerPromotionCoordinator, type ImmutableRelease } from "../src/delivery/promotion.ts";
import { normalizeProjectManifest, runLocalRelease, type LocalExecutionContext } from "../src/execution/local.ts";
import { CONTRACT_VERSIONS, createProject, createProjectRevision, type SourceSpace } from "../src/kernel/contracts.ts";
import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";
import { LocalProjectExporter, verifyProjectExportPackage } from "../src/portability/project-export.ts";
import {
  applyD1Migration,
  d1DatabaseId,
  healthValidator,
  migrationEvidence,
  parseConfig,
  providerError,
  rolloutObserver,
  targetIdentityLedger,
  targetInput,
  targetRecord,
  targetOrder,
  cloudflareRequest,
  workerManifest,
  type GoldenConfig,
  type GoldenTargetInput,
} from "./qualify-cloudflare-golden-path.ts";

const protocol = "anyam.cloudflare-golden-recovery-qualification/v1" as const;
const fixtureRoot = fileURLToPath(new URL("../fixtures/worker-golden/", import.meta.url));
const buildEvidenceKey = "action:action:golden-build:verifier:verifier:golden-build";
const migrationEvidenceKey = "golden:d1-migration";
type JsonObject = Record<string, unknown>;

type GoldenRecoveryBundle = {
  protocol: "anyam.golden-recovery-bundle/v1";
  projectExportDirectory: string;
  projectExportDigest: string;
  projectId: string;
  releaseId: string;
  artifactDigests: readonly string[];
  sourceSpaceId: string;
  receipt: string;
};

let activeConfig: GoldenConfig | undefined;
let activeToken: string | undefined;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

function bytesDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function redacted(value: string): string {
  return value.replace(/(?:cfat_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._~-]{8,})/giu, "[redacted]");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function providerFields(config: GoldenConfig): Set<string> {
  const values = new Set<string>();
  for (const target of config.targets) {
    values.add(target.scriptName);
    values.add(target.healthUrl);
    for (const binding of target.bindings) for (const value of Object.values(binding.providerFields ?? {})) values.add(value);
  }
  return values;
}

async function readToken(): Promise<string> {
  const tokenFile = process.env.ANYAM_GOLDEN_API_TOKEN_FILE?.trim();
  const token = process.env.ANYAM_GOLDEN_API_TOKEN?.trim() || (tokenFile ? (await stat(tokenFile), (await readFile(tokenFile, "utf8")).trim()) : "");
  if (!token) throw new Error("ANYAM_GOLDEN_API_TOKEN or owner-only ANYAM_GOLDEN_API_TOKEN_FILE is required");
  if (tokenFile && ((await stat(tokenFile)).mode & 0o077) !== 0) throw new Error("ANYAM_GOLDEN_API_TOKEN_FILE must be owner-only (mode 0600)");
  return token;
}

function recoveryTransport(base: CloudflareWorkerApiTransport, shouldInjectResponseLoss: boolean): { transport: CloudflareWorkerApiTransport; injected: () => boolean } {
  let injected = false;
  return {
    transport: {
      async request<T>(request: CloudflareWorkerApiRequest) {
        const response = await base.request<T>(request);
        if (shouldInjectResponseLoss && !injected && request.method === "POST" && request.path.endsWith("/versions")) {
          injected = true;
          throw new Error("qualification injected response loss after provider accepted Worker Version upload");
        }
        return response;
      },
    },
    injected: () => injected,
  };
}

function seedModule(): Uint8Array {
  return new TextEncoder().encode("export default { fetch() { return new Response('anyam-golden-recovery-seed'); } };\n");
}

function seedModuleUpload(mainModule: string, bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: mainModule })], { type: "application/json" }), "metadata.json");
  form.append(mainModule, new Blob([Buffer.from(bytes)], { type: "application/javascript+module" }), mainModule);
  return form;
}

async function seedWorker(token: string, config: GoldenConfig, target: GoldenTargetInput): Promise<void> {
  try {
    const versions = await cloudflareRequest<{ items?: readonly unknown[] }>(token, `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(target.scriptName)}/versions?per_page=1`);
    if ((versions.items ?? []).length > 0) throw new Error(`recovery Worker ${target.scriptName} already has a provider version`);
  } catch (error) {
    if (!(error instanceof Error && /HTTP 404\b/u.test(error.message))) throw error;
  }
  await cloudflareRequest<unknown>(token, `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(target.scriptName)}`, { method: "PUT", body: seedModuleUpload("worker.js", seedModule()) });
  await cloudflareRequest<unknown>(token, `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(target.scriptName)}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: true }) });
}

async function deleteWorker(token: string, accountId: string, target: GoldenTargetInput): Promise<string> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(target.scriptName)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return `worker=${target.scriptName}; deleted=already-absent`;
  if (!response.ok) throw new Error(`cleanup Worker ${target.scriptName} returned HTTP ${response.status}`);
  return `worker=${target.scriptName}; deleted=true`;
}

async function cleanup(): Promise<Record<string, unknown>> {
  if (!activeConfig || !activeToken) return { status: "not-attempted", receipt: "cleanup=not-attempted" };
  const resources: string[] = [];
  for (const target of activeConfig.targets) resources.push(await deleteWorker(activeToken, activeConfig.accountId, target));
  return { status: "succeeded", resources };
}

async function createMigrationDeployer(input: {
  config: GoldenConfig;
  target: GoldenTargetInput;
  token: string;
  transport: CloudflareWorkerApiTransport;
  broker: ReturnType<typeof createCloudflareApiTokenCredentialBroker>;
}): Promise<NonNullable<ConstructorParameters<typeof CloudflareWorkerTargetAdapter>[0]["durableObjectMigrationDeployer"]>> {
  return async ({ manifest, release, target, operation, readArtifact }) => {
    const migration = manifest.durableObjectMigrations;
    if (!migration) throw new Error("migration preflight was called without Durable Object migration metadata");
    const credential = await input.broker.issue({ accountId: input.config.accountId, scriptName: input.target.scriptName, targetId: target.id, operation: "version-upload", audience: "aud:anyam:deployment" });
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(workerReleaseManifestUploadMetadata(manifest, release.release.id, `migration-${migration.toTag}`, undefined, { includeStaticAssets: false }))], { type: "application/json" }), "metadata.json");
    const artifactsByDigest = new Map(release.artifacts.map((artifact) => [artifact.digest, artifact]));
    for (const module of manifest.modules) {
      const artifact = artifactsByDigest.get(module.digest);
      if (!artifact) throw new Error(`migration preflight is missing module Artifact ${module.digest}`);
      form.append(module.name, new Blob([Buffer.from(await readArtifact(artifact))], { type: workerReleaseModuleContentType(module.type) }), module.name);
    }
    const upload = await input.transport.request<{ id?: string }>({ method: "PUT", path: `/accounts/${encodeURIComponent(input.config.accountId)}/workers/scripts/${encodeURIComponent(input.target.scriptName)}`, token: credential.token, body: form });
    if (!upload.ok) throw new Error(`migration deployment returned HTTP ${upload.status}: ${providerError(upload)}`);
    const versions = await input.transport.request<{ items?: readonly { id?: string }[] }>({ method: "GET", path: `/accounts/${encodeURIComponent(input.config.accountId)}/workers/scripts/${encodeURIComponent(input.target.scriptName)}/versions?per_page=1`, token: credential.token });
    if (!versions.ok) throw new Error(`migration deployment version list returned HTTP ${versions.status}: ${providerError(versions)}`);
    const versionId = versions.result?.items?.[0]?.id;
    if (!versionId) throw new Error("migration deployment did not return a latest provider version identity");
    const detail = await input.transport.request<{ resources?: { script_runtime?: { migration_tag?: string } } }>({ method: "GET", path: `/accounts/${encodeURIComponent(input.config.accountId)}/workers/scripts/${encodeURIComponent(input.target.scriptName)}/versions/${encodeURIComponent(versionId)}`, token: credential.token });
    if (!detail.ok) throw new Error(`migration deployment read-back returned HTTP ${detail.status}: ${providerError(detail)}`);
    const migrationTag = detail.result?.resources?.script_runtime?.migration_tag;
    if (migrationTag !== migration.toTag) throw new Error(`migration deployment read-back returned tag ${migrationTag ?? "missing"}, expected ${migration.toTag}`);
    return { migrationTag, receipt: `provider=cloudflare-workers; operation=durable-object-migration; target=${target.id}; providerVersionId=${versionId}; migrationTag=${migrationTag}; releaseDigest=${release.releaseDigest}; operationPhase=${operation}; credentialMaterialStored=false` };
  };
}

async function run(): Promise<Record<string, unknown>> {
  const configPath = process.env.ANYAM_GOLDEN_CONFIG_FILE?.trim();
  if (!configPath) throw new Error("ANYAM_GOLDEN_CONFIG_FILE must name the fresh recovery configuration");
  const token = await readToken();
  const config = await parseConfig(configPath);
  activeConfig = config;
  activeToken = token;
  const originalConfigPath = process.env.ANYAM_GOLDEN_ORIGINAL_CONFIG_FILE?.trim();
  if (originalConfigPath) {
    const originalConfig = await parseConfig(originalConfigPath);
    const overlap = [...providerFields(config)].filter((value) => providerFields(originalConfig).has(value) && value !== "GoldenObject");
    if (overlap.length > 0) throw new Error(`recovery configuration overlaps original provider identities: ${overlap.join(",")}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "anyam-golden-recovery-"));
  const exportDirectory = resolve(process.env.ANYAM_GOLDEN_RECOVERY_EXPORT_DIRECTORY?.trim() || join(tmpdir(), `anyam-golden-recovery-export-${Date.now()}`));
  try {
    await cp(fixtureRoot, temporary, { recursive: true });
    const rawManifest = JSON.parse(await readFile(join(temporary, "anyam.json"), "utf8")) as unknown;
    const normalized = normalizeProjectManifest(rawManifest);
    const staging = targetInput(config.targets, "staging");
    const localContext: LocalExecutionContext = {
      directory: temporary,
      projectRevisionId: "project-revision:worker-golden:recovery",
      projectViewId: "project-view:worker-golden:recovery",
      sourceSpaceSnapshots: { "worker-golden-source": "snapshot:worker-golden:recovery" },
      actor: { principalId: "principal:golden-recovery", actorId: "actor:golden-recovery", sessionId: "session:golden-recovery", clientId: "client:golden-recovery" },
      runnerId: "runner:golden-recovery",
      policyVersion: "policy:worker-golden:recovery",
      authorizationEpoch: "1",
      capabilityGrantId: "grant:worker-golden:recovery",
      dependencyDigest: "sha256:worker-golden-dependencies:v1",
      toolchainDigest: "sha256:worker-golden-toolchain:v1",
      environmentDigest: "sha256:worker-golden-environment:v1",
      disclosure: { projectionId: "project-view:worker-golden:recovery", classification: "project" },
      owner: "Anyam Cloudflare golden recovery qualification",
      changeRevisionId: "change-revision:worker-golden:recovery",
      workspaceId: "workspace:worker-golden:recovery",
      targetId: staging.id,
      declaredEffects: ["artifact.create", "migration.apply", "target.promote", "project.export", "project.restore"],
    };
    const local = await runLocalRelease({ manifest: rawManifest, context: localContext, releaseName: "golden-recovery", stateAssumptions: ["disposable Cloudflare recovery resources; no customer data; owner-run cleanup"] });
    if (local.release.status !== "ready" || local.evidence.some((evidence) => evidence.outcome !== "passed")) throw new Error(`recovery build did not produce a ready Release: status=${local.release.status}; evidence=${local.evidence.map((evidence) => `${evidence.key}:${evidence.outcome}`).join(",")}`);
    const artifactsByDigest = new Map<string, Uint8Array>();
    for (const artifact of local.artifacts) {
      const outputPath = requiredString(artifact.outputPath, `artifact ${artifact.id}.outputPath`);
      const bytes = new Uint8Array(await readFile(resolve(temporary, outputPath)));
      if (bytesDigest(bytes) !== artifact.digest) throw new Error(`recovery Artifact ${artifact.id} digest changed after build`);
      artifactsByDigest.set(artifact.digest, bytes);
    }
    const migrationArtifact = local.artifacts.find((artifact) => artifact.type === "d1.migration");
    const assetArtifact = local.artifacts.find((artifact) => artifact.type === "worker.asset");
    if (!migrationArtifact || !assetArtifact) throw new Error("recovery build did not produce required migration and asset Artifacts");
    for (const target of config.targets) await seedWorker(token, config, target);
    const migrationSql = new TextDecoder().decode(artifactsByDigest.get(migrationArtifact.digest));
    const migrationResults = [];
    for (const target of config.targets) migrationResults.push(await applyD1Migration({ token, accountId: config.accountId, databaseId: d1DatabaseId(target), targetId: target.id, sql: migrationSql }));
    const migrationRecord = migrationEvidence(local.evidence[0]!, migrationResults.map(({ targetId, outputDigest }) => ({ targetId, outputDigest })), migrationArtifact.digest);
    const migrationPlan = createMigrationPlan({ strategy: "expand-contract", beforeSchemaDigest: config.migration.beforeSchemaDigest, afterSchemaDigest: config.migration.afterSchemaDigest, compatibility: config.migration.compatibility, rollback: config.migration.rollback, migrationArtifactIds: [migrationArtifact.id], requiredEvidenceKeys: [migrationEvidenceKey] });
    const release = { ...local.release, evidenceIds: [...local.release.evidenceIds, migrationRecord.id], migrationPlan };
    const evidence = [...local.evidence, migrationRecord];
    const sourceSpaceId = normalized.sourceSpaceIds[0];
    if (!sourceSpaceId) throw new Error("recovery Project Manifest has no Source Space");
    const project = createProject({ id: normalized.projectId, name: normalized.name, referenceType: normalized.referenceType, sourceSpaceIds: [sourceSpaceId] });
    const sourceSpace: SourceSpace = { protocol: CONTRACT_VERSIONS.sourceSpace, id: sourceSpaceId, name: "Golden recovery source", classification: "public" };
    const repositoryDriver = new LocalGitRepositoryDriver(join(temporary, "export-driver"));
    const repository = await repositoryDriver.createRepository({ sourceSpaceId, directory: temporary, idempotencyKey: "golden-recovery:source-repository" });
    if (repository.status !== "succeeded") throw new Error(repository.message);
    const committed = await repositoryDriver.commitRepository({ repository: repository.value, message: "Golden recovery source snapshot", idempotencyKey: "golden-recovery:source-commit" });
    if (committed.status !== "succeeded") throw new Error(committed.message);
    const projectRevision = createProjectRevision({ projectId: project.id, sourceSpaceSnapshots: localContext.sourceSpaceSnapshots, id: "project-revision:worker-golden:recovery-export" });
    const exporter = new LocalProjectExporter(repositoryDriver);
    const artifactFiles = local.artifacts.map((artifact) => {
      const bytes = artifactsByDigest.get(artifact.digest);
      if (!bytes) throw new Error(`recovery export is missing bytes for Artifact ${artifact.id}`);
      return { artifactId: artifact.id, bytes };
    });
    const exported = await exporter.exportProject({ project, sourceSpaces: [sourceSpace], repositories: [{ sourceSpaceId, repository: repository.value }], projectRevisions: [projectRevision], evidence, artifacts: local.artifacts, artifactFiles, releases: [release], targets: config.targets.map((target) => targetRecord(config, target, normalized.projectId)), destination: exportDirectory, idempotencyKey: "golden-recovery:project-export" });
    if (exported.status !== "succeeded") throw new Error(exported.message);
    const verifiedExport = await verifyProjectExportPackage(exported.value.directory);
    if (verifiedExport.status !== "succeeded") throw new Error(verifiedExport.message);
    const restoredDestination = join(temporary, "restored-project");
    const restored = await new LocalProjectExporter(new LocalGitRepositoryDriver(join(temporary, "restore-driver"))).importProject({ packageDirectory: exported.value.directory, destination: restoredDestination, idempotencyKey: "golden-recovery:project-import" });
    if (restored.status !== "succeeded") throw new Error(restored.message);
    const replay = await new LocalProjectExporter(new LocalGitRepositoryDriver(join(temporary, "restore-replay-driver"))).importProject({ packageDirectory: exported.value.directory, destination: restoredDestination, idempotencyKey: "golden-recovery:project-import" });
    if (replay.status !== "succeeded") throw new Error(`recovery import replay failed: ${replay.message}`);
    const restoredArtifactsByDigest = new Map<string, Uint8Array>();
    for (const entry of verifiedExport.value.artifactFiles ?? []) {
      if (entry.state !== "included" || !entry.relativePath) throw new Error(`recovery export omitted Artifact bytes for ${entry.artifactId}`);
      const bytes = new Uint8Array(await readFile(join(exported.value.directory, entry.relativePath)));
      if (bytesDigest(bytes) !== entry.digest) throw new Error(`recovery Artifact ${entry.artifactId} failed package read-back`);
      restoredArtifactsByDigest.set(entry.digest, bytes);
    }
    const restoredArtifacts = verifiedExport.value.artifacts;
    const restoredRelease = verifiedExport.value.releases[0];
    if (!restoredRelease) throw new Error("recovery export did not contain a Release");
    const targetRecords = config.targets.map((target) => targetRecord(config, target, normalized.projectId));
    const baseTransport = createCloudflareWorkerRestTransport({});
    const promotions: Record<string, Record<string, unknown>> = {};
    let responseLossInjected = false;
    for (const role of targetOrder) {
      const targetInputValue = targetInput(config.targets, role);
      const target = targetRecords.find((candidate) => candidate.id === targetInputValue.id);
      if (!target) throw new Error(`recovery Target ${targetInputValue.id} was not parsed`);
      const immutable = sealVerifiedRelease({ projectId: normalized.projectId, release: restoredRelease, artifacts: restoredArtifacts, evidence: verifiedExport.value.evidence, target });
      const broker = createCloudflareApiTokenCredentialBroker({ accountId: config.accountId, scriptName: targetInputValue.scriptName, targetId: target.id, tokenSource: async () => ({ token, sourceId: "qualification-env-token", scopes: ["workers:read", "workers:write"] }) });
      const wrapped = recoveryTransport(baseTransport, role === "production");
      const manifestBuilder = ({ release: sealedRelease }: { release: ImmutableRelease; target: ReturnType<typeof createWorkerTarget> }) => workerManifest({ config, target: targetInputValue, release: sealedRelease, assetArtifactId: assetArtifact.id, migrationArtifactId: migrationArtifact.id });
      const adapter = new CloudflareWorkerTargetAdapter({
        accountId: config.accountId,
        scriptName: targetInputValue.scriptName,
        targetId: target.id,
        transport: wrapped.transport,
        credentialBroker: broker,
        workerReleaseManifest: manifestBuilder,
        staticAssetUploader: createCloudflareWorkerStaticAssetUploader({ accountId: config.accountId, scriptName: targetInputValue.scriptName, transport: wrapped.transport, credentialBroker: broker }),
        durableObjectMigrationDeployer: await createMigrationDeployer({ config, target: targetInputValue, token, transport: wrapped.transport, broker }),
        artifactReader: createMapWorkerArtifactReader(restoredArtifactsByDigest),
        previewUrlForVersion: (versionId) => `https://${versionId.slice(0, 8)}-${targetInputValue.scriptName}.${config.previewSubdomain}.workers.dev/?anyam_preview=1`,
        previewUrlForStrategy: ({ strategy }) => strategy.kind === "isolated-target" ? config.targets.find((candidate) => candidate.id === strategy.targetId)?.healthUrl : undefined,
        healthUrl: targetInputValue.healthUrl,
        healthResponseValidator: healthValidator(),
        rolloutPolicy: config.rollout as CloudflareWorkerRolloutPolicy,
        rolloutObserver: rolloutObserver(targetInputValue, immutable),
        providerIdentityLedger: targetIdentityLedger(),
        routeReadinessRetry: config.routeReadinessRetry,
        rollbackRouteReadinessRetry: { ...config.routeReadinessRetry, retryStatuses: [...new Set([...config.routeReadinessRetry.retryStatuses, 503])] },
      });
      const workerTarget = createWorkerTarget({ target, capabilities: { preview: true, promote: true, healthCheck: true, rollback: true } });
      const coordinator = new WorkerPromotionCoordinator({ projectId: normalized.projectId, target: workerTarget, adapter });
      coordinator.registerRelease(immutable);
      let promotion = await coordinator.promote({ releaseId: immutable.release.id, idempotencyKey: `qualification:golden-recovery:${role}`, actor: { principalId: "principal:golden-recovery", actorId: "actor:golden-recovery", sessionId: "session:golden-recovery", clientId: "client:golden-recovery" } });
      if (role === "production") {
        responseLossInjected = wrapped.injected();
        if (!responseLossInjected || promotion.state !== "failed") throw new Error(`response-loss injection did not produce a recoverable failed Promotion: state=${promotion.state}; receipt=${promotion.receipt}`);
        promotion = await coordinator.retryPromotion({ promotionId: promotion.id, idempotencyKey: "qualification:golden-recovery:production:retry", actor: { principalId: "principal:golden-recovery", actorId: "actor:golden-recovery", sessionId: "session:golden-recovery", clientId: "client:golden-recovery" } });
      }
      if (promotion.state !== "healthy") throw new Error(`${role} recovery promotion did not reach healthy state: state=${promotion.state}; receipt=${promotion.receipt}; recoveryAction=${promotion.recoveryAction ?? "not-provided"}`);
      promotions[role] = { state: promotion.state, releaseId: promotion.releaseId, releaseDigest: promotion.releaseDigest, deploymentId: promotion.deploymentId ?? null, health: promotion.health?.state ?? null, receipt: promotion.receipt };
    }
    const cleanupReceipt = await cleanup();
    const bundle: GoldenRecoveryBundle = { protocol: "anyam.golden-recovery-bundle/v1", projectExportDirectory: exported.value.directory, projectExportDigest: verifiedExport.value.integrity.manifestDigest, projectId: normalized.projectId, releaseId: restoredRelease.id, artifactDigests: restoredArtifacts.map((artifact) => artifact.digest), sourceSpaceId, receipt: `export=verified; import=activated; importReplay=activated; responseLoss=${responseLossInjected ? "injected-and-reconciled" : "not-injected"}; credentialMaterialStored=false` };
    await writeFile(join(exported.value.directory, "recovery-bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return { protocol, status: "succeeded", bundle, promotions, cleanup: cleanupReceipt, coverage: { projectExport: "credential-free-and-digest-verified", sourceRestore: "refs-and-bundle-verified", artifactRestore: "bytes-and-digests-verified", targetCount: targetOrder.length, responseLossReconciliation: "version-upload-injected-and-replayed", originalResources: "not-mutated-by-this-command", mutableDurableObjectState: "not-exported", queueContents: "not-exported" }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, recoveryAction: "Retain the recovery bundle and receipt for audit; destroy only the prefix-guarded recovery resources after review." };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    let cleanupReceipt: Record<string, unknown> = { status: "not-attempted", receipt: "cleanup=not-attempted" };
    try { cleanupReceipt = await cleanup(); } catch (cleanupError) { cleanupReceipt = { status: "blocked", error: redacted(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)), receipt: "cleanup=blocked; inspect prefix-guarded recovery Workers" }; }
    console.log(JSON.stringify({ protocol, status: "blocked", error: redacted(error instanceof Error ? error.message : String(error)), cleanup: cleanupReceipt, credentialValues: "not-printed", recoveryAction: "inspect the exact recovery checkpoint and retry only the same immutable bundle after reconciling the named recovery resources" }, null, 2));
    process.exitCode = 2;
  }
}
