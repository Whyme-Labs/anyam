import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  PublicIntakeController,
  PublicIntakeError,
  type PublicIntakePolicy,
} from "../src/index.ts";

function policy(mode: PublicIntakePolicy["mode"] = "rate-limited"): PublicIntakePolicy {
  return {
    protocol: CONTRACT_VERSIONS.publicIntake,
    id: "policy:public-intake:test",
    realmId: "realm:test",
    projectId: "project:video-player",
    publicSourceSpaceId: "source:player",
    mode,
    window: "fixture:event-window",
    ...(mode === "rate-limited" ? {
      configuredLimit: {
        value: 3,
        unit: "public-contribution-requests",
        measuredAt: "2026-08-08T00:00:00.000Z",
        method: "controlled healthy/abuse fixture",
        receipt: "receipt:test-public-intake-limit",
      },
    } : {}),
    owner: "team:moderation",
    receipt: "receipt:test-public-intake-policy",
  };
}

test("public intake quarantines accepted contributions and never grants Landing authority", () => {
  const controller = new PublicIntakeController(policy());
  controller.open({ id: "principal:owner", role: "owner" });
  const result = controller.submit({ requestId: "request:1", actorId: "actor:anonymous", contributionId: "contribution:1" });
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  assert.equal(result.decision.disposition, "quarantined");
  assert.match(result.decision.nextAction, /Change Revision/);
  assert.equal(result.decision.configuredLimit?.receipt, "receipt:test-public-intake-limit");
  assert.deepEqual(controller.snapshot().preservedContributionIds, ["contribution:1"]);
});

test("rate-limit denial names the configured limit, request, receipt, and recovery action", () => {
  const controller = new PublicIntakeController(policy());
  controller.open({ id: "principal:owner", role: "owner" });
  for (const index of [1, 2, 3]) controller.submit({ requestId: `request:${index}`, actorId: "actor:anonymous", contributionId: `contribution:${index}` });
  const result = controller.submit({ requestId: "request:4", actorId: "actor:anonymous", contributionId: "contribution:4" });
  assert.equal(result.status, "denied");
  if (result.status !== "denied") return;
  assert.equal(result.decision.configuredLimit?.value, 3);
  assert.equal(result.decision.requested, 4);
  assert.match(result.decision.receipt, /materialized=false/);
  assert.match(result.decision.nextAction, /reset|higher-grant|policy/);
  assert.equal(controller.snapshot().denied, 1);
});

test("missing measured limits fail closed instead of inventing a public quota", () => {
  const { configuredLimit: _configuredLimit, ...withoutMeasuredLimit } = policy();
  assert.throws(() => new PublicIntakeController(withoutMeasuredLimit), (error: unknown) => {
    assert.ok(error instanceof PublicIntakeError);
    assert.equal(error.code, "invalid-policy");
    assert.match(error.recoveryAction, /measurement|approval-only/);
    return true;
  });
});

test("approval-only intake and moderation preserve history through cleanup", () => {
  const controller = new PublicIntakeController(policy("approval-only"));
  controller.open({ id: "principal:owner", role: "owner" });
  const pending = controller.submit({ requestId: "request:1", actorId: "actor:anonymous", contributionId: "contribution:1" });
  assert.equal(pending.status, "approval_required");
  controller.suspend({ actor: { id: "principal:moderator", role: "moderator" }, reason: "abuse-shaped fixture traffic", receipt: "receipt:suspension" });
  const denied = controller.submit({ requestId: "request:2", actorId: "actor:anonymous", contributionId: "contribution:2" });
  assert.equal(denied.status, "denied");
  controller.reopen({ actor: { id: "principal:moderator", role: "moderator" }, reviewReceipt: "receipt:review" });
  controller.cleanup({ actor: { id: "principal:owner", role: "owner" }, cleanupReceipt: "receipt:cleanup" });
  const snapshot = controller.snapshot();
  assert.equal(snapshot.status, "closed");
  assert.deepEqual(snapshot.preservedContributionIds, []);
  assert.equal(snapshot.pendingReview, 0);
  assert.equal(snapshot.policy.projectId, "project:video-player");
});
