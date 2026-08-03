import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type DisclosurePolicyRef,
} from "../kernel/contracts.ts";

export type QualificationStage = "K0" | "private-alpha" | "public-beta" | "expansion";
export const QUALIFICATION_STAGE_ORDER: readonly QualificationStage[] = ["K0", "private-alpha", "public-beta", "expansion"];

export type QualificationEvidenceStatus = "passed" | "failed" | "stale" | "indeterminate";
export type StageLifecycle = "pending" | "active" | "complete";
export type RecoveryDrillKind =
  | "import"
  | "provider-outage"
  | "partial-landing"
  | "partial-promotion"
  | "mirror-divergence"
  | "credential-compromise"
  | "restore";
export type ResidualRiskDecision = "open" | "accepted" | "deferred";
export type BudgetDecisionState = "within_budget" | "near_budget" | "approval_required" | "degraded" | "exhausted";
export type ProviderFeedStatus = "current" | "delayed" | "unavailable" | "reconciled";

export type MeasuredQuantity = {
  value: number | string;
  unit: string;
  source: string;
  method: string;
  measuredAt: string;
  receipt: string;
};

export type QualificationContext = {
  projectRevisionId: string;
  projectViewId: string;
  sourceSpaceSnapshots: Readonly<Record<string, string>>;
  policyVersion: string;
  authorizationEpoch: string;
  toolchainDigest: string;
  dependencyDigest: string;
  environmentDigest: string;
  runnerId: string;
  capabilityGrantId: string;
  disclosure: DisclosurePolicyRef;
  actionId?: string;
  verifierId?: string;
  changeRevisionId?: string;
  targetId?: string;
  inputDigests?: readonly string[];
  effectDigests?: readonly string[];
};

export type QualificationCriterion = {
  protocol: typeof CONTRACT_VERSIONS.acceptanceCriterion;
  key: string;
  stage: QualificationStage;
  fixtureId: string;
  label: string;
  dimension: string;
  nextAction: string;
  expectedValidityKey?: string;
  expectedContext?: Partial<QualificationContext>;
};

export type QualificationEvidence = {
  protocol: typeof CONTRACT_VERSIONS.qualificationEvidence;
  id: string;
  criterionKey: string;
  stage: QualificationStage;
  fixtureId: string;
  status: QualificationEvidenceStatus;
  validityKey: string;
  context: QualificationContext;
  receipt: string;
  owner: string;
  nextAction: string;
  observedAt: string;
};

export type ReliabilityObjective = {
  protocol: typeof CONTRACT_VERSIONS.reliabilityObjective;
  id: string;
  stage: QualificationStage;
  hostingMode: string;
  name: string;
  sli: string;
  target: MeasuredQuantity;
  errorBudget: MeasuredQuantity;
  measurementReceipt: string;
  owner: string;
  receipt: string;
};

export type UsageReceipt = {
  protocol: typeof CONTRACT_VERSIONS.usageReceipt;
  id: string;
  recordedAt: string;
  usagePeriod: { start: string; end: string };
  hostingMode: string;
  realmId: string;
  projectId: string;
  sourceSpaceId?: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  attemptId?: string;
  logicalUnit: string;
  providerResource: string;
  providerSku?: string;
  quantity: MeasuredQuantity;
  estimatedCost?: MeasuredQuantity;
  currency?: string;
  priceVersion?: string;
  retryClass: "initial" | "retry" | "duplicate" | "redelivery";
  idempotencyKey: string;
  disclosure: DisclosurePolicyRef;
  receipt: string;
};

export type ProviderCostReceipt = {
  protocol: typeof CONTRACT_VERSIONS.providerCostReceipt;
  id: string;
  provider: string;
  usageReceiptIds: readonly string[];
  providerQuantity: MeasuredQuantity;
  attributedQuantity: MeasuredQuantity;
  billedQuantity?: MeasuredQuantity;
  estimatedCost?: MeasuredQuantity;
  billedCost?: MeasuredQuantity;
  currency?: string;
  variance?: MeasuredQuantity;
  feedStatus: ProviderFeedStatus;
  correctedBy?: string;
  receipt: string;
};

export type BudgetPolicy = {
  protocol: typeof CONTRACT_VERSIONS.budgetPolicy;
  id: string;
  scope: { realmId: string; organizationId?: string; projectId?: string; sourceSpaceId?: string; targetId?: string; taskId?: string; runId?: string };
  dimension: string;
  configuredLimit?: MeasuredQuantity;
  providerLimit?: MeasuredQuantity;
  reset?: string;
  behavior: "warn" | "approval" | "degrade" | "block";
  owner: string;
  receipt: string;
};

export type BudgetDecision = {
  protocol: typeof CONTRACT_VERSIONS.budgetDecision;
  id: string;
  policyId: string;
  state: BudgetDecisionState;
  requested: MeasuredQuantity;
  consumed: MeasuredQuantity;
  limit?: MeasuredQuantity;
  resetOrExpiry?: string;
  uncertainty: string;
  nextAction: string;
  receipt: string;
};

export type RecoveryDrill = {
  protocol: typeof CONTRACT_VERSIONS.recoveryDrill;
  id: string;
  stage: QualificationStage;
  kind: RecoveryDrillKind;
  status: QualificationEvidenceStatus;
  checkpointId: string;
  validityKey: string;
  context: QualificationContext;
  expectedInvariant: string;
  observedResult: string;
  owner: string;
  nextAction: string;
  receipt: string;
  observedAt: string;
};

export type QualifiedResidualRisk = {
  protocol: typeof CONTRACT_VERSIONS.residualRisk;
  id: string;
  stage: QualificationStage;
  description: string;
  owner: string;
  mitigation: string;
  qualificationGate: string;
  decision: ResidualRiskDecision;
  decisionReceipt: string;
  nextAction: string;
  receipt: string;
};

export type StageGateDefinition = {
  protocol: typeof CONTRACT_VERSIONS.stageGate;
  id: QualificationStage;
  title: string;
  dependsOn: readonly QualificationStage[];
  criterionKeys: readonly string[];
  reliabilityObjectiveIds: readonly string[];
  usageReceiptIds: readonly string[];
  providerCostReceiptIds: readonly string[];
  budgetDecisionIds: readonly string[];
  recoveryDrillKinds: readonly RecoveryDrillKind[];
  residualRiskIds: readonly string[];
};

export type QualificationBlockerKind =
  | "dependency"
  | "criterion"
  | "reliability"
  | "usage-receipt"
  | "provider-cost-receipt"
  | "budget"
  | "recovery"
  | "residual-risk";

export type QualificationBlocker = {
  kind: QualificationBlockerKind;
  key: string;
  message: string;
  nextAction: string;
};

export type QualificationAdvisory = {
  kind: "provider-feed" | "residual-risk";
  key: string;
  message: string;
  nextAction: string;
};

export type QualificationGateDecision = {
  protocol: typeof CONTRACT_VERSIONS.stageGateDecision;
  id: string;
  stage: QualificationStage;
  status: "ready" | "blocked";
  blockers: readonly QualificationBlocker[];
  advisories: readonly QualificationAdvisory[];
  evidenceIds: readonly string[];
  receipt: string;
};

export type QualificationPlan = {
  protocol: typeof CONTRACT_VERSIONS.qualificationPlan;
  criteria: readonly QualificationCriterion[];
  stages: readonly StageGateDefinition[];
};

export type QualificationRegistryInput = {
  plan?: QualificationPlan;
  now?: () => string;
};

export type QualificationErrorCode =
  | "invalid-input"
  | "duplicate"
  | "not-found"
  | "stage-state"
  | "gate-blocked"
  | "unreceipted-limit"
  | "invalid-receipt";

export class QualificationError extends Error {
  readonly code: QualificationErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: QualificationErrorCode; message: string; affectedObject: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "QualificationError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

type JsonRecord = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function fail(input: ConstructorParameters<typeof QualificationError>[0]): never {
  throw new QualificationError(input);
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    fail({ code: "invalid-input", message: `${field} must not be empty.`, affectedObject: field, recoveryAction: `provide a non-empty ${field} and retry`, receipt: `field=${field}; present=false` });
  }
}

function list(values: readonly string[], field: string): readonly string[] {
  if (values.some((value) => value.trim().length === 0)) {
    fail({ code: "invalid-input", message: `${field} contains an empty value.`, affectedObject: field, recoveryAction: `remove empty ${field} entries and retry`, receipt: `field=${field}; count=${values.length}` });
  }
  if (new Set(values).size !== values.length) {
    fail({ code: "duplicate", message: `${field} contains duplicate values.`, affectedObject: field, recoveryAction: `deduplicate ${field} and retry`, receipt: `field=${field}; count=${values.length}; unique=${new Set(values).size}` });
  }
  return [...values];
}

function receipt(value: string, field: string): void {
  nonEmpty(value, field);
}

function measured(value: MeasuredQuantity, field: string): MeasuredQuantity {
  if (typeof value.value === "number" && !Number.isFinite(value.value)) {
    fail({ code: "invalid-input", message: `${field}.value must be finite when numeric.`, affectedObject: field, recoveryAction: `record a finite measured value or an explicit provider-unknown value`, receipt: `field=${field}; value=${String(value.value)}` });
  }
  nonEmpty(value.unit, `${field}.unit`);
  nonEmpty(value.source, `${field}.source`);
  nonEmpty(value.method, `${field}.method`);
  nonEmpty(value.measuredAt, `${field}.measuredAt`);
  if (value.receipt.trim().length === 0) {
    fail({
      code: "unreceipted-limit",
      message: `${field} has a measured value without a receipt.`,
      affectedObject: field,
      recoveryAction: `record the measurement source and method for ${field}, then attach its receipt`,
      receipt: `field=${field}; measuredAt=${value.measuredAt}; receiptPresent=false`,
    });
  }
  return clone(value);
}

function context(value: QualificationContext, field = "context"): QualificationContext {
  nonEmpty(value.projectRevisionId, `${field}.projectRevisionId`);
  nonEmpty(value.projectViewId, `${field}.projectViewId`);
  nonEmpty(value.policyVersion, `${field}.policyVersion`);
  nonEmpty(value.authorizationEpoch, `${field}.authorizationEpoch`);
  nonEmpty(value.toolchainDigest, `${field}.toolchainDigest`);
  nonEmpty(value.dependencyDigest, `${field}.dependencyDigest`);
  nonEmpty(value.environmentDigest, `${field}.environmentDigest`);
  nonEmpty(value.runnerId, `${field}.runnerId`);
  nonEmpty(value.capabilityGrantId, `${field}.capabilityGrantId`);
  nonEmpty(value.disclosure.projectionId, `${field}.disclosure.projectionId`);
  const snapshots = Object.fromEntries(Object.entries(value.sourceSpaceSnapshots).map(([key, snapshot]) => {
    nonEmpty(key, `${field}.sourceSpaceSnapshots.key`);
    nonEmpty(snapshot, `${field}.sourceSpaceSnapshots.${key}`);
    return [key, snapshot];
  }));
  if (Object.keys(snapshots).length === 0) {
    fail({ code: "invalid-input", message: `${field}.sourceSpaceSnapshots must contain at least one Source Space snapshot.`, affectedObject: `${field}.sourceSpaceSnapshots`, recoveryAction: "bind the record to the exact Source Space snapshot set used by the Run", receipt: `${field}.sourceSpaceSnapshots.count=0` });
  }
  return {
    ...clone(value),
    sourceSpaceSnapshots: snapshots,
    disclosure: { ...value.disclosure },
    ...(value.inputDigests ? { inputDigests: list(value.inputDigests, `${field}.inputDigests`) } : {}),
    ...(value.effectDigests ? { effectDigests: list(value.effectDigests, `${field}.effectDigests`) } : {}),
  };
}

function contextDigest(value: QualificationContext): string {
  return digest(context(value));
}

function matchesPartialContext(actual: QualificationContext, expected: Partial<QualificationContext>): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key as keyof QualificationContext];
    if (stableJson(actualValue) !== stableJson(expectedValue)) return false;
  }
  return true;
}

function stageIndex(stage: QualificationStage): number {
  return QUALIFICATION_STAGE_ORDER.indexOf(stage);
}

function stageOrFail(value: string, field: string): QualificationStage {
  if (!QUALIFICATION_STAGE_ORDER.includes(value as QualificationStage)) {
    fail({ code: "invalid-input", message: `${field} is not a known Qualification Stage.`, affectedObject: field, recoveryAction: `use one of ${QUALIFICATION_STAGE_ORDER.join(", ")}`, receipt: `field=${field}; value=${value}` });
  }
  return value as QualificationStage;
}

export const DEFAULT_QUALIFICATION_CRITERIA: readonly QualificationCriterion[] = [
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "k0:scaffold-local", stage: "K0", fixtureId: "worker", label: "Local scaffold and explicit connect", dimension: "developer experience", nextAction: "run the scaffold and explicit-connect journey against the current source" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "k0:solo-git-flow", stage: "K0", fixtureId: "typescript-library", label: "Solo Git-compatible Change flow", dimension: "solo developer", nextAction: "run clone, edit, commit, push, check, and undo against a Workspace Repository" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "k0:agents", stage: "K0", fixtureId: "worker", label: "Coding-agent task isolation", dimension: "coding agents", nextAction: "run Codex, Claude Code, and Cursor task isolation and canonical-write denial" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "k0:portability", stage: "K0", fixtureId: "typescript-library", label: "Project Export and restore", dimension: "portability", nextAction: "export, verify, restore, and compare the Project and recovery refs" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "k0:performance-receipt", stage: "K0", fixtureId: "worker", label: "Performance measurement before tripwires", dimension: "performance", nextAction: "measure healthy reference runs before declaring a limit" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:worker-target", stage: "private-alpha", fixtureId: "worker", label: "Worker preview, Release, Promotion, and rollback", dimension: "web application", nextAction: "run the Worker Release and health-verified rollback journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:cli-artifact-target", stage: "private-alpha", fixtureId: "typescript-library", label: "Typed CLI/library Artifact and release asset", dimension: "non-web project", nextAction: "run the non-web Artifact, Release, and generic Target journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:hybrid-source", stage: "private-alpha", fixtureId: "hybrid-source", label: "Public/private Source Space projection", dimension: "hybrid source", nextAction: "run the disclosure-safe public projection journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:recovery", stage: "private-alpha", fixtureId: "worker", label: "Import and Promotion failure recovery", dimension: "failure recovery", nextAction: "resume from the named Recovery Checkpoint or reconcile the partial effect" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:security-boundaries", stage: "private-alpha", fixtureId: "hybrid-source", label: "Critical trust-boundary qualification", dimension: "security", nextAction: "rerun the failing canonical-write, disclosure, token, Secret Use, Evidence, or tenant journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:accessibility", stage: "private-alpha", fixtureId: "worker", label: "Accessible web companion journey", dimension: "accessibility", nextAction: "rerun the accessibility journey and attach its observed receipt" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "private-alpha:operations-rollback", stage: "private-alpha", fixtureId: "worker", label: "Operational health and rollback", dimension: "operations", nextAction: "rerun health, audit, retry, and immutable rollback observations" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:team-review", stage: "public-beta", fixtureId: "worker", label: "Team review and separation of duties", dimension: "teams", nextAction: "run the multi-Actor review, approval, cohort, and Landing journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:agent-delegation", stage: "public-beta", fixtureId: "realm-identity", label: "Realm-owned agent identity and human delegation", dimension: "agent trust", nextAction: "run the Realm-owned agent Actor, narrowed Grant, audience, and revocation journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:public-contribution", stage: "public-beta", fixtureId: "hybrid-source", label: "Public contributor workflow", dimension: "public contributors", nextAction: "run a public projection contribution without private disclosure" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:multi-realm", stage: "public-beta", fixtureId: "worker", label: "Multiple isolated Realms", dimension: "tenancy", nextAction: "run the cross-Realm denial and explicit receiving-Realm grant journey" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:customer-install-control", stage: "public-beta", fixtureId: "customer-realm-control", label: "Customer-operated installation and owner claim control", dimension: "customer onboarding", nextAction: "run authenticated install, adapter-verified owner claim, readiness, and quarantined recovery" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:repository-fallback", stage: "public-beta", fixtureId: "typescript-library", label: "Second RepositoryDriver path", dimension: "provider portability", nextAction: "run export, restore, and Git operations through the fallback driver" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:two-way-mirror", stage: "public-beta", fixtureId: "hybrid-source", label: "Two-way GitHub mirror", dimension: "ecosystem compatibility", nextAction: "run mirror divergence, loop, force-update, and recovery journeys" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:external-runner", stage: "public-beta", fixtureId: "typescript-library", label: "Portable external pull Runner", dimension: "cross-platform execution", nextAction: "run immutable input, narrowed grant, scoped output, signed result, and expiry" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "public-beta:npm-target", stage: "public-beta", fixtureId: "typescript-library", label: "npm or generic package Target", dimension: "ecosystem output", nextAction: "publish the reviewed Artifact without rebuilding source" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "expansion:extension-trust", stage: "expansion", fixtureId: "worker", label: "Extension authority remains narrowed", dimension: "extensions", nextAction: "rerun extension digest, grant, deny, and revocation qualification" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "expansion:governance-portable", stage: "expansion", fixtureId: "worker", label: "Governance Profile portability", dimension: "governance", nextAction: "export and replay the Governance Profile on a customer Realm" },
  { protocol: CONTRACT_VERSIONS.acceptanceCriterion, key: "expansion:project-adapter", stage: "expansion", fixtureId: "typescript-library", label: "Specialized project adapter", dimension: "project types", nextAction: "run the adapter's source-to-Artifact-to-Target qualification" },
];

export const DEFAULT_STAGE_GATES: readonly StageGateDefinition[] = [
  {
    protocol: CONTRACT_VERSIONS.stageGate,
    id: "K0",
    title: "Open-source TypeScript kernel",
    dependsOn: [],
    criterionKeys: DEFAULT_QUALIFICATION_CRITERIA.filter((criterion) => criterion.stage === "K0").map((criterion) => criterion.key),
    reliabilityObjectiveIds: ["reliability:K0:local"],
    usageReceiptIds: ["usage:K0"],
    providerCostReceiptIds: [],
    budgetDecisionIds: ["budget:K0"],
    recoveryDrillKinds: ["restore"],
    residualRiskIds: ["risk:K0:provider-boundary"],
  },
  {
    protocol: CONTRACT_VERSIONS.stageGate,
    id: "private-alpha",
    title: "Customer-operated Cloudflare private alpha",
    dependsOn: ["K0"],
    criterionKeys: DEFAULT_QUALIFICATION_CRITERIA.filter((criterion) => criterion.stage === "private-alpha").map((criterion) => criterion.key),
    reliabilityObjectiveIds: ["reliability:private-alpha:customer-realm"],
    usageReceiptIds: ["usage:private-alpha"],
    providerCostReceiptIds: ["cost:private-alpha"],
    budgetDecisionIds: ["budget:private-alpha"],
    recoveryDrillKinds: ["import", "provider-outage", "partial-landing", "partial-promotion", "credential-compromise", "restore"],
    residualRiskIds: ["risk:private-alpha:provider-boundary", "risk:private-alpha:host-isolation"],
  },
  {
    protocol: CONTRACT_VERSIONS.stageGate,
    id: "public-beta",
    title: "Public beta with team adoption",
    dependsOn: ["private-alpha"],
    criterionKeys: DEFAULT_QUALIFICATION_CRITERIA.filter((criterion) => criterion.stage === "public-beta").map((criterion) => criterion.key),
    reliabilityObjectiveIds: ["reliability:public-beta:shared-control-plane"],
    usageReceiptIds: ["usage:public-beta"],
    providerCostReceiptIds: ["cost:public-beta"],
    budgetDecisionIds: ["budget:public-beta"],
    recoveryDrillKinds: ["mirror-divergence", "credential-compromise", "restore"],
    residualRiskIds: ["risk:public-beta:provider-fallback", "risk:public-beta:tenant-isolation"],
  },
  {
    protocol: CONTRACT_VERSIONS.stageGate,
    id: "expansion",
    title: "Open ecosystem and governance expansion",
    dependsOn: ["public-beta"],
    criterionKeys: DEFAULT_QUALIFICATION_CRITERIA.filter((criterion) => criterion.stage === "expansion").map((criterion) => criterion.key),
    reliabilityObjectiveIds: ["reliability:expansion:adapters"],
    usageReceiptIds: ["usage:expansion"],
    providerCostReceiptIds: ["cost:expansion"],
    budgetDecisionIds: ["budget:expansion"],
    recoveryDrillKinds: ["provider-outage", "credential-compromise", "restore"],
    residualRiskIds: ["risk:expansion:ecosystem-drift", "risk:expansion:governance-claims"],
  },
];

export const DEFAULT_QUALIFICATION_PLAN: QualificationPlan = {
  protocol: CONTRACT_VERSIONS.qualificationPlan,
  criteria: DEFAULT_QUALIFICATION_CRITERIA,
  stages: DEFAULT_STAGE_GATES,
};

function defaultStageState(): Record<QualificationStage, StageLifecycle> {
  return { K0: "pending", "private-alpha": "pending", "public-beta": "pending", expansion: "pending" };
}

function copyContext(value: QualificationContext): QualificationContext {
  return context(value);
}

function copyEvidence(value: QualificationEvidence): QualificationEvidence {
  return { ...clone(value), context: copyContext(value.context) };
}

export class QualificationRegistry {
  private readonly plan: QualificationPlan;
  private readonly now: () => string;
  private readonly stages = new Map<QualificationStage, StageLifecycle>(Object.entries(defaultStageState()) as [QualificationStage, StageLifecycle][]);
  private readonly evidence = new Map<string, QualificationEvidence[]>();
  private readonly reliability = new Map<string, ReliabilityObjective>();
  private readonly usage = new Map<string, UsageReceipt>();
  private readonly providerCosts = new Map<string, ProviderCostReceipt>();
  private readonly budgets = new Map<string, BudgetPolicy>();
  private readonly budgetDecisions = new Map<string, BudgetDecision>();
  private readonly drills = new Map<string, RecoveryDrill>();
  private readonly risks = new Map<string, QualifiedResidualRisk>();
  private readonly decisions = new Map<QualificationStage, QualificationGateDecision>();

  constructor(input: QualificationRegistryInput = {}) {
    this.plan = clone(input.plan ?? DEFAULT_QUALIFICATION_PLAN);
    this.now = input.now ?? (() => new Date().toISOString());
    this.validatePlan(this.plan);
  }

  getPlan(): QualificationPlan {
    return clone(this.plan);
  }

  getStageState(stage: QualificationStage): StageLifecycle {
    this.requireStage(stage);
    return this.stages.get(stage) ?? "pending";
  }

  listEvidence(): readonly QualificationEvidence[] {
    return [...this.evidence.values()].flat().map(copyEvidence);
  }

  listReliabilityObjectives(): readonly ReliabilityObjective[] {
    return [...this.reliability.values()].map(clone);
  }

  listUsageReceipts(): readonly UsageReceipt[] {
    return [...this.usage.values()].map(clone);
  }

  listProviderCostReceipts(): readonly ProviderCostReceipt[] {
    return [...this.providerCosts.values()].map(clone);
  }

  listBudgetPolicies(): readonly BudgetPolicy[] {
    return [...this.budgets.values()].map(clone);
  }

  listBudgetDecisions(): readonly BudgetDecision[] {
    return [...this.budgetDecisions.values()].map(clone);
  }

  listRecoveryDrills(): readonly RecoveryDrill[] {
    return [...this.drills.values()].map((drill) => ({ ...clone(drill), context: copyContext(drill.context) }));
  }

  listResidualRisks(): readonly QualifiedResidualRisk[] {
    return [...this.risks.values()].map(clone);
  }

  recordEvidence(input: Omit<QualificationEvidence, "protocol" | "observedAt"> & { protocol?: never; observedAt?: string }): QualificationEvidence {
    const criterion = this.requireCriterion(input.criterionKey);
    if (criterion.stage !== input.stage || criterion.fixtureId !== input.fixtureId) {
      fail({ code: "invalid-input", message: `Evidence ${input.id} does not match Criterion ${criterion.key}'s stage or fixture.`, affectedObject: input.id, recoveryAction: `record Evidence using stage=${criterion.stage} and fixtureId=${criterion.fixtureId}`, receipt: `criterion=${criterion.key}; evidenceStage=${input.stage}; criterionStage=${criterion.stage}; evidenceFixture=${input.fixtureId}; criterionFixture=${criterion.fixtureId}` });
    }
    nonEmpty(input.id, "evidence.id");
    nonEmpty(input.validityKey, "evidence.validityKey");
    receipt(input.receipt, "evidence.receipt");
    nonEmpty(input.owner, "evidence.owner");
    nonEmpty(input.nextAction, "evidence.nextAction");
    const observedAt = input.observedAt ?? this.now();
    nonEmpty(observedAt, "evidence.observedAt");
    const record: QualificationEvidence = {
      protocol: CONTRACT_VERSIONS.qualificationEvidence,
      ...clone(input),
      context: copyContext(input.context),
      observedAt,
    };
    const records = this.evidence.get(record.criterionKey) ?? [];
    if (records.some((candidate) => candidate.id === record.id)) {
      fail({ code: "duplicate", message: `Qualification Evidence ${record.id} already exists.`, affectedObject: record.id, recoveryAction: "use a new Evidence identity or inspect the existing immutable record", receipt: `evidence=${record.id}; duplicate=true` });
    }
    this.evidence.set(record.criterionKey, [...records, record]);
    return copyEvidence(record);
  }

  recordReliabilityObjective(input: Omit<ReliabilityObjective, "protocol"> & { protocol?: never }): ReliabilityObjective {
    nonEmpty(input.id, "reliabilityObjective.id");
    stageOrFail(input.stage, "reliabilityObjective.stage");
    nonEmpty(input.hostingMode, "reliabilityObjective.hostingMode");
    nonEmpty(input.name, "reliabilityObjective.name");
    nonEmpty(input.sli, "reliabilityObjective.sli");
    measured(input.target, "reliabilityObjective.target");
    measured(input.errorBudget, "reliabilityObjective.errorBudget");
    receipt(input.measurementReceipt, "reliabilityObjective.measurementReceipt");
    nonEmpty(input.owner, "reliabilityObjective.owner");
    receipt(input.receipt, "reliabilityObjective.receipt");
    if (this.reliability.has(input.id)) this.duplicate(input.id);
    const objective: ReliabilityObjective = { protocol: CONTRACT_VERSIONS.reliabilityObjective, ...clone(input) };
    this.reliability.set(objective.id, objective);
    return clone(objective);
  }

  recordUsageReceipt(input: Omit<UsageReceipt, "protocol"> & { protocol?: never }): UsageReceipt {
    nonEmpty(input.id, "usageReceipt.id");
    nonEmpty(input.recordedAt, "usageReceipt.recordedAt");
    nonEmpty(input.usagePeriod.start, "usageReceipt.usagePeriod.start");
    nonEmpty(input.usagePeriod.end, "usageReceipt.usagePeriod.end");
    nonEmpty(input.hostingMode, "usageReceipt.hostingMode");
    nonEmpty(input.realmId, "usageReceipt.realmId");
    nonEmpty(input.projectId, "usageReceipt.projectId");
    nonEmpty(input.logicalUnit, "usageReceipt.logicalUnit");
    nonEmpty(input.providerResource, "usageReceipt.providerResource");
    measured(input.quantity, "usageReceipt.quantity");
    if (input.estimatedCost) measured(input.estimatedCost, "usageReceipt.estimatedCost");
    if (input.currency !== undefined) nonEmpty(input.currency, "usageReceipt.currency");
    if (input.priceVersion !== undefined) nonEmpty(input.priceVersion, "usageReceipt.priceVersion");
    nonEmpty(input.idempotencyKey, "usageReceipt.idempotencyKey");
    receipt(input.receipt, "usageReceipt.receipt");
    if (this.usage.has(input.id)) this.duplicate(input.id);
    const record: UsageReceipt = { protocol: CONTRACT_VERSIONS.usageReceipt, ...clone(input), disclosure: { ...input.disclosure }, usagePeriod: { ...input.usagePeriod } };
    this.usage.set(record.id, record);
    return clone(record);
  }

  recordProviderCostReceipt(input: Omit<ProviderCostReceipt, "protocol"> & { protocol?: never }): ProviderCostReceipt {
    nonEmpty(input.id, "providerCostReceipt.id");
    nonEmpty(input.provider, "providerCostReceipt.provider");
    list(input.usageReceiptIds, "providerCostReceipt.usageReceiptIds");
    if (input.usageReceiptIds.some((id) => !this.usage.has(id))) {
      fail({ code: "not-found", message: `Provider Cost Receipt ${input.id} references missing Usage Receipts.`, affectedObject: input.id, recoveryAction: "record the Usage Receipts before recording provider reconciliation", receipt: `cost=${input.id}; usage=${input.usageReceiptIds.join(",")}` });
    }
    measured(input.providerQuantity, "providerCostReceipt.providerQuantity");
    measured(input.attributedQuantity, "providerCostReceipt.attributedQuantity");
    if (input.billedQuantity) measured(input.billedQuantity, "providerCostReceipt.billedQuantity");
    if (input.estimatedCost) measured(input.estimatedCost, "providerCostReceipt.estimatedCost");
    if (input.billedCost) measured(input.billedCost, "providerCostReceipt.billedCost");
    if (input.variance) measured(input.variance, "providerCostReceipt.variance");
    receipt(input.receipt, "providerCostReceipt.receipt");
    if (this.providerCosts.has(input.id)) this.duplicate(input.id);
    const record: ProviderCostReceipt = { protocol: CONTRACT_VERSIONS.providerCostReceipt, ...clone(input), usageReceiptIds: list(input.usageReceiptIds, "providerCostReceipt.usageReceiptIds") };
    this.providerCosts.set(record.id, record);
    return clone(record);
  }

  recordBudgetPolicy(input: Omit<BudgetPolicy, "protocol"> & { protocol?: never }): BudgetPolicy {
    nonEmpty(input.id, "budgetPolicy.id");
    nonEmpty(input.scope.realmId, "budgetPolicy.scope.realmId");
    nonEmpty(input.dimension, "budgetPolicy.dimension");
    if (input.configuredLimit) measured(input.configuredLimit, "budgetPolicy.configuredLimit");
    if (input.providerLimit) measured(input.providerLimit, "budgetPolicy.providerLimit");
    nonEmpty(input.owner, "budgetPolicy.owner");
    receipt(input.receipt, "budgetPolicy.receipt");
    if (this.budgets.has(input.id)) this.duplicate(input.id);
    const policy: BudgetPolicy = { protocol: CONTRACT_VERSIONS.budgetPolicy, ...clone(input), scope: { ...input.scope } };
    this.budgets.set(policy.id, policy);
    return clone(policy);
  }

  recordBudgetDecision(input: Omit<BudgetDecision, "protocol"> & { protocol?: never }): BudgetDecision {
    nonEmpty(input.id, "budgetDecision.id");
    if (!this.budgets.has(input.policyId)) {
      fail({ code: "not-found", message: `Budget Decision ${input.id} references missing Budget Policy ${input.policyId}.`, affectedObject: input.id, recoveryAction: "record the versioned Budget Policy before evaluating the decision", receipt: `decision=${input.id}; policy=${input.policyId}; policyPresent=false` });
    }
    measured(input.requested, "budgetDecision.requested");
    measured(input.consumed, "budgetDecision.consumed");
    if (input.limit) measured(input.limit, "budgetDecision.limit");
    nonEmpty(input.uncertainty, "budgetDecision.uncertainty");
    nonEmpty(input.nextAction, "budgetDecision.nextAction");
    receipt(input.receipt, "budgetDecision.receipt");
    if (this.budgetDecisions.has(input.id)) this.duplicate(input.id);
    const decision: BudgetDecision = { protocol: CONTRACT_VERSIONS.budgetDecision, ...clone(input) };
    this.budgetDecisions.set(decision.id, decision);
    return clone(decision);
  }

  recordRecoveryDrill(input: Omit<RecoveryDrill, "protocol"> & { protocol?: never }): RecoveryDrill {
    nonEmpty(input.id, "recoveryDrill.id");
    stageOrFail(input.stage, "recoveryDrill.stage");
    nonEmpty(input.checkpointId, "recoveryDrill.checkpointId");
    nonEmpty(input.validityKey, "recoveryDrill.validityKey");
    nonEmpty(input.expectedInvariant, "recoveryDrill.expectedInvariant");
    nonEmpty(input.observedResult, "recoveryDrill.observedResult");
    nonEmpty(input.owner, "recoveryDrill.owner");
    nonEmpty(input.nextAction, "recoveryDrill.nextAction");
    nonEmpty(input.observedAt, "recoveryDrill.observedAt");
    receipt(input.receipt, "recoveryDrill.receipt");
    if (this.drills.has(input.id)) this.duplicate(input.id);
    const drill: RecoveryDrill = { protocol: CONTRACT_VERSIONS.recoveryDrill, ...clone(input), context: copyContext(input.context) };
    this.drills.set(drill.id, drill);
    return { ...clone(drill), context: copyContext(drill.context) };
  }

  recordResidualRisk(input: Omit<QualifiedResidualRisk, "protocol"> & { protocol?: never }): QualifiedResidualRisk {
    nonEmpty(input.id, "residualRisk.id");
    stageOrFail(input.stage, "residualRisk.stage");
    nonEmpty(input.description, "residualRisk.description");
    nonEmpty(input.owner, "residualRisk.owner");
    nonEmpty(input.mitigation, "residualRisk.mitigation");
    nonEmpty(input.qualificationGate, "residualRisk.qualificationGate");
    nonEmpty(input.nextAction, "residualRisk.nextAction");
    receipt(input.decisionReceipt, "residualRisk.decisionReceipt");
    receipt(input.receipt, "residualRisk.receipt");
    if (this.risks.has(input.id)) this.duplicate(input.id);
    const risk: QualifiedResidualRisk = { protocol: CONTRACT_VERSIONS.residualRisk, ...clone(input) };
    this.risks.set(risk.id, risk);
    return clone(risk);
  }

  activateStage(stage: QualificationStage): QualificationGateDecision | undefined {
    this.requireStage(stage);
    const definition = this.definition(stage);
    const blockers = definition.dependsOn.filter((dependency) => this.getStageState(dependency) !== "complete");
    if (blockers.length > 0) {
      fail({ code: "stage-state", message: `Stage ${stage} cannot activate before its dependencies complete.`, affectedObject: stage, recoveryAction: `complete ${blockers.join(", ")} and retry activation`, receipt: `stage=${stage}; dependencies=${blockers.join(",")}` });
    }
    this.stages.set(stage, "active");
    return this.decisions.get(stage);
  }

  completeStage(stage: QualificationStage): QualificationGateDecision {
    this.requireStage(stage);
    if (this.getStageState(stage) !== "active") {
      fail({ code: "stage-state", message: `Stage ${stage} must be active before completion.`, affectedObject: stage, recoveryAction: `activate ${stage} after its dependencies complete`, receipt: `stage=${stage}; state=${this.getStageState(stage)}` });
    }
    const decision = this.evaluate(stage);
    if (decision.status !== "ready") {
      fail({ code: "gate-blocked", message: `Stage Gate ${stage} is blocked.`, affectedObject: stage, recoveryAction: decision.blockers[0]?.nextAction ?? `resolve the recorded blockers for ${stage}`, receipt: decision.receipt });
    }
    this.stages.set(stage, "complete");
    return decision;
  }

  evaluate(stage: QualificationStage): QualificationGateDecision {
    this.requireStage(stage);
    const definition = this.definition(stage);
    const blockers: QualificationBlocker[] = [];
    const advisories: QualificationAdvisory[] = [];
    const evidenceIds: string[] = [];

    for (const dependency of definition.dependsOn) {
      if (this.getStageState(dependency) !== "complete") {
        blockers.push({ kind: "dependency", key: dependency, message: `Stage ${stage} depends on incomplete Stage ${dependency}.`, nextAction: `complete Stage ${dependency} before advancing ${stage}` });
      }
    }

    for (const criterionKey of definition.criterionKeys) {
      const criterion = this.requireCriterion(criterionKey);
      const latest = this.latestEvidence(criterionKey);
      if (!latest) {
        blockers.push({ kind: "criterion", key: criterionKey, message: `Qualification Evidence ${criterionKey} is missing for Stage ${stage}.`, nextAction: criterion.nextAction });
        continue;
      }
      evidenceIds.push(latest.id);
      if (latest.status !== "passed") {
        blockers.push({ kind: "criterion", key: criterionKey, message: `Qualification Evidence ${criterionKey} is ${latest.status} for Stage ${stage}.`, nextAction: latest.nextAction });
        continue;
      }
      if ((criterion.expectedValidityKey !== undefined && criterion.expectedValidityKey !== latest.validityKey)
        || (criterion.expectedContext !== undefined && !matchesPartialContext(latest.context, criterion.expectedContext))) {
        blockers.push({ kind: "criterion", key: criterionKey, message: `Qualification Evidence ${criterionKey} is stale for Stage ${stage}; its validity context changed.`, nextAction: criterion.nextAction });
        continue;
      }
      if (latest.receipt.trim().length === 0 || latest.owner.trim().length === 0 || latest.nextAction.trim().length === 0) {
        blockers.push({ kind: "criterion", key: criterionKey, message: `Qualification Evidence ${criterionKey} is indeterminate because its receipt, owner, or next action is missing.`, nextAction: criterion.nextAction });
      }
    }

    for (const objectiveId of definition.reliabilityObjectiveIds) {
      const objective = this.reliability.get(objectiveId);
      if (!objective) {
        blockers.push({ kind: "reliability", key: objectiveId, message: `Reliability Objective ${objectiveId} is missing for Stage ${stage}.`, nextAction: "record the measured SLI, target, error budget, owner, and measurement receipt" });
        continue;
      }
      if (!objective.measurementReceipt.trim() || !objective.receipt.trim()) {
        blockers.push({ kind: "reliability", key: objectiveId, message: `Reliability Objective ${objectiveId} has no complete measurement receipt.`, nextAction: "remeasure the objective and attach the source and method receipt" });
      }
    }

    for (const usageId of definition.usageReceiptIds) {
      if (!this.usage.has(usageId)) blockers.push({ kind: "usage-receipt", key: usageId, message: `Usage Receipt ${usageId} is missing for Stage ${stage}.`, nextAction: "record the logical and provider usage attribution before advancing the gate" });
    }

    for (const costId of definition.providerCostReceiptIds) {
      const cost = this.providerCosts.get(costId);
      if (!cost) {
        blockers.push({ kind: "provider-cost-receipt", key: costId, message: `Provider Cost Receipt ${costId} is missing for Stage ${stage}.`, nextAction: "reconcile the Usage Receipts to the provider feed or record an explicit unavailable-feed receipt" });
      } else if (cost.feedStatus === "unavailable" || cost.feedStatus === "delayed") {
        advisories.push({ kind: "provider-feed", key: costId, message: `Provider Cost Receipt ${costId} is recorded with a ${cost.feedStatus} provider feed.`, nextAction: "reconcile the provider feed when it becomes current; do not treat the estimate as an invoice" });
      }
    }

    for (const budgetId of definition.budgetDecisionIds) {
      const decision = this.budgetDecisions.get(budgetId);
      if (!decision) {
        blockers.push({ kind: "budget", key: budgetId, message: `Budget Decision ${budgetId} is missing for Stage ${stage}.`, nextAction: "evaluate the versioned Budget Policy and record requested, consumed, limit, uncertainty, and next action" });
      } else if (decision.state === "approval_required" || decision.state === "exhausted" || decision.state === "degraded") {
        blockers.push({ kind: "budget", key: budgetId, message: `Budget Decision ${budgetId} is ${decision.state}; the Stage Gate cannot advance.`, nextAction: decision.nextAction });
      }
    }

    for (const kind of definition.recoveryDrillKinds) {
      const drill = this.latestDrill(stage, kind);
      if (!drill) {
        blockers.push({ kind: "recovery", key: `${stage}:${kind}`, message: `Recovery Drill ${kind} is missing for Stage ${stage}.`, nextAction: `run the ${kind} recovery drill and record its checkpoint and observed result` });
      } else if (drill.status !== "passed") {
        blockers.push({ kind: "recovery", key: drill.id, message: `Recovery Drill ${drill.id} is ${drill.status}.`, nextAction: drill.nextAction });
      }
    }

    for (const riskId of definition.residualRiskIds) {
      const risk = this.risks.get(riskId);
      if (!risk) {
        blockers.push({ kind: "residual-risk", key: riskId, message: `Residual Risk ${riskId} has no owner, mitigation, qualification gate, or decision record.`, nextAction: "record the Residual Risk and make an explicit accepted or deferred decision" });
      } else if (risk.decision === "open") {
        blockers.push({ kind: "residual-risk", key: riskId, message: `Residual Risk ${riskId} remains open for Stage ${stage}.`, nextAction: risk.nextAction });
      } else if (risk.decision === "deferred") {
        advisories.push({ kind: "residual-risk", key: riskId, message: `Residual Risk ${riskId} is explicitly deferred rather than silently ignored.`, nextAction: risk.nextAction });
      }
    }

    const status = blockers.length === 0 ? "ready" : "blocked";
    const decision: QualificationGateDecision = {
      protocol: CONTRACT_VERSIONS.stageGateDecision,
      id: `stage-gate:${stage}:${digest({ stage, evidenceIds, blockerKeys: blockers.map((blocker) => blocker.key), advisoryKeys: advisories.map((advisory) => advisory.key) })}`,
      stage,
      status,
      blockers,
      advisories,
      evidenceIds,
      receipt: `stage=${stage}; status=${status}; blockers=${blockers.length}; advisories=${advisories.length}; evidence=${evidenceIds.length}; evaluatedAt=${this.now()}`,
    };
    this.decisions.set(stage, decision);
    return clone(decision);
  }

  getDecision(stage: QualificationStage): QualificationGateDecision | undefined {
    const decision = this.decisions.get(stage);
    return decision ? clone(decision) : undefined;
  }

  private latestEvidence(key: string): QualificationEvidence | undefined {
    const records = this.evidence.get(key) ?? [];
    return [...records].sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id)).at(-1);
  }

  private latestDrill(stage: QualificationStage, kind: RecoveryDrillKind): RecoveryDrill | undefined {
    return [...this.drills.values()]
      .filter((drill) => drill.stage === stage && drill.kind === kind)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id))
      .at(-1);
  }

  private requireCriterion(key: string): QualificationCriterion {
    const criterion = this.plan.criteria.find((candidate) => candidate.key === key);
    if (!criterion) fail({ code: "not-found", message: `Qualification Criterion ${key} is not in the active plan.`, affectedObject: key, recoveryAction: "add the Criterion to the versioned Qualification Plan before recording Evidence", receipt: `criterion=${key}; present=false` });
    return criterion;
  }

  private requireStage(stage: QualificationStage): void {
    if (!this.plan.stages.some((definition) => definition.id === stage)) {
      fail({ code: "not-found", message: `Qualification Stage ${stage} is not in the active plan.`, affectedObject: stage, recoveryAction: "add the Stage to the versioned Qualification Plan before evaluating it", receipt: `stage=${stage}; present=false` });
    }
  }

  private definition(stage: QualificationStage): StageGateDefinition {
    const definition = this.plan.stages.find((candidate) => candidate.id === stage);
    if (!definition) {
      fail({ code: "not-found", message: `Stage Gate ${stage} is not in the active plan.`, affectedObject: stage, recoveryAction: "add the Stage Gate definition before evaluating it", receipt: `stage=${stage}; definition=false` });
    }
    return definition;
  }

  private duplicate(id: string): never {
    return fail({ code: "duplicate", message: `Qualification record ${id} already exists.`, affectedObject: id, recoveryAction: "use a new immutable record identity or inspect the existing record", receipt: `id=${id}; duplicate=true` });
  }

  private validatePlan(plan: QualificationPlan): void {
    if (plan.protocol !== CONTRACT_VERSIONS.qualificationPlan) {
      fail({ code: "invalid-input", message: "Qualification Plan protocol is unsupported.", affectedObject: "plan.protocol", recoveryAction: `use ${CONTRACT_VERSIONS.qualificationPlan}`, receipt: `protocol=${plan.protocol}` });
    }
    const criterionKeys = plan.criteria.map((criterion) => criterion.key);
    list(criterionKeys, "plan.criteria");
    const stageIds = plan.stages.map((stage) => stage.id);
    list(stageIds, "plan.stages");
    for (const criterion of plan.criteria) {
      if (criterion.protocol !== CONTRACT_VERSIONS.acceptanceCriterion) {
        fail({ code: "invalid-input", message: `Qualification Criterion ${criterion.key} has an unsupported protocol.`, affectedObject: criterion.key, recoveryAction: `use ${CONTRACT_VERSIONS.acceptanceCriterion} for the Criterion`, receipt: `criterion=${criterion.key}; protocol=${criterion.protocol}` });
      }
      stageOrFail(criterion.stage, `criterion.${criterion.key}.stage`);
      nonEmpty(criterion.fixtureId, `criterion.${criterion.key}.fixtureId`);
      nonEmpty(criterion.label, `criterion.${criterion.key}.label`);
      nonEmpty(criterion.dimension, `criterion.${criterion.key}.dimension`);
      nonEmpty(criterion.nextAction, `criterion.${criterion.key}.nextAction`);
    }
    for (const definition of plan.stages) {
      if (definition.protocol !== CONTRACT_VERSIONS.stageGate) {
        fail({ code: "invalid-input", message: `Stage Gate ${definition.id} has an unsupported protocol.`, affectedObject: definition.id, recoveryAction: `use ${CONTRACT_VERSIONS.stageGate} for the Stage Gate`, receipt: `stage=${definition.id}; protocol=${definition.protocol}` });
      }
      stageOrFail(definition.id, "stage.id");
      nonEmpty(definition.title, `stage.${definition.id}.title`);
      list(definition.dependsOn, `stage.${definition.id}.dependsOn`);
      list(definition.criterionKeys, `stage.${definition.id}.criterionKeys`);
      list(definition.reliabilityObjectiveIds, `stage.${definition.id}.reliabilityObjectiveIds`);
      list(definition.usageReceiptIds, `stage.${definition.id}.usageReceiptIds`);
      list(definition.providerCostReceiptIds, `stage.${definition.id}.providerCostReceiptIds`);
      list(definition.budgetDecisionIds, `stage.${definition.id}.budgetDecisionIds`);
      list(definition.recoveryDrillKinds, `stage.${definition.id}.recoveryDrillKinds`);
      list(definition.residualRiskIds, `stage.${definition.id}.residualRiskIds`);
      for (const criterionKey of definition.criterionKeys) {
        if (!this.planCriteriaContains(plan, criterionKey)) {
          fail({ code: "invalid-input", message: `Stage Gate ${definition.id} references unknown Criterion ${criterionKey}.`, affectedObject: criterionKey, recoveryAction: "add the Criterion to the Qualification Plan or remove the reference", receipt: `stage=${definition.id}; criterion=${criterionKey}; present=false` });
        }
      }
      for (const dependency of definition.dependsOn) stageOrFail(dependency, `stage.${definition.id}.dependsOn`);
      if (definition.dependsOn.some((dependency) => stageIndex(dependency) >= stageIndex(definition.id))) {
        fail({ code: "invalid-input", message: `Stage Gate ${definition.id} depends on a later or equal Stage.`, affectedObject: definition.id, recoveryAction: "order Stage dependencies from earlier to later and retry", receipt: `stage=${definition.id}; dependsOn=${definition.dependsOn.join(",")}` });
      }
    }
  }

  private planCriteriaContains(plan: QualificationPlan, key: string): boolean {
    return plan.criteria.some((criterion) => criterion.key === key);
  }
}
