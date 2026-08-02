import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  type DisclosurePolicyRef,
} from "../src/kernel/contracts.ts";
import {
  DEFAULT_QUALIFICATION_PLAN,
  DEFAULT_STAGE_GATES,
  QualificationError,
  QualificationRegistry,
  type QualificationContext,
  type QualificationPlan,
  type RecoveryDrillKind,
} from "../src/qualification/stages.ts";

const disclosure: DisclosurePolicyRef = {
  projectionId: "project-view:test",
  classification: "project",
};

function context(projectRevisionId = "project-revision:test"): QualificationContext {
  return {
    projectRevisionId,
    projectViewId: "project-view:test",
    sourceSpaceSnapshots: { public: "snapshot:public" },
    policyVersion: "policy:test:v1",
    authorizationEpoch: "epoch:test:v1",
    toolchainDigest: "toolchain:test",
    dependencyDigest: "dependencies:test",
    environmentDigest: "environment:test",
    runnerId: "runner:test",
    capabilityGrantId: "grant:test",
    disclosure,
    actionId: "action:test",
    verifierId: "verifier:test",
    changeRevisionId: "change-revision:test",
    targetId: "target:test",
    inputDigests: ["input:test"],
    effectDigests: ["effect:test"],
  };
}

function measured(value: number | string, receipt: string): {
  value: number | string;
  unit: string;
  source: string;
  method: string;
  measuredAt: string;
  receipt: string;
} {
  return {
    value,
    unit: "unit",
    source: "fixture:test",
    method: "controlled fixture measurement",
    measuredAt: "2026-08-03T00:00:00.000Z",
    receipt,
  };
}

function oneCriterionPlan(input: {
  recoveryDrillKinds?: readonly RecoveryDrillKind[];
  includeOperations?: boolean;
  includeRisk?: boolean;
} = {}): QualificationPlan {
  return {
    protocol: CONTRACT_VERSIONS.qualificationPlan,
    criteria: [{
      protocol: CONTRACT_VERSIONS.acceptanceCriterion,
      key: "k0:test",
      stage: "K0",
      fixtureId: "worker",
      label: "Qualification test criterion",
      dimension: "test",
      expectedValidityKey: "validity:test:v1",
      expectedContext: { projectRevisionId: "project-revision:test" },
      nextAction: "rerun the qualification fixture and attach the new Evidence receipt",
    }],
    stages: [{
      protocol: CONTRACT_VERSIONS.stageGate,
      id: "K0",
      title: "Qualification test stage",
      dependsOn: [],
      criterionKeys: ["k0:test"],
      reliabilityObjectiveIds: input.includeOperations === false ? [] : ["reliability:test"],
      usageReceiptIds: input.includeOperations === false ? [] : ["usage:test"],
      providerCostReceiptIds: input.includeOperations === false ? [] : ["cost:test"],
      budgetDecisionIds: input.includeOperations === false ? [] : ["budget:test"],
      recoveryDrillKinds: input.recoveryDrillKinds ?? [],
      residualRiskIds: input.includeRisk === false ? [] : ["risk:test"],
    }],
  };
}

function recordEvidence(
  registry: QualificationRegistry,
  input: { id: string; status?: "passed" | "failed" | "stale" | "indeterminate"; validityKey?: string; observedAt?: string; projectRevisionId?: string },
): void {
  registry.recordEvidence({
    id: input.id,
    criterionKey: "k0:test",
    stage: "K0",
    fixtureId: "worker",
    status: input.status ?? "passed",
    validityKey: input.validityKey ?? "validity:test:v1",
    context: context(input.projectRevisionId),
    receipt: `evidence=${input.id}; source=fixture:test`,
    owner: "qualification maintainer",
    nextAction: "rerun the qualification fixture and attach the new Evidence receipt",
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
  });
}

function recordOperations(registry: QualificationRegistry): void {
  registry.recordReliabilityObjective({
    id: "reliability:test",
    stage: "K0",
    hostingMode: "local",
    name: "fixture completion",
    sli: "completed fixture runs / attempted fixture runs",
    target: measured(0.99, "receipt=reliability-target; run-count=100"),
    errorBudget: measured(0.01, "receipt=reliability-error-budget; run-count=100"),
    measurementReceipt: "receipt=reliability-measurement; source=fixture:test",
    owner: "qualification maintainer",
    receipt: "receipt=reliability-objective; source=fixture:test",
  });
  registry.recordUsageReceipt({
    id: "usage:test",
    recordedAt: "2026-08-03T00:00:00.000Z",
    usagePeriod: { start: "2026-08-03T00:00:00.000Z", end: "2026-08-03T00:01:00.000Z" },
    hostingMode: "local",
    realmId: "realm:test",
    projectId: "project:test",
    logicalUnit: "qualification-run",
    providerResource: "fixture:test",
    quantity: measured(1, "receipt=usage-quantity; run-id=run:test"),
    retryClass: "initial",
    idempotencyKey: "usage:test:idempotency",
    disclosure,
    receipt: "receipt=usage; source=fixture:test",
  });
  registry.recordProviderCostReceipt({
    id: "cost:test",
    provider: "fixture-provider",
    usageReceiptIds: ["usage:test"],
    providerQuantity: measured(1, "receipt=provider-quantity; provider=fixture-provider"),
    attributedQuantity: measured(1, "receipt=attributed-quantity; usage=usage:test"),
    feedStatus: "unavailable",
    receipt: "receipt=provider-cost; feed-status=unavailable; source=fixture:test",
  });
  registry.recordBudgetPolicy({
    id: "budget:test",
    scope: { realmId: "realm:test", projectId: "project:test" },
    dimension: "qualification-compute",
    configuredLimit: measured(10, "receipt=budget-limit; source=fixture:test"),
    behavior: "warn",
    owner: "qualification maintainer",
    receipt: "receipt=budget-policy; source=fixture:test",
  });
  registry.recordBudgetDecision({
    id: "budget:test",
    policyId: "budget:test",
    state: "within_budget",
    requested: measured(1, "receipt=budget-requested; run-id=run:test"),
    consumed: measured(1, "receipt=budget-consumed; run-id=run:test"),
    limit: measured(10, "receipt=budget-decision-limit; policy=budget:test"),
    uncertainty: "provider feed is unavailable; fixture quantity is measured locally",
    nextAction: "reconcile the provider feed when it becomes available",
    receipt: "receipt=budget-decision; source=fixture:test",
  });
}

function recordDrill(registry: QualificationRegistry, input: { id: string; kind: RecoveryDrillKind; status?: "passed" | "failed" | "stale" | "indeterminate" }): void {
  registry.recordRecoveryDrill({
    id: input.id,
    stage: "K0",
    kind: input.kind,
    status: input.status ?? "passed",
    checkpointId: `checkpoint:${input.kind}`,
    validityKey: "recovery:test:v1",
    context: context(),
    expectedInvariant: "the authoritative Project state and recovery refs remain reconciled",
    observedResult: `observed ${input.kind} recovery fixture`,
    owner: "operations maintainer",
    nextAction: `rerun the ${input.kind} recovery drill and attach its checkpoint receipt`,
    receipt: `receipt=recovery; kind=${input.kind}; source=fixture:test`,
    observedAt: input.id.includes("zz") ? "2026-08-03T00:01:00.000Z" : "2026-08-03T00:00:00.000Z",
  });
}

function recordRisk(registry: QualificationRegistry, decision: "accepted" | "deferred" | "open"): void {
  registry.recordResidualRisk({
    id: "risk:test",
    stage: "K0",
    description: "The fixture provider may be unavailable during a local qualification run.",
    owner: "operations maintainer",
    mitigation: "Keep provider access behind the RepositoryDriver and retain a portable restore path.",
    qualificationGate: "public-beta:repository-fallback",
    decision,
    decisionReceipt: `receipt=risk-decision; decision=${decision}; owner=operations-maintainer`,
    nextAction: "qualify the fallback RepositoryDriver before public beta",
    receipt: "receipt=residual-risk; source=fixture:test",
  });
}

test("the default plan indexes all stages and the complete recovery matrix", () => {
  assert.equal(DEFAULT_QUALIFICATION_PLAN.protocol, CONTRACT_VERSIONS.qualificationPlan);
  assert.deepEqual(
    DEFAULT_STAGE_GATES.map((stage) => stage.id),
    ["K0", "private-alpha", "public-beta", "expansion"],
  );
  const recoveryKinds = new Set(DEFAULT_STAGE_GATES.flatMap((stage) => stage.recoveryDrillKinds));
  assert.deepEqual([...recoveryKinds].sort(), [
    "credential-compromise",
    "import",
    "mirror-divergence",
    "partial-landing",
    "partial-promotion",
    "provider-outage",
    "restore",
  ]);
  assert.ok(DEFAULT_QUALIFICATION_PLAN.criteria.every((criterion) => criterion.nextAction.length > 0));
});

test("a Stage Gate names every missing operational receipt and next action", () => {
  const registry = new QualificationRegistry({ plan: oneCriterionPlan() });
  const decision = registry.evaluate("K0");

  assert.equal(decision.status, "blocked");
  assert.deepEqual(
    new Set(decision.blockers.map((blocker) => blocker.kind)),
    new Set(["criterion", "reliability", "usage-receipt", "provider-cost-receipt", "budget", "residual-risk"]),
  );
  assert.ok(decision.blockers.every((blocker) => blocker.nextAction.length > 0));
  assert.ok(decision.blockers.some((blocker) => blocker.message.includes("missing")));
});

test("passed Evidence is stale when its validity context changes, then becomes ready with fresh receipts", () => {
  const registry = new QualificationRegistry({ plan: oneCriterionPlan() });
  recordEvidence(registry, { id: "evidence:stale", validityKey: "validity:test:old", observedAt: "2026-08-03T00:00:00.000Z" });
  recordOperations(registry);
  recordRisk(registry, "accepted");

  const stale = registry.evaluate("K0");
  assert.equal(stale.status, "blocked");
  assert.equal(stale.blockers[0]?.kind, "criterion");
  assert.match(stale.blockers[0]?.message ?? "", /stale/);
  assert.ok(stale.blockers[0]?.nextAction.includes("rerun"));

  recordEvidence(registry, { id: "evidence:fresh", observedAt: "2026-08-03T00:00:01.000Z" });
  const ready = registry.evaluate("K0");
  assert.equal(ready.status, "ready");
  assert.equal(ready.blockers.length, 0);
  assert.equal(ready.advisories[0]?.kind, "provider-feed");
});

test("failed and indeterminate Evidence block with an actionable next step", () => {
  for (const status of ["failed", "indeterminate"] as const) {
    const registry = new QualificationRegistry({ plan: oneCriterionPlan({ includeOperations: false, includeRisk: false }) });
    recordEvidence(registry, { id: `evidence:${status}`, status });
    const decision = registry.evaluate("K0");
    assert.equal(decision.status, "blocked");
    assert.equal(decision.blockers[0]?.kind, "criterion");
    assert.match(decision.blockers[0]?.message ?? "", new RegExp(status));
    assert.ok(decision.blockers[0]?.nextAction.length);
  }
});

test("measured limits reject missing receipts and name the budget field", () => {
  const registry = new QualificationRegistry({ plan: oneCriterionPlan({ includeOperations: false, includeRisk: false }) });
  assert.throws(
    () => registry.recordBudgetPolicy({
      id: "budget:unreceipted",
      scope: { realmId: "realm:test" },
      dimension: "compute",
      configuredLimit: measured(10, ""),
      behavior: "block",
      owner: "operations maintainer",
      receipt: "receipt=policy-without-measurement",
    }),
    (error: unknown) => error instanceof QualificationError
      && error.code === "unreceipted-limit"
      && error.message.includes("configuredLimit")
      && error.recoveryAction.includes("measurement source"),
  );
});

test("the recovery matrix blocks failed drills and accepts explicit deferred risk", () => {
  const recoveryKinds: readonly RecoveryDrillKind[] = [
    "import",
    "provider-outage",
    "partial-landing",
    "partial-promotion",
    "mirror-divergence",
    "credential-compromise",
    "restore",
  ];
  const registry = new QualificationRegistry({ plan: oneCriterionPlan({ recoveryDrillKinds: recoveryKinds, includeOperations: false }) });
  recordEvidence(registry, { id: "evidence:recovery" });
  for (const [index, kind] of recoveryKinds.entries()) recordDrill(registry, { id: `drill:${index}:${kind}`, kind });
  recordRisk(registry, "deferred");

  const ready = registry.evaluate("K0");
  assert.equal(ready.status, "ready");
  assert.equal(ready.advisories.some((advisory) => advisory.kind === "residual-risk"), true);

  recordDrill(registry, { id: "drill:zz:restore-failed", kind: "restore", status: "failed" });
  const blocked = registry.evaluate("K0");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockers.some((blocker) => blocker.kind === "recovery"), true);
  assert.ok(blocked.blockers.find((blocker) => blocker.kind === "recovery")?.nextAction.includes("restore"));
});

test("Stage activation follows dependencies and completion records a ready decision", () => {
  const plan: QualificationPlan = {
    protocol: CONTRACT_VERSIONS.qualificationPlan,
    criteria: [
      { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "k0:test", stage: "K0", fixtureId: "worker", label: "K0", dimension: "test", nextAction: "rerun K0" },
      { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "alpha:test", stage: "private-alpha", fixtureId: "worker", label: "alpha", dimension: "test", nextAction: "rerun alpha" },
    ],
    stages: [
      { protocol: CONTRACT_VERSIONS.stageGate, id: "K0", title: "K0", dependsOn: [], criterionKeys: ["k0:test"], reliabilityObjectiveIds: [], usageReceiptIds: [], providerCostReceiptIds: [], budgetDecisionIds: [], recoveryDrillKinds: [], residualRiskIds: [] },
      { protocol: CONTRACT_VERSIONS.stageGate, id: "private-alpha", title: "alpha", dependsOn: ["K0"], criterionKeys: ["alpha:test"], reliabilityObjectiveIds: [], usageReceiptIds: [], providerCostReceiptIds: [], budgetDecisionIds: [], recoveryDrillKinds: [], residualRiskIds: [] },
    ],
  };
  const registry = new QualificationRegistry({ plan });
  assert.throws(() => registry.activateStage("private-alpha"), (error: unknown) => error instanceof QualificationError && error.code === "stage-state");
  registry.activateStage("K0");
  recordEvidence(registry, { id: "evidence:k0" });
  assert.equal(registry.completeStage("K0").status, "ready");
  assert.equal(registry.getStageState("K0"), "complete");
  registry.activateStage("private-alpha");
  registry.recordEvidence({
    id: "evidence:alpha",
    criterionKey: "alpha:test",
    stage: "private-alpha",
    fixtureId: "worker",
    status: "passed",
    validityKey: "alpha:v1",
    context: context(),
    receipt: "receipt=alpha; source=fixture:test",
    owner: "qualification maintainer",
    nextAction: "rerun alpha",
  });
  assert.equal(registry.completeStage("private-alpha").status, "ready");
});
