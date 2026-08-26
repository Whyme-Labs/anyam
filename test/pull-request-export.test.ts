import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";
import { InMemoryRepositoryDriver } from "../src/harness/adapters.ts";
import { LocalProjectExporter, verifyProjectExportPackage } from "../src/portability/project-export.ts";

test("Pull Request review history, stale state, and terminal state survive export and restore", async () => {
  const destination = await mkdtemp(join(tmpdir(), "anyam-pull-request-export-"));
  try {
    const reviewer = { principalId: "principal:reviewer", actorId: "actor:reviewer", sessionId: "session:reviewer", clientId: "client:test" };
    const review = { protocol: CONTRACT_VERSIONS.pullRequestReview, id: "pull-request-review:one", pullRequestId: "pr:export", reviewer, state: "approved" as const, headCommit: "commit:head-one", baseCommit: "commit:base", revisionSetDigest: "sha256:revision-set", reviewDigest: "sha256:review", reviewedAt: "2026-08-26T00:00:00.000Z", receipt: "review=recorded; credentialMaterialStored=false" };
    const pullRequest = { protocol: CONTRACT_VERSIONS.pullRequest, id: "pr:export", projectId: "project:export", changeId: "change:export", provider: "local", headRef: "refs/heads/feature", baseRef: "refs/heads/main", headCommit: "commit:head-two", baseCommit: "commit:base", title: "Export review", description: "", status: "merged" as const, reviewState: "pending" as const, reviewInvalidatedAt: "2026-08-26T00:01:00.000Z", reviews: [review], revisionIds: ["change-revision:one", "change-revision:two"], disclosure: "project" as const, createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:01:00.000Z", mergedAt: "2026-08-26T00:02:00.000Z", receipt: "pullRequest=merged; terminal=true; credentialMaterialStored=false" };
    const exported = await new LocalProjectExporter(new InMemoryRepositoryDriver()).exportProject({ project: { protocol: CONTRACT_VERSIONS.project, id: "project:export", name: "Export", referenceType: "git", sourceSpaceIds: ["source:export"] }, sourceSpaces: [{ protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:export", name: "Export", classification: "public" }], repositories: [], destination, pullRequests: [pullRequest] });
    assert.equal(exported.status, "succeeded");
    if (exported.status !== "succeeded") return;
    const restored = await verifyProjectExportPackage(destination);
    assert.equal(restored.status, "succeeded");
    if (restored.status !== "succeeded") return;
    const roundTripped = restored.value.pullRequests[0];
    assert.equal(roundTripped?.status, "merged");
    assert.equal(roundTripped?.reviewState, "pending");
    assert.equal(roundTripped?.reviews?.[0]?.headCommit, "commit:head-one");
    assert.equal(roundTripped?.reviewInvalidatedAt, "2026-08-26T00:01:00.000Z");
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
