import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_COMMAND_PROTOCOL,
  AuthorityPlaneCoordinator,
  emptyAuthorityPlaneSnapshot,
} from "../src/cloudflare/authority-plane.ts";
import {
  PROMOTION_EXECUTION_PROTOCOL,
  type PromotionExecutionContext,
  type PromotionExecutionResult,
} from "../src/cloudflare/promotion-execution.ts";
import { CONTRACT_VERSIONS, type ActorRef } from "../src/kernel/contracts.ts";

const session = {
  realmId: "realm:promotion-execution-test",
  principalId: "principal:owner",
  actorId: "actor:owner",
  sessionId: "session:owner",
  clientId: "client:anyam-web",
  authorizationEpoch: 1,
};

const actor: ActorRef = {
  principalId: session.principalId,
  actorId: session.actorId,
  sessionId: session.sessionId,
  clientId: session.clientId,
};

function fixture(): ReturnType<typeof emptyAuthorityPlaneSnapshot> {
  const snapshot = emptyAuthorityPlaneSnapshot(session.realmId);
  snapshot.projects["project:execution"] = { protocol: CONTRACT_VERSIONS.project, id: "project:execution", name: "Execution test", referenceType: "git", sourceSpaceIds: ["source:execution"] };
  snapshot.sourceSpaces["source:execution"] = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:execution", name: "public", classification: "public" };
  snapshot.projectRevisions["project-revision:execution"] = { protocol: CONTRACT_VERSIONS.kernel, id: "project-revision:execution", projectId: "project:execution", sourceSpaceSnapshots: { "source:execution": "git:execution" } };
  snapshot.canonicalByProject["project:execution"] = "project-revision:execution";
  snapshot.artifacts["artifact:execution"] = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:execution", type: "cli.archive", digest: "sha256:artifact", projectRevisionId: "project-revision:execution" };
  snapshot.evidence["evidence:execution"] = { protocol: CONTRACT_VERSIONS.evidence, version: "v1", id: "evidence:execution", key: "unit", criterion: "unit", outcome: "passed", validityKey: "valid:execution", actionId: "action:unit", verifierId: "verifier:unit", toolchainDigest: "sha256:toolchain", dependencyDigest: "sha256:dependencies", environmentDigest: "sha256:environment", inputDigests: [], effectDigests: [], outputDigest: "sha256:output", createdAt: "2026-08-12T00:00:00.000Z", producer: { kind: "run", id: "run:execution", version: "v1" }, projectRevisionId: "project-revision:execution", projectViewId: "project-view:execution", runId: "run:execution", actor, runnerId: "runner:execution", policyVersion: "policy:execution", authorizationEpoch: "1", capabilityGrantId: "grant:execution", disclosure: { projectionId: "project-view:execution", classification: "project" }, receipt: "evidence=passed", invalidators: [], owner: "execution-test" };
  snapshot.releases["release:execution"] = { protocol: CONTRACT_VERSIONS.release, id: "release:execution", projectRevisionId: "project-revision:execution", artifactIds: ["artifact:execution"], evidenceIds: ["evidence:execution"], configurationDigests: ["sha256:configuration"], stateAssumptions: [], policyVersion: "policy:execution", status: "ready" };
  snapshot.targets["target:execution"] = { protocol: CONTRACT_VERSIONS.target, id: "target:execution", projectId: "project:execution", name: "Execution target", adapterId: "adapter:execution", acceptedArtifactTypes: ["cli.archive"], requiredEvidenceKeys: [], state: "configured", currentReleaseId: null, releaseHistory: [] };
  snapshot.promotions["promotion:execution"] = { protocol: CONTRACT_VERSIONS.promotion, id: "promotion:execution", projectId: "project:execution", targetId: "target:execution", releaseId: "release:execution", releaseDigest: "declared:release:execution", previousReleaseId: null, expectedCurrentReleaseId: null, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: "request:execution", actor, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", receipt: "promotion=blocked", recoveryAction: "execute through the trusted provider handoff" };
  return snapshot;
}

function healthyExecutor(calls: { count: number }): { execute(context: Readonly<PromotionExecutionContext>): Promise<PromotionExecutionResult> } {
  return {
    async execute(context) {
      calls.count += 1;
      const resultPromotion = {
        ...context.promotion,
        state: "healthy" as const,
        attempt: 1,
        previewId: "preview:execution",
        deploymentId: "deployment:execution",
        providerOperationId: "provider-operation:execution",
        receipt: "provider=fixture; operation=healthy; release-bound=true",
      };
      return {
        protocol: PROMOTION_EXECUTION_PROTOCOL,
        status: "succeeded",
        adapterId: context.target.adapterId,
        executionDigest: context.executionDigest,
        promotion: resultPromotion,
        target: { id: context.target.id, projectId: context.project.id, state: "healthy", currentReleaseId: context.release.id, releaseHistory: [context.release.id] },
        checkpoint: { idempotencyKey: context.executionIdempotencyKey, attempt: 1, stage: "complete", providerOperationIds: ["provider-operation:execution"], receipt: "checkpoint=provider-complete" },
        receipt: "provider=fixture; operation=healthy; receipt=release-bound",
      };
    },
  };
}

test("trusted Promotion handoff invokes the injected executor once and persists the verified Target pointer", async () => {
  const coordinator = new AuthorityPlaneCoordinator(fixture());
  const calls = { count: 0 };
  const first = await coordinator.executePromotion({ promotionId: "promotion:execution", executionIdempotencyKey: "execute:execution:1", executor: healthyExecutor(calls), session });
  assert.equal(first.status, "succeeded", JSON.stringify(first));
  assert.equal(calls.count, 1);
  assert.equal((first.value.promotion as { state: string }).state, "healthy");
  assert.equal((first.value.target as { currentReleaseId: string }).currentReleaseId, "release:execution");
  assert.deepEqual((first.value.target as { releaseHistory: string[] }).releaseHistory, ["release:execution"]);
  assert.equal((first.value.promotion as { executionIdempotencyKey: string }).executionIdempotencyKey, "execute:execution:1");
  assert.equal(JSON.stringify(first).includes("secret"), false);
  const replay = await coordinator.executePromotion({ promotionId: "promotion:execution", executionIdempotencyKey: "execute:execution:1", executor: { execute: async () => { throw new Error("must-not-run"); } }, session });
  assert.deepEqual(replay, first);
  assert.equal(calls.count, 1);
  assert.equal(coordinator.snapshot().version, 1);
});

test("a provider result bound to another Release is rejected and recorded as indeterminate without moving the Target pointer", async () => {
  const coordinator = new AuthorityPlaneCoordinator(fixture());
  const result = await coordinator.executePromotion({
    promotionId: "promotion:execution",
    executionIdempotencyKey: "execute:execution:mismatch",
    executor: {
      async execute(context) {
        return {
          ...await healthyExecutor({ count: 0 }).execute(context),
          target: { id: context.target.id, projectId: context.project.id, state: "healthy", currentReleaseId: "release:attacker", releaseHistory: ["release:attacker"] },
        };
      },
    },
    session,
  });
  assert.equal(result.status, "indeterminate", JSON.stringify(result));
  assert.equal((result.value.promotion as { state: string }).state, "degraded");
  assert.equal((result.value.target as { state: string }).state, "degraded");
  assert.equal((result.value.target as { currentReleaseId: string | null }).currentReleaseId, null);
  assert.match(String(result.recoveryAction), /discard|reconcile|provider/i);
});

test("the public Authority command surface cannot submit promotion.execute as a caller command", () => {
  const coordinator = new AuthorityPlaneCoordinator(fixture());
  assert.throws(() => coordinator.execute({ protocol: AUTHORITY_COMMAND_PROTOCOL, command: "promotion.execute", idempotencyKey: "public:execute", payload: { promotionId: "promotion:execution" } }, session), /internal provider handoff/);
});
