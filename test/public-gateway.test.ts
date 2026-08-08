import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  PublicGatewayCoordinator,
  applyPublicGatewayEdgeLimit,
  type PublicGatewayState,
  type PublicGatewayStore,
  type PublicIntakePolicy,
} from "../src/index.ts";

function policy(mode: PublicIntakePolicy["mode"] = "rate-limited"): PublicIntakePolicy {
  return {
    protocol: CONTRACT_VERSIONS.publicIntake,
    id: "policy:gateway:test",
    realmId: "realm:gateway:test",
    projectId: "project:video-player",
    publicSourceSpaceId: "source:video-player-public",
    mode,
    window: "fixture:event-window",
    ...(mode === "rate-limited" ? {
      configuredLimit: {
        value: 3,
        unit: "public-contribution-requests",
        measuredAt: "2026-08-08T00:00:00.000Z",
        method: "controlled gateway healthy/abuse fixture",
        receipt: "receipt:gateway-public-intake-tripwire",
      },
    } : {}),
    owner: "principal:gateway-owner",
    receipt: "receipt:gateway-policy",
  };
}

class MemoryStore implements PublicGatewayStore {
  value: PublicGatewayState | undefined;

  async load(): Promise<PublicGatewayState | undefined> {
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: PublicGatewayState): Promise<void> {
    this.value = structuredClone(state);
  }
}

const clock = () => new Date("2026-08-08T00:00:00.000Z");

test("gateway is closed by default, quarantines accepted input, and makes completed requests idempotent", async () => {
  const store = new MemoryStore();
  const coordinator = new PublicGatewayCoordinator(policy(), store, clock);

  const closed = await coordinator.submit({ requestId: "request:closed", actorId: "actor:anonymous", contributionId: "contribution:closed", payloadDigest: "sha256:closed" });
  assert.equal(closed.status, "denied");
  assert.match(closed.decision.receipt, /state=closed/);

  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");
  const accepted = await coordinator.submit({ requestId: "request:1", actorId: "actor:anonymous", contributionId: "contribution:1", payloadDigest: "sha256:one" });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.decision.disposition, "quarantined");
  assert.match(accepted.decision.receipt, /landingAuthority=false/);
  const duplicate = await coordinator.submit({ requestId: "request:1", actorId: "actor:anonymous", contributionId: "contribution:1", payloadDigest: "sha256:one" });
  assert.equal(duplicate.status, "accepted");
  assert.equal(duplicate.idempotent, true);

  const replay = await coordinator.submit({ requestId: "request:1", actorId: "actor:anonymous", contributionId: "contribution:changed", payloadDigest: "sha256:changed" });
  assert.equal(replay.status, "denied");
  assert.match(replay.decision.receipt, /replay=true/);
  assert.match(replay.decision.nextAction, /new requestId/);
  const snapshot = await coordinator.snapshot();
  assert.deepEqual(snapshot.preservedContributionIds, ["contribution:1"]);
  assert.equal(snapshot.accepted, 1);
  assert.equal(snapshot.audit.some((event) => event.action === "submit" && event.outcome === "accepted"), true);
});

test("provider timeout is retryable with the same idempotency key and preserves recovery history", async () => {
  const store = new MemoryStore();
  const coordinator = new PublicGatewayCoordinator(policy(), store, clock);
  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");

  const timedOut = await coordinator.submit({
    requestId: "request:retry",
    actorId: "actor:anonymous",
    contributionId: "contribution:retry",
    payloadDigest: "sha256:retry",
    provider: { status: "timeout", receipt: "provider=git-driver; timeout=simulated; retryable=true" },
  });
  assert.equal(timedOut.status, "denied");
  assert.match(timedOut.decision.nextAction, /retry the same idempotency key/);
  assert.match(timedOut.decision.receipt, /materialized=false/);

  const recovered = await coordinator.submit({
    requestId: "request:retry",
    actorId: "actor:anonymous",
    contributionId: "contribution:retry",
    payloadDigest: "sha256:retry",
  });
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.idempotent, false);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.accepted, 1);
  assert.deepEqual(snapshot.preservedContributionIds, ["contribution:retry"]);
  assert.equal(snapshot.requestRecords.length, 2);
  assert.equal(snapshot.requestRecords[0]?.retryable, true);
  assert.match(snapshot.recoveryCheckpoint, /provider-timeout/);
});

test("suspension, review reopen, approval-only intake, and cleanup preserve accepted lineage", async () => {
  const store = new MemoryStore();
  const coordinator = new PublicGatewayCoordinator(policy("approval-only"), store, clock);
  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");
  const pending = await coordinator.submit({ requestId: "request:pending", actorId: "actor:anonymous", contributionId: "contribution:pending", payloadDigest: "sha256:pending" });
  assert.equal(pending.status, "approval_required");

  await coordinator.suspend({ id: "principal:gateway-moderator", role: "moderator" }, "abuse-shaped fixture traffic", "receipt:suspend");
  const denied = await coordinator.submit({ requestId: "request:suspended", actorId: "actor:anonymous", contributionId: "contribution:suspended", payloadDigest: "sha256:suspended" });
  assert.equal(denied.status, "denied");
  assert.match(denied.decision.receipt, /state=suspended/);
  await coordinator.reopen({ id: "principal:gateway-moderator", role: "moderator" }, "receipt:review-reopen");
  await coordinator.cleanup({ id: "principal:gateway-owner", role: "owner" }, "receipt:cleanup");

  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.status, "closed");
  assert.equal(snapshot.pendingReview, 0);
  assert.equal(snapshot.requestRecords.length, 2);
  assert.equal(snapshot.audit.some((event) => event.action === "cleanup"), true);
  assert.match(snapshot.recoveryCheckpoint, /cleanup/);
});

test("edge limiter decision is explicit and does not claim authoritative logical accounting", async () => {
  const configuredLimit = policy().configuredLimit;
  assert.ok(configuredLimit);
  const allowed = await applyPublicGatewayEdgeLimit({
    limiter: { limit: async () => ({ success: true }) },
    key: "coarse-edge-key:fixture",
    configuredLimit,
    requestId: "request:edge-1",
  });
  assert.equal(allowed.status, "allowed");
  assert.match(allowed.receipt, /logicalLedger=authoritative=false/);

  const denied = await applyPublicGatewayEdgeLimit({
    limiter: { limit: async () => ({ success: false }) },
    key: "coarse-edge-key:fixture",
    configuredLimit,
    requestId: "request:edge-2",
  });
  assert.equal(denied.status, "denied");
  assert.match(denied.nextAction, /not materialized/);
  assert.match(denied.receipt, /success=false/);
});

test("stored coordinator state fails closed when its policy receipt drifts", async () => {
  const store = new MemoryStore();
  const coordinator = new PublicGatewayCoordinator(policy(), store, clock);
  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");
  const stored = await coordinator.snapshot();
  await store.save({
    ...stored,
    policy: { ...stored.policy, receipt: "receipt:unexpected-policy" },
  });

  await assert.rejects(
    () => coordinator.snapshot(),
    (error: unknown) => error instanceof Error && error.name === "PublicGatewayError" && error.message.includes("does not match"),
  );
});
