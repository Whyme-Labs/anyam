import { randomUUID } from "node:crypto";

export const CONTRACT_VERSIONS = {
  kernel: "anyam.kernel/v1",
  project: "anyam.project/v1",
  sourceSpace: "anyam.source-space/v1",
  change: "anyam.change/v1",
  run: "anyam.run/v1",
  evidence: "anyam.evidence/v1",
  artifact: "anyam.artifact/v1",
  release: "anyam.release/v1",
  target: "anyam.target/v1",
  capability: "anyam.capability/v1",
  command: "anyam.command/v1",
  event: "anyam.event/v1",
  export: "anyam.export/v1",
  extension: "anyam.extension/v1",
} as const;

export type SourceSpaceClassification = "public" | "internal" | "restricted" | "result-only";
export type DisclosureClassification = "public" | "project" | "restricted";
export type EvidenceOutcome = "passed" | "failed" | "stale" | "indeterminate";

export type ProjectInput = {
  id: string;
  name: string;
  referenceType: string;
  sourceSpaceIds: readonly string[];
};

export type Project = ProjectInput & {
  protocol: typeof CONTRACT_VERSIONS.project;
};

export type SourceSpace = {
  protocol: typeof CONTRACT_VERSIONS.sourceSpace;
  id: string;
  name: string;
  classification: SourceSpaceClassification;
};

export type ProjectRevision = {
  protocol: typeof CONTRACT_VERSIONS.kernel;
  id: string;
  projectId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
};

export type ProjectView = {
  protocol: typeof CONTRACT_VERSIONS.kernel;
  id: string;
  projectId: string;
  projectRevisionId: string;
  projectionId: string;
  classification: DisclosureClassification;
  visibleSourceSpaceIds: readonly string[];
  disclosedSourceSpaceSnapshots: Readonly<Record<string, string>>;
};

export type ProjectViewProjectionErrorCode =
  | "revision-project-mismatch"
  | "unknown-source-space"
  | "source-space-not-in-project"
  | "missing-source-space-snapshot"
  | "duplicate-source-space"
  | "duplicate-source-space-catalog"
  | "disclosure-classification-mismatch";

/**
 * Projection requests fail closed. A partial view is not a valid authorization
 * result: callers must either name a known, revisioned project Source Space or
 * fix the request before continuing.
 */
export class ProjectViewProjectionError extends Error {
  readonly code: ProjectViewProjectionErrorCode;
  readonly sourceSpaceId: string | undefined;

  constructor(code: ProjectViewProjectionErrorCode, message: string, sourceSpaceId?: string) {
    super(message);
    this.name = "ProjectViewProjectionError";
    this.code = code;
    this.sourceSpaceId = sourceSpaceId;
  }
}

export type ChangeStatus = "draft" | "active" | "submitted" | "landed" | "blocked" | "abandoned";

export type Change = {
  protocol: typeof CONTRACT_VERSIONS.change;
  id: string;
  projectId: string;
  intentId: string;
  baseProjectRevisionId: string;
  status: ChangeStatus;
  /** JSON-stable empty state; a Change with no published revision has null. */
  latestRevisionId: string | null;
};

export type ChangeRevision = {
  protocol: typeof CONTRACT_VERSIONS.change;
  id: string;
  changeId: string;
  projectRevisionId: string;
  projectViewId: string;
  sequence: number;
  parentRevisionId: string | undefined;
  declaredEffects: readonly string[];
};

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "indeterminate";

export type Run = {
  protocol: typeof CONTRACT_VERSIONS.run;
  id: string;
  actionId: string;
  projectRevisionId: string;
  projectViewId: string;
  runnerId: string;
  status: RunStatus;
  outputDigest: string | undefined;
};

export type DisclosurePolicyRef = {
  projectionId: string;
  classification: DisclosureClassification;
};

export type EvidenceProducer = {
  kind: "run" | "review" | "policy" | "attestation";
  id: string;
  version: string;
};

export type Evidence = {
  protocol: typeof CONTRACT_VERSIONS.evidence;
  version: "v1";
  id: string;
  key: string;
  criterion: string;
  outcome: EvidenceOutcome;
  validityKey: string;
  actionId: string;
  verifierId: string;
  toolchainDigest: string;
  dependencyDigest: string;
  environmentDigest: string;
  inputDigests: readonly string[];
  effectDigests: readonly string[];
  outputDigest: string;
  createdAt: string;
  producer: EvidenceProducer;
  projectRevisionId: string;
  projectViewId: string;
  changeRevisionId?: string;
  runId: string;
  actor: ActorRef;
  runnerId: string;
  policyVersion: string;
  authorizationEpoch: string;
  capabilityGrantId: string;
  disclosure: DisclosurePolicyRef;
  receipt: string;
  invalidators: readonly string[];
  owner: string;
  residualRiskId?: string;
};

export type Artifact = {
  protocol: typeof CONTRACT_VERSIONS.artifact;
  id: string;
  type: string;
  digest: string;
  projectRevisionId: string;
};

export type ReleaseStatus = "draft" | "ready" | "promoted" | "recalled";

export type Release = {
  protocol: typeof CONTRACT_VERSIONS.release;
  id: string;
  projectRevisionId: string;
  artifactIds: readonly string[];
  evidenceIds: readonly string[];
  configurationDigests: readonly string[];
  stateAssumptions: readonly string[];
  policyVersion: string;
  status: ReleaseStatus;
};

export type TargetState = "configured" | "healthy" | "degraded" | "unknown";

export type Target = {
  protocol: typeof CONTRACT_VERSIONS.target;
  id: string;
  projectId: string;
  name: string;
  adapterId: string;
  acceptedArtifactTypes: readonly string[];
  requiredEvidenceKeys: readonly string[];
  state: TargetState;
};

export type CapabilityGrantStatus = "active" | "revoked" | "expired";

export type CapabilityGrant = {
  protocol: typeof CONTRACT_VERSIONS.capability;
  id: string;
  realmId: string;
  subjectId: string;
  resource: ResourceRef;
  actions: readonly string[];
  expiresAt: string;
  status: CapabilityGrantStatus;
};

export type ExtensionManifest = {
  protocol: typeof CONTRACT_VERSIONS.extension;
  id: string;
  name: string;
  version: string;
  digest: string;
  requestedEffects: readonly string[];
  lifecycle: "installed" | "suspended" | "revoked";
  compatibility: readonly string[];
};

export type ActorRef = {
  principalId: string;
  actorId: string;
  sessionId: string;
  clientId: string;
};

export type ResourceRef = {
  realmId: string;
  projectId?: string;
  sourceSpaceId?: string;
  changeId?: string;
  runId?: string;
  releaseId?: string;
  targetId?: string;
};

export type TaskRef = {
  taskId: string;
  grantId: string;
  authorizationEpoch: string;
};

export type CommandEnvelope<TPayload> = {
  protocol: typeof CONTRACT_VERSIONS.command;
  version: "v1";
  requestId: string;
  operationId: string;
  idempotencyKey: string;
  actor: ActorRef;
  resource: ResourceRef;
  expected?: { aggregateId: string; version: number };
  task?: TaskRef;
  payload: TPayload;
};

export type DomainEvent<TPayload> = {
  protocol: typeof CONTRACT_VERSIONS.event;
  version: "v1";
  eventId: string;
  eventType: string;
  aggregate: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  producer: { context: string; version: string };
  disclosure: DisclosurePolicyRef;
  payload: TPayload;
};

export type ProjectExport = {
  protocol: typeof CONTRACT_VERSIONS.export;
  version: "v1";
  exportId: string;
  createdAt: string;
  project: Project;
  sourceSpaces: readonly SourceSpace[];
  repositories: readonly RepositoryExport[];
  largeObjects: readonly LargeObjectRef[];
  lineage: readonly ProjectExportLineage[];
  projectRevisions: readonly ProjectRevision[];
  changes: readonly Change[];
  evidence: readonly Evidence[];
  artifacts: readonly Artifact[];
  releases: readonly Release[];
  targets: readonly Target[];
  capabilityGrants: readonly CapabilityGrant[];
  extensions: readonly ExtensionManifest[];
  policies: readonly string[];
  auditEventIds: readonly string[];
  recoveryCheckpointIds: readonly string[];
  recovery: ProjectExportRecovery;
  integrity: ProjectExportIntegrity;
};

export type GitObjectFormat = "sha1" | "sha256";

export type GitRef = {
  name: string;
  oid: string;
};

export type LargeObjectRef = {
  oid: string;
  size: number;
  mediaType?: string;
  relativePath?: string;
  digest?: string;
};

export type RepositoryExport = {
  protocol: "anyam.repository-export/v1";
  repositoryId: string;
  sourceSpaceId: string;
  objectFormat: GitObjectFormat;
  defaultBranch: string | null;
  refs: readonly GitRef[];
  bundle: {
    relativePath: string;
    digest: string;
    bytes: number;
  };
  lfs: {
    state: "empty" | "complete" | "incomplete" | "unavailable";
    objects: readonly LargeObjectRef[];
  };
};

export type ProjectExportLineage = {
  projectRevisionId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
};

export type ProjectExportRecovery = {
  checkpointId: string;
  state: "verified" | "incomplete";
  resumeAction: string;
  receipt: string;
};

export type ProjectExportIntegrity = {
  manifestDigest: string;
  repositoryDigests: readonly string[];
  credentialFree: boolean;
  receipt: string;
};

export function createProject(input: ProjectInput): Project {
  return { protocol: CONTRACT_VERSIONS.project, ...input, sourceSpaceIds: [...input.sourceSpaceIds] };
}

export function createProjectRevision(input: {
  projectId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  id?: string;
}): ProjectRevision {
  return {
    protocol: CONTRACT_VERSIONS.kernel,
    id: input.id ?? opaqueId("project-revision"),
    projectId: input.projectId,
    sourceSpaceSnapshots: { ...input.sourceSpaceSnapshots },
  };
}

export function deriveProjectView(input: {
  project: Project;
  revision: ProjectRevision;
  sourceSpaces: readonly SourceSpace[];
  allowedSourceSpaceIds: readonly string[];
  projectionId: string;
  classification?: DisclosureClassification;
}): ProjectView {
  // `allowedSourceSpaceIds` is already the result of policy/capability
  // evaluation. This pure kernel function validates the requested composition;
  // the caller must map unauthorized-resource errors to a safe not-found view.
  if (input.revision.projectId !== input.project.id) {
    throw new ProjectViewProjectionError(
      "revision-project-mismatch",
      `Project Revision ${input.revision.id} belongs to ${input.revision.projectId}, not Project ${input.project.id}.`,
    );
  }

  if (new Set(input.sourceSpaces.map((space) => space.id)).size !== input.sourceSpaces.length) {
    throw new ProjectViewProjectionError(
      "duplicate-source-space-catalog",
      "A Project View projection catalog cannot contain duplicate Source Space IDs.",
    );
  }
  const sourceSpaceById = new Map(input.sourceSpaces.map((space) => [space.id, space]));
  const projectSpaceIds = new Set(input.project.sourceSpaceIds);
  if (new Set(input.allowedSourceSpaceIds).size !== input.allowedSourceSpaceIds.length) {
    throw new ProjectViewProjectionError(
      "duplicate-source-space",
      "A Project View cannot disclose the same Source Space more than once.",
    );
  }
  for (const id of input.allowedSourceSpaceIds) {
    if (!sourceSpaceById.has(id)) {
      throw new ProjectViewProjectionError(
        "unknown-source-space",
        `Source Space ${id} is not present in the projection catalog.`,
        id,
      );
    }
    if (!projectSpaceIds.has(id)) {
      throw new ProjectViewProjectionError(
        "source-space-not-in-project",
        `Source Space ${id} is not owned by Project ${input.project.id}.`,
        id,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(input.revision.sourceSpaceSnapshots, id)) {
      throw new ProjectViewProjectionError(
        "missing-source-space-snapshot",
        `Project Revision ${input.revision.id} has no snapshot for Source Space ${id}.`,
        id,
      );
    }
    const sourceSpace = sourceSpaceById.get(id);
    if (input.classification === "public" && sourceSpace?.classification !== "public") {
      throw new ProjectViewProjectionError(
        "disclosure-classification-mismatch",
        `Public Project View cannot disclose Source Space ${id} classified as ${sourceSpace?.classification ?? "unknown"}.`,
        id,
      );
    }
  }

  const visibleSourceSpaceIds = [...input.allowedSourceSpaceIds];
  const disclosedSourceSpaceSnapshots = Object.fromEntries(
    visibleSourceSpaceIds.flatMap((id) => {
      const snapshot = input.revision.sourceSpaceSnapshots[id];
      return snapshot === undefined ? [] : [[id, snapshot]];
    }),
  ) as Readonly<Record<string, string>>;

  return {
    protocol: CONTRACT_VERSIONS.kernel,
    id: opaqueId("project-view"),
    projectId: input.project.id,
    projectRevisionId: input.revision.id,
    projectionId: input.projectionId,
    classification: input.classification ?? "project",
    visibleSourceSpaceIds,
    disclosedSourceSpaceSnapshots,
  };
}

export function createCommand<TPayload>(input: {
  operationId: string;
  actor: ActorRef;
  resource: ResourceRef;
  idempotencyKey: string;
  payload: TPayload;
  expected?: { aggregateId: string; version: number };
  task?: TaskRef;
}): CommandEnvelope<TPayload> {
  return {
    protocol: CONTRACT_VERSIONS.command,
    version: "v1",
    requestId: opaqueId("request"),
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    resource: input.resource,
    ...(input.expected ? { expected: input.expected } : {}),
    ...(input.task ? { task: input.task } : {}),
    payload: input.payload,
  };
}

export function createDomainEvent<TPayload>(input: {
  eventType: string;
  aggregate: string;
  aggregateId: string;
  aggregateVersion: number;
  disclosure: DisclosurePolicyRef;
  payload: TPayload;
}): DomainEvent<TPayload> {
  return {
    protocol: CONTRACT_VERSIONS.event,
    version: "v1",
    eventId: opaqueId("event"),
    eventType: input.eventType,
    aggregate: input.aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    occurredAt: new Date().toISOString(),
    producer: { context: "k0-harness", version: CONTRACT_VERSIONS.kernel },
    disclosure: input.disclosure,
    payload: input.payload,
  };
}

export function opaqueId(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}
