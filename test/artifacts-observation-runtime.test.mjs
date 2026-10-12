import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { RealmIdentityPolicy } from "../src/identity/realm.ts";
import { AuthorityPlaneCoordinator, AUTHORITY_COMMAND_PROTOCOL, emptyAuthorityPlaneSnapshot } from "../src/cloudflare/authority-plane.ts";
import { disclosureFixture } from "./fixtures/authority-disclosure-state.ts";

const repositoryPath = "/api/workspaces/workspace%3Aa/repositories/source%3Aapp";
function seed(base, tree, expiry = "2099-01-01T00:00:00Z") {
  const f = disclosureFixture();
  for (const session of Object.values(f.identity.sessions)) session.expiresAt = "2099-01-01T00:00:00Z";
  const identity = new RealmIdentityPolicy({ realmId: f.identity.realm.id, relyingPartyId: f.identity.realm.relyingPartyId, now: () => new Date("2026-10-02T12:00:00Z") });
  identity.restoreOperationalSnapshot(f.identity);
  const member = f.members.owner;
  identity.setSourceSpacePolicy({ sourceSpaceId: "source:app", classification: "restricted", readerPrincipalIds: [member.principal.id], allowedCapabilities: ["source.read", "workspace.write", "change.publish_revision"] });
  const c = new AuthorityPlaneCoordinator(emptyAuthorityPlaneSnapshot(f.identity.realm.id));
  const actor = { realmId: f.identity.realm.id, principalId: member.principal.id, actorId: member.session.actorId, sessionId: member.session.id, clientId: member.session.clientId, kind: "human", authorizationEpoch: identity.realm.authorizationEpoch };
  const execute = (command, payload) => { const result = c.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command, idempotencyKey: command, payload }, actor); assert.equal(result.status, "succeeded", JSON.stringify(result)); return result; };
  execute("project.create", { projectId: "project:test", projectRevisionId: "revision:base", name: "Actual Git fixture", sourceSpaces: [{ id: "source:app", name: "Source", classification: "restricted", snapshotId: base, repositoryId: "repository:artifacts:account-a:private:uuid-source" }] });
  execute("workspace.create", { projectId: "project:test", projectRevisionId: "revision:base", workspaceId: "workspace:a", sourceSpaceIds: ["source:app"] });
  execute("intent.create", { projectId: "project:test", intentId: "intent:a", title: "Verify an actual Git candidate" });
  execute("change.create", { projectId: "project:test", intentId: "intent:a", changeId: "change:a", workspaceId: "workspace:a" });
  const grant = identity.createOwnerTaskGrant({ sessionId: member.session.id, purpose: "Existing synthetic observation scope", resource: { realmId: identity.realm.id, projectId: "project:test", workspaceId: "workspace:a", sourceSpaceId: "source:app" }, sourceSpaceIds: ["source:app"], actions: ["source.read", "workspace.write"], effects: ["source.read", "workspace.write"], expiresAt: expiry });
  f.identity = identity.getRecoverySnapshot(); f.state = c.snapshot();
  return { fixture: f, authorization: { taskId: grant.task.id, grantId: grant.grant.id }, materialize: { taskId: grant.task.id, grantId: grant.grant.id, sourceRepositoryName: "source", targetName: "workspace-a", baseTreeOid: tree } };
}
async function local(run, expiryMilliseconds) {
  const directory = await mkdtemp(join(tmpdir(), "anyam-git-observation-")); let runtime;
  try {
    const gitDirectory = join(directory, "git"); await mkdir(gitDirectory);
    const git = (...args) => execFileSync("git", args, { cwd: gitDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--initial-branch=main");
    const commit = () => { git("add", "worker.js"); git("-c", "user.name=Owned fixture", "-c", "user.email=fixture@example.invalid", "commit", "--no-gpg-sign", "-m", "owned fixture"); return git("rev-parse", "HEAD"); };
    await writeFile(join(gitDirectory, "worker.js"), "export default {fetch(){return new Response('base')}};\n"); const base = commit(); const baseTree = git("rev-parse", "HEAD^{tree}");
    await writeFile(join(gitDirectory, "worker.js"), "export default {fetch(){return new Response('candidate')}};\n"); const candidate = commit(); const tree = git("rev-parse", "HEAD^{tree}");
    const commits = git("rev-list", "--parents", "HEAD").split("\n").map(line => { const [hash, ...parents] = line.split(" "); return { hash, treeHash: git("rev-parse", `${hash}^{tree}`), parents }; });
    const bundle = await build({ entryPoints: ["test/fixtures/artifacts-workspace-product-runtime.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
    const options = convertV4MiniflareOptions({ name: "observation-local", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-02", compatibilityFlags: ["nodejs_compat"], durableObjects: { REALM_COORDINATOR: { className: "LocalArtifactsWorkspaceRealm", useSQLite: true } }, r2Buckets: { ANYAM_REPOSITORY_STATE: "owned-observations" }, outboundService: () => new Response("outbound disabled", { status: 403 }) });
    options.telemetry = { enabled: false }; options.resourcePersistencePath = join(directory, "storage"); runtime = new Miniflare(options);
    const invoke = async (url, body, method = body === undefined ? "GET" : "POST", member = "owner", key) => {
      const response = await runtime.dispatchFetch(`http://localhost${url}`, { method, headers: { "content-type": "application/json", "x-fixture-member": member, ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    };
    const expiry = expiryMilliseconds ? new Date(Date.now() + expiryMilliseconds).toISOString() : "2099-01-01T00:00:00Z";
    const f = seed(base, baseTree, expiry); assert.equal((await invoke("/fixture/seed-recovery", f.fixture)).status, 200);
    await invoke("/fixture/provider-graph", { commits, head: base, sourceBase: base });
    assert.equal((await invoke(repositoryPath, f.materialize, "PUT")).status, 200);
    await invoke("/fixture/provider-graph", { commits, head: candidate });
    const input = { ...f.authorization, expectedSymbolicRef: "refs/heads/main", expectedCommitOid: candidate, expectedTreeOid: tree };
    const restart = async () => { await runtime.dispose(); runtime = new Miniflare(options); };
    await run({ invoke, restart, input, ...f, base, candidate, tree, commits, expiry });
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}
test("authenticated actual Git observation feeds the existing Observer and hosted publication without caller ancestry claims", async () => local(async ({ invoke, restart, input, fixture, base, candidate, tree }) => {
  const before = (await invoke("/fixture/checkpoint")).value.authority;
  assert.equal((await invoke(`${repositoryPath}/observations/1`, { ...input, ancestorCommitOids: [base] }, "PUT")).status, 422);
  assert.notEqual((await invoke(`${repositoryPath}/observations/1`, input, "PUT", "public")).status, 200);
  const ready = await invoke(`${repositoryPath}/observations/1`, input, "PUT");
  assert.equal(ready.status, 200, JSON.stringify(ready.value));
  assert.equal(ready.value.repositoryId, "repository:artifacts:account-a:private:uuid-source");
  const stored = (await invoke("/fixture/observation-state")).value.objects;
  assert.equal(stored.length, 2);
  const manifest = stored.find(item => !item.key.endsWith("index.json")).value;
  assert.equal(manifest.baseCommitOid, base); assert.equal(manifest.commitOid, candidate); assert.equal(manifest.treeOid, tree);
  assert.deepEqual(new Set(manifest.ancestorCommitOids), new Set([candidate, base]));
  assert.doesNotMatch(JSON.stringify(stored), /initial-secret|usable-secret/u);
  assert.deepEqual((await invoke("/fixture/checkpoint")).value.authority, before);
  assert.deepEqual((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).value, ready.value);
  await restart();
  assert.deepEqual((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).value, ready.value);
  assert.deepEqual((await invoke("/fixture/observation-state")).value.objects, stored);
  const workspace = fixture.state.workspaces["workspace:a"];
  const publication = await invoke("/api/changes/change%3Aa/revisions", { projectId: workspace.projectId, workspaceId: workspace.id, projectViewId: workspace.projectViewId, projectRevisionId: workspace.projectRevisionId, sourceSpaceSnapshots: { "source:app": candidate }, declaredEffects: [] }, "POST", "owner", "observed-candidate");
  assert.equal(publication.status, 200, JSON.stringify(publication.value));
  const authority = (await invoke("/fixture/checkpoint")).value.authority;
  const revision = Object.values(authority.changeRevisions)[0];
  assert.equal(revision.sourceSpaceObservations["source:app"].commitOid, candidate);
  assert.equal(revision.sourceSpaceObservations["source:app"].baseCommitOid, base);
  assert.equal(authority.canonicalByProject["project:test"], before.canonicalByProject["project:test"]);
}));
for (const fault of ["manifest", "index"]) test(`actual R2 ${fault} commit followed by interruption replays after restart without replacing its generation`, async () => local(async ({ invoke, restart, input }) => {
  await invoke("/fixture/observation-fault", { fault });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 503);
  const partial = (await invoke("/fixture/observation-state")).value.objects;
  assert.equal(partial.length, fault === "manifest" ? 1 : 2);
  const manifest = partial.find(item => !item.key.endsWith("index.json"));
  await restart();
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 200);
  const complete = (await invoke("/fixture/observation-state")).value.objects;
  assert.equal(complete.length, 2);
  assert.deepEqual(complete.find(item => !item.key.endsWith("index.json")), manifest);
}));
test("interrupted observation refuses a moved candidate and revoked session rather than activating stale state", async () => local(async ({ invoke, restart, input, commits, base, fixture }) => {
  await invoke("/fixture/observation-fault", { fault: "manifest" });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 503);
  await restart();
  await invoke("/fixture/provider-graph", { commits, head: base });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 409);
  assert.equal((await invoke("/fixture/observation-state")).value.objects.length, 1);
  await invoke("/fixture/revoke", { sessionId: fixture.members.owner.session.id });
  assert.notEqual((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 200);
  assert.equal((await invoke("/fixture/observation-state")).value.objects.length, 1);
}));

test("observation generations advance monotonically and reject mismatched ref, tree, and stale replay", async () => local(async ({ invoke, input }) => {
  assert.equal((await invoke(`${repositoryPath}/observations/1`, { ...input, expectedSymbolicRef: "refs/heads/unknown" }, "PUT")).status, 409);
  assert.equal((await invoke(`${repositoryPath}/observations/1`, { ...input, expectedTreeOid: "0".repeat(40) }, "PUT")).status, 409);
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 200);
  assert.equal((await invoke(`${repositoryPath}/observations/2`, input, "PUT")).status, 200);
  const before = (await invoke("/fixture/observation-state")).value;
  assert.equal(before.objects.find(item => item.key.endsWith("index.json")).value.latestGeneration, 2);
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 409);
  assert.deepEqual((await invoke("/fixture/observation-state")).value, before);
}));
test("expired interrupted observation cannot become active after restart", async () => local(async ({ invoke, restart, input, expiry }) => {
  await invoke("/fixture/observation-fault", { fault: "manifest" });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 503);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 50)));
  await restart();
  assert.notEqual((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 200);
  assert.equal((await invoke("/fixture/observation-state")).value.objects.length, 1);
}, 3500));

test("conditional native R2 activation refuses a concurrently advanced index", async () => local(async ({ invoke, restart, input }) => {
  await invoke("/fixture/observation-fault", { fault: "advance-index" });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 409);
  const before = (await invoke("/fixture/observation-state")).value;
  assert.equal(before.objects.find(item => item.key.endsWith("index.json")).value.latestGeneration, 2);
  await restart();
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 409);
  assert.deepEqual((await invoke("/fixture/observation-state")).value, before);
}));

test("interrupted observation refuses a recreated provider repository and changed Source binding", async () => local(async ({ invoke, restart, input, fixture }) => {
  await invoke("/fixture/observation-fault", { fault: "manifest" });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 503);
  await restart();
  await invoke("/fixture/provider-fault", { fault: "recreated" });
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 409);
  assert.equal((await invoke("/fixture/observation-state")).value.objects.length, 1);
  fixture.state.sourceSpaces["source:app"].repositoryId = "repository:artifacts:account-a:private:uuid-other-source";
  assert.equal((await invoke("/fixture/replace-authority", fixture.state)).status, 200);
  assert.equal((await invoke(`${repositoryPath}/observations/1`, input, "PUT")).status, 404);
  assert.equal((await invoke("/fixture/observation-state")).value.objects.length, 1);
}));
