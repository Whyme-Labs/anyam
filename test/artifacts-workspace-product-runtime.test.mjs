import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { artifactsProductState as seed } from "./fixtures/artifacts-product-state.mjs";
import { artifactsSelection } from "./fixtures/artifacts-binding.ts";

const path = "/api/workspaces/workspace%3Aa/repositories/source%3Aapp";

async function local(run) {
  const directory = await mkdtemp(join(tmpdir(), "anyam-workspace-product-"));
  let runtime;
  try {
    const bundle = await build({ entryPoints: ["test/fixtures/artifacts-workspace-product-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "artifacts-product-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalArtifactsWorkspaceRealm", useSQLite: true } }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage");
    runtime = new Miniflare(options);
    const invoke = async (url, body, method = body === undefined ? "GET" : "POST", member = "owner") => {
      const response = await runtime.dispatchFetch(`http://localhost${url}`, { method, headers: { "content-type": "application/json", "x-fixture-member": member }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const f = seed(); assert.equal((await invoke("/fixture/seed-recovery", f.fixture)).status, 200);
    const restart = async () => { await runtime.dispose(); runtime = new Miniflare(options); };
    await run({ invoke, restart, ...f });
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
test("public owner PUT materializes an exact Artifacts Workspace and replays across restart without credentials or authority mutation", async () => local(async ({ invoke, restart, fixture, input }) => {
  const before = (await invoke("/fixture/checkpoint")).value;
  assert.equal((await invoke(path, { ...input, baseCommitOid: "CLIENT-CREDENTIAL" }, "PUT")).status, 422);
  assert.equal((await invoke(path, { ...input, grantId: "grant:unknown" }, "PUT")).status, 404);
  assert.notEqual((await invoke(path, input, "PUT", "public")).status, 200);
  assert.equal((await invoke(path, input, "POST")).status, 405);
  assert.deepEqual((await invoke("/fixture/provider")).value.events, []);
  assert.equal((await invoke(path, { ...input, baseTreeOid: "0".repeat(40) }, "PUT")).status, 409);
  const [ready, concurrent] = await Promise.all([invoke(path, input, "PUT"), invoke(path, input, "PUT")]);
  assert.deepEqual(concurrent, ready);
  assert.equal(ready.status, 200, JSON.stringify(ready.value));
  assert.equal(ready.value.repository.id, "repository:artifacts:account-a:private:uuid-workspace-a");
  assert.equal(ready.value.baseCommitOid, artifactsSelection.baseCommitOid);
  assert.doesNotMatch(JSON.stringify(ready.value), /initial-secret|usable-secret|CLIENT-CREDENTIAL/u);
  const provider = (await invoke("/fixture/provider")).value;
  assert.equal(provider.events.filter(event => event.startsWith("fork:")).length, 1);
  assert.equal(provider.activeTokens, 0);
  assert.equal(provider.custody.length, 1);
  assert.doesNotMatch(JSON.stringify(provider.custody), /initial-secret|usable-secret/u);
  const after = (await invoke("/fixture/checkpoint")).value;
  assert.deepEqual(after.authority, before.authority);
  assert.deepEqual(after.sqlRows, before.sqlRows);
  assert.deepEqual(after.operationalCredentialRecords, before.operationalCredentialRecords);
  const { audit: beforeAudit, ...beforeIdentity } = before.identity;
  const { audit: afterAudit, ...afterIdentity } = after.identity;
  assert.deepEqual(afterIdentity, beforeIdentity, "no policy, Agent, session, Task or Grant is created");
  assert.ok(afterAudit.length > beforeAudit.length, "current policy decisions are audited");
  assert.deepEqual(after.keys["anyam/realm-identity/snapshot/v1"], after.identity, "policy audit survives through the identity KV boundary");
  assert.deepEqual((await invoke(path, input, "PUT")).value, ready.value);
  await restart();
  assert.deepEqual((await invoke(path, input, "PUT")).value, ready.value);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(event => event.startsWith("fork:")).length, 1);
  assert.deepEqual((await invoke("/fixture/provider")).value.custody, provider.custody);
  assert.equal((await invoke(path, { ...input, targetName: "different" }, "PUT")).status, 409);
  await invoke("/fixture/provider-fault", { fault: "recreated" });
  assert.equal((await invoke(path, input, "PUT")).status, 409);
  await invoke("/fixture/revoke", { sessionId: fixture.members.owner.session.id });
  assert.notEqual((await invoke(path, input, "PUT")).status, 200);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(event => event.startsWith("fork:")).length, 1);
}));
for (const fault of ["lost-fork", "retirement"]) test(`public Artifacts materialization retains ${fault} custody across restart and never retries the fork`, async () => local(async ({ invoke, restart, input }) => {
  await invoke("/fixture/provider-fault", { fault });
  const failed = await invoke(path, input, "PUT");
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.value), /initial-secret|usable-secret/u);
  const provider = (await invoke("/fixture/provider")).value;
  assert.equal(provider.custody.length, 1);
  assert.equal(JSON.parse(provider.custody[0].payload).pendingOperation, "fork");
  await restart();
  await invoke("/fixture/provider-fault", { fault: "none" });
  assert.equal((await invoke(path, input, "PUT")).status, 409);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(event => event.startsWith("fork:")).length, 1);
}));

test("public materialization preserves provider custody when identity audit persistence fails", async () => local(async ({ invoke, restart, input }) => {
  const before = (await invoke("/fixture/checkpoint")).value;
  await invoke("/fixture/fail-identity-write-once", {});
  assert.equal((await invoke(path, input, "PUT")).status, 503);
  const after = (await invoke("/fixture/checkpoint")).value;
  assert.deepEqual(after.identity, before.identity);
  assert.deepEqual(after.keys["anyam/realm-identity/snapshot/v1"], before.keys["anyam/realm-identity/snapshot/v1"]);
  assert.deepEqual(after.authority, before.authority);
  const provider = (await invoke("/fixture/provider")).value;
  assert.equal(provider.activeTokens, 0);
  assert.equal(provider.custody.length, 1);
  assert.equal(JSON.parse(provider.custody[0].payload).pendingOperation, "none");
  await restart();
  assert.equal((await invoke(path, input, "PUT")).status, 200);
  assert.equal((await invoke("/fixture/provider")).value.events.filter(event => event.startsWith("fork:")).length, 1);
}));
