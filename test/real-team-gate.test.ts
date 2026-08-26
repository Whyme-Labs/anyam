import assert from "node:assert/strict";
import test from "node:test";

import { validateRealTeamGate } from "../src/qualification/real-team-gate.ts";

function receipt() {
  return { status: "verified" as const, receipt: "fixture=validator-only; credentialMaterialStored=false", observedAt: "2026-01-15T00:00:00.000Z", owner: "human:1", nextAction: "retain the immutable receipt" };
}

function completeFixture(): Record<string, unknown> {
  const scenarios = { ordinaryGit: receipt(), concurrentWorkspaces: receipt(), intentLifecycle: receipt(), pullRequestLifecycle: receipt(), reviewAndLanding: receipt(), conflictAndRebase: receipt(), hybridProjection: receipt(), bidirectionalGitHub: receipt(), exportRestore: receipt(), noCanonicalWrite: receipt() };
  const operations = { sustainedLoad: receipt(), queueRecovery: receipt(), durableObjectContention: receipt(), backupRestoreRpoRto: receipt(), authenticationThrottling: receipt(), keyRotation: receipt(), incidentAlerting: receipt(), independentSecurityReview: receipt() };
  return { protocol: "anyam.real-team-adoption-gate/v1", cohort: { id: "cohort:unit", realmId: "realm:unit", hostingMode: "customer-operated", canonicalAuthority: "anyam", humanParticipantIds: ["human:1", "human:2", "human:3"], agentProducts: ["codex", "claude-code"], startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-02-01T00:00:00.000Z" }, changes: { terminalCount: 25, changeIds: Array.from({ length: 25 }, (_, index) => `change:${index}`) }, scenarios, provider: { workerReleaseTarget: { ...receipt(), provider: "cloudflare-workers" } }, operations, retentionDecision: { decision: "continue", recordedAt: "2026-02-01T00:00:00.000Z", owner: "human:1", receipt: "fixture=retention; credentialMaterialStored=false", nextAction: "continue" } };
}

test("real-team gate validator accepts only a complete receipt shape", () => {
  const result = validateRealTeamGate(completeFixture());
  assert.equal(result.status, "ready");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.summary.verifiedScenarioCount, 10);
  assert.equal(result.summary.verifiedOperationsCount, 8);
});

test("real-team gate remains blocked for missing human, provider, operations, and retention evidence", () => {
  const result = validateRealTeamGate({ protocol: "anyam.real-team-adoption-gate/v1" });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "cohort.humanParticipantIds"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "operations.sustainedLoad"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "retentionDecision"));
});

test("real-team gate rejects credential-like receipts and a short trial even when scenarios are present", () => {
  const evidence = completeFixture();
  const cohort = evidence.cohort as Record<string, unknown>;
  cohort.endedAt = "2026-01-10T00:00:00.000Z";
  const scenarios = evidence.scenarios as Record<string, Record<string, unknown>>;
  scenarios.ordinaryGit!.receipt = "providerToken=must-not-persist";
  const result = validateRealTeamGate(evidence);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "cohort.trialWindow"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "scenarios.ordinaryGit"));
});

test("real-team gate rejects duplicate identities and inconsistent terminal Change counts", () => {
  const evidence = completeFixture();
  const cohort = evidence.cohort as Record<string, unknown>;
  cohort.humanParticipantIds = ["human:1", "human:1", "human:2"];
  const changes = evidence.changes as Record<string, unknown>;
  changes.terminalCount = 25;
  changes.changeIds = Array.from({ length: 25 }, () => "change:duplicate");
  const result = validateRealTeamGate(evidence);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "cohort.humanParticipantIds.unique"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "changes.changeIds.unique"));
});

test("real-team gate rejects future, malformed, and out-of-window evidence timestamps", () => {
  const future = completeFixture();
  const futureCohort = future.cohort as Record<string, unknown>;
  futureCohort.endedAt = new Date(Date.now() + 86_400_000).toISOString();
  const futureResult = validateRealTeamGate(future);
  assert.ok(futureResult.blockers.some((blocker) => blocker.key === "cohort.endedAt.future"));

  const malformed = completeFixture();
  const malformedScenarios = malformed.scenarios as Record<string, Record<string, unknown>>;
  malformedScenarios.ordinaryGit!.observedAt = "not-a-timestamp";
  const malformedResult = validateRealTeamGate(malformed);
  assert.ok(malformedResult.blockers.some((blocker) => blocker.key === "scenarios.ordinaryGit.observedAt"));

  const outside = completeFixture();
  const outsideScenarios = outside.scenarios as Record<string, Record<string, unknown>>;
  outsideScenarios.ordinaryGit!.observedAt = "2026-03-01T00:00:00.000Z";
  const outsideResult = validateRealTeamGate(outside);
  assert.ok(outsideResult.blockers.some((blocker) => blocker.key === "scenarios.ordinaryGit.observedAt.window"));
});

test("real-team gate binds provider and receipt owners to the named cohort", () => {
  const evidence = completeFixture();
  const provider = evidence.provider as Record<string, Record<string, unknown>>;
  provider.workerReleaseTarget!.provider = "github-actions";
  provider.workerReleaseTarget!.owner = "unlisted:provider";
  const operations = evidence.operations as Record<string, Record<string, unknown>>;
  operations.sustainedLoad!.owner = "unlisted:operator";
  const result = validateRealTeamGate(evidence);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget.provider"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "provider.workerReleaseTarget.owner"));
  assert.ok(result.blockers.some((blocker) => blocker.key === "operations.sustainedLoad.owner"));
});
