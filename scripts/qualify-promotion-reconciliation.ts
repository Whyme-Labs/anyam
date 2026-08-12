import {
  AUTHORITY_PLANE_PROTOCOL,
  AuthorityPlaneCoordinator,
  emptyAuthorityPlaneSnapshot,
} from "../src/cloudflare/authority-plane.ts";
import {
  PROMOTION_EXECUTION_PROTOCOL,
  type PromotionExecutionContext,
  type PromotionExecutionResult,
} from "../src/cloudflare/promotion-execution.ts";
import { CONTRACT_VERSIONS } from "../src/kernel/contracts.ts";

const protocol = "anyam.promotion-reconciliation-qualification/v1" as const;
const session = {
  realmId: "realm:promotion-reconciliation-qualification",
  principalId: "principal:qualification",
  actorId: "actor:qualification",
  sessionId: "session:qualification",
  clientId: "client:qualification",
  authorizationEpoch: 1,
};

function fixture() {
  const snapshot = emptyAuthorityPlaneSnapshot(session.realmId);
  snapshot.projects["project:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.project, id: "project:promotion-reconciliation-qualification", name: "Promotion reconciliation qualification", referenceType: "git", sourceSpaceIds: ["source:promotion-reconciliation-qualification"] };
  snapshot.sourceSpaces["source:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.sourceSpace, id: "source:promotion-reconciliation-qualification", name: "qualification", classification: "public" };
  snapshot.projectRevisions["project-revision:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.kernel, id: "project-revision:promotion-reconciliation-qualification", projectId: "project:promotion-reconciliation-qualification", sourceSpaceSnapshots: { "source:promotion-reconciliation-qualification": "git:qualification" } };
  snapshot.canonicalByProject["project:promotion-reconciliation-qualification"] = "project-revision:promotion-reconciliation-qualification";
  snapshot.artifacts["artifact:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.artifact, id: "artifact:promotion-reconciliation-qualification", type: "cli.archive", digest: "sha256:artifact", projectRevisionId: "project-revision:promotion-reconciliation-qualification" };
  snapshot.releases["release:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.release, id: "release:promotion-reconciliation-qualification", projectRevisionId: "project-revision:promotion-reconciliation-qualification", artifactIds: ["artifact:promotion-reconciliation-qualification"], evidenceIds: [], configurationDigests: ["sha256:configuration"], stateAssumptions: [], policyVersion: "policy:qualification", status: "ready" };
  snapshot.targets["target:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.target, id: "target:promotion-reconciliation-qualification", projectId: "project:promotion-reconciliation-qualification", name: "Qualification target", adapterId: "adapter:qualification", acceptedArtifactTypes: ["cli.archive"], requiredEvidenceKeys: [], state: "configured", currentReleaseId: null, releaseHistory: [] };
  snapshot.promotions["promotion:promotion-reconciliation-qualification"] = { protocol: CONTRACT_VERSIONS.promotion, id: "promotion:promotion-reconciliation-qualification", projectId: "project:promotion-reconciliation-qualification", targetId: "target:promotion-reconciliation-qualification", releaseId: "release:promotion-reconciliation-qualification", releaseDigest: "declared:qualification", previousReleaseId: null, expectedCurrentReleaseId: null, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: "request:qualification", actor: { principalId: session.principalId, actorId: session.actorId, sessionId: session.sessionId, clientId: session.clientId }, createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", receipt: "promotion=blocked" };
  return { snapshot, promotionId: "promotion:promotion-reconciliation-qualification", executionIdempotencyKey: "execute:promotion-reconciliation-qualification" };
}

function healthyExecutor(): { execute(context: Readonly<PromotionExecutionContext>): Promise<PromotionExecutionResult> } {
  return {
    async execute(context) {
      return {
        protocol: PROMOTION_EXECUTION_PROTOCOL,
        status: "succeeded",
        adapterId: context.target.adapterId,
        executionDigest: context.executionDigest,
        promotion: { ...context.promotion, state: "healthy", attempt: context.promotion.attempt + 1, providerOperationId: "provider-operation:qualification", receipt: "provider=qualification; operation=healthy; release-bound=true" },
        target: { id: context.target.id, projectId: context.project.id, state: "healthy", currentReleaseId: context.release.id, releaseHistory: [...(context.target.releaseHistory ?? []), context.release.id] },
        checkpoint: { idempotencyKey: context.executionIdempotencyKey, attempt: context.promotion.attempt + 1, stage: "complete", providerOperationIds: ["provider-operation:qualification"], receipt: "checkpoint=provider-complete" },
        receipt: "provider=qualification; release-bound=true",
      };
    },
  };
}

try {
  const { snapshot, promotionId, executionIdempotencyKey } = fixture();
  const firstCoordinator = new AuthorityPlaneCoordinator(snapshot);
  const first = await firstCoordinator.executePromotion({ promotionId, executionIdempotencyKey, executor: { execute: async () => { throw new Error("transport timeout after provider apply"); } }, session });
  if (first.status !== "indeterminate") throw new Error(`expected indeterminate first attempt; received ${first.status}`);
  const firstCheckpoint = first.value.checkpoint as { executionDigest?: string; idempotencyKey: string };
  if (!firstCheckpoint.executionDigest || firstCheckpoint.idempotencyKey !== executionIdempotencyKey) throw new Error("durable checkpoint did not retain the immutable execution identity");
  const restarted = new AuthorityPlaneCoordinator(firstCoordinator.snapshot());
  const reconciled = await restarted.reconcilePromotion({ promotionId, reconciliationIdempotencyKey: "reconcile:promotion-reconciliation-qualification", executor: healthyExecutor(), session });
  if (reconciled.status !== "succeeded") throw new Error(`reconciliation did not reach healthy state: ${reconciled.status}`);
  const target = reconciled.value.target as { currentReleaseId?: string | null };
  if (target.currentReleaseId !== "release:promotion-reconciliation-qualification") throw new Error("reconciliation advanced an unexpected Target Release pointer");
  const checkpoint = reconciled.value.checkpoint as { executionDigest?: string; idempotencyKey: string };
  if (checkpoint.executionDigest !== firstCheckpoint.executionDigest || checkpoint.idempotencyKey !== executionIdempotencyKey) throw new Error("reconciliation changed the immutable provider identity");
  console.log(JSON.stringify({ protocol, status: "succeeded", restart: "snapshot-restored", firstAttempt: first.status, reconciled: reconciled.status, targetCurrentReleaseId: target.currentReleaseId, executionIdempotencyKey, executionDigest: checkpoint.executionDigest, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, receipt: "checkpoint=durable; identity=immutable; stale-callbacks=release-and-digest-bound; target-pointer=advanced-only-after-healthy" }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", canonicalWrite: false, recoveryAction: "inspect the durable Promotion checkpoint and retry the same bounded reconciliation qualification", receipt: `providerInvocation=fixture-only; authority=${AUTHORITY_PLANE_PROTOCOL}; target-pointer=not-advanced` }, null, 2));
  process.exitCode = 2;
}
