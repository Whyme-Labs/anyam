import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";
import { emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { disclosureFixture } from "./fixtures/authority-disclosure-state.ts";
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value) {
  assert.ok(isRecord(value));
  return value;
}
const payload = {
  projectId: "project:owner-readable",
  name: "Owner-readable source",
  sourceAccess: "owner-read",
  sourceSpaces: [{ id: "source:owner-readable", name: "Selected repository", classification: "restricted", repositoryId: "repository:synthetic", snapshotId: "1111111111111111111111111111111111111111" }]
};
test("actual owner bootstrap makes declared Source metadata readable without an Agent and survives replay and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-owner-source-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    assert.ok(bundle.outputFiles[0]);
    const options = convertV4MiniflareOptions({ name: "owner-source-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false };
    options.resourcePersistencePath = join(directory, "storage");
    const start = () => new Miniflare(options);
    runtime = start();
    const invoke = async (path, body, member = "owner", key) => {
      assert.ok(runtime);
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: body === void 0 ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-member": member, [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, ...key ? { "idempotency-key": key } : {} }, ...body === void 0 ? {} : { body: JSON.stringify(body) } });
      return { status: response.status, value: record(await response.json()) };
    };
    const f = disclosureFixture();
    f.state = emptyAuthorityPlaneSnapshot(f.identity.realm.id);
    for (const session of Object.values(f.identity.sessions)) session.expiresAt = "2099-01-01T00:00:00Z";
    const peer = f.members.projectOwner;
    assert.ok(peer);
    for (const relationship of Object.values(f.identity.relationships)) {
      if (relationship.principalId === peer.principal.id) relationship.resource = { realmId: f.identity.realm.id };
    }
    assert.equal((await invoke("/fixture/seed-recovery", f)).status, 200);
    const before = (await invoke("/fixture/checkpoint")).value;
    const secretInput = { ...payload, sourceSpaces: [{ ...payload.sourceSpaces[0], repositoryId: "https://user:SYNTHETIC-CREDENTIAL@repository.invalid/source.git" }] };
    const secretRejected = await invoke("/api/projects", secretInput, "owner", "credential-free-registration");
    assert.notEqual(secretRejected.status, 200);
    assert.doesNotMatch(JSON.stringify(secretRejected.value), /SYNTHETIC-CREDENTIAL/u);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, before);
    const unrelated = await invoke("/api/projects", payload, "public", "non-owner-registration");
    assert.notEqual(unrelated.status, 200);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, before);
    const conflicting = { ...payload, sourceSpaces: [...payload.sourceSpaces, { ...payload.sourceSpaces[0], id: "source:public" }] };
    assert.equal((await invoke("/api/projects", conflicting, "owner", "existing-policy-registration")).status, 409);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, before, "existing identity policy is never replaced, even after preparing another Source in the same request");
    const created = await invoke("/api/projects", payload, "owner", "register-owner-source");
    assert.equal(created.status, 200, JSON.stringify(created.value));
    assert.equal(created.value.sourceAccess, "owner-read");
    const after = (await invoke("/fixture/checkpoint")).value;
    const identity = record(after.identity);
    const priorIdentity = record(before.identity);
    const policy = record(record(identity.sourceSpacePolicies)["source:owner-readable"]);
    assert.deepEqual(policy.readerPrincipalIds, [f.members.owner.principal.id]);
    assert.deepEqual(policy.allowedCapabilities, ["source.read"]);
    assert.equal(policy.discoverable, false);
    for (const field of ["agents", "tasks", "grants", "sessions", "actors", "passkeys", "relationships"]) assert.deepEqual(identity[field], priorIdentity[field], field);
    assert.deepEqual(after.operationalCredentialRecords, before.operationalCredentialRecords);
    const ownerRead = await invoke("/api/projects/project%3Aowner-readable");
    assert.equal(ownerRead.status, 200);
    assert.ok(Array.isArray(ownerRead.value.sourceSpaces));
    assert.equal(ownerRead.value.sourceSpaces.length, 1);
    const peerRead = await invoke("/api/projects/project%3Aowner-readable", void 0, "projectOwner");
    assert.equal(peerRead.status, 200, "Realm owners retain Project-level discovery independently of Source access");
    assert.deepEqual(peerRead.value.sourceSpaces, []);
    assert.deepEqual(record(peerRead.value.project).sourceSpaceIds, []);
    assert.deepEqual(record(peerRead.value.projectViewRevision).sourceSpaceSnapshots, {});
    assert.doesNotMatch(JSON.stringify(peerRead.value), /Selected repository|repository:synthetic|1111111111111111111111111111111111111111/u);
    assert.notEqual((await invoke("/api/projects", payload, "projectOwner", "register-owner-source")).status, 200);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, after, "a different owner cannot take over access by replaying the registration");
    assert.equal((await invoke("/api/projects", payload, "owner", "register-owner-source")).status, 200);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, after, "replay preserves policy IDs, audit and all durable state");
    assert.equal((await invoke("/api/projects", { ...payload, name: "Changed" }, "owner", "register-owner-source")).status, 409);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, after);
    await runtime.dispose();
    runtime = start();
    assert.equal((await invoke("/api/projects/project%3Aowner-readable")).status, 200);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, after);
    const workspace = await invoke("/api/projects/project%3Aowner-readable/workspaces", { projectRevisionId: record(created.value.canonicalRevision).id, sourceSpaceIds: ["source:owner-readable"] }, "owner", "no-implicit-workspace-write");
    assert.notEqual(workspace.status, 200, "read registration must not grant Workspace writes");
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, after);
    const { sourceAccess: _access, ...legacy } = payload;
    const legacyPayload = { ...legacy, projectId: "project:legacy", sourceSpaces: [{ ...payload.sourceSpaces[0], id: "source:legacy" }] };
    assert.equal((await invoke("/api/projects", legacyPayload, "owner", "legacy-registration")).status, 200);
    assert.deepEqual((await invoke("/api/projects/project%3Alegacy")).value.sourceSpaces, [], "omitting the opt-in preserves the legacy undisclosed Source behavior");
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
test("actual owner Source bootstrap rolls back SQL, identity KV and memory on an identity write failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-owner-source-rollback-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    assert.ok(bundle.outputFiles[0]);
    const options = convertV4MiniflareOptions({ name: "owner-source-rollback", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false };
    options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    const invoke = async (path, body) => {
      assert.ok(runtime);
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: body === void 0 ? "GET" : "POST", headers: { "content-type": "application/json", "x-fixture-member": "owner", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE, "idempotency-key": "rollback-owner-source" }, ...body === void 0 ? {} : { body: JSON.stringify(body) } });
      return { status: response.status, value: record(await response.json()) };
    };
    const f = disclosureFixture();
    f.state = emptyAuthorityPlaneSnapshot(f.identity.realm.id);
    assert.equal((await invoke("/fixture/seed-recovery", f)).status, 200);
    const before = (await invoke("/fixture/checkpoint")).value;
    assert.equal((await invoke("/fixture/fail-identity-write-once", {})).status, 200);
    assert.equal((await invoke("/api/projects", payload)).status, 503);
    assert.deepEqual((await invoke("/fixture/checkpoint")).value, before);
    assert.equal((await invoke("/api/projects", payload)).status, 200);
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
