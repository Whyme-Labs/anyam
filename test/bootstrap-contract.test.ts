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
