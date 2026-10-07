import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactsWorkspaceAdapter } from "../src/cloudflare/artifacts-workspace.ts";
import { MemoryArtifactsWorkspaceStore } from "../src/cloudflare/artifacts-workspace-store.ts";
import { repositoryObservationDigest } from "../src/portability/repository-observation.ts";
import { artifactsBindingFixture, artifactsSelection } from "./fixtures/artifacts-binding.ts";

async function observationFixture() {
  const fixture = artifactsBindingFixture();
  const store = new MemoryArtifactsWorkspaceStore();
  const control = new ArtifactsWorkspaceAdapter({ artifacts: fixture.binding, accountId: "account-a", namespace: "private", authorize: fixture.authorize, now: () => fixture.now, store });
  const context = await control.forkWorkspace(artifactsSelection);
  const graph = new Map([
    ["1".repeat(40), { hash: "1".repeat(40), treeHash: "2".repeat(40), parents: [] as string[] }],
    ["3".repeat(40), { hash: "3".repeat(40), treeHash: "4".repeat(40), parents: [] as string[] }],
    ["5".repeat(40), { hash: "5".repeat(40), treeHash: "6".repeat(40), parents: ["3".repeat(40), "1".repeat(40)] }],
  ]);
  let head = "5".repeat(40);
  const reads: string[] = [];
  const get = fixture.binding.get.bind(fixture.binding);
  fixture.binding.get = async name => {
    const repo = await get(name);
    return { ...repo,
      async log(input) { assert.equal(input.ref, "refs/heads/main"); return [graph.get(head)!]; },
      async readCommit(oid) { reads.push(oid); return graph.get(oid) ?? null; },
    };
  };
  const request = { repository: { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app" }, workspaceId: "workspace:a", projectViewId: "view:a", expectedSymbolicRef: "refs/heads/main", expectedCommitOid: "5".repeat(40), expectedTreeOid: "6".repeat(40), expectedBaseCommitOid: "1".repeat(40), expectedObjectFormat: "sha1" as const };
  return { fixture, control, store, context, graph, reads, request, moveHead: (oid: string) => { head = oid; } };
}

test("Artifacts observes a fresh exact Workspace candidate and complete non-first-parent ancestry", async () => {
  const { control, graph, reads, request } = await observationFixture();
  const result = await control.observeRepository(request);
  assert.equal(result.status, "succeeded");
  if (result.status !== "succeeded") return;
  assert.equal(result.value.commitOid, "5".repeat(40));
  assert.equal(result.value.treeOid, "6".repeat(40));
  assert.equal(result.value.baseCommitOid, "1".repeat(40));
  assert.equal(result.value.ancestryVerified, true);
  assert.deepEqual(new Set(reads), new Set(graph.keys()), "all reachable parents must be read, including the non-first-parent base");
  assert.equal(result.value.manifestDigest, await repositoryObservationDigest(result.value));
  assert.doesNotMatch(JSON.stringify(result), /usable-secret|initial-secret/);
});

test("Artifacts observation rejects mismatched authority, exact candidate and incomplete ancestry", async () => {
  const outcomes: string[] = [];
  for (const condition of ["workspace", "view", "source", "account", "namespace", "grant", "ref", "commit", "tree", "format", "base", "missing-parent", "missing-parents", "cycle", "wrong-object"] as const) {
    const { fixture, control, store, graph, request } = await observationFixture();
    if (condition === "workspace") request.workspaceId = "workspace:peer";
    if (condition === "view") request.projectViewId = "view:peer";
    if (condition === "source") request.repository.sourceSpaceId = "source:peer";
    if (condition === "grant") fixture.granted = false;
    if (condition === "ref") request.expectedSymbolicRef = "refs/heads/*";
    if (condition === "commit") request.expectedCommitOid = "7".repeat(40);
    if (condition === "tree") request.expectedTreeOid = "8".repeat(40);
    if (condition === "format") Object.assign(request, { expectedObjectFormat: "sha256" });
    if (condition === "base") request.expectedBaseCommitOid = "9".repeat(40);
    if (condition === "missing-parent") graph.delete("3".repeat(40));
    if (condition === "missing-parents") Object.assign(graph.get("3".repeat(40))!, { parents: undefined });
    if (condition === "cycle") graph.get("3".repeat(40))!.parents.push("5".repeat(40));
    if (condition === "wrong-object") graph.get("3".repeat(40))!.hash = "7".repeat(40);
    const observer = condition === "account" || condition === "namespace"
      ? new ArtifactsWorkspaceAdapter({ artifacts: fixture.binding, accountId: condition === "account" ? "account-b" : "account-a", namespace: condition === "namespace" ? "other" : "private", authorize: fixture.authorize, now: () => fixture.now, store })
      : control;
    const result = await observer.observeRepository(request);
    outcomes.push(`${condition}:${result.status}`);
    assert.doesNotMatch(JSON.stringify(result), /usable-secret|initial-secret/, condition);
    assert.equal(fixture.mintedCount, 0, condition);
  }
  assert.deepEqual(outcomes, ["workspace", "view", "source", "account", "namespace", "grant", "ref", "commit", "tree", "format", "base", "missing-parent", "missing-parents", "cycle", "wrong-object"].map(condition => `${condition}:failed`));
});

test("Artifacts observation rechecks ref, provider identity and authority after graph traversal", async () => {
  const outcomes: string[] = [];
  for (const condition of ["ref-moved", "uuid-recreated", "grant-revoked", "caller-mutated", "provider-error"] as const) {
    const { fixture, control, request, moveHead } = await observationFixture();
    const get = fixture.binding.get.bind(fixture.binding);
    let changed = false;
    fixture.binding.get = async name => {
      const repo = await get(name);
      return { ...repo, async readCommit(oid) {
        const commit = await repo.readCommit(oid);
        if (!changed) {
          changed = true;
          if (condition === "ref-moved") moveHead("3".repeat(40));
          if (condition === "uuid-recreated") fixture.infos.get("workspace-a")!.id = "replacement-uuid";
          if (condition === "grant-revoked") fixture.granted = false;
          if (condition === "caller-mutated") { request.expectedCommitOid = "7".repeat(40); request.repository.sourceSpaceId = "source:peer"; }
          if (condition === "provider-error") throw new Error("provider failure with usable-secret and initial-secret");
        }
        return commit;
      } };
    };
    const result = await control.observeRepository(request);
    outcomes.push(`${condition}:${result.status}`);
    assert.doesNotMatch(JSON.stringify(result), /usable-secret|initial-secret/);
    if (condition === "caller-mutated" && result.status === "succeeded") {
      assert.equal(result.value.commitOid, "5".repeat(40));
      assert.equal(result.value.sourceSpaceId, "source:app");
    }
  }
  assert.deepEqual(outcomes, ["ref-moved:failed", "uuid-recreated:failed", "grant-revoked:failed", "caller-mutated:succeeded", "provider-error:failed"]);
});

test("Artifacts observation snapshots provider head metadata before asynchronous graph reads", async () => {
  const { fixture, control, graph, reads, request } = await observationFixture();
  const sharedHead = graph.get(request.expectedCommitOid)!;
  const get = fixture.binding.get.bind(fixture.binding);
  fixture.binding.get = async name => {
    const repo = await get(name);
    return { ...repo, async readCommit(oid) {
      const commit = await repo.readCommit(oid);
      if (oid === "3".repeat(40)) {
        sharedHead.hash = "7".repeat(40);
        sharedHead.treeHash = "8".repeat(40);
      }
      return commit;
    } };
  };
  const result = await control.observeRepository(request);
  assert.equal(result.status, "failed", "a reused mutable provider object must not authorize an untraversed candidate");
  assert.equal(reads.includes("7".repeat(40)), false);
});
