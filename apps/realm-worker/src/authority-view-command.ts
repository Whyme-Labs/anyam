import { createHash } from "node:crypto";
import { AUTHORITY_COMMAND_PROTOCOL, AUTHORITY_PLANE_PROTOCOL, AuthorityPlaneError, type AuthorityCommand, type AuthorityCommandResult, type AuthorityPlaneSnapshot, type AuthoritySession } from "../../../src/cloudflare/authority-plane.ts";
import { opaqueId, type ResourceRef } from "../../../src/kernel/contracts.ts";
import type { Capability } from "../../../src/identity/realm.ts";
import { AuthorityDisclosure } from "./authority-disclosure.ts";

const capabilities = { "workspace.create": "workspace.write", "change.create": "change.publish_revision", "revision.publish": "change.publish_revision", "run.request": "run.invoke" } as const;
type ViewCommandName = keyof typeof capabilities;
const fields: Record<ViewCommandName, readonly string[]> = {
  "workspace.create": ["projectId", "projectViewRevisionId", "sourceSpaceIds", "mounts", "classification"],
  "change.create": ["projectId", "workspaceId", "baseProjectViewRevisionId", "intentId"],
  "revision.publish": ["projectId", "workspaceId", "changeId", "baseProjectViewRevisionId", "sourceSpaceSnapshots", "declaredEffects", "kind", "expectedSymbolicRef"],
  "run.request": ["projectId", "workspaceId", "changeRevisionId", "projectViewRevisionId", "actionId", "actionContractDigest", "verifierId", "verifierContractDigest", "inputDigests", "effectDigests", "dependencyDigest", "toolchainDigest", "environmentDigest"],
};
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)]));
  return value;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export function disclosedCommandFailure(code: "not_found" | "invalid_request" | "conflict" = "not_found") {
  return new AuthorityPlaneError({ code, message: code === "not_found" ? "The requested resource is unavailable." : code === "conflict" ? "The disclosed command conflicts with its current visible context." : "Use the documented disclosed command fields.", recoveryAction: code === "conflict" ? "refresh the disclosed Project or Workspace; retry an accepted command with its original payload" : "use a currently disclosed resource and the documented command fields", receipt: "viewCommand=not-accepted; details=not-disclosed; canonicalWrite=false" });
}
export function disclosedCommandError(code: "not_found" | "invalid_request" | "conflict" = "not_found"): never { throw disclosedCommandFailure(code); }
function string(value: unknown): string { if (typeof value !== "string" || !value.trim()) disclosedCommandError("invalid_request"); return value.trim(); }
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) disclosedCommandError("invalid_request");
  const ids = value.map(string); if (new Set(ids).size !== ids.length) disclosedCommandError("invalid_request"); return ids;
}
export type PreparedViewCommand = {
  command: AuthorityCommand;
  capability: Capability;
  resource: ResourceRef;
  sourceSpaceIds: readonly string[];
  replay: boolean;
  requestConflict: boolean;
};

/** Resolves selectors only. Authority comes from the current kernel Task/Grant,
 * never from the selector, stored request, or previously accepted result. */
export function prepareDisclosedCommand(input: {
  snapshot: AuthorityPlaneSnapshot;
  disclosure: AuthorityDisclosure;
  body: Record<string, unknown>;
  session: AuthoritySession;
  actorPrincipal: (actorId: string) => string | undefined;
  allocateId?: (kind: string) => string;
}): PreparedViewCommand {
  const { snapshot: state, disclosure: d, body, session } = input;
  if (Object.keys(body).some(key => !["command", "payload", "idempotencyKey", "protocol", "sessionId"].includes(key)) || (body.protocol !== undefined && body.protocol !== AUTHORITY_COMMAND_PROTOCOL)) disclosedCommandError("invalid_request");
  const name = string(body.command);
  if (!Object.hasOwn(capabilities, name)) disclosedCommandError("invalid_request");
  const commandName = name as ViewCommandName;
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) disclosedCommandError("invalid_request");
  const requested = body.payload as Record<string, unknown>;
  if (Object.keys(requested).some(key => !fields[commandName].includes(key))) disclosedCommandError("invalid_request");
  const requestedProjectId = string(requested.projectId); const disclosedProject = d.project(requestedProjectId);
  if (!disclosedProject) disclosedCommandError();
  let requestedScope: readonly string[];
  if (commandName === "workspace.create") {
    requestedScope = requested.sourceSpaceIds === undefined ? disclosedProject.project.sourceSpaceIds : strings(requested.sourceSpaceIds);
    if (!requestedScope.length || requestedScope.some(id => !disclosedProject.project.sourceSpaceIds.includes(id))) disclosedCommandError();
  } else {
    const w = state.workspaces[string(requested.workspaceId)];
    if (!w || w.projectId !== requestedProjectId || !d.workspace(w.id)) disclosedCommandError();
    requestedScope = state.projectViews[w.projectViewId]!.visibleSourceSpaceIds;
  }
  const requestDigest = digest({ command: commandName, payload: requested });
  const selector = string(commandName === "change.create" || commandName === "revision.publish" ? requested.baseProjectViewRevisionId : requested.projectViewRevisionId);
  const key = `view-command:${digest({ principalId: session.principalId, command: commandName, projectId: requestedProjectId, workspaceId: requested.workspaceId, sourceSpaceIds: [...requestedScope].sort(), selector, key: string(body.idempotencyKey) })}`;
  const saved = state.idempotency[key];
  let command: AuthorityCommand; let requestConflict = false; const allocateId = input.allocateId ?? opaqueId;
  if (saved) {
    let parsed: unknown; try { parsed = JSON.parse(saved.fingerprint); } catch { disclosedCommandError(); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) disclosedCommandError();
    command = parsed as AuthorityCommand;
    const marker = command.payload?.disclosedCommand;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) disclosedCommandError();
    const binding = marker as Record<string, unknown>;
    if (binding.principalId !== session.principalId || input.actorPrincipal(string(binding.actorId)) !== session.principalId || command.command !== commandName || command.protocol !== AUTHORITY_COMMAND_PROTOCOL || command.idempotencyKey !== key) disclosedCommandError();
    requestConflict = binding.requestDigest !== requestDigest;
  } else command = { protocol: AUTHORITY_COMMAND_PROTOCOL, command: commandName, idempotencyKey: key, payload: { ...requested, disclosedCommand: { principalId: session.principalId, actorId: session.actorId, requestDigest } } };

  const p = command.payload;
  const projectId = string(p.projectId);
  if (!d.project(projectId)) disclosedCommandError();
  let ids: readonly string[]; let resource: ResourceRef = { realmId: state.realmId, projectId };
  if (commandName === "workspace.create") {
    if (saved) {
      const w = state.workspaces[string(p.workspaceId)];
      if (!w || !d.workspace(w.id) || w.projectId !== projectId || w.projectRevisionId !== p.projectRevisionId || w.actorId !== (p.disclosedCommand as Record<string, unknown>).actorId) disclosedCommandError();
      ids = state.projectViews[w.projectViewId]!.visibleSourceSpaceIds;
      if (!equal([...ids].sort(), strings(p.sourceSpaceIds).sort())) disclosedCommandError();
      resource = { ...resource, workspaceId: w.id, ...(w.changeId ? { changeId: w.changeId } : {}) };
    } else {
      const project = d.project(projectId)!;
      if (string(p.projectViewRevisionId) !== project.projectViewRevision.id) disclosedCommandError("conflict");
      ids = p.sourceSpaceIds === undefined ? project.project.sourceSpaceIds : strings(p.sourceSpaceIds);
      if (!ids.length || ids.some(id => !project.project.sourceSpaceIds.includes(id))) disclosedCommandError();
      p.projectRevisionId = state.canonicalByProject[projectId];
      p.sourceSpaceIds = [...ids]; p.workspaceId = allocateId("workspace");
      resource = { ...resource, workspaceId: string(p.workspaceId) };
    }
  } else if (commandName === "change.create" || commandName === "revision.publish") {
    const workspaceId = string(p.workspaceId); const w = state.workspaces[workspaceId]; const disclosedWorkspace = d.workspace(workspaceId);
    if (!w || !disclosedWorkspace || w.projectId !== projectId) disclosedCommandError();
    ids = state.projectViews[w.projectViewId]!.visibleSourceSpaceIds;
    if (!saved && string(p.baseProjectViewRevisionId) !== disclosedWorkspace.workspace.projectViewRevisionId) disclosedCommandError("conflict");
    resource = { ...resource, workspaceId };
    if (commandName === "change.create") {
      if (saved) {
        const c = state.changes[string(p.changeId)];
        if (!c || !d.change(c.id) || c.workspaceId !== workspaceId || c.projectId !== projectId || c.baseProjectRevisionId !== p.baseProjectRevisionId || c.author?.actorId !== (p.disclosedCommand as Record<string, unknown>).actorId) disclosedCommandError();
      } else {
        if (w.changeId || w.state !== "active") disclosedCommandError("conflict");
        if (p.intentId !== undefined && !d.intent(string(p.intentId))) disclosedCommandError();
        p.changeId = allocateId("change"); p.baseProjectRevisionId = w.projectRevisionId;
      }
    } else {
      const c = state.changes[string(p.changeId)];
      if (!c || !d.change(c.id) || c.projectId !== projectId || c.workspaceId !== workspaceId || w.changeId !== c.id) disclosedCommandError();
      if (saved) {
        const r = state.changeRevisions[string(p.revisionId)];
        if (!r || r.changeId !== c.id || r.workspaceId !== workspaceId || r.projectViewId !== p.projectViewId || r.projectRevisionId !== p.projectRevisionId || !equal(r.sourceSpaceSnapshots, p.sourceSpaceSnapshots) || r.author?.actorId !== (p.disclosedCommand as Record<string, unknown>).actorId) disclosedCommandError();
      } else {
        if (!p.sourceSpaceSnapshots || typeof p.sourceSpaceSnapshots !== "object" || Array.isArray(p.sourceSpaceSnapshots)) disclosedCommandError("invalid_request");
        const snapshots = p.sourceSpaceSnapshots as Record<string, unknown>;
        if (!equal(Object.keys(snapshots).sort(), [...ids].sort())) disclosedCommandError();
        Object.values(snapshots).forEach(string);
        p.projectViewId = w.projectViewId; p.projectRevisionId = allocateId("candidate-revision"); p.revisionId = allocateId("change-revision");
      }
    }
    resource = { ...resource, changeId: string(p.changeId) };
  } else {
    const revisionId = string(p.changeRevisionId); const r = state.changeRevisions[revisionId]; const c = r && state.changes[r.changeId];
    const disclosedChange = c && d.change(c.id); const disclosedRevision = disclosedChange?.revisions.find(revision => revision.id === revisionId);
    const workspaceId = string(p.workspaceId); const w = state.workspaces[workspaceId];
    if (!r || !c || !w || !disclosedRevision || !d.workspace(workspaceId) || c.projectId !== projectId || c.workspaceId !== workspaceId || r.workspaceId !== workspaceId || r.projectViewId !== w.projectViewId) disclosedCommandError();
    ids = state.projectViews[w.projectViewId]!.visibleSourceSpaceIds;
    if (saved) {
      const run = state.runs[string(p.runId)];
      if (!run || !d.run(run.id) || run.actor?.actorId !== (p.disclosedCommand as Record<string, unknown>).actorId || run.workspaceId !== workspaceId || run.changeRevisionId !== revisionId || run.projectRevisionId !== p.projectRevisionId || run.projectViewId !== p.projectViewId) disclosedCommandError();
    } else {
      if (w.state !== "active" || string(p.projectViewRevisionId) !== disclosedRevision.projectViewRevisionId) disclosedCommandError("conflict");
      p.projectRevisionId = r.projectRevisionId; p.projectViewId = r.projectViewId; p.runId = allocateId("run");
    }
    resource = { ...resource, workspaceId, changeId: c.id, runId: string(p.runId) };
  }
  return { command, capability: capabilities[commandName], resource, sourceSpaceIds: [...ids], replay: !!saved, requestConflict };
}

export function disclosedCommandResult(d: AuthorityDisclosure, prepared: PreparedViewCommand, result: AuthorityCommandResult) {
  const p = prepared.command.payload;
  let value: unknown;
  if (result.status !== "succeeded") disclosedCommandError("conflict");
  switch (prepared.command.command) {
    case "workspace.create": value = d.workspace(string(p.workspaceId)); break;
    case "change.create": value = d.change(string(p.changeId)); break;
    case "revision.publish": {
      const change = d.change(string(p.changeId)); const revision = change?.revisions.find(r => r.id === p.revisionId);
      if (change && revision) value = { change: change.change, revision }; break;
    }
    case "run.request": { const run = d.run(string(p.runId)); if (run) value = { run }; break; }
  }
  if (!value) disclosedCommandError();
  return { protocol: AUTHORITY_PLANE_PROTOCOL, command: prepared.command.command, status: "succeeded", value, credentialFree: true, canonicalWrite: false, receipt: "authority=coordinator; operation=view-command; projection=current; canonicalWrite=false" };
}
