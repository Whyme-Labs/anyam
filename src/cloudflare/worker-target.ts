import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type Artifact,
} from "../kernel/contracts.ts";
import {
  type DeliveryAdapterFailure,
  type DeliveryAdapterResult,
  type HealthObservation,
  type ImmutableRelease,
  type WorkerAdapterInput,
  type WorkerDeployment,
  type WorkerHealthInput,
  type WorkerPreview,
  type WorkerRollbackInput,
  type WorkerTarget,
  type WorkerTargetAdapter,
} from "../delivery/promotion.ts";
import { targetDeploymentProfile } from "../delivery/target-deployment.ts";
import type { TargetPreviewStrategy } from "../kernel/contracts.ts";
import {
  assertCloudflareWorkerVersionReadback,
  WorkerReleaseManifestError,
  workerReleaseManifestUploadMetadata,
  workerReleaseModuleContentType,
  type CloudflareWorkerVersionResources,
  type WorkerReleaseManifest,
} from "./worker-release-manifest.ts";

/**
 * Cloudflare's Worker Versions API is deliberately kept behind this module.
 * The delivery coordinator owns Anyam state; this adapter owns only provider
 * mechanics and returns provider identities plus digest-bound receipts.
 */
export const CLOUDFLARE_WORKER_TARGET_PROTOCOL = "anyam.cloudflare-worker-target/v1" as const;
export const CLOUDFLARE_WORKER_TARGET_ADAPTER_ID = "cloudflare.worker" as const;
export const CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE = "aud:anyam:deployment" as const;
export const CLOUDFLARE_WORKER_PROMOTION_AUDIENCE = "aud:anyam:promotion" as const;

export type CloudflareWorkerTargetOperation = "preview" | "apply" | "health" | "rollback" | "version-read" | "version-upload";

/**
 * The broker owns the real provider credential. The adapter receives it only
 * for the in-memory request and never puts it in a receipt, release, or
 * evidence object.
 */
export type CloudflareWorkerCredential = {
  token: string;
  credentialId: string;
  expiresAt: string;
  audience: typeof CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE | typeof CLOUDFLARE_WORKER_PROMOTION_AUDIENCE;
  /** Provider scopes observed or declared by the customer-owned broker. */
  scopes: readonly string[];
  /** The broker must have completed a provider authorization observation. */
  providerAuthorization: "observed";
  /** Provider-side operation identity for the authorization observation. */
  providerOperationId?: string;
  receipt: string;
};

export type CloudflareWorkerCredentialObservation = {
  credentialId: string;
  expiresAt: string;
  scopes: readonly string[];
  providerAuthorization: "observed";
  providerOperationId?: string;
  receipt: string;
};

export type CloudflareWorkerCredentialBroker = {
  issue(input: {
    accountId: string;
    scriptName: string;
    targetId: string;
    operation: CloudflareWorkerTargetOperation;
    audience: CloudflareWorkerCredential["audience"];
  }): Promise<CloudflareWorkerCredential>;
  probe(input: {
    accountId: string;
    scriptName: string;
    targetId: string;
  }): Promise<CloudflareWorkerCredentialObservation>;
};

export type CloudflareApiError = {
  code?: number;
  message: string;
};

export type CloudflareWorkerApiResponse<T> = {
  status: number;
  ok: boolean;
  result?: T;
  errors: readonly CloudflareApiError[];
  messages: readonly CloudflareApiError[];
};

export type CloudflareWorkerApiRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  token: string;
  body?: BodyInit;
  headers?: Readonly<Record<string, string>>;
};

export type CloudflareWorkerApiTransport = {
  request<T>(input: CloudflareWorkerApiRequest): Promise<CloudflareWorkerApiResponse<T>>;
};

export type CloudflareWorkerVersion = {
  id: string;
  metadata?: {
    hasPreview?: boolean;
    annotations?: {
      "workers/tag"?: string;
      "workers/message"?: string;
    };
    created_on?: string;
  };
  resources?: CloudflareWorkerVersionResources;
  readbackReceipt?: string;
  number?: number;
};

export type CloudflareWorkerVersionList = {
  items?: readonly CloudflareWorkerVersion[];
};

export type CloudflareWorkerDeployment = {
  id: string;
  versions: readonly { version_id: string; percentage: number }[];
  created_on?: string;
};

export type CloudflareWorkerTargetAdapterConfig = {
  accountId: string;
  scriptName: string;
  targetId: string;
  transport: CloudflareWorkerApiTransport;
  credentialBroker: CloudflareWorkerCredentialBroker;
  artifactReader: CloudflareWorkerArtifactReader;
  /** Builds the immutable provider manifest from the sealed Anyam Release. */
  workerReleaseManifest?: (input: { release: ImmutableRelease; target: WorkerTarget }) => WorkerReleaseManifest;
  /**
   * Cloudflare returns whether preview is available on a version, while the
   * workers.dev subdomain belongs to the customer account. Keeping URL
   * construction injected makes custom domains and customer-owned accounts
   * explicit instead of guessing them in the kernel.
   */
  previewUrlForVersion: (versionId: string) => string;
  /** Resolves non-version-url strategies to an explicit isolated/controlled route. */
  previewUrlForStrategy?: (input: { strategy: TargetPreviewStrategy; target: WorkerTarget; release: ImmutableRelease; providerVersionId: string }) => string | undefined;
  healthUrl: string | ((input: { target: WorkerTarget; deploymentId?: string; providerVersionId: string }) => string);
  /**
   * Validates the application response against the expected Release. A
   * provider route can briefly serve a previous version after deployment, so
   * HTTP 2xx alone is not sufficient evidence that this Release is serving.
   */
  healthResponseValidator?: CloudflareWorkerHealthResponseValidator;
  /**
   * Some provider routes are reachable only after a version upload or
   * deployment response has returned. This policy is deliberately opt-in and
   * status-specific: it is a readiness observation, not a replacement for a
   * real preview or production health check. The caller must provide the
   * measurement-backed tripwire.
  */
  routeReadinessRetry?: CloudflareWorkerRouteReadinessRetry;
  /**
   * Rollback verification may observe the candidate still serving briefly
   * after the rollback deployment is accepted. Keep this policy separate so
   * an expected candidate 503 is never retried into a false success.
   */
  rollbackRouteReadinessRetry?: CloudflareWorkerRouteReadinessRetry;
  fetch?: typeof fetch;
  now?: () => string;
  healthHeaders?: Readonly<Record<string, string>>;
  contractDigest?: string;
};

export type CloudflareWorkerArtifactReader = {
  read(artifact: Artifact): Promise<Uint8Array>;
};

export type CloudflareWorkerRouteReadinessRetry = {
  maxAttempts: number;
  delayMs: number;
  retryStatuses: readonly number[];
  /** Retry transient DNS/TLS/connection failures during route readiness. */
  retryTransportErrors?: boolean;
};

export type CloudflareWorkerHealthResponseValidator = (input: {
  status: number;
  body: Uint8Array;
  bodyDigest: string;
  release: ImmutableRelease;
  providerVersionId: string;
  phase: "candidate" | "rollback";
}) => {
  state: HealthObservation["state"];
  receipt: string;
};

export class CloudflareWorkerArtifactError extends Error {
  readonly code: "missing-output-path" | "digest-mismatch" | "read-failed";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: CloudflareWorkerArtifactError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "CloudflareWorkerArtifactError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

/** A filesystem reader is useful for local Actions and qualification scripts. */
export function createFilesystemWorkerArtifactReader(root: string): CloudflareWorkerArtifactReader {
  return {
    async read(artifact: Artifact): Promise<Uint8Array> {
      const outputPath = artifact.outputPath?.trim();
      if (!outputPath) {
        throw new CloudflareWorkerArtifactError({
          code: "missing-output-path",
          message: `Worker Artifact ${artifact.id} does not identify an output path.`,
          recoveryAction: "attach the exact verified Worker bundle output path to the Artifact before uploading a version",
          receipt: `artifact=${artifact.id}; outputPath=missing; providerMutation=false`,
        });
      }
      const [{ lstat, open, realpath }, { constants }, { isAbsolute, join, relative, resolve, sep }] = await Promise.all([
        import("node:fs/promises"),
        import("node:fs"),
        import("node:path"),
      ]);
      const rejectBoundary = (reason: string, message: string, recoveryAction = "restore a regular verified Artifact below the declared workspace root"): never => {
        throw new CloudflareWorkerArtifactError({
          code: "read-failed",
          message,
          recoveryAction,
          receipt: `artifact=${artifact.id}; outputPath=${outputPath}; reason=${reason}; providerMutation=false`,
        });
      };
      try {
        const normalizedPath = outputPath.replaceAll("\\", "/");
        if (normalizedPath.includes("\0") || isAbsolute(normalizedPath) || /^[A-Za-z]:\//u.test(normalizedPath)) {
          rejectBoundary("path-invalid", `Worker Artifact ${artifact.id} does not use a workspace-relative output path.`, "use a relative output path below the Artifact root");
        }
        const absoluteRoot = await realpath(resolve(root));
        const rootStat = await lstat(absoluteRoot);
        if (!rootStat.isDirectory()) rejectBoundary("root-not-directory", `Worker Artifact ${artifact.id} root is not a directory.`);
        const absolutePath = resolve(absoluteRoot, normalizedPath);
        const relativePath = relative(absoluteRoot, absolutePath);
        if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
          rejectBoundary("outside-root", `Worker Artifact ${artifact.id} resolves outside the declared workspace.`, "use a workspace-relative output path below the Artifact root");
        }
        const segments = relativePath.split(sep).filter((segment) => segment.length > 0);
        if (segments.some((segment) => segment.toLocaleLowerCase() === ".git")) {
          rejectBoundary("git-metadata", `Worker Artifact ${artifact.id} points into Git metadata.`, "publish a Worker Artifact outside the repository's .git metadata");
        }
        let cursor = absoluteRoot;
        for (const [index, segment] of segments.entries()) {
          cursor = join(cursor, segment);
          const entry = await lstat(cursor);
          if (entry.isSymbolicLink()) rejectBoundary("symlink", `Worker Artifact ${artifact.id} contains a symlink path component.`);
          if (index < segments.length - 1 && !entry.isDirectory()) rejectBoundary("non-directory", `Worker Artifact ${artifact.id} contains a non-directory path component.`);
          if (index === segments.length - 1 && !entry.isFile()) rejectBoundary("non-regular", `Worker Artifact ${artifact.id} is not a regular file.`);
        }
        const resolvedPath = await realpath(absolutePath);
        const resolvedRelativePath = relative(absoluteRoot, resolvedPath);
        if (resolvedRelativePath.startsWith(`..${sep}`) || resolvedRelativePath === "..") {
          rejectBoundary("symlink", `Worker Artifact ${artifact.id} resolves outside the declared workspace.`);
        }
        const noFollow = constants.O_NOFOLLOW ?? 0;
        const nonBlocking = constants.O_NONBLOCK ?? 0;
        const handle = await open(absolutePath, constants.O_RDONLY | noFollow | nonBlocking);
        let bytes: Uint8Array;
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) rejectBoundary("non-regular", `Worker Artifact ${artifact.id} is not a regular file.`);
          bytes = new Uint8Array(await handle.readFile());
        } finally {
          await handle.close();
        }
        const actualDigest = sha256(bytes);
        if (actualDigest !== artifact.digest) {
          throw new CloudflareWorkerArtifactError({
            code: "digest-mismatch",
            message: `Worker Artifact ${artifact.id} changed after verification.`,
            recoveryAction: "restore the exact verified Artifact bytes and retry without rebuilding the Release",
            receipt: `artifact=${artifact.id}; outputPath=${outputPath}; bytes=${bytes.byteLength}; expectedDigest=${artifact.digest}; actualDigest=${actualDigest}; providerMutation=false`,
          });
        }
        return bytes;
      } catch (error) {
        if (error instanceof CloudflareWorkerArtifactError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new CloudflareWorkerArtifactError({
          code: "read-failed",
          message: `Worker Artifact ${artifact.id} could not be read: ${message}`,
          recoveryAction: "restore the verified Artifact output in the workspace and retry",
          receipt: `artifact=${artifact.id}; outputPath=${outputPath}; reason=filesystem-error; providerMutation=false`,
        });
      }
    },
  };
}

/** A digest-checked reader for tests, R2 adapters, and other object stores. */
export function createMapWorkerArtifactReader(contents: ReadonlyMap<string, Uint8Array>): CloudflareWorkerArtifactReader {
  return {
    async read(artifact: Artifact): Promise<Uint8Array> {
      const bytes = contents.get(artifact.digest);
      if (!bytes) {
        throw new CloudflareWorkerArtifactError({
          code: "read-failed",
          message: `Worker Artifact ${artifact.id} is absent from the configured object store.`,
          recoveryAction: "restore the exact digest-addressed Artifact before retrying",
          receipt: `artifact=${artifact.id}; digest=${artifact.digest}; object=absent; providerMutation=false`,
        });
      }
      const actualDigest = sha256(bytes);
      if (actualDigest !== artifact.digest) {
        throw new CloudflareWorkerArtifactError({
          code: "digest-mismatch",
          message: `Worker Artifact ${artifact.id} failed the object-store digest check.`,
          recoveryAction: "restore the exact verified Artifact bytes and retry without rebuilding the Release",
          receipt: `artifact=${artifact.id}; expectedDigest=${artifact.digest}; actualDigest=${actualDigest}; providerMutation=false`,
        });
      }
      return new Uint8Array(bytes);
    },
  };
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function tagForRelease(release: ImmutableRelease): string {
  return `anyam-${release.releaseDigest.replace(/^sha256:/, "")}`;
}

function providerErrors(response: CloudflareWorkerApiResponse<unknown>): string {
  return [...response.errors, ...response.messages].map((error) => `${error.code ?? "unknown"}:${error.message}`).join(" | ") || `http-${response.status}`;
}

function routeReadinessReceipt(retry: CloudflareWorkerRouteReadinessRetry | undefined, attempts: number): string {
  if (!retry) return `routeReadinessAttempts=${attempts}`;
  return `routeReadinessAttempts=${attempts}; routeReadinessMaxAttempts=${retry.maxAttempts}; routeReadinessDelayMs=${retry.delayMs}; routeReadinessStatuses=${retry.retryStatuses.join(",")}; routeReadinessRetryTransportErrors=${retry.retryTransportErrors === true}`;
}

function validateRouteReadinessRetry(retry: CloudflareWorkerRouteReadinessRetry, name: string): void {
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) {
    throw new Error(`${name}.maxAttempts must be a positive integer; received ${retry.maxAttempts}`);
  }
  if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
    throw new Error(`${name}.delayMs must be a non-negative finite number; received ${retry.delayMs}`);
  }
  if (retry.retryStatuses.length === 0) {
    throw new Error(`${name}.retryStatuses must contain at least one HTTP status`);
  }
}

function validateHealthResponse(input: {
  operation: "preview" | "health";
  status: number;
  body: Uint8Array;
  bodyDigest: string;
  release: ImmutableRelease;
  providerVersionId: string;
  phase: "candidate" | "rollback";
  validator?: CloudflareWorkerHealthResponseValidator;
}): { state: HealthObservation["state"]; receipt: string } | DeliveryAdapterFailure {
  const statusHealthy = input.status >= 200 && input.status < 300;
  if (!input.validator) {
    return {
      state: statusHealthy ? "healthy" : "unhealthy",
      receipt: `healthValidation=provider-status-only; status=${input.status}`,
    };
  }
  try {
    const validation = input.validator({
      status: input.status,
      body: input.body,
      bodyDigest: input.bodyDigest,
      release: input.release,
      providerVersionId: input.providerVersionId,
      phase: input.phase,
    });
    if (!validation || !["healthy", "unhealthy", "unknown"].includes(validation.state) || typeof validation.receipt !== "string" || validation.receipt.trim().length === 0) {
      throw new Error("health response validator returned an incomplete result");
    }
    return {
      // A validator cannot turn a non-2xx provider response into healthy.
      state: statusHealthy ? validation.state : validation.state === "unknown" ? "unknown" : "unhealthy",
      receipt: validation.receipt,
    };
  } catch (error) {
    return failure({
      operation: input.operation,
      code: "health.response-invalid",
      message: `Cloudflare Worker health response validation failed: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
      recoveryAction: "repair the Worker health response contract so it identifies the expected Release, then retry without changing the immutable Release",
      receipt: `providerVersionId=${input.providerVersionId}; releaseDigest=${input.release.releaseDigest}; phase=${input.phase}; httpStatus=${input.status}; bodyDigest=${input.bodyDigest}; credentialMaterialStored=false`,
    });
  }
}

function failure(input: {
  operation: CloudflareWorkerTargetOperation;
  code: string;
  message: string;
  outcome?: DeliveryAdapterFailure["outcome"];
  retryable?: boolean;
  recoveryAction: string;
  receipt: string;
}): DeliveryAdapterFailure {
  return {
    status: "failed",
    outcome: input.outcome ?? "failed",
    errorCode: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    recoveryAction: input.recoveryAction,
    receipt: `provider=cloudflare-workers; operation=${input.operation}; ${input.receipt}`,
  };
}

function isMutation(operation: CloudflareWorkerTargetOperation): boolean {
  return operation === "preview" || operation === "apply" || operation === "rollback" || operation === "version-upload";
}

function audienceFor(operation: CloudflareWorkerTargetOperation): CloudflareWorkerCredential["audience"] {
  return operation === "apply" || operation === "rollback" ? CLOUDFLARE_WORKER_PROMOTION_AUDIENCE : CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE;
}

function operationPath(accountId: string, scriptName: string, suffix: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(scriptName)}${suffix}`;
}

function responseResult<T>(response: CloudflareWorkerApiResponse<T>, operation: CloudflareWorkerTargetOperation): T | DeliveryAdapterFailure {
  if (response.ok && response.result !== undefined) return response.result;
  return failure({
    operation,
    code: `cloudflare.http_${response.status}`,
    message: `Cloudflare Workers ${operation} failed: ${providerErrors(response)}`,
    outcome: isMutation(operation) && response.status >= 500 ? "indeterminate" : "failed",
    retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
    recoveryAction: isMutation(operation)
      ? "inspect the provider version/deployment by its receipt before retrying the same immutable operation"
      : "inspect the named Worker Target and retry the health observation",
    receipt: `httpStatus=${response.status}; providerOperation=not-returned`,
  });
}

function credentialReceipt(credential: CloudflareWorkerCredential): string {
  return `credentialId=${credential.credentialId}; credentialExpiresAt=${credential.expiresAt}; credentialScopes=${credential.scopes.join(",") || "none"}; providerAuthorization=${credential.providerAuthorization}; ${credential.providerOperationId ? `credentialProviderOperationId=${credential.providerOperationId}; ` : ""}credentialMaterialStored=false`;
}

function responseResultWithCredential<T>(response: CloudflareWorkerApiResponse<T>, operation: CloudflareWorkerTargetOperation, credential: CloudflareWorkerCredential): T | DeliveryAdapterFailure {
  const result = responseResult(response, operation);
  if (!isFailure(result)) return result;
  const authorizationFailure = response.status === 401 || response.status === 403;
  return {
    ...result,
    message: authorizationFailure
      ? `${result.message} The brokered provider credential was rejected after authorization was observed.`
      : result.message,
    recoveryAction: authorizationFailure
      ? "refresh or rotate the customer-owned broker credential, re-probe provider authorization, and retry the same immutable operation only after the credential is observed active"
      : result.recoveryAction,
    receipt: `${result.receipt}; ${credentialReceipt(credential)}; providerAuthorization=${authorizationFailure ? "rejected-after-observation" : credential.providerAuthorization}`,
  };
}

function credentialMetadataSafe(value: string, field: string): boolean {
  if (/(?:cfat_[A-Za-z0-9]+|bearer\s+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=])/iu.test(value)) {
    throw new Error(`credential broker returned credential material in ${field}`);
  }
  return true;
}

function targetBindingFailure(operation: CloudflareWorkerTargetOperation, target: WorkerTarget, configuredTargetId: string): DeliveryAdapterFailure | undefined {
  if (target.id === configuredTargetId) return undefined;
  return failure({
    operation,
    code: "target.binding",
    message: `Cloudflare Worker Target adapter received ${target.id}, but is bound to ${configuredTargetId}.`,
    recoveryAction: "route the exact Target operation to its customer-owned adapter and broker",
    receipt: `target=${target.id}; configuredTarget=${configuredTargetId}; providerMutation=false; credentialMaterialStored=false`,
  });
}

function isFailure<T>(value: T | DeliveryAdapterFailure): value is DeliveryAdapterFailure {
  return typeof value === "object" && value !== null && "status" in value && (value as { status?: unknown }).status === "failed";
}

function deploymentBody(versionId: string, message: string): string {
  return JSON.stringify({
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: versionId }],
    annotations: { "workers/message": message },
  });
}

function previewUrlForStrategy(config: CloudflareWorkerTargetAdapterConfig, input: WorkerAdapterInput, version: CloudflareWorkerVersion): string | DeliveryAdapterFailure {
  const strategy = targetDeploymentProfile(input.target).previewStrategy;
  if (strategy.kind === "version-url") {
    if (version.metadata?.hasPreview === false) {
      return failure({ operation: "preview", code: "preview.unavailable", message: `Cloudflare version ${version.id} does not expose a version preview URL.`, recoveryAction: "configure an isolated-target, custom-domain-version-override, or staging-only Preview Strategy for this Target", receipt: `providerVersionId=${version.id}; previewStrategy=version-url; providerPreview=false; providerMutation=false` });
    }
    return config.previewUrlForVersion(version.id);
  }
  if (!config.previewUrlForStrategy) {
    return failure({ operation: "preview", code: "preview.strategy-unconfigured", message: `Target ${input.target.id} declares Preview Strategy ${strategy.kind} without an execution route.`, recoveryAction: "configure an explicit previewUrlForStrategy for the Target or keep the Promotion blocked", receipt: `target=${input.target.id}; previewStrategy=${strategy.kind}; route=missing; providerMutation=false` });
  }
  const url = config.previewUrlForStrategy({ strategy, target: input.target, release: input.release, providerVersionId: version.id });
  if (!url || url.trim().length === 0) {
    return failure({ operation: "preview", code: "preview.strategy-unavailable", message: `Target ${input.target.id} Preview Strategy ${strategy.kind} did not produce a health URL.`, recoveryAction: "materialize the isolated preview Target or required Evidence route before retrying", receipt: `target=${input.target.id}; previewStrategy=${strategy.kind}; route=unavailable; providerMutation=false` });
  }
  return url;
}

export class CloudflareWorkerTargetAdapter implements WorkerTargetAdapter {
  readonly protocol = CONTRACT_VERSIONS.targetAdapter;
  readonly id = CLOUDFLARE_WORKER_TARGET_ADAPTER_ID;
  readonly contractDigest: string;
  private readonly now: () => string;
  private readonly fetcher: typeof fetch;
  private readonly versionsByPromotion = new Map<string, CloudflareWorkerVersion>();
  private readonly deploymentsById = new Map<string, string>();

  constructor(private readonly config: CloudflareWorkerTargetAdapterConfig) {
    required(config.accountId, "accountId");
    required(config.scriptName, "scriptName");
    required(config.targetId, "targetId");
    if (typeof config.previewUrlForVersion !== "function") throw new Error("previewUrlForVersion is required");
    if (config.routeReadinessRetry) {
      validateRouteReadinessRetry(config.routeReadinessRetry, "routeReadinessRetry");
    }
    if (config.rollbackRouteReadinessRetry) validateRouteReadinessRetry(config.rollbackRouteReadinessRetry, "rollbackRouteReadinessRetry");
    this.now = config.now ?? (() => new Date().toISOString());
    this.fetcher = config.fetch ?? fetch;
    this.contractDigest = config.contractDigest ?? digest({
      protocol: CLOUDFLARE_WORKER_TARGET_PROTOCOL,
      adapter: CLOUDFLARE_WORKER_TARGET_ADAPTER_ID,
      api: "workers-scripts-versions-and-deployments",
      releaseManifest: "anyam.worker-release-manifest/v1",
      providerReadback: "version-detail-required",
      credentialAudiences: [CLOUDFLARE_WORKER_DEPLOYMENT_AUDIENCE, CLOUDFLARE_WORKER_PROMOTION_AUDIENCE],
    });
  }

  async preview(input: WorkerAdapterInput): Promise<DeliveryAdapterResult<WorkerPreview>> {
    const targetBinding = targetBindingFailure("preview", input.target, this.config.targetId);
    if (targetBinding) return targetBinding;
    const version = await this.ensureVersion(input, "preview");
    if (isFailure(version)) return version;
    const previewUrl = previewUrlForStrategy(this.config, input, version);
    if (isFailure(previewUrl)) return previewUrl;
    const previewResponse = await this.fetchHealth(previewUrl, this.config.routeReadinessRetry, "preview");
    if (isFailure(previewResponse)) return previewResponse;
    const validation = validateHealthResponse({
      operation: "preview",
      status: previewResponse.status,
      body: previewResponse.body,
      bodyDigest: previewResponse.bodyDigest,
      release: input.release,
      providerVersionId: version.id,
      phase: "candidate",
      ...(this.config.healthResponseValidator ? { validator: this.config.healthResponseValidator } : {}),
    });
    if (isFailure(validation)) return validation;
    if (validation.state !== "healthy") {
      return failure({
        operation: "preview",
        code: "preview.unhealthy",
        message: `Cloudflare Worker preview was not health-verified for Release ${input.release.release.id}.`,
        retryable: true,
        recoveryAction: "inspect the preview Worker response and publish a new verified Release only after the preview is healthy",
        receipt: `providerVersionId=${version.id}; previewUrl=${previewUrl}; httpStatus=${previewResponse.status}; bodyDigest=${previewResponse.bodyDigest}; providerOperationId=preview:${version.id}; ${validation.receipt}; ${routeReadinessReceipt(this.config.routeReadinessRetry, previewResponse.attempts)}; credentialMaterialStored=false`,
      });
    }
    const previewOperationId = `preview:${version.id}`;
    const receipt = `provider=cloudflare-workers; operation=preview; providerOperationId=${previewOperationId}; providerVersionId=${version.id}; previewUrl=${previewUrl}; previewHttpStatus=${previewResponse.status}; releaseDigest=${input.release.releaseDigest}; artifactDigest=${input.release.artifacts.map((artifact) => artifact.digest).join(",")}; ${validation.receipt}; ${routeReadinessReceipt(this.config.routeReadinessRetry, previewResponse.attempts)}; credentialMaterialStored=false`;
    return {
      status: "succeeded",
      value: {
        previewId: previewOperationId,
        providerVersionId: version.id,
        releaseDigest: input.release.releaseDigest,
        artifactDigests: input.release.artifacts.map((artifact) => artifact.digest),
        receipt,
      },
      receipt,
    };
  }

  async apply(input: WorkerAdapterInput): Promise<DeliveryAdapterResult<WorkerDeployment>> {
    const targetBinding = targetBindingFailure("apply", input.target, this.config.targetId);
    if (targetBinding) return targetBinding;
    const version = await this.ensureVersion(input, "apply");
    if (isFailure(version)) return version;
    const operation = "apply" as const;
    const credential = await this.issueCredential(operation);
    if (isFailure(credential)) return credential;
    const path = operationPath(this.config.accountId, this.config.scriptName, "/deployments");
    let response: CloudflareWorkerApiResponse<CloudflareWorkerDeployment>;
    try {
      response = await this.config.transport.request<CloudflareWorkerDeployment>({
        method: "POST",
        path,
        token: credential.token,
        headers: { "content-type": "application/json" },
        body: deploymentBody(version.id, `Anyam Release ${input.release.release.id}`),
      });
    } catch (error) {
      return failure({ operation, code: "cloudflare.transport", message: `Cloudflare Worker deployment transport failed: ${error instanceof Error ? error.message : String(error)}`, outcome: "indeterminate", retryable: true, recoveryAction: "inspect the deployment by its Release tag before retrying the same immutable promotion", receipt: `providerVersionId=${version.id}; credentialMaterialStored=false` });
    }
    const result = responseResultWithCredential(response, operation, credential);
    if (isFailure(result)) return result;
    this.deploymentsById.set(result.id, version.id);
    const providerOperationId = `deployment:${result.id}`;
    const receipt = `provider=cloudflare-workers; operation=apply; providerOperationId=${providerOperationId}; providerVersionId=${version.id}; releaseDigest=${input.release.releaseDigest}; artifactDigest=${input.release.artifacts.map((artifact) => artifact.digest).join(",")}; credentialMaterialStored=false`;
    return {
      status: "succeeded",
      value: {
        deploymentId: result.id,
        providerVersionId: version.id,
        releaseDigest: input.release.releaseDigest,
        artifactDigests: input.release.artifacts.map((artifact) => artifact.digest),
        providerOperationId,
        receipt,
      },
      receipt,
    };
  }

  async health(input: WorkerHealthInput): Promise<DeliveryAdapterResult<HealthObservation>> {
    const targetBinding = targetBindingFailure("health", input.target, this.config.targetId);
    if (targetBinding) return targetBinding;
    const version = await this.versionForRelease(input.release, input.target, "health");
    if (isFailure(version)) return version;
    const healthUrl = typeof this.config.healthUrl === "string"
      ? this.config.healthUrl
      : this.config.healthUrl({ target: input.target, ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}), providerVersionId: version.id });
    const routeReadinessRetry = input.phase === "rollback"
      ? this.config.rollbackRouteReadinessRetry ?? this.config.routeReadinessRetry
      : this.config.routeReadinessRetry;
    const response = await this.fetchHealth(healthUrl, routeReadinessRetry, "health");
    if (isFailure(response)) return response;
    const phase = input.phase ?? "candidate";
    const validation = validateHealthResponse({
      operation: "health",
      status: response.status,
      body: response.body,
      bodyDigest: response.bodyDigest,
      release: input.release,
      providerVersionId: version.id,
      phase,
      ...(this.config.healthResponseValidator ? { validator: this.config.healthResponseValidator } : {}),
    });
    if (isFailure(validation)) return validation;
    const state = validation.state;
    const operationId = `health:${version.id}:${digest({ status: response.status, bodyDigest: response.bodyDigest })}`;
    const receipt = `provider=cloudflare-workers; operation=health; providerOperationId=${operationId}; providerVersionId=${version.id}; deploymentId=${input.deploymentId ?? "not-provided"}; phase=${phase}; url=${healthUrl}; httpStatus=${response.status}; bodyDigest=${response.bodyDigest}; releaseDigest=${input.release.releaseDigest}; ${validation.receipt}; ${routeReadinessReceipt(routeReadinessRetry, response.attempts)}; credentialMaterialStored=false`;
    return {
      status: "succeeded",
      value: {
        protocol: CONTRACT_VERSIONS.healthObservation,
        id: operationId,
        targetId: input.target.id,
        releaseId: input.release.release.id,
        state,
        checkId: "cloudflare-worker:http-health",
        checkedAt: this.now(),
        receipt,
        outputDigest: response.bodyDigest,
      },
      receipt,
    };
  }

  async rollback(input: WorkerRollbackInput): Promise<DeliveryAdapterResult<WorkerDeployment>> {
    const targetBinding = targetBindingFailure("rollback", input.target, this.config.targetId);
    if (targetBinding) return targetBinding;
    const previousVersion = await this.versionForRelease(input.previousRelease, input.target, "rollback");
    if (isFailure(previousVersion)) return previousVersion;
    const operation = "rollback" as const;
    const credential = await this.issueCredential(operation);
    if (isFailure(credential)) return credential;
    const path = operationPath(this.config.accountId, this.config.scriptName, "/deployments");
    let response: CloudflareWorkerApiResponse<CloudflareWorkerDeployment>;
    try {
      response = await this.config.transport.request<CloudflareWorkerDeployment>({
        method: "POST",
        path,
        token: credential.token,
        headers: { "content-type": "application/json" },
        body: deploymentBody(previousVersion.id, `Anyam rollback to Release ${input.previousRelease.release.id}`),
      });
    } catch (error) {
      return failure({ operation, code: "cloudflare.transport", message: `Cloudflare Worker rollback transport failed: ${error instanceof Error ? error.message : String(error)}`, outcome: "indeterminate", retryable: true, recoveryAction: "inspect the active deployment and previous Release version before retrying rollback", receipt: `providerVersionId=${previousVersion.id}; credentialMaterialStored=false` });
    }
    const result = responseResultWithCredential(response, operation, credential);
    if (isFailure(result)) return result;
    this.deploymentsById.set(result.id, previousVersion.id);
    const providerOperationId = `deployment:${result.id}`;
    const receipt = `provider=cloudflare-workers; operation=rollback; providerOperationId=${providerOperationId}; providerVersionId=${previousVersion.id}; releaseDigest=${input.previousRelease.releaseDigest}; artifactDigest=${input.previousRelease.artifacts.map((artifact) => artifact.digest).join(",")}; credentialMaterialStored=false`;
    return {
      status: "succeeded",
      value: {
        deploymentId: result.id,
        providerVersionId: previousVersion.id,
        releaseDigest: input.previousRelease.releaseDigest,
        artifactDigests: input.previousRelease.artifacts.map((artifact) => artifact.digest),
        providerOperationId,
        receipt,
      },
      receipt,
    };
  }

  private async issueCredential(operation: CloudflareWorkerTargetOperation): Promise<CloudflareWorkerCredential | DeliveryAdapterFailure> {
    try {
      const credential = await this.config.credentialBroker.issue({ accountId: this.config.accountId, scriptName: this.config.scriptName, targetId: this.config.targetId, operation, audience: audienceFor(operation) });
      if (!credential.token || !credential.credentialId || !credential.expiresAt || !credential.receipt || credential.providerAuthorization !== "observed" || !Array.isArray(credential.scopes)) throw new Error("credential broker returned an incomplete observed credential receipt");
      credentialMetadataSafe(credential.credentialId, "credentialId");
      credentialMetadataSafe(credential.expiresAt, "expiresAt");
      credentialMetadataSafe(credential.receipt, "receipt");
      credential.scopes.forEach((scope) => { if (typeof scope !== "string" || scope.trim().length === 0) throw new Error("credential broker returned an invalid scope"); credentialMetadataSafe(scope, "scope"); });
      if (credential.audience !== audienceFor(operation)) throw new Error(`credential audience ${credential.audience} does not match ${audienceFor(operation)}`);
      const expiry = Date.parse(credential.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.parse(this.now())) throw new Error(`credential ${credential.credentialId} is expired or has an invalid provider expiry observation`);
      return credential;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const authorization = /revoked|expired|unauthorized|forbidden|scope|authorization/iu.test(message) ? "providerAuthorization=rejected" : "providerAuthorization=unobserved";
      return failure({ operation, code: "credential.broker", message: `Cloudflare Worker credential brokering failed: ${message}`, retryable: true, recoveryAction: "refresh or rotate the customer-owned broker credential, re-probe provider authorization, and retry without changing the immutable Release", receipt: `${authorization}; providerMutation=false; credentialMaterialStored=false` });
    }
  }

  private workerManifest(release: ImmutableRelease, target: WorkerTarget, operation: CloudflareWorkerTargetOperation): WorkerReleaseManifest | DeliveryAdapterFailure {
    if (typeof this.config.workerReleaseManifest !== "function") {
      return failure({ operation, code: "manifest.missing", message: `Cloudflare Worker Release ${release.release.id} has no immutable Worker Release Manifest builder.`, recoveryAction: "configure a Worker Release Manifest covering modules, assets, compatibility, bindings, migrations, and health identity before provider upload", receipt: `releaseDigest=${release.releaseDigest}; manifest=missing; providerMutation=false` });
    }
    try {
      const manifest = this.config.workerReleaseManifest({ release, target });
      if (manifest.protocol !== "anyam.worker-release-manifest/v1" || !manifest.digest || manifest.modules.length === 0 || manifest.modules[0]?.name !== manifest.mainModule) throw new WorkerReleaseManifestError({ code: "invalid", message: `Worker Release Manifest for ${release.release.id} is incomplete.`, recoveryAction: "return a digest-bound manifest with a main module and complete provider inputs", receipt: `releaseDigest=${release.releaseDigest}; manifest=invalid; providerMutation=false` });
      const artifactDigests = new Set(release.artifacts.map((artifact) => artifact.digest));
      const missing = manifest.modules.find((module) => !artifactDigests.has(module.digest));
      if (missing) throw new WorkerReleaseManifestError({ code: "artifact-missing", message: `Worker Release Manifest module ${missing.name} is not present in the sealed Release.`, recoveryAction: "bind every manifest module to an exact verified Release Artifact before provider upload", receipt: `releaseDigest=${release.releaseDigest}; module=${missing.name}; artifactDigest=${missing.digest}; manifest=invalid; providerMutation=false` });
      return manifest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure({ operation, code: "manifest.invalid", message, recoveryAction: "repair the immutable Worker Release Manifest and retry without changing the Release", receipt: `releaseDigest=${release.releaseDigest}; manifest=invalid; providerMutation=false` });
    }
  }

  private async readVersionDetail(version: CloudflareWorkerVersion, manifest: WorkerReleaseManifest, operation: CloudflareWorkerTargetOperation): Promise<CloudflareWorkerVersion | DeliveryAdapterFailure> {
    const credential = await this.issueCredential("version-read");
    if (isFailure(credential)) return credential;
    let response: CloudflareWorkerApiResponse<CloudflareWorkerVersion>;
    try {
      response = await this.config.transport.request<CloudflareWorkerVersion>({
        method: "GET",
        path: `${operationPath(this.config.accountId, this.config.scriptName, `/versions/${encodeURIComponent(version.id)}`)}`,
        token: credential.token,
      });
    } catch (error) {
      return failure({ operation, code: "cloudflare.readback.transport", message: `Cloudflare Worker version read-back transport failed: ${error instanceof Error ? error.message : String(error)}`, outcome: "indeterminate", retryable: true, recoveryAction: "inspect the exact provider version detail and retry the same immutable Release operation", receipt: `providerVersionId=${version.id}; manifestDigest=${manifest.digest}; readback=indeterminate; credentialMaterialStored=false` });
    }
    const detail = responseResultWithCredential(response, operation, credential);
    if (isFailure(detail)) return detail;
    try {
      const receipt = assertCloudflareWorkerVersionReadback({ manifest, version: detail });
      return { ...version, ...detail, resources: detail.resources, metadata: detail.metadata, readbackReceipt: receipt } as CloudflareWorkerVersion;
    } catch (error) {
      const manifestError = error instanceof WorkerReleaseManifestError ? error : undefined;
      return failure({ operation, code: `cloudflare.readback.${manifestError?.code ?? "invalid"}`, message: error instanceof Error ? error.message : String(error), recoveryAction: manifestError?.recoveryAction ?? "reconcile provider version detail before deployment", receipt: `${manifestError?.receipt ?? `providerVersionId=${version.id}; manifestDigest=${manifest.digest}; readback=invalid`}; credentialMaterialStored=false` });
    }
  }

  private async ensureVersion(input: WorkerAdapterInput, operation: "preview" | "apply"): Promise<CloudflareWorkerVersion | DeliveryAdapterFailure> {
    const manifest = this.workerManifest(input.release, input.target, operation);
    if (isFailure(manifest)) return manifest;
    const existing = await this.versionForRelease(input.release, input.target, operation, manifest);
    if (!isFailure(existing)) return existing;
    if (!existing.errorCode.endsWith("not-found") && existing.errorCode !== "cloudflare.http_404") return existing;
    const artifactsByDigest = new Map(input.release.artifacts.map((artifact) => [artifact.digest, artifact]));
    const form = new FormData();
    form.append("metadata", JSON.stringify(workerReleaseManifestUploadMetadata(manifest, input.release.release.id, tagForRelease(input.release))));
    for (const module of manifest.modules) {
      const artifact = artifactsByDigest.get(module.digest);
      if (!artifact) return failure({ operation, code: "manifest.artifact-missing", message: `Worker Release Manifest module ${module.name} is not bound to a sealed Artifact.`, recoveryAction: "bind every manifest module to an exact verified Release Artifact before provider upload", receipt: `releaseDigest=${input.release.releaseDigest}; module=${module.name}; artifactDigest=${module.digest}; providerMutation=false` });
      let bytes: Uint8Array;
      try {
        bytes = await this.config.artifactReader.read(artifact);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure({ operation, code: "artifact.read", message, recoveryAction: "restore the exact verified Worker Artifact and retry without rebuilding the Release", receipt: `artifactDigest=${artifact.digest}; providerMutation=false` });
      }
      form.append(module.name, new Blob([Buffer.from(bytes)], { type: workerReleaseModuleContentType(module.type) }), module.name);
    }
    const credential = await this.issueCredential("version-upload");
    if (isFailure(credential)) return credential;
    let response: CloudflareWorkerApiResponse<CloudflareWorkerVersion>;
    try {
      response = await this.config.transport.request<CloudflareWorkerVersion>({
        method: "POST",
        path: operationPath(this.config.accountId, this.config.scriptName, "/versions"),
        token: credential.token,
        body: form,
      });
    } catch (error) {
      return failure({ operation, code: "cloudflare.transport", message: `Cloudflare Worker version upload transport failed: ${error instanceof Error ? error.message : String(error)}`, outcome: "indeterminate", retryable: true, recoveryAction: "list Worker versions by the Anyam Release tag before retrying the same immutable operation", receipt: `manifestDigest=${manifest.digest}; providerMutation=unknown; credentialMaterialStored=false` });
    }
    const result = responseResultWithCredential(response, operation, credential);
    if (isFailure(result)) return result;
    if (!result.id) return failure({ operation, code: "cloudflare.response", message: "Cloudflare accepted the Worker version request without returning a version identity.", outcome: "indeterminate", retryable: true, recoveryAction: "inspect the Worker versions list and reconcile the version tagged with this Release digest", receipt: `manifestDigest=${manifest.digest}; providerMutation=accepted; providerVersionId=missing` });
    const verified = await this.readVersionDetail(result, manifest, operation);
    if (isFailure(verified)) return verified;
    this.versionsByPromotion.set(input.release.releaseDigest, verified);
    return verified;
  }

  private async versionForRelease(release: ImmutableRelease, target: WorkerTarget, operation: CloudflareWorkerTargetOperation, expectedManifest?: WorkerReleaseManifest): Promise<CloudflareWorkerVersion | DeliveryAdapterFailure> {
    const cached = this.versionsByPromotion.get(release.releaseDigest);
    if (cached) return cached;
    const manifest = expectedManifest ?? this.workerManifest(release, target, operation);
    if (isFailure(manifest)) return manifest;
    const credential = await this.issueCredential("version-read");
    if (isFailure(credential)) return credential;
    let response: CloudflareWorkerApiResponse<CloudflareWorkerVersionList>;
    try {
      response = await this.config.transport.request<CloudflareWorkerVersionList>({
        method: "GET",
        path: `${operationPath(this.config.accountId, this.config.scriptName, "/versions")}?per_page=100`,
        token: credential.token,
      });
    } catch (error) {
      return failure({ operation, code: "cloudflare.transport", message: `Cloudflare Worker version lookup transport failed: ${error instanceof Error ? error.message : String(error)}`, outcome: "indeterminate", retryable: true, recoveryAction: "inspect provider reachability and retry the same immutable Release operation", receipt: "providerOperation=version-list; credentialMaterialStored=false" });
    }
    const result = responseResultWithCredential(response, operation, credential);
    if (isFailure(result)) return result;
    const tag = tagForRelease(release);
    const version = (result.items ?? []).find((candidate) => candidate.metadata?.annotations?.["workers/tag"] === tag);
    if (!version) return failure({ operation, code: "cloudflare.version-not-found", message: `Cloudflare Worker version for Release ${release.release.id} was not found by its immutable tag.`, recoveryAction: "upload the exact verified Release Artifact or reconcile the provider version list before retrying", receipt: `releaseDigest=${release.releaseDigest}; tag=${tag}; providerOperation=version-list; found=false` });
    const verified = await this.readVersionDetail(version, manifest, operation);
    if (isFailure(verified)) return verified;
    this.versionsByPromotion.set(release.releaseDigest, verified);
    return verified;
  }

  private async fetchHealth(url: string, retry: CloudflareWorkerRouteReadinessRetry | undefined, operation: "preview" | "health"): Promise<{ status: number; body: Uint8Array; bodyDigest: string; attempts: number } | DeliveryAdapterFailure> {
    const maxAttempts = retry?.maxAttempts ?? 1;
    const retryStatuses = new Set(retry?.retryStatuses ?? []);
    for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
      try {
        const response = await this.fetcher(url, { method: "GET", ...(this.config.healthHeaders ? { headers: this.config.healthHeaders } : {}) });
        const body = new Uint8Array(await response.arrayBuffer());
        const observation = { status: response.status, body, bodyDigest: sha256(body), attempts };
        if (attempts === maxAttempts || !retryStatuses.has(response.status)) return observation;
        if (retry?.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, retry.delayMs));
      } catch (error) {
        if (retry?.retryTransportErrors === true && attempts < maxAttempts) {
          if (retry.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, retry.delayMs));
          continue;
        }
        return failure({ operation, code: "health.transport", message: `Cloudflare Worker ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`, outcome: "indeterminate", retryable: true, recoveryAction: `inspect the named ${operation} Worker endpoint and retry ${operation} without changing the Release`, receipt: `url=${url}; providerOperation=${operation}-request; ${routeReadinessReceipt(retry, attempts)}; credentialMaterialStored=false` });
      }
    }
    throw new Error("health retry loop exhausted without an observation");
  }
}

/**
 * REST transport for the Cloudflare API. The token is deliberately required
 * per request so a long-lived credential cannot become adapter state.
 */
export function createCloudflareWorkerRestTransport(input: { fetch?: typeof fetch; apiBase?: string }): CloudflareWorkerApiTransport {
  const fetcher = input.fetch ?? fetch;
  const base = (input.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
  return {
    async request<T>(request: CloudflareWorkerApiRequest): Promise<CloudflareWorkerApiResponse<T>> {
      const url = `${base}${request.path}`;
      const response = await fetcher(url, {
        method: request.method,
        headers: { accept: "application/json", authorization: `Bearer ${request.token}`, ...(request.headers ?? {}) },
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
      const text = await response.text();
      let parsed: { result?: T; errors?: CloudflareApiError[]; messages?: CloudflareApiError[] } = {};
      if (text.trim().length > 0) {
        try {
          parsed = JSON.parse(text) as typeof parsed;
        } catch {
          parsed = { errors: [{ message: `Cloudflare returned non-JSON response (${text.slice(0, 120)})` }] };
        }
      }
      const errors = parsed.errors ?? [];
      return {
        status: response.status,
        ok: response.ok && errors.length === 0,
        ...(parsed.result !== undefined ? { result: parsed.result } : {}),
        errors,
        messages: parsed.messages ?? [],
      };
    },
  };
}
