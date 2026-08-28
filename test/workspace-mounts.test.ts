import assert from "node:assert/strict";
import test from "node:test";

import {
  validateWorkspaceMounts,
  WorkspaceMountValidationError,
  WORKSPACE_MOUNT_VALIDATION_PROTOCOL,
} from "../src/kernel/workspace-mounts.ts";

function mounts(...values: readonly [string, string][]) {
  return values.map(([sourceSpaceId, mountPath]) => ({ sourceSpaceId, mountPath }));
}

function rejects(code: WorkspaceMountValidationError["code"], sourceSpaceIds: readonly unknown[], workspaceMounts: readonly unknown[]) {
  assert.throws(
    () => validateWorkspaceMounts({ sourceSpaceIds, mounts: workspaceMounts }),
    (error: unknown) => error instanceof WorkspaceMountValidationError && error.code === code && error.receipt.includes(`protocol=${WORKSPACE_MOUNT_VALIDATION_PROTOCOL}`),
  );
}

test("Workspace mount validation returns a complete normalized bijection", () => {
  assert.deepEqual(
    validateWorkspaceMounts({ sourceSpaceIds: ["source:public", "source:private"], mounts: mounts(["source:public", "public\\web"], ["source:private", "private/codec"]) }),
    mounts(["source:public", "public/web"], ["source:private", "private/codec"]),
  );
});

test("Workspace mount validation rejects missing, extra, and duplicate Source Space mappings", () => {
  rejects("mount-count-mismatch", ["source:one", "source:two"], mounts(["source:one", "one"]));
  rejects("mount-source-undisclosed", ["source:one"], mounts(["source:one", "one"], ["source:two", "two"]));
  rejects("source-space-duplicate", ["source:one", "source:one"], mounts(["source:one", "one"], ["source:one", "two"]));
  rejects("mount-source-duplicate", ["source:one", "source:two"], mounts(["source:one", "one"], ["source:one", "two"]));
  rejects("mount-source-undisclosed", ["source:one"], mounts(["source:two", "two"]));
});

test("Workspace mount validation rejects ambiguous paths across platforms", () => {
  rejects("mount-path-duplicate", ["source:one", "source:two"], mounts(["source:one", "Public/Web"], ["source:two", "public\\web"]));
  rejects("mount-path-overlap", ["source:one", "source:two"], mounts(["source:one", "source"], ["source:two", "SOURCE/private"]));
  rejects("mount-invalid", ["source:one"], mounts(["source:one", "./source"]));
  rejects("mount-invalid", ["source:one"], mounts(["source:one", "source/../escape"]));
  rejects("mount-invalid", ["source:one"], mounts(["source:one", "/absolute"]));
  rejects("mount-invalid", ["source:one"], mounts(["source:one", "C:\\workspace"]));
  rejects("mount-invalid", ["source:one"], mounts(["source:one", "C:relative"]));
  rejects("mount-invalid", ["source:one"], mounts(["source:one", "source//nested"]));
});

test("Workspace mount validation receipts identify both sides of a collision", () => {
  assert.throws(
    () => validateWorkspaceMounts({ sourceSpaceIds: ["source:one", "source:two"], mounts: mounts(["source:one", "source"], ["source:two", "source/private"]) }),
    (error: unknown) => error instanceof WorkspaceMountValidationError
      && error.code === "mount-path-overlap"
      && error.sourceSpaceId === "source:two"
      && error.mountPath === "source/private"
      && error.conflictingSourceSpaceId === "source:one"
      && error.conflictingMountPath === "source"
      && error.recoveryAction.length > 0,
  );
});
