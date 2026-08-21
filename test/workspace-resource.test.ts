import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceBoundary, WorkspaceBoundaryError } from "../packages/create-anyam/src/workspace-boundary.ts";

const validLimits = {
  maxProcesses: 256,
  maxAddressSpaceBytes: 1_000_000_000,
  maxCpuSeconds: 30,
  maxOpenFiles: 1024,
  maxFileBytes: 64_000_000,
  maxWorkspaceBytes: 128_000_000,
  monitorIntervalMs: 250,
  receipt: "measurement=workspace-resource-fixture; source=test",
};

test("Workspace resource policies require a measurement receipt", async () => {
  await assert.rejects(
    () => createWorkspaceBoundary({ sourceDirectory: process.cwd(), stateDirectory: process.cwd(), projectId: "project:test", changeId: "change:test", workspaceId: "workspace:test", mode: "supervised", resourceLimits: { ...validLimits, receipt: "" } }),
    (error: unknown) => error instanceof WorkspaceBoundaryError && error.code === "workspace.resource_receipt_missing" && /receipt-required/u.test(error.receipt ?? ""),
  );
});

test("Workspace resource policies reject non-positive tripwires with an actionable receipt", async () => {
  await assert.rejects(
    () => createWorkspaceBoundary({ sourceDirectory: process.cwd(), stateDirectory: process.cwd(), projectId: "project:test", changeId: "change:test", workspaceId: "workspace:test", mode: "supervised", resourceLimits: { ...validLimits, maxOpenFiles: 0 } }),
    (error: unknown) => error instanceof WorkspaceBoundaryError && error.code === "workspace.resource_limits_invalid" && /maxOpenFiles/u.test(error.receipt ?? ""),
  );
});
