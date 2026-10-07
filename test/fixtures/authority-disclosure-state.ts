import { RealmIdentityPolicy } from "../../src/identity/realm.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, emptyAuthorityPlaneSnapshot, type AuthorityCommandName } from "../../src/cloudflare/authority-plane.ts";
import { CONTRACT_VERSIONS } from "../../src/kernel/contracts.ts";

export const disclosureClock = Date.parse("2026-10-02T12:00:00Z");
export function disclosureFixture() {
  const identity = new RealmIdentityPolicy({ realmId: "realm:disclosure-local", relyingPartyId: "fixture.local", now: () => new Date(disclosureClock) });
  const members = Object.fromEntries(["owner", "public", "private", "unrelated", "projectOwner"].map(name => {
    const principal = identity.createPrincipal({ displayName: `Synthetic ${name}` });
    identity.registerPasskey({ principalId: principal.id, credentialId: `synthetic-${name}-passkey` });
    const session = identity.authenticatePasskey({ credentialId: `synthetic-${name}-passkey`, challenge: "test-only", verified: true });
    if (name !== "unrelated") identity.addRelationship({ principalId: principal.id, kind: "organization-member", subjectId: principal.id,
      role: name === "owner" || name === "projectOwner" ? "owner" : "viewer", resource: { realmId: identity.realm.id, ...(name === "owner" ? {} : { projectId: "project:fixture" }) } });
    return [name, { principal, session }];
  }));
  for (const [sourceSpaceId, classification, readers] of [
    ["source:public", "public", ["owner", "public", "private", "projectOwner"]],
    ["source:hidden", "restricted", ["owner", "private", "projectOwner"]],
  ] as const) identity.setSourceSpacePolicy({ sourceSpaceId, classification, allowedCapabilities: ["source.read"], readerPrincipalIds: readers.map(name => members[name]!.principal.id), discoverable: classification === "public" });
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(identity.realm.id));
  const owner = members.owner!;
  const actor = { realmId: identity.realm.id, principalId: owner.principal.id, actorId: owner.session.actorId, sessionId: owner.session.id, clientId: owner.session.clientId, authorizationEpoch: identity.realm.authorizationEpoch, kind: "human" as const };
  const command = (name: AuthorityCommandName, key: string, payload: Record<string, unknown>) => {
    const result = authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: name, idempotencyKey: key, payload }, actor);
    if (result.status !== "succeeded") throw new Error(`Fixture ${name} failed: ${result.receipt}`);
    return result;
  };
  command("project.create", "project", { projectId: "project:fixture", name: "Synthetic hybrid Project", referenceType: "hybrid-public-private", projectRevisionId: "canonical:base", sourceSpaces: [
    { id: "source:public", name: "Public Source", classification: "public", repositoryId: "repository:public", snapshotId: "snapshot:public" },
    { id: "source:hidden", name: "PRIVATE-source-marker", classification: "restricted", repositoryId: "PRIVATE-repository-marker", snapshotId: "PRIVATE-snapshot-marker" },
  ] });
  for (const [kind, sourceSpaceIds] of [["public", ["source:public"]], ["hidden", ["source:hidden"]], ["mixed", ["source:public", "source:hidden"]]] as const) {
    command("workspace.create", `workspace:${kind}`, { projectId: "project:fixture", workspaceId: `workspace:${kind}`, projectRevisionId: "canonical:base", sourceSpaceIds });
    command("change.create", `change:${kind}`, { projectId: "project:fixture", changeId: `change:${kind}`, intentId: `intent:${kind}`, workspaceId: `workspace:${kind}`, baseProjectRevisionId: "canonical:base" });
    const w = authority.snapshot().workspaces[`workspace:${kind}`]!;
    command("revision.publish", `revision:${kind}`, { projectId: "project:fixture", changeId: `change:${kind}`, revisionId: `revision:${kind}`, projectRevisionId: `candidate:${kind}`, projectViewId: w.projectViewId, workspaceId: w.id,
      sourceSpaceSnapshots: Object.fromEntries(sourceSpaceIds.map(id => [id, `${id}:candidate`])), declaredEffects: ["source.propose"], kind: "implementation" });
    command("run.record", `run:${kind}`, { projectId: "project:fixture", runId: `run:${kind}`, actionId: "PRIVATE-action-marker", projectRevisionId: `candidate:${kind}`, projectViewId: w.projectViewId, workspaceId: w.id, changeRevisionId: `revision:${kind}`, runnerId: "PRIVATE-runner-marker", status: "succeeded", inputDigests: ["PRIVATE-input-marker"], outputDigest: "PRIVATE-output-marker" });
    command("evidence.record", `evidence:${kind}`, { projectId: "project:fixture", runId: `run:${kind}`, evidenceId: `evidence:${kind}`, key: "test-result", criterion: "Synthetic criterion", validityKey: "synthetic-validity", actionId: "PRIVATE-action-marker", verifierId: "PRIVATE-verifier-marker", toolchainDigest: "PRIVATE-toolchain-marker", dependencyDigest: "PRIVATE-dependencies-marker", environmentDigest: "PRIVATE-environment-marker", inputDigests: ["PRIVATE-input-marker"], effectDigests: [], outputDigest: "PRIVATE-output-marker", policyVersion: identity.realm.policyVersion, capabilityGrantId: "synthetic-grant", disclosure: { projectionId: authority.snapshot().projectViews[w.projectViewId]!.projectionId, classification: kind === "public" ? "public" : "restricted" }, receipt: "PRIVATE-evidence-receipt-marker", invalidators: [], owner: "Synthetic fixture" });
  }
  command("intent.create", "intent:collaboration", { projectId: "project:fixture", intentId: "intent:collaboration", title: "Visible collaboration", description: "Project discussion", disclosure: "project" });
  command("intent.comment", "comment:visible", { intentId: "intent:collaboration", commentId: "comment:visible", body: "Visible comment", disclosure: "project" });
  command("intent.comment", "comment:hidden", { intentId: "intent:collaboration", commentId: "comment:hidden", body: "PRIVATE-comment-marker", disclosure: "project" });
  command("intent.create", "intent:restricted", { projectId: "project:fixture", intentId: "intent:restricted", title: "PRIVATE-intent-marker", description: "Restricted discussion", disclosure: "restricted" });
  const state = authority.snapshot();
  // Imported legacy state may contain comments narrower than their Intent.
  state.intentComments["comment:hidden"]!.disclosure = "restricted";
  state.intents["intent:hidden"]!.disclosure = "restricted";
  state.intents["intent:mixed"]!.disclosure = "restricted";
  // Explicit synthetic read fixtures. These do not qualify creation/execution.
  for (const kind of ["public", "hidden", "mixed"] as const) {
    const w = state.workspaces[`workspace:${kind}`]!;
    state.artifacts[`artifact:${kind}`] = { protocol: CONTRACT_VERSIONS.artifact, id: `artifact:${kind}`, type: "test", digest: "PRIVATE-artifact-digest-marker", projectRevisionId: `candidate:${kind}`, changeRevisionId: `revision:${kind}`, runId: `run:${kind}`, disclosure: { projectionId: state.projectViews[w.projectViewId]!.projectionId, classification: kind === "public" ? "public" : "restricted" } };
    state.releases[`release:${kind}`] = { protocol: CONTRACT_VERSIONS.release, id: `release:${kind}`, projectRevisionId: `candidate:${kind}`, changeRevisionId: `revision:${kind}`, artifactIds: [`artifact:${kind}`], evidenceIds: [`evidence:${kind}`], configurationDigests: ["PRIVATE-configuration-marker"], stateAssumptions: [], policyVersion: identity.realm.policyVersion, status: "ready", provenanceDigest: "PRIVATE-provenance-marker" };
    state.targets[`target:${kind}`] = { protocol: CONTRACT_VERSIONS.target, id: `target:${kind}`, projectId: "project:fixture", name: `${kind} target`, adapterId: "synthetic-adapter", acceptedArtifactTypes: ["test"], requiredEvidenceKeys: ["test-result"], state: "configured", currentReleaseId: `release:${kind}`, releaseHistory: [`release:${kind}`] };
    state.promotions[`promotion:${kind}`] = { protocol: CONTRACT_VERSIONS.promotion, id: `promotion:${kind}`, projectId: "project:fixture", targetId: `target:${kind}`, releaseId: `release:${kind}`, releaseDigest: "PRIVATE-release-digest-marker", previousReleaseId: null, expectedCurrentReleaseId: null, state: "proposed", attempt: 1, kind: "promotion", idempotencyKey: `synthetic:${kind}`, actor, createdAt: "2026-10-02T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z", receipt: "PRIVATE-promotion-receipt-marker" };
    state.pullRequests[`pr:${kind}`] = { protocol: CONTRACT_VERSIONS.pullRequest, id: `pr:${kind}`, projectId: "project:fixture", changeId: `change:${kind}`, provider: "PRIVATE-provider-marker", remoteRepository: "PRIVATE-provider-repository-marker", sourceSpaceId: kind === "hidden" ? "source:hidden" : "source:public", headRef: "branch:public", baseRef: "main", headCommit: "a".repeat(40), baseCommit: "b".repeat(40), title: `${kind} PR`, description: "Synthetic PR", status: "open", reviewState: "pending", revisionIds: [`revision:${kind}`], disclosure: "project", createdAt: "2026-10-02T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z", receipt: "PRIVATE-pr-receipt-marker" };
  }
  for (const kind of ["public", "hidden"] as const) state.mirrors[`mirror:${kind}`] = { protocol: CONTRACT_VERSIONS.mirror, id: `mirror:${kind}`, projectId: "project:fixture", sourceSpaceId: `source:${kind}`, provider: "synthetic-provider", remoteRepository: `${kind}-mirror`, direction: "bidirectional", canonicalAuthority: "anyam", refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }], disclosure: kind === "public" ? "public" : "restricted", state: "healthy", canonicalProjectRevisionId: "canonical:base", canonicalRefs: [{ name: "refs/heads/main", oid: "a".repeat(40) }], remoteGeneration: "PRIVATE-remote-generation-marker", remoteRefs: [{ name: "refs/heads/main", oid: "a".repeat(40) }], pendingInboundChangeIds: ["change:public", "change:hidden"], createdAt: "2026-10-02T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z", receipt: "PRIVATE-mirror-receipt-marker" };
  return { identity: identity.getRecoverySnapshot(), state, members };
}
