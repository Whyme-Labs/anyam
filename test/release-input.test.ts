import assert from "node:assert/strict";
import test from "node:test";

import {
  assertReleaseInputSetMatches,
  createReleaseInputSet,
  deriveReleaseInputSet,
  ReleaseInputError,
} from "../src/delivery/release-input.ts";
import { CONTRACT_VERSIONS, type Artifact, type Evidence } from "../src/kernel/contracts.ts";

const artifact: Artifact = {
  protocol: CONTRACT_VERSIONS.artifact,
  id: "artifact:input",
  type: "package.archive",
  digest: "sha256:artifact",
  projectRevisionId: "project-revision:input",
};

const evidence: Evidence = {
  protocol: CONTRACT_VERSIONS.evidence,
  version: "v1",
  id: "evidence:input",
  key: "build",
  criterion: "build",
  outcome: "passed",
  validityKey: "sha256:validity",
  actionId: "action:build",
  verifierId: "verifier:build",
  toolchainDigest: "sha256:toolchain",
  dependencyDigest: "sha256:dependencies",
  environmentDigest: "sha256:environment",
  inputDigests: ["src/index.ts=sha256:source"],
  effectDigests: [],
  outputDigest: artifact.digest,
  createdAt: "2026-08-23T00:00:00.000Z",
  producer: { kind: "run", id: "run:input", version: "v1" },
  projectRevisionId: artifact.projectRevisionId,
  projectViewId: "project-view:input",
  runId: "run:input",
  actor: { principalId: "principal:input", actorId: "actor:input", sessionId: "session:input", clientId: "client:input" },
  runnerId: "runner:input",
  policyVersion: "policy:input",
  authorizationEpoch: "1",
  capabilityGrantId: "grant:input",
  disclosure: { projectionId: "project-view:input", classification: "project" },
  receipt: "evidence=passed; credentialMaterialStored=false",
  invalidators: [],
  owner: "input-test",
};

test("Release input closure derives from one exact Evidence and Artifact set", () => {
  const inputSet = deriveReleaseInputSet({ configurationDigests: ["sha256:build-definition"], artifacts: [artifact], evidence: [evidence] });
  assert.equal(inputSet.protocol, "anyam.release-input/v1");
  assert.deepEqual(inputSet.artifactDigests, [artifact.digest]);
  assert.match(inputSet.inputClosureDigest, /^sha256:/);
  assert.doesNotThrow(() => assertReleaseInputSetMatches({ inputSet, configurationDigests: ["sha256:build-definition"], artifacts: [artifact], evidence: [evidence] }));
});

test("Release input closure rejects mismatched Evidence and tampered fields", () => {
  const inputSet = createReleaseInputSet({ buildDefinitionDigest: "sha256:build-definition", dependencyDigest: evidence.dependencyDigest, toolchainDigest: evidence.toolchainDigest, environmentDigest: evidence.environmentDigest, artifactDigests: [artifact.digest] });
  assert.throws(
    () => assertReleaseInputSetMatches({ inputSet: { ...inputSet, artifactDigests: ["sha256:other"] }, configurationDigests: ["sha256:build-definition"], artifacts: [artifact], evidence: [evidence] }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseInputError);
      assert.equal(error.code, "mismatch");
      assert.match(error.receipt, /inputClosure=/);
      return true;
    },
  );
  assert.throws(
    () => deriveReleaseInputSet({ configurationDigests: ["sha256:build-definition"], artifacts: [artifact], evidence: [evidence, { ...evidence, id: "evidence:other", dependencyDigest: "sha256:other-dependencies" }] }),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseInputError);
      assert.match(error.receipt, /dependencyDigest-mismatch/);
      return true;
    },
  );
});
