import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type Artifact,
  type Target,
} from "../kernel/contracts.ts";
import {
  createWorkerTarget,
  sealVerifiedRelease,
  WorkerPromotionCoordinator,
  type ImmutableRelease,
  type PromotionRecord,
  type WorkerTarget,
} from "../delivery/promotion.ts";
import {
  CLOUDFLARE_WORKER_TARGET_ADAPTER_ID,
  CloudflareWorkerTargetAdapter,
  createCloudflareWorkerRestTransport,
  type CloudflareWorkerCredentialBroker,
  type CloudflareWorkerCredentialObservation,
  type CloudflareWorkerHealthResponseValidator,
  type CloudflareWorkerRouteReadinessRetry,
} from "./worker-target.ts";
import {
  PROMOTION_EXECUTION_PROTOCOL,
  type PromotionExecutionContext,
  type PromotionExecutionReleaseBundle,
  type PromotionExecutionResult,
  type PromotionHandoffKeyring,
} from "./promotion-execution.ts";
import { verifyPromotionHandoff, type PromotionHandoffNonceStore } from "./promotion-execution.ts";

/**
 * The executor is the customer-owned provider boundary. Authority sends the
 * detached Promotion context over a trusted service binding; this Worker
 * alone owns provider credentials, Target adapter selection, and provider
 * calls. Nothing from this module is written back into Authority until the
 * credential-free result crosses its validator.
 */
export const PROMOTION_EXECUTOR_PROTOCOL = PROMOTION_EXECUTION_PROTOCOL;

export type PromotionExecutorArtifactObject = {
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type PromotionExecutorArtifactStore = {
  get(key: string): Promise<PromotionExecutorArtifactObject | null>;
};

export type PromotionExecutorConfig = {
  accountId: string;
  scriptName: string;
  targetId: string;
  adapterId?: string;
  previewSubdomain: string;
  healthUrl?: string;
  /** Provider authority is available only through this customer-owned broker. */
  credentialBroker: CloudflareWorkerCredentialBroker;
  artifactStore: PromotionExecutorArtifactStore;
  fetch?: typeof fetch;
  now?: () => string;
  routeReadinessRetry?: CloudflareWorkerRouteReadinessRetry;
  rollbackRouteReadinessRetry?: CloudflareWorkerRouteReadinessRetry;
  healthHeaders?: Readonly<Record<string, string>>;
  handoffKeys: PromotionHandoffKeyring;
  handoffNonceStore: PromotionHandoffNonceStore;
};

export type PromotionExecutorResponse = {
  status: number;
  body: Record<string, unknown>;
};

class PromotionExecutorInputError extends Error {
  readonly status = 422;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "PromotionExecutorInputError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

class PromotionExecutorConfigurationError extends Error {
  readonly status = 503;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "PromotionExecutorConfigurationError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

class PromotionExecutorProviderError extends Error {
  readonly status = 503;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "PromotionExecutorProviderError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PromotionExecutorInputError(
      `${field} must be a non-empty string in a Promotion execution context.`,
      `return a complete ${field} from the Authority handoff; provider invocation was not attempted`,
      `field=${field}; context=invalid; providerInvocation=false`,
    );
  }
  return value.trim();
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestFormat(value: string, field: string): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new PromotionExecutorInputError(
      `${field} must be a sha256 digest.`,
      `return the Authority-issued ${field} without rewriting it; provider invocation was not attempted`,
      `field=${field}; digest=invalid; providerInvocation=false`,
    );
  }
}

function safeObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PromotionExecutorInputError(
      `${field} must be an object.`,
      `send the exact typed ${field} object from the Authority handoff; provider invocation was not attempted`,
      `field=${field}; object=required; providerInvocation=false`,
    );
  }
  return value;
}

function credentialMaterial(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    return /(?:bearer\s+[A-Za-z0-9._~-]{8,}|cfat_[A-Za-z0-9]+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^;\s]{4,})/iu.test(value)
      ? "string"
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = credentialMaterial(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:token|secret|password|credentials?|api[_-]?key)$/iu.test(key)) return key;
      const found = credentialMaterial(entry);
      if (found) return found;
    }
  }
  return undefined;
}

function allowedContextKeys(value: Record<string, unknown>): void {
  const allowed = [
    "protocol",
    "realmId",
    "stateVersion",
    "project",
    "promotion",
    "release",
    "artifacts",
    "evidence",
    "previousRelease",
    "target",
    "expectedCurrentReleaseId",
    "executionIdempotencyKey",
    "actor",
    "executionDigest",
  ];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new PromotionExecutorInputError(
      `Promotion execution context field ${unknown} is not accepted.`,
      "send only the Authority-issued anyam.promotion-execution/v1 context; provider invocation was not attempted",
      `field=${unknown}; context=unknown-field; providerInvocation=false`,
    );
  }
}

function routeRetry(config: PromotionExecutorConfig): CloudflareWorkerRouteReadinessRetry {
  // These are the qualification-backed Worker Target values. They are a
  // customer configuration default, not an Anyam capacity limit; remeasure
  // them during deployment qualification before treating them as production
  // policy.
  return config.routeReadinessRetry ?? {
    maxAttempts: 10,
    delayMs: 1000,
    retryStatuses: [404],
    retryTransportErrors: true,
  };
}

function rollbackRouteRetry(config: PromotionExecutorConfig): CloudflareWorkerRouteReadinessRetry {
  const retry = config.rollbackRouteReadinessRetry ?? routeRetry(config);
  return retry;
}

function workerHealthValidator(): CloudflareWorkerHealthResponseValidator {
  return ({ status, body, release }) => {
    let parsed: { status?: unknown; releaseId?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as typeof parsed;
    } catch {
      return { state: "unknown", receipt: `healthValidation=invalid-json; expectedRelease=${release.release.id}` };
    }
    const observedRelease = typeof parsed.releaseId === "string" ? parsed.releaseId : "missing";
    const observedStatus = typeof parsed.status === "string" ? parsed.status : "missing";
    const statusHealthy = status >= 200 && status < 300;
    const releaseMatches = observedRelease === release.release.id;
    const bodyHealthy = observedStatus === "healthy";
    if (statusHealthy && releaseMatches && bodyHealthy) {
      return { state: "healthy", receipt: `healthValidation=release-bound; expectedRelease=${release.release.id}; observedRelease=${observedRelease}; bodyStatus=${observedStatus}` };
    }
    return {
      state: "unhealthy",
      receipt: `healthValidation=${releaseMatches ? "status-mismatch" : "release-mismatch"}; expectedRelease=${release.release.id}; observedRelease=${observedRelease}; bodyStatus=${observedStatus}`,
    };
  };
}

function artifactKey(artifact: Artifact): string {
  return `artifacts/${artifact.digest}`;
}

function createArtifactReader(store: PromotionExecutorArtifactStore) {
  return {
    async read(artifact: Artifact): Promise<Uint8Array> {
      const object = await store.get(artifactKey(artifact));
      if (!object) {
        throw new Error(`Artifact ${artifact.id} is absent from digest-addressed customer storage at ${artifactKey(artifact)}`);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      const actual = digest(bytes);
      if (actual !== artifact.digest) {
        throw new Error(`Artifact ${artifact.id} digest mismatch: expected ${artifact.digest}, received ${actual}`);
      }
      return bytes;
    },
  };
}

function targetForContext(context: PromotionExecutionContext, config: PromotionExecutorConfig): WorkerTarget {
  const target = safeObject(context.target, "target") as unknown as Target;
  if (target.id !== config.targetId) {
    throw new PromotionExecutorInputError(
      `Target ${target.id} is not the Target configured for this executor.`,
      "route the exact Target to its customer-operated executor service; provider invocation was not attempted",
      `target=${target.id}; configuredTarget=${config.targetId}; adapterSelection=mismatch; providerInvocation=false`,
    );
  }
  const adapterId = config.adapterId ?? CLOUDFLARE_WORKER_TARGET_ADAPTER_ID;
  if (target.adapterId !== adapterId || adapterId !== CLOUDFLARE_WORKER_TARGET_ADAPTER_ID) {
    throw new PromotionExecutorInputError(
      `Target ${target.id} requests unsupported adapter ${target.adapterId}.`,
      `configure a qualified ${CLOUDFLARE_WORKER_TARGET_ADAPTER_ID} executor for this Target; provider invocation was not attempted`,
      `target=${target.id}; adapter=${target.adapterId}; configuredAdapter=${adapterId}; adapterSelection=rejected; providerInvocation=false`,
    );
  }
  if (!target.acceptedArtifactTypes.includes("worker.bundle")) {
    throw new PromotionExecutorInputError(
      `Target ${target.id} does not accept worker.bundle Artifacts.`,
      "configure the Target for the Artifact type consumed by the Worker Target adapter; provider invocation was not attempted",
      `target=${target.id}; artifactType=worker.bundle; accepted=false; providerInvocation=false`,
    );
  }
  return createWorkerTarget({
    target,
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
    currentReleaseId: target.currentReleaseId ?? null,
    releaseHistory: target.releaseHistory ?? [],
  });
}

function validateContext(value: unknown, config: PromotionExecutorConfig): PromotionExecutionContext {
  const context = safeObject(value, "context");
  allowedContextKeys(context);
  const forbidden = credentialMaterial(context);
  if (forbidden) {
    throw new PromotionExecutorInputError(
      "Promotion execution context contains caller-supplied credential material.",
      "remove provider credentials and send only the Authority-issued detached context; provider invocation was not attempted",
      `credentialMaterial=${forbidden}; context=rejected; providerInvocation=false`,
    );
  }
  if (context.protocol !== PROMOTION_EXECUTION_PROTOCOL) {
    throw new PromotionExecutorInputError(
      `Unsupported Promotion execution protocol ${String(context.protocol)}.`,
      `send ${PROMOTION_EXECUTION_PROTOCOL} from the Realm service binding; provider invocation was not attempted`,
      `protocol=${String(context.protocol)}; expected=${PROMOTION_EXECUTOR_PROTOCOL}; providerInvocation=false`,
    );
  }
  const project = safeObject(context.project, "project");
  const promotion = safeObject(context.promotion, "promotion");
  const release = safeObject(context.release, "release");
  const target = safeObject(context.target, "target");
  const projectId = requiredString(project.id, "project.id");
  const promotionId = requiredString(promotion.id, "promotion.id");
  const releaseId = requiredString(release.id, "release.id");
  const targetId = requiredString(target.id, "target.id");
  const expected = context.expectedCurrentReleaseId === null ? null : requiredString(context.expectedCurrentReleaseId, "expectedCurrentReleaseId");
  if (promotion.projectId !== projectId || promotion.releaseId !== releaseId || promotion.targetId !== targetId || target.projectId !== projectId || promotion.expectedCurrentReleaseId !== expected) {
    throw new PromotionExecutorInputError(
      `Promotion ${promotionId} is not bound to one exact Project, Release, and Target.`,
      "return the untouched Authority context; provider invocation was not attempted",
      `promotion=${promotionId}; exactBinding=false; providerInvocation=false`,
    );
  }
  if (targetId !== config.targetId) {
    throw new PromotionExecutorInputError(
      `Target ${targetId} is not configured for this executor.`,
      "bind the Realm to the customer-operated executor selected for this Target; provider invocation was not attempted",
      `target=${targetId}; configuredTarget=${config.targetId}; providerInvocation=false`,
    );
  }
  digestFormat(requiredString(context.executionDigest, "executionDigest"), "executionDigest");
  requiredString(context.realmId, "realmId");
  requiredString(context.executionIdempotencyKey, "executionIdempotencyKey");
  if (!Array.isArray(context.artifacts) || !Array.isArray(context.evidence)) {
    throw new PromotionExecutorInputError(
      "Promotion execution context artifacts and evidence must be arrays.",
      "return the complete immutable Release inputs from Authority; provider invocation was not attempted",
      `promotion=${promotionId}; lineage=arrays-required; providerInvocation=false`,
    );
  }
  if (promotion.previousReleaseId === null && context.previousRelease !== null) {
    throw new PromotionExecutorInputError(
      "Promotion context included previous Release inputs without a previousReleaseId.",
      "omit previous Release inputs when the Target has no known-good predecessor; provider invocation was not attempted",
      `promotion=${promotionId}; previousRelease=unexpected; providerInvocation=false`,
    );
  }
  if (promotion.previousReleaseId !== null) {
    const previous = safeObject(context.previousRelease, "previousRelease");
    const previousValue = safeObject(previous.release, "previousRelease.release");
    if (previousValue.id !== promotion.previousReleaseId) {
      throw new PromotionExecutorInputError(
        "Promotion context previous Release does not match the requested rollback identity.",
        "return the exact previous known-good Release bundle from Authority; provider invocation was not attempted",
        `promotion=${promotionId}; expectedPrevious=${promotion.previousReleaseId}; receivedPrevious=${String(previousValue.id)}; providerInvocation=false`,
      );
    }
  }
  return context as unknown as PromotionExecutionContext;
}

function immutableRelease(input: PromotionExecutionReleaseBundle, projectId: string, target: Target): ImmutableRelease {
  return sealVerifiedRelease({ projectId, release: input.release, artifacts: input.artifacts, evidence: input.evidence, target });
}

function operationIds(promotion: PromotionRecord): string[] {
  return [promotion.providerOperationId, promotion.rollbackProviderOperationId].filter((value): value is string => Boolean(value));
}

function mapPromotionResult(context: PromotionExecutionContext, local: PromotionRecord, target: WorkerTarget, release: ImmutableRelease): PromotionExecutionResult {
  const promotion: PromotionRecord = {
    ...local,
    id: context.promotion.id,
    projectId: context.project.id,
    targetId: context.target.id,
    releaseId: context.release.id,
    releaseDigest: context.promotion.releaseDigest.startsWith("declared:") ? context.promotion.releaseDigest : release.releaseDigest,
    previousReleaseId: context.promotion.previousReleaseId,
    expectedCurrentReleaseId: context.expectedCurrentReleaseId,
    idempotencyKey: context.promotion.idempotencyKey,
    actor: context.actor,
    createdAt: context.promotion.createdAt,
    attempt: Math.max(local.attempt, context.promotion.attempt),
    executionIdempotencyKey: context.executionIdempotencyKey,
  };
  const status: PromotionExecutionResult["status"] = promotion.state === "healthy" || (promotion.state === "rolled-back" && target.state === "healthy")
    ? "succeeded"
    : promotion.state === "degraded" || target.state === "degraded"
      ? "indeterminate"
      : "blocked";
  const checkpoint = {
    idempotencyKey: context.executionIdempotencyKey,
    attempt: promotion.attempt,
    stage: status === "indeterminate" ? "reconcile" as const : "complete" as const,
    providerOperationIds: operationIds(promotion),
    receipt: `promotion=${promotion.id}; executor=customer-operated; execution=${status}; credentialMaterialStored=false`,
  };
  promotion.reconciliationCheckpoint = checkpoint;
  return {
    protocol: PROMOTION_EXECUTION_PROTOCOL,
    status,
    adapterId: context.target.adapterId,
    executionDigest: context.executionDigest,
    promotion,
    target: {
      id: target.id,
      projectId: target.projectId,
      state: target.state,
      currentReleaseId: target.currentReleaseId,
      releaseHistory: [...target.releaseHistory],
    },
    checkpoint,
    receipt: `executor=customer-operated; provider=cloudflare-workers; promotion=${promotion.id}; state=${promotion.state}; targetState=${target.state}; release=${context.release.id}; providerOperationIds=${operationIds(promotion).join(",") || "none"}; credentialMaterialStored=false; canonicalWrite=false`,
    ...(promotion.recoveryAction ? { recoveryAction: promotion.recoveryAction } : {}),
  };
}

export function createPromotionExecutor(config: PromotionExecutorConfig): { execute(context: Readonly<PromotionExecutionContext>): Promise<PromotionExecutionResult> } {
  if (!config.accountId || !config.scriptName || !config.targetId || !config.previewSubdomain || !config.credentialBroker || !config.handoffKeys?.active?.id || !config.handoffKeys.active.secret || !config.handoffNonceStore) {
    throw new PromotionExecutorConfigurationError(
      "Customer-operated Promotion executor configuration is incomplete.",
      "configure account ID, Worker script, Target ID, preview subdomain, customer-owned credential broker, active handoff key, and nonce store before binding the service",
      `executor=config-incomplete; handoffKey=${config.handoffKeys?.active?.id ? "present" : "missing"}; nonceStore=${config.handoffNonceStore ? "present" : "missing"}; providerInvocation=false; credentialMaterialStored=false`,
    );
  }
  if (config.handoffKeys.previous && (!config.handoffKeys.previous.id || !config.handoffKeys.previous.secret || config.handoffKeys.previous.id === config.handoffKeys.active.id)) {
    throw new PromotionExecutorConfigurationError("Customer-operated Promotion executor handoff key rotation configuration is invalid.", "configure a distinct previous handoff key ID and secret, or omit the previous key pair", "executor=handoff-key-rotation-invalid; providerInvocation=false; credentialMaterialStored=false");
  }
  const adapterId = config.adapterId ?? CLOUDFLARE_WORKER_TARGET_ADAPTER_ID;
  if (adapterId !== CLOUDFLARE_WORKER_TARGET_ADAPTER_ID) {
    throw new PromotionExecutorConfigurationError(
      `Unsupported executor adapter ${adapterId}.`,
      `configure ${CLOUDFLARE_WORKER_TARGET_ADAPTER_ID} or add a separately qualified executor adapter`,
      `adapter=${adapterId}; executor=config-invalid; providerInvocation=false`,
    );
  }
  const transport = createCloudflareWorkerRestTransport(config.fetch ? { fetch: config.fetch } : {});
  const adapter = new CloudflareWorkerTargetAdapter({
    accountId: config.accountId,
    scriptName: config.scriptName,
    targetId: config.targetId,
    transport,
    credentialBroker: config.credentialBroker,
    artifactReader: createArtifactReader(config.artifactStore),
    previewUrlForVersion: (versionId) => `https://${versionId.slice(0, 8)}-${config.scriptName}.${config.previewSubdomain}.workers.dev/?anyam_preview=1`,
    healthUrl: config.healthUrl ?? `https://${config.scriptName}.${config.previewSubdomain}.workers.dev/health`,
    healthResponseValidator: workerHealthValidator(),
    routeReadinessRetry: routeRetry(config),
    rollbackRouteReadinessRetry: rollbackRouteRetry(config),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.now ? { now: config.now } : {}),
    ...(config.healthHeaders ? { healthHeaders: config.healthHeaders } : {}),
  });

  return {
    async execute(rawContext) {
      const context = validateContext(rawContext, config);
      const target = targetForContext(context, config);
      const candidate = immutableRelease({ release: context.release, artifacts: context.artifacts, evidence: context.evidence }, context.project.id, target);
      const previous = context.previousRelease
        ? immutableRelease(context.previousRelease, context.project.id, target)
        : undefined;
      const coordinator = new WorkerPromotionCoordinator({
        projectId: context.project.id,
        target,
        adapter,
        ...(previous ? { releases: [previous, candidate] } : { releases: [candidate] }),
      });
      let local: PromotionRecord;
      try {
        local = await coordinator.promote({
          releaseId: candidate.release.id,
          idempotencyKey: `${context.executionIdempotencyKey}:provider`,
          actor: context.actor,
          expectedCurrentReleaseId: context.expectedCurrentReleaseId,
          kind: context.promotion.kind,
          ...(context.promotion.rollbackOfPromotionId ? { rollbackOfPromotionId: context.promotion.rollbackOfPromotionId } : {}),
        });
      } catch (error) {
        throw new PromotionExecutorProviderError(
          `Customer-operated Worker Target execution failed before a terminal Promotion result: ${error instanceof Error ? error.message : String(error)}`,
          "inspect the provider operation by the immutable execution identity before retrying",
          `promotion=${context.promotion.id}; providerResult=thrown; credentialMaterialStored=false`,
        );
      }
      return mapPromotionResult(context, local, coordinator.getTarget(), candidate);
    },
  };
}

export async function probePromotionExecutorProviderAuthorization(config: PromotionExecutorConfig): Promise<CloudflareWorkerCredentialObservation> {
  return config.credentialBroker.probe({ accountId: config.accountId, scriptName: config.scriptName, targetId: config.targetId });
}

export function createPromotionExecutorHandler(config: PromotionExecutorConfig): (request: Request) => Promise<Response> {
  let executor: ReturnType<typeof createPromotionExecutor>;
  try {
    executor = createPromotionExecutor(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return async () => jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: "executor_configuration_invalid", message, recoveryAction: "configure the signed Authority handoff and durable nonce store before binding the executor", receipt: "executor=config-invalid; providerInvocation=false; credentialMaterialStored=false" }, 503);
  }
  return async (request) => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/execute") {
      return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: "not_found", message: "Only POST /execute is exposed by the Promotion executor.", recoveryAction: "send the Authority handoff to POST /execute", receipt: "executor=customer-operated; operation=not-found; credentialMaterialStored=false" }, 404);
    }
    if (request.headers.get("x-anyam-promotion-protocol") !== PROMOTION_EXECUTOR_PROTOCOL) {
      return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: "protocol_required", message: "The internal Promotion execution protocol header is required.", recoveryAction: "invoke the Worker through the trusted Realm service binding", receipt: "executor=customer-operated; protocol=missing-or-mismatch; providerInvocation=false; credentialMaterialStored=false" }, 401);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: "invalid_json", message: "Promotion execution body must be valid JSON.", recoveryAction: "send the exact serialized Authority handoff context", receipt: "executor=customer-operated; body=invalid-json; providerInvocation=false; credentialMaterialStored=false" }, 422);
    }
    try {
      const context = validateContext(body, config);
      const nonce = request.headers.get("x-anyam-promotion-nonce")?.trim() ?? "";
      const expiresAt = request.headers.get("x-anyam-promotion-expires-at")?.trim() ?? "";
      const signature = request.headers.get("x-anyam-promotion-handoff")?.trim() ?? "";
      const keyId = request.headers.get("x-anyam-promotion-key-id")?.trim() ?? "";
      const handoffKey = keyId === config.handoffKeys.active.id ? config.handoffKeys.active : keyId === config.handoffKeys.previous?.id ? config.handoffKeys.previous : undefined;
      if (!nonce || !expiresAt || !signature || !handoffKey || !(await verifyPromotionHandoff({ context, nonce, expiresAt, signature, secret: handoffKey.secret, keyId }))) {
        return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: "handoff_invalid", message: "The Authority Promotion handoff is missing, expired, unknown-keyed, or invalid.", recoveryAction: "request a fresh signed one-time Authority handoff using the active handoff key ID; provider invocation was not attempted", receipt: `executor=handoff-invalid; keyId=${keyId || "missing"}; providerInvocation=false; credentialMaterialStored=false` }, 401);
      }
      if (!(await config.handoffNonceStore.claim({ nonce, expiresAt }))) {
        return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: "handoff_replayed", message: "The Authority Promotion handoff nonce has already been consumed.", recoveryAction: "request a fresh signed handoff for explicit reconciliation", receipt: "executor=handoff-replay; providerInvocation=false; credentialMaterialStored=false" }, 409);
      }
      const result = await executor.execute(context);
      return jsonResponse(result as unknown as Record<string, unknown>, result.status === "succeeded" ? 200 : result.status === "blocked" ? 409 : 503);
    } catch (error) {
      if (error instanceof PromotionExecutorInputError || error instanceof PromotionExecutorConfigurationError || error instanceof PromotionExecutorProviderError) {
        return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "blocked", code: error.name, message: error.message, recoveryAction: error.recoveryAction, receipt: error.receipt, credentialMaterialStored: false, canonicalWrite: false }, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ protocol: PROMOTION_EXECUTOR_PROTOCOL, status: "indeterminate", code: "executor_threw", message: `Promotion executor threw: ${message}`, recoveryAction: "inspect the provider operation by the immutable execution identity before retrying", receipt: "executor=customer-operated; providerResult=thrown; credentialMaterialStored=false; canonicalWrite=false" }, 503);
    }
  };
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
