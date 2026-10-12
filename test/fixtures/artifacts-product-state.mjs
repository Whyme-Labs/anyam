import assert from "node:assert/strict";
import { RealmIdentityPolicy } from "../../src/identity/realm.ts";
import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, emptyAuthorityPlaneSnapshot } from "../../src/cloudflare/authority-plane.ts";
import { disclosureFixture } from "./authority-disclosure-state.ts";
import { artifactsSelection } from "./artifacts-binding.ts";
export function artifactsProductState() {
  const f = disclosureFixture();
  for (const session of Object.values(f.identity.sessions)) session.expiresAt = "2099-01-01T00:00:00Z";
  const identity = new RealmIdentityPolicy({ realmId: f.identity.realm.id, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date("2026-10-02T12:00:00Z") });
  identity.restoreOperationalSnapshot(f.identity);
  const member = f.members.owner;
  identity.setSourceSpacePolicy({ sourceSpaceId: "source:app", classification: "restricted", readerPrincipalIds: [member.principal.id], allowedCapabilities: ["source.read", "workspace.write"] });
  const coordinator = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(f.identity.realm.id));
  const actor = { realmId: f.identity.realm.id, principalId: member.principal.id, actorId: member.session.actorId, sessionId: member.session.id, clientId: member.session.clientId, kind: "human", authorizationEpoch: identity.realm.authorizationEpoch };
  coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "project.create", idempotencyKey: "product-project", payload: { projectId: artifactsSelection.projectId, name: "Synthetic product", projectRevisionId: artifactsSelection.projectRevisionId, sourceSpaces: [{ id: "source:app", name: "Source", classification: "restricted", snapshotId: artifactsSelection.baseCommitOid, repositoryId: "repository:artifacts:account-a:private:uuid-source" }] } }, actor);
  assert.equal(coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "workspace.create", idempotencyKey: "product-workspace", payload: { projectId: artifactsSelection.projectId, projectRevisionId: artifactsSelection.projectRevisionId, workspaceId: "workspace:a", sourceSpaceIds: ["source:app"] } }, actor).status, "succeeded");
  const grant = identity.createOwnerTaskGrant({ sessionId: member.session.id, purpose: "Existing synthetic materialization authority", resource: { realmId: identity.realm.id, projectId: artifactsSelection.projectId, workspaceId: "workspace:a", sourceSpaceId: "source:app" }, sourceSpaceIds: ["source:app"], actions: ["source.read", "workspace.write"], effects: ["source.read", "workspace.write"], expiresAt: "2099-01-01T00:00:00Z" });
  f.identity = identity.getRecoverySnapshot(); f.state = coordinator.snapshot();
  return { fixture: f, input: { taskId: grant.task.id, grantId: grant.grant.id, sourceRepositoryName: "source", targetName: "workspace-a", baseTreeOid: artifactsSelection.baseTreeOid } };
}
