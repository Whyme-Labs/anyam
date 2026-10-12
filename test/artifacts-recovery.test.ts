import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import type { AuthoritySqlHost } from "../src/cloudflare/authority-sqlite.ts";
import { ArtifactsWorkspaceAdapter } from "../src/cloudflare/artifacts-workspace.ts";
import { SQLiteArtifactsWorkspaceStore } from "../src/cloudflare/artifacts-workspace-store.ts";
import { artifactsBindingFixture, artifactsSelection } from "./fixtures/artifacts-binding.ts";
import { ArtifactsRecoveryStore, parseArtifactsRecoverySnapshot, ARTIFACTS_RECOVERY_PROTOCOL } from "../src/cloudflare/artifacts-recovery.ts";
import { createAuthorityRecoveryBundle, verifyAuthorityRecoveryBundle } from "../src/cloudflare/authority-recovery.ts";
import { signArtifactRecoveryFixture } from "./fixtures/artifacts-recovery-envelope.ts";

function database() {
  const db = new DatabaseSync(":memory:"); let sequence = 0;
  const host: AuthoritySqlHost = { sql: { exec<T extends Record<string, unknown>>(query: string, ...args: unknown[]) {
    const statement = db.prepare(query);
    const values = args.map(value => { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value; throw new Error("unsupported owned fixture SQL binding"); });
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    // The owned fixture SQL projection is declared by each caller.
    return { toArray: () => rows as T[] };
  } }, transactionSync<T>(callback: () => T): T {
    const name = `artifact_recovery_${sequence++}`; db.exec(`SAVEPOINT ${name}`);
    try { const value = callback(); db.exec(`RELEASE ${name}`); return value; }
    catch (error) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw error; }
  } };
  return { db, host, close: () => db.close() };
}
async function fixture() {
  const data = database(); const provider = artifactsBindingFixture();
  const authority = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot("realm:artifact-recovery"));
  const actor = { realmId: "realm:artifact-recovery", principalId: "principal:owner", actorId: "actor:owner", sessionId: "session:owner", clientId: "client:owner", kind: "human" as const, authorizationEpoch: 1 };
  assert.equal(authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "project.create", idempotencyKey: "project", payload: { projectId: artifactsSelection.projectId, projectRevisionId: artifactsSelection.projectRevisionId, name: "Recovery fixture", sourceSpaces: [{ id: artifactsSelection.sourceSpaceId, name: "Source", classification: "restricted", snapshotId: artifactsSelection.baseCommitOid, repositoryId: "repository:artifacts:account-a:private:uuid-source" }] } }, actor).status, "succeeded");
  assert.equal(authority.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "workspace.create", idempotencyKey: "workspace", payload: { projectId: artifactsSelection.projectId, projectRevisionId: artifactsSelection.projectRevisionId, workspaceId: artifactsSelection.workspaceId, sourceSpaceIds: [artifactsSelection.sourceSpaceId] } }, actor).status, "succeeded");
  const state = authority.snapshot(); const workspace = state.workspaces[artifactsSelection.workspaceId]!;
  const selection = { ...artifactsSelection, projectViewId: workspace.projectViewId };
  const store = new SQLiteArtifactsWorkspaceStore(data.host);
  const adapter = new ArtifactsWorkspaceAdapter({ artifacts: provider.binding, accountId: "account-a", namespace: "private", store, authorize: provider.authorize, now: () => provider.now });
  const context = await adapter.materializeWorkspace(selection);
  data.host.sql.exec("CREATE TABLE anyam_artifacts_observations (row_key TEXT PRIMARY KEY, manifest TEXT NOT NULL)");
  const add = (generation: number) => {
    const manifest = { protocol: "anyam.repository-driver-snapshot/v2", repositoryId: "repository:artifacts:account-a:private:uuid-source", sourceSpaceId: selection.sourceSpaceId, context: { kind: "workspace", workspaceId: selection.workspaceId, projectViewId: selection.projectViewId, workspaceRef: "refs/heads/main" }, objectFormat: "sha1", symbolicRef: "refs/heads/main", commitOid: selection.baseCommitOid, treeOid: selection.baseTreeOid, baseCommitOid: selection.baseCommitOid, ancestorCommitOids: [selection.baseCommitOid], generation, state: "active", observedAt: "2026-10-02T12:00:00Z", expiresAt: "2026-10-02T12:10:00Z", receipt: `provider=artifacts; workspaceRepository=${context.binding.repositoryId}; credentialMaterialStored=false` };
    const index = `repositories/${encodeURIComponent(manifest.repositoryId)}/workspace/${encodeURIComponent(selection.workspaceId)}/${encodeURIComponent(selection.projectViewId)}/index.json`;
    data.host.sql.exec("INSERT INTO anyam_artifacts_observations VALUES (?, ?)", JSON.stringify([index, selection.sourceSpaceId, generation]), JSON.stringify(manifest, null, generation === 1 ? 2 : undefined));
  };
  add(1); add(2);
  return { ...data, provider, state, selection, store, add, recovery: new ArtifactsRecoveryStore(data.host) };
}

test("Artifact recovery round-trips pending custody and exact immutable generation bytes", async () => {
  const f = await fixture(); const target = database();
  try {
    f.store.change(f.selection, value => { value.pendingOperation = "mint"; value.unknownTokenInventory = true; value.tokenIds.push("token-id-pending"); });
    const snapshot = f.recovery.capture(f.state);
    assert.equal(snapshot.protocol, ARTIFACTS_RECOVERY_PROTOCOL); assert.equal(snapshot.schemaVersion, 1);
    new ArtifactsRecoveryStore(target.host).restore(snapshot, { currentAuthority: f.state, targetAuthority: f.state });
    assert.deepEqual(new ArtifactsRecoveryStore(target.host).capture(f.state), snapshot);
    assert.equal(new SQLiteArtifactsWorkspaceStore(target.host).read(f.selection)?.pendingOperation, "mint");
    assert.deepEqual(snapshot.observations.map(value => value.manifest), target.host.sql.exec<{ manifest: string }>("SELECT manifest FROM anyam_artifacts_observations ORDER BY row_key").toArray().map(value => value.manifest));
    assert.doesNotMatch(JSON.stringify(snapshot), /initial-secret|usable-secret/);
  } finally { f.close(); target.close(); }
});

test("Artifact recovery rejects malformed schema, duplicate bindings and inconsistent Source/base/generation rows", async () => {
  const f = await fixture();
  try {
    const snapshot = f.recovery.capture(f.state);
    assert.equal(parseArtifactsRecoverySnapshot({ ...snapshot, schemaVersion: 99 }, f.state), undefined);
    for (const change of [
      (s: typeof snapshot) => { s.workspaces.push({ ...s.workspaces[0]! }); },
      (s: typeof snapshot) => { s.workspaces[0]!.accountId = "other-account"; },
      (s: typeof snapshot) => { const value = JSON.parse(s.workspaces[0]!.payload); value.pendingOperation = ["fork"]; s.workspaces[0]!.payload = JSON.stringify(value); },
      (s: typeof snapshot) => { const value = JSON.parse(s.workspaces[0]!.payload); value.selection.baseCommitOid = "a".repeat(40); s.workspaces[0]!.payload = JSON.stringify(value); },
      (s: typeof snapshot) => { s.observations[0]!.rowKey = "[]"; },
      (s: typeof snapshot) => { const value = JSON.parse(s.observations[0]!.manifest); value.context.projectViewId = "view:other"; s.observations[0]!.manifest = JSON.stringify(value); },
    ]) { const changed = structuredClone(snapshot); change(changed); assert.equal(parseArtifactsRecoverySnapshot(changed, f.state), undefined); }
  } finally { f.close(); }
});

test("Artifact recovery excludes credential-bearing and unknown payload fields before export or restore", async () => {
  const f = await fixture();
  try {
    const snapshot = f.recovery.capture(f.state); const value = JSON.parse(snapshot.workspaces[0]!.payload); value.token = "credential-value"; snapshot.workspaces[0]!.payload = JSON.stringify(value);
    assert.equal(parseArtifactsRecoverySnapshot(snapshot, f.state), undefined);
    f.host.sql.exec("UPDATE anyam_artifacts_workspaces SET payload = ?", snapshot.workspaces[0]!.payload);
    assert.throws(() => f.recovery.capture(f.state), /artifact recovery/);
  } finally { f.close(); }
});

test("an older Artifact checkpoint cannot erase new pending effects or replace a generation", async () => {
  const f = await fixture();
  try {
    const snapshot = f.recovery.capture(f.state);
    f.store.change(f.selection, value => { value.pendingOperation = "mint"; value.unknownTokenInventory = true; });
    const before = f.recovery.capture(f.state);
    assert.throws(() => f.recovery.restore(snapshot, { currentAuthority: f.state, targetAuthority: f.state }), /conflict/);
    assert.deepEqual(f.recovery.capture(f.state), before);
    const mutated = structuredClone(before); const value = JSON.parse(mutated.observations[0]!.manifest); value.receipt += "; changed=true"; mutated.observations[0]!.manifest = JSON.stringify(value);
    assert.throws(() => f.recovery.restore(mutated, { currentAuthority: f.state, targetAuthority: f.state }), /conflict/);
    assert.deepEqual(f.recovery.capture(f.state), before);
  } finally { f.close(); }
});

test("signed v2 recovery binds Artifact metadata while existing v1 recovery remains compatible", async () => {
  const f = await fixture();
  try {
    const common = { snapshot: f.state, bundleId: "bundle:artifact", recoveryKeyId: "key:synthetic", secret: "synthetic-only" };
    const legacy = await createAuthorityRecoveryBundle(common); assert.equal(legacy.protocol, "anyam.authority-recovery/v1");
    const artifacts = f.recovery.capture(f.state);
    const signed = await createAuthorityRecoveryBundle({ ...common, artifacts }); assert.equal(signed.protocol, "anyam.authority-recovery/v2");
    assert.equal((await verifyAuthorityRecoveryBundle({ value: signed, realmId: f.state.realmId, recoveryKeyId: common.recoveryKeyId, secret: common.secret })).valid, true);
    const tampered = { ...signed, artifacts: { ...artifacts, observations: [] } };
    assert.equal((await verifyAuthorityRecoveryBundle({ value: tampered, realmId: f.state.realmId, recoveryKeyId: common.recoveryKeyId, secret: common.secret })).valid, false);
    assert.equal((await verifyAuthorityRecoveryBundle({ value: legacy, realmId: f.state.realmId, recoveryKeyId: common.recoveryKeyId, secret: common.secret })).valid, true);
  } finally { f.close(); }
});

test("Artifact recovery refuses an unsupported physical table schema before writing", () => {
  const target = database();
  try {
    target.host.sql.exec("CREATE TABLE anyam_artifacts_observations (row_key TEXT, manifest TEXT NOT NULL)");
    assert.throws(() => new ArtifactsRecoveryStore(target.host).capture(emptyAuthorityPlaneSnapshot("realm:schema")), /schema_unsupported/);
  } finally { target.close(); }
});

test("a matching signature cannot authorize incompatible or inconsistent Artifact recovery metadata", async () => {
  const f = await fixture();
  try {
    const secret = "synthetic-only";
    const signed = await createAuthorityRecoveryBundle({ snapshot: f.state, artifacts: f.recovery.capture(f.state), bundleId: "bundle:malformed", recoveryKeyId: "key:synthetic", secret });
    const verify = (value: unknown) => verifyAuthorityRecoveryBundle({ value, realmId: f.state.realmId, recoveryKeyId: "key:synthetic", secret });
    assert.equal((await verify(signArtifactRecoveryFixture(signed, secret))).valid, true);
    for (const value of [
      { ...signed, authoritySchemaVersion: 99 },
      { ...signed, artifacts: undefined },
      { ...signed, artifacts: { ...f.recovery.capture(f.state), schemaVersion: 99 } },
      { ...signed, artifacts: { ...f.recovery.capture(f.state), workspaces: [] } },
    ]) assert.equal((await verify(signArtifactRecoveryFixture(value, secret))).valid, false);
    const before = f.recovery.capture(f.state);
    const malformed = structuredClone(before);
    const generation = JSON.parse(malformed.observations[0]!.manifest);
    generation.receipt = "Authorization: Bearer synthetic-credential";
    malformed.observations[0]!.manifest = JSON.stringify(generation);
    assert.equal((await verify(signArtifactRecoveryFixture({ ...signed, artifacts: malformed }, secret))).valid, false);
    assert.throws(() => f.recovery.restore(malformed, { currentAuthority: f.state, targetAuthority: f.state }), /invalid_snapshot/);
    assert.deepEqual(f.recovery.capture(f.state), before);
  } finally { f.close(); }
});
