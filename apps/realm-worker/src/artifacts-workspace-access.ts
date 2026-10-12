import { assertArtifactsWorkspaceSelection, type ArtifactsWorkspaceSelection } from "../../../src/cloudflare/artifacts-workspace.ts";
import type { AuthorityPlaneSnapshot } from "../../../src/cloudflare/authority-plane.ts";
import type { RealmIdentityPolicy } from "../../../src/identity/realm.ts";

export type ArtifactsRealmBinding = { workspaceId: string; sourceSpaceId: string; taskId: string; grantId: string };
export type ArtifactsRealmAuthorization = { sessionId: string; bindings: readonly ArtifactsRealmBinding[] };
export type ArtifactsRealmAccess = {
  accountId: string;
  namespace: string;
  current(): Promise<{ identity: RealmIdentityPolicy; authority: AuthorityPlaneSnapshot; active: boolean }>;
};

export class ArtifactsRealmAccessError extends Error {
  constructor(readonly code: "denied" | "unavailable", detail: string) { super(detail); }
}

export async function currentArtifactsRealmOwner(options: ArtifactsRealmAccess, sessionId: string) {
  const state = await options.current();
  if (!state.active) throw new ArtifactsRealmAccessError("unavailable", "recovery blocked");
  const session = state.identity.validateSession(sessionId);
  const identity = state.identity.getRecoverySnapshot();
  if (state.authority.realmId !== identity.realm.id || identity.actors[session.actorId]?.kind !== "human" || !Object.values(identity.relationships).some(relationship => relationship.principalId === session.principalId && relationship.status === "active" && relationship.role === "owner" && relationship.resource.realmId === identity.realm.id && Object.keys(relationship.resource).every(key => key === "realmId"))) throw new ArtifactsRealmAccessError("denied", "owner denied");
  return { ...state, session };
}

/** Shared live Task/Grant and exact Workspace/Source binding check. */
export async function authorizeRealmArtifactsSelection(options: ArtifactsRealmAccess, authorization: ArtifactsRealmAuthorization, selection: ArtifactsWorkspaceSelection, receiptMetadata?: string) {
    assertArtifactsWorkspaceSelection(selection, options.accountId, options.namespace);
    const { identity, authority, session } = await currentArtifactsRealmOwner(options, authorization.sessionId);
    const project = authority.projects[selection.projectId];
    const workspace = authority.workspaces[selection.workspaceId];
    const revision = authority.projectRevisions[selection.projectRevisionId];
    const view = authority.projectViews[selection.projectViewId];
    const source = authority.sourceSpaces[selection.sourceSpaceId];
    const binding = authorization.bindings.find(entry => entry.workspaceId === selection.workspaceId && entry.sourceSpaceId === selection.sourceSpaceId);
    const identitySnapshot = identity.getRecoverySnapshot();
    const policy = identitySnapshot.sourceSpacePolicies[selection.sourceSpaceId];
    const creator = identitySnapshot.actors[workspace?.actorId ?? ""];
    if (receiptMetadata !== undefined && Object.keys(identitySnapshot.sessions).some(handle => receiptMetadata.includes(handle))) throw new ArtifactsRealmAccessError("denied", "session metadata denied");
    if (!binding || !project || !workspace || !revision || !view || !source || !policy || !creator || creator.kind !== "human" || creator.realmId !== identity.realm.id || creator.principalId !== session.principalId || source.classification !== policy.classification ||
      workspace.state !== "active" || workspace.projectId !== project.id || workspace.projectRevisionId !== revision.id || workspace.projectViewId !== view.id ||
      revision.projectId !== project.id || view.projectId !== project.id || view.projectRevisionId !== revision.id || !project.sourceSpaceIds.includes(source.id) || !view.visibleSourceSpaceIds.includes(source.id) ||
      revision.sourceSpaceSnapshots[source.id] !== selection.baseCommitOid || view.disclosedSourceSpaceSnapshots[source.id] !== selection.baseCommitOid || !workspace.mounts.some(mount => mount.sourceSpaceId === source.id && mount.snapshotId === selection.baseCommitOid) ||
      source.repositoryId !== `repository:artifacts:${selection.sourceRepository.accountId}:${selection.sourceRepository.namespace}:${selection.sourceRepository.repositoryId}`) throw new ArtifactsRealmAccessError("denied", "scope denied");
    const resource = { realmId: identity.realm.id, projectId: project.id, workspaceId: workspace.id, sourceSpaceId: source.id };
    for (const capability of ["source.read", "workspace.write"] as const) {
      const chain = { principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: binding.taskId, grantId: binding.grantId, resource };
      const validation = identity.validateTaskGrant({ ...chain, action: capability, sourceSpaceIds: [source.id], effects: [capability] });
      if (!validation.valid) throw new ArtifactsRealmAccessError("denied", "task grant denied");
      identity.authorize({ ...chain, operation: capability, capability, sourceSpaceId: source.id });
    }
    const grant = identity.getGrant(binding.grantId);
    if (!grant) throw new ArtifactsRealmAccessError("denied", "grant missing");
    return { expiresAt: new Date(Math.min(Date.parse(session.expiresAt), Date.parse(grant.expiresAt))).toISOString() };
 }
