import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AuthorityPlaneCoordinator, emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { artifactsClock, artifactsSelection } from "./fixtures/artifacts-binding.ts";

function seed() {
  const identity = new RealmIdentityPolicy({ realmId: "realm:artifacts-local", relyingPartyId: "anyam.local", now: () => new Date(artifactsClock) });
  const principal = identity.createPrincipal({ displayName: "Fixture owner" });
  identity.registerPasskey({ principalId: principal.id, credentialId: "fixture-passkey" });
  const session = identity.authenticatePasskey({ credentialId: "fixture-passkey", challenge: "fixture-only", verified: true });
  identity.addRelationship({ principalId: principal.id, kind: "organization-member", subjectId: principal.id, role: "owner", resource: { realmId: identity.realm.id } });
  identity.setSourceSpacePolicy({ sourceSpaceId: artifactsSelection.sourceSpaceId, classification: "restricted", readerPrincipalIds: [principal.id], allowedCapabilities: ["source.read", "workspace.write"], allowedModelProviders: [] });
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(identity.realm.id));
  const actor = { realmId: identity.realm.id, principalId: principal.id, actorId: session.actorId, sessionId: session.id, clientId: session.clientId, authorizationEpoch: identity.realm.authorizationEpoch, kind: "human" };
  authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "project.create", idempotencyKey: "seed-project", payload: { projectId: artifactsSelection.projectId, name: "Fixture", referenceType: "git", projectRevisionId: artifactsSelection.projectRevisionId, sourceSpaces: [{ id: artifactsSelection.sourceSpaceId, name: "source", classification: "restricted", snapshotId: artifactsSelection.baseCommitOid, repositoryId: "repository:artifacts:account-a:private:uuid-source" }] } }, actor);
  const workspace = authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "workspace.create", idempotencyKey: "seed-workspace", payload: { projectId: artifactsSelection.projectId, workspaceId: artifactsSelection.workspaceId, projectRevisionId: artifactsSelection.projectRevisionId, sourceSpaceIds: [artifactsSelection.sourceSpaceId] } }, actor);
  assert.equal(workspace.status, "succeeded");
  const state = authority.snapshot();
  const selection = { ...artifactsSelection, projectViewId: state.workspaces[artifactsSelection.workspaceId].projectViewId };
  const grant = identity.createOwnerTaskGrant({ sessionId: session.id, purpose: "Owned local qualification", resource: { realmId: identity.realm.id, projectId: selection.projectId, workspaceId: selection.workspaceId, sourceSpaceId: selection.sourceSpaceId }, sourceSpaceIds: [selection.sourceSpaceId], actions: ["source.read", "workspace.write"], effects: ["source.read", "workspace.write"], expiresAt: new Date(artifactsClock + 300_000).toISOString() });
  const peerSession = identity.authenticatePasskey({ credentialId: "fixture-passkey", challenge: "fixture-peer-only", verified: true });
  const recoveryGrant = identity.createOwnerTaskGrant({ sessionId: peerSession.id, purpose: "Owned local recovery", resource: { realmId: identity.realm.id, projectId: selection.projectId, workspaceId: selection.workspaceId, sourceSpaceId: selection.sourceSpaceId }, sourceSpaceIds: [selection.sourceSpaceId], actions: ["source.read", "workspace.write"], effects: ["source.read", "workspace.write"], expiresAt: new Date(artifactsClock + 300_000).toISOString() });
  return { peerSessionId: peerSession.id, recoveryAuthorization: { sessionId: peerSession.id, bindings: [{ workspaceId: selection.workspaceId, sourceSpaceId: selection.sourceSpaceId, taskId: recoveryGrant.task.id, grantId: recoveryGrant.grant.id }] }, identity: identity.getRecoverySnapshot(), authority: state, request: { sessionId: session.id, bindings: [{ workspaceId: selection.workspaceId, sourceSpaceId: selection.sourceSpaceId, taskId: grant.task.id, grantId: grant.grant.id }], input: { runId: "local-runtime:one", execution: "local-fixture", selections: [selection], credentialExpiresAt: new Date(artifactsClock + 120_000).toISOString() } } };
}

test("local workerd Realm composes current authorization and SQLite custody without name-only deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-artifacts-realm-runtime-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/artifacts-realm-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "artifacts-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { LOCAL_REALM: { className: "LocalArtifactsRealm", useSQLite: true }, PRODUCTION_REALM: { className: "LocalCoordinatorProbe", useSQLite: true } }, durableObjectsPersist: join(directory, "storage"), outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false };
    options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    const invoke = async (path, body) => {
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const fixture = seed();
    const productionBefore = (await invoke("/production/inspect", {})).result;
    for (const path of ["/production/run", "/production/cleanup"]) {
      const denied = await invoke(path, { ...fixture.request, runId: fixture.request.input.runId });
      assert.equal(denied.result.code, "artifacts.realm_authorization_denied");
      assert.deepEqual((await invoke("/production/inspect", {})).result, productionBefore, "actual coordinator denial cannot initialize Authority/custody or call the provider");
    }
    assert.equal(productionBefore.providerCalls, 0);
    await invoke("/seed", fixture);
    const initially = (await invoke("/inspect", {})).result;
    assert.ok(initially.rows.every(row => !row.name.startsWith("anyam_artifacts_")));
    for (const handle of [fixture.request.sessionId, fixture.peerSessionId]) {
      const sessionAlias = await invoke("/run", { ...fixture.request, input: { ...fixture.request.input, runId: handle } });
      assert.equal(sessionAlias.result.code, "artifacts.realm_authorization_denied", "known Realm session handles cannot become receipt metadata");
      assert.deepEqual(sessionAlias.events, []);
      assert.deepEqual((await invoke("/inspect", {})).result, initially);
    }
    for (const [field, value] of [["status", "closed"], ["principalId", "untrusted-principal"], ["actorId", "untrusted-actor"], ["sessionId", "untrusted-session"]]) {
      const invalid = structuredClone(fixture);
      invalid.identity.tasks[fixture.request.bindings[0].taskId][field] = value;
      await invoke("/seed", invalid);
      const denied = await invoke("/run", fixture.request);
      assert.equal(denied.result.code, "artifacts.realm_authorization_denied", `Task ${field} must deny current authority`);
      assert.deepEqual(denied.events, []);
      assert.deepEqual((await invoke("/inspect", {})).result, initially);
    }
    await invoke("/seed", fixture);
    const invalidRequests = [
      { ...fixture.request, sessionId: "untrusted-session" },
      { ...fixture.request, bindings: [] },
      { ...fixture.request, bindings: fixture.request.bindings.map(binding => ({ ...binding, grantId: "unknown-grant" })) },
      ...["workspaceId", "projectViewId", "projectId", "projectRevisionId"].map(field => ({ ...fixture.request, input: { ...fixture.request.input, selections: fixture.request.input.selections.map(selection => ({ ...selection, [field]: "unknown-context" })) } })),
      { ...fixture.request, input: { ...fixture.request.input, credentialExpiresAt: "invalid-expiry" } },
      { ...fixture.request, bindings: [fixture.request.bindings[0], { ...fixture.request.bindings[0], workspaceId: "unused-binding" }], input: { ...fixture.request.input, selections: [fixture.request.input.selections[0], fixture.request.input.selections[0]] } },
    ];
    for (const request of invalidRequests) {
      const denied = await invoke("/run", request);
      assert.equal(denied.result.code, "artifacts.realm_authorization_denied");
      assert.deepEqual(denied.events, []);
      assert.deepEqual((await invoke("/inspect", {})).result, initially, "denial cannot create qualification/custody schemas or rows");
    }
    const renewedDenial = await invoke("/run", { ...fixture.request, testDenyAfter: 1 });
    assert.equal(renewedDenial.result.code, "qualification.authorization_denied");
    assert.deepEqual(renewedDenial.events, []);
    assert.deepEqual((await invoke("/inspect", {})).result, initially, "a renewed denial cannot initialize qualification/custody schemas");
    const result = await invoke("/run", fixture.request);
    assert.equal(result.result.bindingContract, "passed");
    assert.equal(result.result.cleanup, "required");
    assert.equal(result.result.resources[0].recovery, "qualification.guarded_delete_unqualified");
    assert.match(result.result.inputDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.activeTokens, 0);
    assert.equal(result.repositoryIds.length, 2);
    assert.ok(result.events.every(event => !event.startsWith("UNSAFE-delete")));
    assert.doesNotMatch(JSON.stringify(result.result), /initial-secret|usable-secret|fixture-passkey/u);
    const before = await invoke("/inspect", {});
    const denied = await invoke("/run", { ...fixture.request, sessionId: "untrusted-session", input: { ...fixture.request.input, runId: "denied" } });
    assert.equal(denied.result.code, "artifacts.realm_authorization_denied");
    assert.deepEqual(denied.events, []);
    assert.deepEqual((await invoke("/inspect", {})).result, before.result);
    const mismatch = await invoke("/run", { ...fixture.request, input: { ...fixture.request.input, runId: "mismatch", selections: [{ ...fixture.request.input.selections[0], baseCommitOid: "9".repeat(40) }] } });
    assert.equal(mismatch.result.code, "artifacts.realm_authorization_denied");
    assert.deepEqual(mismatch.events, []);
    assert.deepEqual((await invoke("/inspect", {})).result, before.result);
    await runtime.dispose(); runtime = new Miniflare(options);
    assert.deepEqual((await invoke("/inspect", {})).result, before.result, "actual local DO storage survives runtime replacement");
    const duplicate = await invoke("/run", fixture.request);
    assert.equal(duplicate.result.code, "qualification.run_already_recorded");
    assert.deepEqual(duplicate.events, []);
    await invoke("/recreate", { name: "workspace-a" });
    const cleanup = await invoke("/cleanup", { ...fixture.request, runId: fixture.request.input.runId });
    assert.equal(cleanup.result.cleanup, "required");
    assert.equal(cleanup.result.deletion, "unsupported-name-only-binding");
    assert.ok(cleanup.events.every(event => !event.startsWith("UNSAFE-delete")));
    assert.ok(cleanup.repositoryIds.some(([name, id]) => name === "workspace-a" && id === "uuid-recreated"));
    await invoke("/revoke", { sessionId: fixture.request.sessionId });
    const beforeRevoke = await invoke("/inspect", {});
    const revoked = await invoke("/cleanup", { ...fixture.request, runId: fixture.request.input.runId });
    assert.equal(revoked.result.code, "artifacts.realm_authorization_denied");
    assert.deepEqual(revoked.events, []);
    assert.deepEqual((await invoke("/inspect", {})).result, beforeRevoke.result);
    const recovered = await invoke("/cleanup", { ...fixture.recoveryAuthorization, runId: fixture.request.input.runId });
    assert.equal(recovered.result.inputDigest, result.result.inputDigest, "fresh owner authority can reconcile the same recorded input after the original session is revoked");
    assert.equal(recovered.result.deletion, "unsupported-name-only-binding");
    assert.ok(recovered.events.some(event => event.startsWith("get:")));
    assert.ok(recovered.events.every(event => !event.startsWith("UNSAFE-delete")));
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
