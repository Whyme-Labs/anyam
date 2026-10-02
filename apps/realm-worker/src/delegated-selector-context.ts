import type { AuthorityPlaneSnapshot, AuthoritySession } from "../../../src/cloudflare/authority-plane.ts";
import { RealmIdentityPolicy, type Capability, type RealmCapabilityGrant } from "../../../src/identity/realm.ts";
import type { ResourceRef } from "../../../src/kernel/contracts.ts";
import { AuthorityDisclosure } from "./authority-disclosure.ts";
import { disclosedCommandError, type PreparedViewCommand } from "./authority-view-command.ts";

const resourceKeys = ["realmId", "organizationId", "projectId", "sourceSpaceId", "workspaceId", "changeId", "pullRequestId", "runId", "releaseId", "targetId"] as const;
const string = (value: unknown): string => { if (typeof value !== "string" || !value.trim()) disclosedCommandError(); return value as string; };
/** Validate the native delegation; request scope can narrow it, never widen it. */
export function delegatedSelectorContext(identity: RealmIdentityPolicy, snapshot: AuthorityPlaneSnapshot, body: Record<string, unknown>) {
  if (body.surface !== "mcp") disclosedCommandError();
  const live = identity.validateSession(string(body.sessionId));
  const state = identity.getRecoverySnapshot();
  const actor = state.actors[live.actorId]; const agent = actor?.agentId && state.agents[actor.agentId];
  if (!actor || actor.kind !== "agent" || !agent || agent.id !== body.agentId || agent.status !== "active" || !agent.allowedCredentialClasses.includes("mcp")) disclosedCommandError();
  const taskId = string(body.taskId); const capabilityGrantId = string(body.capabilityGrantId);
  const task = state.tasks[taskId]; const grant = state.grants[capabilityGrantId];
  if (!task || !grant || grant.agentId !== agent.id || !grant.parentGrantId || grant.delegatedBySessionId !== live.delegatedBySessionId || (body.delegatedBySessionId !== undefined && body.delegatedBySessionId !== grant.delegatedBySessionId)) disclosedCommandError();
  if (grant.taskId !== taskId || grant.principalId !== live.principalId
    || grant.actorId !== live.actorId || grant.clientId !== live.clientId
    || grant.sessionId !== live.id || task.principalId !== live.principalId
    || task.actorId !== live.actorId || task.sessionId !== live.id) disclosedCommandError();
  const parents: RealmCapabilityGrant[] = []; const seen = new Set<string>(); let next = grant;
  while (next) {
    if (seen.has(next.id)) disclosedCommandError(); seen.add(next.id);
    const nativeTask = state.tasks[next.taskId];
    if (!nativeTask || nativeTask.status !== "active" || next.principalId !== live.principalId || nativeTask.principalId !== next.principalId || nativeTask.actorId !== next.actorId || nativeTask.sessionId !== next.sessionId) disclosedCommandError();
    identity.validateSession(next.sessionId);
    parents.push(next);
    if (!next.parentGrantId) break;
    const parent = state.grants[next.parentGrantId];
    if (!parent || (next.delegatedBySessionId && next.delegatedBySessionId !== parent.sessionId) || (next.delegatedByActorId && next.delegatedByActorId !== parent.actorId)) disclosedCommandError();
    next = parent;
  }
  const value = body.resource;
  if (!value || typeof value !== "object" || Array.isArray(value)) disclosedCommandError();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !(resourceKeys as readonly string[]).includes(key))) disclosedCommandError();
  const envelope = Object.fromEntries(Object.entries(raw).map(([key, entry]) => [key, string(entry)])) as ResourceRef;
  if (envelope.realmId !== snapshot.realmId || !envelope.projectId) disclosedCommandError();
  if (!Array.isArray(body.sourceSpaceIds) || !body.sourceSpaceIds.length) disclosedCommandError();
  const sourceSpaceIds = (body.sourceSpaceIds as unknown[]).map(string);
  if (new Set(sourceSpaceIds).size !== sourceSpaceIds.length) disclosedCommandError();
  const session: AuthoritySession = { realmId: live.realmId, principalId: live.principalId, actorId: live.actorId, clientId: live.clientId, sessionId: live.id, taskId, capabilityGrantId, authorizationEpoch: identity.realm.authorizationEpoch, kind: "agent", modelProvider: agent.modelProvider, ...(grant.delegatedBySessionId ? { delegatedBySessionId: grant.delegatedBySessionId } : {}) };
  const binding = { agentId: agent.id, actorId: live.actorId, clientId: live.clientId, sessionId: live.id, taskId, capabilityGrantId };
  const validate = (resource: ResourceRef, ids: readonly string[], capability: Capability, effects: readonly string[] = []) => {
    for (const parent of parents) {
      const parentTask = state.tasks[parent.taskId]!;
      const parentClient = state.clients[parent.clientId];
      if (!parent.allowedCredentialClasses.includes("mcp") || !parentClient || parentClient.status !== "active" || parentClient.realmId !== live.realmId || !parentClient.allowedAudiences.includes("mcp") || parent.deniedActions.includes(capability) || (parent.allowedModelProviders.length && !parent.allowedModelProviders.includes(agent.modelProvider)) || (parentTask.workspaceId && parentTask.workspaceId !== resource.workspaceId) || (parentTask.changeId && parentTask.changeId !== resource.changeId)) disclosedCommandError();
      const result = identity.validateTaskGrant({ principalId: parent.principalId, actorId: parent.actorId, clientId: parent.clientId, sessionId: parent.sessionId, taskId: parent.taskId, grantId: parent.id, resource, sourceSpaceIds: ids, action: capability, effects });
      if (!result.valid) disclosedCommandError();
    }
  };
  validate(envelope, sourceSpaceIds, "source.read");
  const evaluation = (resource: ResourceRef, sourceSpaceId: string, capability: Capability, effect?: string, operation = "source.read") => ({ operation, capability, principalId: live.principalId, actorId: live.actorId, clientId: live.clientId, sessionId: live.id, taskId, grantId: capabilityGrantId, resource, sourceSpaceId, modelProvider: agent.modelProvider, requiredCredentialClass: "mcp" as const, protected: true, ...(effect ? { effect } : {}) });
  const inEnvelope = (resource: ResourceRef, partial: boolean) => resourceKeys.every(key => envelope[key] === undefined || (partial && resource[key] === undefined) || resource[key] === envelope[key]);
  // One synchronous projection uses one current identity snapshot. Never reuse
  // these observations across requests or after the RepositoryDriver await.
  const readable = new Map<string, boolean>();
  const disclosure = new AuthorityDisclosure(snapshot, {
    realmOwner: () => false,
    capabilities: resource => {
      if (!inEnvelope(resource, true)) return [];
      const capabilities = identity.activeCapabilitiesForPrincipal({ principalId: live.principalId, resource }).filter(capability => !parents.some(parent => parent.deniedActions.includes(capability)));
      return capabilities.includes("source.read") ? capabilities : [];
    },
    sourceReadable: (projectId, sourceSpaceId, capability = "source.read") => {
      if (projectId !== envelope.projectId || !sourceSpaceIds.includes(sourceSpaceId)) return false;
      if (parents.some(parent => parent.deniedActions.includes(capability))) return false;
      const key = JSON.stringify([projectId, sourceSpaceId, capability]);
      const cached = readable.get(key); if (cached !== undefined) return cached;
      const policy = state.sourceSpacePolicies[sourceSpaceId]; const source = snapshot.sourceSpaces[sourceSpaceId];
      if (!policy || !source || policy.classification !== source.classification || policy.deniedCapabilities.includes(capability) || !identity.activeCapabilitiesForPrincipal({ principalId: live.principalId, resource: { ...envelope, sourceSpaceId } }).includes(capability)) return false;
      validate({ ...envelope, sourceSpaceId }, [sourceSpaceId], "source.read");
      const allowed = identity.evaluateReadOnly(evaluation({ ...envelope, sourceSpaceId }, sourceSpaceId, "source.read")).allowed;
      readable.set(key, allowed);
      return allowed;
    },
  });
  const authorize = (prepared: PreparedViewCommand) => {
    const target = { ...prepared.resource, ...(prepared.sourceSpaceIds.length === 1 ? { sourceSpaceId: prepared.sourceSpaceIds[0]! } : {}) };
    if (!inEnvelope(target, false) || prepared.sourceSpaceIds.some(id => !sourceSpaceIds.includes(id)) || (task.workspaceId && task.workspaceId !== prepared.resource.workspaceId) || (task.changeId && task.changeId !== prepared.resource.changeId)) disclosedCommandError();
    const effects = prepared.command.command === "revision.publish" ? prepared.command.payload.declaredEffects ?? [] : [];
    if (!Array.isArray(effects) || effects.some(effect => typeof effect !== "string" || !effect.trim())) disclosedCommandError("invalid_request");
    for (const sourceSpaceId of prepared.sourceSpaceIds) {
      const resource = { ...prepared.resource, sourceSpaceId };
      for (const capability of ["source.read", prepared.capability] as const) {
        validate(resource, [sourceSpaceId], capability, capability === prepared.capability ? effects as string[] : []);
        identity.authorize(evaluation(resource, sourceSpaceId, capability, undefined, prepared.command.command));
        if (capability === prepared.capability) for (const effect of effects as string[]) identity.authorize(evaluation(resource, sourceSpaceId, capability, effect, prepared.command.command));
      }
    }
  };
  return { session, disclosure, binding, authorize };
}
