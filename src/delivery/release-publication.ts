import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type Artifact,
  type DisclosureClassification,
  type Target,
} from "../kernel/contracts.ts";
import {
  type DeliveryAdapterFailure,
  type DeliveryAdapterResult,
  type ImmutableRelease,
} from "./promotion.ts";
import { targetDeploymentContractDigest, targetDeploymentProfile } from "./target-deployment.ts";

/**
 * A package registry, downloadable release channel, or generic artifact
 * target. It intentionally has no web-runtime assumptions.
 */
export type ReleaseAssetTarget = Target & {
  currentReleaseId: string | null;
  currentArtifactId: string | null;
  releaseHistory: readonly string[];
  publicationState: "configured" | "published" | "degraded" | "unknown";
  contractDigest: string;
};

export type PublishedArtifact = {
  targetId: string;
  releaseId: string;
  artifactId: string;
  releaseDigest: string;
  artifactDigest: string;
  providerObjectId: string;
  providerReleaseId?: string;
  providerAssetId?: string;
  providerReleaseUrl?: string;
  providerAssetUrl?: string;
  providerAssetApiUrl?: string;
  providerMediaType?: string;
  providerByteLength?: number;
  disclosure?: DisclosureClassification;
  providerCapabilities?: Readonly<Record<string, boolean>>;
  receipt: string;
};

export type ReleaseTargetAdapter = {
  protocol: typeof CONTRACT_VERSIONS.targetAdapter;
  id: string;
  contractDigest: string;
  publish(input: {
    publicationId: string;
    attempt: number;
    release: ImmutableRelease;
    artifact: Artifact;
    target: ReleaseAssetTarget;
  }): Promise<DeliveryAdapterResult<PublishedArtifact>>;
};

export type ReleasePublicationState = "proposed" | "publishing" | "published" | "failed" | "blocked" | "degraded";

export type ReleasePublicationRecord = {
  protocol: typeof CONTRACT_VERSIONS.releasePublication;
  id: string;
  projectId: string;
  targetId: string;
  releaseId: string;
  releaseDigest: string;
  artifactId: string;
  artifactDigest: string;
  previousReleaseId: string | null;
  expectedCurrentReleaseId: string | null;
  state: ReleasePublicationState;
  attempt: number;
  idempotencyKey: string;
  actor: ActorRef;
  createdAt: string;
  updatedAt: string;
  receipt: string;
  providerObjectId?: string;
  providerReleaseId?: string;
  providerAssetId?: string;
  providerReleaseUrl?: string;
  providerAssetUrl?: string;
  providerAssetApiUrl?: string;
  providerMediaType?: string;
  providerByteLength?: number;
  disclosure?: DisclosureClassification;
  providerCapabilities?: Readonly<Record<string, boolean>>;
  recoveryAction?: string;
};

export type ReleasePublicationEvent = {
  protocol: typeof CONTRACT_VERSIONS.releasePublication;
  id: string;
  publicationId: string;
  sequence: number;
  from: ReleasePublicationState | null;
  to: ReleasePublicationState;
  attempt: number;
  operationId: string;
  idempotencyKey: string;
  actor: ActorRef;
  createdAt: string;
  receipt: string;
};

export type ReleasePublicationRequest = {
  releaseId: string;
  artifactId: string;
  idempotencyKey: string;
  actor: ActorRef;
  expectedCurrentReleaseId?: string | null;
};

export type ReleasePublicationRetryRequest = {
  publicationId: string;
  idempotencyKey: string;
  actor: ActorRef;
};

export type ReleaseAssetTargetInput = {
  target: Target;
  currentReleaseId?: string | null;
  currentArtifactId?: string | null;
  releaseHistory?: readonly string[];
  publicationState?: ReleaseAssetTarget["publicationState"];
  contractDigest?: string;
};

export type ReleasePublicationCoordinatorInput = {
  projectId: string;
  target: ReleaseAssetTarget;
  adapter: ReleaseTargetAdapter;
  now?: () => string;
  releases?: readonly ImmutableRelease[];
};

export type ReleasePublicationErrorCode =
  | "invalid-target"
  | "target-mismatch"
  | "adapter-mismatch"
  | "release-not-found"
  | "artifact-not-found"
  | "artifact-type-mismatch"
  | "expected-current-mismatch"
  | "idempotency-conflict"
  | "invalid-state"
  | "provider-result-mismatch";

export class ReleasePublicationError extends Error {
  readonly code: ReleasePublicationErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: ReleasePublicationErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "ReleasePublicationError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function error(input: ConstructorParameters<typeof ReleasePublicationError>[0]): never {
  throw new ReleasePublicationError(input);
}

function nonEmpty(value: string, field: string, affectedObject: string): void {
  if (value.trim().length === 0) {
    error({
      code: "invalid-target",
      message: `${field} is required for ${affectedObject}.`,
      affectedObject,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function defaultContractDigest(target: Target): string {
  return targetDeploymentContractDigest({ ...target, deploymentProfile: targetDeploymentProfile(target) });
}

export function createReleaseAssetTarget(input: ReleaseAssetTargetInput): ReleaseAssetTarget {
  nonEmpty(input.target.id, "target.id", input.target.id);
  nonEmpty(input.target.projectId, "target.projectId", input.target.id);
  nonEmpty(input.target.adapterId, "target.adapterId", input.target.id);
  const releaseHistory = [...(input.releaseHistory ?? [])];
  if (new Set(releaseHistory).size !== releaseHistory.length) {
    error({
      code: "invalid-target",
      message: `Target ${input.target.id} has duplicate Release history entries.`,
      affectedObject: input.target.id,
      recoveryAction: "repair the append-only Target history before activating it",
      receipt: `target=${input.target.id}; history=${releaseHistory.join(",")}`,
    });
  }
  if ((input.currentReleaseId === null || input.currentReleaseId === undefined) !== (input.currentArtifactId === null || input.currentArtifactId === undefined)) {
    error({
      code: "invalid-target",
      message: `Target ${input.target.id} must bind its current Release and Artifact together.`,
      affectedObject: input.target.id,
      recoveryAction: "restore both current pointers or clear both before retrying",
      receipt: `target=${input.target.id}; currentRelease=${input.currentReleaseId ?? "none"}; currentArtifact=${input.currentArtifactId ?? "none"}`,
    });
  }
  if (input.currentReleaseId && !releaseHistory.includes(input.currentReleaseId)) {
    error({
      code: "invalid-target",
      message: `Target ${input.target.id} names current Release ${input.currentReleaseId} outside its history.`,
      affectedObject: input.target.id,
      recoveryAction: "restore the complete Target history before activating its current Release",
      receipt: `target=${input.target.id}; currentRelease=${input.currentReleaseId}; history=${releaseHistory.join(",")}`,
    });
  }
  return {
    ...clone(input.target),
    acceptedArtifactTypes: [...input.target.acceptedArtifactTypes],
    requiredEvidenceKeys: [...input.target.requiredEvidenceKeys],
    deploymentProfile: targetDeploymentProfile(input.target),
    currentReleaseId: input.currentReleaseId ?? null,
    currentArtifactId: input.currentArtifactId ?? null,
    releaseHistory,
    publicationState: input.publicationState ?? "configured",
    contractDigest: input.contractDigest ?? defaultContractDigest(input.target),
  };
}

const transitions: Readonly<Record<ReleasePublicationState, readonly ReleasePublicationState[]>> = {
  proposed: ["publishing"],
  publishing: ["published", "failed", "blocked", "degraded"],
  published: [],
  failed: ["proposed"],
  blocked: ["proposed"],
  degraded: ["proposed"],
};

function providerMatches(result: PublishedArtifact, publication: ReleasePublicationRecord): boolean {
  return result.targetId === publication.targetId
    && result.releaseId === publication.releaseId
    && result.artifactId === publication.artifactId
    && result.releaseDigest === publication.releaseDigest
    && result.artifactDigest === publication.artifactDigest;
}

function adapterThrown(operation: string, thrown: unknown): DeliveryAdapterFailure {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return {
    status: "failed",
    outcome: "indeterminate",
    errorCode: "adapter.threw",
    message: `Release Target adapter ${operation} threw: ${message}`,
    retryable: true,
    recoveryAction: `inspect the provider operation for ${operation}, reconcile its state, then retry with a new idempotency key`,
    receipt: `operation=${operation}; provider-result=thrown; message=${message}`,
  };
}

export class ReleasePublicationCoordinator {
  private readonly projectId: string;
  private readonly adapter: ReleaseTargetAdapter;
  private readonly now: () => string;
  private target: ReleaseAssetTarget;
  private readonly releases = new Map<string, ImmutableRelease>();
  private readonly publications = new Map<string, ReleasePublicationRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly executions = new Map<string, Promise<ReleasePublicationRecord>>();
  private readonly events: ReleasePublicationEvent[] = [];

  constructor(input: ReleasePublicationCoordinatorInput) {
    nonEmpty(input.projectId, "projectId", "release-publication-coordinator");
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
    if (current && current.releaseDigest !== release.releaseDigest) {
      error({
        code: "provider-result-mismatch",
        message: `Release ${release.release.id} is already registered with a different immutable digest.`,
        affectedObject: release.release.id,
        recoveryAction: "use the original immutable Release or create a new Release ID",
        receipt: `release=${release.release.id}; existingDigest=${current.releaseDigest}; receivedDigest=${release.releaseDigest}`,
      });
    }
    if (!current) this.releases.set(release.release.id, clone(release));
  }

  getTarget(): ReleaseAssetTarget {
    return clone(this.target);
  }

  getPublication(publicationId: string): ReleasePublicationRecord | undefined {
    const publication = this.publications.get(publicationId);
    return publication ? clone(publication) : undefined;
  }

  listPublications(): readonly ReleasePublicationRecord[] {
    return [...this.publications.values()].map(clone);
  }

  listEvents(): readonly ReleasePublicationEvent[] {
    return this.events.map(clone);
  }

  requestPublication(input: ReleasePublicationRequest): ReleasePublicationRecord {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.publications.get(existingId);
      if (!existing || existing.releaseId !== input.releaseId || existing.artifactId !== input.artifactId) {
        error({
          code: "idempotency-conflict",
          message: `Idempotency key ${input.idempotencyKey} was already used for another artifact publication.`,
          affectedObject: input.idempotencyKey,
          recoveryAction: "use a new idempotency key for a different Release or Artifact",
          receipt: `idempotencyKey=${input.idempotencyKey}; existingPublication=${existingId}; requestedRelease=${input.releaseId}; requestedArtifact=${input.artifactId}`,
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
        recoveryAction: "seal and register the exact ready Release before publication",
        receipt: `release=${input.releaseId}; registered=false; target=${this.target.id}`,
      });
    }
    const artifact = release.artifacts.find((candidate) => candidate.id === input.artifactId);
    if (!artifact) {
      error({
        code: "artifact-not-found",
        message: `Artifact ${input.artifactId} is not part of Release ${release.release.id}.`,
        affectedObject: input.artifactId,
        recoveryAction: "select an Artifact declared by the immutable Release",
        receipt: `release=${release.release.id}; artifact=${input.artifactId}; present=false`,
      });
    }
    if (!this.target.acceptedArtifactTypes.includes(artifact.type)) {
      error({
        code: "artifact-type-mismatch",
        message: `Target ${this.target.id} does not accept Artifact type ${artifact.type}.`,
        affectedObject: artifact.id,
        recoveryAction: "select a Target-compatible Artifact or configure a Target adapter for this type",
        receipt: `target=${this.target.id}; accepted=${this.target.acceptedArtifactTypes.join(",")}; artifactType=${artifact.type}`,
      });
    }
    const expected = input.expectedCurrentReleaseId === undefined ? this.target.currentReleaseId : input.expectedCurrentReleaseId;
    if (expected !== this.target.currentReleaseId) {
      error({
        code: "expected-current-mismatch",
        message: `Target ${this.target.id} changed before publishing Release ${release.release.id}.`,
        affectedObject: this.target.id,
        recoveryAction: "refresh Target state and retry with the current expected Release ID",
        receipt: `target=${this.target.id}; expectedCurrent=${expected ?? "none"}; actualCurrent=${this.target.currentReleaseId ?? "none"}`,
      });
    }
    const publication: ReleasePublicationRecord = {
      protocol: CONTRACT_VERSIONS.releasePublication,
      id: opaqueId("release-publication"),
      projectId: this.projectId,
      targetId: this.target.id,
      releaseId: release.release.id,
      releaseDigest: release.releaseDigest,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
      previousReleaseId: this.target.currentReleaseId,
      expectedCurrentReleaseId: expected,
      state: "proposed",
      attempt: 0,
      idempotencyKey: input.idempotencyKey,
      actor: clone(input.actor),
      createdAt: this.now(),
      updatedAt: this.now(),
      receipt: `publication=proposed; target=${this.target.id}; release=${release.release.id}; artifact=${artifact.id}; expectedCurrent=${expected ?? "none"}`,
    };
    this.publications.set(publication.id, publication);
    this.idempotency.set(input.idempotencyKey, publication.id);
    this.emit(publication, null, "proposed", publication.receipt);
    return clone(publication);
  }

  async publish(input: ReleasePublicationRequest): Promise<ReleasePublicationRecord> {
    const requested = this.requestPublication(input);
    const running = this.executions.get(requested.id);
    if (running) return running;
    if (requested.state !== "proposed") return requested;
    return this.executeOnce(requested.id);
  }

  async retry(input: ReleasePublicationRetryRequest): Promise<ReleasePublicationRecord> {
    const existingId = this.idempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.publications.get(existingId);
      if (!existing || existing.id !== input.publicationId) {
        error({
          code: "idempotency-conflict",
          message: `Retry idempotency key ${input.idempotencyKey} was already used by another publication.`,
          affectedObject: input.idempotencyKey,
          recoveryAction: "use a new retry idempotency key",
          receipt: `idempotencyKey=${input.idempotencyKey}; requestedPublication=${input.publicationId}; existingPublication=${existingId ?? "missing"}`,
        });
      }
      const running = this.executions.get(existing.id);
      if (running) return running;
      return clone(existing);
    }
    const publication = this.publications.get(input.publicationId);
    if (!publication) {
      error({
        code: "release-not-found",
        message: `Release publication ${input.publicationId} does not exist.`,
        affectedObject: input.publicationId,
        recoveryAction: "use the recorded publication ID from the authoritative Target ledger",
        receipt: `publication=${input.publicationId}; record=missing`,
      });
    }
    if (!["failed", "blocked", "degraded"].includes(publication.state)) {
      error({
        code: "invalid-state",
        message: `Release publication ${publication.id} is ${publication.state}; only failed, blocked, or degraded publication may retry.`,
        affectedObject: publication.id,
        recoveryAction: "wait for a recoverable publication state before retrying",
        receipt: `publication=${publication.id}; state=${publication.state}; retryableStates=failed,blocked,degraded`,
      });
    }
    publication.idempotencyKey = input.idempotencyKey;
    publication.expectedCurrentReleaseId = this.target.currentReleaseId;
    publication.previousReleaseId = this.target.currentReleaseId;
    publication.attempt += 1;
    publication.receipt = `publication=retry-requested; target=${this.target.id}; release=${publication.releaseId}; artifact=${publication.artifactId}; attempt=${publication.attempt}; expectedCurrent=${this.target.currentReleaseId ?? "none"}`;
    publication.recoveryAction = "retry is executing against the current Target pointer";
    delete publication.providerObjectId;
    this.idempotency.set(input.idempotencyKey, publication.id);
    this.transition(publication, "proposed", publication.receipt);
    return this.executeOnce(publication.id);
  }

  private async execute(publicationId: string): Promise<ReleasePublicationRecord> {
    const publication = this.publications.get(publicationId);
    if (!publication) {
      error({
        code: "release-not-found",
        message: `Release publication ${publicationId} does not exist.`,
        affectedObject: publicationId,
        recoveryAction: "use the publication ID returned by the request operation",
        receipt: `publication=${publicationId}; record=missing`,
      });
    }
    if (publication.state !== "proposed") return clone(publication);
    const release = this.releases.get(publication.releaseId);
    if (!release) {
      this.fail(publication, "failed", "The registered immutable Release disappeared before publication.", "restore the Release registry before retrying", `release=${publication.releaseId}; registry=missing`);
      return clone(publication);
    }
    const artifact = release.artifacts.find((candidate) => candidate.id === publication.artifactId);
    if (!artifact) {
      this.fail(publication, "blocked", `Artifact ${publication.artifactId} disappeared from the immutable Release.`, "restore the exact Release snapshot before retrying", `release=${release.release.id}; artifact=${publication.artifactId}; present=false`);
      return clone(publication);
    }
    this.transition(publication, "publishing", `publication=publishing; releaseDigest=${release.releaseDigest}; artifactDigest=${artifact.digest}`);
    const result = await this.invoke(() => this.adapter.publish({
      publicationId: publication.id,
      attempt: publication.attempt,
      release: clone(release),
      artifact: clone(artifact),
      target: clone(this.target),
    }));
    if (result.status === "failed") {
      const state: ReleasePublicationState = result.outcome === "indeterminate"
        ? "degraded"
        : result.retryable ? "failed" : "blocked";
      if (state === "degraded") this.target.publicationState = "degraded";
      this.fail(publication, state, `Target publication failed: ${result.message}`, result.recoveryAction, result.receipt);
      return clone(publication);
    }
    if (!providerMatches(result.value, publication)) {
      this.target.publicationState = "degraded";
      this.fail(publication, "degraded", "Target adapter returned a different Release or Artifact lineage.", "reconcile the provider publication before retrying", `expectedReleaseDigest=${publication.releaseDigest}; receivedReleaseDigest=${result.value.releaseDigest}; expectedArtifactDigest=${publication.artifactDigest}; receivedArtifactDigest=${result.value.artifactDigest}`);
      return clone(publication);
    }
    publication.providerObjectId = result.value.providerObjectId;
    if (result.value.providerReleaseId !== undefined) publication.providerReleaseId = result.value.providerReleaseId;
    if (result.value.providerAssetId !== undefined) publication.providerAssetId = result.value.providerAssetId;
    if (result.value.providerReleaseUrl !== undefined) publication.providerReleaseUrl = result.value.providerReleaseUrl;
    if (result.value.providerAssetUrl !== undefined) publication.providerAssetUrl = result.value.providerAssetUrl;
    if (result.value.providerAssetApiUrl !== undefined) publication.providerAssetApiUrl = result.value.providerAssetApiUrl;
    if (result.value.providerMediaType !== undefined) publication.providerMediaType = result.value.providerMediaType;
    if (result.value.providerByteLength !== undefined) publication.providerByteLength = result.value.providerByteLength;
    if (result.value.disclosure !== undefined) publication.disclosure = result.value.disclosure;
    if (result.value.providerCapabilities !== undefined) publication.providerCapabilities = result.value.providerCapabilities;
    this.target.currentReleaseId = release.release.id;
    this.target.currentArtifactId = artifact.id;
    if (this.target.releaseHistory[this.target.releaseHistory.length - 1] !== release.release.id) {
      this.target.releaseHistory = [...this.target.releaseHistory, release.release.id];
    }
    this.target.publicationState = "published";
    this.target.state = "healthy";
    publication.receipt = `publication=published; target=${this.target.id}; release=${release.release.id}; artifact=${artifact.id}; releaseDigest=${release.releaseDigest}; artifactDigest=${artifact.digest}; providerReceipt=${result.receipt}`;
    this.transition(publication, "published", publication.receipt);
    return clone(publication);
  }

  private executeOnce(publicationId: string): Promise<ReleasePublicationRecord> {
    const running = this.executions.get(publicationId);
    if (running) return running;
    const execution = this.execute(publicationId);
    this.executions.set(publicationId, execution);
    const cleanup = (): void => {
      if (this.executions.get(publicationId) === execution) this.executions.delete(publicationId);
    };
    void execution.then(cleanup, cleanup);
    return execution;
  }

  private async invoke(call: () => Promise<DeliveryAdapterResult<PublishedArtifact>>): Promise<DeliveryAdapterResult<PublishedArtifact>> {
    try {
      return await call();
    } catch (thrown) {
      return adapterThrown("publish", thrown);
    }
  }

  private fail(publication: ReleasePublicationRecord, state: "failed" | "blocked" | "degraded", message: string, recoveryAction: string, receipt: string): void {
    publication.recoveryAction = recoveryAction;
    publication.receipt = `publication=${state}; ${message}; ${receipt}`;
    this.transition(publication, state, publication.receipt);
  }

  private transition(publication: ReleasePublicationRecord, next: ReleasePublicationState, receipt: string): void {
    if (!transitions[publication.state].includes(next)) {
      error({
        code: "invalid-state",
        message: `Release publication ${publication.id} cannot transition from ${publication.state} to ${next}.`,
        affectedObject: publication.id,
        recoveryAction: "inspect the publication event ledger and resume from its recorded state",
        receipt: `publication=${publication.id}; from=${publication.state}; to=${next}`,
      });
    }
    const from = publication.state;
    publication.state = next;
    publication.updatedAt = this.now();
    this.emit(publication, from, next, receipt);
  }

  private emit(publication: ReleasePublicationRecord, from: ReleasePublicationState | null, to: ReleasePublicationState, receipt: string): void {
    this.events.push({
      protocol: CONTRACT_VERSIONS.releasePublication,
      id: opaqueId("release-publication-event"),
      publicationId: publication.id,
      sequence: this.events.length + 1,
      from,
      to,
      attempt: publication.attempt,
      operationId: opaqueId("release-publication-operation"),
      idempotencyKey: publication.idempotencyKey,
      actor: clone(publication.actor),
      createdAt: this.now(),
      receipt,
    });
  }
}

export async function publishReleaseArtifact(input: {
  coordinator: ReleasePublicationCoordinator;
  releaseId: string;
  artifactId: string;
  idempotencyKey: string;
  actor: ActorRef;
  expectedCurrentReleaseId?: string | null;
}): Promise<ReleasePublicationRecord> {
  return input.coordinator.publish({
    releaseId: input.releaseId,
    artifactId: input.artifactId,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    ...(input.expectedCurrentReleaseId !== undefined ? { expectedCurrentReleaseId: input.expectedCurrentReleaseId } : {}),
  });
}
