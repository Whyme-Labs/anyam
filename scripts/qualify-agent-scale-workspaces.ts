import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { LocalChangeCoordinator, type WorkspaceSource } from "../src/change-control/local.ts";
import { EvidenceLedger, evaluateStageGate } from "../src/kernel/evidence.ts";
import { CONTRACT_VERSIONS, createProjectRevision, type ActorRef, type Project, type ProjectView, type SourceSpace } from "../src/kernel/contracts.ts";

const protocol = "anyam.agent-scale-workspaces-qualification/v1" as const;
const fixtureActors = ["agent:codex", "agent:claude", "agent:cursor"] as const;
const fixtureReceipt = "fixture=agent-scale-workspaces; workspaceCount=3; sharedBranch=observation-only; not-a-product-limit; remeasure-before-production";

function actorRef(actorId: string): ActorRef {
  return { principalId: `principal:${actorId}`, actorId, sessionId: `session:${actorId}`, clientId: `client:${actorId}` };
}

function viewFor(project: Project, revisionId: string, sourceSpace: SourceSpace, snapshotId: string): ProjectView {
  return {
    protocol: CONTRACT_VERSIONS.kernel,
    id: `project-view:${sourceSpace.id}`,
    projectId: project.id,
    projectRevisionId: revisionId,
    projectionId: `projection:${sourceSpace.id}`,
    classification: "public",
    visibleSourceSpaceIds: [sourceSpace.id],
    disclosedSourceSpaceSnapshots: { [sourceSpace.id]: snapshotId },
  };
}

function evidenceInput(input: {
  id: string;
  key: string;
  outcome: "passed" | "failed";
  validityKey: string;
  projectRevisionId: string;
  changeRevisionId?: string;
  projectViewId: string;
  runId: string;
  receipt: string;
}) {
  return {
    id: input.id,
    key: input.key,
    criterion: `Agent-scale qualification evidence for ${input.key}.`,
    outcome: input.outcome,
    validityKey: input.validityKey,
    actionId: "action:agent-scale-workspaces",
    verifierId: "verifier:agent-scale-workspaces",
    toolchainDigest: "sha256:agent-scale-toolchain",
    dependencyDigest: "sha256:agent-scale-dependencies",
    environmentDigest: "sha256:agent-scale-environment",
    inputDigests: [input.projectRevisionId],
    effectDigests: ["sha256:agent-scale-effects"],
    outputDigest: `sha256:${input.id}`,
    producer: { kind: "run" as const, id: input.runId, version: "qualification-v1" },
    projectRevisionId: input.projectRevisionId,
    projectViewId: input.projectViewId,
    ...(input.changeRevisionId ? { changeRevisionId: input.changeRevisionId } : {}),
    runId: input.runId,
    actor: actorRef("verifier:agent-scale"),
    runnerId: "runner:agent-scale-local",
    policyVersion: "policy:agent-scale-qualification:v1",
    authorizationEpoch: "fixture-owner-session",
    capabilityGrantId: "grant:agent-scale-qualification",
    disclosure: { projectionId: "projection:agent-scale", classification: "project" as const },
    receipt: input.receipt,
    invalidators: ["source-revision", "cohort-members", "policy-version"],
    owner: "Anyam agent-scale qualification",
    workspaceId: "workspace:agent-scale-verifier",
  };
}

export async function qualifyAgentScaleWorkspaces(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "anyam-agent-scale-workspaces-"));
  const project: Project = { protocol: CONTRACT_VERSIONS.project, id: "project:agent-scale", name: "Agent-scale Workspace fixture", referenceType: "git", sourceSpaceIds: fixtureActors.map((actor) => `source:${actor}`) };
  const sourceSpaces: SourceSpace[] = fixtureActors.map((actor) => ({ protocol: CONTRACT_VERSIONS.sourceSpace, id: `source:${actor}`, name: actor, classification: "public" }));
  const baselineSnapshots = Object.fromEntries(sourceSpaces.map((source) => [source.id, `snapshot:baseline:${source.id}`]));
  const baseline = createProjectRevision({ id: "project-revision:agent-scale:baseline", projectId: project.id, sourceSpaceSnapshots: baselineSnapshots });
  const coordinator = new LocalChangeCoordinator({ project, sourceSpaces, canonicalRevision: baseline });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const members: Array<{ changeId: string; changeRevisionId: string }> = [];
  const workspaceReceipts: string[] = [];
  const workspaceCheckpoints: Array<{ workspaceId: string; projectRevisionId: string; sourceSpaceSnapshots: Readonly<Record<string, string>> }> = [];
  const evidenceLedger = new EvidenceLedger();

  try {
    for (const actorId of fixtureActors) {
      const sourceSpace = sourceSpaces.find((candidate) => candidate.id === `source:${actorId}`);
      if (!sourceSpace) throw new Error(`fixture source missing for ${actorId}`);
      const view = viewFor(project, baseline.id, sourceSpace, baselineSnapshots[sourceSpace.id]!);
      const workspaceId = `workspace:${actorId}`;
      const workspace = await coordinator.createWorkspace({
        view,
        sources: [{ sourceSpaceId: sourceSpace.id, snapshotId: baselineSnapshots[sourceSpace.id]!, files: { "README.md": `${actorId}\n` } } satisfies WorkspaceSource],
        mounts: [{ sourceSpaceId: sourceSpace.id, mountPath: "source" }],
        directory: join(root, workspaceId.replaceAll(":", "-")),
        id: workspaceId,
        actorId,
      });
      workspaceCheckpoints.push({
        workspaceId: workspace.workspace.id,
        projectRevisionId: workspace.workspace.projectRevisionId,
        sourceSpaceSnapshots: { [sourceSpace.id]: baselineSnapshots[sourceSpace.id]! },
      });
      const actor = actorRef(actorId);
      const changeId = `change:${actorId}`;
      const change = coordinator.createChange({ id: changeId, intentId: `intent:${actorId}`, workspaceId: workspace.workspace.id, author: actor });
      const revision = coordinator.publishRevision({
        changeId: change.id,
        workspaceId: workspace.workspace.id,
        declaredEffects: [`source-space:${sourceSpace.id}`],
        sourceSpaceSnapshots: { [sourceSpace.id]: `snapshot:${actorId}:revision-1` },
        actor,
      });
      members.push({ changeId, changeRevisionId: revision.id });
      workspaceReceipts.push(`workspace=${workspace.workspace.id}; actor=${actorId}; change=${changeId}; revision=${revision.id}; base=${baseline.id}`);
    }

    // The isolated path is trusted. The shared-branch path is retained only
    // as an observation fixture; it is deliberately not used for Landing.
    const overlapSource = sourceSpaces[0]!;
    const overlapView = viewFor(project, baseline.id, overlapSource, baselineSnapshots[overlapSource.id]!);
    const overlapMembers: Array<{ changeId: string; changeRevisionId: string }> = [];
    for (const suffix of ["a", "b"] as const) {
      const workspace = await coordinator.createWorkspace({
        view: overlapView,
        sources: [{ sourceSpaceId: overlapSource.id, snapshotId: baselineSnapshots[overlapSource.id]!, files: { "README.md": `overlap-${suffix}\n` } } satisfies WorkspaceSource],
        mounts: [{ sourceSpaceId: overlapSource.id, mountPath: "source" }],
        directory: join(root, `overlap-${suffix}`),
        id: `workspace:overlap:${suffix}`,
        actorId: `agent:overlap:${suffix}`,
      });
      const actor = actorRef(`agent:overlap:${suffix}`);
      const change = coordinator.createChange({ id: `change:overlap:${suffix}`, intentId: `intent:overlap:${suffix}`, workspaceId: workspace.workspace.id, author: actor });
      const revision = coordinator.publishRevision({
        changeId: change.id,
        workspaceId: workspace.workspace.id,
        declaredEffects: [`source-space:${overlapSource.id}`, "contract:shared-effect"],
        sourceSpaceSnapshots: { [overlapSource.id]: `snapshot:overlap:${suffix}` },
        actor,
      });
      overlapMembers.push({ changeId: change.id, changeRevisionId: revision.id });
    }
    let overlapReceipt = "overlap=not-observed";
    try {
      coordinator.landCohort({ cohortId: "cohort:overlap", members: overlapMembers, expectedCanonicalProjectRevisionId: baseline.id });
    } catch (error) {
      overlapReceipt = error instanceof Error && "receipt" in error ? String(error.receipt) : "overlap=blocked; receipt=not-returned";
    }
    assert.match(overlapReceipt, /sourceSpace=|incompatible|overlap/u);

    const evidenceValidityKey = `cohort:${baseline.id}:${members.map((member) => member.changeRevisionId).join(",")}`;
    const firstRevision = members[0]?.changeRevisionId;
    const failedEvidence = evidenceLedger.append(evidenceInput({
      id: "evidence:agent-scale:checks-failed",
      key: "agent-scale-checks",
      outcome: "failed",
      validityKey: evidenceValidityKey,
      projectRevisionId: baseline.id,
      ...(firstRevision ? { changeRevisionId: firstRevision } : {}),
      projectViewId: "project-view:source:agent:codex",
      runId: "run:agent-scale:checks-failed",
      receipt: "evidence=failed; reason=fixture-check-failure; canonicalWrite=false",
    }));
    const blockedEvidenceGate = evaluateStageGate({
      gateId: "cohort:agent-scale",
      requiredEvidence: [{ key: "agent-scale-checks", currentValidityKey: evidenceValidityKey }],
      evidence: [failedEvidence],
    });
    assert.equal(blockedEvidenceGate.status, "blocked");
    const passedEvidence = evidenceLedger.append(evidenceInput({
      id: "evidence:agent-scale:checks-passed",
      key: "agent-scale-checks",
      outcome: "passed",
      validityKey: evidenceValidityKey,
      projectRevisionId: baseline.id,
      ...(firstRevision ? { changeRevisionId: firstRevision } : {}),
      projectViewId: "project-view:source:agent:codex",
      runId: "run:agent-scale:checks-retry",
      receipt: "evidence=passed; retry=resume-same-cohort; canonicalWrite=false",
    }));
    const compositionEvidence = evidenceLedger.append(evidenceInput({
      id: "evidence:agent-scale:composition-passed",
      key: "agent-scale-composition",
      outcome: "passed",
      validityKey: evidenceValidityKey,
      projectRevisionId: baseline.id,
      ...(firstRevision ? { changeRevisionId: firstRevision } : {}),
      projectViewId: "project-view:source:agent:codex",
      runId: "run:agent-scale:composition",
      receipt: "evidence=passed; cohort=non-overlapping-source-spaces; canonicalWrite=false",
    }));
    const readyEvidenceGate = evaluateStageGate({
      gateId: "cohort:agent-scale",
      requiredEvidence: [
        { key: "agent-scale-checks", currentValidityKey: evidenceValidityKey },
        { key: "agent-scale-composition", currentValidityKey: evidenceValidityKey },
      ],
      evidence: evidenceLedger.list(),
    });
    assert.equal(readyEvidenceGate.status, "ready");

    const landing = coordinator.landCohort({ cohortId: "cohort:agent-scale", members, expectedCanonicalProjectRevisionId: baseline.id });
    const afterLanding = coordinator.canonicalRevision;
    for (const actorId of fixtureActors) {
      const sourceId = `source:${actorId}`;
      assert.equal(afterLanding.sourceSpaceSnapshots[sourceId], `snapshot:${actorId}:revision-1`);
      assert.equal(coordinator.getChange(`change:${actorId}`)?.status, "landed");
    }

    let duplicateEventReceipt = "duplicate=not-observed";
    try {
      coordinator.landCohort({ cohortId: "cohort:agent-scale", members, expectedCanonicalProjectRevisionId: baseline.id });
    } catch (error) {
      duplicateEventReceipt = error instanceof Error && "receipt" in error ? String(error.receipt) : "duplicate=blocked; receipt=not-returned";
    }
    assert.match(duplicateEventReceipt, /expected=.*actual=.*compare-and-swap=false/u);

    const staleView = viewFor(project, baseline.id, sourceSpaces[0]!, baselineSnapshots[sourceSpaces[0]!.id]!);
    const staleWorkspace = await coordinator.createWorkspace({
      view: staleView,
      sources: [{ sourceSpaceId: sourceSpaces[0]!.id, snapshotId: baselineSnapshots[sourceSpaces[0]!.id]!, files: { "README.md": "stale\n" } } satisfies WorkspaceSource],
      mounts: [{ sourceSpaceId: sourceSpaces[0]!.id, mountPath: "source" }],
      directory: join(root, "stale-workspace"),
      id: "workspace:stale",
      actorId: "agent:stale",
    });
    const staleChange = coordinator.createChange({ id: "change:stale", intentId: "intent:stale", workspaceId: staleWorkspace.workspace.id, author: actorRef("agent:stale") });
    const staleRevision = coordinator.publishRevision({ changeId: staleChange.id, workspaceId: staleWorkspace.workspace.id, declaredEffects: ["source-space:stale"], sourceSpaceSnapshots: { [sourceSpaces[0]!.id]: "snapshot:stale:revision-1" }, actor: actorRef("agent:stale") });
    let staleReceipt = "stale=not-observed";
    try {
      coordinator.landChange({ changeId: staleChange.id, changeRevisionId: staleRevision.id, expectedCanonicalProjectRevisionId: baseline.id });
    } catch (error) {
      staleReceipt = error instanceof Error && "receipt" in error ? String(error.receipt) : "stale=blocked; receipt=not-returned";
    }
    assert.match(staleReceipt, /stale|canonical|expected=/u);

    const rebased = await coordinator.rebaseChange({
      changeId: staleChange.id,
      view: viewFor(project, afterLanding.id, sourceSpaces[0]!, afterLanding.sourceSpaceSnapshots[sourceSpaces[0]!.id]!),
      sources: [{ sourceSpaceId: sourceSpaces[0]!.id, snapshotId: afterLanding.sourceSpaceSnapshots[sourceSpaces[0]!.id]!, files: { "README.md": "rebased\n" } } satisfies WorkspaceSource],
      mounts: [{ sourceSpaceId: sourceSpaces[0]!.id, mountPath: "source" }],
      directory: join(root, "stale-rebased-workspace"),
      actorId: "agent:stale",
      declaredEffects: [`source-space:${sourceSpaces[0]!.id}`, "retry:stale-base"],
    });
    const retryRevision = coordinator.publishRevision({
      changeId: staleChange.id,
      workspaceId: rebased.workspace.id,
      declaredEffects: [`source-space:${sourceSpaces[0]!.id}`, "retry:stale-base"],
      sourceSpaceSnapshots: { [sourceSpaces[0]!.id]: "snapshot:stale:retry-1" },
      actor: actorRef("agent:stale"),
      kind: "implementation",
    });
    const retryLanding = coordinator.landChange({ changeId: staleChange.id, changeRevisionId: retryRevision.id, expectedCanonicalProjectRevisionId: afterLanding.id });
    const afterRetry = coordinator.canonicalRevision;
    const elapsedMs = Math.round(performance.now() - started);
    return {
      protocol,
      status: "succeeded",
      fixtureReceipt,
      startedAt,
      finishedAt: new Date().toISOString(),
      measurements: {
        workspaceCount: fixtureActors.length,
        landingMemberCount: members.length,
        overlapFixtureMemberCount: overlapMembers.length,
        evidenceRecordCount: evidenceLedger.list().length,
        elapsedMs,
        measurement: "local-fixture",
        notAProductLimit: true,
      },
      workspaces: { isolated: true, sharedBranch: "observation-only", receipts: workspaceReceipts, checkpoints: workspaceCheckpoints },
      sharedBranchObservation: { status: "observation-only", mutableWorkspaceCount: fixtureActors.length, trustModel: false, receipt: fixtureReceipt },
      overlap: { status: "blocked", receipt: overlapReceipt, declaredEffect: "contract:shared-effect" },
      evidence: { blockedGate: blockedEvidenceGate, readyGate: readyEvidenceGate, passedEvidenceIds: [passedEvidence.id, compositionEvidence.id], receipt: "evidence=required-before-landing; failed-and-retried; canonicalWrite=false" },
      landing: { status: "succeeded", id: landing.id, cohortId: landing.cohortId, changeIds: landing.changeIds, changeRevisionIds: landing.changeRevisionIds, previous: landing.previousProjectRevisionId, next: landing.projectRevisionId, receipt: landing.receipt },
      duplicateEvent: { status: "blocked", receipt: duplicateEventReceipt, receiptMeaning: "same cohort replay did not mutate canonical state" },
      staleBase: { status: "blocked", receipt: staleReceipt },
      retryResume: { status: "succeeded", staleChangeId: staleChange.id, rebaseRevisionId: rebased.revision.id, retryRevisionId: retryRevision.id, landingId: retryLanding.id, canonicalProjectRevisionId: afterRetry.id, receipt: "retry=resume-after-stale-base; rebase=explicit; compare-and-swap=true" },
      landableRevisions: { status: "verified", changeRevisionIds: members.map((member) => member.changeRevisionId), evidenceGate: readyEvidenceGate.status, receipt: "landable=latest-change-revisions; evidence=ready" },
      release: { status: "not-created", projectRevisionId: afterRetry.id, evidenceIds: evidenceLedger.list().filter((record) => record.outcome === "passed").map((record) => record.id), receipt: "release=not-created; qualification-boundary=verified-landing; artifact-target=not-run" },
      canonical: { projectRevisionId: afterRetry.id, sourceSpaceSnapshots: afterRetry.sourceSpaceSnapshots },
      cleanup: { status: "succeeded", workspaceRootRemoved: true, receipt: "cleanup=workspace-root-removed; canonicalWrite=false" },
      credentialValues: "not-printed",
      canonicalWrite: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  console.log(JSON.stringify(await qualifyAgentScaleWorkspaces(), null, 2));
} catch (error) {
  console.error(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : "qualification failed", credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the named Workspace/Landing receipt and retry the same bounded fixture" }, null, 2));
  process.exitCode = 2;
}
