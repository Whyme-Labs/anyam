import { randomUUID } from "node:crypto";

export const CONTRACT_VERSIONS = {
  kernel: "anyam.kernel/v1",
  project: "anyam.project/v1",
  sourceSpace: "anyam.source-space/v1",
  action: "anyam.action/v1",
  verifier: "anyam.verifier/v1",
  workspace: "anyam.workspace/v1",
  change: "anyam.change/v1",
  conflict: "anyam.conflict/v1",
  landing: "anyam.landing/v1",
  reviewFinding: "anyam.review-finding/v1",
  reviewApproval: "anyam.review-approval/v1",
  integrationCohort: "anyam.integration-cohort/v1",
  integrationConflict: "anyam.integration-conflict/v1",
  collaborationAudit: "anyam.collaboration-audit/v1",
  collaborationPolicyExplanation: "anyam.collaboration-policy-explanation/v1",
  run: "anyam.run/v1",
  runner: "anyam.runner/v1",
  runnerJob: "anyam.runner-job/v1",
  runnerAttempt: "anyam.runner-attempt/v1",
  runnerOutput: "anyam.runner-output/v1",
  runnerEvent: "anyam.runner-event/v1",
  acceptanceCriterion: "anyam.acceptance-criterion/v1",
  qualificationEvidence: "anyam.qualification-evidence/v1",
  qualificationPlan: "anyam.qualification-plan/v1",
  stageGate: "anyam.stage-gate/v1",
  stageGateDecision: "anyam.stage-gate-decision/v1",
  reliabilityObjective: "anyam.reliability-objective/v1",
  usageReceipt: "anyam.usage-receipt/v1",
  providerCostReceipt: "anyam.provider-cost-receipt/v1",
  budgetPolicy: "anyam.budget-policy/v1",
  budgetDecision: "anyam.budget-decision/v1",
  recoveryDrill: "anyam.recovery-drill/v1",
  residualRisk: "anyam.residual-risk/v1",
  evidence: "anyam.evidence/v1",
  artifact: "anyam.artifact/v1",
  release: "anyam.release/v1",
  target: "anyam.target/v1",
  verifiedRelease: "anyam.verified-release/v1",
  promotion: "anyam.promotion/v1",
  releasePublication: "anyam.release-publication/v1",
  healthObservation: "anyam.health-observation/v1",
  targetAdapter: "anyam.target-adapter/v1",
  capability: "anyam.capability/v1",
  realm: "anyam.realm/v1",
  principal: "anyam.principal/v1",
  agent: "anyam.agent/v1",
  actor: "anyam.actor/v1",
  session: "anyam.session/v1",
  task: "anyam.task/v1",
  policy: "anyam.policy/v1",
  credential: "anyam.credential/v1",
  audit: "anyam.audit/v1",
  installation: "anyam.installation/v1",
  recovery: "anyam.recovery/v1",
  command: "anyam.command/v1",
  event: "anyam.event/v1",
  export: "anyam.export/v1",
  extension: "anyam.extension/v1",
  extensionInstallation: "anyam.extension-installation/v1",
  extensionEvent: "anyam.extension-event/v1",
  governanceProfile: "anyam.governance-profile/v1",
  governanceProfileExport: "anyam.governance-profile-export/v1",
  governanceControlEvidence: "anyam.governance-control-evidence/v1",
  governanceEvaluation: "anyam.governance-evaluation/v1",
  publicProjection: "anyam.public-projection/v1",
  publicationChange: "anyam.publication-change/v1",
  sealedVerifier: "anyam.sealed-verifier/v1",
  disclosure: "anyam.disclosure/v1",
  mirror: "anyam.mirror/v1",
  mirrorOperation: "anyam.mirror-operation/v1",
  mirrorCheckpoint: "anyam.mirror-checkpoint/v1",
  publicIntake: "anyam.public-intake/v1",
  publicGateway: "anyam.public-gateway/v1",
  publicGatewayAbuse: "anyam.public-gateway-abuse/v1",
  publicGatewayLedger: "anyam.public-gateway-ledger/v1",
  publicGatewayReplayArchive: "anyam.public-gateway-replay-archive/v1",
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

export type Action = {
  protocol: typeof CONTRACT_VERSIONS.action;
  id: string;
  moduleId: string;
  moduleRoot: string;
  dependencyIds: readonly string[];
  command: string;
  inputGlobs: readonly string[];
  outputPaths: readonly string[];
  network: readonly string[];
  resources: Readonly<Record<string, string | number | boolean>>;
  contractDigest: string;
};

export type VerifierDisclosure = "full" | "result-only";

export type Verifier = {
  protocol: typeof CONTRACT_VERSIONS.verifier;
  id: string;
  actionId: string;
  disclosure: VerifierDisclosure;
  requiredFor: readonly string[];
  contractDigest: string;
};

export type ProjectRevision = {
  protocol: typeof CONTRACT_VERSIONS.kernel;
  id: string;
  projectId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  /** The accepted Project Revision immediately before this one, when landed. */
  parentProjectRevisionId?: string;
  /** The Change Revision whose Landing produced this Project Revision. */
  landedChangeRevisionId?: string;
  /** All Change Revisions landed atomically by an Integration Cohort. */
  landedChangeRevisionIds?: readonly string[];
  /** The Integration Cohort whose Landing produced this Project Revision. */
  landingCohortId?: string;
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
  /** The current Workspace for this Change, when one has been assigned. */
  workspaceId?: string;
  /** Set only for a Revert Change; the landed Change Revision it restores. */
  revertsChangeRevisionId?: string;
  /** The Actor that authored the stable Change, when the caller can disclose it. */
  author?: ActorRef;
  /** Provenance for a Change created from an external Repository Mirror. */
  origin?: ChangeOrigin;
};

export type ChangeOrigin = {
  kind: "local" | "mirror";
  source: string;
  mirrorId?: string;
  remoteRepository?: string;
  remoteRef?: string;
  remoteCommit?: string;
  remoteAuthor?: { name: string; email?: string };
  disclosure: DisclosureClassification;
  receipt: string;
};

export type ChangeRevisionKind = "implementation" | "rebase" | "conflict-resolution" | "handoff" | "revert";

export type ChangeRevision = {
  protocol: typeof CONTRACT_VERSIONS.change;
  id: string;
  changeId: string;
  projectRevisionId: string;
  projectViewId: string;
  sequence: number;
  parentRevisionId: string | undefined;
  declaredEffects: readonly string[];
  /** The exact base that the Workspace was created from. */
  baseProjectRevisionId?: string;
  /** The Workspace that produced this immutable revision. */
  workspaceId?: string;
  /** Source Space snapshots changed by this revision. */
  sourceSpaceSnapshots?: Readonly<Record<string, string>>;
  /** Source Spaces whose content or disclosure policy is affected. */
  affectedSourceSpaceIds?: readonly string[];
  /** Modules whose declared scope is affected by this revision. */
  affectedModuleIds?: readonly string[];
  /** Targets whose declared scope is affected by this revision. */
  affectedTargetIds?: readonly string[];
  /** The Actor that authored this immutable revision, when disclosed. */
  author?: ActorRef;
  /** Conflicts explicitly considered by this revision. */
  conflictIds?: readonly string[];
  kind?: ChangeRevisionKind;
};

export type WorkspaceMount = {
  sourceSpaceId: string;
  snapshotId: string;
  mountPath: string;
};

export type WorkspaceState = "active" | "blocked" | "closed";

export type Workspace = {
  protocol: typeof CONTRACT_VERSIONS.workspace;
  id: string;
  projectId: string;
  projectRevisionId: string;
  projectViewId: string;
  mounts: readonly WorkspaceMount[];
  state: WorkspaceState;
  changeId?: string;
  actorId?: string;
};

export type ConflictKind = "textual" | "structural" | "semantic" | "schema" | "dependency" | "policy" | "disclosure";
export type ConflictState = "open" | "resolved";

export type Conflict = {
  protocol: typeof CONTRACT_VERSIONS.conflict;
  id: string;
  projectId: string;
  changeId: string;
  workspaceId: string;
  kind: ConflictKind;
  sourceSpaceIds: readonly string[];
  paths: readonly string[];
  description: string;
  state: ConflictState;
  resolutionRevisionId?: string;
};

export type Landing = {
  protocol: typeof CONTRACT_VERSIONS.landing;
  id: string;
  projectId: string;
  changeId: string;
  changeRevisionId: string;
  previousProjectRevisionId: string;
  projectRevisionId: string;
  receipt: string;
  /** The cohort that atomically produced this Landing, when applicable. */
  cohortId?: string;
  /** All stable Changes included in this Landing, when applicable. */
  changeIds?: readonly string[];
  /** All exact Change Revisions included in this Landing, when applicable. */
  changeRevisionIds?: readonly string[];
};

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "indeterminate";

export type Run = {
  protocol: typeof CONTRACT_VERSIONS.run;
  id: string;
  actionId: string;
  projectRevisionId: string;
  projectViewId: string;
  runnerId: string;
  attemptId?: string;
  status: RunStatus;
  outputDigest: string | undefined;
  changeRevisionId?: string;
  workspaceId?: string;
  inputDigests?: readonly string[];
  outputDigests?: readonly string[];
  effectDigests?: readonly string[];
  dependencyDigest?: string;
  toolchainDigest?: string;
  environmentDigest?: string;
  policyVersion?: string;
  targetId?: string;
  actor?: ActorRef;
  capabilityGrantId?: string;
  exitCode?: number;
  stdoutDigest?: string;
  stderrDigest?: string;
};

export type RunnerStatus = "enrolled" | "active" | "unavailable" | "disabled" | "quarantined";

export type RunnerProfile = {
  protocol: typeof CONTRACT_VERSIONS.runner;
  id: string;
  realmId: string;
  provider: string;
  publicKey: string;
  platform: {
    operatingSystem: string;
    architecture: string;
    isolation: string;
  };
  capabilities: readonly string[];
  networkDestinations: readonly string[];
  secretUse: "brokered" | "none" | "unverified";
  canUploadArtifacts: boolean;
  canUploadEvidence: boolean;
  status: RunnerStatus;
  profileDigest: string;
  enrolledAt: string;
  updatedAt: string;
  receipt: string;
};

export type RunnerJobState = "queued" | "offered" | "claimed" | "running" | "cancel-requested" | "succeeded" | "failed" | "indeterminate" | "cancelled" | "expired" | "quarantined";

export type RunnerOutputLocations = {
  logs: string;
  artifacts: string;
  evidence: string;
};

export type RunnerJob = {
  protocol: typeof CONTRACT_VERSIONS.runnerJob;
  id: string;
  projectId: string;
  runId: string;
  actionId: string;
  verifierId?: string;
  projectRevisionId: string;
  projectViewId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  changeRevisionId?: string;
  workspaceId?: string;
  targetId?: string;
  inputManifestDigest: string;
  inputDigests: readonly string[];
  outputPaths: readonly string[];
  effectDigests: readonly string[];
  dependencyDigest: string;
  toolchainDigest: string;
  environmentDigest: string;
  policyVersion: string;
  authorizationEpoch: string;
  capabilityGrantId: string;
  actor: ActorRef;
  disclosure: DisclosurePolicyRef;
  runnerRequirements: readonly string[];
  networkDestinations: readonly string[];
  secretUseAliases: readonly string[];
  outputLocations: RunnerOutputLocations;
  state: RunnerJobState;
  idempotencyKey: string;
  attemptIds: readonly string[];
  currentAttemptId: string;
  currentRunnerId?: string;
  createdAt: string;
  updatedAt: string;
  recoveryAction?: string;
  receipt: string;
};

export type RunnerAttemptState = "queued" | "offered" | "claimed" | "running" | "cancel-requested" | "succeeded" | "failed" | "indeterminate" | "cancelled" | "expired" | "quarantined";

export type RunnerAttempt = {
  protocol: typeof CONTRACT_VERSIONS.runnerAttempt;
  id: string;
  jobId: string;
  runId: string;
  runnerId?: string;
  state: RunnerAttemptState;
  leaseExpiresAt: string;
  challengeDigest?: string;
  jobCredentialDigest?: string;
  claimedAt?: string;
  lastHeartbeatAt?: string;
  completedAt?: string;
  resultDigest?: string;
  recoveryAction?: string;
  receipt: string;
};

export type RunnerOutputKind = "log" | "artifact" | "evidence";

export type RunnerOutputReference = {
  protocol: typeof CONTRACT_VERSIONS.runnerOutput;
  id: string;
  kind: RunnerOutputKind;
  runId: string;
  attemptId: string;
  location: string;
  digest: string;
  disclosure: DisclosurePolicyRef;
  receipt: string;
};

export type RunnerEvent = {
  protocol: typeof CONTRACT_VERSIONS.runnerEvent;
  id: string;
  sequence: number;
  type: string;
  runnerId?: string;
  jobId?: string;
  attemptId?: string;
  runId?: string;
  actor?: ActorRef;
  from?: RunnerJobState | RunnerAttemptState;
  to?: RunnerJobState | RunnerAttemptState;
  occurredAt: string;
  receipt: string;
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
  sourceSpaceSnapshots?: Readonly<Record<string, string>>;
  actionContractDigest?: string;
  verifierContractDigest?: string;
  targetId?: string;
  workspaceId?: string;
};

export type Artifact = {
  protocol: typeof CONTRACT_VERSIONS.artifact;
  id: string;
  type: string;
  digest: string;
  projectRevisionId: string;
  changeRevisionId?: string;
  runId?: string;
  actionId?: string;
  outputPath?: string;
  provenanceDigest?: string;
  disclosure?: DisclosurePolicyRef;
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
  name?: string;
  changeRevisionId?: string;
  provenanceDigest?: string;
  receipt?: string;
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

export type ExtensionKind =
  | "repository-driver"
  | "action"
  | "verifier"
  | "target-adapter"
  | "project-experience"
  | "ide"
  | "agent-skill"
  | "app";

export type ExtensionTrust = "first-party" | "verified" | "unverified";

export type ExtensionLifecycle =
  | "proposed"
  | "installed"
  | "enabled"
  | "suspended"
  | "deprecated"
  | "replaced"
  | "revoked"
  | "blocked";

export type ExtensionProvenance = {
  source: string;
  publisher: string;
  signer?: string;
  attestation?: string;
  receipt: string;
};

export type ExtensionManifest = {
  protocol: typeof CONTRACT_VERSIONS.extension;
  id: string;
  name: string;
  version: string;
  kind: ExtensionKind;
  trust: ExtensionTrust;
  source: string;
  digest: string;
  requestedEffects: readonly string[];
  requestedCapabilities: readonly string[];
  lifecycle: ExtensionLifecycle;
  compatibility: readonly string[];
  provenance: ExtensionProvenance;
  deprecationReason?: string;
};

export type ExtensionScope =
  | { kind: "realm"; realmId: string }
  | { kind: "organization"; realmId: string; organizationId: string }
  | { kind: "project"; realmId: string; organizationId?: string; projectId: string };

export type ExtensionInstallation = {
  protocol: typeof CONTRACT_VERSIONS.extensionInstallation;
  id: string;
  manifestId: string;
  manifestVersion: string;
  manifestDigest: string;
  scope: ExtensionScope;
  lifecycle: ExtensionLifecycle;
  grantedEffects: readonly string[];
  grantedCapabilities: readonly string[];
  grantId: string;
  policyVersion: string;
  authorizationEpoch: number;
  installedBy: ActorRef;
  installedAt: string;
  lineageId: string;
  replacesInstallationId?: string;
  providerMigrationFrom?: string;
  receipt: string;
};

export type ExtensionEventKind =
  | "registered"
  | "install-requested"
  | "installed"
  | "enabled"
  | "suspended"
  | "deprecated"
  | "replaced"
  | "provider-migrated"
  | "revoked"
  | "blocked"
  | "invocation-proposed"
  | "invoked"
  | "invocation-blocked";

export type ExtensionEvent = {
  protocol: typeof CONTRACT_VERSIONS.extensionEvent;
  id: string;
  kind: ExtensionEventKind;
  installationId?: string;
  manifestId: string;
  previousInstallationId?: string;
  nextInstallationId?: string;
  actor?: ActorRef;
  occurredAt: string;
  reason: string;
  receipt: string;
};

export type GovernanceScope = {
  realmId: string;
  organizationId?: string;
  projectId?: string;
};

export type GovernanceControl = {
  id: string;
  title: string;
  requirement: string;
  owner: string;
  required: boolean;
  evidenceKinds: readonly string[];
  customerResponsibility?: string;
};

export type GovernanceProfile = {
  protocol: typeof CONTRACT_VERSIONS.governanceProfile;
  id: string;
  name: string;
  version: string;
  digest: string;
  scope: GovernanceScope;
  controls: readonly GovernanceControl[];
  provenance: ExtensionProvenance;
  policyVersion: string;
  lifecycle: "draft" | "active" | "retired";
  receipt: string;
};

export type GovernanceControlObservation = {
  controlId: string;
  status: "satisfied" | "failed" | "indeterminate";
  evidenceRefs: readonly string[];
  observedAt: string;
  owner: string;
  nextAction: string;
  disclosure: DisclosurePolicyRef;
  receipt: string;
};

export type GovernanceControlEvidence = {
  protocol: typeof CONTRACT_VERSIONS.governanceControlEvidence;
  id: string;
  profileId: string;
  profileDigest: string;
  scope: GovernanceScope;
  controlId: string;
  status: GovernanceControlObservation["status"];
  evidenceRefs: readonly string[];
  policyVersion: string;
  authorizationEpoch: number;
  observedAt: string;
  owner: string;
  nextAction: string;
  disclosure: DisclosurePolicyRef;
  certificationClaim: false;
  receipt: string;
};

export type GovernanceEvaluation = {
  protocol: typeof CONTRACT_VERSIONS.governanceEvaluation;
  id: string;
  profileId: string;
  profileDigest: string;
  scope: GovernanceScope;
  status: "ready" | "blocked" | "indeterminate";
  evidenceIds: readonly string[];
  blockers: readonly string[];
  advisories: readonly string[];
  policyVersion: string;
  authorizationEpoch: number;
  certificationClaim: false;
  receipt: string;
};

export type GovernanceProfileExport = {
  protocol: typeof CONTRACT_VERSIONS.governanceProfileExport;
  version: "v1";
  exportId: string;
  createdAt: string;
  profile: GovernanceProfile;
  observations: readonly GovernanceControlObservation[];
  evaluation: GovernanceEvaluation;
  credentialFree: true;
  integrityDigest: string;
  receipt: string;
};

export type ActorRef = {
  principalId: string;
  actorId: string;
  sessionId: string;
  clientId: string;
};

export type ResourceRef = {
  realmId: string;
  organizationId?: string;
  projectId?: string;
  sourceSpaceId?: string;
  workspaceId?: string;
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
  mirrors?: readonly RepositoryMirror[];
  mirrorOperationIds?: readonly string[];
  capabilityGrants: readonly CapabilityGrant[];
  extensions: readonly ExtensionManifest[];
  extensionInstallations?: readonly ExtensionInstallation[];
  extensionEvents?: readonly ExtensionEvent[];
  governanceProfiles?: readonly GovernanceProfile[];
  governanceControlEvidence?: readonly GovernanceControlEvidence[];
  governanceEvaluations?: readonly GovernanceEvaluation[];
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

export type MirrorDirection = "bidirectional";
export type MirrorState = "healthy" | "lagging" | "divergent" | "force-pushed" | "blocked" | "credential-failed" | "disabled";
export type MirrorRefMapping = { localRef: string; remoteRef: string };

export type RepositoryMirror = {
  protocol: typeof CONTRACT_VERSIONS.mirror;
  id: string;
  projectId: string;
  sourceSpaceId: string;
  provider: string;
  remoteRepository: string;
  direction: MirrorDirection;
  refMappings: readonly MirrorRefMapping[];
  disclosure: DisclosureClassification;
  state: MirrorState;
  canonicalProjectRevisionId: string;
  /** Projected remote ref names and OIDs from the last accepted sync boundary. */
  canonicalRefs: readonly GitRef[];
  remoteGeneration: string;
  remoteRefs: readonly GitRef[];
  pendingInboundChangeIds: readonly string[];
  lastOperationId?: string;
  lastOriginOperationId?: string;
  checkpointId?: string;
  createdAt: string;
  updatedAt: string;
  receipt: string;
};

export type MirrorOperation = {
  protocol: typeof CONTRACT_VERSIONS.mirrorOperation;
  id: string;
  mirrorId: string;
  kind: "sync" | "outbound" | "inbound" | "reconcile";
  state: "started" | "succeeded" | "failed" | "blocked" | "degraded";
  canonicalProjectRevisionId: string;
  expectedRemoteGeneration: string;
  actualRemoteGeneration?: string;
  actor?: ActorRef;
  inboundChangeIds: readonly string[];
  checkpointId: string;
  errorCode?: string;
  createdAt: string;
  completedAt?: string;
  receipt: string;
};

export type MirrorCheckpoint = {
  protocol: typeof CONTRACT_VERSIONS.mirrorCheckpoint;
  id: string;
  mirrorId: string;
  operationId: string;
  state: "preflight" | "remote-inspected" | "inbound-proposals" | "outbound-applied" | "blocked" | "completed";
  canonicalProjectRevisionId: string;
  canonicalRefs: readonly GitRef[];
  remoteGeneration: string;
  remoteRefs: readonly GitRef[];
  completedInboundChangeIds: readonly string[];
  recoveryAction: string;
  receipt: string;
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
  parentProjectRevisionId?: string;
  landedChangeRevisionId?: string;
  landedChangeRevisionIds?: readonly string[];
  landingCohortId?: string;
}): ProjectRevision {
  return {
    protocol: CONTRACT_VERSIONS.kernel,
    id: input.id ?? opaqueId("project-revision"),
    projectId: input.projectId,
    sourceSpaceSnapshots: { ...input.sourceSpaceSnapshots },
    ...(input.parentProjectRevisionId ? { parentProjectRevisionId: input.parentProjectRevisionId } : {}),
    ...(input.landedChangeRevisionId ? { landedChangeRevisionId: input.landedChangeRevisionId } : {}),
    ...(input.landedChangeRevisionIds ? { landedChangeRevisionIds: [...input.landedChangeRevisionIds] } : {}),
    ...(input.landingCohortId ? { landingCohortId: input.landingCohortId } : {}),
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
