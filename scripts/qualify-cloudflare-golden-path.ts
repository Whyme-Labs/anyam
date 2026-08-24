import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  CloudflareWorkerTargetAdapter,
  createCloudflareWorkerRestTransport,
  createMapWorkerArtifactReader,
  type CloudflareWorkerApiResponse,
  type CloudflareWorkerHealthResponseValidator,
  type CloudflareWorkerProviderIdentity,
  type CloudflareWorkerProviderIdentityLedger,
  type CloudflareWorkerRouteReadinessRetry,
  type CloudflareWorkerRolloutPolicy,
} from "../src/cloudflare/worker-target.ts";
import { createCloudflareApiTokenCredentialBroker } from "../src/cloudflare/promotion-credential-broker.ts";
import { createCloudflareWorkerReleaseManifest, type WorkerReleaseBinding, type WorkerReleaseDurableObjectMigrations, workerReleaseManifestUploadMetadata, workerReleaseModuleContentType } from "../src/cloudflare/worker-release-manifest.ts";
import { createCloudflareWorkerStaticAssetUploader } from "../src/cloudflare/worker-assets.ts";
import { createMigrationPlan } from "../src/delivery/migration-plan.ts";
import { assertTargetResourceIsolation, createTargetDeploymentProfile, type TargetPreviewStrategy } from "../src/delivery/target-deployment.ts";
import { createWorkerTarget, sealVerifiedRelease, WorkerPromotionCoordinator, type ImmutableRelease } from "../src/delivery/promotion.ts";
import { normalizeProjectManifest, runLocalRelease, type LocalExecutionContext } from "../src/execution/local.ts";
import { CONTRACT_VERSIONS, type Evidence, type Target } from "../src/kernel/contracts.ts";

const protocol = "anyam.cloudflare-golden-path-qualification/v1" as const;
const fixtureRoot = fileURLToPath(new URL("../fixtures/worker-golden/", import.meta.url));
const buildEvidenceKey = "action:action:golden-build:verifier:verifier:golden-build";
const migrationEvidenceKey = "golden:d1-migration";
export const targetOrder = ["preview", "staging", "production"] as const;
type TargetRole = (typeof targetOrder)[number];
type JsonObject = Record<string, unknown>;

export type GoldenTargetInput = {
  id: string;
  role: TargetRole;
  scriptName: string;
  healthUrl: string;
  bindings: readonly WorkerReleaseBinding[];
  previewStrategy?: TargetPreviewStrategy;
};

export type GoldenConfig = {
  accountId: string;
  previewSubdomain: string;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  targets: readonly GoldenTargetInput[];
  migration: {
    beforeSchemaDigest: string;
    afterSchemaDigest: string;
    compatibility: "backward-compatible" | "bidirectional";
    rollback: "application-only" | "manual-data-action";
  };
  durableObjectMigrations: WorkerReleaseDurableObjectMigrations;
  rollout: CloudflareWorkerRolloutPolicy;
  routeReadinessRetry: CloudflareWorkerRouteReadinessRetry;
};

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: readonly { code?: number; message: string }[];
  messages?: readonly { code?: number; message: string }[];
};

let activeGoldenConfig: GoldenConfig | undefined;
let activeGoldenToken: string | undefined;
let activeGoldenCleanupMode: "retain" | "workers" = "retain";

function object(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function digest(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input as JsonObject).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
    return input;
  };
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(stable(value))).digest("hex")}`;
}

function bytesDigest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function redact(value: string): string {
  return value.replace(/(?:cfat_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._~-]{8,})/giu, "[redacted]");
}

export function providerError<T>(response: CloudflareWorkerApiResponse<T>): string {
  return [...response.errors, ...response.messages].map((error) => `${error.code ?? "unknown"}:${redact(error.message)}`).join(" | ") || `http-${response.status}`;
}

function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const normalized = requiredString(value, field) as T;
  if (!allowed.includes(normalized)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return normalized;
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) throw new Error(`${field} must be an array of non-empty strings`);
  return value.map((entry) => (entry as string).trim());
}

function safeProviderFields(value: unknown, field: string): Readonly<Record<string, string>> {
  const fields = object(value, field);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fields)) {
    const fieldValue = requiredString(raw, `${field}.${key}`);
    if (/(?:token|secret|password|credential|private[_-]?key|jwt)/iu.test(key) || /(?:cfat_|Bearer\s+)/iu.test(fieldValue)) throw new Error(`${field}.${key} contains credential-like material`);
    result[key] = fieldValue;
  }
  return result;
}

function parseBindings(value: unknown, field: string): readonly WorkerReleaseBinding[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must contain at least one binding`);
  return value.map((entry, index) => {
    const binding = object(entry, `${field}[${index}]`);
    const name = requiredString(binding.name, `${field}[${index}].name`);
    const kind = requiredString(binding.kind, `${field}[${index}].kind`);
    const resourceIdentity = requiredString(binding.resourceIdentity, `${field}[${index}].resourceIdentity`);
    const providerFields = safeProviderFields(binding.providerFields, `${field}[${index}].providerFields`);
    return { name, kind, resourceIdentity, providerFields };
  });
}

function parsePreviewStrategy(value: unknown, role: TargetRole): TargetPreviewStrategy | undefined {
  if (value === undefined) {
    if (role === "preview") return { kind: "staging-only", requiredEvidenceKeys: [buildEvidenceKey, migrationEvidenceKey] };
    return { kind: "isolated-target", targetId: role === "staging" ? "target:golden-preview" : "target:golden-staging" };
  }
  const strategy = object(value, "previewStrategy");
  const kind = enumValue(strategy.kind, "previewStrategy.kind", ["version-url", "isolated-target", "custom-domain-version-override", "staging-only"] as const);
  if (kind === "version-url") return { kind };
  if (kind === "isolated-target") return { kind, targetId: requiredString(strategy.targetId, "previewStrategy.targetId") };
  if (kind === "custom-domain-version-override") return { kind, hostname: requiredString(strategy.hostname, "previewStrategy.hostname") };
  return { kind, requiredEvidenceKeys: stringList(strategy.requiredEvidenceKeys, "previewStrategy.requiredEvidenceKeys") };
}

function parseRollout(value: unknown): CloudflareWorkerRolloutPolicy {
  const rollout = object(value, "rollout");
  if (!Array.isArray(rollout.steps) || rollout.steps.length === 0) throw new Error("rollout.steps must contain at least one step");
  const steps = rollout.steps.map((entry, index) => {
    const step = object(entry, `rollout.steps[${index}]`);
    const percentage = Number(step.percentage);
    const minimumObservationMs = Number(step.minimumObservationMs);
    if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) throw new Error(`rollout.steps[${index}].percentage must be an integer from 1 to 100`);
    if (!Number.isFinite(minimumObservationMs) || minimumObservationMs < 0) throw new Error(`rollout.steps[${index}].minimumObservationMs must be non-negative`);
    return { percentage, minimumObservationMs };
  });
  const versionAffinityRequired = rollout.versionAffinityRequired !== false;
  return { steps, versionAffinityRequired };
}

function parseRouteReadiness(value: unknown): CloudflareWorkerRouteReadinessRetry {
  const route = object(value, "routeReadinessRetry");
  const maxAttempts = Number(route.maxAttempts);
  const delayMs = Number(route.delayMs);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("routeReadinessRetry.maxAttempts must be a positive integer");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("routeReadinessRetry.delayMs must be non-negative");
  const retryStatuses = stringList(route.retryStatuses, "routeReadinessRetry.retryStatuses").map((status) => Number(status));
  if (retryStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) throw new Error("routeReadinessRetry.retryStatuses must contain HTTP status integers");
  return { maxAttempts, delayMs, retryStatuses, retryTransportErrors: route.retryTransportErrors === true };
}

function parseDurableObjectMigrations(value: unknown): WorkerReleaseDurableObjectMigrations {
  const migration = object(value, "durableObjectMigrations");
  const steps = migration.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.some((step) => step === null || typeof step !== "object" || Array.isArray(step))) throw new Error("durableObjectMigrations.steps must contain at least one provider migration step object");
  const normalizedSteps = steps as readonly Readonly<Record<string, unknown>>[];
  return {
    ...(migration.fromTag === undefined ? {} : { fromTag: requiredString(migration.fromTag, "durableObjectMigrations.fromTag") }),
    toTag: requiredString(migration.toTag, "durableObjectMigrations.toTag"),
    steps: normalizedSteps,
    stepsDigest: digest(normalizedSteps),
  };
}

function parseTarget(value: unknown, index: number, projectId: string): { input: GoldenTargetInput; record: Target } {
  const target = object(value, `targets[${index}]`);
  const id = requiredString(target.id, `targets[${index}].id`);
  const role = enumValue(target.role, `targets[${index}].role`, targetOrder);
  const scriptName = requiredString(target.scriptName, `targets[${index}].scriptName`);
  if (!/^anyam-golden-/u.test(scriptName)) throw new Error(`targets[${index}].scriptName must start with anyam-golden- so cleanup cannot target an existing Worker`);
  const healthUrl = requiredString(target.healthUrl, `targets[${index}].healthUrl`);
  if (!/^https:\/\//u.test(healthUrl)) throw new Error(`targets[${index}].healthUrl must use HTTPS`);
  const bindings = parseBindings(target.bindings, `targets[${index}].bindings`);
  const previewStrategy = parsePreviewStrategy(target.previewStrategy, role);
  const resourceIdentities = bindings.map((binding) => requiredString(binding.resourceIdentity, `targets[${index}].bindings.resourceIdentity`));
  const profile = createTargetDeploymentProfile({
    environment: role,
    channel: role === "production" ? "stable" : "beta",
    audience: id,
    runtimeIdentity: `worker:${scriptName}`,
    routeIdentities: [`route:${healthUrl}`],
    bindingIdentities: resourceIdentities,
    dataResourceIdentities: bindings.filter((binding) => ["d1", "r2_bucket", "kv_namespace", "queue", "durable_object_namespace"].includes(binding.kind)).map((binding) => requiredString(binding.resourceIdentity, `targets[${index}].bindings.resourceIdentity`)),
    configurationDigests: [digest({ scriptName, healthUrl, bindings })],
    secretUseAliases: [`provider-token:${id}`],
    dataClass: role === "production" ? "production" : "isolated",
    resourceSharing: "isolated",
    ...(previewStrategy ? { previewStrategy } : {}),
  });
  const record: Target = { protocol: CONTRACT_VERSIONS.target, id, projectId, name: `Golden ${role}`, adapterId: "cloudflare.worker", acceptedArtifactTypes: ["worker.bundle", "worker.module", "worker.asset", "d1.migration"], requiredEvidenceKeys: [], state: "configured", deploymentProfile: profile, currentReleaseId: null, releaseHistory: [] };
  return { input: { id, role, scriptName, healthUrl, bindings, ...(previewStrategy ? { previewStrategy } : {}) }, record };
}

export async function parseConfig(filePath: string): Promise<GoldenConfig> {
  const raw = JSON.parse(await readFile(resolve(filePath), "utf8")) as unknown;
  const config = object(raw, "golden config");
  const accountId = requiredString(config.accountId, "accountId");
  const previewSubdomain = requiredString(config.previewSubdomain, "previewSubdomain");
  const compatibilityDate = requiredString(config.compatibilityDate, "compatibilityDate");
  const compatibilityFlags = config.compatibilityFlags === undefined ? [] : stringList(config.compatibilityFlags, "compatibilityFlags");
  const migration = object(config.migration, "migration");
  const migrationConfig = {
    beforeSchemaDigest: requiredString(migration.beforeSchemaDigest, "migration.beforeSchemaDigest"),
    afterSchemaDigest: requiredString(migration.afterSchemaDigest, "migration.afterSchemaDigest"),
    compatibility: enumValue(migration.compatibility, "migration.compatibility", ["backward-compatible", "bidirectional"] as const),
    rollback: enumValue(migration.rollback, "migration.rollback", ["application-only", "manual-data-action"] as const),
  };
  const durableObjectMigrations = parseDurableObjectMigrations(config.durableObjectMigrations);
  const rollout = parseRollout(config.rollout);
  const routeReadinessRetry = parseRouteReadiness(config.routeReadinessRetry);
  if (!Array.isArray(config.targets) || config.targets.length !== 3) throw new Error("targets must contain exactly preview, staging, and production entries");
  const parsedTargets = config.targets.map((entry, index) => parseTarget(entry, index, "project:worker-golden"));
  const roles = new Set(parsedTargets.map(({ input }) => input.role));
  if (roles.size !== 3 || targetOrder.some((role) => !roles.has(role))) throw new Error("targets must contain exactly one preview, staging, and production role");
  for (const [index, current] of parsedTargets.entries()) {
    assertTargetResourceIsolation({ existing: parsedTargets.slice(0, index).map(({ record: target }) => target), candidate: current.record });
  }
  return { accountId, previewSubdomain, compatibilityDate, compatibilityFlags, targets: parsedTargets.map(({ input }) => input), migration: migrationConfig, durableObjectMigrations, rollout, routeReadinessRetry };
}

export function targetInput(targets: readonly GoldenTargetInput[], role: TargetRole): GoldenTargetInput {
  const target = targets.find((candidate) => candidate.role === role);
  if (!target) throw new Error(`golden config is missing the ${role} Target`);
  return target;
}

export function targetRecord(config: GoldenConfig, input: GoldenTargetInput, projectId: string): Target {
  const parsed = parseTarget({ id: input.id, role: input.role, scriptName: input.scriptName, healthUrl: input.healthUrl, bindings: input.bindings, ...(input.previewStrategy ? { previewStrategy: input.previewStrategy } : {}) }, 0, projectId);
  return parsed.record;
}

export function healthValidator(): CloudflareWorkerHealthResponseValidator {
  return ({ status, body, release }) => {
    let parsed: { status?: unknown; releaseId?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as typeof parsed;
    } catch {
      return { state: "unknown", receipt: `healthValidation=invalid-json; expectedRelease=${release.release.id}` };
    }
    const observedRelease = typeof parsed.releaseId === "string" ? parsed.releaseId : "missing";
    const observedStatus = typeof parsed.status === "string" ? parsed.status : "missing";
    const healthy = status >= 200 && status < 300 && observedRelease === release.release.id && observedStatus === "healthy";
    return { state: healthy ? "healthy" : "unhealthy", receipt: `healthValidation=${healthy ? "release-bound" : observedRelease === release.release.id ? "status-mismatch" : "release-mismatch"}; expectedRelease=${release.release.id}; observedRelease=${observedRelease}; bodyStatus=${observedStatus}` };
  };
}

export async function cloudflareRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({})) as CloudflareEnvelope<T>;
  const errors = [...(body.errors ?? []), ...(body.messages ?? [])].map((error) => `${error.code ?? "unknown"}:${redact(error.message)}`).join(" | ");
  if (!response.ok || body.success === false || body.result === undefined) throw new Error(`Cloudflare ${path} returned HTTP ${response.status}: ${errors || "result-missing"}`);
  return body.result;
}

function workerModuleUpload(mainModule: string, bytes: Uint8Array): FormData {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: mainModule })], { type: "application/json" }), "metadata.json");
  form.append(mainModule, new Blob([Buffer.from(bytes)], { type: "application/javascript+module" }), mainModule);
  return form;
}

function seedModule(): Uint8Array {
  return new TextEncoder().encode("export default { fetch() { return new Response('anyam-golden-seed'); } };\n");
}

async function seedWorker(input: { token: string; accountId: string; target: GoldenTargetInput; mainModule: string; bytes: Uint8Array }): Promise<void> {
  try {
    const existing = await cloudflareRequest<{ items?: readonly unknown[] }>(input.token, `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.target.scriptName)}/versions?per_page=1`);
    if ((existing.items ?? []).length > 0) throw new Error(`disposable Worker ${input.target.scriptName} already has a provider version`);
  } catch (error) {
    if (!(error instanceof Error && /HTTP 404\b/u.test(error.message))) throw error;
  }
  await cloudflareRequest<unknown>(input.token, `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.target.scriptName)}`, { method: "PUT", body: workerModuleUpload(input.mainModule, input.bytes) });
  await cloudflareRequest<unknown>(input.token, `/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.target.scriptName)}/subdomain`, { method: "POST", body: JSON.stringify({ enabled: true, previews_enabled: true }) });
}

export async function applyD1Migration(input: { token: string; accountId: string; databaseId: string; targetId: string; sql: string }): Promise<{ targetId: string; databaseId: string; outputDigest: string; receipt: string }> {
  if (/\b(?:DROP|DELETE)\b/iu.test(input.sql)) throw new Error(`D1 migration for ${input.targetId} contains destructive SQL; the golden qualifier requires an additive migration`);
  const applied = await cloudflareRequest<unknown>(input.token, `/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}/query`, { method: "POST", body: JSON.stringify({ sql: input.sql }) });
  const verified = await cloudflareRequest<unknown>(input.token, `/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(input.databaseId)}/query`, { method: "POST", body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'golden_events'" }) });
  if (!JSON.stringify(verified).includes("golden_events")) throw new Error(`D1 migration verification for ${input.targetId} did not observe golden_events`);
  const outputDigest = digest({ applied, verified });
  return { targetId: input.targetId, databaseId: input.databaseId, outputDigest, receipt: `provider=d1; target=${input.targetId}; databaseId=${input.databaseId}; migration=applied-and-read-back; outputDigest=${outputDigest}; credentialMaterialStored=false` };
}

export function migrationEvidence(base: Evidence, migrationResults: readonly { targetId: string; outputDigest: string }[], migrationArtifactDigest: string): Evidence {
  const outputDigest = digest(migrationResults);
  const { targetId: _targetId, ...crossTargetBase } = base;
  void _targetId;
  return {
    ...crossTargetBase,
    id: "evidence:golden-d1-migration",
    key: migrationEvidenceKey,
    criterion: "The additive D1 migration was applied and read back on every isolated golden Target.",
    validityKey: digest({ migrationArtifactDigest, migrationResults }),
    actionId: "action:golden-d1-migration",
    verifierId: "verifier:golden-d1-migration",
    inputDigests: [migrationArtifactDigest],
    outputDigest,
    producer: { kind: "attestation", id: "attestation:golden-d1-migration", version: "v1" },
    createdAt: new Date().toISOString(),
    receipt: `evidence=passed; migration=d1; targets=${migrationResults.length}; outputDigest=${outputDigest}; credentialMaterialStored=false`,
    invalidators: ["migration-artifact", "target-resource", "provider-schema"],
  };
}

export function d1DatabaseId(target: GoldenTargetInput): string {
  const binding = target.bindings.find((candidate) => candidate.kind === "d1");
  if (!binding) throw new Error(`Target ${target.id} has no d1 binding`);
  const databaseId = binding.providerFields?.database_id;
  if (!databaseId) throw new Error(`Target ${target.id} d1 binding must declare providerFields.database_id`);
  return databaseId;
}

export function workerManifest(input: { config: GoldenConfig; target: GoldenTargetInput; release: ImmutableRelease; assetArtifactId: string; migrationArtifactId: string }): ReturnType<typeof createCloudflareWorkerReleaseManifest> {
  const bindings = input.target.bindings.filter((binding) => binding.name !== "ANYAM_RELEASE_ID");
  bindings.push({ name: "ANYAM_RELEASE_ID", kind: "plain_text", resourceIdentity: `release-id:${input.target.id}`, providerFields: { text: input.release.release.id } });
  const assetArtifact = input.release.artifacts.find((artifact) => artifact.id === input.assetArtifactId);
  if (!assetArtifact) throw new Error(`Target ${input.target.id} cannot build a Worker manifest without asset Artifact ${input.assetArtifactId}`);
  return createCloudflareWorkerReleaseManifest({
    release: input.release,
    compatibilityDate: input.config.compatibilityDate,
    compatibilityFlags: input.config.compatibilityFlags,
    bindings,
    staticAssetArtifactIds: [input.assetArtifactId],
    staticAssets: { manifestDigest: assetArtifact.digest, namespaceDigest: digest(`assets:${input.target.id}`) },
    externalMigrationArtifactIds: [input.migrationArtifactId],
    durableObjectMigrations: input.config.durableObjectMigrations,
    healthPaths: ["/health"],
  });
}

export function targetIdentityLedger(): CloudflareWorkerProviderIdentityLedger {
  const identities = new Map<string, CloudflareWorkerProviderIdentity>();
  return {
    async load(input) { return identities.get(`${input.targetId}:${input.releaseDigest}`); },
    async save(identity) { identities.set(`${identity.targetId}:${identity.releaseDigest}`, identity); },
  };
}

export function rolloutObserver(target: GoldenTargetInput, release: ImmutableRelease) {
  return async ({ step, providerVersionId }: { step: { percentage: number; minimumObservationMs: number }; providerVersionId: string }): Promise<{ status: "continue" | "abort"; receipt: string }> => {
    if (step.minimumObservationMs > 0) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, step.minimumObservationMs));
    const response = await fetch(target.healthUrl, { cache: "no-store", headers: { "Cloudflare-Workers-Version-Overrides": `${target.scriptName}="${providerVersionId}"` } });
    const body = await response.text();
    let parsed: { status?: unknown; releaseId?: unknown } = {};
    try { parsed = JSON.parse(body) as typeof parsed; } catch { /* the receipt below records the failed observation */ }
    const healthy = response.status >= 200 && response.status < 300 && parsed.status === "healthy" && parsed.releaseId === release.release.id;
    return { status: healthy ? "continue" : "abort", receipt: `rolloutObservation=${healthy ? "healthy" : "failed"}; percentage=${step.percentage}; httpStatus=${response.status}; bodyDigest=${digest(body)}` };
  };
}

async function deleteWorker(token: string, accountId: string, target: GoldenTargetInput): Promise<string> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(target.scriptName)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return `worker=${target.scriptName}; deleted=already-absent`;
  const body = await response.json().catch(() => ({})) as CloudflareEnvelope<unknown>;
  if (!response.ok || body.success === false) throw new Error(`cleanup Worker ${target.scriptName} returned HTTP ${response.status}`);
  return `worker=${target.scriptName}; deleted=true`;
}

async function cleanupGoldenWorkers(): Promise<Record<string, unknown>> {
  if (!activeGoldenConfig || !activeGoldenToken) return { mode: activeGoldenCleanupMode, status: "not-attempted", receipt: "cleanup=not-attempted; configuration-or-credential-not-loaded" };
  if (activeGoldenCleanupMode === "retain") return { mode: activeGoldenCleanupMode, status: "retained-by-owner", resources: activeGoldenConfig.targets.map((target) => target.scriptName), receipt: "destructiveCleanup=not-requested; data-resources=retained" };
  const resources = [];
  for (const target of activeGoldenConfig.targets) resources.push(await deleteWorker(activeGoldenToken, activeGoldenConfig.accountId, target));
  return { mode: activeGoldenCleanupMode, status: "succeeded", resources };
}

export async function run(): Promise<Record<string, unknown>> {
  const configPath = process.env.ANYAM_GOLDEN_CONFIG_FILE?.trim();
  const tokenFile = process.env.ANYAM_GOLDEN_API_TOKEN_FILE?.trim();
  let token = process.env.ANYAM_GOLDEN_API_TOKEN?.trim();
  if (!token && tokenFile) {
    const mode = (await stat(tokenFile)).mode & 0o077;
    if (mode !== 0) throw new Error(`ANYAM_GOLDEN_API_TOKEN_FILE must be owner-only (mode 0600); observed mode ${mode.toString(8)}`);
    token = (await readFile(tokenFile, "utf8")).trim();
  }
  const cleanupMode = process.env.ANYAM_GOLDEN_CLEANUP_MODE?.trim() || "retain";
  if (!configPath || !token) throw new Error("ANYAM_GOLDEN_CONFIG_FILE and either ANYAM_GOLDEN_API_TOKEN or owner-only ANYAM_GOLDEN_API_TOKEN_FILE are required; credential material is never printed");
  if (cleanupMode !== "retain" && cleanupMode !== "workers") throw new Error("ANYAM_GOLDEN_CLEANUP_MODE must be retain or workers; data-resource destruction is intentionally not implicit");
  const config = await parseConfig(configPath);
  activeGoldenConfig = config;
  activeGoldenToken = token;
  activeGoldenCleanupMode = cleanupMode;
  const tempDirectory = await mkdtemp(join(tmpdir(), "anyam-golden-live-"));
  try {
    await cp(fixtureRoot, tempDirectory, { recursive: true });
    const rawManifest = JSON.parse(await readFile(join(tempDirectory, "anyam.json"), "utf8")) as unknown;
    const normalized = normalizeProjectManifest(rawManifest);
    const preview = targetInput(config.targets, "preview");
    const staging = targetInput(config.targets, "staging");
    const production = targetInput(config.targets, "production");
    const targetRecords = [preview, staging, production].map((target, index) => parseTarget({ id: target.id, role: target.role, scriptName: target.scriptName, healthUrl: target.healthUrl, bindings: target.bindings, ...(target.previewStrategy ? { previewStrategy: target.previewStrategy } : {}) }, index, normalized.projectId).record);
    const localContext: LocalExecutionContext = {
      directory: tempDirectory,
      projectRevisionId: "project-revision:worker-golden:live",
      projectViewId: "project-view:worker-golden:live",
      sourceSpaceSnapshots: { "worker-golden-source": "snapshot:worker-golden:live" },
      actor: { principalId: "principal:golden-qualification", actorId: "actor:golden-qualification", sessionId: "session:golden-qualification", clientId: "client:golden-qualification" },
      runnerId: "runner:golden-local",
      policyVersion: "policy:worker-golden:live",
      authorizationEpoch: "1",
      capabilityGrantId: "grant:worker-golden:live",
      dependencyDigest: "sha256:worker-golden-dependencies:v1",
      toolchainDigest: "sha256:worker-golden-toolchain:v1",
      environmentDigest: "sha256:worker-golden-environment:v1",
      disclosure: { projectionId: "project-view:worker-golden:live", classification: "project" },
      owner: "Anyam Cloudflare golden-path qualification",
      changeRevisionId: "change-revision:worker-golden:live",
      workspaceId: "workspace:worker-golden:live",
      targetId: staging.id,
      declaredEffects: ["artifact.create", "migration.apply", "target.promote"],
    };
    const local = await runLocalRelease({ manifest: rawManifest, context: localContext, releaseName: "golden-live", stateAssumptions: ["disposable Cloudflare resources; no customer data; owner-run cleanup"] });
    if (local.release.status !== "ready" || local.evidence.some((evidence) => evidence.outcome !== "passed")) throw new Error(`local golden build did not produce a ready Release: status=${local.release.status}; evidence=${local.evidence.map((evidence) => `${evidence.key}:${evidence.outcome}`).join(",")}`);
    const artifacts = new Map<string, Uint8Array>();
    for (const artifact of local.artifacts) {
      const outputPath = requiredString(artifact.outputPath, `artifact ${artifact.id}.outputPath`);
      const path = resolve(tempDirectory, outputPath);
      if (!path.startsWith(`${resolve(tempDirectory)}/`)) throw new Error(`artifact ${artifact.id} escapes the golden Workspace`);
      const bytes = new Uint8Array(await readFile(path));
      if (bytesDigest(bytes) !== artifact.digest) throw new Error(`artifact ${artifact.id} (${outputPath}) digest changed after local verification: expected=${artifact.digest}; observed=${bytesDigest(bytes)}`);
      artifacts.set(artifact.digest, bytes);
    }
    const migrationArtifact = local.artifacts.find((artifact) => artifact.type === "d1.migration");
    const assetArtifact = local.artifacts.find((artifact) => artifact.type === "worker.asset");
    if (!migrationArtifact || !assetArtifact) throw new Error("golden fixture did not produce the d1.migration and worker.asset Artifacts required by this qualifier");
    const mainArtifact = local.artifacts.find((artifact) => artifact.type === "worker.bundle");
    if (!mainArtifact || !mainArtifact.outputPath) throw new Error("golden fixture did not produce a main Worker bundle Artifact");
    const seedBytes = seedModule();
    const transport = createCloudflareWorkerRestTransport({});
    for (const target of [preview, staging, production]) await seedWorker({ token, accountId: config.accountId, target, mainModule: "worker.js", bytes: seedBytes });
    const migrationSql = new TextDecoder().decode(artifacts.get(migrationArtifact.digest));
    const migrationResults = [];
    for (const target of [preview, staging, production]) migrationResults.push(await applyD1Migration({ token, accountId: config.accountId, databaseId: d1DatabaseId(target), targetId: target.id, sql: migrationSql }));
    const migrationRecord = migrationEvidence(local.evidence[0]!, migrationResults.map(({ targetId, outputDigest }) => ({ targetId, outputDigest })), migrationArtifact.digest);
    const migrationPlan = createMigrationPlan({ strategy: "expand-contract", beforeSchemaDigest: config.migration.beforeSchemaDigest, afterSchemaDigest: config.migration.afterSchemaDigest, compatibility: config.migration.compatibility, rollback: config.migration.rollback, migrationArtifactIds: [migrationArtifact.id], requiredEvidenceKeys: [migrationEvidenceKey] });
    const release = { ...local.release, evidenceIds: [...local.release.evidenceIds, migrationRecord.id], migrationPlan };
    const evidence = [...local.evidence, migrationRecord];
    const routeTargets = new Map(config.targets.map((target) => [target.id, target]));
    const releaseDigests: Record<string, string> = {};
    const promotions: Record<string, Record<string, unknown>> = {};
    const immutableByTarget = new Map<string, ImmutableRelease>();
    for (const role of targetOrder) {
      const targetInputValue = targetInput(config.targets, role);
      const target = targetRecords.find((candidate) => candidate.id === targetInputValue.id);
      if (!target) throw new Error(`Target ${targetInputValue.id} was not parsed`);
      const immutable = sealVerifiedRelease({ projectId: normalized.projectId, release, artifacts: local.artifacts, evidence, target });
      immutableByTarget.set(target.id, immutable);
      releaseDigests[role] = immutable.releaseDigest;
      const broker = createCloudflareApiTokenCredentialBroker({ accountId: config.accountId, scriptName: targetInputValue.scriptName, targetId: target.id, tokenSource: async () => ({ token, sourceId: "qualification-env-token", scopes: ["workers:read", "workers:write"] }) });
      const manifestBuilder = ({ release: sealedRelease }: { release: ImmutableRelease; target: ReturnType<typeof createWorkerTarget> }) => workerManifest({ config, target: targetInputValue, release: sealedRelease, assetArtifactId: assetArtifact.id, migrationArtifactId: migrationArtifact.id });
      const adapter = new CloudflareWorkerTargetAdapter({
        accountId: config.accountId,
        scriptName: targetInputValue.scriptName,
        targetId: target.id,
        transport,
        credentialBroker: broker,
        workerReleaseManifest: manifestBuilder,
        staticAssetUploader: createCloudflareWorkerStaticAssetUploader({ accountId: config.accountId, scriptName: targetInputValue.scriptName, transport, credentialBroker: broker }),
        durableObjectMigrationDeployer: async ({ manifest, release: sealedRelease, target: migrationTarget, operation, readArtifact }) => {
          const migration = manifest.durableObjectMigrations;
          if (!migration) throw new Error("migration preflight was called without Durable Object migration metadata");
          const credential = await broker.issue({ accountId: config.accountId, scriptName: targetInputValue.scriptName, targetId: migrationTarget.id, operation: "version-upload", audience: "aud:anyam:deployment" });
          const form = new FormData();
          form.append("metadata", new Blob([JSON.stringify(workerReleaseManifestUploadMetadata(manifest, sealedRelease.release.id, `migration-${migration.toTag}`, undefined, { includeStaticAssets: false }))], { type: "application/json" }), "metadata.json");
          const artifactByDigest = new Map(sealedRelease.artifacts.map((artifact) => [artifact.digest, artifact]));
          for (const module of manifest.modules) {
            const artifact = artifactByDigest.get(module.digest);
            if (!artifact) throw new Error(`migration preflight is missing module Artifact ${module.digest}`);
            const bytes = await readArtifact(artifact);
            form.append(module.name, new Blob([Buffer.from(bytes)], { type: workerReleaseModuleContentType(module.type) }), module.name);
          }
          const upload = await transport.request<{ id?: string }>({ method: "PUT", path: `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(targetInputValue.scriptName)}`, token: credential.token, body: form });
          if (!upload.ok) throw new Error(`migration deployment returned HTTP ${upload.status}: ${providerError(upload)}`);
          const versions = await transport.request<{ items?: readonly { id?: string }[] }>({ method: "GET", path: `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(targetInputValue.scriptName)}/versions?per_page=1`, token: credential.token });
          if (!versions.ok) throw new Error(`migration deployment version list returned HTTP ${versions.status}: ${providerError(versions)}`);
          const versionId = versions.result?.items?.[0]?.id;
          if (!versionId) throw new Error("migration deployment did not return a latest provider version identity");
          const detail = await transport.request<{ resources?: { script_runtime?: { migration_tag?: string } } }>({ method: "GET", path: `/accounts/${encodeURIComponent(config.accountId)}/workers/scripts/${encodeURIComponent(targetInputValue.scriptName)}/versions/${encodeURIComponent(versionId)}`, token: credential.token });
          if (!detail.ok) throw new Error(`migration deployment read-back returned HTTP ${detail.status}: ${providerError(detail)}`);
          const migrationTag = detail.result?.resources?.script_runtime?.migration_tag;
          if (migrationTag !== migration.toTag) throw new Error(`migration deployment read-back returned tag ${migrationTag ?? "missing"}, expected ${migration.toTag}`);
          return { migrationTag, receipt: `provider=cloudflare-workers; operation=durable-object-migration; target=${migrationTarget.id}; providerVersionId=${versionId}; migrationTag=${migrationTag}; releaseDigest=${sealedRelease.releaseDigest}; operationPhase=${operation}; credentialMaterialStored=false` };
        },
        artifactReader: createMapWorkerArtifactReader(artifacts),
        previewUrlForVersion: (versionId) => `https://${versionId.slice(0, 8)}-${targetInputValue.scriptName}.${config.previewSubdomain}.workers.dev/?anyam_preview=1`,
        previewUrlForStrategy: ({ strategy }) => strategy.kind === "isolated-target" ? routeTargets.get(strategy.targetId)?.healthUrl : undefined,
        healthUrl: targetInputValue.healthUrl,
        healthResponseValidator: healthValidator(),
        rolloutPolicy: config.rollout,
        rolloutObserver: rolloutObserver(targetInputValue, immutable),
        providerIdentityLedger: targetIdentityLedger(),
        routeReadinessRetry: config.routeReadinessRetry,
        rollbackRouteReadinessRetry: { ...config.routeReadinessRetry, retryStatuses: [...new Set([...config.routeReadinessRetry.retryStatuses, 503])] },
      });
      const workerTarget = createWorkerTarget({ target, capabilities: { preview: true, promote: true, healthCheck: true, rollback: true } });
      const coordinator = new WorkerPromotionCoordinator({ projectId: normalized.projectId, target: workerTarget, adapter });
      coordinator.registerRelease(immutable);
      const promotion = await coordinator.promote({ releaseId: immutable.release.id, idempotencyKey: `qualification:golden:${role}`, actor: { principalId: "principal:golden-qualification", actorId: "actor:golden-qualification", sessionId: "session:golden-qualification", clientId: "client:golden-qualification" } });
      if (promotion.state !== "healthy") throw new Error(`${role} promotion did not reach healthy state: state=${promotion.state}; receipt=${promotion.receipt}; recoveryAction=${promotion.recoveryAction ?? "not-provided"}`);
      promotions[role] = { state: promotion.state, releaseId: promotion.releaseId, releaseDigest: promotion.releaseDigest, deploymentId: promotion.deploymentId ?? null, health: promotion.health?.state ?? null, previewId: promotion.previewId ?? null, receipt: promotion.receipt };
    }
    const cleanup = await cleanupGoldenWorkers();
    return { protocol, status: "succeeded", coverage: { build: "passed", d1Migration: "applied-and-read-back", workerModules: "uploaded-and-read-back", staticAssets: "uploaded", targetCount: targetOrder.length, promotionOrder: [...targetOrder], exportRestore: "not-performed; follow-up remains open" }, accountId: config.accountId, projectId: normalized.projectId, releaseId: release.id, releaseDigests, promotions, rollout: config.rollout, routeReadiness: config.routeReadinessRetry, cleanup, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, recoveryAction: "Export and restore the exact Authority/provider state before treating the golden path as complete." };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    let cleanup: Record<string, unknown>;
    try { cleanup = await cleanupGoldenWorkers(); } catch (cleanupError) { cleanup = { mode: activeGoldenCleanupMode, status: "blocked", error: redact(cleanupError instanceof Error ? cleanupError.message : String(cleanupError)), receipt: "cleanup=blocked; inspect the exact disposable Worker names before retrying deletion" }; }
    console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? redact(error.message) : "golden qualification failed", cleanup, credentialValues: "not-printed", recoveryAction: "inspect the exact provider operation receipt and retry only the same immutable golden Release after reconciling the named Target" }, null, 2));
    process.exitCode = 2;
  }
}
