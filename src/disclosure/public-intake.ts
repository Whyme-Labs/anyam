import { CONTRACT_VERSIONS } from "../kernel/contracts.ts";

export const PUBLIC_INTAKE_PROTOCOL = CONTRACT_VERSIONS.publicIntake;

export type PublicIntakeStatus = "closed" | "open" | "suspended";
export type PublicIntakePolicyMode = "rate-limited" | "approval-only";
export type PublicIntakeActorRole = "owner" | "moderator";

/** A configured limit is invalid without a measurement receipt. */
export type PublicIntakeMeasuredLimit = {
  value: number;
  unit: string;
  measuredAt: string;
  method: string;
  receipt: string;
};

export type PublicIntakePolicy = {
  protocol: typeof PUBLIC_INTAKE_PROTOCOL;
  id: string;
  realmId: string;
  projectId: string;
  publicSourceSpaceId: string;
  mode: PublicIntakePolicyMode;
  window: string;
  configuredLimit?: PublicIntakeMeasuredLimit;
  owner: string;
  receipt: string;
};

export type PublicIntakeDecision = {
  protocol: typeof PUBLIC_INTAKE_PROTOCOL;
  id: string;
  requestId: string;
  actorId: string;
  projectId: string;
  publicSourceSpaceId: string;
  status: "accepted" | "denied" | "approval_required";
  disposition: "quarantined" | "not-materialized" | "awaiting-owner-review";
  requested: number;
  consumed: number;
  configuredLimit?: PublicIntakeMeasuredLimit;
  nextAction: string;
  receipt: string;
};

export type PublicIntakeSnapshot = {
  protocol: typeof PUBLIC_INTAKE_PROTOCOL;
  policy: PublicIntakePolicy;
  status: PublicIntakeStatus;
  requests: number;
  accepted: number;
  denied: number;
  pendingReview: number;
  preservedContributionIds: readonly string[];
  lastDecision?: PublicIntakeDecision;
};

export type PublicIntakeResult =
  | { status: "accepted"; decision: PublicIntakeDecision }
  | { status: "denied"; decision: PublicIntakeDecision }
  | { status: "approval_required"; decision: PublicIntakeDecision };

export class PublicIntakeError extends Error {
  readonly code: "invalid-policy" | "invalid-request" | "forbidden" | "invalid-state";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: PublicIntakeError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "PublicIntakeError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PublicIntakeError({
      code: "invalid-request",
      message: `${field} is required for public intake.`,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validatePolicy(policy: PublicIntakePolicy): PublicIntakePolicy {
  required(policy.id, "policy.id");
  required(policy.realmId, "policy.realmId");
  required(policy.projectId, "policy.projectId");
  required(policy.publicSourceSpaceId, "policy.publicSourceSpaceId");
  required(policy.window, "policy.window");
  required(policy.owner, "policy.owner");
  required(policy.receipt, "policy.receipt");
  if (policy.mode === "rate-limited") {
    const limit = policy.configuredLimit;
    if (!limit) {
      throw new PublicIntakeError({
        code: "invalid-policy",
        message: "Rate-limited public intake requires a measured configured limit; no public quota was activated.",
        recoveryAction: "record a workload measurement with its receipt, or choose approval-only intake",
        receipt: `policy=${policy.id}; configuredLimit=missing; publicIntake=closed`,
      });
    }
    if (!Number.isFinite(limit.value) || limit.value < 1) {
      throw new PublicIntakeError({
        code: "invalid-policy",
        message: "The public-intake configured limit must be a positive measured value.",
        recoveryAction: "remeasure a healthy workload and provide a positive configured limit",
        receipt: `policy=${policy.id}; configuredLimit=${String(limit.value)}; valid=false`,
      });
    }
    required(limit.unit, "configuredLimit.unit");
    required(limit.measuredAt, "configuredLimit.measuredAt");
    required(limit.method, "configuredLimit.method");
    required(limit.receipt, "configuredLimit.receipt");
  }
  return clone(policy);
}

/**
 * Destination-Realm public contribution control. Accepted submissions are
 * quarantined Change inputs; this class never Lands, reads private Source
 * Spaces, or deletes canonical lineage.
 */
export class PublicIntakeController {
  private readonly policy: PublicIntakePolicy;
  private status: PublicIntakeStatus = "closed";
  private requests = 0;
  private accepted = 0;
  private denied = 0;
  private pendingReview = 0;
  private readonly preservedContributionIds: string[] = [];
  private lastDecision: PublicIntakeDecision | undefined;

  constructor(policy: PublicIntakePolicy) {
    this.policy = validatePolicy(policy);
  }

  snapshot(): PublicIntakeSnapshot {
    return clone({
      protocol: PUBLIC_INTAKE_PROTOCOL,
      policy: this.policy,
      status: this.status,
      requests: this.requests,
      accepted: this.accepted,
      denied: this.denied,
      pendingReview: this.pendingReview,
      preservedContributionIds: this.preservedContributionIds,
      ...(this.lastDecision ? { lastDecision: this.lastDecision } : {}),
    });
  }

  open(actor: { id: string; role: PublicIntakeActorRole }): PublicIntakeSnapshot {
    required(actor.id, "actor.id");
    if (this.status === "suspended") {
      throw new PublicIntakeError({
        code: "invalid-state",
        message: "Suspended public intake cannot be reopened without an explicit review decision.",
        recoveryAction: "call reopen after owner or moderator review and record the review receipt",
        receipt: `policy=${this.policy.id}; state=suspended; transition=open=denied`,
      });
    }
    this.status = "open";
    return this.snapshot();
  }

  submit(input: { requestId: string; actorId: string; contributionId: string }): PublicIntakeResult {
    required(input.requestId, "requestId");
    required(input.actorId, "actorId");
    required(input.contributionId, "contributionId");
    const requested = this.requests + 1;
    this.requests = requested;

    if (this.status === "suspended") {
      return this.recordDenied(input, requested, "public-intake-suspended", "owner or moderator reviews the suspension before reopening public intake");
    }
    if (this.status !== "open") {
      return this.recordDenied(input, requested, "public-intake-closed", "an owner explicitly opens the destination-Realm public projection before accepting contributions");
    }
    if (this.policy.mode === "approval-only") {
      this.pendingReview += 1;
      const decision = this.record({
        ...input,
        status: "approval_required",
        disposition: "awaiting-owner-review",
        requested,
        consumed: this.accepted,
        nextAction: "owner reviews the public Change envelope before it becomes an accepted quarantined input",
        receipt: `policy=${this.policy.id}; mode=approval-only; request=${input.requestId}; materialized=false`,
      });
      return { status: "approval_required", decision };
    }

    const limit = this.policy.configuredLimit!;
    if (requested > limit.value) {
      return this.recordDenied(input, requested, `public-contribution-${limit.unit}`, "wait for the configured window to reset, authenticate for a higher-grant path, or ask the owner to review the policy", limit);
    }

    this.accepted += 1;
    this.preservedContributionIds.push(input.contributionId);
    const decision = this.record({
      ...input,
      status: "accepted",
      disposition: "quarantined",
      requested,
      consumed: this.accepted,
      configuredLimit: limit,
      nextAction: "run disclosure checks and create a Change Revision; Landing remains a separate authorized operation",
      receipt: `policy=${this.policy.id}; request=${input.requestId}; contribution=${input.contributionId}; privateSourceSpace=not-materialized`,
    });
    return { status: "accepted", decision };
  }

  suspend(input: { actor: { id: string; role: PublicIntakeActorRole }; reason: string; receipt: string }): PublicIntakeSnapshot {
    required(input.actor.id, "actor.id");
    required(input.reason, "reason");
    required(input.receipt, "receipt");
    this.status = "suspended";
    return this.snapshot();
  }

  reopen(input: { actor: { id: string; role: PublicIntakeActorRole }; reviewReceipt: string }): PublicIntakeSnapshot {
    required(input.actor.id, "actor.id");
    required(input.reviewReceipt, "reviewReceipt");
    if (this.status !== "suspended") {
      throw new PublicIntakeError({
        code: "invalid-state",
        message: "Only suspended public intake can be reopened.",
        recoveryAction: "inspect the current public-intake state and retry the matching transition",
        receipt: `policy=${this.policy.id}; state=${this.status}; transition=reopen=denied`,
      });
    }
    this.status = "open";
    return this.snapshot();
  }

  cleanup(input: { actor: { id: string; role: PublicIntakeActorRole }; cleanupReceipt: string }): PublicIntakeSnapshot {
    required(input.actor.id, "actor.id");
    required(input.cleanupReceipt, "cleanupReceipt");
    this.status = "closed";
    this.pendingReview = 0;
    return this.snapshot();
  }

  private recordDenied(input: { requestId: string; actorId: string; contributionId: string }, requested: number, limitName: string, nextAction: string, configuredLimit?: PublicIntakeMeasuredLimit): PublicIntakeResult {
    this.denied += 1;
    const decision = this.record({
      ...input,
      status: "denied",
      disposition: "not-materialized",
      requested,
      consumed: this.accepted,
      ...(configuredLimit ? { configuredLimit } : {}),
      nextAction,
      receipt: `policy=${this.policy.id}; limit=${limitName}; configured=${configuredLimit?.value ?? "state-boundary"}; requested=${requested}; contribution=${input.contributionId}; materialized=false`,
    });
    return { status: "denied", decision };
  }

  private record(input: Omit<PublicIntakeDecision, "protocol" | "id" | "projectId" | "publicSourceSpaceId">): PublicIntakeDecision {
    const decision: PublicIntakeDecision = {
      protocol: PUBLIC_INTAKE_PROTOCOL,
      id: `public-intake-decision:${this.requests}`,
      projectId: this.policy.projectId,
      publicSourceSpaceId: this.policy.publicSourceSpaceId,
      ...input,
    };
    this.lastDecision = decision;
    return clone(decision);
  }
}
