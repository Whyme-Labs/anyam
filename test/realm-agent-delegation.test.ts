import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_AUDIENCES,
  RealmIdentityError,
  RealmIdentityPolicy,
  type CredentialClass,
} from "../src/identity/realm.ts";

const allCredentialClasses: readonly CredentialClass[] = [
  "realm-api",
  "git",
  "mcp",
  "runner",
  "integration",
  "deployment",
  "promotion",
];

function createRealm(realmId: string) {
  let current = new Date("2026-08-03T00:00:00.000Z");
  const realm = new RealmIdentityPolicy({
    realmId,
    name: `Test ${realmId}`,
    relyingPartyId: `${realmId}.test`,
    sessionLifetimeMs: 60 * 60 * 1000,
    credentialLifetimeMs: 10 * 60 * 1000,
    now: () => current,
  });
  const principal = realm.createPrincipal({ id: `${realmId}:principal`, displayName: "Wei" });
  realm.registerPasskey({ principalId: principal.id, credentialId: `${realmId}:passkey` });
  const session = realm.authenticatePasskey({ credentialId: `${realmId}:passkey`, challenge: "challenge", verified: true, clientId: "client:anyam-cli" });
  realm.registerClient({ id: `${realmId}:broker`, kind: "integration", allowedAudiences: allCredentialClasses });
  const brokerSession = realm.authenticatePasskey({ credentialId: `${realmId}:passkey`, challenge: "broker", verified: true, clientId: `${realmId}:broker` });
  realm.addRelationship({
    principalId: principal.id,
    kind: "organization-member",
    subjectId: principal.id,
    role: "maintainer",
    resource: { realmId: realm.realm.id, projectId: "project:video-player" },
  });
  realm.setSourceSpacePolicy({
    sourceSpaceId: "public-player",
    classification: "public",
    allowedCapabilities: ["project.inspect", "source.read", "workspace.write", "change.publish_revision", "run.invoke"],
    readerPrincipalIds: [principal.id],
    allowedModelProviders: ["openai"],
  });
  return {
    realm,
    principal,
    session,
    brokerSession,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function createHumanParent(realm: RealmIdentityPolicy, session: ReturnType<typeof createRealm>["brokerSession"]) {
  const task = realm.createTask({
    principalId: session.principalId,
    actorId: session.actorId,
    sessionId: session.id,
    purpose: "delegate a bounded implementation task",
    workspaceId: "workspace:human",
    changeId: "change:video-player",
    modelProvider: "openai",
  });
  const grant = realm.createCapabilityGrant({
    principalId: session.principalId,
    actorId: session.actorId,
    clientId: session.clientId,
    sessionId: session.id,
    taskId: task.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player" },
    sourceSpaceIds: ["public-player"],
    actions: ["project.inspect", "source.read", "workspace.write", "change.publish_revision", "run.invoke", "agent.delegate"],
    effects: ["source.read", "workspace.write", "run.invoke"],
    allowedModelProviders: ["openai"],
    allowedCredentialClasses: allCredentialClasses,
    budget: { modelCostUsd: 5 },
  });
  return { task, grant };
}

function delegationInput(realm: RealmIdentityPolicy, parentGrantId: string, agentId: string) {
  return {
    humanSessionId: realm.snapshot().sessions[Object.values(realm.snapshot().sessions).find((candidate) => candidate.clientId.endsWith(":broker"))!.id]!.id,
    parentGrantId,
    agentId,
    purpose: "add the resumable playback control",
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player", workspaceId: "workspace:agent", changeId: "change:agent" },
    sourceSpaceIds: ["public-player"],
    actions: ["project.inspect", "source.read", "workspace.write", "change.publish_revision", "run.invoke"] as const,
    effects: ["source.read", "workspace.write", "run.invoke"],
    allowedCredentialClasses: ["git", "mcp"] as const,
    budget: { modelCostUsd: 2 },
  };
}

test("registers a Realm-owned agent and narrows human authority into a task grant", () => {
  const { realm, brokerSession } = createRealm("realm:agent");
  const { grant: parentGrant } = createHumanParent(realm, brokerSession);
  const agent = realm.registerAgent({ principalId: brokerSession.principalId, id: "agent:codex", name: "Codex", runtime: "codex-cli", modelProvider: "openai", allowedCredentialClasses: ["realm-api", "git", "mcp"] });

  const delegated = realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, agent.id), humanSessionId: brokerSession.id });
  assert.equal(delegated.protocol, "anyam.delegation/v1");
  assert.equal(delegated.agent.id, agent.id);
  assert.equal(delegated.actor.kind, "agent");
  assert.equal(delegated.actor.status, "active");
  assert.equal(delegated.actor.agentId, agent.id);
  assert.equal(delegated.actor.delegatedByActorId, brokerSession.actorId);
  assert.equal(delegated.session.actorKind, "agent");
  assert.equal(delegated.session.delegatedBySessionId, brokerSession.id);
  assert.equal(delegated.task.agentId, agent.id);
  assert.equal(delegated.task.modelProvider, "openai");
  assert.equal(delegated.grant.parentGrantId, parentGrant.id);
  assert.deepEqual(delegated.grant.allowedCredentialClasses, ["git", "mcp"]);
  assert.deepEqual(delegated.grant.allowedModelProviders, ["openai"]);
  assert.equal(delegated.receipt.includes("canonicalWrite=false"), true);
  assert.equal(Object.values(realm.snapshot().credentials).some((credential) => "token" in credential), false);

  const directAgentTask = realm.createTask({ principalId: delegated.session.principalId, actorId: delegated.actor.actorId, sessionId: delegated.session.id, purpose: "attempt direct agent authority", modelProvider: "openai" });
  assert.throws(() => realm.createCapabilityGrant({ principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: directAgentTask.id, resource: delegated.grant.resource, sourceSpaceIds: ["public-player"], actions: ["source.read"] }), (error: unknown) => error instanceof RealmIdentityError && error.code === "grant.agent_parent_required");
});

test("rejects agent scope widening and issues only task-scoped Git and MCP credentials", () => {
  const { realm, brokerSession } = createRealm("realm:scope");
  const { grant: parentGrant } = createHumanParent(realm, brokerSession);
  const agent = realm.registerAgent({ principalId: brokerSession.principalId, id: "agent:claude", name: "Claude", runtime: "claude-code", modelProvider: "anthropic", allowedCredentialClasses: ["git", "mcp"] });

  assert.throws(() => realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, agent.id), humanSessionId: brokerSession.id }), (error: unknown) => error instanceof RealmIdentityError && error.code === "delegation.model_denied");
  assert.throws(() => realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, agent.id), humanSessionId: brokerSession.id, actions: ["source.read", "target.promote"] as const }), (error: unknown) => error instanceof RealmIdentityError && error.code === "delegation.action_widening");

  const openaiAgent = realm.registerAgent({ principalId: brokerSession.principalId, id: "agent:codex", name: "Codex", runtime: "codex-cli", modelProvider: "openai", allowedCredentialClasses: ["git", "mcp"] });
  const delegated = realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, openaiAgent.id), humanSessionId: brokerSession.id });
  const resource = delegated.grant.resource;
  const git = realm.issueCredential({ class: "git", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource });
  const mcp = realm.issueCredential({ class: "mcp", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource });
  assert.equal(realm.validateCredential(git.token, { class: "git", audience: CREDENTIAL_AUDIENCES.git }).valid, true);
  assert.equal(realm.validateCredential(mcp.token, { class: "mcp", audience: CREDENTIAL_AUDIENCES.mcp }).valid, true);
  assert.throws(() => realm.issueCredential({ class: "promotion", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource }), (error: unknown) => error instanceof RealmIdentityError && error.code === "credential.audience_denied");
});

test("revokes all delegated authority without revoking the human session", () => {
  const { realm, brokerSession } = createRealm("realm:revoke-agent");
  const { grant: parentGrant } = createHumanParent(realm, brokerSession);
  const agent = realm.registerAgent({ principalId: brokerSession.principalId, id: "agent:codex", name: "Codex", runtime: "codex-cli", modelProvider: "openai", allowedCredentialClasses: ["git", "mcp"] });
  const delegated = realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, agent.id), humanSessionId: brokerSession.id });
  const git = realm.issueCredential({ class: "git", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource: delegated.grant.resource });

  const result = realm.revokeAgent(agent.id);
  assert.deepEqual(result.revokedActorIds, [delegated.actor.actorId]);
  assert.deepEqual(result.revokedSessionIds, [delegated.session.id]);
  assert.equal(realm.getAgent(agent.id)?.status, "revoked");
  assert.equal(realm.getSession(delegated.session.id)?.status, "revoked");
  assert.equal(realm.getGrant(delegated.grant.id)?.status, "revoked");
  assert.equal(realm.validateCredential(git.token).valid, false);
  const denied = realm.evaluate({ operation: "source.read", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource: delegated.grant.resource, sourceSpaceId: "public-player", protected: true });
  assert.equal(denied.allowed, false);
  assert.equal(realm.getSession(brokerSession.id)?.status, "active");
  const freshHumanTask = realm.createTask({ principalId: brokerSession.principalId, actorId: brokerSession.actorId, sessionId: brokerSession.id, purpose: "human remains authorized", modelProvider: "openai" });
  assert.equal(freshHumanTask.status, "active");
});

test("expired delegated Grants reject explicit credential exchange without materializing a credential", () => {
  const { realm, brokerSession, advance } = createRealm("realm:expired-credential");
  const { grant: parentGrant } = createHumanParent(realm, brokerSession);
  const agent = realm.registerAgent({ principalId: brokerSession.principalId, id: "agent:codex", name: "Codex", runtime: "codex-cli", modelProvider: "openai", allowedCredentialClasses: ["git", "mcp"] });
  const delegated = realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, agent.id), humanSessionId: brokerSession.id });

  advance(11 * 60 * 1000);
  assert.throws(() => realm.issueCredential({ class: "git", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource: delegated.grant.resource }), (error: unknown) => error instanceof RealmIdentityError && error.code === "credential.grant_inactive");
  assert.equal(Object.keys(realm.snapshot().credentials).length, 0);
});

test("parent Session revocation cascades to delegated agent Sessions, Tasks, Grants, and credentials", () => {
  const { realm, brokerSession } = createRealm("realm:revoke-parent");
  const { grant: parentGrant } = createHumanParent(realm, brokerSession);
  const agent = realm.registerAgent({ principalId: brokerSession.principalId, id: "agent:codex", name: "Codex", runtime: "codex-cli", modelProvider: "openai", allowedCredentialClasses: ["git"] });
  const delegated = realm.delegateAgent({ ...delegationInput(realm, parentGrant.id, agent.id), humanSessionId: brokerSession.id, allowedCredentialClasses: ["git"] });
  const git = realm.issueCredential({ class: "git", principalId: delegated.session.principalId, actorId: delegated.actor.actorId, clientId: delegated.session.clientId, sessionId: delegated.session.id, taskId: delegated.task.id, grantId: delegated.grant.id, resource: delegated.grant.resource });

  const result = realm.revokeSession(brokerSession.id);
  assert.equal(result.revokedGrantIds.includes(parentGrant.id), true);
  assert.equal(result.revokedGrantIds.includes(delegated.grant.id), true);
  assert.equal(realm.getSession(delegated.session.id)?.status, "revoked");
  assert.equal(realm.snapshot().tasks[delegated.task.id]?.status, "closed");
  assert.equal(realm.validateCredential(git.token).valid, false);
  assert.equal(realm.getAgent(agent.id)?.status, "active");
});

test("does not accept an agent or parent Grant from another Realm", () => {
  const first = createRealm("realm:first");
  const second = createRealm("realm:second");
  const { grant: parentGrant } = createHumanParent(first.realm, first.brokerSession);
  const foreignAgent = second.realm.registerAgent({ principalId: second.brokerSession.principalId, id: "agent:foreign", name: "Foreign", runtime: "codex-cli", modelProvider: "openai", allowedCredentialClasses: ["git"] });
  assert.throws(() => first.realm.delegateAgent({ ...delegationInput(first.realm, parentGrant.id, foreignAgent.id), humanSessionId: first.brokerSession.id }), (error: unknown) => error instanceof RealmIdentityError && error.code === "delegation.agent_invalid");
});
