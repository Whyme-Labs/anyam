import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  createCommand,
  createDomainEvent,
  createProject,
  createProjectRevision,
  deriveProjectView,
  ProjectViewProjectionError,
} from "../src/kernel/contracts.ts";
import { EvidenceLedger, evaluateStageGate } from "../src/kernel/evidence.ts";
import { runK0Harness } from "../src/harness/k0.ts";
import { referenceFixtures, validateReferenceFixtures } from "../src/fixtures/reference.ts";

const fixtureRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));
const evidenceContext = {
  actionId: "action:test",
  verifierId: "verifier:test",
  toolchainDigest: "toolchain:test",
  dependencyDigest: "dependency:test",
  environmentDigest: "environment:test",
  inputDigests: ["input:test"],
  effectDigests: [],
  outputDigest: "output:test",
  producer: { kind: "run" as const, id: "run:test", version: "v1" },
  criterion: "K0 test criterion",
  projectRevisionId: "project-revision:test",
  projectViewId: "project-view:test",
  runId: "run:test",
  actor: {
    principalId: "principal:test",
    actorId: "actor:test",
    sessionId: "session:test",
    clientId: "client:test",
  },
  runnerId: "runner:test",
  policyVersion: "policy:test:v1",
  authorizationEpoch: "epoch:test:v1",
  capabilityGrantId: "grant:test",
  disclosure: { projectionId: "project:test", classification: "project" as const },
  receipt: "test receipt",
  invalidators: [],
  owner: "test owner",
};

test("reference fixtures are source-controlled and execute expected journeys", async () => {
  const result = await validateReferenceFixtures(fixtureRoot);

  assert.equal(result.ok, true);
  assert.deepEqual(
    referenceFixtures.map((fixture) => fixture.id),
    ["worker", "typescript-library", "hybrid-source"],
  );
  assert.ok(result.checkedFiles > 0);
  assert.equal(result.checkedJourneys, 13);
  assert.equal(result.missingFiles.length, 0);
  assert.equal(result.missingJourneys.length, 0);
  assert.deepEqual(result.failedJourneys, []);
});

test("public Project View omits the private codec Source Space", () => {
  const fixture = referenceFixtures.find((candidate) => candidate.id === "hybrid-source");
  assert.ok(fixture);

  const project = createProject(fixture.project);
  const revision = createProjectRevision({
    projectId: project.id,
    sourceSpaceSnapshots: Object.fromEntries(
      fixture.sourceSpaces.map((space) => [space.id, `snapshot:${space.id}`]),
    ),
  });
  const view = deriveProjectView({
    project,
    revision,
    sourceSpaces: fixture.sourceSpaces,
    allowedSourceSpaceIds: ["public-player"],
    projectionId: "public-video-player",
  });

  assert.deepEqual(view.visibleSourceSpaceIds, ["public-player"]);
  assert.equal(JSON.stringify(view).includes("private-codec"), false);
});

test("Project View projection fails closed for malformed requests", () => {
  const fixture = referenceFixtures.find((candidate) => candidate.id === "hybrid-source");
  assert.ok(fixture);
  const project = createProject(fixture.project);
  const revision = createProjectRevision({
    projectId: project.id,
    sourceSpaceSnapshots: Object.fromEntries(fixture.sourceSpaces.map((space) => [space.id, "snapshot"])),
  });

  assert.throws(
    () => deriveProjectView({
      project,
      revision,
      sourceSpaces: fixture.sourceSpaces,
      allowedSourceSpaceIds: ["public-player", "public-player"],
      projectionId: "duplicate",
    }),
    (error: unknown) => error instanceof ProjectViewProjectionError && error.code === "duplicate-source-space",
  );
  assert.throws(
    () => deriveProjectView({
      project,
      revision,
      sourceSpaces: fixture.sourceSpaces,
      allowedSourceSpaceIds: ["missing"],
      projectionId: "unknown",
    }),
    (error: unknown) => error instanceof ProjectViewProjectionError && error.code === "unknown-source-space",
  );
  assert.throws(
    () => deriveProjectView({
      project,
      revision,
      sourceSpaces: fixture.sourceSpaces,
      allowedSourceSpaceIds: ["private-codec"],
      projectionId: "public-private",
      classification: "public",
    }),
    (error: unknown) => error instanceof ProjectViewProjectionError && error.code === "disclosure-classification-mismatch",
  );
  assert.throws(
    () => deriveProjectView({
      project,
      revision,
      sourceSpaces: [fixture.sourceSpaces[0]!, fixture.sourceSpaces[0]!],
      allowedSourceSpaceIds: ["public-player"],
      projectionId: "duplicate-catalog",
    }),
    (error: unknown) => error instanceof ProjectViewProjectionError && error.code === "duplicate-source-space-catalog",
  );
});

test("stage gate reports missing, failed, stale, and indeterminate Evidence", () => {
  const ledger = new EvidenceLedger();
  ledger.append({ ...evidenceContext, key: "k0:local-loop", outcome: "passed", validityKey: "v1" });
  ledger.append({ ...evidenceContext, key: "k0:git-roundtrip", outcome: "failed", validityKey: "v1" });
  ledger.append({ ...evidenceContext, key: "k0:agent-loop", outcome: "stale", validityKey: "v0" });
  ledger.append({ ...evidenceContext, key: "k0:export", outcome: "indeterminate", validityKey: "v1" });

  const decision = evaluateStageGate({
    gateId: "k0",
    requiredEvidence: [
      { key: "k0:local-loop", currentValidityKey: "v1" },
      { key: "k0:git-roundtrip", currentValidityKey: "v1" },
      { key: "k0:agent-loop", currentValidityKey: "v1" },
      { key: "k0:export", currentValidityKey: "v1" },
      { key: "k0:restore", currentValidityKey: "v1" },
    ],
    evidence: ledger.list(),
  });

  assert.equal(decision.status, "blocked");
  assert.deepEqual(
    decision.blockers.map((blocker) => blocker.kind),
    ["failed", "stale", "indeterminate", "missing"],
  );
  assert.ok(decision.blockers.every((blocker) => blocker.stageGate === "k0"));
});

test("Evidence records retain normalized provenance and residual risks block a gate", () => {
  const ledger = new EvidenceLedger();
  const record = ledger.append({
    ...evidenceContext,
    key: "k0:normalized",
    outcome: "passed",
    validityKey: "v1",
    projectRevisionId: "project-revision:test",
    projectViewId: "project-view:test",
    receipt: "runner=local; output=sha256:test",
    owner: "kernel maintainer",
  });
  assert.equal(record.protocol, "anyam.evidence/v1");
  assert.equal(record.criterion, "K0 test criterion");
  assert.equal(record.projectRevisionId, "project-revision:test");
  assert.equal(record.verifierId, "verifier:test");
  assert.equal(record.producer.id, "run:test");
  assert.equal(record.receipt, "runner=local; output=sha256:test");
  const listed = ledger.list();
  (listed[0]!.invalidators as string[]).push("mutated-outside-ledger");
  record.producer.id = "mutated-return-value";
  assert.deepEqual(ledger.list()[0]!.invalidators, []);
  assert.equal(ledger.list()[0]!.producer.id, "run:test");

  const decision = evaluateStageGate({
    gateId: "k0",
    requiredEvidence: [{ key: "k0:normalized", currentValidityKey: "v1" }],
    evidence: ledger.list(),
    residualRisks: [{
      id: "risk:open",
      description: "Unqualified runner",
      owner: "platform lead",
      mitigation: "Qualify before alpha",
      status: "open",
    }],
  });
  assert.equal(decision.status, "blocked");
  assert.equal(decision.blockers.at(-1)?.kind, "risk");

  const staleContextDecision = evaluateStageGate({
    gateId: "k0",
    requiredEvidence: [{
      key: "k0:normalized",
      currentValidityKey: "v1",
      expectedProjectRevisionId: "project-revision:changed",
    }],
    evidence: ledger.list(),
  });
  assert.equal(staleContextDecision.blockers[0]?.kind, "stale");
});

test("the K0 harness exercises adapter seams without exposing provider authority", async () => {
  const report = await runK0Harness({ fixtureRoot });

  assert.equal(report.contractVersion, CONTRACT_VERSIONS.kernel);
  assert.equal(report.fixtures.ok, true);
  assert.equal(report.evidence.length, 7);
  assert.ok(report.evidence.every((record) => record.protocol === "anyam.evidence/v1" && record.receipt.length > 0));
  assert.deepEqual(report.adapterSeams, {
    repositoryDriver: "passed",
    runner: "passed",
    targetAdapter: "passed",
    identity: "passed",
    export: "passed",
  });
  assert.equal(report.riskSpikes.length, 2);
  assert.ok(report.riskSpikes.every((risk) => risk.receipt.length > 0 && risk.owner.length > 0));
  assert.equal(report.residualRisks.length, 1);
  const residualRisk = report.residualRisks[0];
  assert.ok(residualRisk);
  assert.ok(residualRisk.owner.length > 0);
  assert.equal(JSON.stringify(report.projectExport).includes("token"), false);
});

test("command and event envelopes carry the versioned kernel contract", () => {
  const command = createCommand({
    operationId: "change.create",
    resource: { realmId: "realm:test", projectId: "project:test" },
    actor: {
      principalId: "principal:test",
      actorId: "actor:test",
      sessionId: "session:test",
      clientId: "client:test",
    },
    idempotencyKey: "idem:test",
    expected: { aggregateId: "project:test", version: 3 },
    payload: { title: "Add fixture" },
  });
  const event = createDomainEvent({
    eventType: "change.created",
    aggregate: "Change",
    aggregateId: "change:test",
    aggregateVersion: 1,
    disclosure: { projectionId: "project:test", classification: "project" },
    payload: { changeId: "change:test" },
  });

  assert.equal(command.protocol, CONTRACT_VERSIONS.command);
  assert.equal(event.protocol, CONTRACT_VERSIONS.event);
  assert.equal(command.operationId, "change.create");
  assert.deepEqual(command.expected, { aggregateId: "project:test", version: 3 });
  assert.equal(event.aggregateVersion, 1);
});
