import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { GitHubActionsBridgeCapability } from "../src/portability/github-actions-bridge.ts";
import {
  GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL,
  GitHubActionsBridgeOutboundCoordinator,
  githubActionsBridgeOutboundMessage,
  type GitHubActionsBridgeOutboundBundle,
} from "../src/portability/github-actions-bridge-outbound.ts";

const now = "2026-08-22T00:00:00.000Z";
const bundleBytes = new TextEncoder().encode("git bundle for outbound\n");
const bundleDigest = `sha256:${createHash("sha256").update(bundleBytes).digest("hex")}`;
const keys = generateKeyPairSync("ed25519");
const publicKey = String(keys.publicKey.export({ type: "spki", format: "pem" }));

function capability(overrides: Partial<GitHubActionsBridgeCapability> = {}): GitHubActionsBridgeCapability {
  return {
    protocol: "anyam.github-actions-bridge/v1",
    id: "capability:outbound",
    connectionId: "connection:outbound",
    realmId: "realm:customer",
    projectId: "project:atlas",
    sourceSpaceId: "source:public",
    operation: "outbound",
    repositoryOwnerId: "owner:1",
    repositoryId: "repo:1",
    mirrorId: "mirror:github",
    outboundSigningKeyId: "key:outbound",
    outboundSigningPublicKey: publicKey,
    workflowRef: "acme/atlas/.github/workflows/anyam-bridge.yml@refs/heads/main",
    workflowSha: "workflow-sha",
    runId: "run:outbound",
    jtiDigest: "sha256:jti",
    issuedAt: "2026-08-21T23:59:00.000Z",
    expiresAt: "2026-08-22T00:05:00.000Z",
    status: "active",
    canonicalWrite: false,
    receipt: "fixture=outbound-capability; credentialMaterialStored=false",
    ...overrides,
  };
}

function unsignedBundle(overrides: Partial<GitHubActionsBridgeOutboundBundle> = {}): GitHubActionsBridgeOutboundBundle {
  const base: GitHubActionsBridgeOutboundBundle = {
    protocol: GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL,
    operationId: "outbound:one",
    capabilityId: "capability:outbound",
    realmId: "realm:customer",
    projectId: "project:atlas",
    sourceSpaceId: "source:public",
    repositoryOwnerId: "owner:1",
    repositoryId: "repo:1",
    runId: "run:outbound",
    mirrorId: "mirror:github",
    remoteRepository: "acme/atlas",
    objectFormat: "sha1",
    defaultBranch: "main",
    expectedRemoteGeneration: "remote:g0",
    expectedRemoteRefs: [{ name: "refs/heads/main", oid: "commit:previous" }],
    refs: [{ name: "refs/heads/main", oid: "commit:canonical" }],
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    protectedRemoteRefs: ["refs/heads/main"],
    bundle: { bytes: bundleBytes, digest: bundleDigest, declaredBytes: bundleBytes.byteLength },
    signing: { algorithm: "Ed25519", keyId: "key:outbound", publicKey, signature: "pending", messageDigest: "pending" },
    ...overrides,
  };
  const message = githubActionsBridgeOutboundMessage(base);
  const messageDigest = `sha256:${createHash("sha256").update(message).digest("hex")}`;
  const signature = sign(null, Buffer.from(message), keys.privateKey).toString("base64url");
  return { ...base, signing: { ...base.signing, signature, messageDigest } };
}

function run() {
  return { state: "received" as const, receipt: "workflow=received; credentialMaterialStored=false" };
}

test("outbound preflight verifies the exact signed bundle and completes only after mapped-ref read-back", async () => {
  const coordinator = new GitHubActionsBridgeOutboundCoordinator({ now: () => now });
  const bundle = unsignedBundle();
  const planned = await coordinator.prepare({ capability: capability(), bundle, run: run() });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  const completed = await coordinator.complete({ plan: planned.value, capability: capability(), bundle, run: run(), provider: { status: "succeeded", generation: "remote:g1", refs: [{ name: "refs/heads/main", oid: "commit:canonical" }], receipt: "github=read-back; refs=verified; credentialMaterialStored=false" } });
  assert.equal(completed.status, "succeeded");
  if (completed.status === "succeeded") assert.equal(completed.value.state, "pushed");
  assert.equal(JSON.stringify(completed).includes("git bundle for outbound"), false);
});

test("protected branch refusal becomes a visible blocked checkpoint with branch/PR recovery", async () => {
  const coordinator = new GitHubActionsBridgeOutboundCoordinator({ now: () => now });
  const bundle = unsignedBundle({ operationId: "outbound:protected" });
  const planned = await coordinator.prepare({ capability: capability(), bundle, run: run() });
  assert.equal(planned.status, "succeeded");
  if (planned.status !== "succeeded") return;
  const result = await coordinator.complete({ plan: planned.value, capability: capability(), bundle, run: run(), provider: { status: "failed", code: "protected-branch", recoveryAction: "provider rejected protected main", receipt: "github=protected-branch; credentialMaterialStored=false", remoteMayHaveChanged: false } });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.match(result.recoveryAction, /branch|Pull Request/iu);
});

test("digest mismatch, no-run, stale, expired, and replay never report synchronization", async () => {
  const coordinator = new GitHubActionsBridgeOutboundCoordinator({ now: () => now });
  const badDigest = await coordinator.prepare({ capability: capability(), bundle: unsignedBundle({ bundle: { bytes: bundleBytes, digest: "sha256:wrong", declaredBytes: bundleBytes.byteLength } }), run: run() });
  assert.equal(badDigest.status, "failed");
  if (badDigest.status === "failed") assert.equal(badDigest.code, "bundle_digest_mismatch");
  for (const state of ["no-run", "stale"] as const) {
    const result = await coordinator.prepare({ capability: capability(), bundle: unsignedBundle({ operationId: `outbound:${state}` }), run: { state, receipt: `workflow=${state}; credentialMaterialStored=false` } });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.code, `run_${state}`);
  }
  const expired = await coordinator.prepare({ capability: capability({ expiresAt: "2026-08-21T00:00:00.000Z" }), bundle: unsignedBundle({ operationId: "outbound:expired" }), run: run() });
  assert.equal(expired.status, "failed");
  if (expired.status === "failed") assert.equal(expired.code, "capability_expired");
  const bundle = unsignedBundle({ operationId: "outbound:replay" });
  const plan = await coordinator.prepare({ capability: capability(), bundle, run: run() });
  assert.equal(plan.status, "succeeded");
  if (plan.status !== "succeeded") return;
  const provider = { status: "succeeded" as const, generation: "remote:g2", refs: [{ name: "refs/heads/main", oid: "commit:canonical" }], receipt: "github=read-back; credentialMaterialStored=false" };
  const first = await coordinator.complete({ plan: plan.value, capability: capability(), bundle, run: run(), provider });
  assert.equal(first.status, "succeeded");
  const replay = await coordinator.complete({ plan: plan.value, capability: capability(), bundle, run: run(), provider });
  assert.equal(replay.status, "failed");
  if (replay.status === "failed") assert.equal(replay.code, "outbound_replay");
});

test("provider read-back mismatch is quarantined instead of becoming a healthy Mirror checkpoint", async () => {
  const coordinator = new GitHubActionsBridgeOutboundCoordinator({ now: () => now });
  const bundle = unsignedBundle({ operationId: "outbound:mismatch" });
  const plan = await coordinator.prepare({ capability: capability(), bundle, run: run() });
  assert.equal(plan.status, "succeeded");
  if (plan.status !== "succeeded") return;
  const result = await coordinator.complete({ plan: plan.value, capability: capability(), bundle, run: run(), provider: { status: "succeeded", generation: "remote:g3", refs: [{ name: "refs/heads/main", oid: "commit:other" }], receipt: "github=read-back; credentialMaterialStored=false" } });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.code, "push_result_mismatch");
});
