import assert from "node:assert/strict";
import test from "node:test";

import { createWorkerTargetQualificationRelease } from "../src/qualification/cloudflare-worker-target.ts";

test("Worker Target qualification seals a digest-bound Release with passed input Evidence", () => {
  const bytes = new TextEncoder().encode("export default { fetch() { return new Response('ok'); } };\n");
  const result = createWorkerTargetQualificationRelease({
    id: "healthy",
    fileName: "healthy.js",
    bytes,
    createdAt: "2026-08-24T00:00:00.000Z",
  });

  assert.deepEqual(result.immutable.release.evidenceIds, [result.evidence.id]);
  assert.equal(result.evidence.outcome, "passed");
  assert.equal(result.evidence.outputDigest, result.artifact.digest);
  assert.deepEqual(result.evidence.inputDigests, [result.artifact.digest]);
  assert.equal(result.immutable.release.inputSet?.dependencyDigest, result.evidence.dependencyDigest);
  assert.match(result.evidence.receipt, /source=qualification-fixture/);
  assert.match(result.evidence.receipt, /provider=not-observed/);
});
