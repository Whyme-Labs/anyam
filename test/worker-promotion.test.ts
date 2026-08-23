import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createWorkerTarget,
  sealVerifiedRelease,
  shipWorkerRelease,
  WorkerPromotionCoordinator,
  type DeliveryAdapterResult,
  type HealthObservation,
  type ImmutableRelease,
  type WorkerDeployment,
  type WorkerPreview,
  type WorkerTarget,
  type WorkerTargetAdapter,
} from "../src/delivery/promotion.ts";
import { createMigrationPlan } from "../src/delivery/migration-plan.ts";
import type { Release } from "../src/kernel/contracts.ts";
import {
  normalizeProjectManifest,
  runLocalRelease,
  targetFromManifest,
  type LocalExecutionContext,
} from "../src/execution/local.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

const actor = {
  principalId: "principal:worker-release-test",
  actorId: "actor:worker-release-test",
  sessionId: "session:worker-release-test",
  clientId: "client:worker-release-test",
};

function context(directory: string): LocalExecutionContext {
  return {
    directory,
    projectRevisionId: "project-revision:worker:v1",
    projectViewId: "project-view:worker:project",
    sourceSpaceSnapshots: { "worker-source": "snapshot:worker:v1" },
    actor,
    runnerId: "runner:local",
    policyVersion: "policy:worker-release:v1",
    authorizationEpoch: "epoch:worker-release:v1",
    capabilityGrantId: "grant:worker-release",
    dependencyDigest: "sha256:worker-dependencies:v1",
    toolchainDigest: "sha256:worker-toolchain:v1",
    environmentDigest: "sha256:worker-environment:v1",
    disclosure: { projectionId: "project-view:worker:project", classification: "project" },
    owner: "worker release test",
    changeRevisionId: "change-revision:worker:v1",
    workspaceId: "workspace:worker:v1",
    targetId: "target:worker",
    declaredEffects: ["artifact.create", "target.promote"],
  };
}

async function workerRelease(name: string, migrationPlan?: Release["migrationPlan"]): Promise<{ release: ImmutableRelease; directory: string; target: WorkerTarget }> {
  const directory = await mkdtemp(join(tmpdir(), `anyam-worker-promotion-${name}-`));
  await cp(join(fixtureRoot, "worker"), directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, "anyam.json"), "utf8")) as unknown;
  const normalized = normalizeProjectManifest(manifest);
  const target = createWorkerTarget({
    target: targetFromManifest(normalized.targets[0]!, normalized.projectId),
    capabilities: { preview: true, promote: true, healthCheck: true, rollback: true },
  });
  const result = await runLocalRelease({
    manifest,
    context: context(directory),
    releaseName: name,
  });
  return {
    directory,
    target,
    release: sealVerifiedRelease({
      projectId: normalized.projectId,
      release: migrationPlan === undefined ? result.release : { ...result.release, migrationPlan },
      artifacts: result.artifacts,
      evidence: result.evidence,
      target,
    }),
  };
}

type AdapterOptions = {
  healthStates?: readonly HealthObservation["state"][];
  applyFailures?: number;
};

class ScriptedWorkerAdapter implements WorkerTargetAdapter {
  readonly protocol = "anyam.target-adapter/v1" as const;
  readonly id = "cloudflare.worker";
  readonly contractDigest = "sha256:scripted-worker-adapter:v1";
  readonly calls: Array<{ operation: string; releaseDigest: string; artifactDigests: readonly string[]; targetCurrentReleaseId: string | null }> = [];
  private readonly healthStates: HealthObservation["state"][];
  private applyFailures: number;
  private sequence = 0;

  constructor(options: AdapterOptions = {}) {
    this.healthStates = [...(options.healthStates ?? [])];
    this.applyFailures = options.applyFailures ?? 0;
  }

  async preview(input: { release: ImmutableRelease; target: WorkerTarget }): Promise<DeliveryAdapterResult<WorkerPreview>> {
    this.record("preview", input.release, input.target);
    return {
      status: "succeeded",
      value: {
        previewId: `preview:${++this.sequence}`,
        providerVersionId: `version:preview:${this.sequence}`,
        releaseDigest: input.release.releaseDigest,
        artifactDigests: input.release.artifacts.map((artifact) => artifact.digest),
        receipt: `preview=scripted; releaseDigest=${input.release.releaseDigest}`,
      },
      receipt: `provider=scripted; operation=preview; sequence=${this.sequence}`,
    };
  }

  async apply(input: { release: ImmutableRelease; target: WorkerTarget }): Promise<DeliveryAdapterResult<WorkerDeployment>> {
    this.record("apply", input.release, input.target);
    if (this.applyFailures > 0) {
      this.applyFailures -= 1;
      return {
        status: "failed",
        outcome: "failed",
        errorCode: "scripted.apply_failed",
        message: "scripted provider rejected the deployment before changing the Target",
        retryable: true,
        recoveryAction: "inspect the provider receipt and retry the same immutable Release",
        receipt: "provider=scripted; operation=apply; changedTarget=false",
      };
    }
    return {
      status: "succeeded",
      value: {
        deploymentId: `deployment:${++this.sequence}`,
        providerVersionId: `version:apply:${this.sequence}`,
        releaseDigest: input.release.releaseDigest,
        artifactDigests: input.release.artifacts.map((artifact) => artifact.digest),
        providerOperationId: `provider-operation:${this.sequence}`,
        receipt: `deployment=scripted; releaseDigest=${input.release.releaseDigest}`,
      },
      receipt: `provider=scripted; operation=apply; sequence=${this.sequence}`,
    };
  }

  async health(input: { release: ImmutableRelease; target: WorkerTarget; deploymentId?: string }): Promise<DeliveryAdapterResult<HealthObservation>> {
    this.record("health", input.release, input.target);
    const state = this.healthStates.shift() ?? "healthy";
    const observation: HealthObservation = {
      protocol: "anyam.health-observation/v1",
      id: `health:${++this.sequence}`,
      targetId: input.target.id,
      releaseId: input.release.release.id,
      state,
      checkId: "worker-health:scripted",
      checkedAt: `2026-08-03T00:00:${String(this.sequence).padStart(2, "0")}Z`,
      receipt: `health=scripted; state=${state}; deployment=${input.deploymentId ?? "none"}`,
      outputDigest: `sha256:health:${this.sequence}`,
    };
    return { status: "succeeded", value: observation, receipt: observation.receipt };
  }

  async rollback(input: { release: ImmutableRelease; previousRelease: ImmutableRelease; target: WorkerTarget }): Promise<DeliveryAdapterResult<WorkerDeployment>> {
    this.record("rollback", input.previousRelease, input.target);
    return {
      status: "succeeded",
      value: {
        deploymentId: `deployment:rollback:${++this.sequence}`,
        providerVersionId: `version:rollback:${this.sequence}`,
        releaseDigest: input.previousRelease.releaseDigest,
        artifactDigests: input.previousRelease.artifacts.map((artifact) => artifact.digest),
        providerOperationId: `provider-operation:rollback:${this.sequence}`,
        receipt: `rollback=scripted; releaseDigest=${input.previousRelease.releaseDigest}`,
      },
      receipt: `provider=scripted; operation=rollback; sequence=${this.sequence}`,
    };
  }

  private record(operation: string, release: ImmutableRelease, target: WorkerTarget): void {
    this.calls.push({
      operation,
      releaseDigest: release.releaseDigest,
      artifactDigests: release.artifacts.map((artifact) => artifact.digest),
      targetCurrentReleaseId: target.currentReleaseId,
    });
  }
}

async function closeReleases(...releases: readonly { directory: string }[]): Promise<void> {
  await Promise.all(releases.map((release) => rm(release.directory, { recursive: true, force: true })));
}

test("Worker Promotion moves one immutable Artifact/Release through preview and health before changing Target", async () => {
  const built = await workerRelease("worker-release-healthy");
  try {
    const adapter = new ScriptedWorkerAdapter({ healthStates: ["healthy"] });
    const coordinator = new WorkerPromotionCoordinator({ projectId: "project:worker", target: built.target, adapter });
    coordinator.registerRelease(built.release);

    const originalReleaseName = built.release.release.name;
    (built.release.release as unknown as { name?: string }).name = "mutated-after-sealing";
    const promotion = await shipWorkerRelease({
      coordinator,
      releaseId: built.release.release.id,
      idempotencyKey: "ship:worker:healthy:v1",
      actor,
    });

    assert.equal(promotion.state, "healthy");
    assert.equal(promotion.releaseDigest, coordinator.getRelease(built.release.release.id)?.releaseDigest);
    assert.equal(coordinator.getTarget().currentReleaseId, built.release.release.id);
    assert.equal(coordinator.getTarget().state, "healthy");
    assert.equal(coordinator.getRelease(built.release.release.id)?.release.name, originalReleaseName);
    assert.deepEqual(adapter.calls.map((call) => call.operation), ["preview", "apply", "health"]);
    assert.equal(new Set(adapter.calls.map((call) => call.releaseDigest)).size, 1);
    assert.deepEqual(coordinator.listEvents().map((event) => event.to), ["proposed", "validating", "approved", "applying", "healthy"]);
    assert.equal(promotion.health?.state, "healthy");
    assert.match(promotion.receipt, /artifactDigests=sha256:/);
  } finally {
    await closeReleases(built);
  }
});

test("unhealthy Worker Promotion keeps the previous Release serving and records a verified rollback", async () => {
  const first = await workerRelease("worker-release-first");
  const second = await workerRelease("worker-release-unhealthy");
  try {
    const adapter = new ScriptedWorkerAdapter({ healthStates: ["healthy", "unhealthy", "healthy"] });
    const coordinator = new WorkerPromotionCoordinator({ projectId: "project:worker", target: first.target, adapter });
    coordinator.registerRelease(first.release);
    coordinator.registerRelease(second.release);
    const initial = await coordinator.promote({ releaseId: first.release.release.id, idempotencyKey: "ship:worker:first:v1", actor });
    const failed = await coordinator.promote({ releaseId: second.release.release.id, idempotencyKey: "ship:worker:unhealthy:v1", actor });

    assert.equal(initial.state, "healthy");
    assert.equal(failed.state, "rolled-back");
    assert.match(failed.healthFailure ?? "", /unhealthy/);
    assert.equal(failed.rollbackHealth?.state, "healthy");
    assert.equal(coordinator.getTarget().currentReleaseId, first.release.release.id);
    assert.equal(coordinator.getTarget().state, "healthy");
    assert.deepEqual(coordinator.getTarget().releaseHistory, [first.release.release.id]);
    assert.ok(coordinator.listEvents().some((event) => event.promotionId === failed.id && event.to === "degraded"));
    assert.ok(coordinator.listEvents().some((event) => event.promotionId === failed.id && event.to === "rolled-back"));
    const secondHealthCall = adapter.calls.find((call, index) => call.operation === "health" && index > 2);
    assert.equal(secondHealthCall?.targetCurrentReleaseId, first.release.release.id);
  } finally {
    await closeReleases(first, second);
  }
});

test("health-failure rollback obeys every Migration Plan rollback mode", async () => {
  const modes: Array<{ name: string; plan: Release["migrationPlan"]; expectedState: "rolled-back" | "degraded" }> = [
    { name: "safe", plan: createMigrationPlan({ strategy: "manual", compatibility: "unknown", rollback: "safe" }), expectedState: "rolled-back" },
    { name: "application-only-proven", plan: createMigrationPlan({ strategy: "expand-contract", beforeSchemaDigest: "sha256:before", afterSchemaDigest: "sha256:after", compatibility: "bidirectional", rollback: "application-only" }), expectedState: "rolled-back" },
    { name: "application-only-unknown", plan: createMigrationPlan({ strategy: "custom", compatibility: "unknown", rollback: "application-only" }), expectedState: "degraded" },
    { name: "manual-data-action", plan: createMigrationPlan({ strategy: "manual", compatibility: "forward-only", rollback: "manual-data-action" }), expectedState: "degraded" },
    { name: "blocked", plan: createMigrationPlan({ strategy: "custom", compatibility: "backward-compatible", rollback: "blocked" }), expectedState: "degraded" },
  ];
  for (const mode of modes) {
    const first = await workerRelease(`worker-release-migration-${mode.name}-first`);
    const second = await workerRelease(`worker-release-migration-${mode.name}-candidate`, mode.plan);
    try {
      const adapter = new ScriptedWorkerAdapter({ healthStates: ["healthy", "unhealthy", "healthy"] });
      const coordinator = new WorkerPromotionCoordinator({ projectId: "project:worker", target: first.target, adapter });
      coordinator.registerRelease(first.release);
      coordinator.registerRelease(second.release);
      await coordinator.promote({ releaseId: first.release.release.id, idempotencyKey: `ship:worker:migration:${mode.name}:first`, actor });
      const failed = await coordinator.promote({ releaseId: second.release.release.id, idempotencyKey: `ship:worker:migration:${mode.name}:candidate`, actor });
      assert.equal(failed.state, mode.expectedState, mode.name);
      assert.match(failed.receipt, new RegExp(`migrationRollback=${mode.plan?.rollback}`));
      if (mode.expectedState === "degraded") assert.equal(failed.rollbackHealth, undefined, mode.name);
    } finally {
      await closeReleases(first, second);
    }
  }
});

test("failed Worker Promotion retry is idempotent and reuses the sealed Release without rebuilding", async () => {
  const built = await workerRelease("worker-release-retry");
  try {
    const adapter = new ScriptedWorkerAdapter({ applyFailures: 1, healthStates: ["healthy"] });
    const coordinator = new WorkerPromotionCoordinator({ projectId: "project:worker", target: built.target, adapter });
    coordinator.registerRelease(built.release);
    const [firstAttempt, concurrentDuplicate] = await Promise.all([
      coordinator.promote({ releaseId: built.release.release.id, idempotencyKey: "ship:worker:retry:v1", actor }),
      coordinator.promote({ releaseId: built.release.release.id, idempotencyKey: "ship:worker:retry:v1", actor }),
    ]);
    const duplicate = await coordinator.promote({ releaseId: built.release.release.id, idempotencyKey: "ship:worker:retry:v1", actor });
    const retried = await coordinator.retryPromotion({ promotionId: firstAttempt.id, idempotencyKey: "ship:worker:retry:v2", actor });
    const retryDuplicate = await coordinator.retryPromotion({ promotionId: firstAttempt.id, idempotencyKey: "ship:worker:retry:v2", actor });

    assert.equal(firstAttempt.state, "failed");
    assert.equal(firstAttempt.receipt.includes("changedTarget=false"), true);
    assert.equal(concurrentDuplicate.id, firstAttempt.id);
    assert.equal(concurrentDuplicate.state, "failed");
    assert.equal(duplicate.id, firstAttempt.id);
    assert.equal(duplicate.state, "failed");
    assert.equal(retried.state, "healthy");
    assert.equal(retried.attempt, 1);
    assert.equal(retried.releaseDigest, built.release.releaseDigest);
    assert.equal(retryDuplicate.id, retried.id);
    assert.equal(adapter.calls.filter((call) => call.operation === "apply").length, 2);
    assert.equal(new Set(adapter.calls.filter((call) => call.operation === "apply").map((call) => call.releaseDigest)).size, 1);
    assert.equal(coordinator.getTarget().currentReleaseId, built.release.release.id);
    assert.ok(coordinator.listEvents().some((event) => event.from === "failed" && event.to === "proposed"));
  } finally {
    await closeReleases(built);
  }
});

test("explicit rollback is a new audited Promotion to the prior known-good Release", async () => {
  const first = await workerRelease("worker-release-rollback-first");
  const second = await workerRelease("worker-release-rollback-second");
  try {
    const adapter = new ScriptedWorkerAdapter({ healthStates: ["healthy", "healthy", "healthy"] });
    const coordinator = new WorkerPromotionCoordinator({ projectId: "project:worker", target: first.target, adapter });
    coordinator.registerRelease(first.release);
    coordinator.registerRelease(second.release);
    const firstPromotion = await coordinator.promote({ releaseId: first.release.release.id, idempotencyKey: "ship:worker:rollback:first:v1", actor });
    const secondPromotion = await coordinator.promote({ releaseId: second.release.release.id, idempotencyKey: "ship:worker:rollback:second:v1", actor });
    const rollback = await coordinator.rollbackToPrevious({ idempotencyKey: "rollback:worker:v1", actor });

    assert.equal(firstPromotion.state, "healthy");
    assert.equal(secondPromotion.state, "healthy");
    assert.equal(rollback.kind, "rollback");
    assert.equal(rollback.state, "healthy");
    assert.equal(rollback.releaseId, first.release.release.id);
    assert.equal(rollback.rollbackOfPromotionId, secondPromotion.id);
    assert.equal(coordinator.getTarget().currentReleaseId, first.release.release.id);
    assert.deepEqual(coordinator.getTarget().releaseHistory, [first.release.release.id, second.release.release.id, first.release.release.id]);
    assert.ok(coordinator.listEvents().some((event) => event.promotionId === rollback.id && event.to === "healthy"));
    assert.equal(adapter.calls.filter((call) => call.operation === "rollback").length, 1);
  } finally {
    await closeReleases(first, second);
  }
});
