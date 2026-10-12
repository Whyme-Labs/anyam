import assert from "node:assert/strict";
import test from "node:test";

import { bootstrapCommand, bootstrapPath } from "../apps/realm-worker/src/bootstrap-contract.ts";

test("typed REST bootstrap applies the shared Workspace mount validator before Authority", () => {
  assert.throws(
    () => bootstrapCommand(
      bootstrapPath("/api/projects/project%3Amount/workspaces"),
      {
        projectRevisionId: "revision:base",
        sourceSpaceIds: ["source:one", "source:two"],
        mounts: ["Public\\Web", "public/web"],
      },
      "mounts:rest-case",
    ),
    (error: unknown) => error instanceof Error
      && error.message.includes("collides")
      && "receipt" in error
      && String(error.receipt).includes("mount-path-duplicate")
      && "recoveryAction" in error
      && String(error.recoveryAction).includes("unique"),
  );
});

const ownerSourcePayload = {
  projectId: "project:owner-readable", name: "Owner-readable source", sourceAccess: "owner-read",
  sourceSpaces: [{ id: "source:owner-readable", name: "Selected repository", classification: "restricted", repositoryId: "repository:synthetic", snapshotId: "1111111111111111111111111111111111111111" }],
};

test("typed Project bootstrap accepts only the explicit owner-read Source access profile", () => {
  const path = bootstrapPath("/api/projects");
  assert.equal(bootstrapCommand(path, ownerSourcePayload, "source-registration").payload.sourceAccess, "owner-read");
  for (const value of [null, true, "public", "owner-write", " owner-read", []]) {
    assert.throws(() => bootstrapCommand(path, { ...ownerSourcePayload, sourceAccess: value }, "source-registration"));
  }
  const { sourceAccess: _access, ...legacy } = ownerSourcePayload;
  assert.equal(bootstrapCommand(path, legacy, "legacy").payload.sourceAccess, undefined);
});
