import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { setup, makeRunner, runnerSession } from "./realm-artifact-handoff-fixture.ts";
import { runnerResultMessage } from "../src/execution/runner.ts";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";
import { createHash } from "node:crypto";

// The already-strict/probed LocalDisclosureRealm fixture seeds auth/Authority;
// actual workerd, Realm fetch, SQLite and Miniflare R2 bindings execute here.
// All storage and processes are owned locally; outbound service is denied.
test("Realm Artifact handoff uses actual local workerd, SQLite and R2 with tamper denial, conditional retention and durable replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anyam-realm-artifact-handoff-")); let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/authority-disclosure-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "realm-artifact-handoff-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-03", compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"], durableObjects: { REALM_COORDINATOR: { className: "LocalDisclosureRealm", useSQLite: true } }, r2Buckets: { ANYAM_RUNNER_OUTPUTS: "owned-attempt-outputs", ANYAM_PROMOTION_ARTIFACTS: "owned-executor-artifacts" }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options); await runtime.ready;
    const source = await runtime.getR2Bucket("ANYAM_RUNNER_OUTPUTS"); const destination = await runtime.getR2Bucket("ANYAM_PROMOTION_ARTIFACTS");
    const f = setup(); const runner = makeRunner(f.input, f.runId);
    const bytes = new TextEncoder().encode("retained by actual local Realm/R2; no process execution claim\n");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const result = structuredClone(runner.result); result.output.outputDigest = digest; result.output.outputDigests = [`dist/result.txt=${digest}`]; result.outputs[0].digest = digest;
    result.signature = sign(null, Buffer.from(runnerResultMessage(result)), runner.keys.privateKey).toString("base64url");
    const completion = runner.runner.submit({ credential: runner.lease.credential, result });
    f.authority.registerRunnerProfile(runner.profile, runnerSession); const state = f.authority.snapshot();
    const identity = new RealmIdentityPolicy({ realmId: state.realmId, relyingPartyId: "fixture.local" }).getRecoverySnapshot(); identity.realm.authorizationEpoch = 4;
    const invoke = async (path, body) => {
      const response = await runtime.dispatchFetch(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...(path.startsWith("/authority/") ? { [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    };
    const seed = async () => { assert.equal((await invoke("/fixture/seed", { identity, state, members: {} })).status, 200); };
    const snapshot = async () => (await invoke("/fixture/checkpoint", {})).value.authority;
    const command = { idempotencyKey: "local-runtime:artifact-handoff", completion };
    const complete = () => invoke("/authority/runner-complete/internal", command);
    const key = `artifacts/${digest}`; const sourceKey = completion.outputs[0].location;
    await seed(); const before = await snapshot();
    await source.put(sourceKey, "tampered Attempt bytes");
    const denied = await complete(); assert.equal(denied.status, 409); assert.match(denied.value.receipt, /source-digest-mismatch/u);
    assert.deepEqual(await snapshot(), before); assert.equal(await destination.get(key), null);
    await source.put(sourceKey, bytes);
    const accepted = await complete(); assert.equal(accepted.status, 200, JSON.stringify(accepted)); assert.match(accepted.value.receipt, /artifactByteCustody=realm-verified/u);
    const retained = await destination.get(key); assert.ok(retained); assert.deepEqual(new Uint8Array(await retained.arrayBuffer()), bytes);
    const terminal = await snapshot(); assert.equal(terminal.runs[f.runId].status, "succeeded"); assert.match(terminal.evidence[accepted.value.value.evidence.id].receipt, /artifactByteCustody=realm-verified/u);
    await source.delete(sourceKey); assert.deepEqual(await complete(), accepted); assert.deepEqual(await snapshot(), terminal);
    // Re-seeding is an owned test-only fixture operation, never a product retry.
    // Confirm immutable destination conflict and subsequent operator restoration.
    await seed(); await source.put(sourceKey, bytes); await destination.put(key, "conflicting immutable bytes");
    const conflict = await complete(); assert.equal(conflict.status, 409); assert.match(conflict.value.receipt, /destination-digest-mismatch/u);
    assert.deepEqual(await snapshot(), before); assert.equal(await (await destination.get(key)).text(), "conflicting immutable bytes");
    await destination.delete(key); assert.equal((await complete()).status, 200);
    assert.deepEqual(new Uint8Array(await (await destination.get(key)).arrayBuffer()), bytes);
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
});
