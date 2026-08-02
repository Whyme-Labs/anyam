import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CollaborationCoordinator,
  CollaborationError,
  declaredEffectOverlapAnalyzer,
  type IntegrationAnalyzer,
  type IntegrationConflictKind,
  type ReviewOwnershipRule,
} from "../src/change-control/collaboration.ts";
import {
  LocalChangeCoordinator,
  type WorkspaceSource,
} from "../src/change-control/local.ts";
import {
  createProject,
  createProjectRevision,
  deriveProjectView,
  type ActorRef,
  type ChangeRevision,
  type Evidence,
  type Project,
  type ProjectRevision,
  type SourceSpace,
} from "../src/kernel/contracts.ts";

const project: Project = createProject({
  id: "project:collaboration",
  name: "Collaboration Fixture",
  referenceType: "typescript-library",
  sourceSpaceIds: ["public-source", "private-source"],
});

const sourceSpaces: readonly SourceSpace[] = [
  { protocol: "anyam.source-space/v1", id: "public-source", name: "Public Source", classification: "public" },
  { protocol: "anyam.source-space/v1", id: "private-source", name: "Private Source", classification: "restricted" },
];

const sources: readonly WorkspaceSource[] = [
  { sourceSpaceId: "public-source", snapshotId: "snapshot:public:v1", files: { "src/public.ts": "export const publicValue = true;\n" } },
  { sourceSpaceId: "private-source", snapshotId: "snapshot:private:v1", files: { "src/private.ts": "export const privateValue = true;\n" } },
];

const baseRevision: ProjectRevision = createProjectRevision({
  id: "project-revision:collaboration-base",
  projectId: project.id,
  sourceSpaceSnapshots: {
    "public-source": "snapshot:public:v1",
    "private-source": "snapshot:private:v1",
  },
});

const authorA: ActorRef = { principalId: "principal:author-a", actorId: "actor:author-a", sessionId: "session:author-a", clientId: "client:cli" };
const authorB: ActorRef = { principalId: "principal:author-b", actorId: "actor:author-b", sessionId: "session:author-b", clientId: "client:cli" };
const verifier: ActorRef = { principalId: "principal:verifier", actorId: "actor:verifier", sessionId: "session:verifier", clientId: "client:runner" };
const reviewer: ActorRef = { principalId: "principal:reviewer", actorId: "actor:reviewer", sessionId: "session:reviewer", clientId: "client:web" };
const landingActor: ActorRef = { principalId: "principal:landing", actorId: "actor:landing", sessionId: "session:landing", clientId: "client:landing" };
const promotionActor: ActorRef = { principalId: "principal:release", actorId: "actor:release", sessionId: "session:release", clientId: "client:promotion" };

function view(revision: ProjectRevision, sourceSpaceIds: readonly string[]) {
  return deriveProjectView({
    project,
    revision,
    sourceSpaces,
    allowedSourceSpaceIds: sourceSpaceIds,
    projectionId: `project-view:${sourceSpaceIds.join("+")}`,
    classification: "project",
  });
}

async function makeChanges(): Promise<{
  control: LocalChangeCoordinator;
  changeA: ReturnType<LocalChangeCoordinator["getChange"]>;
  changeB: ReturnType<LocalChangeCoordinator["getChange"]>;
  revisionA: ChangeRevision;
  revisionB: ChangeRevision;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "anyam-collaboration-"));
  const control = new LocalChangeCoordinator({ project, sourceSpaces, canonicalRevision: baseRevision });
  const workspaceA = await control.createWorkspace({
    view: view(baseRevision, ["public-source"]),
    sources,
    mounts: [{ sourceSpaceId: "public-source", mountPath: "public" }],
    directory: join(root, "workspace-a"),
    actorId: authorA.actorId,
  });
  const workspaceB = await control.createWorkspace({
    view: view(baseRevision, ["private-source"]),
    sources,
    mounts: [{ sourceSpaceId: "private-source", mountPath: "private" }],
    directory: join(root, "workspace-b"),
    actorId: authorB.actorId,
  });
  const changeA = control.createChange({ intentId: "intent:public-api", workspaceId: workspaceA.workspace.id, author: authorA });
  const changeB = control.createChange({ intentId: "intent:private-implementation", workspaceId: workspaceB.workspace.id, author: authorB });
  const revisionA = control.publishRevision({
    changeId: changeA.id,
    declaredEffects: ["api.modify"],
    actor: authorA,
    affectedModuleIds: ["module:player"],
    affectedTargetIds: ["target:production"],
  });
  const revisionB = control.publishRevision({
    changeId: changeB.id,
    declaredEffects: ["schema.migrate"],
    actor: authorB,
    affectedModuleIds: ["module:codec"],
    affectedTargetIds: ["target:production"],
  });
  return { control, changeA: control.getChange(changeA.id), changeB: control.getChange(changeB.id), revisionA, revisionB, root };
}

function ownershipRules(): readonly ReviewOwnershipRule[] {
  return [
    {
      id: "owner:player-module",
      scopeKind: "module",
      scopeId: "module:player",
      requiredReviewerPrincipalIds: [reviewer.principalId],
      requiredReviewerTeamIds: [],
      disclosure: "public",
      label: "Player module owner review",
    },
    {
      id: "owner:private-source",
      scopeKind: "source-space",
      scopeId: "private-source",
      requiredReviewerPrincipalIds: [reviewer.principalId],
      requiredReviewerTeamIds: [],
      disclosure: "restricted",
      label: "Private Source Space owner review",
    },
    {
      id: "owner:production-target",
      scopeKind: "target",
      scopeId: "target:production",
      requiredReviewerPrincipalIds: [],
      requiredReviewerTeamIds: ["team:release"],
      disclosure: "project",
      label: "Production Target owner review",
    },
  ];
}

function policy(version = "policy:collaboration:v1") {
  return {
    version,
    requiredEvidence: [],
    requiredEvidenceByEffect: {
      "api.modify": [{ key: "api-check", currentValidityKey: "api-check:v1" }],
      "schema.migrate": [{ key: "schema-check", currentValidityKey: "schema-check:v1" }],
    },
  } as const;
}

function evidenceFor(revision: ChangeRevision, key: string, validityKey: string, actor: ActorRef): Evidence {
  return {
    protocol: "anyam.evidence/v1",
    version: "v1",
    id: `evidence:${key}:${revision.id}`,
    key,
    criterion: `Evidence for ${key}`,
    outcome: "passed",
    validityKey,
    actionId: `action:${key}`,
    verifierId: `verifier:${key}`,
    toolchainDigest: "sha256:toolchain:v1",
    dependencyDigest: "sha256:dependencies:v1",
    environmentDigest: "sha256:environment:v1",
    inputDigests: [revision.id],
    effectDigests: revision.declaredEffects.map((effect) => `effect:${effect}`),
    outputDigest: `sha256:output:${key}:${revision.id}`,
    createdAt: "2026-08-03T00:00:00.000Z",
    producer: { kind: "run", id: `run:${key}`, version: "v1" },
    projectRevisionId: revision.projectRevisionId,
    projectViewId: revision.projectViewId,
    changeRevisionId: revision.id,
    runId: `run:${key}:${revision.id}`,
    actor,
    runnerId: "runner:local",
    policyVersion: "policy:collaboration:v1",
    authorizationEpoch: "epoch:collaboration:v1",
    capabilityGrantId: "grant:verifier",
    disclosure: { projectionId: "project-view:collaboration", classification: "project" },
    receipt: `verifier=${key}; revision=${revision.id}`,
    invalidators: [],
    owner: "collaboration test",
  };
}

function collaboration(input: {
  control: LocalChangeCoordinator;
  analyzers?: readonly IntegrationAnalyzer[];
  policyVersion?: string;
}): CollaborationCoordinator {
  return new CollaborationCoordinator({
    projectId: project.id,
    canonicalRevision: input.control.canonicalRevision,
    policy: policy(input.policyVersion),
    ownershipRules: ownershipRules(),
    reviewerDirectory: [{ principalId: reviewer.principalId, teamIds: ["team:release"] }],
    ...(input.analyzers ? { analyzers: input.analyzers } : {}),
    landingAuthority: {
      landCohort: (request) => input.control.landCohort(request),
    },
    authorizationEpoch: "epoch:collaboration:v1",
  });
}

test("selects module, Source Space, and Target reviewers while projecting restricted ownership safely", async () => {
  const fixture = await makeChanges();
  try {
    assert.ok(fixture.changeA);
    assert.ok(fixture.changeB);
    const coordinator = collaboration(fixture);
    const cohort = await coordinator.createCohort({
      members: [
        { change: fixture.changeA, revision: fixture.revisionA, verifierActors: [verifier] },
        { change: fixture.changeB, revision: fixture.revisionB, verifierActors: [verifier] },
      ],
      actor: landingActor,
      id: "cohort:ownership",
    });
    const requirements = coordinator.listReviewRequirements(cohort.id);
    assert.equal(requirements.length, 4);
    assert.ok(requirements.some((requirement) => requirement.scopeId === "module:player"));
    assert.ok(requirements.some((requirement) => requirement.scopeId === "private-source"));
    assert.ok(requirements.some((requirement) => requirement.scopeId === "target:production"));
    const publicProjection = coordinator.projectCohort({ cohortId: cohort.id, audience: "public", visibleScopeIds: ["module:player"] });
    const encoded = JSON.stringify(publicProjection);
    assert.equal(encoded.includes("private-source"), false);
    assert.equal(encoded.includes("owner:private-source"), false);
    assert.equal(encoded.includes("Private Source Space owner review"), false);
    assert.equal(publicProjection.requirements.some((requirement) => requirement.scopeId === ""), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("review findings and approvals bind to exact Change Revisions and explain every Landing blocker", async () => {
  const fixture = await makeChanges();
  try {
    assert.ok(fixture.changeA);
    assert.ok(fixture.changeB);
    const coordinator = collaboration(fixture);
    const cohort = await coordinator.createCohort({
      members: [
        { change: fixture.changeA, revision: fixture.revisionA, verifierActors: [verifier] },
        { change: fixture.changeB, revision: fixture.revisionB, verifierActors: [verifier] },
      ],
      actor: landingActor,
      id: "cohort:review",
    });
    const finding = coordinator.submitFinding({
      cohortId: cohort.id,
      changeId: fixture.revisionA.changeId,
      changeRevisionId: fixture.revisionA.id,
      author: reviewer,
      kind: "request-changes",
      severity: "blocking",
      summary: "The public API needs a compatibility note.",
      scope: { moduleId: "module:player", path: "src/public.ts" },
      disclosure: "public",
      idempotencyKey: "finding:compatibility",
    });
    assert.equal(finding.changeId, fixture.revisionA.changeId);
    assert.equal(finding.changeRevisionId, fixture.revisionA.id);
    assert.throws(
      () => coordinator.approve({ cohortId: cohort.id, requirementId: coordinator.listReviewRequirements(cohort.id)[0]!.id, reviewer: authorA }),
      (error: unknown) => error instanceof CollaborationError && error.code === "separation-of-duty",
    );
    let explanation = coordinator.evaluateLanding({
      cohortId: cohort.id,
      evidence: [],
    });
    assert.equal(explanation.decision, "deny");
    assert.ok(explanation.blockers.some((blocker) => blocker.kind === "open-finding"));
    assert.ok(explanation.blockers.some((blocker) => blocker.kind === "missing-evidence"));
    assert.ok(explanation.safeNextCommands.some((command) => command.startsWith("anyam")));

    coordinator.resolveFinding({ findingId: finding.id, actor: reviewer, resolution: "Published the compatibility note in the Change Revision." });
    const requirements = coordinator.listReviewRequirements(cohort.id);
    for (const requirement of requirements) {
      coordinator.approve({ cohortId: cohort.id, requirementId: requirement.id, reviewer, evidenceIds: [] });
    }
    const evidence = [
      evidenceFor(fixture.revisionA, "api-check", "api-check:v1", verifier),
      evidenceFor(fixture.revisionB, "schema-check", "schema-check:v1", verifier),
    ];
    explanation = coordinator.evaluateLanding({ cohortId: cohort.id, evidence });
    assert.equal(explanation.decision, "allow");
    const landed = await coordinator.land({ cohortId: cohort.id, evidence, actor: landingActor });
    assert.equal(landed.landing.cohortId, cohort.id);
    assert.deepEqual(new Set(landed.landing.changeRevisionIds), new Set([fixture.revisionA.id, fixture.revisionB.id]));
    assert.equal(fixture.control.canonicalRevision.landingCohortId, cohort.id);
    assert.deepEqual(new Set(fixture.control.canonicalRevision.landedChangeRevisionIds), new Set([fixture.revisionA.id, fixture.revisionB.id]));
    assert.equal(fixture.control.getChange(fixture.revisionA.changeId)?.status, "landed");
    const promotionAudit = coordinator.recordPromotionAuthority({
      cohortId: cohort.id,
      promotionId: "promotion:collaboration",
      targetId: "target:production",
      releaseId: "release:collaboration",
      actor: promotionActor,
      receipt: "provider=qualification; authority=separate",
    });
    assert.equal(promotionAudit.role, "promotion");
    const roles = new Set(coordinator.listAuditEvents().map((event) => event.role));
    assert.deepEqual([...roles].sort(), ["author", "landing", "promotion", "reviewer", "verifier"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("policy activation makes prior approvals stale and analyzers expose typed cohort conflicts", async () => {
  const fixture = await makeChanges();
  try {
    assert.ok(fixture.changeA);
    assert.ok(fixture.changeB);
    const kinds: readonly IntegrationConflictKind[] = ["textual", "semantic", "schema", "dependency", "policy", "disclosure"];
    const analyzer: IntegrationAnalyzer = {
      id: "analyzer:typed-conflicts",
      analyze: ({ members }) => kinds.map((kind) => ({
        kind,
        severity: "blocking" as const,
        changeIds: members.map((member) => member.changeId),
        scopeIds: ["private-source"],
        description: `typed ${kind} conflict`,
        disclosure: kind === "disclosure" ? "restricted" as const : "project" as const,
        receipt: `analyzer=typed; kind=${kind}`,
        recoveryAction: `resolve ${kind} conflict in a new Change Revision`,
      })),
    };
    const coordinator = collaboration({ ...fixture, analyzers: [analyzer] });
    const cohort = await coordinator.createCohort({
      members: [
        { change: fixture.changeA, revision: fixture.revisionA, verifierActors: [verifier] },
        { change: fixture.changeB, revision: fixture.revisionB, verifierActors: [verifier] },
      ],
      actor: landingActor,
      id: "cohort:typed-conflicts",
    });
    assert.deepEqual(new Set(coordinator.listConflicts(cohort.id).map((conflict) => conflict.kind)), new Set(kinds));
    const requirements = coordinator.listReviewRequirements(cohort.id);
    for (const requirement of requirements) coordinator.approve({ cohortId: cohort.id, requirementId: requirement.id, reviewer });
    coordinator.activatePolicy(policy("policy:collaboration:v2"));
    const stale = coordinator.evaluateLanding({ cohortId: cohort.id, evidence: [] });
    assert.ok(stale.blockers.some((blocker) => blocker.kind === "stale-approval"));
    const publicProjection = coordinator.projectCohort({ cohortId: cohort.id, audience: "public", visibleScopeIds: [] });
    const encoded = JSON.stringify(publicProjection);
    assert.equal(encoded.includes("private-source"), false);
    assert.equal(encoded.includes("typed disclosure conflict"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("declared effect overlap is conservative and never claims universal behavioral conflict detection", async () => {
  const fixture = await makeChanges();
  try {
    assert.ok(fixture.changeA);
    assert.ok(fixture.changeB);
    const coordinator = collaboration(fixture);
    const cohort = await coordinator.createCohort({
      members: [
        { change: fixture.changeA, revision: fixture.revisionA },
        { change: fixture.changeB, revision: fixture.revisionB },
      ],
      actor: landingActor,
      id: "cohort:effect-overlap",
    });
    assert.equal(coordinator.listConflicts(cohort.id).length, 0);
    assert.equal(declaredEffectOverlapAnalyzer.id, "analyzer:declared-effect-overlap/v1");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
