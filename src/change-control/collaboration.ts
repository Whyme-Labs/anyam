import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type Change,
  type ChangeRevision,
  type DisclosureClassification,
  type Evidence,
  type Landing,
  type ProjectRevision,
} from "../kernel/contracts.ts";
import type { EvidenceRequirement } from "../kernel/evidence.ts";

export type OwnershipScopeKind = "module" | "source-space" | "target";

/**
 * A review ownership rule names who must review an affected governed scope.
 * The rule is a requirement, not a grant: authorization still comes from the
 * Realm and the reviewer must be an active candidate in the directory.
 */
export type ReviewOwnershipRule = {
  id: string;
  scopeKind: OwnershipScopeKind;
  scopeId: string;
  requiredReviewerPrincipalIds: readonly string[];
  requiredReviewerTeamIds: readonly string[];
  disclosure: DisclosureClassification;
  label?: string;
};

export type ReviewerDirectoryEntry = {
  principalId: string;
  teamIds: readonly string[];
  active?: boolean;
};

export type ReviewRequirement = {
  id: string;
  ruleId: string;
  changeId: string;
  changeRevisionId: string;
  scopeKind: OwnershipScopeKind;
  scopeId: string;
  disclosure: DisclosureClassification;
  requiredReviewerPrincipalIds: readonly string[];
  requiredReviewerTeamIds: readonly string[];
  candidatePrincipalIds: readonly string[];
  reason: string;
};

export type ReviewFindingKind = "comment" | "request-changes" | "security" | "policy";
export type ReviewFindingSeverity = "info" | "warning" | "blocking";
export type ReviewFindingState = "open" | "resolved" | "dismissed";

export type ReviewScope = {
  moduleId?: string;
  sourceSpaceId?: string;
  targetId?: string;
  path?: string;
  symbol?: string;
};

export type ReviewFinding = {
  protocol: typeof CONTRACT_VERSIONS.reviewFinding;
  id: string;
  projectId: string;
  cohortId: string;
  changeId: string;
  changeRevisionId: string;
  author: ActorRef;
  kind: ReviewFindingKind;
  severity: ReviewFindingSeverity;
  state: ReviewFindingState;
  summary: string;
  scope?: ReviewScope;
  disclosure: DisclosureClassification;
  createdAt: string;
  updatedAt: string;
  resolution?: string;
  resolvedBy?: ActorRef;
  receipt: string;
};

export type ReviewApproval = {
  protocol: typeof CONTRACT_VERSIONS.reviewApproval;
  id: string;
  projectId: string;
  cohortId: string;
  requirementId: string;
  changeId: string;
  changeRevisionId: string;
  reviewer: ActorRef;
  authorActorId?: string;
  verifierActorIds: readonly string[];
  evidenceIds: readonly string[];
  policyVersion: string;
  approvedAt: string;
  receipt: string;
};

export type IntegrationCohortMember = {
  changeId: string;
  changeRevisionId: string;
  baseProjectRevisionId: string;
  author?: ActorRef;
  authorActorId?: string;
  verifierActorIds: readonly string[];
  affectedModuleIds: readonly string[];
  affectedSourceSpaceIds: readonly string[];
  affectedTargetIds: readonly string[];
  declaredEffects: readonly string[];
};

export type IntegrationConflictKind = "textual" | "semantic" | "schema" | "dependency" | "policy" | "disclosure";
export type IntegrationConflictSeverity = "blocking" | "warning";
export type IntegrationConflictState = "open" | "resolved";

export type IntegrationConflictCandidate = {
  kind: IntegrationConflictKind;
  severity: IntegrationConflictSeverity;
  changeIds: readonly string[];
  scopeIds: readonly string[];
  description: string;
  disclosure: DisclosureClassification;
  receipt: string;
  recoveryAction: string;
};

export type IntegrationConflict = {
  protocol: typeof CONTRACT_VERSIONS.integrationConflict;
  id: string;
  projectId: string;
  cohortId: string;
  kind: IntegrationConflictKind;
  severity: IntegrationConflictSeverity;
  state: IntegrationConflictState;
  changeIds: readonly string[];
  changeRevisionIds: readonly string[];
  scopeIds: readonly string[];
  analyzerId: string;
  description: string;
  disclosure: DisclosureClassification;
  createdAt: string;
  resolvedAt?: string;
  resolutionRevisionIds?: readonly string[];
  receipt: string;
  recoveryAction: string;
};

export type IntegrationCohortState = "proposed" | "blocked" | "ready" | "stale" | "landed";

export type IntegrationCohort = {
  protocol: typeof CONTRACT_VERSIONS.integrationCohort;
  id: string;
  projectId: string;
  baseProjectRevisionId: string;
  members: readonly IntegrationCohortMember[];
  conflictIds: readonly string[];
  state: IntegrationCohortState;
  createdBy: ActorRef;
  createdAt: string;
  updatedAt: string;
  receipt: string;
};

export type CollaborationPolicy = {
  version: string;
  requiredEvidence: readonly EvidenceRequirement[];
  requiredEvidenceByEffect?: Readonly<Record<string, readonly EvidenceRequirement[]>>;
};

export type IntegrationAnalyzerInput = {
  projectId: string;
  baseProjectRevisionId: string;
  members: readonly IntegrationCohortMember[];
};

export type IntegrationAnalyzer = {
  id: string;
  analyze(input: IntegrationAnalyzerInput): readonly IntegrationConflictCandidate[] | Promise<readonly IntegrationConflictCandidate[]>;
};

export type CollaborationAuditRole = "author" | "verifier" | "reviewer" | "landing" | "promotion" | "analyzer";

export type CollaborationAuditEvent = {
  protocol: typeof CONTRACT_VERSIONS.collaborationAudit;
  id: string;
  projectId: string;
  cohortId?: string;
  changeId?: string;
  changeRevisionId?: string;
  role: CollaborationAuditRole;
  action: string;
  outcome: "observed" | "succeeded" | "denied";
  actor: ActorRef;
  policyVersion: string;
  disclosure: DisclosureClassification;
  occurredAt: string;
  receipt: string;
};

export type CollaborationBlockerKind =
  | "stale-base"
  | "open-conflict"
  | "open-finding"
  | "required-reviewer"
  | "stale-approval"
  | "missing-evidence"
  | "stale-evidence"
  | "failed-evidence"
  | "separation-of-duty"
  | "invalid-state";

export type CollaborationBlocker = {
  kind: CollaborationBlockerKind;
  affectedObject: string;
  changeId?: string;
  scopeId?: string;
  disclosure: DisclosureClassification;
  message: string;
  recoveryAction: string;
  safeCommand: string;
};

export type CollaborationPolicyExplanation = {
  protocol: typeof CONTRACT_VERSIONS.collaborationPolicyExplanation;
  id: string;
  projectId: string;
  cohortId: string;
  decision: "allow" | "deny" | "indeterminate";
  policyVersion: string;
  authorizationEpoch?: string;
  baseProjectRevisionId: string;
  currentCanonicalProjectRevisionId: string;
  blockers: readonly CollaborationBlocker[];
  safeNextCommands: readonly string[];
  receipt: string;
};

export type LandingAuthority = {
  landCohort(input: {
    cohortId: string;
    members: readonly Pick<IntegrationCohortMember, "changeId" | "changeRevisionId">[];
    expectedCanonicalProjectRevisionId: string;
  }): Landing | Promise<Landing>;
};

export type CollaborationErrorCode =
  | "invalid-input"
  | "project-mismatch"
  | "duplicate-member"
  | "change-revision-mismatch"
  | "change-revision-not-latest"
  | "base-mismatch"
  | "cohort-not-found"
  | "conflict-not-found"
  | "finding-not-found"
  | "requirement-not-found"
  | "reviewer-not-required"
  | "separation-of-duty"
  | "idempotency-conflict"
  | "policy-blocked"
  | "landing-authority-unavailable"
  | "landing-result-mismatch";

export class CollaborationError extends Error {
  readonly code: CollaborationErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly explanation?: CollaborationPolicyExplanation;

  constructor(input: {
    code: CollaborationErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
    explanation?: CollaborationPolicyExplanation;
  }) {
    super(input.message);
    this.name = "CollaborationError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
    if (input.explanation) this.explanation = clone(input.explanation);
  }
}

export type CreateCohortMemberInput = {
  change: Change;
  revision: ChangeRevision;
  verifierActors?: readonly ActorRef[];
};

export type CollaborationCoordinatorInput = {
  projectId: string;
  canonicalRevision: ProjectRevision;
  policy: CollaborationPolicy;
  ownershipRules?: readonly ReviewOwnershipRule[];
  reviewerDirectory?: readonly ReviewerDirectoryEntry[];
  analyzers?: readonly IntegrationAnalyzer[];
  landingAuthority?: LandingAuthority;
  now?: () => string;
  authorizationEpoch?: string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new CollaborationError({
      code: "invalid-input",
      message: `${field} must not be empty.`,
      affectedObject: field,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function disclosureRank(value: DisclosureClassification): number {
  return value === "public" ? 0 : value === "project" ? 1 : 2;
}

function cloneActor(actor: ActorRef): ActorRef {
  return { ...actor };
}

function cloneMember(member: IntegrationCohortMember): IntegrationCohortMember {
  return {
    ...member,
    ...(member.author ? { author: cloneActor(member.author) } : {}),
    verifierActorIds: [...member.verifierActorIds],
    affectedModuleIds: [...member.affectedModuleIds],
    affectedSourceSpaceIds: [...member.affectedSourceSpaceIds],
    affectedTargetIds: [...member.affectedTargetIds],
    declaredEffects: [...member.declaredEffects],
  };
}

function cloneCohort(cohort: IntegrationCohort): IntegrationCohort {
  return {
    ...cohort,
    createdBy: cloneActor(cohort.createdBy),
    members: cohort.members.map(cloneMember),
    conflictIds: [...cohort.conflictIds],
  };
}

function cloneConflict(conflict: IntegrationConflict): IntegrationConflict {
  return {
    ...conflict,
    changeIds: [...conflict.changeIds],
    changeRevisionIds: [...conflict.changeRevisionIds],
    scopeIds: [...conflict.scopeIds],
    ...(conflict.resolutionRevisionIds ? { resolutionRevisionIds: [...conflict.resolutionRevisionIds] } : {}),
  };
}

function cloneFinding(finding: ReviewFinding): ReviewFinding {
  return {
    ...finding,
    author: cloneActor(finding.author),
    ...(finding.scope ? { scope: { ...finding.scope } } : {}),
    ...(finding.resolvedBy ? { resolvedBy: cloneActor(finding.resolvedBy) } : {}),
  };
}

function cloneApproval(approval: ReviewApproval): ReviewApproval {
  return {
    ...approval,
    reviewer: cloneActor(approval.reviewer),
    verifierActorIds: [...approval.verifierActorIds],
    evidenceIds: [...approval.evidenceIds],
  };
}

function cloneAudit(event: CollaborationAuditEvent): CollaborationAuditEvent {
  return { ...event, actor: cloneActor(event.actor) };
}

function classifyEffect(effect: string): IntegrationConflictKind {
  const normalized = effect.toLowerCase();
  if (normalized.startsWith("textual.") || normalized.includes("text-conflict")) return "textual";
  if (normalized.startsWith("schema.") || normalized.includes("migration")) return "schema";
  if (normalized.startsWith("dependency.") || normalized.includes("lockfile")) return "dependency";
  if (normalized.startsWith("policy.") || normalized.includes("ownership")) return "policy";
  if (normalized.startsWith("disclosure.") || normalized.includes("private")) return "disclosure";
  return "semantic";
}

/**
 * A conservative baseline analyzer. It only reports declared effect overlap;
 * it never claims that source behavior is universally understood. More
 * precise textual, symbol, schema, or dependency analyzers can be installed
 * through the same normalized adapter seam.
 */
export const declaredEffectOverlapAnalyzer: IntegrationAnalyzer = {
  id: "analyzer:declared-effect-overlap/v1",
  analyze(input) {
    const candidates: IntegrationConflictCandidate[] = [];
    for (let leftIndex = 0; leftIndex < input.members.length; leftIndex += 1) {
      const left = input.members[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < input.members.length; rightIndex += 1) {
        const right = input.members[rightIndex]!;
        const overlap = left.declaredEffects.filter((effect) => right.declaredEffects.includes(effect));
        for (const effect of overlap) {
          const kind = classifyEffect(effect);
          candidates.push({
            kind,
            severity: "blocking",
            changeIds: [left.changeId, right.changeId],
            scopeIds: [...new Set([
              ...left.affectedModuleIds,
              ...left.affectedSourceSpaceIds,
              ...left.affectedTargetIds,
              ...right.affectedModuleIds,
              ...right.affectedSourceSpaceIds,
              ...right.affectedTargetIds,
            ])],
            description: `Changes ${left.changeId} and ${right.changeId} both declare effect ${effect}.`,
            disclosure: "project",
            receipt: `analyzer=${this.id}; effect=${effect}; left=${left.changeId}; right=${right.changeId}`,
            recoveryAction: "run a semantic analyzer or publish a new Change Revision that resolves the effect conflict",
          });
        }
      }
    }
    return candidates;
  },
};

export type CollaborationEvaluationInput = {
  cohortId: string;
  evidence: readonly Evidence[];
  audience?: DisclosureClassification;
  visibleScopeIds?: readonly string[];
};

export type CollaborationLandingResult = {
  landing: Landing;
  explanation: CollaborationPolicyExplanation;
};

export class CollaborationCoordinator {
  private readonly projectId: string;
  private policy: CollaborationPolicy;
  private readonly ownershipRules: readonly ReviewOwnershipRule[];
  private readonly reviewerDirectory: readonly ReviewerDirectoryEntry[];
  private readonly analyzers: readonly IntegrationAnalyzer[];
  private readonly landingAuthority: LandingAuthority | undefined;
  private readonly now: () => string;
  private readonly authorizationEpoch: string | undefined;
  private canonicalRevision: ProjectRevision;
  private readonly cohorts = new Map<string, IntegrationCohort>();
  private readonly conflicts = new Map<string, IntegrationConflict>();
  private readonly findings = new Map<string, ReviewFinding>();
  private readonly approvals = new Map<string, ReviewApproval>();
  private readonly idempotency = new Map<string, string>();
  private readonly audit: CollaborationAuditEvent[] = [];

  constructor(input: CollaborationCoordinatorInput) {
    nonEmpty(input.projectId, "projectId");
    if (input.canonicalRevision.projectId !== input.projectId) {
      throw new CollaborationError({
        code: "project-mismatch",
        message: `Canonical Project Revision ${input.canonicalRevision.id} belongs to ${input.canonicalRevision.projectId}, not ${input.projectId}.`,
        affectedObject: input.canonicalRevision.id,
        recoveryAction: "construct the collaboration coordinator with the Project's canonical revision",
        receipt: `canonicalProject=${input.canonicalRevision.projectId}; coordinatorProject=${input.projectId}`,
      });
    }
    nonEmpty(input.policy.version, "policy.version");
    this.projectId = input.projectId;
    this.policy = {
      version: input.policy.version,
      requiredEvidence: input.policy.requiredEvidence.map((requirement) => ({ ...requirement })),
      ...(input.policy.requiredEvidenceByEffect ? {
        requiredEvidenceByEffect: Object.fromEntries(Object.entries(input.policy.requiredEvidenceByEffect).map(([effect, requirements]) => [effect, requirements.map((requirement) => ({ ...requirement }))])),
      } : {}),
    };
    this.ownershipRules = (input.ownershipRules ?? []).map((rule) => ({
      ...rule,
      requiredReviewerPrincipalIds: [...rule.requiredReviewerPrincipalIds],
      requiredReviewerTeamIds: [...rule.requiredReviewerTeamIds],
    }));
    this.reviewerDirectory = (input.reviewerDirectory ?? []).map((entry) => ({ ...entry, teamIds: [...entry.teamIds] }));
    this.analyzers = input.analyzers ?? [declaredEffectOverlapAnalyzer];
    this.landingAuthority = input.landingAuthority;
    this.now = input.now ?? (() => new Date().toISOString());
    this.authorizationEpoch = input.authorizationEpoch;
    this.canonicalRevision = clone(input.canonicalRevision);
  }

  get canonicalProjectRevision(): ProjectRevision {
    return clone(this.canonicalRevision);
  }

  setCanonicalProjectRevision(revision: ProjectRevision): void {
    if (revision.projectId !== this.projectId) {
      throw new CollaborationError({
        code: "project-mismatch",
        message: `Canonical Project Revision ${revision.id} belongs to another Project.`,
        affectedObject: revision.id,
        recoveryAction: "update collaboration state with the owning Project's canonical revision",
        receipt: `revisionProject=${revision.projectId}; coordinatorProject=${this.projectId}`,
      });
    }
    this.canonicalRevision = clone(revision);
  }

  /**
   * Policy activation is a new immutable version. Existing approvals remain
   * historical records and are deliberately stale for the new version.
   */
  activatePolicy(policy: CollaborationPolicy): void {
    nonEmpty(policy.version, "policy.version");
    if (policy.version === this.policy.version) {
      throw new CollaborationError({
        code: "invalid-input",
        message: `Policy ${policy.version} is already active.`,
        affectedObject: policy.version,
        recoveryAction: "activate a new immutable policy version before re-evaluating approvals",
        receipt: `policy=${policy.version}; active=true`,
      });
    }
    this.policy = {
      version: policy.version,
      requiredEvidence: policy.requiredEvidence.map((requirement) => ({ ...requirement })),
      ...(policy.requiredEvidenceByEffect ? {
        requiredEvidenceByEffect: Object.fromEntries(Object.entries(policy.requiredEvidenceByEffect).map(([effect, requirements]) => [effect, requirements.map((requirement) => ({ ...requirement }))])),
      } : {}),
    };
  }

  async createCohort(input: { members: readonly CreateCohortMemberInput[]; actor: ActorRef; baseProjectRevisionId?: string; id?: string }): Promise<IntegrationCohort> {
    if (input.members.length === 0) {
      throw new CollaborationError({
        code: "invalid-input",
        message: "An Integration Cohort requires at least one Change Revision.",
        affectedObject: this.projectId,
        recoveryAction: "select at least one submitted Change Revision and retry cohort composition",
        receipt: "members=0",
      });
    }
    const baseProjectRevisionId = input.baseProjectRevisionId ?? this.canonicalRevision.id;
    const seenChanges = new Set<string>();
    const seenRevisions = new Set<string>();
    const members: IntegrationCohortMember[] = [];
    for (const candidate of input.members) {
      const { change, revision } = candidate;
      if (change.projectId !== this.projectId) {
        throw new CollaborationError({
          code: "project-mismatch",
          message: `Change ${change.id} or Revision ${revision.id} does not belong to Project ${this.projectId}.`,
          affectedObject: change.id,
          recoveryAction: "select Change and Revision records from the coordinator's Project",
          receipt: `changeProject=${change.projectId}; revisionProject=derived-from-change; coordinatorProject=${this.projectId}`,
        });
      }
      if (seenChanges.has(change.id) || seenRevisions.has(revision.id)) {
        throw new CollaborationError({
          code: "duplicate-member",
          message: `Integration Cohort cannot include Change ${change.id} or Revision ${revision.id} more than once.`,
          affectedObject: change.id,
          recoveryAction: "select one exact latest Change Revision per stable Change",
          receipt: `change=${change.id}; revision=${revision.id}; duplicate=true`,
        });
      }
      if (revision.changeId !== change.id) {
        throw new CollaborationError({
          code: "change-revision-mismatch",
          message: `Change Revision ${revision.id} belongs to ${revision.changeId}, not ${change.id}.`,
          affectedObject: revision.id,
          recoveryAction: "select the Change Revision belonging to the requested Change",
          receipt: `change=${change.id}; revisionChange=${revision.changeId}`,
        });
      }
      if (change.latestRevisionId !== revision.id) {
        throw new CollaborationError({
          code: "change-revision-not-latest",
          message: `Change ${change.id} no longer names Revision ${revision.id} as its latest revision.`,
          affectedObject: change.id,
          recoveryAction: "refresh the Change and compose its latest immutable Revision",
          receipt: `change=${change.id}; latest=${change.latestRevisionId ?? "none"}; selected=${revision.id}`,
        });
      }
      const revisionBase = revision.baseProjectRevisionId ?? revision.projectRevisionId;
      if (revisionBase !== baseProjectRevisionId || change.baseProjectRevisionId !== baseProjectRevisionId) {
        throw new CollaborationError({
          code: "base-mismatch",
          message: `Change ${change.id} is not based on the requested cohort base Project Revision.`,
          affectedObject: change.id,
          recoveryAction: `rebase ${change.id} onto ${baseProjectRevisionId}, publish a new Revision, and refresh the cohort`,
          receipt: `changeBase=${change.baseProjectRevisionId}; revisionBase=${revisionBase}; cohortBase=${baseProjectRevisionId}`,
        });
      }
      const verifierActors = candidate.verifierActors ?? [];
      seenChanges.add(change.id);
      seenRevisions.add(revision.id);
      const authorActorId = revision.author?.actorId ?? change.author?.actorId;
      members.push({
        changeId: change.id,
        changeRevisionId: revision.id,
        baseProjectRevisionId: revisionBase,
        ...((revision.author ?? change.author) ? { author: cloneActor(revision.author ?? change.author!) } : {}),
        ...(authorActorId ? { authorActorId } : {}),
        verifierActorIds: verifierActors.map((actor) => actor.actorId),
        affectedModuleIds: [...(revision.affectedModuleIds ?? [])],
        affectedSourceSpaceIds: [...(revision.affectedSourceSpaceIds ?? [])],
        affectedTargetIds: [...(revision.affectedTargetIds ?? [])],
        declaredEffects: [...revision.declaredEffects],
      });
    }
    const cohortId = input.id ?? opaqueId("integration-cohort");
    const conflictIds: string[] = [];
    for (const analyzer of this.analyzers) {
      const candidates = await analyzer.analyze({ projectId: this.projectId, baseProjectRevisionId, members: members.map(cloneMember) });
      for (const candidate of candidates) {
        const candidateChanges = [...new Set(candidate.changeIds)];
        if (candidateChanges.length < 1 || candidateChanges.some((changeId) => !seenChanges.has(changeId))) {
          throw new CollaborationError({
            code: "invalid-input",
            message: `Analyzer ${analyzer.id} returned a conflict outside the Integration Cohort.`,
            affectedObject: analyzer.id,
            recoveryAction: "return only conflicts whose Change IDs belong to the analyzed cohort",
            receipt: `analyzer=${analyzer.id}; changeIds=${candidateChanges.join(",")}`,
          });
        }
        nonEmpty(candidate.description, "conflict.description");
        nonEmpty(candidate.receipt, "conflict.receipt");
        const revisionIds = members.filter((member) => candidateChanges.includes(member.changeId)).map((member) => member.changeRevisionId);
        const conflict: IntegrationConflict = {
          protocol: CONTRACT_VERSIONS.integrationConflict,
          id: stableId("integration-conflict", { cohortId, analyzerId: analyzer.id, candidate }),
          projectId: this.projectId,
          cohortId,
          kind: candidate.kind,
          severity: candidate.severity,
          state: "open",
          changeIds: candidateChanges,
          changeRevisionIds: revisionIds,
          scopeIds: [...candidate.scopeIds],
          analyzerId: analyzer.id,
          description: candidate.description,
          disclosure: candidate.disclosure,
          createdAt: this.now(),
          receipt: candidate.receipt,
          recoveryAction: candidate.recoveryAction,
        };
        this.conflicts.set(conflict.id, conflict);
        conflictIds.push(conflict.id);
        this.appendAudit({
          projectId: this.projectId,
          cohortId,
          role: "analyzer",
          action: "integration-conflict.detected",
          outcome: "observed",
          actor: input.actor,
          disclosure: candidate.disclosure,
          receipt: `${candidate.receipt}; conflict=${conflict.id}`,
        });
      }
    }
    const cohort: IntegrationCohort = {
      protocol: CONTRACT_VERSIONS.integrationCohort,
      id: cohortId,
      projectId: this.projectId,
      baseProjectRevisionId,
      members,
      conflictIds,
      state: conflictIds.some((id) => this.conflicts.get(id)?.severity === "blocking") ? "blocked" : "proposed",
      createdBy: cloneActor(input.actor),
      createdAt: this.now(),
      updatedAt: this.now(),
      receipt: `cohort=created; project=${this.projectId}; base=${baseProjectRevisionId}; members=${members.map((member) => member.changeId).join(",")}; conflicts=${conflictIds.length}`,
    };
    this.cohorts.set(cohort.id, cohort);
    for (const member of members) {
      const authorActorId = member.authorActorId;
      if (authorActorId) {
        this.appendAudit({
          projectId: this.projectId,
          cohortId: cohort.id,
          changeId: member.changeId,
          changeRevisionId: member.changeRevisionId,
          role: "author",
          action: "change-revision.authored",
          outcome: "observed",
          actor: member.author ?? actorForId(authorActorId, input.actor),
          disclosure: "project",
          receipt: `change=${member.changeId}; revision=${member.changeRevisionId}; author=${authorActorId}`,
        });
      }
    }
    return cloneCohort(cohort);
  }

  getCohort(cohortId: string): IntegrationCohort | undefined {
    const cohort = this.cohorts.get(cohortId);
    return cohort ? cloneCohort(cohort) : undefined;
  }

  listCohorts(): readonly IntegrationCohort[] {
    return [...this.cohorts.values()].map(cloneCohort);
  }

  listConflicts(cohortId: string): readonly IntegrationConflict[] {
    return [...this.conflicts.values()].filter((conflict) => conflict.cohortId === cohortId).map(cloneConflict);
  }

  listFindings(cohortId: string): readonly ReviewFinding[] {
    return [...this.findings.values()].filter((finding) => finding.cohortId === cohortId).map(cloneFinding);
  }

  listApprovals(cohortId: string): readonly ReviewApproval[] {
    return [...this.approvals.values()].filter((approval) => approval.cohortId === cohortId).map(cloneApproval);
  }

  listAuditEvents(): readonly CollaborationAuditEvent[] {
    return this.audit.map(cloneAudit);
  }

  listReviewRequirements(cohortId: string): readonly ReviewRequirement[] {
    const cohort = this.requireCohort(cohortId);
    return this.requirementsFor(cohort).map((requirement) => ({
      ...requirement,
      requiredReviewerPrincipalIds: [...requirement.requiredReviewerPrincipalIds],
      requiredReviewerTeamIds: [...requirement.requiredReviewerTeamIds],
      candidatePrincipalIds: [...requirement.candidatePrincipalIds],
    }));
  }

  submitFinding(input: {
    cohortId: string;
    changeId: string;
    changeRevisionId: string;
    author: ActorRef;
    kind: ReviewFindingKind;
    severity: ReviewFindingSeverity;
    summary: string;
    disclosure?: DisclosureClassification;
    scope?: ReviewScope;
    idempotencyKey?: string;
  }): ReviewFinding {
    const cohort = this.requireCohort(input.cohortId);
    const member = this.requireMember(cohort, input.changeId, input.changeRevisionId);
    nonEmpty(input.summary, "review.summary");
    if (input.idempotencyKey) {
      const existingId = this.idempotency.get(input.idempotencyKey);
      if (existingId) {
        const existing = this.findings.get(existingId);
        if (!existing || existing.changeId !== input.changeId || existing.changeRevisionId !== input.changeRevisionId) {
          throw new CollaborationError({
            code: "idempotency-conflict",
            message: `Review idempotency key ${input.idempotencyKey} was already used for another Change Revision.`,
            affectedObject: input.idempotencyKey,
            recoveryAction: "use a new idempotency key for a different review finding",
            receipt: `idempotencyKey=${input.idempotencyKey}; existingFinding=${existingId}`,
          });
        }
        return cloneFinding(existing);
      }
    }
    const finding: ReviewFinding = {
      protocol: CONTRACT_VERSIONS.reviewFinding,
      id: opaqueId("review-finding"),
      projectId: this.projectId,
      cohortId: cohort.id,
      changeId: input.changeId,
      changeRevisionId: input.changeRevisionId,
      author: cloneActor(input.author),
      kind: input.kind,
      severity: input.severity,
      state: "open",
      summary: input.summary,
      ...(input.scope ? { scope: { ...input.scope } } : {}),
      disclosure: input.disclosure ?? "project",
      createdAt: this.now(),
      updatedAt: this.now(),
      receipt: `finding=open; cohort=${cohort.id}; change=${input.changeId}; revision=${input.changeRevisionId}; severity=${input.severity}`,
    };
    this.findings.set(finding.id, finding);
    if (input.idempotencyKey) this.idempotency.set(input.idempotencyKey, finding.id);
    this.appendAudit({
      projectId: this.projectId,
      cohortId: cohort.id,
      changeId: finding.changeId,
      changeRevisionId: finding.changeRevisionId,
      role: "reviewer",
      action: "review.finding.submitted",
      outcome: "observed",
      actor: input.author,
      policyVersion: this.policy.version,
      disclosure: finding.disclosure,
      receipt: finding.receipt,
    });
    return cloneFinding(finding);
  }

  resolveFinding(input: { findingId: string; actor: ActorRef; resolution: string }): ReviewFinding {
    const finding = this.findings.get(input.findingId);
    if (!finding) {
      throw new CollaborationError({
        code: "finding-not-found",
        message: `Review Finding ${input.findingId} is not known.`,
        affectedObject: input.findingId,
        recoveryAction: "refresh the Change review and resolve a known Finding",
        receipt: `finding=${input.findingId}; known=false`,
      });
    }
    nonEmpty(input.resolution, "review.resolution");
    const updated: ReviewFinding = {
      ...finding,
      state: "resolved",
      resolution: input.resolution,
      resolvedBy: cloneActor(input.actor),
      updatedAt: this.now(),
      receipt: `finding=resolved; id=${finding.id}; resolutionActor=${input.actor.actorId}`,
    };
    this.findings.set(updated.id, updated);
    this.appendAudit({
      projectId: this.projectId,
      cohortId: finding.cohortId,
      changeId: finding.changeId,
      changeRevisionId: finding.changeRevisionId,
      role: "reviewer",
      action: "review.finding.resolved",
      outcome: "succeeded",
      actor: input.actor,
      policyVersion: this.policy.version,
      disclosure: finding.disclosure,
      receipt: updated.receipt,
    });
    return cloneFinding(updated);
  }

  approve(input: {
    cohortId: string;
    requirementId: string;
    reviewer: ActorRef;
    evidenceIds?: readonly string[];
    idempotencyKey?: string;
  }): ReviewApproval {
    const cohort = this.requireCohort(input.cohortId);
    const requirement = this.requirementFor(cohort, input.requirementId);
    const member = this.requireMember(cohort, requirement.changeId, requirement.changeRevisionId);
    const authorActorId = member.authorActorId;
    const verifierActorIds = [...member.verifierActorIds];
    if (input.reviewer.actorId === authorActorId || verifierActorIds.includes(input.reviewer.actorId)) {
      throw new CollaborationError({
        code: "separation-of-duty",
        message: `Reviewer ${input.reviewer.actorId} cannot approve a Change it authored or verified.`,
        affectedObject: requirement.id,
        recoveryAction: "use an independent reviewer Actor and re-evaluate the current Change Revision",
        receipt: `requirement=${requirement.id}; reviewer=${input.reviewer.actorId}; author=${authorActorId ?? "none"}; verifiers=${verifierActorIds.join(",")}`,
      });
    }
    if (!requirement.candidatePrincipalIds.includes(input.reviewer.principalId)) {
      throw new CollaborationError({
        code: "reviewer-not-required",
        message: `Actor ${input.reviewer.actorId} is not an eligible reviewer for requirement ${requirement.id}.`,
        affectedObject: requirement.id,
        recoveryAction: "request review from a configured module, Source Space, or Target owner",
        receipt: `requirement=${requirement.id}; reviewer=${input.reviewer.principalId}; candidates=${requirement.candidatePrincipalIds.join(",")}`,
      });
    }
    if (input.idempotencyKey) {
      const existingId = this.idempotency.get(input.idempotencyKey);
      if (existingId) {
        const existing = this.approvals.get(existingId);
        if (!existing || existing.requirementId !== requirement.id || existing.changeRevisionId !== requirement.changeRevisionId) {
          throw new CollaborationError({
            code: "idempotency-conflict",
            message: `Approval idempotency key ${input.idempotencyKey} was already used for another review requirement.`,
            affectedObject: input.idempotencyKey,
            recoveryAction: "use a new idempotency key for a different approval",
            receipt: `idempotencyKey=${input.idempotencyKey}; existingApproval=${existingId}`,
          });
        }
        return cloneApproval(existing);
      }
    }
    const existingApproval = [...this.approvals.values()].find((approval) => approval.requirementId === requirement.id && approval.changeRevisionId === requirement.changeRevisionId && approval.reviewer.actorId === input.reviewer.actorId && approval.policyVersion === this.policy.version);
    if (existingApproval) return cloneApproval(existingApproval);
    const approval: ReviewApproval = {
      protocol: CONTRACT_VERSIONS.reviewApproval,
      id: opaqueId("review-approval"),
      projectId: this.projectId,
      cohortId: cohort.id,
      requirementId: requirement.id,
      changeId: requirement.changeId,
      changeRevisionId: requirement.changeRevisionId,
      reviewer: cloneActor(input.reviewer),
      ...(authorActorId ? { authorActorId } : {}),
      verifierActorIds,
      evidenceIds: [...(input.evidenceIds ?? [])],
      policyVersion: this.policy.version,
      approvedAt: this.now(),
      receipt: `approval=approved; requirement=${requirement.id}; change=${requirement.changeId}; revision=${requirement.changeRevisionId}; reviewer=${input.reviewer.actorId}`,
    };
    this.approvals.set(approval.id, approval);
    if (input.idempotencyKey) this.idempotency.set(input.idempotencyKey, approval.id);
    this.appendAudit({
      projectId: this.projectId,
      cohortId: cohort.id,
      changeId: approval.changeId,
      changeRevisionId: approval.changeRevisionId,
      role: "reviewer",
      action: "review.approved",
      outcome: "succeeded",
      actor: input.reviewer,
      policyVersion: this.policy.version,
      disclosure: requirement.disclosure,
      receipt: approval.receipt,
    });
    return cloneApproval(approval);
  }

  resolveConflict(input: { conflictId: string; resolutionRevisionIds: readonly string[]; actor: ActorRef }): IntegrationConflict {
    const conflict = this.conflicts.get(input.conflictId);
    if (!conflict) {
      throw new CollaborationError({
        code: "conflict-not-found",
        message: `Integration Conflict ${input.conflictId} is not known.`,
        affectedObject: input.conflictId,
        recoveryAction: "refresh the Integration Cohort and resolve a known Conflict",
        receipt: `conflict=${input.conflictId}; known=false`,
      });
    }
    const cohort = this.requireCohort(conflict.cohortId);
    const cohortRevisionIds = new Set(cohort.members.map((member) => member.changeRevisionId));
    if (input.resolutionRevisionIds.length === 0 || input.resolutionRevisionIds.some((revisionId) => !cohortRevisionIds.has(revisionId))) {
      throw new CollaborationError({
        code: "invalid-input",
        message: `Conflict ${conflict.id} must be resolved by exact Change Revisions in its Cohort.`,
        affectedObject: conflict.id,
        recoveryAction: "publish the conflict-resolution Change Revision and attach its exact ID",
        receipt: `conflict=${conflict.id}; resolutionRevisions=${input.resolutionRevisionIds.join(",")}`,
      });
    }
    const updated: IntegrationConflict = {
      ...conflict,
      state: "resolved",
      resolvedAt: this.now(),
      resolutionRevisionIds: [...input.resolutionRevisionIds],
      receipt: `conflict=resolved; id=${conflict.id}; revisions=${input.resolutionRevisionIds.join(",")}`,
    };
    this.conflicts.set(updated.id, updated);
    this.appendAudit({
      projectId: this.projectId,
      cohortId: cohort.id,
      role: "reviewer",
      action: "integration-conflict.resolved",
      outcome: "succeeded",
      actor: input.actor,
      policyVersion: this.policy.version,
      disclosure: conflict.disclosure,
      receipt: updated.receipt,
    });
    return cloneConflict(updated);
  }

  evaluateLanding(input: CollaborationEvaluationInput): CollaborationPolicyExplanation {
    const cohort = this.requireCohort(input.cohortId);
    const blockers: CollaborationBlocker[] = [];
    const addBlocker = (blocker: CollaborationBlocker): void => {
      blockers.push(blocker);
    };
    if (cohort.state === "landed") {
      addBlocker({
        kind: "invalid-state",
        affectedObject: cohort.id,
        disclosure: "project",
        message: `Integration Cohort ${cohort.id} has already Landed.`,
        recoveryAction: "create a new Change for any further work",
        safeCommand: `anyam change create --from-cohort ${cohort.id}`,
      });
    }
    if (this.canonicalRevision.id !== cohort.baseProjectRevisionId) {
      addBlocker({
        kind: "stale-base",
        affectedObject: cohort.id,
        disclosure: "project",
        message: `Integration Cohort ${cohort.id} is based on ${cohort.baseProjectRevisionId}, but canonical state is ${this.canonicalRevision.id}.`,
        recoveryAction: "rebase every Change in the Cohort onto the current canonical Project Revision and reverify",
        safeCommand: `anyam change rebase --cohort ${cohort.id}`,
      });
    }
    for (const conflict of this.listConflicts(cohort.id).filter((candidate) => candidate.state === "open" && candidate.severity === "blocking")) {
      addBlocker({
        kind: "open-conflict",
        affectedObject: conflict.id,
        ...(conflict.changeIds[0] ? { changeId: conflict.changeIds[0] } : {}),
        ...(conflict.scopeIds[0] ? { scopeId: conflict.scopeIds[0] } : {}),
        disclosure: conflict.disclosure,
        message: conflict.description,
        recoveryAction: conflict.recoveryAction,
        safeCommand: `anyam cohort inspect ${cohort.id}`,
      });
    }
    for (const finding of this.listFindings(cohort.id).filter((candidate) => candidate.state === "open" && (candidate.severity === "blocking" || candidate.kind === "request-changes"))) {
      const scopeId = finding.scope?.sourceSpaceId ?? finding.scope?.moduleId ?? finding.scope?.targetId;
      addBlocker({
        kind: "open-finding",
        affectedObject: finding.id,
        changeId: finding.changeId,
        ...(scopeId ? { scopeId } : {}),
        disclosure: finding.disclosure,
        message: `Review Finding ${finding.id} requests a new Change Revision before Landing.`,
        recoveryAction: "address the Finding, publish a new immutable Change Revision, and request review again",
        safeCommand: `anyam change publish --fix ${finding.changeId}`,
      });
    }
    const requirements = this.requirementsFor(cohort);
    for (const requirement of requirements) {
      const approvals = [...this.approvals.values()].filter((approval) => approval.requirementId === requirement.id);
      const current = approvals.filter((approval) => approval.changeRevisionId === requirement.changeRevisionId && approval.policyVersion === this.policy.version);
      const invalidDuty = current.filter((approval) => approval.reviewer.actorId === approval.authorActorId || approval.verifierActorIds.includes(approval.reviewer.actorId));
      if (invalidDuty.length > 0) {
        addBlocker({
          kind: "separation-of-duty",
          affectedObject: requirement.id,
          changeId: requirement.changeId,
          scopeId: requirement.scopeId,
          disclosure: requirement.disclosure,
          message: `Requirement ${requirement.id} has an approval from the Change author or verifier.`,
          recoveryAction: "obtain approval from an independent reviewer for the exact Change Revision",
          safeCommand: `anyam change review request ${requirement.changeId}`,
        });
      } else if (current.length === 0) {
        const stale = approvals.length > 0;
        addBlocker({
          kind: stale ? "stale-approval" : "required-reviewer",
          affectedObject: requirement.id,
          changeId: requirement.changeId,
          scopeId: requirement.scopeId,
          disclosure: requirement.disclosure,
          message: stale
            ? `Required review for ${requirement.changeId} is stale for Change Revision ${requirement.changeRevisionId}.`
            : requirement.candidatePrincipalIds.length === 0
              ? `No active reviewer candidate is configured for ${requirement.changeId} Revision ${requirement.changeRevisionId}.`
              : `An eligible reviewer has not approved ${requirement.changeId} Revision ${requirement.changeRevisionId}.`,
          recoveryAction: stale
            ? "review the latest immutable Change Revision and approve it again"
            : "request review from the configured module, Source Space, or Target owner",
          safeCommand: `anyam change review request ${requirement.changeId}`,
        });
      }
    }
    const verifierAuditKeys = new Set<string>();
    for (const record of input.evidence) {
      if (record.changeRevisionId === undefined || !cohort.members.some((member) => member.changeRevisionId === record.changeRevisionId)) continue;
      const key = `${record.changeRevisionId}:${record.actor.actorId}`;
      if (verifierAuditKeys.has(key)) continue;
      verifierAuditKeys.add(key);
      this.appendAudit({
        projectId: this.projectId,
        cohortId: cohort.id,
        changeRevisionId: record.changeRevisionId,
        role: "verifier",
        action: "evidence.observed",
        outcome: record.outcome === "passed" ? "succeeded" : "denied",
        actor: record.actor,
        policyVersion: record.policyVersion,
        disclosure: record.disclosure.classification,
        receipt: `evidence=${record.id}; key=${record.key}; outcome=${record.outcome}`,
      });
    }
    for (const requirement of this.requiredEvidenceFor(cohort)) {
      const records = input.evidence.filter((record) => record.key === requirement.key);
      const record = [...records].reverse()[0];
      if (!record) {
        addBlocker({
          kind: "missing-evidence",
          affectedObject: requirement.key,
          disclosure: "project",
          message: `Evidence ${requirement.key} is missing for Integration Cohort ${cohort.id}.`,
          recoveryAction: "run the required Action or Verifier and attach its Evidence to the exact Change Revision",
          safeCommand: `anyam check --cohort ${cohort.id}`,
        });
        continue;
      }
      const contextMismatch = (requirement.expectedProjectRevisionId !== undefined && record.projectRevisionId !== requirement.expectedProjectRevisionId)
        || (requirement.expectedProjectViewId !== undefined && record.projectViewId !== requirement.expectedProjectViewId)
        || (requirement.expectedChangeRevisionId !== undefined && record.changeRevisionId !== requirement.expectedChangeRevisionId)
        || (requirement.expectedTargetId !== undefined && record.targetId !== requirement.expectedTargetId)
        || (requirement.expectedDisclosureClassification !== undefined && record.disclosure.classification !== requirement.expectedDisclosureClassification)
        || record.validityKey !== requirement.currentValidityKey;
      if (contextMismatch && record.outcome === "passed") {
        addBlocker({
          kind: "stale-evidence",
          affectedObject: requirement.key,
          disclosure: "project",
          message: `Evidence ${requirement.key} is stale for the current Integration Cohort state.`,
          recoveryAction: "rerun the required Action or Verifier against the exact Change Revision and current policy",
          safeCommand: `anyam check --cohort ${cohort.id} --refresh`,
        });
      } else if (record.outcome !== "passed") {
        addBlocker({
          kind: record.outcome === "failed" ? "failed-evidence" : "stale-evidence",
          affectedObject: requirement.key,
          disclosure: "project",
          message: `Evidence ${requirement.key} is ${record.outcome} for Integration Cohort ${cohort.id}.`,
          recoveryAction: "inspect the Evidence receipt, repair the failing Action, and produce a fresh Evidence record",
          safeCommand: `anyam check --cohort ${cohort.id} --refresh`,
        });
      }
    }
    const decision = blockers.length === 0 ? "allow" : "deny";
    const explanation: CollaborationPolicyExplanation = {
      protocol: CONTRACT_VERSIONS.collaborationPolicyExplanation,
      id: opaqueId("collaboration-policy-decision"),
      projectId: this.projectId,
      cohortId: cohort.id,
      decision,
      policyVersion: this.policy.version,
      ...(this.authorizationEpoch ? { authorizationEpoch: this.authorizationEpoch } : {}),
      baseProjectRevisionId: cohort.baseProjectRevisionId,
      currentCanonicalProjectRevisionId: this.canonicalRevision.id,
      blockers,
      safeNextCommands: [...new Set(blockers.map((blocker) => blocker.safeCommand))],
      receipt: `cohort=${cohort.id}; decision=${decision}; blockers=${blockers.length}; policy=${this.policy.version}; base=${cohort.baseProjectRevisionId}; canonical=${this.canonicalRevision.id}`,
    };
    return input.audience !== undefined || input.visibleScopeIds !== undefined
      ? this.projectExplanation(explanation, input.audience ?? "project", input.visibleScopeIds ?? [])
      : explanation;
  }

  async land(input: CollaborationEvaluationInput & { actor: ActorRef }): Promise<CollaborationLandingResult> {
    const explanation = this.evaluateLanding(input);
    if (explanation.decision !== "allow") {
      throw new CollaborationError({
        code: "policy-blocked",
        message: `Landing is blocked for Integration Cohort ${input.cohortId}.`,
        affectedObject: input.cohortId,
        recoveryAction: explanation.safeNextCommands[0] ?? "inspect the Policy Explanation and resolve its blockers",
        receipt: explanation.receipt,
        explanation,
      });
    }
    if (!this.landingAuthority) {
      throw new CollaborationError({
        code: "landing-authority-unavailable",
        message: "No trusted Landing authority is configured for this collaboration coordinator.",
        affectedObject: input.cohortId,
        recoveryAction: "connect the Project coordinator's Landing authority; developer tools and agents cannot perform Landing directly",
        receipt: `cohort=${input.cohortId}; landingAuthority=configured=false`,
      });
    }
    const cohort = this.requireCohort(input.cohortId);
    const landing = await this.landingAuthority.landCohort({
      cohortId: cohort.id,
      members: cohort.members.map((member) => ({ changeId: member.changeId, changeRevisionId: member.changeRevisionId })),
      expectedCanonicalProjectRevisionId: cohort.baseProjectRevisionId,
    });
    const expectedChangeIds = new Set(cohort.members.map((member) => member.changeId));
    const expectedRevisionIds = new Set(cohort.members.map((member) => member.changeRevisionId));
    const actualChangeIds = new Set(landing.changeIds ?? []);
    const actualRevisionIds = new Set(landing.changeRevisionIds ?? []);
    const sameSet = (left: Set<string>, right: Set<string>): boolean => left.size === right.size && [...left].every((value) => right.has(value));
    if (landing.projectId !== this.projectId || landing.cohortId !== cohort.id || !sameSet(actualChangeIds, expectedChangeIds) || !sameSet(actualRevisionIds, expectedRevisionIds)) {
      throw new CollaborationError({
        code: "landing-result-mismatch",
        message: `Landing authority returned a result that does not identify the requested Integration Cohort.`,
        affectedObject: cohort.id,
        recoveryAction: "reconcile the Landing authority receipt before accepting canonical state",
        receipt: `cohort=${cohort.id}; landingProject=${landing.projectId}; landingCohort=${landing.cohortId ?? "none"}; landedChanges=${[...actualChangeIds].join(",")}; expectedChanges=${[...expectedChangeIds].join(",")}; landedRevisions=${[...actualRevisionIds].join(",")}; expectedRevisions=${[...expectedRevisionIds].join(",")}`,
      });
    }
    this.cohorts.set(cohort.id, { ...cohort, state: "landed", updatedAt: this.now(), receipt: `cohort=landed; landing=${landing.id}; next=${landing.projectRevisionId}` });
    this.appendAudit({
      projectId: this.projectId,
      cohortId: cohort.id,
      role: "landing",
      action: "landing.completed",
      outcome: "succeeded",
      actor: input.actor,
      policyVersion: this.policy.version,
      disclosure: "project",
      receipt: landing.receipt,
    });
    return { landing: clone(landing), explanation };
  }

  recordPromotionAuthority(input: { cohortId?: string; promotionId: string; targetId: string; releaseId: string; actor: ActorRef; receipt: string }): CollaborationAuditEvent {
    nonEmpty(input.promotionId, "promotionId");
    nonEmpty(input.targetId, "targetId");
    nonEmpty(input.releaseId, "releaseId");
    nonEmpty(input.receipt, "promotion.receipt");
    return this.appendAudit({
      projectId: this.projectId,
      ...(input.cohortId ? { cohortId: input.cohortId } : {}),
      role: "promotion",
      action: "promotion.authority.observed",
      outcome: "observed",
      actor: input.actor,
      policyVersion: this.policy.version,
      disclosure: "project",
      receipt: `promotion=${input.promotionId}; target=${input.targetId}; release=${input.releaseId}; ${input.receipt}`,
    });
  }

  projectExplanation(explanation: CollaborationPolicyExplanation, audience: DisclosureClassification, visibleScopeIds: readonly string[]): CollaborationPolicyExplanation {
    const visible = (blocker: CollaborationBlocker): boolean => disclosureRank(audience) >= disclosureRank(blocker.disclosure)
      && (blocker.scopeId === undefined || visibleScopeIds.includes(blocker.scopeId));
    const blockers = explanation.blockers.map((blocker) => visible(blocker)
      ? { ...blocker }
      : {
        kind: blocker.kind,
        affectedObject: explanation.cohortId,
        disclosure: blocker.disclosure,
        message: "A restricted review, Evidence, or conflict requirement blocks this operation.",
        recoveryAction: "request an authorized maintainer Review Projection for the next permitted action",
        safeCommand: `anyam cohort inspect ${explanation.cohortId}`,
      });
    return {
      ...explanation,
      blockers,
      safeNextCommands: [...new Set(blockers.map((blocker) => blocker.safeCommand))],
    };
  }

  projectCohort(input: { cohortId: string; audience: DisclosureClassification; visibleScopeIds: readonly string[] }): {
    cohort: IntegrationCohort;
    conflicts: readonly IntegrationConflict[];
    findings: readonly ReviewFinding[];
    requirements: readonly ReviewRequirement[];
  } {
    const cohort = this.requireCohort(input.cohortId);
    const scopeVisible = (scopeIds: readonly string[], disclosure: DisclosureClassification): boolean => disclosureRank(input.audience) >= disclosureRank(disclosure)
      && scopeIds.every((scopeId) => input.visibleScopeIds.includes(scopeId));
    const projectedMembers = cohort.members.map((member): IntegrationCohortMember => ({
      ...member,
      affectedModuleIds: member.affectedModuleIds.filter((scopeId) => input.visibleScopeIds.includes(scopeId)),
      affectedSourceSpaceIds: member.affectedSourceSpaceIds.filter((scopeId) => input.visibleScopeIds.includes(scopeId)),
      affectedTargetIds: member.affectedTargetIds.filter((scopeId) => input.visibleScopeIds.includes(scopeId)),
    }));
    const projectedCohort: IntegrationCohort = { ...cohort, members: projectedMembers };
    const conflicts = this.listConflicts(cohort.id).map((conflict) => scopeVisible(conflict.scopeIds, conflict.disclosure)
      ? conflict
      : {
        ...conflict,
        changeIds: [],
        changeRevisionIds: [],
        scopeIds: [],
        analyzerId: "",
        description: "A restricted Integration Conflict requires maintainer review.",
        receipt: `conflict=${conflict.id}; disclosure=projection-only`,
      });
    const findings = this.listFindings(cohort.id).map((finding): ReviewFinding => {
      const scopeIds = finding.scope ? [finding.scope.sourceSpaceId ?? finding.scope.moduleId ?? finding.scope.targetId].filter((value): value is string => value !== undefined) : [];
      if (scopeVisible(scopeIds, finding.disclosure)) return finding;
      const projected: ReviewFinding = {
        ...finding,
        summary: "A restricted Review Finding requires maintainer attention.",
        receipt: `finding=${finding.id}; disclosure=projection-only`,
      };
      delete projected.scope;
      return projected;
    });
    const requirements = this.listReviewRequirements(cohort.id).map((requirement) => scopeVisible([requirement.scopeId], requirement.disclosure)
      ? requirement
      : {
        ...requirement,
        ruleId: "",
        scopeId: "",
        reason: "An authorized owner Review is required.",
        requiredReviewerPrincipalIds: [],
        requiredReviewerTeamIds: [],
        candidatePrincipalIds: [],
      });
    return { cohort: projectedCohort, conflicts, findings, requirements };
  }

  private requirementsFor(cohort: IntegrationCohort): ReviewRequirement[] {
    const requirements: ReviewRequirement[] = [];
    for (const member of cohort.members) {
      for (const rule of this.ownershipRules) {
        const affected = rule.scopeKind === "module"
          ? member.affectedModuleIds.includes(rule.scopeId)
          : rule.scopeKind === "source-space"
            ? member.affectedSourceSpaceIds.includes(rule.scopeId)
            : member.affectedTargetIds.includes(rule.scopeId);
        if (!affected) continue;
        const candidates = this.reviewerDirectory
          .filter((entry) => entry.active !== false && (rule.requiredReviewerPrincipalIds.includes(entry.principalId) || entry.teamIds.some((teamId) => rule.requiredReviewerTeamIds.includes(teamId))))
          .map((entry) => entry.principalId);
        requirements.push({
          id: stableId("review-requirement", { cohortId: cohort.id, ruleId: rule.id, changeId: member.changeId, changeRevisionId: member.changeRevisionId }),
          ruleId: rule.id,
          changeId: member.changeId,
          changeRevisionId: member.changeRevisionId,
          scopeKind: rule.scopeKind,
          scopeId: rule.scopeId,
          disclosure: rule.disclosure,
          requiredReviewerPrincipalIds: [...rule.requiredReviewerPrincipalIds],
          requiredReviewerTeamIds: [...rule.requiredReviewerTeamIds],
          candidatePrincipalIds: [...new Set(candidates)],
          reason: rule.label ?? `${rule.scopeKind} owner review is required`,
        });
      }
    }
    return requirements;
  }

  private requiredEvidenceFor(cohort: IntegrationCohort): EvidenceRequirement[] {
    const requirements: EvidenceRequirement[] = this.policy.requiredEvidence.map((requirement) => ({ ...requirement }));
    for (const member of cohort.members) {
      for (const effect of member.declaredEffects) {
        for (const requirement of this.policy.requiredEvidenceByEffect?.[effect] ?? []) {
          requirements.push({
            ...requirement,
            ...(requirement.expectedChangeRevisionId === undefined ? { expectedChangeRevisionId: member.changeRevisionId } : {}),
          });
        }
      }
    }
    const seen = new Set<string>();
    return requirements.filter((requirement) => {
      const key = `${requirement.key}:${requirement.currentValidityKey}:${requirement.expectedChangeRevisionId ?? ""}:${requirement.expectedTargetId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private requirementFor(cohort: IntegrationCohort, requirementId: string): ReviewRequirement {
    const requirement = this.requirementsFor(cohort).find((candidate) => candidate.id === requirementId);
    if (!requirement) {
      throw new CollaborationError({
        code: "requirement-not-found",
        message: `Review Requirement ${requirementId} is not part of Integration Cohort ${cohort.id}.`,
        affectedObject: requirementId,
        recoveryAction: "refresh the Cohort and approve a currently required reviewer slot",
        receipt: `cohort=${cohort.id}; requirement=${requirementId}; known=false`,
      });
    }
    return requirement;
  }

  private requireMember(cohort: IntegrationCohort, changeId: string, changeRevisionId: string): IntegrationCohortMember {
    const member = cohort.members.find((candidate) => candidate.changeId === changeId && candidate.changeRevisionId === changeRevisionId);
    if (!member) {
      throw new CollaborationError({
        code: "change-revision-mismatch",
        message: `Change ${changeId} Revision ${changeRevisionId} is not a member of Cohort ${cohort.id}.`,
        affectedObject: changeId,
        recoveryAction: "select the exact Change Revision composed by the Integration Cohort",
        receipt: `cohort=${cohort.id}; change=${changeId}; revision=${changeRevisionId}; member=false`,
      });
    }
    return member;
  }

  private requireCohort(cohortId: string): IntegrationCohort {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) {
      throw new CollaborationError({
        code: "cohort-not-found",
        message: `Integration Cohort ${cohortId} is not known.`,
        affectedObject: cohortId,
        recoveryAction: "create or restore the Integration Cohort and retry",
        receipt: `cohort=${cohortId}; known=false`,
      });
    }
    return cohort;
  }

  private appendAudit(input: Omit<CollaborationAuditEvent, "protocol" | "id" | "occurredAt" | "policyVersion"> & { policyVersion?: string }): CollaborationAuditEvent {
    const event: CollaborationAuditEvent = {
      protocol: CONTRACT_VERSIONS.collaborationAudit,
      id: opaqueId("collaboration-audit"),
      projectId: input.projectId,
      ...(input.cohortId ? { cohortId: input.cohortId } : {}),
      ...(input.changeId ? { changeId: input.changeId } : {}),
      ...(input.changeRevisionId ? { changeRevisionId: input.changeRevisionId } : {}),
      role: input.role,
      action: input.action,
      outcome: input.outcome,
      actor: cloneActor(input.actor),
      policyVersion: input.policyVersion ?? this.policy.version,
      disclosure: input.disclosure,
      occurredAt: this.now(),
      receipt: input.receipt,
    };
    this.audit.push(event);
    return cloneAudit(event);
  }
}

function actorForId(actorId: string, fallback: ActorRef): ActorRef {
  return {
    principalId: fallback.principalId,
    actorId,
    sessionId: fallback.sessionId,
    clientId: fallback.clientId,
  };
}
