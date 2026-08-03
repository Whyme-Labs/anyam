import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_VERSIONS,
  type DisclosurePolicyRef,
} from "../src/kernel/contracts.ts";
import {
  DEFAULT_QUALIFICATION_PLAN,
  DEFAULT_STAGE_GATES,
  QualificationRegistry,
  type QualificationContext,
  type QualificationStage,
} from "../src/qualification/stages.ts";

const disclosure: DisclosurePolicyRef = {
  projectionId: "project-view:p3-public-beta",
  classification: "project",
};

function context(stage: QualificationStage): QualificationContext {
  return {
    projectRevisionId: `project-revision:${stage}:receipt`,
    projectViewId: `project-view:${stage}:receipt`,
    sourceSpaceSnapshots: { public: `snapshot:${stage}:public` },
    policyVersion: `policy:${stage}:v1`,
    authorizationEpoch: `epoch:${stage}:v1`,
    toolchainDigest: `toolchain:${stage}:receipt`,
    dependencyDigest: `dependencies:${stage}:receipt`,
    environmentDigest: `environment:${stage}:receipt`,
    runnerId: `runner:${stage}:fixture`,
    capabilityGrantId: `grant:${stage}:fixture`,
    disclosure,
    actionId: `action:${stage}:fixture`,
    verifierId: `verifier:${stage}:fixture`,
    changeRevisionId: `change-revision:${stage}:fixture`,
    targetId: `target:${stage}:fixture`,
    inputDigests: [`input:${stage}:fixture`],
    effectDigests: [`effect:${stage}:fixture`],
  };
}

function measured(value: number, receipt: string) {
  return {
    value,
    unit: "fixture-run",
    source: "p3-stage-gate-fixture",
    method: "deterministic local qualification harness",
    measuredAt: "2026-08-03T00:00:00.000Z",
    receipt,
  };
}

function recordEvidence(registry: QualificationRegistry): void {
  for (const criterion of DEFAULT_QUALIFICATION_PLAN.criteria) {
    registry.recordEvidence({
      id: `evidence:${criterion.key}`,
      criterionKey: criterion.key,
      stage: criterion.stage,
      fixtureId: criterion.fixtureId,
      status: "passed",
      validityKey: `validity:${criterion.key}:v1`,
      context: context(criterion.stage),
      receipt: `evidence=${criterion.key}; source=p3-stage-gate-fixture; providerCoverage=bounded`,
      owner: "P3 qualification maintainer",
      nextAction: criterion.nextAction,
    });
  }
}

function recordOperations(registry: QualificationRegistry): void {
  for (const definition of DEFAULT_STAGE_GATES) {
    const stage = definition.id;
    for (const objectiveId of definition.reliabilityObjectiveIds) {
      registry.recordReliabilityObjective({
        id: objectiveId,
        stage,
        hostingMode: "fixture-and-customer-operated",
        name: `${stage} bounded control-plane completion`,
        sli: "qualified fixture journeys completed / attempted fixture journeys",
        target: measured(1, `reliability-target=${objectiveId}; source=p3-stage-gate-fixture`),
        errorBudget: measured(0, `reliability-error-budget=${objectiveId}; source=p3-stage-gate-fixture`),
        measurementReceipt: `measurement=${objectiveId}; source=p3-stage-gate-fixture; providerCoverage=bounded`,
        owner: "P3 qualification maintainer",
        receipt: `reliability=${objectiveId}; source=p3-stage-gate-fixture`,
      });
    }
    for (const usageId of definition.usageReceiptIds) {
      registry.recordUsageReceipt({
        id: usageId,
        recordedAt: "2026-08-03T00:00:00.000Z",
        usagePeriod: { start: "2026-08-03T00:00:00.000Z", end: "2026-08-03T00:01:00.000Z" },
        hostingMode: "fixture-and-customer-operated",
        realmId: `realm:${stage}`,
        projectId: `project:${stage}`,
        logicalUnit: "qualification-stage",
        providerResource: `fixture:${stage}`,
        quantity: measured(1, `usage=${usageId}; source=p3-stage-gate-fixture`),
        retryClass: "initial",
        idempotencyKey: `${usageId}:idempotency:v1`,
        disclosure,
        receipt: `usage=${usageId}; source=p3-stage-gate-fixture`,
      });
    }
    for (const costId of definition.providerCostReceiptIds) {
      const usageId = definition.usageReceiptIds[0];
      assert.ok(usageId, `provider cost ${costId} must have a usage receipt in the default plan`);
      registry.recordProviderCostReceipt({
        id: costId,
        provider: "customer-operated-cloudflare-or-fixture",
        usageReceiptIds: [usageId],
        providerQuantity: measured(1, `provider-quantity=${costId}; usage=${usageId}`),
        attributedQuantity: measured(1, `attributed-quantity=${costId}; usage=${usageId}`),
        feedStatus: "unavailable",
        receipt: `cost=${costId}; feedStatus=unavailable; source=p3-stage-gate-fixture`,
      });
    }
    for (const budgetId of definition.budgetDecisionIds) {
      const policyId = `${budgetId}:policy`;
      registry.recordBudgetPolicy({
        id: policyId,
        scope: { realmId: `realm:${stage}`, projectId: `project:${stage}` },
        dimension: "qualification-compute",
        configuredLimit: measured(10, `budget-limit=${policyId}; source=p3-stage-gate-fixture`),
        behavior: "warn",
        owner: "P3 qualification maintainer",
        receipt: `budget-policy=${policyId}; source=p3-stage-gate-fixture`,
      });
      registry.recordBudgetDecision({
        id: budgetId,
        policyId,
        state: "within_budget",
        requested: measured(1, `budget-requested=${budgetId}; source=p3-stage-gate-fixture`),
        consumed: measured(1, `budget-consumed=${budgetId}; source=p3-stage-gate-fixture`),
        limit: measured(10, `budget-decision-limit=${budgetId}; policy=${policyId}`),
        uncertainty: "fixture quantity is measured locally; provider feed is separately visible",
        nextAction: "reconcile provider usage and cost when the provider feed is current",
        receipt: `budget-decision=${budgetId}; source=p3-stage-gate-fixture`,
      });
    }
    for (const kind of definition.recoveryDrillKinds) {
      registry.recordRecoveryDrill({
        id: `drill:${stage}:${kind}:passed`,
        stage,
        kind,
        status: "passed",
        checkpointId: `checkpoint:${stage}:${kind}:passed`,
        validityKey: `recovery:${stage}:${kind}:v1`,
        context: context(stage),
        expectedInvariant: "the canonical Project state and recovery lineage remain reconciled",
        observedResult: `${kind} fixture completed with the expected checkpoint and idempotency receipt`,
        owner: "P3 operations maintainer",
        nextAction: `rerun ${kind} against the provider-specific adapter before broadening coverage`,
        observedAt: "2026-08-03T00:00:00.000Z",
        receipt: `recovery=${stage}:${kind}; source=p3-stage-gate-fixture; providerCoverage=bounded`,
      });
    }
    for (const riskId of definition.residualRiskIds) {
      registry.recordResidualRisk({
        id: riskId,
        stage,
        description: `${riskId} remains provider or tenancy dependent outside the bounded fixture receipt.`,
        owner: "P3 operations and Realm owners",
        mitigation: "retain provider boundaries, credential-free export, explicit disclosure, and a named follow-up receipt",
        qualificationGate: `${stage}:provider-or-tenant-follow-up`,
        decision: stage === "public-beta" ? "deferred" : "accepted",
        decisionReceipt: `risk=${riskId}; decision=${stage === "public-beta" ? "deferred" : "accepted"}; owner=P3-operations`,
        nextAction: "qualify the provider-specific or customer-account path before claiming broader coverage",
        receipt: `risk=${riskId}; source=p3-stage-gate-fixture; decision-explicit=true`,
      });
    }
  }
}

test("default P3 public-beta Stage Gate is executable, receipt-backed, and explicit about residual risk", () => {
  const registry = new QualificationRegistry({ now: () => "2026-08-03T00:02:00.000Z" });
  assert.equal(DEFAULT_QUALIFICATION_PLAN.protocol, CONTRACT_VERSIONS.qualificationPlan);
  assert.ok(DEFAULT_QUALIFICATION_PLAN.criteria.some((criterion) => criterion.key === "public-beta:agent-delegation"));
  assert.ok(DEFAULT_QUALIFICATION_PLAN.criteria.some((criterion) => criterion.key === "public-beta:customer-install-control"));
  recordEvidence(registry);
  recordOperations(registry);

  for (const stage of ["K0", "private-alpha", "public-beta"] as const) {
    registry.activateStage(stage);
    const decision = registry.completeStage(stage);
    assert.equal(decision.status, "ready");
  }

  const decision = registry.getDecision("public-beta");
  assert.ok(decision);
  assert.equal(decision.status, "ready");
  assert.equal(decision.blockers.length, 0);
  assert.equal(decision.evidenceIds.length, DEFAULT_STAGE_GATES.find((stage) => stage.id === "public-beta")!.criterionKeys.length);
  assert.equal(decision.advisories.filter((advisory) => advisory.kind === "provider-feed").length, 1);
  assert.equal(decision.advisories.filter((advisory) => advisory.kind === "residual-risk").length, 2);
  assert.match(decision.receipt, /stage=public-beta; status=ready; blockers=0; advisories=3/);
  console.log(`protocol=anyam.p3-stage-gate-qualification/v1; ${decision.receipt}; providerCoverage=bounded; universalSupport=false`);
});
