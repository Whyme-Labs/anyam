import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  type Capability,
  type GovernanceControlObservation,
} from "../src/index.ts";
import {
  ExtensionError,
  ExtensionRegistry,
  createGovernanceProfile,
  GovernanceProfileError,
  GovernanceProfileRegistry,
  verifyGovernanceProfileExport,
  type ExtensionAuthorization,
} from "../src/index.ts";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";

const projectId = "project:video-player";

function createHarness() {
  let current = new Date("2026-08-03T00:00:00.000Z");
  const realm = new RealmIdentityPolicy({
    realmId: "realm:test",
    name: "Anyam test Realm",
    relyingPartyId: "anyam.test",
    now: () => current,
  });
  const principal = realm.createPrincipal({ id: "principal:owner", displayName: "Owner" });
  realm.registerPasskey({ principalId: principal.id, credentialId: "passkey:owner" });
  const session = realm.authenticatePasskey({ credentialId: "passkey:owner", challenge: "challenge", verified: true, clientId: "client:anyam-cli" });
  realm.addRelationship({
    principalId: principal.id,
    kind: "organization-member",
    subjectId: principal.id,
    role: "owner",
    resource: { realmId: realm.realm.id, projectId },
  });

  function authorizeFor(resourceProjectId = projectId, options: { target?: boolean; governance?: boolean } = {}) {
    const task = realm.createTask({
      principalId: session.principalId,
      actorId: session.actorId,
      sessionId: session.id,
      purpose: "extension and governance acceptance test",
      workspaceId: "workspace:test",
      changeId: "change:test",
    });
    const actions: Capability[] = [
      "extension.install",
      "extension.manage",
      "extension.invoke",
      "governance.profile.manage",
      "governance.profile.evaluate",
    ];
    const effects = [
      "extension.install",
      "extension.manage",
      "extension.replace",
      "extension.deprecated",
      "extension.revoked",
      "target.promote",
      "governance.profile.manage",
      "governance.profile.evaluate",
    ];
    if (options.target !== false) actions.push("target.promote");
    if (options.governance === false) {
      actions.splice(actions.indexOf("governance.profile.manage"), 1);
      actions.splice(actions.indexOf("governance.profile.evaluate"), 1);
    }
    const resource = { realmId: realm.realm.id, projectId: resourceProjectId };
    const grant = realm.createCapabilityGrant({
      principalId: session.principalId,
      actorId: session.actorId,
      clientId: session.clientId,
      sessionId: session.id,
      taskId: task.id,
      resource,
      sourceSpaceIds: [],
      actions,
      effects: options.target === false ? effects.filter((effect) => effect !== "target.promote") : effects,
      allowedModelProviders: [],
      budget: { modelCostUsd: 5 },
    });
    const authorization: ExtensionAuthorization = {
      principalId: session.principalId,
      actorId: session.actorId,
      clientId: session.clientId,
      sessionId: session.id,
      taskId: task.id,
      grantId: grant.id,
      resource,
    };
    return { authorization, grant };
  }

  return {
    realm,
    principal,
    session,
    authorizeFor,
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function manifest(overrides: Partial<Parameters<ExtensionRegistry["registerManifest"]>[0]["manifest"]> = {}) {
  return {
    protocol: CONTRACT_VERSIONS.extension,
    id: "extension:video-target",
    name: "Video Target Adapter",
    version: "1.0.0",
    kind: "target-adapter" as const,
    trust: "verified" as const,
    source: "https://registry.example.test/video-target.tgz",
    digest: "sha256:video-target-v1",
    requestedEffects: ["target.promote"],
    requestedCapabilities: ["target.promote"],
    lifecycle: "proposed" as const,
    compatibility: [CONTRACT_VERSIONS.kernel, CONTRACT_VERSIONS.extension],
    provenance: {
      source: "https://registry.example.test/video-target.tgz",
      publisher: "test-publisher",
      signer: "sig:test-publisher",
      receipt: "receipt=extension-manifest; source=fixture",
    },
    ...overrides,
  };
}

function installInput(harness: ReturnType<typeof createHarness>, authorization: ExtensionAuthorization) {
  return {
    manifestId: "extension:video-target",
    manifestVersion: "1.0.0",
    packageDigest: "sha256:video-target-v1",
    scope: { kind: "project" as const, realmId: harness.realm.realm.id, projectId },
    grantedEffects: ["target.promote"],
    grantedCapabilities: ["target.promote" as const],
    authorization,
    receipt: "receipt=extension-install; source=acceptance-test",
  };
}

test("digest-pinned extension registration fails closed and blocks unverified authority", () => {
  const harness = createHarness();
  const registry = new ExtensionRegistry({ realm: harness.realm, now: harness.now });

  assert.throws(
    () => registry.registerManifest({ manifest: manifest(), packageDigest: "sha256:wrong" }),
    (error: unknown) => error instanceof ExtensionError && error.code === "digest-mismatch",
  );

  const blocked = registry.registerManifest({
    manifest: manifest({ id: "extension:unverified-target", trust: "unverified" }),
    packageDigest: "sha256:video-target-v1",
  });
  assert.equal(blocked.lifecycle, "blocked");
  assert.equal(registry.snapshot().events.at(-1)?.kind, "blocked");
});

test("extension installation intersects scope, manifest, grant, and policy", () => {
  const harness = createHarness();
  const registry = new ExtensionRegistry({ realm: harness.realm, now: harness.now });
  registry.registerManifest({ manifest: manifest(), packageDigest: "sha256:video-target-v1" });
  const { authorization } = harness.authorizeFor();

  assert.throws(
    () => registry.install({ ...installInput(harness, authorization), grantedCapabilities: ["change.approve"] }),
    (error: unknown) => error instanceof ExtensionError && error.code === "grant-widening",
  );

  const installation = registry.install(installInput(harness, authorization));
  assert.equal(installation.lifecycle, "enabled");
  assert.equal(installation.scope.kind, "project");
  assert.equal(installation.manifestDigest, "sha256:video-target-v1");
  assert.equal(installation.grantId, authorization.grantId);
  assert.equal(installation.grantedCapabilities.includes("target.promote"), true);
  assert.equal(registry.snapshot().events.filter((event) => event.installationId === installation.id).map((event) => event.kind).join(","), "install-requested,installed,enabled");
});

test("extensions can propose protected transitions but never become Landing or Promotion authority", () => {
  const harness = createHarness();
  const registry = new ExtensionRegistry({ realm: harness.realm, now: harness.now });
  registry.registerManifest({ manifest: manifest(), packageDigest: "sha256:video-target-v1" });
  const authorized = harness.authorizeFor();
  const installation = registry.install(installInput(harness, authorized.authorization));
  const proposal = registry.invoke({
    installationId: installation.id,
    requestedEffects: ["target.promote"],
    requestedCapabilities: ["target.promote"],
    resource: { realmId: harness.realm.realm.id, projectId, targetId: "target:production" },
    authorization: authorized.authorization,
    operation: "target.promote",
  });
  assert.equal(proposal.status, "proposal");
  assert.match(proposal.nextAction, /trusted Anyam authority/);

  const withoutPromotion = harness.authorizeFor(projectId, { target: false });
  const blocked = registry.invoke({
    installationId: installation.id,
    requestedEffects: ["target.promote"],
    requestedCapabilities: ["target.promote"],
    resource: { realmId: harness.realm.realm.id, projectId, targetId: "target:production" },
    authorization: withoutPromotion.authorization,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.policyExplanations[0]?.decision, "deny");

  const secret = registry.invoke({
    installationId: installation.id,
    requestedEffects: ["secret.value.read"],
    requestedCapabilities: ["secret.value.read"],
    resource: { realmId: harness.realm.realm.id, projectId },
    authorization: authorized.authorization,
  });
  assert.equal(secret.status, "blocked");
  assert.match(secret.nextAction, /raw secret values/);
});

test("replacement, provider migration, deprecation, and revocation preserve extension lineage", () => {
  const harness = createHarness();
  const registry = new ExtensionRegistry({ realm: harness.realm, now: harness.now });
  registry.registerManifest({ manifest: manifest(), packageDigest: "sha256:video-target-v1" });
  const { authorization } = harness.authorizeFor();
  const first = registry.install(installInput(harness, authorization));
  const replacement = registry.migrateProvider({
    installationId: first.id,
    replacement: installInput(harness, authorization),
    authorization,
    reason: "move provider to the customer-operated registry",
  });
  assert.equal(replacement.replacesInstallationId, first.id);
  assert.equal(replacement.providerMigrationFrom, "https://registry.example.test/video-target.tgz");
  assert.equal(replacement.lineageId, first.lineageId);
  assert.equal(registry.getInstallation(first.id)?.lifecycle, "replaced");

  const deprecated = registry.deprecate({ installationId: replacement.id, authorization, reason: "provider published a replacement manifest" });
  assert.equal(deprecated.lifecycle, "deprecated");
  const revoked = registry.revoke({ installationId: replacement.id, authorization, reason: "provider compromise receipt" });
  assert.equal(revoked.lifecycle, "revoked");
  assert.equal(registry.snapshot().events.some((event) => event.kind === "provider-migrated"), true);
  assert.equal(registry.snapshot().events.some((event) => event.kind === "deprecated"), true);
  assert.equal(registry.snapshot().events.some((event) => event.kind === "revoked"), true);
});

function observations(): readonly GovernanceControlObservation[] {
  return [
    {
      controlId: "identity.passkey",
      status: "satisfied",
      evidenceRefs: ["evidence:passkey"],
      observedAt: "2026-08-03T00:00:00.000Z",
      owner: "identity-maintainer",
      nextAction: "recheck after the next Realm policy epoch",
      disclosure: { projectionId: "project:video-player", classification: "project" },
      receipt: "receipt=identity-passkey; source=acceptance-test",
    },
    {
      controlId: "audit.export",
      status: "satisfied",
      evidenceRefs: ["evidence:audit-export"],
      observedAt: "2026-08-03T00:00:00.000Z",
      owner: "governance-maintainer",
      nextAction: "retain the export with the Project recovery package",
      disclosure: { projectionId: "project:video-player", classification: "project" },
      receipt: "receipt=audit-export; source=acceptance-test",
    },
  ];
}

test("Governance Profiles export and replay portable control Evidence without certification claims", () => {
  const harness = createHarness();
  const { authorization } = harness.authorizeFor();
  const registry = new GovernanceProfileRegistry(harness.realm, { now: harness.now });
  const profile = createGovernanceProfile({
    id: "governance:baseline",
    name: "Anyam baseline controls",
    version: "1.0.0",
    scope: { realmId: harness.realm.realm.id, projectId },
    controls: [
      { id: "identity.passkey", title: "Passkey owner", requirement: "A Realm owner uses a passkey.", owner: "identity", required: true, evidenceKinds: ["audit"] },
      { id: "audit.export", title: "Exportable audit", requirement: "The Project audit can be exported.", owner: "governance", required: true, evidenceKinds: ["export"] },
    ],
    provenance: { source: "https://profiles.anyam.dev/baseline", publisher: "Anyam community", receipt: "receipt=governance-profile; source=acceptance-test" },
    policyVersion: harness.realm.realm.policyVersion,
    receipt: "receipt=governance-profile; scope=project:video-player",
  });
  registry.registerProfile(profile);
  registry.activateProfile({ profileId: profile.id, scope: profile.scope, authorization });
  assert.equal(registry.getProfile(profile.id)?.lifecycle, "active");
  const evaluation = registry.evaluate({ profileId: profile.id, scope: profile.scope, observations: observations(), authorization });
  assert.equal(evaluation.status, "ready");
  assert.equal(evaluation.certificationClaim, false);
  assert.equal(registry.listEvidence().every((evidence) => evidence.certificationClaim === false), true);

  const bundle = registry.exportProfile(profile.id, { profileId: profile.id, scope: profile.scope, observations: observations(), authorization });
  assert.equal(bundle.credentialFree, true);
  assert.equal(verifyGovernanceProfileExport(bundle).integrityDigest, bundle.integrityDigest);
  const tampered = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
  tampered.integrityDigest = "sha256:tampered";
  assert.throws(() => verifyGovernanceProfileExport(tampered), (error: unknown) => error instanceof GovernanceProfileError && error.code === "export-invalid");

  const replayRegistry = new GovernanceProfileRegistry(harness.realm, { now: harness.now });
  const replay = replayRegistry.replay(bundle, { scope: profile.scope, authorization, observations: observations() });
  assert.equal(replay.status, "ready");
  assert.equal(replay.profileDigest, profile.digest);
  assert.equal(replay.certificationClaim, false);
});
