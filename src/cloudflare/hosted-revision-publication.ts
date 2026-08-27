import { AuthorityPlaneError, type AuthorityCommand, type AuthorityPlaneSnapshot } from "./authority-plane.ts";
import { verifyRepositoryObservation } from "../portability/repository-observation.ts";
import type { RepositoryObservation } from "../kernel/contracts.ts";

export type HostedRevisionObservationInput = {
  readonly repositoryId: string;
  readonly sourceSpaceId: string;
  readonly workspaceId: string;
  readonly projectViewId: string;
  readonly expectedSymbolicRef?: string;
  readonly expectedCommitOid: string;
  readonly expectedBaseCommitOid: string;
};

export type HostedRevisionObserver = (input: HostedRevisionObservationInput) => Promise<RepositoryObservation>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sourceSnapshots(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityPlaneError({ code: "invalid_request", message: "Hosted revision publication requires a Source Space snapshot object.", recoveryAction: "publish one non-empty Git commit object ID for every Source Space disclosed by the Project View", receipt: "repositoryObservation=snapshot-object-required; transition=not-applied" });
  }
  const result: Record<string, string> = {};
  for (const [sourceSpaceId, snapshot] of Object.entries(value)) {
    const normalized = nonEmptyString(snapshot);
    if (!normalized) throw new AuthorityPlaneError({ code: "invalid_request", message: "Hosted revision publication contains an invalid Source Space snapshot.", recoveryAction: "publish one non-empty Git commit object ID for every disclosed Source Space", receipt: "repositoryObservation=snapshot-invalid; transition=not-applied" });
    result[sourceSpaceId] = normalized;
  }
  return result;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

/**
 * Prepare one hosted revision through the trusted RepositoryDriver boundary.
 * Every caller supplies only the current Authority snapshot and a callback
 * bound to the customer-owned observer service; project, view, workspace,
 * Change, Source Space, base, and repository identities come from Authority.
 */
export async function prepareHostedRevisionPublish(input: {
  readonly snapshot: AuthorityPlaneSnapshot;
  readonly command: AuthorityCommand;
  readonly observe: HostedRevisionObserver;
}): Promise<AuthorityCommand> {
  if (input.command.command !== "revision.publish") throw new AuthorityPlaneError({ code: "invalid_request", message: "The hosted revision boundary accepts only revision.publish.", recoveryAction: "send the typed hosted revision publication command", receipt: `command=${input.command.command}; hostedRevisionBoundary=not-accepted` });
  const payload = input.command.payload;
  const projectId = nonEmptyString(payload.projectId);
  const changeId = nonEmptyString(payload.changeId);
  if (!projectId || !changeId) throw new AuthorityPlaneError({ code: "invalid_request", message: "Hosted revision publication requires Project and Change identities.", recoveryAction: "publish through the exact Project and Change bound to the Workspace", receipt: "repositoryObservation=project-change-required; transition=not-applied" });
  const project = input.snapshot.projects[projectId];
  const change = input.snapshot.changes[changeId];
  if (!project || !change || change.projectId !== project.id) throw new AuthorityPlaneError({ code: "not_found", message: "The hosted revision Project and Change are not available as one authoritative pair.", recoveryAction: "use the current Project and Change identities without probing hidden resources", receipt: "repositoryObservation=project-change-mismatch; discoverable=false; transition=not-applied" });

  const workspaceId = nonEmptyString(payload.workspaceId) ?? change.workspaceId;
  const workspace = workspaceId ? input.snapshot.workspaces[workspaceId] : undefined;
  if (!workspaceId || !workspace || workspace.projectId !== project.id || workspace.changeId !== change.id || workspace.state !== "active") throw new AuthorityPlaneError({ code: "conflict", message: "Hosted revision publication requires the active Workspace assigned to the Change.", recoveryAction: "publish from the active Change Workspace in the same Project", receipt: "repositoryObservation=workspace-binding-required; transition=not-applied" });

  const projectViewId = nonEmptyString(payload.projectViewId) ?? workspace.projectViewId;
  const projectView = input.snapshot.projectViews[projectViewId];
  if (!projectView || projectView.projectId !== project.id || projectView.id !== workspace.projectViewId) throw new AuthorityPlaneError({ code: "conflict", message: "Hosted revision publication requires the Project View mounted by the active Workspace.", recoveryAction: "publish with the Project View bound to the assigned Workspace", receipt: "repositoryObservation=project-view-binding-required; transition=not-applied" });
  const baseRevision = input.snapshot.projectRevisions[change.baseProjectRevisionId];
  if (!baseRevision || baseRevision.projectId !== project.id || workspace.projectRevisionId !== change.baseProjectRevisionId || projectView.projectRevisionId !== change.baseProjectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: "Hosted revision publication requires the Workspace and Project View to share the Change base Project Revision.", recoveryAction: "rebase the Change onto a fresh Workspace and Project View derived from its declared base", receipt: `change=${change.id}; changeBase=${change.baseProjectRevisionId}; workspaceBase=${workspace.projectRevisionId}; viewBase=${projectView.projectRevisionId}; repositoryObservation=lineage-mismatch; transition=not-applied` });

  const snapshots = sourceSnapshots(payload.sourceSpaceSnapshots);
  const expectedSymbolicRef = nonEmptyString(payload.expectedSymbolicRef);
  const visibleSourceSpaceIds = [...projectView.visibleSourceSpaceIds];
  if (visibleSourceSpaceIds.length === 0 || !sameSet(Object.keys(snapshots), visibleSourceSpaceIds)) throw new AuthorityPlaneError({ code: "conflict", message: "Hosted revision publication must cover exactly the Source Spaces disclosed by the Project View.", recoveryAction: "publish one candidate snapshot for every Source Space in the exact Project View and no others", receipt: `project=${project.id}; projectView=${projectView.id}; repositoryObservation=source-space-set-mismatch; transition=not-applied` });

  const observations: Record<string, RepositoryObservation> = {};
  for (const sourceSpaceId of visibleSourceSpaceIds) {
    if (!project.sourceSpaceIds.includes(sourceSpaceId)) throw new AuthorityPlaneError({ code: "not_found", message: `Source Space ${sourceSpaceId} is not part of Project ${project.id}.`, recoveryAction: "publish only Source Spaces declared by the Project View", receipt: `project=${project.id}; sourceSpace=${sourceSpaceId}; repositoryObservation=project-source-mismatch; transition=not-applied` });
    const sourceSpace = input.snapshot.sourceSpaces[sourceSpaceId];
    const expectedCommitOid = snapshots[sourceSpaceId];
    const expectedBaseCommitOid = baseRevision.sourceSpaceSnapshots[sourceSpaceId];
    if (!sourceSpace?.repositoryId || !expectedCommitOid || !expectedBaseCommitOid) throw new AuthorityPlaneError({ code: "blocked", message: `Hosted Source Space ${sourceSpaceId} is missing a Repository identity or complete candidate/base snapshot.`, recoveryAction: "bind the Source Space to an authoritative Repository identity and publish the complete candidate/base snapshot set", receipt: `sourceSpace=${sourceSpaceId}; repositoryObservation=inputs-incomplete; transition=not-applied` });
    const observed = await input.observe({ repositoryId: sourceSpace.repositoryId, sourceSpaceId, workspaceId, projectViewId: projectView.id, ...(expectedSymbolicRef ? { expectedSymbolicRef } : {}), expectedCommitOid, expectedBaseCommitOid });
    const verified = await verifyRepositoryObservation({ observation: observed, repositoryId: sourceSpace.repositoryId, sourceSpaceId, workspaceId, projectViewId: projectView.id, ...(expectedSymbolicRef ? { expectedSymbolicRef } : {}), expectedCommitOid, expectedBaseCommitOid });
    if (!verified.valid) throw new AuthorityPlaneError({ code: "conflict", message: verified.message, recoveryAction: verified.recoveryAction, receipt: verified.receipt });
    observations[sourceSpaceId] = verified.observation;
  }

  const verifiedSnapshots = Object.fromEntries(Object.entries(observations).map(([sourceSpaceId, observation]) => [sourceSpaceId, observation.commitOid]));
  return { ...input.command, payload: { ...payload, projectId: project.id, changeId: change.id, workspaceId, projectViewId: projectView.id, sourceSpaceSnapshots: verifiedSnapshots, sourceSpaceObservations: observations } };
}
