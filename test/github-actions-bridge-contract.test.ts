import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeGitHubActionsBridgeOutboundBundle,
  encodeGitHubActionsBridgeHistory,
  encodeGitHubActionsBridgeSourcePackage,
  parseGitHubActionsBridgeHistory,
  parseGitHubActionsBridgeOutboundBundle,
  parseGitHubActionsBridgeSourcePackage,
} from "../apps/realm-worker/src/github-actions-bridge-contract.ts";
import { GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL, type GitHubActionsBridgeOutboundBundle } from "../src/portability/github-actions-bridge-outbound.ts";
import { GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL, type GitHubActionsBridgeSourcePackage } from "../src/portability/github-actions-bridge-import.ts";

const bytes = new TextEncoder().encode("bundle\n");

const sourcePackage: GitHubActionsBridgeSourcePackage = {
  protocol: GITHUB_ACTIONS_BRIDGE_SOURCE_PROTOCOL,
  operationId: "bridge:contract",
  capabilityId: "capability:contract",
  realmId: "realm:customer",
  projectId: "project:atlas",
  sourceSpaceId: "source:private",
  repositoryOwnerId: "owner:1",
  repositoryId: "repo:1",
  runId: "run:contract",
  objectFormat: "sha1",
  defaultBranch: "main",
  refs: [{ name: "refs/heads/main", oid: "commit:one" }],
  bundle: { bytes, digest: "sha256:bundle", declaredBytes: bytes.byteLength },
  lfs: { state: "empty", objects: [] },
};

test("Realm wire contract round-trips binary source packages without credential fields", () => {
  const wire = encodeGitHubActionsBridgeSourcePackage(sourcePackage);
  const parsed = parseGitHubActionsBridgeSourcePackage(wire);
  assert.deepEqual([...parsed.bundle.bytes], [...bytes]);
  assert.equal(JSON.stringify(wire).includes("token"), false);
  assert.equal(parsed.repositoryId, sourcePackage.repositoryId);
});
test("Realm wire contract preserves RepositoryDriver history provenance and rejects caller history", () => {
  const history = { source: "repository-driver" as const, objectFormat: "sha1" as const, canonicalRefs: [], githubRefs: sourcePackage.refs, relation: "empty" as const, receipt: "driver=verified; credentialMaterialStored=false" };
  assert.deepEqual(parseGitHubActionsBridgeHistory(encodeGitHubActionsBridgeHistory(history)), history);
  assert.throws(() => parseGitHubActionsBridgeHistory({ ...encodeGitHubActionsBridgeHistory(history), source: "workflow" }), /repository-driver-required/);
});

test("Realm wire contract round-trips signed outbound bundles without GitHub credentials", () => {
  const outbound: GitHubActionsBridgeOutboundBundle = {
    protocol: GITHUB_ACTIONS_BRIDGE_OUTBOUND_PROTOCOL,
    operationId: "outbound:wire",
    capabilityId: "capability:wire",
    realmId: "realm:customer",
    projectId: "project:atlas",
    sourceSpaceId: "source:public",
    repositoryOwnerId: "owner:1",
    repositoryId: "repo:1",
    runId: "run:wire",
    mirrorId: "mirror:github",
    remoteRepository: "acme/atlas",
    objectFormat: "sha1",
    defaultBranch: "main",
    expectedRemoteGeneration: "remote:g0",
    expectedRemoteRefs: [{ name: "refs/heads/main", oid: "commit:previous" }],
    refs: [{ name: "refs/heads/main", oid: "commit:current" }],
    refMappings: [{ localRef: "refs/heads/main", remoteRef: "refs/heads/main" }],
    protectedRemoteRefs: ["refs/heads/main"],
    bundle: { bytes, digest: "sha256:bundle", declaredBytes: bytes.byteLength },
    signing: { algorithm: "Ed25519", keyId: "key:wire", publicKey: "public-key", signature: "signature", messageDigest: "sha256:message" },
  };
  const parsed = parseGitHubActionsBridgeOutboundBundle(encodeGitHubActionsBridgeOutboundBundle(outbound));
  assert.deepEqual([...parsed.bundle.bytes], [...bytes]);
  assert.equal(parsed.expectedRemoteGeneration, "remote:g0");
  assert.equal(JSON.stringify(parsed).includes("GITHUB_TOKEN"), false);
});
