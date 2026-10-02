import assert from "node:assert/strict";
import test from "node:test";
import { localReviewPacket } from "../packages/create-anyam/src/review-packet.ts";
import type { LocalProposedRevision, LocalRunObservation } from "../packages/create-anyam/src/agent.ts";

const session = { id: "session:fixture", workspaceId: "workspace:fixture", actorId: "actor:fixture", taskId: "task:fixture", grantId: "grant:fixture" };
const revision: LocalProposedRevision = { id: "revision:fixture", changeId: "change:fixture", workspaceId: session.workspaceId, sourceSnapshot: "git:snapshot:fixture", sourceRepositoryId: "repository:fixture", sourceRevision: "git:commit:fixture", baseProjectRevisionId: "base:fixture", gitRef: "refs/heads/candidate", gitObjectFormat: "sha1", treeDigest: "git:tree:fixture", sourceKind: "git", declaredEffects: ["source.modify"], createdAt: "2026-10-02T00:00:00Z", actorId: session.actorId, canonicalWrite: false };
const run: LocalRunObservation = { id: "run:fixture", actionId: "action:check", status: "passed", evidenceId: "evidence:fixture", evidenceDigest: "sha256:evidence", startedAt: "2026-10-02T00:00:00Z", completedAt: "2026-10-02T00:00:01Z", sourceRevision: revision.sourceRevision, sourceSnapshot: revision.sourceSnapshot, actionContractDigest: "sha256:action", verifierId: "verifier:check", verifierContractDigest: "sha256:verifier", exitCode: 0, stdoutDigest: "sha256:stdout", stderrDigest: "sha256:stderr", inputDigests: ["sha256:input"], outputDigests: [], outputDigest: "sha256:output", toolchainDigest: "sha256:toolchain", environmentDigest: "sha256:environment", actorId: session.actorId, grantId: session.grantId, taskId: session.taskId, receipt: "synthetic=true" };
const input = { change: { id: revision.changeId, title: "Fixture", baseProjectRevisionId: revision.baseProjectRevisionId }, session, revisions: [revision], runs: [run], findings: [], actions: [{ id: run.actionId, contractDigest: run.actionContractDigest }], verifiers: [{ id: run.verifierId, actionId: run.actionId, contractDigest: run.verifierContractDigest! }] };

test("review packet rejects obsolete Action/Verifier contracts even at the same source", () => {
  assert.equal(localReviewPacket(input).checks[0]?.status, "passed");
  assert.equal(localReviewPacket({ ...input, actions: [{ ...input.actions[0]!, contractDigest: "sha256:new-action" }] }).checks[0]?.status, "stale");
  assert.equal(localReviewPacket({ ...input, verifiers: [{ ...input.verifiers[0]!, contractDigest: "sha256:new-verifier" }] }).checks[0]?.status, "stale");
  const { verifierContractDigest: omittedContract, ...missingContractRun } = run;
  assert.ok(omittedContract);
  assert.equal(localReviewPacket({ ...input, runs: [missingContractRun] }).checks[0]?.status, "stale");
});

test("review packet keeps latest matching-session failure and excludes peer provenance", () => {
  const failed = { ...run, id: "run:failed", status: "failed" as const };
  const peer = { ...run, id: "run:peer", actorId: "actor:peer", taskId: "task:peer", grantId: "grant:peer" };
  const packet = localReviewPacket({ ...input, runs: [run, failed, peer] });
  assert.equal(packet.checks[0]?.status, "failed");
  assert.equal(packet.checks[0]?.runId, failed.id);
  assert.equal(JSON.stringify(packet).includes(peer.id), false);
  assert.equal(localReviewPacket({ ...input, runs: [peer] }).checks[0]?.status, "missing");
  assert.equal(localReviewPacket({ ...input, revisions: [] }).checks[0]?.status, "unbound");
});


test("review packet requires source reconciliation before rerunning a differently tested commit", () => {
  const packet = localReviewPacket({ ...input, runs: [{ ...run, sourceRevision: "git:commit:other" }] });
  assert.equal(packet.checks[0]?.status, "stale");
  assert.equal(packet.checks[0]?.sourceMismatch, true);
  assert.equal(packet.nextSteps[0]?.tool, undefined);
  assert.match(packet.nextSteps[0]?.reason ?? "", /Reconcile the intended source/);
});
