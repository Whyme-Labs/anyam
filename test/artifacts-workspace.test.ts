import assert from "node:assert/strict";
import test from "node:test";
import { ArtifactsWorkspaceAdapter } from "../src/cloudflare/artifacts-workspace.ts";
import { artifactsBindingFixture, artifactsSelection } from "./fixtures/artifacts-binding.ts";

function adapter(fixture = artifactsBindingFixture()) {
  return { fixture, workspace: new ArtifactsWorkspaceAdapter({ artifacts: fixture.binding, accountId: "account-a", namespace: "private", authorize: fixture.authorize, now: () => fixture.now }) };
}

test("Artifacts forks independent credential-free Workspace repositories at the exact selected base", async () => {
  const { fixture, workspace } = adapter();
  const [first, second] = await Promise.all([
    workspace.forkWorkspace(artifactsSelection),
    workspace.forkWorkspace({ ...artifactsSelection, workspaceId: "workspace:b", projectViewId: "view:b", targetName: "workspace-b" }),
  ]);
  assert.equal(first.binding.repositoryId, "repository:artifacts:account-a:private:uuid-workspace-a");
  assert.equal(first.binding.workspaceId, "workspace:a");
  assert.equal(first.binding.sourceSpaceId, "source:app");
  assert.equal(first.repository.remote, "https://account-a.artifacts.cloudflare.net/git/private/workspace-a.git");
  assert.notEqual(first.repository.repositoryId, second.repository.repositoryId);
  assert.equal(fixture.activeTokens.size, 0, "initial fork tokens are retired before context release");
  assert.equal(first.storage, "process-local-contract");
  assert.equal(first.canonicalPublication, "unqualified");
  assert.doesNotMatch(JSON.stringify([first, second, fixture.events]), /initial-secret|usable-secret/);
  assert.ok(fixture.events.includes("fork:source:workspace-a:false:false"));
  assert.ok(fixture.events.includes("head:workspace-a:refs/heads/main:1"));
  assert.ok(fixture.events.includes("dispose:source"));
  assert.ok(fixture.events.includes("dispose:workspace-a"));
  await assert.rejects(workspace.forkWorkspace(artifactsSelection), { code: "artifacts.workspace_already_bound" });
});

test("Artifacts fails before mutation for denied or cross-boundary selections", async () => {
  for (const change of ["denied", "account", "namespace", "identity", "source-head", "source-tree"] as const) {
    const { fixture, workspace } = adapter();
    const selection = structuredClone(artifactsSelection);
    if (change === "denied") fixture.granted = false;
    if (change === "account") selection.sourceRepository.accountId = "account-b";
    if (change === "namespace") selection.sourceRepository.namespace = "other";
    if (change === "identity") fixture.infos.get("source")!.id = "recreated-source";
    if (change === "source-head") fixture.heads.set("source", [{ hash: "3".repeat(40), treeHash: selection.baseTreeOid }]);
    if (change === "source-tree") fixture.commits.set("source", { hash: selection.baseCommitOid, treeHash: "3".repeat(40) });
    await assert.rejects(workspace.forkWorkspace(selection));
    assert.equal(fixture.events.some(event => event.startsWith("fork:")), false, change);
    assert.equal(fixture.activeTokens.size, 0);
  }
});

test("Artifacts retires the fork token and withholds drifted or revoked Workspace context", async () => {
  for (const change of ["head", "tree", "identity", "remote", "grant"] as const) {
    const { fixture, workspace } = adapter();
    fixture.afterFork = () => {
      if (change === "head") fixture.heads.set("workspace-a", [{ hash: "3".repeat(40), treeHash: artifactsSelection.baseTreeOid }]);
      if (change === "tree") fixture.commits.set("workspace-a", { hash: artifactsSelection.baseCommitOid, treeHash: "3".repeat(40) });
      if (change === "identity") fixture.infos.get("workspace-a")!.id = "recreated-workspace";
      if (change === "remote") fixture.infos.get("workspace-a")!.remote = "https://account-b.artifacts.cloudflare.net/git/private/workspace-a.git";
      if (change === "grant") fixture.granted = false;
    };
    await assert.rejects(workspace.forkWorkspace(artifactsSelection));
    assert.equal(fixture.activeTokens.size, 0, change);
    assert.ok(fixture.events.includes("revoke:workspace-a"));
  }
});

test("Artifacts reports named reconciliation when fork or token retirement is uncertain", async () => {
  for (const change of ["lost-reply", "retirement"] as const) {
    const { fixture, workspace } = adapter();
    fixture.forkFails = change === "lost-reply";
    fixture.revokeSucceeds = change !== "retirement";
    await assert.rejects(workspace.forkWorkspace(artifactsSelection), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /workspace-a.*reconcile|reconcile.*workspace-a/i);
      assert.doesNotMatch(error.message, /secret data|initial-secret/);
      return true;
    });
    await assert.rejects(workspace.forkWorkspace(artifactsSelection), { code: "artifacts.workspace_already_bound" });
  }
});

test("Artifacts issues explicit read/write credentials only for enrolled Workspace forks and retires them on revoke", async () => {
  const { fixture, workspace } = adapter();
  const context = await workspace.forkWorkspace(artifactsSelection);
  const input = { repositoryId: context.binding.repositoryId, sourceSpaceId: context.binding.sourceSpaceId, expiresAt: new Date(fixture.now + 120_000).toISOString() };
  const read = await workspace.issue({ ...input, operation: "read" });
  assert.deepEqual(read.operations, ["read"]);
  assert.equal(read.workspaceId, "workspace:a");
  const write = await workspace.issue({ ...input, workspaceId: "workspace:a", operation: "write" });
  assert.deepEqual(write.operations, ["read", "write"]);
  assert.equal(write.audience, "aud:anyam:git");
  assert.equal(write.repositoryId, context.binding.repositoryId);
  assert.equal(write.canonicalWrite, false);
  assert.match(write.tokenDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(write.expiresAt, input.expiresAt);
  assert.ok(fixture.events.includes("mint:workspace-a:read:120"));
  assert.ok(fixture.events.includes("mint:workspace-a:write:120"));
  assert.equal(fixture.activeTokens.size, 2);
  await workspace.revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" });
  assert.equal(fixture.activeTokens.size, 0);
  await assert.rejects(workspace.issue({ ...input, operation: "read" }), { code: "artifacts.authorization_denied" });
  assert.doesNotMatch(JSON.stringify([context, fixture.events]), /initial-secret|usable-secret/);
});

test("Artifacts denies canonical, cross-context, expired and recreated repository credentials before minting", async () => {
  for (const change of ["canonical", "source", "workspace", "missing-workspace", "expired", "ttl-minimum", "revoked-grant", "recreated"] as const) {
    const { fixture, workspace } = adapter();
    const context = await workspace.forkWorkspace(artifactsSelection);
    const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", workspaceId: "workspace:a", operation: "write" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
    if (change === "canonical") request.repositoryId = "repository:artifacts:account-a:private:uuid-source";
    if (change === "source") request.sourceSpaceId = "source:peer";
    if (change === "workspace") request.workspaceId = "workspace:peer";
    if (change === "expired") request.expiresAt = new Date(fixture.now).toISOString();
    if (change === "ttl-minimum") request.expiresAt = new Date(fixture.now + 59_000).toISOString();
    if (change === "revoked-grant") fixture.granted = false;
    if (change === "recreated") fixture.infos.get("workspace-a")!.id = "recreated";
    const { workspaceId: _workspaceId, ...withoutWorkspace } = request;
    await assert.rejects(workspace.issue(change === "missing-workspace" ? withoutWorkspace : request));
    assert.equal(fixture.events.some(event => event.startsWith("mint:")), false, change);
  }
});

test("Artifacts retires a token rejected after an asynchronous mint and reports uncertain cleanup", async () => {
  for (const change of ["grant", "identity", "scope", "expiry", "cleanup", "lost-mint-reply"] as const) {
    const { fixture, workspace } = adapter();
    const context = await workspace.forkWorkspace(artifactsSelection);
    if (change === "scope") fixture.returnedScope = "write";
    if (change === "expiry") fixture.tokenExpiresAt = new Date(fixture.now + 1_000_000).toISOString();
    if (change === "cleanup") fixture.revokeSucceeds = false;
    if (change === "lost-mint-reply") fixture.mintFails = true;
    fixture.afterMint = () => {
      if (change === "grant" || change === "cleanup") fixture.granted = false;
      if (change === "identity") fixture.infos.get("workspace-a")!.id = "recreated-during-mint";
    };
    await assert.rejects(workspace.issue({ repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read", expiresAt: new Date(fixture.now + 120_000).toISOString() }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /usable-secret|initial-secret/);
      if (change === "cleanup" || change === "lost-mint-reply") assert.match(error.message, /reconcile.*repository|target=workspace-a/);
      return true;
    });
    assert.equal(fixture.activeTokens.size, change === "cleanup" || change === "lost-mint-reply" ? 1 : 0, change);
  }
});

test("Artifacts authorizes before credential-provider lookup and sanitizes lookup failure", async () => {
  const { fixture, workspace } = adapter();
  const context = await workspace.forkWorkspace(artifactsSelection);
  const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
  fixture.granted = false;
  fixture.events.length = 0;
  await assert.rejects(workspace.issue(request), { code: "artifacts.authorization_denied" });
  assert.equal(fixture.events.some(event => event.startsWith("get:")), false);
  fixture.granted = true;
  fixture.unavailableName = "workspace-a";
  await assert.rejects(workspace.issue(request), error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /usable-secret/);
    assert.match(error.message, /artifacts.provider_effect_unqualified/);
    return true;
  });
});

test("Artifacts blocks further issuance after an unknown mint until named token reconciliation", async () => {
  const { fixture, workspace } = adapter();
  const context = await workspace.forkWorkspace(artifactsSelection);
  const request = { repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read" as const, expiresAt: new Date(fixture.now + 120_000).toISOString() };
  fixture.mintFails = true;
  await assert.rejects(workspace.issue(request), { code: "artifacts.provider_effect_unqualified" });
  fixture.mintFails = false;
  await assert.rejects(workspace.issue(request), { code: "artifacts.authorization_denied" });
  assert.equal(fixture.mintedCount, 1);
  await assert.rejects(workspace.revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" }), { code: "artifacts.workspace_token_inventory_unknown" });
});

test("Artifacts revocation during a mint withholds and retires the new credential", async () => {
  const { fixture, workspace } = adapter();
  const context = await workspace.forkWorkspace(artifactsSelection);
  let revocation: Promise<void> | undefined;
  fixture.afterMint = () => { revocation = workspace.revokeWorkspace({ workspaceId: "workspace:a", sourceSpaceId: "source:app" }); };
  await assert.rejects(workspace.issue({ repositoryId: context.binding.repositoryId, sourceSpaceId: "source:app", operation: "read", expiresAt: new Date(fixture.now + 120_000).toISOString() }), { code: "artifacts.authorization_denied" });
  await revocation;
  assert.equal(fixture.activeTokens.size, 0);
});

test("Artifacts rejects a purported fork that aliases the canonical provider UUID", async () => {
  const { fixture, workspace } = adapter();
  fixture.forkedRepositoryId = "uuid-source";
  await assert.rejects(workspace.forkWorkspace(artifactsSelection), { code: "artifacts.fork_metadata_mismatch" });
  assert.equal(fixture.activeTokens.size, 0);
  assert.equal(fixture.events.some(event => event.startsWith("mint:")), false);
});
