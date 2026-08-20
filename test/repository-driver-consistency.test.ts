import assert from "node:assert/strict";
import test from "node:test";

import { LocalGitRepositoryDriver } from "../src/portability/local-git.ts";
import { SmartHttpRepositoryDriver } from "../src/portability/smart-http-driver.ts";
import type { RepositoryDriverCapabilityState, RepositoryDriverConsistencyCapabilities } from "../src/portability/repository-driver.ts";

const states: readonly RepositoryDriverCapabilityState[] = ["observed", "unverified", "unsupported"];

function assertConsistency(value: RepositoryDriverConsistencyCapabilities): void {
  for (const state of [value.durableBeforeAcknowledgement, value.linearizableRefPublication, value.readAfterWrite, value.replayAfterCacheLoss, value.exactExportRestore]) assert.ok(states.includes(state));
  assert.match(value.receipt, /provider=/u);
  assert.match(value.receipt, /providerFactsAreNotAnyamLimits=true/u);
}

test("RepositoryDriver descriptors expose conservative consistency and recovery receipts", async () => {
  const local = await new LocalGitRepositoryDriver("/tmp/anyam-driver-consistency-local").describe();
  const smart = await new SmartHttpRepositoryDriver({
    workspaceRoot: "/tmp/anyam-driver-consistency-smart",
    credentials: { issue: async () => ({ id: "credential:fixture", token: "fixture", audience: "aud:anyam:git", repositoryId: "repository:fixture", sourceSpaceId: "source:fixture", operations: ["read", "write"], canonicalWrite: false, tokenDigest: "sha256:fixture", expiresAt: new Date(Date.now() + 60_000).toISOString(), status: "active" }) },
    credentialExpiresAt: () => new Date(Date.now() + 60_000).toISOString(),
  }).describe();

  assert.equal(local.status, "succeeded");
  assert.equal(smart.status, "succeeded");
  if (local.status !== "succeeded" || smart.status !== "succeeded") return;
  assertConsistency(local.value.capabilities.consistency);
  assertConsistency(smart.value.capabilities.consistency);
  assert.equal(local.value.capabilities.consistency.linearizableRefPublication, "observed");
  assert.equal(local.value.capabilities.consistency.exactExportRestore, "observed");
  assert.equal(smart.value.capabilities.consistency.durableBeforeAcknowledgement, "unverified");
  assert.equal(smart.value.capabilities.consistency.replayAfterCacheLoss, "unsupported");
});
