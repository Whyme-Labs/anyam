import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { artifactsProductState } from "./fixtures/artifacts-product-state.mjs";
import { artifactsSelection } from "./fixtures/artifacts-binding.ts";
import { signArtifactRecoveryFixture } from "./fixtures/artifacts-recovery-envelope.ts";
import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "../apps/realm-worker/src/coordinator-protocol.ts";

const repositoryPath = "/api/workspaces/workspace%3Aa/repositories/source%3Aapp";
async function local(run) {
  const directory = await mkdtemp(join(tmpdir(), "anyam-artifacts-recovery-")); let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/artifacts-workspace-product-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "artifact-recovery-owned-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], bindings: { ANYAM_AUTHORITY_RECOVERY_KEY_ID: "synthetic-key", ANYAM_AUTHORITY_RECOVERY_SECRET: "synthetic-local-only" }, durableObjects: { REALM_COORDINATOR: { className: "LocalArtifactsWorkspaceRealm", useSQLite: true } }, r2Buckets: { ANYAM_REPOSITORY_STATE: "owned-repository-state" }, serviceBindings: { FIXTURE_RECOVERY_CONTROL: () => new Response("owned fault barrier") }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage"); runtime = new Miniflare(options);
    const invoke = async (path, body, method = body === undefined ? "GET" : "POST") => { const response = await runtime.dispatchFetch(`http://localhost${path}`, { method, headers: { "content-type": "application/json", "x-fixture-member": "owner", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
    const f = artifactsProductState(); assert.equal((await invoke("/fixture/seed-recovery", f.fixture)).status, 200);
    const sessionId = f.fixture.members.owner.session.id;
    const exportBundle = async () => { const result = await invoke("/authority/recovery/export/internal", { sessionId }); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.bundle; };
    const restore = bundle => invoke("/authority/recovery/restore/internal", { sessionId, idempotencyKey: `restore-${bundle.bundleId}`, bundle });
    const activate = bundle => invoke("/authority/recovery/activate/internal", { sessionId, idempotencyKey: `activate-${bundle.bundleId}`, bundleId: bundle.bundleId, bundleDigest: bundle.bundleDigest });
    const rows = async () => (await invoke("/fixture/artifact-recovery-rows")).value;
    const observe = generation => invoke(`${repositoryPath}/observations/${generation}`, { taskId: f.input.taskId, grantId: f.input.grantId, expectedSymbolicRef: "refs/heads/main", expectedCommitOid: artifactsSelection.baseCommitOid, expectedTreeOid: artifactsSelection.baseTreeOid }, "PUT");
    const restart = async () => { await runtime.dispose(); runtime = new Miniflare(options); };
    const cliFile = resolve("packages/create-anyam/src/anyam.ts"); const loader = resolve("node_modules/tsx/dist/loader.mjs");
    const cli = async (operation, flags) => {
      const base = (await runtime.ready).toString();
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", loader, cliFile, "realm", "recovery", operation, "--realm", base, "--session-stdin", "--json", ...flags], { cwd: directory, env: { PATH: process.env.PATH, ANYAM_STATE_HOME: join(directory, "state") }, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = ""; let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; }); child.once("error", reject);
        child.once("close", code => { try { resolve({ code, stdout, stderr, value: stdout.trim() ? JSON.parse(stdout) : undefined }); } catch (error) { reject(error); } });
        child.stdin.end("synthetic-owner\n");
      });
    };
    await run({ invoke, restart, rows, exportBundle, restore, activate, observe, cli, directory, ...f });
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
test("native recovery atomically restores Artifact bindings and journal, then preserves exact replay after restart", async () => local(async ({ invoke, restart, rows, exportBundle, restore, activate, observe, input }) => {
  const legacy = await exportBundle(); assert.equal(legacy.protocol, "anyam.authority-recovery/v1");
  assert.equal((await invoke(repositoryPath, input, "PUT")).status, 200);
  assert.equal((await observe(1)).status, 200); assert.equal((await observe(2)).status, 200);
  const before = await rows(); const r2 = (await invoke("/fixture/observation-state")).value;
  const checkpoint = (await invoke("/fixture/checkpoint")).value; const provider = (await invoke("/fixture/provider")).value;
  const signed = await exportBundle(); assert.equal(signed.protocol, "anyam.authority-recovery/v2"); assert.equal(signed.authoritySchemaVersion, 2); assert.equal(signed.artifacts.workspaces.length, 1); assert.equal(signed.artifacts.observations.length, 2); assert.doesNotMatch(JSON.stringify(signed), /initial-secret|usable-secret|synthetic-local-only/);
  assert.equal((await restore(legacy)).status, 409); assert.deepEqual(await rows(), before);
  await invoke("/fixture/artifact-recovery-mutate", { operation: "drop" }); assert.deepEqual(await rows(), { workspaces: [], observations: [] });
  assert.equal((await restore(signed)).status, 200); assert.deepEqual(await rows(), before);
  assert.deepEqual((await invoke("/fixture/observation-state")).value, r2);
  assert.deepEqual((await invoke("/fixture/checkpoint")).value.identity, checkpoint.identity);
  assert.deepEqual((await invoke("/fixture/provider")).value.events, provider.events);
  await restart(); assert.deepEqual(await rows(), before); assert.equal((await activate(signed)).status, 200);
  assert.equal((await invoke(repositoryPath, input, "PUT")).status, 200); assert.equal((await observe(2)).status, 200);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(value => value.startsWith("fork:")).length, 1);
}));
test("native recovery retains uncertain fork reservation without retrying the provider effect", async () => local(async ({ invoke, restart, rows, exportBundle, restore, activate, input }) => {
  await invoke("/fixture/provider-fault", { fault: "lost-fork" }); assert.equal((await invoke(repositoryPath, input, "PUT")).status, 503);
  const before = await rows(); assert.equal(JSON.parse(before.workspaces[0].payload).pendingOperation, "fork"); const signed = await exportBundle();
  await invoke("/fixture/artifact-recovery-mutate", { operation: "drop" }); assert.equal((await restore(signed)).status, 200); await restart(); assert.deepEqual(await rows(), before);
  assert.equal((await activate(signed)).status, 200); assert.equal((await invoke(repositoryPath, input, "PUT")).status, 409);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(value => value.startsWith("fork:")).length, 1);
}));
test("same Authority version cannot hide a newer Artifact generation or changed quarantined metadata", async () => local(async ({ invoke, rows, exportBundle, restore, activate, observe, input }) => {
  assert.equal((await invoke(repositoryPath, input, "PUT")).status, 200); assert.equal((await observe(1)).status, 200); const old = await exportBundle();
  assert.equal((await observe(2)).status, 200); const before = (await invoke("/fixture/checkpoint")).value; assert.equal(before.authority.version, old.expectedVersion); const artifactRows = await rows();
  assert.equal((await restore(old)).status, 409); assert.deepEqual(await rows(), artifactRows); assert.deepEqual((await invoke("/fixture/checkpoint")).value, before);
  const fresh = await exportBundle(); assert.equal((await restore(fresh)).status, 200);
  await invoke("/fixture/artifact-recovery-mutate", { operation: "tamper-generation" }); const changed = await rows();
  assert.equal((await activate(fresh)).status, 409); assert.equal((await restore(fresh)).status, 409); assert.deepEqual(await rows(), changed);
}));
test("native SQL/KV fault after Artifact insertion rolls back the complete recovery transaction", async () => local(async ({ invoke, rows, exportBundle, restore, input }) => {
  assert.equal((await invoke(repositoryPath, input, "PUT")).status, 200); const signed = await exportBundle();
  await invoke("/fixture/artifact-recovery-mutate", { operation: "drop" }); const checkpoint = (await invoke("/fixture/checkpoint")).value;
  await invoke("/fixture/fail-recovery-write-once", { stage: "after-sql" });
  const failed = await restore(signed); assert.equal(failed.status, 503); assert.match(failed.value.receipt, /unconfirmed/); assert.doesNotMatch(JSON.stringify(failed.value), /owned recovery fault|synthetic-local-only/);
  assert.deepEqual(await rows(), { workspaces: [], observations: [] }); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint);
  assert.equal((await restore(signed)).status, 200); assert.equal((await rows()).workspaces.length, 1);
}));

test("native restore rejects signed incompatible and inconsistent metadata without changing SQL, KV or provider state", async () => local(async ({ invoke, rows, exportBundle, restore, observe, input }) => {
  assert.equal((await invoke(repositoryPath, input, "PUT")).status, 200); assert.equal((await observe(1)).status, 200);
  const signed = await exportBundle(); const before = await rows(); const checkpoint = (await invoke("/fixture/checkpoint")).value; const provider = (await invoke("/fixture/provider")).value;
  for (const value of [
    { ...signed, authoritySchemaVersion: 99 },
    { ...signed, artifacts: { ...signed.artifacts, schemaVersion: 99 } },
    { ...signed, artifacts: { ...signed.artifacts, workspaces: [] } },
  ]) {
    const invalid = signArtifactRecoveryFixture(value, "synthetic-local-only");
    const rejected = await restore(invalid);
    assert.equal(rejected.status, 422); assert.match(rejected.value.receipt, /artifacts-schema-or-state-invalid; restore=not-applied/);
    assert.deepEqual(await rows(), before); assert.deepEqual((await invoke("/fixture/checkpoint")).value, checkpoint); assert.deepEqual((await invoke("/fixture/provider")).value, provider);
  }
}));

test("actual operator CLI preserves and restores a v2 Artifact checkpoint through private files and restart", async () => local(async ({ invoke, rows, observe, input, cli, directory, restart }) => {
  assert.equal((await invoke(repositoryPath, input, "PUT")).status, 200); assert.equal((await observe(1)).status, 200);
  const accepted = async action => { const result = await action; assert.equal(result.code, 0, result.stderr || result.stdout); assert.doesNotMatch(result.stdout + result.stderr, /synthetic-owner|synthetic-local-only|initial-secret|usable-secret/); assert.equal(Object.hasOwn(result.value, "bundle"), false); return result.value; };
  const file = join(directory, "checkpoint.json"); const receipt = join(directory, "receipt.json"); const before = await rows();
  await accepted(cli("export", ["--output", file])); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const signed = JSON.parse(await readFile(file, "utf8")); assert.equal(signed.protocol, "anyam.authority-recovery/v2"); assert.equal(signed.artifacts.observations.length, 1);
  await invoke("/fixture/artifact-recovery-mutate", { operation: "drop" });
  const restored = await accepted(cli("restore", ["--input", file, "--output", receipt, "--idempotency-key", "cli-restore-v2"])); assert.equal(restored.bundleDigest, signed.bundleDigest); assert.equal((await stat(receipt)).mode & 0o777, 0o600); assert.deepEqual(await rows(), before);
  await restart(); await accepted(cli("activate", ["--input", receipt, "--idempotency-key", "cli-activate-v2"])); assert.deepEqual(await rows(), before);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(value => value.startsWith("fork:")).length, 1);
}));
