import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CollaborationCoordinator, type LandingAuthority } from "../../src/change-control/collaboration.ts";
import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, emptyAuthorityPlaneSnapshot, type AuthorityCommandName, type AuthorityPlaneSnapshot, type AuthoritySession } from "../../src/cloudflare/authority-plane.ts";
import type { CanonicalRefBinding } from "../../src/cloudflare/canonical-ref-reconciliation.ts";
import type { CohortLandingReview } from "../../src/cloudflare/cohort-landing.ts";
import type { AuthoritySQLiteStore } from "../../src/cloudflare/authority-sqlite.ts";
import type { Evidence } from "../../src/kernel/contracts.ts";
import type { EvidenceRequirement } from "../../src/kernel/evidence.ts";

export const projectId = "project:reconciliation";
export const session: AuthoritySession = { realmId: "realm:reconciliation", principalId: "principal:landing", actorId: "actor:landing", sessionId: "session:landing", clientId: "client:offline", authorizationEpoch: 1 };
type Request = Parameters<LandingAuthority["landCohort"]>[0];

export function realGitSources(root: string) {
  const directories: Record<string, string> = {};
  const revisions: Record<string, string>[] = [{}, {}, {}];
  const bindings: CanonicalRefBinding[] = [];
  for (const space of ["a", "b"]) {
    const directory = join(root, space);
    mkdirSync(directory, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git("init", "--quiet");
    for (const iteration of [0, 1, 2]) {
      writeFileSync(join(directory, "source.txt"), `${space} revision ${iteration}\n`);
      git("add", "source.txt");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", `source ${space} revision ${iteration}`);
      revisions[iteration]![`source:${space}`] = git("rev-parse", "HEAD");
    }
    git("update-ref", "refs/heads/canonical", revisions[0]![`source:${space}`]!);
    directories[`repo:${space}`] = directory;
    bindings.push({ sourceSpaceId: `source:${space}`, repositoryId: `repo:${space}`, ref: "refs/heads/canonical" });
  }
  return { directories, revisions, bindings };
}

export type CohortVerification = (input: { space: string; workspaceId: string; changeRevisionId: string; projectRevisionId: string; projectViewId: string; candidateOid: string }) => Promise<Evidence>;

export async function prepareCohort(store: AuthoritySQLiteStore, tag: string, source: ReturnType<typeof realGitSources>, candidates: Record<string, string>, verify?: CohortVerification) {
  if (!store.load(session.realmId)) store.replace(emptyAuthorityPlaneSnapshot(session.realmId));
  const execute = (name: AuthorityCommandName, key: string, payload: Record<string, unknown>) => {
    const previous = store.load(session.realmId)!;
    const control = new AuthorityPlaneCoordinator(previous);
    const result = control.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey: key, payload }, session);
    store.commit(previous, control.snapshot());
    return result;
  };
  if (!store.load(session.realmId)!.projects[projectId]) execute("project.create", "create", { projectId, name: "Offline reconciliation", projectRevisionId: "project-revision:base", sourceSpaces: ["a", "b"].map((space) => ({ id: `source:${space}`, name: space, classification: space === "a" ? "public" : "internal", repositoryId: `repo:${space}`, snapshotId: source.revisions[0]![`source:${space}`] })) });
  const baseId = store.load(session.realmId)!.canonicalByProject[projectId]!;
  const evidenceIds: string[] = [];
  const requiredEvidence: EvidenceRequirement[] = [];
  const members = [];
  for (const space of ["a", "b"]) {
    const changeId = `change:${tag}:${space}`;
    const workspaceId = `workspace:${tag}:${space}`;
    const revisionId = `change-revision:${tag}:${space}`;
    execute("workspace.create", workspaceId, { projectId, workspaceId, projectRevisionId: baseId, sourceSpaceIds: [`source:${space}`], mounts: [space] });
    execute("change.create", changeId, { projectId, changeId, workspaceId, intentId: `intent:${tag}:${space}`, baseProjectRevisionId: baseId });
    execute("revision.publish", revisionId, { projectId, changeId, revisionId, projectRevisionId: baseId, sourceSpaceSnapshots: { [`source:${space}`]: candidates[`source:${space}`] }, declaredEffects: [`${space}.modify`] });
    const viewId = store.load(session.realmId)!.workspaces[workspaceId]!.projectViewId;
    if (verify) {
      const evidence = await verify({ space, workspaceId, changeRevisionId: revisionId, projectRevisionId: baseId, projectViewId: viewId, candidateOid: candidates[`source:${space}`]! });
      evidenceIds.push(evidence.id);
      requiredEvidence.push({ key: evidence.key, currentValidityKey: evidence.validityKey, expectedChangeRevisionId: revisionId, expectedProjectRevisionId: baseId, expectedProjectViewId: viewId });
    } else {
      const runId = `run:${tag}:${space}`;
      const evidenceId = `evidence:${tag}:${space}`;
      evidenceIds.push(evidenceId);
      execute("run.record", runId, { projectId, workspaceId, changeRevisionId: revisionId, projectRevisionId: baseId, projectViewId: viewId, runId, actionId: "action:compatibility", runnerId: "runner:synthetic", status: "succeeded", inputDigests: [candidates[`source:${space}`]], outputDigest: `sha256:${runId}` });
      execute("evidence.record", evidenceId, { projectId, runId, evidenceId, actionId: "action:compatibility", runnerId: "runner:synthetic", key: "compatibility", criterion: "synthetic declaration", validityKey: `validity:${revisionId}`, verifierId: "verifier:synthetic", toolchainDigest: "sha256:toolchain", dependencyDigest: "sha256:dependencies", environmentDigest: "sha256:environment", inputDigests: [candidates[`source:${space}`]], effectDigests: [`${space}.modify`], outputDigest: `sha256:${runId}`, policyVersion: "policy:fixture", capabilityGrantId: "grant:fixture", disclosure: { projectionId: viewId, classification: "project" }, receipt: "synthetic=true; liveVerifier=false", invalidators: [], owner: "fixture" });
      requiredEvidence.push({ key: "compatibility", currentValidityKey: `validity:${revisionId}`, expectedChangeRevisionId: revisionId, expectedProjectRevisionId: baseId, expectedProjectViewId: viewId });
    }
    members.push({ changeId, changeRevisionId: revisionId });
  }
  const snapshot = store.load(session.realmId)!;
  const request: Request = { cohortId: `cohort:${tag}`, members, expectedCanonicalProjectRevisionId: baseId };
  const reviewer = { principalId: "principal:reviewer", actorId: "actor:reviewer", sessionId: "session:reviewer", clientId: "client:reviewer" };
  const control = new CollaborationCoordinator({ projectId, canonicalRevision: snapshot.projectRevisions[baseId]!, policy: { version: "policy:fixture", requiredEvidence }, ownershipRules: ["a", "b"].map((space) => ({ id: `owner:${space}`, scopeKind: "source-space", scopeId: `source:${space}`, requiredReviewerPrincipalIds: [reviewer.principalId], requiredReviewerTeamIds: [], disclosure: "project", label: `Owner ${space}` })), reviewerDirectory: [{ principalId: reviewer.principalId, teamIds: [] }] });
  await control.createCohort({ id: request.cohortId, members: members.map((member) => ({ change: snapshot.changes[member.changeId]!, revision: snapshot.changeRevisions[member.changeRevisionId]! })), actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId } });
  for (const requirement of control.listReviewRequirements(request.cohortId)) control.approve({ cohortId: request.cohortId, requirementId: requirement.id, reviewer, evidenceIds });
  const evaluate = (fresh: Readonly<AuthorityPlaneSnapshot>): CohortLandingReview => {
    control.setCanonicalProjectRevision(fresh.projectRevisions[fresh.canonicalByProject[projectId]!]!);
    return { explanation: control.evaluateLanding({ cohortId: request.cohortId, evidence: Object.values(fresh.evidence) }), evidenceIds, approvals: control.listApprovals(request.cohortId) };
  };
  return { request, evaluate };
}
