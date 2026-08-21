import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { GitHubActionsBridgeCapability } from "../src/portability/github-actions-bridge.ts";
import {
  GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL,
  GitHubActionsBridgeImportCoordinator,
  type GitHubActionsBridgeHistoryObservation,
  type GitHubActionsBridgeSourcePackage,
} from "../src/portability/github-actions-bridge-import.ts";

const now = "2026-08-22T00:00:00.000Z";
const bundleBytes = new TextEncoder().encode("git bundle fixture\n");
const bundleDigest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;

function capability(overrides: Partial<GitHubActionsBridgeCapability> = {}): GitHubActionsBridgeCapability {
  return {
    protocol: "anyam.github-actions-bridge/v1",
    id: "github-bridge-capability:one",
    connectionId: "github-bridge:one",
    realmId: "realm:customer",
    projectId: "project:atlas",
    sourceSpaceId: "source:private",
    operation: "inbound",
    repositoryOwnerId: "774812",
    repositoryId: "92834123",
    workflowRef: "acme/private-platform/.github/workflows/anyam-bridge.yml@refs/heads/main",
    workflowSha: "workflow-sha-1",
    runId: "run:one",
    jtiDigest: "sha256:jti",
    issuedAt: "2026-08-21T23:59:00.000Z",
    expiresAt: "2026-08-22T00:05:00.000Z",
    status: "active",
    canonicalWrite: false,
    receipt: "fixture=capability; credentialMaterialStored=false",
    ...overrides,
  };
}

function sourcePackage(overrides: Partial<GitHubActionsBridgeSourcePackage> = {}): GitHubActionsBridgeSourcePackage {
  return {
    protocol: GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL,
    operationId: "bridge-import:one",
    capabilityId: "github-bridge-capability:one",
    realmId: "realm:customer",
    projectId: "project:atlas",
    sourceSpaceId: "source:private",
    repositoryOwnerId: "774812",
    repositoryId: "92834123",
    runId: "run:one",
    objectFormat: "sha1",
    defaultBranch: "main",
    refs: [{ name: "refs/heads/main", oid: "commit:one" }],
    bundle: { bytes: bundleBytes, digest: bundleDigest, declaredBytes: bundleBytes.byteLength },
    lfs: { state: "empty", objects: [] },
    ...overrides,
  };
}

function history(relation: GitHubActionsBridgeHistoryObservation["relation"]): GitHubActionsBridgeHistoryObservation {
  return {
    source: "repository-driver",
    objectFormat: "sha1",
    canonicalRefs: relation === "empty" ? [] : [{ name: "refs/heads/main", oid: relation === "same" || relation === "canonical-ahead" ? "commit:one" : "commit:canonical" }],
    githubRefs: [{ name: "refs/heads/main", oid: relation === "canonical-ahead" || relation === "same" || relation === "empty" ? "commit:one" : "commit:github" }],
    relation,
    receipt: `fixture=repository-driver; relation=${relation}; credentialMaterialStored=false`,
  };
}

function importer() {
  const calls: string[] = [];
  return {
    calls,
    importQuarantined: async (input: { sourcePackage: GitHubActionsBridgeSourcePackage; checkpointId: string }) => {
      calls.push(input.checkpointId);
      return {
        status: "succeeded" as const,
        repositoryId: input.sourcePackage.repositoryId,
        sourceSnapshotId: "snapshot:one",
        objectFormat: input.sourcePackage.objectFormat,
        refs: input.sourcePackage.refs,
        bundleDigest: input.sourcePackage.bundle.digest,
        lfsState: input.sourcePackage.lfs.state === "empty" ? "empty" as const : "complete" as const,
        checkpointId: input.checkpointId,
        receipt: "fixture=repository-driver-import; verified=true; credentialMaterialStored=false",
      };
    },
  };
}

test("empty Project import requires owner confirmation, then cuts over through the owner boundary", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  const input = sourcePackage();
  const planned = await coordinator.prepare({ capability: capability(), sourcePackage: input, history: history("empty"), mode: "initial-import" });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  assert.equal(planned.value.status, "awaiting-owner");
  const repository = importer();
  let cutoverCalls = 0;
  const missingOwner = await coordinator.activateInitialImport({
    plan: planned.value,
    capability: capability(),
    sourcePackage: input,
    history: history("empty"),
    importer: repository,
    cutover: { activateImportedRepository: async () => { cutoverCalls += 1; return { status: "succeeded", projectRevisionId: "project-revision:one", receipt: "fixture=cutover" }; } },
  });
  assert.equal(missingOwner.status, "failed");
  if (missingOwner.status === "failed") assert.equal(missingOwner.code, "owner_confirmation_required");
  assert.equal(repository.calls.length, 0);
  const activated = await coordinator.activateInitialImport({
    plan: planned.value,
    capability: capability(),
    sourcePackage: input,
    history: history("empty"),
    ownerConfirmation: { status: "confirmed", principalId: "owner:one", sessionId: "session:one", receipt: "owner=verified; packageDigest=verified" },
    importer: repository,
    cutover: { activateImportedRepository: async () => { cutoverCalls += 1; return { status: "succeeded", projectRevisionId: "project-revision:one", receipt: "fixture=cutover" }; } },
  });
  assert.equal(activated.status, "succeeded");
  if (activated.status !== "succeeded") return;
  assert.equal(activated.value.canonicalCutover, "owner-confirmed-initialization");
  assert.equal(repository.calls.length, 1);
  assert.equal(cutoverCalls, 1);
  assert.equal(JSON.stringify(activated).includes("git bundle fixture"), false);
  assert.match(activated.receipt, /canonicalWrite=false/);
});

test("same history is a no-transfer ready state and never invokes an importer", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  const repository = importer();
  const planned = await coordinator.prepare({ capability: capability(), sourcePackage: sourcePackage(), history: history("same"), mode: "initial-import" });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  assert.equal(planned.value.status, "ready");
  const activation = await coordinator.activateInitialImport({ plan: planned.value, capability: capability(), sourcePackage: sourcePackage(), history: history("same"), ownerConfirmation: { status: "confirmed", principalId: "owner:one", sessionId: "session:one", receipt: "owner=verified" }, importer: repository, cutover: { activateImportedRepository: async () => ({ status: "succeeded", projectRevisionId: "unexpected", receipt: "fixture=unexpected" }) } });
  assert.equal(activation.status, "failed");
  if (activation.status === "failed") assert.equal(activation.code, "plan_invalid");
  assert.equal(repository.calls.length, 0);
});

test("GitHub-ahead history requires a proposal capability and creates only a Change proposal", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  const input = sourcePackage({ operationId: "bridge-proposal:one", refs: [{ name: "refs/heads/main", oid: "commit:github" }] });
  const planned = await coordinator.prepare({ capability: capability({ id: "github-bridge-capability:proposal", operation: "proposal" }), sourcePackage: { ...input, capabilityId: "github-bridge-capability:proposal" }, history: history("github-ahead"), mode: "proposal" });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  assert.equal(planned.value.status, "ready");
  const proposal = await coordinator.createProposal({ plan: planned.value, capability: capability({ id: "github-bridge-capability:proposal", operation: "proposal" }), sourcePackage: { ...input, capabilityId: "github-bridge-capability:proposal" }, history: history("github-ahead"), creator: { createProposal: async (value) => ({ status: "succeeded", changeId: "change:github-ahead", checkpointId: value.checkpointId, receipt: "fixture=proposal; landing=not-performed" }) } });
  assert.equal(proposal.status, "succeeded");
  if (proposal.status === "succeeded") assert.equal(proposal.value.canonicalWrite, false);
});

test("canonical-ahead and diverged histories are distinct blocked states", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  for (const relation of ["canonical-ahead", "diverged"] as const) {
    const result = await coordinator.prepare({ capability: capability(), sourcePackage: sourcePackage({ operationId: `bridge-import:${relation}`, ...(relation === "diverged" ? { refs: [{ name: "refs/heads/main", oid: "commit:github" }] } : {}) }), history: history(relation), mode: "initial-import" });
    assert.equal(result.status, "succeeded");
    if (result.status === "succeeded") {
      assert.equal(result.value.status, "blocked");
      assert.equal(result.value.relation, relation);
      assert.equal(result.value.canonicalWrite, false);
    }
  }
});

test("bundle, LFS, capability, stale, and replay failures are fail-closed", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  const badDigest = await coordinator.prepare({ capability: capability(), sourcePackage: sourcePackage({ bundle: { bytes: bundleBytes, digest: "sha256:wrong", declaredBytes: bundleBytes.byteLength } }), history: history("empty"), mode: "initial-import" });
  assert.equal(badDigest.status, "failed");
  if (badDigest.status === "failed") assert.equal(badDigest.code, "bundle_digest_mismatch");
  const incompleteLfs = await coordinator.prepare({ capability: capability(), sourcePackage: sourcePackage({ lfs: { state: "incomplete", objects: [] } }), history: history("empty"), mode: "initial-import" });
  assert.equal(incompleteLfs.status, "failed");
  if (incompleteLfs.status === "failed") assert.equal(incompleteLfs.code, "lfs_incomplete");
  const wrongProject = await coordinator.prepare({ capability: capability({ projectId: "project:other" }), sourcePackage: sourcePackage(), history: history("empty"), mode: "initial-import" });
  assert.equal(wrongProject.status, "failed");
  if (wrongProject.status === "failed") assert.equal(wrongProject.code, "capability_binding_mismatch");
  const expired = await coordinator.prepare({ capability: capability({ expiresAt: "2026-08-21T00:00:00.000Z" }), sourcePackage: sourcePackage(), history: history("empty"), mode: "initial-import" });
  assert.equal(expired.status, "failed");
  if (expired.status === "failed") assert.equal(expired.code, "capability_expired");
  const input = sourcePackage({ operationId: "bridge-replay:one" });
  const planned = await coordinator.prepare({ capability: capability(), sourcePackage: input, history: history("empty"), mode: "initial-import" });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  const activationInput = { plan: planned.value, capability: capability(), sourcePackage: input, history: history("empty"), ownerConfirmation: { status: "confirmed" as const, principalId: "owner:one", sessionId: "session:one", receipt: "owner=verified" }, importer: importer(), cutover: { activateImportedRepository: async () => ({ status: "succeeded" as const, projectRevisionId: "project-revision:one", receipt: "fixture=cutover" }) } };
  const first = await coordinator.activateInitialImport(activationInput);
  assert.equal(first.status, "succeeded");
  const replay = await coordinator.activateInitialImport(activationInput);
  assert.equal(replay.status, "failed");
  if (replay.status === "failed") assert.equal(replay.code, "bridge_replay");
});

test("credential-shaped RepositoryDriver and owner receipts are rejected", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  const input = sourcePackage({ operationId: "bridge-credential-receipt:one" });
  const planned = await coordinator.prepare({ capability: capability(), sourcePackage: input, history: history("empty"), mode: "initial-import" });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  const result = await coordinator.activateInitialImport({ plan: planned.value, capability: capability(), sourcePackage: input, history: history("empty"), ownerConfirmation: { status: "confirmed", principalId: "owner:one", sessionId: "session:one", receipt: "token=must-not-appear" }, importer: importer(), cutover: { activateImportedRepository: async () => ({ status: "succeeded", projectRevisionId: "project-revision:one", receipt: "fixture=cutover" }) } });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.code, "credential_in_receipt");
});

test("a failed quarantine attempt releases the operation for checkpoint retry, while success remains replay-protected", async () => {
  const coordinator = new GitHubActionsBridgeImportCoordinator({ now: () => now });
  const input = sourcePackage({ operationId: "bridge-retry:one" });
  const planned = await coordinator.prepare({ capability: capability(), sourcePackage: input, history: history("empty"), mode: "initial-import" });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  let importerCalls = 0;
  const common = { plan: planned.value, capability: capability(), sourcePackage: input, history: history("empty"), ownerConfirmation: { status: "confirmed" as const, principalId: "owner:one", sessionId: "session:one", receipt: "owner=verified" }, importer: { importQuarantined: async (value: { sourcePackage: GitHubActionsBridgeSourcePackage; checkpointId: string }) => { importerCalls += 1; if (importerCalls === 1) throw new Error("driver unavailable"); return { status: "succeeded" as const, repositoryId: value.sourcePackage.repositoryId, sourceSnapshotId: "snapshot:retry", objectFormat: value.sourcePackage.objectFormat, refs: value.sourcePackage.refs, bundleDigest: value.sourcePackage.bundle.digest, lfsState: "empty" as const, checkpointId: value.checkpointId, receipt: "driver=verified" }; } }, cutover: { activateImportedRepository: async () => ({ status: "succeeded" as const, projectRevisionId: "project-revision:retry", receipt: "cutover=owner-confirmed" }) } };
  const first = await coordinator.activateInitialImport(common);
  assert.equal(first.status, "failed");
  const retry = await coordinator.activateInitialImport(common);
  assert.equal(retry.status, "succeeded");
  assert.equal(importerCalls, 2);
  const replay = await coordinator.activateInitialImport(common);
  assert.equal(replay.status, "failed");
  if (replay.status === "failed") assert.equal(replay.code, "bridge_replay");
});
