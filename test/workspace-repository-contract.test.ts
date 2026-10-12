import assert from "node:assert/strict";
import test from "node:test";
import { workspaceRepositoryInput, workspaceRepositoryPath, WorkspaceRepositoryInputError } from "../apps/realm-worker/src/workspace-repository-contract.ts";

const path = { workspaceId: "workspace:a", sourceSpaceId: "source:app" };
const body = { taskId: "task:current", grantId: "grant:current", sourceRepositoryName: "source", targetName: "workspace-a", baseTreeOid: "2".repeat(40) };
test("Workspace repository contract binds path selectors and rejects caller authority, credentials and malformed bodies", () => {
  assert.deepEqual(workspaceRepositoryInput(body, path), { ...path, ...body });
  for (const value of [null, [], { ...body, sessionId: "SYNTHETIC-CREDENTIAL" }, { ...body, workspaceId: "workspace:other" }, { ...body, baseCommitOid: "1".repeat(40) }, { ...body, accountId: "other" }, { ...body, baseTreeOid: "main" }, { ...body, grantId: undefined }, { ...body, targetName: "source" }, { ...body, sourceRepositoryName: "../source" }]) {
    assert.throws(() => workspaceRepositoryInput(value, path), error => error instanceof WorkspaceRepositoryInputError && !error.message.includes("SYNTHETIC-CREDENTIAL"));
  }
});
test("Workspace repository paths use exactly one safe URL-encoded Workspace and Source identifier", () => {
  assert.deepEqual(workspaceRepositoryPath("/api/workspaces/workspace%3Aa/repositories/source%3Aapp"), path);
  assert.equal(workspaceRepositoryPath("/api/workspaces/workspace%3Aa"), undefined);
  for (const value of ["/api/workspaces/a/repositories", "/api/workspaces/a/repositories/source/extra", "/api/workspaces/a%2Fb/repositories/source", "/api/workspaces/%00/repositories/source", "/api/workspaces/a/repositories/%zz"]) assert.deepEqual(workspaceRepositoryPath(value), { malformed: true });
});
