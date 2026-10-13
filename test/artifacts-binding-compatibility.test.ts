import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactsWorkspaceAdapter } from "../src/cloudflare/artifacts-workspace.ts";
import { artifactsBindingFixture, artifactsSelection } from "./fixtures/artifacts-binding.ts";

function setup() {
  const fixture = artifactsBindingFixture();
  const control = new ArtifactsWorkspaceAdapter({ artifacts: fixture.binding, accountId: "account-a", namespace: "private", authorize: fixture.authorize, now: () => fixture.now });
  return { fixture, control };
}

test("Artifacts materializes with the observed no-code missing error and short-branch-only responses", async () => {
  const { fixture, control } = setup();
  // Only nonsecret object identities and response shape from the Oct13 trial.
  const base = { hash: "9b9026bcee3ebfcbde25030ebf52f078585088a4", treeHash: "0214f42bce2f1cb956addaf722ec8c1ea2a79afb", parents: ["b904e7e833a9e715ad0eaf5026a0b923e5f14581"] };
  fixture.commits.set("source", base); fixture.heads.set("source", [base]);
  await assert.rejects(fixture.binding.get("workspace-a"), error => {
    assert.ok(error instanceof Error); assert.equal("code" in error, false); return true;
  });
  using source = await fixture.binding.get("source");
  assert.deepEqual(await source.log({ ref: "refs/heads/main", limit: 1 }), []);
  assert.deepEqual(await source.log({ ref: "HEAD", limit: 1 }), []);
  assert.deepEqual(await source.log({ ref: "main", limit: 1 }), [base]);
  const result = await control.materializeWorkspace({ ...artifactsSelection, baseCommitOid: base.hash, baseTreeOid: base.treeHash });
  assert.equal(result.selection.baseCommitOid, base.hash);
  assert.equal(fixture.events.filter(value => value.startsWith("fork:")).length, 1);
  assert.equal(fixture.activeTokens.size, 0);
});

test("Artifacts uses a nested provider default branch without adding a full-ref prefix", async () => {
  const { fixture, control } = setup();
  fixture.infos.get("source")!.defaultBranch = "feature/worker";
  await control.materializeWorkspace(artifactsSelection);
  assert.ok(fixture.events.includes("head:source:feature/worker:1"));
  assert.ok(fixture.events.includes("head:workspace-a:feature/worker:1"));
  assert.equal(fixture.activeTokens.size, 0);
});

test("Artifacts proves vacancy only after every inventory page and rechecks authority", async () => {
  const { fixture, control } = setup();
  const reads: (string | undefined)[] = [];
  fixture.binding.list = async options => {
    reads.push(options?.cursor);
    return options?.cursor === undefined
      ? { repos: [{ id: "uuid-source", name: "source" }], total: 2, cursor: "next-page" }
      : { repos: [{ id: "uuid-other", name: "other" }], total: 2 };
  };
  await control.materializeWorkspace(artifactsSelection);
  assert.deepEqual(reads, [undefined, "next-page"]);
  assert.equal(fixture.events.filter(value => value.startsWith("fork:")).length, 1);
  const denied = setup();
  denied.fixture.binding.list = async () => { denied.fixture.granted = false; return { repos: [], total: 0 }; };
  await assert.rejects(denied.control.materializeWorkspace(artifactsSelection), { code: "artifacts.authorization_denied" });
  assert.equal(denied.fixture.events.some(value => value.startsWith("fork:")), false);
});

for (const status of ["ready", "importing", "forking"]) test(`Artifacts refuses an occupied ${status} target on a later inventory page`, async () => {
  const { fixture, control } = setup();
  fixture.binding.list = async options => options?.cursor === undefined
    ? { repos: [{ id: "uuid-source", name: "source", status: "ready" }], total: 2, cursor: "next-page" }
    : { repos: [{ id: "uuid-unrelated", name: "workspace-a", status }], total: 2 };
  await assert.rejects(control.materializeWorkspace(artifactsSelection), { code: "artifacts.workspace_already_bound" });
  assert.equal(fixture.events.some(value => value.startsWith("fork:")), false);
  assert.equal(fixture.activeTokens.size, 0);
});

for (const condition of ["not-found-message", "unavailable", "missing-page", "missing-total", "incomplete", "excess", "changed-total", "repeated-cursor", "empty-cursor", "empty-advancing-page", "cursor-after-total", "duplicate-name", "duplicate-id", "malformed-repo"]) test(`Artifacts fails closed on ${condition} inventory without exposing provider data`, async () => {
  const { fixture, control } = setup();
  const entry = { id: "uuid-source", name: "source" };
  fixture.binding.list = async options => {
    if (condition === "not-found-message") throw new Error("NOT_FOUND: usable-secret");
    if (condition === "unavailable") throw new Error("provider unavailable: usable-secret");
    if (condition === "missing-page") return null;
    if (condition === "missing-total") return { repos: [] };
    if (condition === "incomplete") return { repos: [entry], total: 2 };
    if (condition === "excess") return { repos: [entry], total: 0 };
    if (condition === "empty-cursor") return { repos: [entry], total: 1, cursor: "" };
    if (condition === "empty-advancing-page") return { repos: [], total: 1, cursor: "unused-cursor" };
    if (condition === "cursor-after-total") return { repos: [entry], total: 1, cursor: "unused-cursor" };
    if (condition === "duplicate-name") return { repos: [entry, { ...entry, id: "other-id" }], total: 2 };
    if (condition === "duplicate-id") return { repos: [entry, { ...entry, name: "other" }], total: 2 };
    if (condition === "malformed-repo") return { repos: [{ name: "source", id: null }], total: 1 };
    if (options?.cursor === undefined) return { repos: [entry], total: 2, cursor: "next-page" };
    return { repos: [{ id: "uuid-other", name: "other" }], total: condition === "changed-total" ? 3 : 2, cursor: condition === "repeated-cursor" ? "next-page" : undefined };
  };
  await assert.rejects(control.materializeWorkspace(artifactsSelection), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /usable-secret/); return true;
  });
  assert.equal(fixture.events.some(value => value.startsWith("fork:")), false);
  assert.equal(fixture.activeTokens.size, 0);
});

test("Artifacts validates short-branch heads independently of the missing-error shape", async () => {
  const { fixture, control } = setup();
  const get = fixture.binding.get.bind(fixture.binding);
  fixture.binding.get = async name => {
    if (!fixture.infos.has(name)) throw Object.assign(new Error("synthetic legacy missing code"), { code: "NOT_FOUND" });
    return get(name);
  };
  await control.materializeWorkspace(artifactsSelection);
  assert.ok(fixture.events.includes("head:source:main:1"));
  assert.ok(fixture.events.includes("head:workspace-a:main:1"));
  assert.equal(fixture.activeTokens.size, 0);
});
