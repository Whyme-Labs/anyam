import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  PublicGatewayCoordinator,
  PUBLIC_GATEWAY_LEDGER_PROTOCOL,
  applyPublicGatewayEdgeLimit,
  parsePublicGatewayProviderOutcome,
  type PublicGatewayState,
  type PublicGatewayLedgerExport,
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
  exports = new Map<string, PublicGatewayLedgerExport>();

  async load(): Promise<PublicGatewayState | undefined> {
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: PublicGatewayState): Promise<void> {
    this.value = structuredClone(state);
  }

  async saveLedgerExport(bundle: PublicGatewayLedgerExport): Promise<void> {
    this.exports.set(bundle.exportId, structuredClone(bundle));
  }

  async loadLedgerExport(exportId: string): Promise<PublicGatewayLedgerExport | undefined> {
    const bundle = this.exports.get(exportId);
    return bundle ? structuredClone(bundle) : undefined;
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

test("provider challenge is ledgered as a retryable denial and never materializes a contribution", async () => {
  const store = new MemoryStore();
  const coordinator = new PublicGatewayCoordinator(policy(), store, clock);
  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");

  const challenged = await coordinator.submit({
    requestId: "request:challenge",
    actorId: "actor:anonymous",
    contributionId: "contribution:challenge",
    payloadDigest: "sha256:challenge",
    provider: { status: "abuse", outcome: "challenge", retryable: true, receipt: "provider=cloudflare-turnstile; validation=failed; rawProviderError=not-disclosed" },
  });
  assert.equal(challenged.status, "denied");
  assert.equal(challenged.providerOutcome, "challenge");
  assert.match(challenged.decision.receipt, /materialized=false/);

  const recovered = await coordinator.submit({
    requestId: "request:challenge",
    actorId: "actor:anonymous",
    contributionId: "contribution:challenge",
    payloadDigest: "sha256:challenge",
  });
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.idempotent, false);
  const snapshot = await coordinator.snapshot();
  assert.equal(snapshot.accepted, 1);
  assert.deepEqual(snapshot.preservedContributionIds, ["contribution:challenge"]);
  assert.match(snapshot.recoveryCheckpoint, /abuse:challenge/);
});

function retentionPolicy(overrides: Partial<Record<"requestRecordLimit" | "requestTombstoneLimit" | "auditEventLimit" | "retryableRetentionMs" | "terminalDenialRetentionMs", number>> = {}) {
  const measured = (name: string, value: number, unit: string) => ({
    value,
    unit,
    measuredAt: "2026-08-08T00:00:00.000Z",
    method: `controlled-ledger-retention-fixture:${name}`,
    receipt: `receipt:ledger-retention:${name}`,
  });
  return {
    protocol: PUBLIC_GATEWAY_LEDGER_PROTOCOL,
    requestRecordLimit: measured("request-records", overrides.requestRecordLimit ?? 4, "detailed-request-records"),
    requestTombstoneLimit: measured("request-tombstones", overrides.requestTombstoneLimit ?? 4, "exact-replay-tombstones"),
    auditEventLimit: measured("audit-events", overrides.auditEventLimit ?? 8, "audit-events"),
    retryableRetentionMs: measured("retryable-age", overrides.retryableRetentionMs ?? 1000, "milliseconds"),
    terminalDenialRetentionMs: measured("terminal-age", overrides.terminalDenialRetentionMs ?? 1000, "milliseconds"),
    receipt: "receipt:ledger-retention-policy-fixture",
  } as const;
}

test("ledger export survives restart and compaction retains exact replay tombstones and accepted lineage", async () => {
  const store = new MemoryStore();
  let now = new Date("2026-08-08T00:00:00.000Z");
  const gatewayClock = () => now;
  const coordinator = new PublicGatewayCoordinator(policy(), store, gatewayClock);

  const closed = await coordinator.submit({ requestId: "request:compact-terminal", actorId: "actor:anonymous", contributionId: "contribution:compact-terminal", payloadDigest: "sha256:terminal" });
  assert.equal(closed.status, "denied");
  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");
  const retryable = await coordinator.submit({ requestId: "request:compact-retryable", actorId: "actor:anonymous", contributionId: "contribution:compact-retryable", payloadDigest: "sha256:retryable", provider: { status: "timeout", receipt: "provider=fixture; timeout=true; retryable=true" } });
  assert.equal(retryable.status, "denied");
  const accepted = await coordinator.submit({ requestId: "request:compact-accepted", actorId: "actor:anonymous", contributionId: "contribution:compact-accepted", payloadDigest: "sha256:accepted" });
  assert.equal(accepted.status, "accepted");

  now = new Date("2026-08-08T00:00:02.000Z");
  const exported = await coordinator.exportLedger({ actorId: "principal:gateway-owner", exportId: "ledger-export:restart-fixture", receipt: "receipt:ledger-export:restart-fixture" });
  assert.equal(exported.protocol, PUBLIC_GATEWAY_LEDGER_PROTOCOL);
  assert.equal(store.exports.has(exported.exportId), true);
  assert.match(exported.digest, /^sha256:[0-9a-f]{64}$/);

  const compacted = await coordinator.compactLedger({ actorId: "principal:gateway-owner", exportId: exported.exportId, policy: retentionPolicy(), receipt: "receipt:ledger-compact:restart-fixture" });
  assert.equal(compacted.status, "compacted");
  assert.equal(compacted.compacted.requestRecords, 2);
  assert.equal(compacted.after.requestRecords, 1);
  assert.equal(compacted.after.requestTombstones, 2);
  assert.match(compacted.receipt, /acceptedLineage=preserved/);

  const restarted = new PublicGatewayCoordinator(policy(), store, gatewayClock);
  const snapshot = await restarted.snapshot();
  assert.deepEqual(snapshot.preservedContributionIds, ["contribution:compact-accepted"]);
  assert.equal(snapshot.requestRecords.length, 1);
  assert.equal(snapshot.ledger.requestTombstones.length, 2);
  assert.equal(snapshot.ledger.lastExport?.digest, exported.digest);

  const compactedReplay = await restarted.submit({ requestId: "request:compact-terminal", actorId: "actor:anonymous", contributionId: "contribution:compact-terminal", payloadDigest: "sha256:terminal" });
  assert.equal(compactedReplay.status, "denied");
  assert.equal(compactedReplay.idempotent, true);
  assert.match(compactedReplay.decision.receipt, /compacted=true/);

  const replayWithChangedPayload = await restarted.submit({ requestId: "request:compact-terminal", actorId: "actor:anonymous", contributionId: "contribution:other", payloadDigest: "sha256:other" });
  assert.equal(replayWithChangedPayload.status, "denied");
  assert.equal(replayWithChangedPayload.idempotent, false);
  assert.match(replayWithChangedPayload.decision.receipt, /replay=true/);
});

test("ledger compaction rejects stale exports and exposes a measured budget failure", async () => {
  const store = new MemoryStore();
  const coordinator = new PublicGatewayCoordinator(policy(), store, clock);
  await coordinator.open({ id: "principal:gateway-owner", role: "owner" }, "receipt:open");
  const first = await coordinator.submit({ requestId: "request:budget-1", actorId: "actor:anonymous", contributionId: "contribution:budget-1", payloadDigest: "sha256:budget-1" });
  assert.equal(first.status, "accepted");
  const exported = await coordinator.exportLedger({ actorId: "principal:gateway-owner", exportId: "ledger-export:stale-fixture", receipt: "receipt:ledger-export:stale-fixture" });
  const changed = await coordinator.submit({ requestId: "request:budget-2", actorId: "actor:anonymous", contributionId: "contribution:budget-2", payloadDigest: "sha256:budget-2" });
  assert.equal(changed.status, "accepted");
  await assert.rejects(
    () => coordinator.compactLedger({ actorId: "principal:gateway-owner", exportId: exported.exportId, policy: retentionPolicy(), receipt: "receipt:ledger-compact:stale" }),
    (error: unknown) => error instanceof Error && error.name === "PublicGatewayError" && error.message.includes("stale"),
  );

  const fresh = await coordinator.exportLedger({ actorId: "principal:gateway-owner", exportId: "ledger-export:budget-fixture", receipt: "receipt:ledger-export:budget-fixture" });
  await assert.rejects(
    () => coordinator.compactLedger({ actorId: "principal:gateway-owner", exportId: fresh.exportId, policy: retentionPolicy({ requestRecordLimit: 1 }), receipt: "receipt:ledger-compact:budget" }),
    (error: unknown) => error instanceof Error && error.name === "PublicGatewayError" && error.message.includes("budget=public-gateway-request-records") && error.message.includes("limit=1") && error.message.includes("asked=2") && error.message.includes("receipt:ledger-retention:request-records"),
  );
});

test("Worker provider payload parsing preserves abuse decisions instead of dropping them", () => {
  const parsed = parsePublicGatewayProviderOutcome({ status: "abuse", outcome: "challenge", retryable: true, receipt: "provider=cloudflare-turnstile; materialized=false" });
  assert.deepEqual(parsed, { status: "abuse", outcome: "challenge", retryable: true, receipt: "provider=cloudflare-turnstile; materialized=false" });
  assert.deepEqual(parsePublicGatewayProviderOutcome({ status: "abuse", outcome: "challenge", retryable: true, receipt: "" }), { status: "abuse", outcome: "denied", retryable: false, receipt: "provider=invalid; receipt=missing; failClosed=true" });
  assert.deepEqual(parsePublicGatewayProviderOutcome({ status: "abuse", outcome: "unexpected", retryable: true, receipt: "provider=bad" }), { status: "abuse", outcome: "denied", retryable: false, receipt: "provider=invalid; outcome=not-recognized; failClosed=true" });
  assert.deepEqual(parsePublicGatewayProviderOutcome("timeout"), { status: "timeout", receipt: "provider=fixture-driver; timeout=simulated; retryable=true" });
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
