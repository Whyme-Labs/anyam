import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type Artifact,
  type Evidence,
  type Release,
  type Target,
} from "../kernel/contracts.ts";
import { assertTargetCanPromote, createTargetDeploymentProfile, targetDeploymentContractDigest, targetDeploymentProfile, TargetDeploymentProfileError } from "./target-deployment.ts";
import { assertReleaseInputSetMatches, deriveReleaseInputSet } from "./release-input.ts";
import { assertMigrationPlanSafeForTarget, automaticMigrationRollbackDecision, createMigrationPlan, defaultMigrationPlan } from "./migration-plan.ts";

/**
 * A Target adapter is deliberately smaller than the Promotion authority. It
 * can perform provider mechanics, but it cannot update Anyam's Target pointer
 * or declare a Release healthy on its own.
 */
export type WorkerTargetAdapter = {
  protocol: typeof CONTRACT_VERSIONS.targetAdapter;
  id: string;
  contractDigest: string;
  preview(input: WorkerAdapterInput): Promise<DeliveryAdapterResult<WorkerPreview>>;
  apply(input: WorkerAdapterInput): Promise<DeliveryAdapterResult<WorkerDeployment>>;
  health(input: WorkerHealthInput): Promise<DeliveryAdapterResult<HealthObservation>>;
  rollback(input: WorkerRollbackInput): Promise<DeliveryAdapterResult<WorkerDeployment>>;
};

export type WorkerTargetCapabilities = {
  preview: boolean;
  promote: boolean;
  healthCheck: boolean;
  rollback: boolean;
};

export type WorkerTarget = Target & {
  currentReleaseId: string | null;
  releaseHistory: readonly string[];
  capabilities: WorkerTargetCapabilities;
  contractDigest: string;
};

export type HealthState = "healthy" | "unhealthy" | "unknown";

export type HealthObservation = {
  protocol: typeof CONTRACT_VERSIONS.healthObservation;
  id: string;
  targetId: string;
  releaseId: string;
  state: HealthState;
  checkId: string;
  checkedAt: string;
  receipt: string;
  outputDigest?: string;
};

export type ImmutableRelease = {
  protocol: typeof CONTRACT_VERSIONS.verifiedRelease;
  id: string;
  projectId: string;
  release: Readonly<Release>;
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
  releaseDigest: string;
  receipt: string;
};

export type DeliveryAdapterSuccess<T> = {
  status: "succeeded";
  value: T;
  receipt: string;
};

export type DeliveryAdapterFailure = {
  status: "failed";
  outcome: "failed" | "indeterminate";
  errorCode: string;
  message: string;
  retryable: boolean;
  recoveryAction: string;
  receipt: string;
};

export type DeliveryAdapterResult<T> = DeliveryAdapterSuccess<T> | DeliveryAdapterFailure;

export type WorkerPreview = {
  previewId: string;
  providerVersionId: string;
  releaseDigest: string;
  artifactDigests: readonly string[];
  receipt: string;
};

export type WorkerDeployment = {
  deploymentId: string;
  providerVersionId: string;
  releaseDigest: string;
  artifactDigests: readonly string[];
  providerOperationId?: string;
  receipt: string;
};

export type WorkerAdapterInput = {
  promotionId: string;
  attempt: number;
  release: ImmutableRelease;
  target: WorkerTarget;
};

export type WorkerHealthInput = WorkerAdapterInput & {
  deploymentId?: string;
  /** Distinguishes candidate health from verification after a rollback. */
  phase?: "candidate" | "rollback";
};

export type WorkerRollbackInput = WorkerAdapterInput & {
  previousRelease: ImmutableRelease;
  deploymentId?: string;
};

export type PromotionState =
  | "proposed"
  | "validating"
  | "approved"
  | "applying"
  | "healthy"
  | "failed"
  | "blocked"
  | "degraded"
  | "rolled-back";

export type PromotionKind = "promotion" | "rollback";

export type PromotionRecord = {
  protocol: typeof CONTRACT_VERSIONS.promotion;
  id: string;
  projectId: string;
  targetId: string;
  releaseId: string;
  releaseDigest: string;
  previousReleaseId: string | null;
  expectedCurrentReleaseId: string | null;
  state: PromotionState;
  attempt: number;
  kind: PromotionKind;
  idempotencyKey: string;
  actor: ActorRef;
  createdAt: string;
  updatedAt: string;
  receipt: string;
  previewId?: string;
  deploymentId?: string;
  providerOperationId?: string;
  health?: HealthObservation;
  rollbackHealth?: HealthObservation;
  healthFailure?: string;
  rollbackDeploymentId?: string;
  rollbackProviderOperationId?: string;
  recoveryAction?: string;
  rollbackOfPromotionId?: string;
  /** Idempotency identity used by the trusted Authority-to-provider handoff. */
  executionIdempotencyKey?: string;
  /** Durable checkpoint for provider reconciliation and recovery. */
  reconciliationCheckpoint?: PromotionReconciliationCheckpoint;
};

export type PromotionReconciliationCheckpoint = {
  idempotencyKey: string;
  attempt: number;
  stage: "preview" | "apply" | "health" | "rollback" | "complete" | "reconcile";
  providerOperationIds: readonly string[];
  receipt: string;
  /** Stable handoff binding retained across retries and coordinator restarts. */
  executionDigest?: string;
  releaseId?: string;
  targetId?: string;
  status?: "succeeded" | "blocked" | "indeterminate";
  updatedAt?: string;
};

export type PromotionEvent = {
  protocol: typeof CONTRACT_VERSIONS.promotion;
  id: string;
  promotionId: string;
  sequence: number;
  from: PromotionState | null;
  to: PromotionState;
  attempt: number;
  operationId: string;
  idempotencyKey: string;
  actor: ActorRef;
  createdAt: string;
  receipt: string;
  providerOperationId?: string;
};

export type PromotionRequest = {
  releaseId: string;
  idempotencyKey: string;
  actor: ActorRef;
  expectedCurrentReleaseId?: string | null;
  kind?: PromotionKind;
  rollbackOfPromotionId?: string;
};

export type PromotionRetryRequest = {
  promotionId: string;
  idempotencyKey: string;
  actor: ActorRef;
};

export type WorkerPromotionCoordinatorInput = {
  projectId: string;
  target: WorkerTarget;
  adapter: WorkerTargetAdapter;
  now?: () => string;
  releases?: readonly ImmutableRelease[];
};

export type WorkerShipInput = {
  coordinator: WorkerPromotionCoordinator;
  releaseId: string;
  idempotencyKey: string;
  actor: ActorRef;
  expectedCurrentReleaseId?: string | null;
};

export type PromotionErrorCode =
  | "invalid-release"
  | "release-not-found"
  | "target-mismatch"
  | "adapter-mismatch"
  | "expected-current-mismatch"
  | "idempotency-conflict"
  | "invalid-state"
  | "capability-unavailable"
  | "provider-result-mismatch"
  | "rollback-unavailable";

export class PromotionError extends Error {
  readonly code: PromotionErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: PromotionErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "PromotionError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function error(input: ConstructorParameters<typeof PromotionError>[0]): never {
  throw new PromotionError(input);
}

function nonEmpty(value: string, field: string, affectedObject: string): void {
  if (value.trim().length === 0) {
    error({
      code: "invalid-release",
      message: `${field} is required for ${affectedObject}.`,
      affectedObject,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function uniqueIds(ids: readonly string[], field: string, affectedObject: string): void {
  if (new Set(ids).size !== ids.length) {
    error({
      code: "invalid-release",
      message: `${field} contains duplicate IDs for ${affectedObject}.`,
      affectedObject,
      recoveryAction: `remove duplicate ${field} entries and retry`,
      receipt: `field=${field}; count=${ids.length}; unique=${new Set(ids).size}`,
    });
  }
}

export function createWorkerTarget(input: {
  target: Target;
  capabilities: WorkerTargetCapabilities;
  currentReleaseId?: string | null;
  releaseHistory?: readonly string[];
  contractDigest?: string;
}): WorkerTarget {
  nonEmpty(input.target.projectId, "projectId", input.target.id);
  nonEmpty(input.target.adapterId, "adapterId", input.target.id);
  const releaseHistory = [...(input.releaseHistory ?? [])];
  uniqueIds(releaseHistory, "releaseHistory", input.target.id);
  if (input.currentReleaseId && !releaseHistory.includes(input.currentReleaseId)) {
    error({
      code: "target-mismatch",
      message: `Target ${input.target.id} names current Release ${input.currentReleaseId} outside its known-good history.`,
      affectedObject: input.target.id,
      recoveryAction: "restore the complete Target history before activating its current Release",
      receipt: `target=${input.target.id}; currentRelease=${input.currentReleaseId}; history=${releaseHistory.join(",")}`,
    });
  }
  const deploymentProfile = input.target.deploymentProfile && input.target.deploymentProfile.configurationDigests.length > 0
    ? input.target.deploymentProfile
    : createTargetDeploymentProfile({
      environment: "custom",
      channel: "custom",
      audience: input.target.id,
      runtimeIdentity: `target:${input.target.id}`,
      routeIdentities: [],
      bindingIdentities: [],
      dataResourceIdentities: [],
      configurationDigests: [targetDeploymentContractDigest(input.target)],
      secretUseAliases: [],
      dataClass: "custom",
      resourceSharing: "isolated",
      });
  return {
    ...clone(input.target),
    acceptedArtifactTypes: [...input.target.acceptedArtifactTypes],
    requiredEvidenceKeys: [...input.target.requiredEvidenceKeys],
    deploymentProfile,
    currentReleaseId: input.currentReleaseId ?? null,
    releaseHistory,
    capabilities: { ...input.capabilities },
    contractDigest: input.contractDigest ?? digest({
      targetContractDigest: targetDeploymentContractDigest(input.target),
      capabilities: input.capabilities,
    }),
  };
}

/**
 * Seals the exact Release, Artifacts, and Evidence that a Target may consume.
 * The returned snapshot is detached from the caller and is the only object a
 * Promotion or publication adapter receives.
 */
export function sealVerifiedRelease(input: {
  projectId: string;
  release: Release;
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
  target: Target;
}): ImmutableRelease {
  const release = clone(input.release);
  const artifacts = clone(input.artifacts);
  const evidence = clone(input.evidence);
  const affectedObject = release.id;
  nonEmpty(input.projectId, "projectId", affectedObject);
  nonEmpty(release.id, "release.id", affectedObject);
  nonEmpty(release.projectRevisionId, "release.projectRevisionId", affectedObject);
  nonEmpty(release.policyVersion, "release.policyVersion", affectedObject);
  if (release.configurationDigests.length === 0) {
    error({
      code: "invalid-release",
      message: `Release ${release.id} has no configuration digest.`,
      affectedObject,
      recoveryAction: "bind the exact Project configuration digest during Release assembly",
      receipt: `release=${release.id}; configurationDigests=0`,
    });
  }
  if (release.status !== "ready") {
    error({
      code: "invalid-release",
      message: `Release ${release.id} is ${release.status}; only a ready Release can be promoted.`,
      affectedObject,
      recoveryAction: "run the required Actions and Verifiers, then create a ready Release",
      receipt: `release=${release.id}; status=${release.status}; required=ready`,
    });
  }
  uniqueIds(release.artifactIds, "release.artifactIds", affectedObject);
  uniqueIds(release.evidenceIds, "release.evidenceIds", affectedObject);
  uniqueIds(artifacts.map((artifact) => artifact.id), "artifacts", affectedObject);
  uniqueIds(evidence.map((record) => record.id), "evidence", affectedObject);
  if (release.artifactIds.length === 0) {
    error({
      code: "invalid-release",
      message: `Release ${release.id} has no Artifacts for Target ${input.target.id}.`,
      affectedObject,
      recoveryAction: "build and attach at least one Target-compatible Artifact",
      receipt: `release=${release.id}; artifacts=0; target=${input.target.id}`,
    });
  }

  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const artifactId of release.artifactIds) {
    const artifact = artifactById.get(artifactId);
    if (!artifact) {
      error({
        code: "invalid-release",
        message: `Release ${release.id} references missing Artifact ${artifactId}.`,
        affectedObject,
        recoveryAction: "attach the complete Artifact set produced by the Release assembly",
        receipt: `release=${release.id}; missingArtifact=${artifactId}`,
      });
    }
    if (artifact.projectRevisionId !== release.projectRevisionId) {
      error({
        code: "invalid-release",
        message: `Artifact ${artifact.id} belongs to ${artifact.projectRevisionId}, not Release revision ${release.projectRevisionId}.`,
        affectedObject: artifact.id,
        recoveryAction: "rebuild the Release from one exact Project Revision",
        receipt: `artifact=${artifact.id}; artifactRevision=${artifact.projectRevisionId}; releaseRevision=${release.projectRevisionId}`,
      });
    }
    nonEmpty(artifact.digest, "artifact.digest", artifact.id);
    if (!input.target.acceptedArtifactTypes.includes(artifact.type)) {
      error({
        code: "invalid-release",
        message: `Target ${input.target.id} does not accept Artifact type ${artifact.type}.`,
        affectedObject: artifact.id,
        recoveryAction: "declare an Artifact type accepted by the Target or select another Target",
        receipt: `target=${input.target.id}; accepted=${input.target.acceptedArtifactTypes.join(",")}; artifactType=${artifact.type}`,
      });
    }
  }
  if (artifactById.size !== release.artifactIds.length) {
    error({
      code: "invalid-release",
      message: `Release ${release.id} did not provide exactly its declared Artifacts.`,
      affectedObject,
      recoveryAction: "pass the complete, non-duplicated Artifact set referenced by the Release",
      receipt: `declaredArtifacts=${release.artifactIds.length}; providedArtifacts=${artifactById.size}`,
    });
  }

  const evidenceById = new Map(evidence.map((record) => [record.id, record]));
  for (const evidenceId of release.evidenceIds) {
    const record = evidenceById.get(evidenceId);
    if (!record) {
      error({
        code: "invalid-release",
        message: `Release ${release.id} references missing Evidence ${evidenceId}.`,
        affectedObject,
        recoveryAction: "attach the Evidence records produced for this Release assembly",
        receipt: `release=${release.id}; missingEvidence=${evidenceId}`,
      });
    }
    if (record.projectRevisionId !== release.projectRevisionId || record.outcome !== "passed") {
      error({
        code: "invalid-release",
        message: `Evidence ${record.id} is not passed Evidence for Release revision ${release.projectRevisionId}.`,
        affectedObject: record.id,
        recoveryAction: "rerun the stale or failed Verifier against the exact Release revision",
        receipt: `evidence=${record.id}; outcome=${record.outcome}; evidenceRevision=${record.projectRevisionId}; releaseRevision=${release.projectRevisionId}`,
      });
    }
  }
  for (const requiredKey of input.target.requiredEvidenceKeys) {
    const record = evidence.find((candidate) => candidate.key === requiredKey);
    if (!record || record.outcome !== "passed" || record.projectRevisionId !== release.projectRevisionId || record.targetId !== input.target.id) {
      error({
        code: "invalid-release",
        message: `Target ${input.target.id} requires passed Evidence ${requiredKey} bound to this Release revision.`,
        affectedObject: input.target.id,
        recoveryAction: `produce Evidence key ${requiredKey} with targetId=${input.target.id} for the exact Project Revision`,
        receipt: `target=${input.target.id}; requiredEvidence=${requiredKey}; present=${record ? "true" : "false"}; targetBound=${record?.targetId === input.target.id}`,
      });
    }
  }
  if (evidenceById.size !== release.evidenceIds.length) {
    error({
      code: "invalid-release",
      message: `Release ${release.id} did not provide exactly its declared Evidence.`,
      affectedObject,
      recoveryAction: "pass the complete, non-duplicated Evidence set referenced by the Release",
      receipt: `declaredEvidence=${release.evidenceIds.length}; providedEvidence=${evidenceById.size}`,
    });
  }

  const inputSet = release.inputSet ?? deriveReleaseInputSet({ configurationDigests: release.configurationDigests, artifacts, evidence });
  if (release.inputSet) assertReleaseInputSetMatches({ inputSet: release.inputSet, configurationDigests: release.configurationDigests, artifacts, evidence });
  release.inputSet = inputSet;
  const migrationPlan = release.migrationPlan ?? defaultMigrationPlan();
  const normalizedMigrationPlan = createMigrationPlan(migrationPlan);
  for (const migrationArtifactId of normalizedMigrationPlan.migrationArtifactIds) {
    const artifact = artifactById.get(migrationArtifactId);
    if (!artifact || !release.artifactIds.includes(migrationArtifactId)) {
      error({
        code: "invalid-release",
        message: `Migration Plan references Artifact ${migrationArtifactId}, but that Artifact is not part of Release ${release.id}.`,
        affectedObject: release.id,
        recoveryAction: "attach the exact migration Artifact to the Release before Promotion",
        receipt: `release=${release.id}; migrationArtifact=${migrationArtifactId}; declared=${release.artifactIds.includes(migrationArtifactId)}; provided=${artifact ? "true" : "false"}`,
      });
    }
  }
  for (const requiredEvidenceKey of normalizedMigrationPlan.requiredEvidenceKeys) {
    const record = evidence.find((candidate) => candidate.key === requiredEvidenceKey);
    if (!record || !release.evidenceIds.includes(record.id) || record.outcome !== "passed" || record.projectRevisionId !== release.projectRevisionId || (record.targetId !== undefined && record.targetId !== input.target.id)) {
      error({
        code: "invalid-release",
        message: `Migration Plan requires passed Evidence ${requiredEvidenceKey} for Target ${input.target.id}.`,
        affectedObject: release.id,
        recoveryAction: "produce the required migration Evidence for the exact Project Revision and Target before Promotion",
        receipt: `release=${release.id}; migrationEvidence=${requiredEvidenceKey}; present=${record ? "true" : "false"}; declared=${record ? release.evidenceIds.includes(record.id) : "false"}; outcome=${record?.outcome ?? "missing"}`,
      });
    }
  }
  const deploymentProfile = targetDeploymentProfile(input.target);
  assertMigrationPlanSafeForTarget({ plan: normalizedMigrationPlan, environment: deploymentProfile.environment, dataClass: deploymentProfile.dataClass });
  release.migrationPlan = normalizedMigrationPlan;

  const targetContractDigest = "contractDigest" in input.target && typeof input.target.contractDigest === "string"
    ? input.target.contractDigest
    : targetDeploymentContractDigest(input.target);
  const releaseDigest = digest({
    projectId: input.projectId,
    targetId: input.target.id,
    targetContractDigest,
    release,
    artifacts,
    evidence,
  });
  return {
    protocol: CONTRACT_VERSIONS.verifiedRelease,
    id: opaqueId("verified-release"),
    projectId: input.projectId,
    release,
    artifacts,
    evidence,
    releaseDigest,
    receipt: `release=${release.id}; projectRevision=${release.projectRevisionId}; artifacts=${artifacts.length}; evidence=${evidence.length}; digest=${releaseDigest}`,
  };
}

const allowedTransitions: Readonly<Record<PromotionState, readonly PromotionState[]>> = {
  proposed: ["validating"],
  validating: ["approved", "failed", "blocked"],
  approved: ["applying", "failed", "blocked"],
  applying: ["healthy", "failed", "blocked", "degraded", "rolled-back"],
  healthy: [],
  failed: ["proposed"],
  blocked: ["proposed"],
  degraded: ["proposed", "rolled-back"],
  "rolled-back": ["proposed"],
};

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function providerResultMatches(result: WorkerPreview | WorkerDeployment, release: ImmutableRelease): boolean {
  return result.releaseDigest === release.releaseDigest
    && sameStrings(result.artifactDigests, release.artifacts.map((artifact) => artifact.digest));
}

function failureFromThrown(operation: string, thrown: unknown): DeliveryAdapterFailure {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return {
    status: "failed",
    outcome: "indeterminate",
    errorCode: "adapter.threw",
    message: `Target adapter ${operation} threw: ${message}`,
    retryable: true,
    recoveryAction: `inspect the provider operation for ${operation}, reconcile its state, then retry with a new idempotency key`,
    receipt: `operation=${operation}; provider-result=thrown; message=${message}`,
  };
}

export class WorkerPromotionCoordinator {
  private readonly projectId: string;
  private readonly adapter: WorkerTargetAdapter;
  private readonly now: () => string;
  private target: WorkerTarget;
  private readonly releases = new Map<string, ImmutableRelease>();
  private readonly promotions = new Map<string, PromotionRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly executions = new Map<string, Promise<PromotionRecord>>();
  private readonly events: PromotionEvent[] = [];

  constructor(input: WorkerPromotionCoordinatorInput) {
    nonEmpty(input.projectId, "projectId", "promotion-coordinator");
    if (input.target.projectId !== input.projectId) {
      error({
        code: "target-mismatch",
        message: `Target ${input.target.id} belongs to ${input.target.projectId}, not ${input.projectId}.`,
        affectedObject: input.target.id,
        recoveryAction: "construct the coordinator with the Target's owning Project",
        receipt: `targetProject=${input.target.projectId}; coordinatorProject=${input.projectId}`,
      });
    }
    if (input.adapter.id !== input.target.adapterId) {
      error({
        code: "adapter-mismatch",
        message: `Target ${input.target.id} requires adapter ${input.target.adapterId}, received ${input.adapter.id}.`,
        affectedObject: input.target.id,
        recoveryAction: "select the adapter declared by the Target",
        receipt: `targetAdapter=${input.target.adapterId}; receivedAdapter=${input.adapter.id}`,
      });
    }
    this.projectId = input.projectId;
    this.adapter = input.adapter;
    this.now = input.now ?? (() => new Date().toISOString());
    this.target = clone(input.target);
    for (const release of input.releases ?? []) this.registerRelease(release);
  }

  registerRelease(release: ImmutableRelease): void {
    if (release.projectId !== this.projectId) {
      error({
        code: "target-mismatch",
        message: `Verified Release ${release.release.id} belongs to ${release.projectId}, not ${this.projectId}.`,
        affectedObject: release.release.id,
        recoveryAction: "register the Release with its owning Project coordinator",
        receipt: `releaseProject=${release.projectId}; coordinatorProject=${this.projectId}`,
      });
    }
    const current = this.releases.get(release.release.id);
    if (current) {
      if (current.releaseDigest !== release.releaseDigest) {
        error({
          code: "invalid-release",
          message: `Release ${release.release.id} is already registered with a different immutable digest.`,
          affectedObject: release.release.id,
          recoveryAction: "use the original immutable Release or create a new Release ID",
          receipt: `release=${release.release.id}; existingDigest=${current.releaseDigest}; receivedDigest=${release.releaseDigest}`,
        });
      }
      return;
    }
    this.releases.set(release.release.id, clone(release));
  }

  getTarget(): WorkerTarget {
    return clone(this.target);
  }

  getRelease(releaseId: string): ImmutableRelease | undefined {
    const release = this.releases.get(releaseId);
    return release ? clone(release) : undefined;
  }

  getPromotion(promotionId: string): PromotionRecord | undefined {
    const promotion = this.promotions.get(promotionId);
    return promotion ? clone(promotion) : undefined;
  }

  listPromotions(): readonly PromotionRecord[] {
    return [...this.promotions.values()].map(clone);
  }

  listEvents(): readonly PromotionEvent[] {
    return this.events.map(clone);
  }

  requestPromotion(input: PromotionRequest): PromotionRecord {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.promotions.get(existingId);
      if (!existing) {
        error({
          code: "idempotency-conflict",
          message: `Idempotency key ${input.idempotencyKey} points to missing Promotion ${existingId}.`,
          affectedObject: input.idempotencyKey,
          recoveryAction: "repair the authoritative Promotion ledger before retrying",
          receipt: `idempotencyKey=${input.idempotencyKey}; promotion=${existingId}; record=missing`,
        });
      }
      if (existing.releaseId !== input.releaseId || existing.targetId !== this.target.id) {
        error({
          code: "idempotency-conflict",
          message: `Idempotency key ${input.idempotencyKey} was already used for another Promotion.`,
          affectedObject: input.idempotencyKey,
          recoveryAction: "use a new idempotency key for a different Release or Target",
          receipt: `idempotencyKey=${input.idempotencyKey}; existingRelease=${existing.releaseId}; requestedRelease=${input.releaseId}; target=${this.target.id}`,
        });
      }
      return clone(existing);
    }

    const release = this.releases.get(input.releaseId);
    if (!release) {
      error({
        code: "release-not-found",
        message: `Verified Release ${input.releaseId} is not registered with Target ${this.target.id}.`,
        affectedObject: input.releaseId,
        recoveryAction: "seal and register the exact ready Release before requesting Promotion",
        receipt: `release=${input.releaseId}; registered=false; target=${this.target.id}`,
      });
    }
    const expected = input.expectedCurrentReleaseId === undefined
      ? this.target.currentReleaseId
      : input.expectedCurrentReleaseId;
    if (expected !== this.target.currentReleaseId) {
      error({
        code: "expected-current-mismatch",
        message: `Target ${this.target.id} changed before Promotion ${input.releaseId} was requested.`,
        affectedObject: this.target.id,
        recoveryAction: "refresh Target state and retry with the current expected Release ID",
        receipt: `target=${this.target.id}; expectedCurrent=${expected ?? "none"}; actualCurrent=${this.target.currentReleaseId ?? "none"}`,
      });
    }
    const promotion: PromotionRecord = {
      protocol: CONTRACT_VERSIONS.promotion,
      id: opaqueId("promotion"),
      projectId: this.projectId,
      targetId: this.target.id,
      releaseId: input.releaseId,
      releaseDigest: release.releaseDigest,
      previousReleaseId: this.target.currentReleaseId,
      expectedCurrentReleaseId: expected,
      state: "proposed",
      attempt: 0,
      kind: input.kind ?? "promotion",
      idempotencyKey: input.idempotencyKey,
      actor: clone(input.actor),
      createdAt: this.now(),
      updatedAt: this.now(),
      receipt: `promotion=proposed; target=${this.target.id}; release=${input.releaseId}; expectedCurrent=${expected ?? "none"}`,
      ...(input.rollbackOfPromotionId ? { rollbackOfPromotionId: input.rollbackOfPromotionId } : {}),
    };
    this.promotions.set(promotion.id, promotion);
    this.idempotency.set(input.idempotencyKey, promotion.id);
    this.emit(promotion, null, "proposed", promotion.receipt);
    return clone(promotion);
  }

  async promote(input: PromotionRequest): Promise<PromotionRecord> {
    const requested = this.requestPromotion(input);
    const running = this.executions.get(requested.id);
    if (running) return running;
    if (requested.state !== "proposed") return requested;
    return this.executeOnce(requested.id);
  }

  async retryPromotion(input: PromotionRetryRequest): Promise<PromotionRecord> {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.promotions.get(existingId);
      if (!existing || existing.id !== input.promotionId) {
        error({
          code: "idempotency-conflict",
          message: `Retry idempotency key ${input.idempotencyKey} was already used by another operation.`,
          affectedObject: input.idempotencyKey,
          recoveryAction: "use a new retry idempotency key",
          receipt: `idempotencyKey=${input.idempotencyKey}; requestedPromotion=${input.promotionId}; existingPromotion=${existingId ?? "missing"}`,
        });
      }
      const running = this.executions.get(existing.id);
      if (running) return running;
      return clone(existing);
    }
    const promotion = this.promotions.get(input.promotionId);
    if (!promotion) {
      error({
        code: "release-not-found",
        message: `Promotion ${input.promotionId} does not exist.`,
        affectedObject: input.promotionId,
        recoveryAction: "use the recorded Promotion ID from the authoritative Target ledger",
        receipt: `promotion=${input.promotionId}; record=missing`,
      });
    }
    if (!["failed", "blocked", "degraded", "rolled-back"].includes(promotion.state)) {
      error({
        code: "invalid-state",
        message: `Promotion ${promotion.id} is ${promotion.state}; only a failed, blocked, degraded, or rolled-back Promotion can retry.`,
        affectedObject: promotion.id,
        recoveryAction: "wait for the current Promotion to reach a recoverable state or request a separate rollback",
        receipt: `promotion=${promotion.id}; state=${promotion.state}; retryableStates=failed,blocked,degraded,rolled-back`,
      });
    }
    const expected = this.target.currentReleaseId;
    promotion.idempotencyKey = input.idempotencyKey;
    promotion.expectedCurrentReleaseId = expected;
    promotion.previousReleaseId = this.target.currentReleaseId;
    promotion.attempt += 1;
    promotion.receipt = `promotion=retry-requested; target=${this.target.id}; release=${promotion.releaseId}; attempt=${promotion.attempt}; expectedCurrent=${expected ?? "none"}`;
    promotion.recoveryAction = "retry is executing against the current Target pointer";
    delete promotion.previewId;
    delete promotion.deploymentId;
    delete promotion.providerOperationId;
    delete promotion.health;
    delete promotion.rollbackHealth;
    delete promotion.healthFailure;
    delete promotion.rollbackDeploymentId;
    delete promotion.rollbackProviderOperationId;
    this.idempotency.set(input.idempotencyKey, promotion.id);
    this.transition(promotion, "proposed", promotion.receipt);
    return this.executeOnce(promotion.id);
  }

  async rollbackToPrevious(input: {
    idempotencyKey: string;
    actor: ActorRef;
  }): Promise<PromotionRecord> {
    const current = this.target.currentReleaseId;
    if (!current) {
      error({
        code: "rollback-unavailable",
        message: `Target ${this.target.id} has no current Release to roll back.`,
        affectedObject: this.target.id,
        recoveryAction: "promote a known-good Release before requesting a rollback",
        receipt: `target=${this.target.id}; currentRelease=none`,
      });
    }
    const currentIndex = this.target.releaseHistory.lastIndexOf(current);
    const previous = currentIndex > 0 ? this.target.releaseHistory[currentIndex - 1] : null;
    if (!previous) {
      error({
        code: "rollback-unavailable",
        message: `Target ${this.target.id} has no previous known-good Release.`,
        affectedObject: this.target.id,
        recoveryAction: "retain the current Release or register a prior known-good Release before retrying",
        receipt: `target=${this.target.id}; currentRelease=${current}; history=${this.target.releaseHistory.join(",")}`,
      });
    }
    const previousPromotion = [...this.promotions.values()].reverse().find((candidate) => candidate.releaseId === current && candidate.state === "healthy");
    return this.promote({
      releaseId: previous,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedCurrentReleaseId: current,
      kind: "rollback",
      ...(previousPromotion ? { rollbackOfPromotionId: previousPromotion.id } : {}),
    });
  }

  private async execute(promotionId: string): Promise<PromotionRecord> {
    const promotion = this.promotions.get(promotionId);
    if (!promotion) {
      error({
        code: "release-not-found",
        message: `Promotion ${promotionId} does not exist.`,
        affectedObject: promotionId,
        recoveryAction: "use the Promotion ID returned by the request operation",
        receipt: `promotion=${promotionId}; record=missing`,
      });
    }
    if (promotion.state !== "proposed") return clone(promotion);
    const release = this.releases.get(promotion.releaseId);
    if (!release) {
      this.fail(promotion, "failed", `Registered Release ${promotion.releaseId} disappeared before execution.`, "restore the immutable Release registry before retrying", `release=${promotion.releaseId}; registry=missing`);
      return clone(promotion);
    }
    try {
      assertTargetCanPromote(this.target);
    } catch (error) {
      if (!(error instanceof TargetDeploymentProfileError)) throw error;
      this.fail(promotion, "blocked", error.message, error.recoveryAction, error.receipt);
      return clone(promotion);
    }
    if (!this.target.capabilities.preview) {
      this.fail(promotion, "blocked", `Target ${this.target.id} does not declare preview capability.`, "qualify a preview-capable Worker Target before Promotion", `target=${this.target.id}; capability=preview; enabled=false`);
      return clone(promotion);
    }
    this.transition(promotion, "validating", `promotion=validating; release=${release.release.id}; digest=${release.releaseDigest}`);
    const preview = await this.invoke("preview", () => this.adapter.preview({ promotionId: promotion.id, attempt: promotion.attempt, release: clone(release), target: clone(this.target) }));
    if (preview.status === "failed") {
      this.failFromAdapter(promotion, preview, "preview");
      return clone(promotion);
    }
    if (!providerResultMatches(preview.value, release)) {
      this.fail(promotion, "blocked", `Preview for Promotion ${promotion.id} did not identify the sealed Release and Artifact digests.`, "fix the Target adapter to return the exact immutable Release lineage", `promotion=${promotion.id}; expectedReleaseDigest=${release.releaseDigest}; receivedReleaseDigest=${preview.value.releaseDigest}`);
      return clone(promotion);
    }
    promotion.previewId = preview.value.previewId;
    promotion.receipt = `promotion=previewed; release=${release.release.id}; preview=${preview.value.previewId}; providerReceipt=${preview.receipt}`;
    this.transition(promotion, "approved", promotion.receipt);

    if (!this.target.capabilities.promote) {
      this.fail(promotion, "blocked", `Target ${this.target.id} does not declare Promotion capability.`, "qualify a Promotion-capable Worker Target before shipping", `target=${this.target.id}; capability=promote; enabled=false`);
      return clone(promotion);
    }
    if (promotion.kind === "rollback" && !this.target.capabilities.rollback) {
      this.fail(promotion, "blocked", `Target ${this.target.id} does not declare rollback capability.`, "qualify a rollback-capable Worker Target before requesting rollback", `target=${this.target.id}; capability=rollback; enabled=false`);
      return clone(promotion);
    }
    this.transition(promotion, "applying", `promotion=applying; release=${release.release.id}; preview=${promotion.previewId}`);
    const deploymentOperation = promotion.kind === "rollback" ? "rollback" : "apply";
    const deployment = promotion.kind === "rollback"
      ? await this.invoke("rollback", () => this.adapter.rollback({
        promotionId: promotion.id,
        attempt: promotion.attempt,
        release: clone(release),
        target: clone(this.target),
        previousRelease: clone(release),
      }))
      : await this.invoke("apply", () => this.adapter.apply({ promotionId: promotion.id, attempt: promotion.attempt, release: clone(release), target: clone(this.target) }));
    if (deployment.status === "failed") {
      this.failFromAdapter(promotion, deployment, deploymentOperation);
      return clone(promotion);
    }
    if (!providerResultMatches(deployment.value, release)) {
      this.degrade(promotion, `Deployment for Promotion ${promotion.id} did not identify the sealed Release and Artifact digests.`, "reconcile the provider deployment, then retry only after the Target state is known", `promotion=${promotion.id}; expectedReleaseDigest=${release.releaseDigest}; receivedReleaseDigest=${deployment.value.releaseDigest}`);
      return clone(promotion);
    }
    promotion.deploymentId = deployment.value.deploymentId;
    if (deployment.value.providerOperationId) promotion.providerOperationId = deployment.value.providerOperationId;

    if (!this.target.capabilities.healthCheck) {
      this.degrade(promotion, `Target ${this.target.id} has no declared health-check capability after applying Release ${release.release.id}.`, "qualify a health checker before changing the authoritative Target pointer", `target=${this.target.id}; capability=healthCheck; enabled=false`);
      return clone(promotion);
    }
    const health = await this.invoke("health", () => this.adapter.health({ promotionId: promotion.id, attempt: promotion.attempt, release: clone(release), target: clone(this.target), deploymentId: deployment.value.deploymentId, phase: "candidate" }));
    if (health.status === "failed") {
      await this.recoverAfterHealthFailure(promotion, release, `health adapter failure: ${health.message}`, health.receipt);
      return clone(promotion);
    }
    promotion.health = clone(health.value);
    if (health.value.targetId !== this.target.id || health.value.releaseId !== release.release.id) {
      await this.recoverAfterHealthFailure(promotion, release, "health observation was bound to a different Target or Release", `target=${this.target.id}; release=${release.release.id}; observedTarget=${health.value.targetId}; observedRelease=${health.value.releaseId}`);
      return clone(promotion);
    }
    if (health.value.state !== "healthy") {
      await this.recoverAfterHealthFailure(promotion, release, `health state=${health.value.state}`, health.value.receipt);
      return clone(promotion);
    }
    this.completeHealthy(promotion, release, health.value, deployment.value.providerOperationId);
    return clone(promotion);
  }

  private executeOnce(promotionId: string): Promise<PromotionRecord> {
    const running = this.executions.get(promotionId);
    if (running) return running;
    const execution = this.execute(promotionId);
    this.executions.set(promotionId, execution);
    const cleanup = (): void => {
      if (this.executions.get(promotionId) === execution) this.executions.delete(promotionId);
    };
    void execution.then(cleanup, cleanup);
    return execution;
  }

  private async recoverAfterHealthFailure(promotion: PromotionRecord, release: ImmutableRelease, message: string, receipt: string): Promise<void> {
    promotion.healthFailure = message;
    promotion.receipt = `promotion=health-failed; release=${release.release.id}; ${receipt}`;
    this.target.state = "degraded";
    this.transition(promotion, "degraded", promotion.receipt);
    const migrationDecision = automaticMigrationRollbackDecision(release.release.migrationPlan ?? defaultMigrationPlan());
    if (!migrationDecision.allowed) {
      promotion.recoveryAction = migrationDecision.recoveryAction;
      promotion.receipt = `${promotion.receipt}; ${migrationDecision.receipt}`;
      return;
    }
    promotion.receipt = `${promotion.receipt}; ${migrationDecision.receipt}`;
    if (!promotion.previousReleaseId || !this.target.capabilities.rollback) {
      promotion.recoveryAction = promotion.previousReleaseId
        ? "Target is degraded; qualify rollback capability or reconcile the provider before retrying"
        : "Target is degraded; no previous known-good Release exists, so reconcile the provider before retrying";
      return;
    }
    const previous = this.releases.get(promotion.previousReleaseId);
    if (!previous) {
      promotion.recoveryAction = "Target is degraded; restore the previous immutable Release record before retrying rollback";
      return;
    }
    const rollback = await this.invoke("rollback", () => this.adapter.rollback({
      promotionId: promotion.id,
      attempt: promotion.attempt,
      release: clone(release),
      target: clone(this.target),
      previousRelease: clone(previous),
      ...(promotion.deploymentId ? { deploymentId: promotion.deploymentId } : {}),
    }));
    if (rollback.status === "failed") {
      promotion.recoveryAction = `Target remains degraded; rollback failed: ${rollback.recoveryAction}`;
      promotion.receipt = `${promotion.receipt}; rollback=failed; ${rollback.receipt}`;
      return;
    }
    if (!providerResultMatches(rollback.value, previous)) {
      promotion.recoveryAction = "Target remains degraded; rollback provider result did not identify the previous immutable Release";
      promotion.receipt = `${promotion.receipt}; rollback=result-mismatch; expectedReleaseDigest=${previous.releaseDigest}; receivedReleaseDigest=${rollback.value.releaseDigest}`;
      return;
    }
    promotion.rollbackDeploymentId = rollback.value.deploymentId;
    if (rollback.value.providerOperationId) promotion.rollbackProviderOperationId = rollback.value.providerOperationId;
    const rollbackHealth = await this.invoke("rollback-health", () => this.adapter.health({
      promotionId: promotion.id,
      attempt: promotion.attempt,
      release: clone(previous),
      target: clone(this.target),
      deploymentId: rollback.value.deploymentId,
      phase: "rollback",
    }));
    if (rollbackHealth.status === "failed") {
      promotion.recoveryAction = `Target remains degraded; rollback health could not be verified: ${rollbackHealth.recoveryAction}`;
      promotion.receipt = `${promotion.receipt}; rollback=applied; rollbackHealth=indeterminate; ${rollbackHealth.receipt}`;
      return;
    }
    promotion.rollbackHealth = clone(rollbackHealth.value);
    if (rollbackHealth.value.targetId !== this.target.id || rollbackHealth.value.releaseId !== previous.release.id || rollbackHealth.value.state !== "healthy") {
      promotion.recoveryAction = "Target remains degraded; rollback completed but the previous Release is not health-verified";
      promotion.receipt = `${promotion.receipt}; rollback=applied; rollbackHealth=${rollbackHealth.value.state}; rollbackHealthReceipt=${rollbackHealth.value.receipt}`;
      return;
    }
    this.target.state = "healthy";
    promotion.recoveryAction = `previous Release ${previous.release.id} restored and health-verified; inspect the failed Release before retrying`;
    promotion.receipt = `${promotion.receipt}; rollback=healthy; previousRelease=${previous.release.id}; rollbackReceipt=${rollbackHealth.value.receipt}`;
    this.transition(promotion, "rolled-back", promotion.receipt, rollback.value.providerOperationId);
  }

  private completeHealthy(promotion: PromotionRecord, release: ImmutableRelease, health: HealthObservation, providerOperationId?: string): void {
    this.target.currentReleaseId = release.release.id;
    if (this.target.releaseHistory[this.target.releaseHistory.length - 1] !== release.release.id) {
      this.target.releaseHistory = [...this.target.releaseHistory, release.release.id];
    }
    this.target.state = "healthy";
    promotion.receipt = `promotion=healthy; target=${this.target.id}; release=${release.release.id}; artifactDigests=${release.artifacts.map((artifact) => artifact.digest).join(",")}; health=${health.receipt}`;
    this.transition(promotion, "healthy", promotion.receipt, providerOperationId);
  }

  private failFromAdapter(promotion: PromotionRecord, failure: DeliveryAdapterFailure, operation: string): void {
    const state: PromotionState = failure.outcome === "indeterminate"
      ? (operation === "apply" ? "degraded" : "failed")
      : failure.retryable ? "failed" : "blocked";
    if (state === "degraded") {
      this.degrade(promotion, `${operation} returned an indeterminate provider result: ${failure.message}`, failure.recoveryAction, failure.receipt);
      return;
    }
    this.fail(promotion, state, `${operation} failed: ${failure.message}`, failure.recoveryAction, failure.receipt);
  }

  private fail(promotion: PromotionRecord, state: "failed" | "blocked", message: string, recoveryAction: string, receipt: string): void {
    promotion.recoveryAction = recoveryAction;
    promotion.receipt = `promotion=${state}; ${message}; ${receipt}`;
    this.transition(promotion, state, promotion.receipt);
  }

  private degrade(promotion: PromotionRecord, message: string, recoveryAction: string, receipt: string): void {
    this.target.state = "degraded";
    promotion.recoveryAction = recoveryAction;
    promotion.receipt = `promotion=degraded; ${message}; ${receipt}`;
    this.transition(promotion, "degraded", promotion.receipt);
  }

  private transition(promotion: PromotionRecord, next: PromotionState, receipt: string, providerOperationId?: string): void {
    if (!allowedTransitions[promotion.state].includes(next)) {
      error({
        code: "invalid-state",
        message: `Promotion ${promotion.id} cannot transition from ${promotion.state} to ${next}.`,
        affectedObject: promotion.id,
        recoveryAction: "inspect the Promotion event ledger and resume only from the recorded state",
        receipt: `promotion=${promotion.id}; from=${promotion.state}; to=${next}`,
      });
    }
    const from = promotion.state;
    promotion.state = next;
    promotion.updatedAt = this.now();
    this.emit(promotion, from, next, receipt, providerOperationId);
  }

  private emit(promotion: PromotionRecord, from: PromotionState | null, to: PromotionState, receipt: string, providerOperationId?: string): void {
    this.events.push({
      protocol: CONTRACT_VERSIONS.promotion,
      id: opaqueId("promotion-event"),
      promotionId: promotion.id,
      sequence: this.events.length + 1,
      from,
      to,
      attempt: promotion.attempt,
      operationId: opaqueId("promotion-operation"),
      idempotencyKey: promotion.idempotencyKey,
      actor: clone(promotion.actor),
      createdAt: this.now(),
      receipt,
      ...(providerOperationId ? { providerOperationId } : {}),
    });
  }

  private async invoke<T>(operation: string, call: () => Promise<DeliveryAdapterResult<T>>): Promise<DeliveryAdapterResult<T>> {
    try {
      return await call();
    } catch (thrown) {
      return failureFromThrown(operation, thrown);
    }
  }
}

export async function shipWorkerRelease(input: WorkerShipInput): Promise<PromotionRecord> {
  return input.coordinator.promote({
    releaseId: input.releaseId,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    ...(input.expectedCurrentReleaseId !== undefined ? { expectedCurrentReleaseId: input.expectedCurrentReleaseId } : {}),
  });
}
