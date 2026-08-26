import type { AuthorityCommand, AuthorityPlaneSnapshot } from "./authority-plane.ts";
import type { ProjectView, ResourceRef } from "../kernel/contracts.ts";

export type McpCommandTargetAuthorizationInput = {
  readonly snapshot: AuthorityPlaneSnapshot;
  readonly command: AuthorityCommand;
  readonly grantId: string;
  readonly grantResource: ResourceRef;
  readonly grantSourceSpaceIds: readonly string[];
};

export type McpCommandTargetAuthorizationResult =
  | {
      readonly allowed: true;
      readonly command: AuthorityCommand;
      readonly resource: ResourceRef;
      readonly sourceSpaceIds: readonly string[];
      readonly receipt: string;
    }
  | {
      readonly allowed: false;
      readonly code: "invalid_request" | "not_found" | "conflict";
      readonly message: string;
      readonly recoveryAction: string;
      readonly receipt: string;
    };

function failure(code: Extract<McpCommandTargetAuthorizationResult, { allowed: false }>["code"], reason: string, recoveryAction: string): McpCommandTargetAuthorizationResult {
  return {
    allowed: false,
    code,
    message: "The MCP command target is not authorized by its delegated Task and Capability Grant.",
    recoveryAction,
    receipt: `authority=mcp; target=not-authorized; reason=${reason}; canonicalWrite=false; transition=not-applied`,
  };
}

function stringField(payload: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringListField(payload: Readonly<Record<string, unknown>>, field: string): string[] | undefined {
  const value = payload[field];
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return undefined;
    result.push(entry);
  }
  return result;
}

function snapshotKeys(payload: Readonly<Record<string, unknown>>): string[] | undefined {
  const value = payload.sourceSpaceSnapshots;
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.keys(value);
}

function includesAll(allowed: readonly string[], requested: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return requested.every((value) => allowedSet.has(value));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && includesAll(left, right) && includesAll(right, left);
}

function projectViewFor(snapshot: AuthorityPlaneSnapshot, payload: Readonly<Record<string, unknown>>, workspaceViewId: string | undefined): ProjectView | undefined {
  const projectViewId = stringField(payload, "projectViewId") ?? workspaceViewId;
  return projectViewId ? snapshot.projectViews[projectViewId] : undefined;
}

/**
 * Bind one parsed MCP mutation to the exact resources in its live grant.
 * This is deliberately pure: it cannot mint authority or mutate the
 * Authority snapshot. The caller executes only the returned sanitized command.
 */
export function authorizeMcpCommandTarget(input: McpCommandTargetAuthorizationInput): McpCommandTargetAuthorizationResult {
  const { snapshot, command, grantId, grantResource, grantSourceSpaceIds } = input;
  const payload = command.payload;
  if (command.command === "project.create") return failure("invalid_request", "project-create-agent-unsupported", "create the Project through the authenticated owner boundary before delegating an Agent Task");

  let projectId = stringField(payload, "projectId");
  let workspaceId = stringField(payload, "workspaceId");
  let changeId = stringField(payload, "changeId");
  const pullRequestId = stringField(payload, "pullRequestId");
  const runId = stringField(payload, "runId");
  const intentId = stringField(payload, "intentId");
  const changeRevisionId = stringField(payload, "changeRevisionId");
  let sourceSpaceIds = snapshotKeys(payload) ?? stringListField(payload, "sourceSpaceIds") ?? [];
  const explicitSourceSpaceId = stringField(payload, "sourceSpaceId");
  if (explicitSourceSpaceId) sourceSpaceIds = [...new Set([...sourceSpaceIds, explicitSourceSpaceId])];
  if (payload.capabilityGrantId !== undefined && payload.capabilityGrantId !== grantId) return failure("conflict", "grant-id-mismatch", "use the live Capability Grant identity supplied by the MCP session");

  const pullRequest = pullRequestId ? snapshot.pullRequests[pullRequestId] : undefined;
  if (pullRequestId && !pullRequest && command.command !== "pullRequest.open") return failure("not_found", "pull-request-not-found", "verify the Pull Request identifier without probing undiscoverable resources");
  if (pullRequest) {
    if (projectId && projectId !== pullRequest.projectId) return failure("not_found", "pull-request-project-mismatch", "use the Pull Request's authoritative Project target");
    projectId = pullRequest.projectId;
    if (!changeId) changeId = pullRequest.changeId;
    if (pullRequest.sourceSpaceId && sourceSpaceIds.length === 0) sourceSpaceIds = [pullRequest.sourceSpaceId];
  }

  const changeRevision = changeRevisionId ? snapshot.changeRevisions[changeRevisionId] : undefined;
  if (changeRevisionId && !changeRevision) return failure("not_found", "change-revision-not-found", "use a Change Revision returned by the current Authority");
  if (changeRevision && !changeId) changeId = changeRevision.changeId;

  const change = changeId ? snapshot.changes[changeId] : undefined;
  if (changeId && !change) return failure("not_found", "change-not-found", "use a Change returned by the current Authority");
  if (change) {
    if (projectId && projectId !== change.projectId) return failure("not_found", "change-project-mismatch", "use the Change's authoritative Project target");
    projectId = change.projectId;
    if (!workspaceId && change.workspaceId) workspaceId = change.workspaceId;
  }

  const intent = intentId ? snapshot.intents[intentId] : undefined;
  if (intentId && !intent && command.command !== "intent.create") return failure("not_found", "intent-not-found", "use an Intent returned by the current Authority");
  if (intent) {
    if (projectId && projectId !== intent.projectId) return failure("not_found", "intent-project-mismatch", "use the Intent's authoritative Project target");
    projectId = intent.projectId;
  }

  const run = runId ? snapshot.runs[runId] : undefined;
  if (runId && !run) return failure("not_found", "run-not-found", "use a Run returned by the current Authority");
  if (run && !projectId) {
    const runRevision = snapshot.projectRevisions[run.projectRevisionId];
    if (runRevision) projectId = runRevision.projectId;
  }

  const workspace = workspaceId ? snapshot.workspaces[workspaceId] : undefined;
  if (workspaceId && !workspace) return failure("not_found", "workspace-not-found", "use a Workspace returned by the current Authority");
  if (workspace) {
    if (projectId && projectId !== workspace.projectId) return failure("not_found", "workspace-project-mismatch", "use the Workspace's authoritative Project target");
    projectId = workspace.projectId;
    if (workspace.changeId && changeId && workspace.changeId !== changeId) return failure("not_found", "workspace-change-mismatch", "use the Workspace assigned to the delegated Change");
    if (!changeId && workspace.changeId) changeId = workspace.changeId;
    if (sourceSpaceIds.length === 0) sourceSpaceIds = workspace.mounts.map((mount) => mount.sourceSpaceId);
  }

  if (grantResource.projectId && projectId && grantResource.projectId !== projectId) return failure("not_found", "project-target-mismatch", "use only the Project bound to the delegated Agent Task");
  if (grantResource.workspaceId && workspaceId && grantResource.workspaceId !== workspaceId) return failure("not_found", "workspace-target-mismatch", "use only the Workspace bound to the delegated Agent Task");
  if (grantResource.changeId && changeId && grantResource.changeId !== changeId) return failure("not_found", "change-target-mismatch", "use only the Change bound to the delegated Agent Task");
  if (grantResource.pullRequestId && pullRequestId && grantResource.pullRequestId !== pullRequestId) return failure("not_found", "pull-request-target-mismatch", "use only the Pull Request bound to the delegated Agent Task");
  if (grantResource.runId && runId && grantResource.runId !== runId) return failure("not_found", "run-target-mismatch", "use only the Run bound to the delegated Agent Task");
  if (!projectId) return failure("invalid_request", "project-target-missing", "send a Project-bound MCP mutation target");
  const project = snapshot.projects[projectId];
  if (!project) return failure("not_found", "project-not-found", "use a Project returned by the current Authority");

  const view = projectViewFor(snapshot, payload, workspace?.projectViewId);
  if ((stringField(payload, "projectViewId") || workspace?.projectViewId) && !view) return failure("not_found", "project-view-not-found", "use the Project View mounted by the delegated Workspace");
  if (view && view.projectId !== project.id) return failure("not_found", "project-view-project-mismatch", "use a Project View belonging to the delegated Project");
  if (view && workspace && workspace.projectViewId !== view.id) return failure("conflict", "workspace-project-view-mismatch", "publish only through the Project View mounted by the delegated Workspace");

  if (command.command === "revision.publish" && view && !sameSet(sourceSpaceIds, view.visibleSourceSpaceIds)) return failure("conflict", "project-view-source-set-mismatch", "publish the complete disclosed Source Space snapshot set for the bound Project View");
  if ((command.command === "run.request" || command.command === "run.record") && view) sourceSpaceIds = [...view.visibleSourceSpaceIds];
  if (view && sourceSpaceIds.length > 0 && !includesAll(view.visibleSourceSpaceIds, sourceSpaceIds)) return failure("not_found", "project-view-source-space-mismatch", "use only Source Spaces disclosed by the bound Project View");

  const effectiveSourceSpaceIds = sourceSpaceIds.length > 0 ? sourceSpaceIds : [...grantSourceSpaceIds];
  if (!includesAll(project.sourceSpaceIds, effectiveSourceSpaceIds)) return failure("not_found", "project-source-space-mismatch", "use only Source Spaces declared by the delegated Project");
  if (!includesAll(grantSourceSpaceIds, effectiveSourceSpaceIds)) return failure("not_found", "source-space-grant-mismatch", "reauthorize the Agent Task with every affected Source Space explicitly disclosed");
  if (grantResource.sourceSpaceId && effectiveSourceSpaceIds.some((sourceSpaceId) => sourceSpaceId !== grantResource.sourceSpaceId)) return failure("not_found", "source-space-resource-mismatch", "use only the Source Space bound to the delegated resource");

  const sanitizedPayload: Record<string, unknown> = { ...payload, projectId };
  if (workspaceId) sanitizedPayload.workspaceId = workspaceId;
  if (changeId) sanitizedPayload.changeId = changeId;
  if (pullRequestId) sanitizedPayload.pullRequestId = pullRequestId;
  if (runId) sanitizedPayload.runId = runId;
  if (payload.capabilityGrantId !== undefined) sanitizedPayload.capabilityGrantId = grantId;
  return {
    allowed: true,
    command: { ...command, payload: sanitizedPayload },
    resource: {
      ...grantResource,
      realmId: snapshot.realmId,
      projectId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(changeId ? { changeId } : {}),
      ...(pullRequestId ? { pullRequestId } : {}),
      ...(runId ? { runId } : {}),
    },
    sourceSpaceIds: effectiveSourceSpaceIds,
    receipt: `authority=mcp; target=authorized; project=${project.id}; sourceSpaces=${effectiveSourceSpaceIds.length}; command=${command.command}; sanitized=true; canonicalWrite=false`,
  };
}
