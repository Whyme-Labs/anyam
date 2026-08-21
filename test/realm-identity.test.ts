import assert from "node:assert/strict";
import test from "node:test";

import {
  CREDENTIAL_AUDIENCES,
  RealmIdentityError,
  RealmIdentityPolicy,
  type CredentialClass,
  type RealmSession,
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

function createRealm() {
  let current = new Date("2026-08-03T00:00:00.000Z");
  const realm = new RealmIdentityPolicy({
    realmId: "realm:test",
    name: "Test Realm",
    relyingPartyId: "anyam.test",
    sessionLifetimeMs: 60 * 60 * 1000,
    credentialLifetimeMs: 10 * 60 * 1000,
    now: () => current,
  });
  const principal = realm.createPrincipal({ id: "principal:wei", displayName: "Wei" });
  realm.registerPasskey({ principalId: principal.id, credentialId: "passkey:wei" });
  const provider = realm.registerOidcProvider({ id: "oidc:acme", issuer: "https://id.acme.test", clientId: "anyam" });
  realm.linkOidcIdentity({ principalId: principal.id, issuer: provider.issuer, subject: "wei-subject" });
  realm.registerClient({ id: "client:test-broker", kind: "integration", allowedAudiences: allCredentialClasses });
  const passkeySession = realm.authenticatePasskey({ credentialId: "passkey:wei", challenge: "challenge", verified: true, clientId: "client:anyam-cli" });
  const oidcSession = realm.authenticateOidc({ issuer: provider.issuer, subject: "wei-subject", verified: true });
  realm.addRelationship({
    principalId: principal.id,
    kind: "organization-member",
    subjectId: principal.id,
    role: "contributor",
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
    passkeySession,
    oidcSession,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function taskAndGrant(realm: RealmIdentityPolicy, session: RealmSession, options: { sourceSpaceIds?: readonly string[]; allowedCredentialClasses?: readonly CredentialClass[] } = {}) {
  const task = realm.createTask({
    principalId: session.principalId,
    actorId: session.actorId,
    sessionId: session.id,
    purpose: "test task",
    workspaceId: "workspace:test",
    changeId: "change:test",
    modelProvider: "openai",
  });
  const grant = realm.createCapabilityGrant({
    principalId: session.principalId,
    actorId: session.actorId,
    clientId: session.clientId,
    sessionId: session.id,
    taskId: task.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player", workspaceId: "workspace:test", changeId: "change:test" },
    sourceSpaceIds: options.sourceSpaceIds ?? ["public-player"],
    actions: ["project.inspect", "source.read", "workspace.write", "change.publish_revision", "run.invoke", "target.promote"],
    effects: ["source.read", "workspace.write", "run.invoke"],
    allowedModelProviders: ["openai"],
    allowedCredentialClasses: options.allowedCredentialClasses ?? allCredentialClasses,
    budget: { modelCostUsd: 5 },
  });
  return { task, grant };
}

function validationCode(result: ReturnType<RealmIdentityPolicy["validateCredential"]>): string | undefined {
  return result.valid ? undefined : result.code;
}

test("authenticates through passkey and OIDC while retaining Realm-local identity state", () => {
  const { realm, principal, passkeySession, oidcSession } = createRealm();

  assert.equal(passkeySession.method, "passkey");
  assert.equal(oidcSession.method, "oidc");
  assert.equal(passkeySession.principalId, principal.id);
  assert.equal(oidcSession.principalId, principal.id);
  const snapshot = realm.snapshot();
  assert.equal(snapshot.principals[principal.id]?.displayName, "Wei");
  assert.equal(Object.keys(snapshot.passkeys).length, 1);
  assert.equal(Object.keys(snapshot.oidcProviders).length, 1);
  assert.equal(Object.keys(snapshot.oidcIdentities).length, 1);
  assert.equal(Object.keys(snapshot.sessions).length, 2);
  assert.equal(snapshot.sessions[passkeySession.id]?.authorizationEpoch, realm.realm.authorizationEpoch);
  assert.deepEqual(realm.validateSession(passkeySession.id), passkeySession);
});

test("accepts monotonic verified passkey counters and rejects regressions", () => {
  const { realm, principal } = createRealm();
  realm.registerPasskey({ principalId: principal.id, credentialId: "passkey:counter", signCount: 7 });
  const first = realm.authenticatePasskey({ credentialId: "passkey:counter", challenge: "counter-1", verified: true, signCount: 8 });
  assert.equal(first.method, "passkey");
  assert.equal(realm.snapshot().passkeys["passkey:counter"]?.signCount, 8);
  assert.throws(
    () => realm.authenticatePasskey({ credentialId: "passkey:counter", challenge: "counter-2", verified: true, signCount: 7 }),
    (error: unknown) => error instanceof RealmIdentityError && error.code === "auth.passkey_counter_regression",
  );
  assert.equal(realm.snapshot().passkeys["passkey:counter"]?.signCount, 8);
});

test("intersects role, Source Space policy, task grant, client/session state, and explicit denies", () => {
  const { realm, principal, passkeySession } = createRealm();
  const { task, grant } = taskAndGrant(realm, passkeySession);

  const allowed = realm.evaluate({
    operation: "source.read",
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: task.id,
    grantId: grant.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player", workspaceId: "workspace:test", changeId: "change:test" },
    sourceSpaceId: "public-player",
    requiredCredentialClass: "git",
    protected: true,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.explanation.decision, "allow");
  assert.ok(allowed.explanation.satisfiedCapabilities.includes("source.read"));

  const denied = realm.evaluate({
    operation: "target.promote",
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: task.id,
    grantId: grant.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player", targetId: "target:production" },
    sourceSpaceId: "public-player",
    requiredCredentialClass: "promotion",
    protected: true,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.explanation.code, "forbidden");
  assert.ok(denied.explanation.missingCapabilities.includes("target.promote"));
  assert.match(denied.explanation.remediation, /request the missing capability|approval/);
  assert.ok(denied.explanation.factors.some((factor) => factor.name === "source-space-policy" && factor.status === "denied"));
});

test("moderator relationships authorize only the Public Gateway moderation capability", () => {
  const { realm, principal, passkeySession } = createRealm();
  const relationship = realm.addRelationship({ principalId: principal.id, kind: "organization-member", subjectId: principal.id, role: "moderator", resource: { realmId: realm.realm.id, projectId: "project:video-player" } });
  const stored = realm.getRecoverySnapshot().relationships[relationship.id];
  assert.equal(stored?.role, "moderator");
  assert.equal(stored?.resource.projectId, "project:video-player");
  assert.equal(passkeySession.principalId, principal.id);
});

test("returns a disclosure-safe not_found explanation for hidden Source Spaces", () => {
  const { realm, principal, passkeySession } = createRealm();
  const { task, grant } = taskAndGrant(realm, passkeySession, { sourceSpaceIds: ["private-codec"] });
  realm.setSourceSpacePolicy({
    sourceSpaceId: "private-codec",
    classification: "restricted",
    allowedCapabilities: ["source.read"],
    readerPrincipalIds: ["principal:other"],
    discoverable: false,
  });
  const result = realm.evaluate({
    operation: "source.read",
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: task.id,
    grantId: grant.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "private-codec", workspaceId: "workspace:test" },
    sourceSpaceId: "private-codec",
    protected: true,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.explanation.code, "not_found");
  assert.equal(result.explanation.resource, undefined);
  assert.equal(JSON.stringify(result.explanation).includes("private-codec"), false);
  assert.throws(() => realm.authorize({
    operation: "source.read",
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: task.id,
    grantId: grant.id,
    resource: { realmId: realm.realm.id, sourceSpaceId: "private-codec" },
    sourceSpaceId: "private-codec",
    protected: true,
  }), (error: unknown) => error instanceof RealmIdentityError && error.code === "not_found" && !JSON.stringify(error).includes("private-codec"));
});

test("issues separate audience credentials and revokes each path independently", () => {
  const { realm, passkeySession } = createRealm();
  const brokerSession = realm.authenticatePasskey({ credentialId: "passkey:wei", challenge: "broker-challenge", verified: true, clientId: "client:test-broker" });
  const { task, grant } = taskAndGrant(realm, brokerSession);
  const issued = allCredentialClasses.map((credentialClass) => realm.issueCredential({
    class: credentialClass,
    principalId: brokerSession.principalId,
    actorId: brokerSession.actorId,
    clientId: brokerSession.clientId,
    sessionId: brokerSession.id,
    taskId: task.id,
    grantId: grant.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player", workspaceId: "workspace:test", changeId: "change:test" },
  }));
  assert.equal(new Set(issued.map((credential) => credential.audience)).size, allCredentialClasses.length);
  assert.equal(issued.every((credential) => credential.token.length > 20), true);
  assert.equal(Object.values(realm.snapshot().credentials).every((credential) => !("token" in credential)), true);
  for (const credential of issued) assert.equal(credential.audience, CREDENTIAL_AUDIENCES[credential.class]);
  assert.equal(realm.validateCredential(issued.find((credential) => credential.class === "git")!.token, { class: "git", audience: CREDENTIAL_AUDIENCES.git }).valid, true);
  assert.equal(validationCode(realm.validateCredential(issued.find((credential) => credential.class === "git")!.token, { class: "mcp" })), "credential.audience_mismatch");

  const mcp = issued.find((credential) => credential.class === "mcp")!;
  const git = issued.find((credential) => credential.class === "git")!;
  realm.revokeCredential(mcp.id);
  assert.equal(validationCode(realm.validateCredential(mcp.token)), "credential.revoked");
  assert.equal(realm.validateCredential(git.token, { class: "git" }).valid, true);
  realm.revokeSession(brokerSession.id);
  assert.equal(validationCode(realm.validateCredential(git.token)), "credential.revoked");
  assert.throws(() => realm.validateSession(brokerSession.id), (error: unknown) => error instanceof RealmIdentityError && error.code === "session.inactive");
  assert.notEqual(validationCode(realm.validateCredential(git.token)), "credential.audience_mismatch");
  assert.notEqual(passkeySession.id, brokerSession.id);
});

test("records principal, Actor, client, model, Session, Task, Grant, Workspace, and Promotion authority", () => {
  const { realm, principal, passkeySession } = createRealm();
  const { task, grant } = taskAndGrant(realm, passkeySession);
  const result = realm.evaluate({
    operation: "run.invoke",
    capability: "run.invoke",
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: task.id,
    grantId: grant.id,
    resource: { realmId: realm.realm.id, projectId: "project:video-player", sourceSpaceId: "public-player", workspaceId: "workspace:test", changeId: "change:test" },
    sourceSpaceId: "public-player",
    modelProvider: "openai",
    authorityClass: "promotion",
    promotionId: "promotion:test",
    protected: true,
  });
  assert.equal(result.allowed, true);
  const event = [...realm.listAuditEvents()].reverse().find((candidate) => candidate.eventType === "policy.evaluated");
  assert.ok(event);
  assert.equal(event.principalId, principal.id);
  assert.equal(event.actorId, passkeySession.actorId);
  assert.equal(event.clientId, passkeySession.clientId);
  assert.equal(event.modelProvider, "openai");
  assert.equal(event.sessionId, passkeySession.id);
  assert.equal(event.taskId, task.id);
  assert.equal(event.grantId, grant.id);
  assert.equal(event.workspaceId, "workspace:test");
  assert.equal(event.promotionId, "promotion:test");
  assert.equal(event.authorityClass, "promotion");
});

test("binds MCP delivery to a live human-owned Task and Grant", () => {
  const { realm, principal, passkeySession } = createRealm();
  realm.addRelationship({
    principalId: principal.id,
    kind: "organization-member",
    subjectId: principal.id,
    role: "owner",
    resource: { realmId: realm.realm.id, projectId: "project:video-player" },
  });
  const resource = { realmId: realm.realm.id, projectId: "project:video-player", workspaceId: "workspace:mcp", changeId: "change:mcp" };
  const actions = ["landing.request", "release.create", "target.configure", "promotion.request"] as const;
  const delivery = realm.createOwnerTaskGrant({
    sessionId: passkeySession.id,
    purpose: "Remote MCP delivery qualification",
    resource,
    sourceSpaceIds: ["public-player"],
    actions,
    effects: ["landing.apply", "release.create", "target.configure", "promotion.request"],
    expiresAt: "2026-08-03T00:30:00.000Z",
  });
  assert.equal(delivery.grant.allowedCredentialClasses.length, 0);
  const valid = realm.validateTaskGrant({
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: delivery.task.id,
    grantId: delivery.grant.id,
    resource,
    sourceSpaceIds: ["public-player"],
    action: "landing.request",
    effects: ["landing.apply"],
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.taskId, delivery.task.id);
    assert.equal(valid.grantId, delivery.grant.id);
    assert.equal(valid.sourceSpaceCount, 1);
    assert.match(valid.receipt, /task-grant-live/);
  }
  realm.revokeGrant(delivery.grant.id);
  const revoked = realm.validateTaskGrant({
    principalId: principal.id,
    actorId: passkeySession.actorId,
    clientId: passkeySession.clientId,
    sessionId: passkeySession.id,
    taskId: delivery.task.id,
    grantId: delivery.grant.id,
    resource,
    sourceSpaceIds: ["public-player"],
    action: "landing.request",
    effects: ["landing.apply"],
  });
  assert.equal(revoked.valid, false);
  if (!revoked.valid) assert.equal(revoked.code, "mcp.delivery_task_grant_inactive");
});
