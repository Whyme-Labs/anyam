import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeGitHubActionsBridgeHistory,
  encodeGitHubActionsBridgeSourcePackage,
  parseGitHubActionsBridgeHistory,
  parseGitHubActionsBridgeSourcePackage,
} from "../apps/realm-worker/src/github-actions-bridge-contract.ts";
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
