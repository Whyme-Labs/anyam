import {
  PUBLIC_INTAKE_PROTOCOL,
  type PublicIntakeActorRole,
  type PublicIntakeDecision,
  type PublicIntakeMeasuredLimit,
  type PublicIntakePolicy,
} from "../disclosure/public-intake.ts";
import { CONTRACT_VERSIONS } from "../kernel/contracts.ts";

export const PUBLIC_GATEWAY_PROTOCOL = CONTRACT_VERSIONS.publicGateway;

export type PublicGatewayStatus = "closed" | "open" | "suspended";

export type PublicGatewayRequestRecord = {
  requestId: string;
  payloadDigest: string;
  contributionId: string;
  decision: PublicIntakeDecision;
  retryable: boolean;
  recordedAt: string;
};

export type PublicGatewayAuditEvent = {
  id: string;
  action: "open" | "submit" | "suspend" | "reopen" | "cleanup";
  actorId: string;
  requestId?: string;
  outcome: "accepted" | "denied" | "approval_required" | "completed";
  receipt: string;
  recordedAt: string;
};

export type PublicGatewayState = {
  protocol: typeof PUBLIC_GATEWAY_PROTOCOL;
  intakeProtocol: typeof PUBLIC_INTAKE_PROTOCOL;
  policy: PublicIntakePolicy;
  status: PublicGatewayStatus;
  requests: number;
  accepted: number;
  denied: number;
  pendingReview: number;
  preservedContributionIds: readonly string[];
  requestRecords: readonly PublicGatewayRequestRecord[];
  audit: readonly PublicGatewayAuditEvent[];
  recoveryCheckpoint: string;
};

export type PublicGatewayStore = {
  load(): Promise<PublicGatewayState | undefined>;
  save(state: PublicGatewayState): Promise<void>;
};

export type PublicGatewayClock = () => Date;

export type PublicGatewayProviderOutcome =
  | { status: "ready"; receipt: string }
  | { status: "timeout"; receipt: string }
  | { status: "abuse"; outcome: "challenge" | "denied" | "unavailable"; retryable: boolean; receipt: string };

export function parsePublicGatewayProviderOutcome(value: unknown): PublicGatewayProviderOutcome | undefined {
  if (value === "timeout") return { status: "timeout", receipt: "provider=fixture-driver; timeout=simulated; retryable=true" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "abuse") return undefined;
  if (candidate.outcome !== "challenge" && candidate.outcome !== "denied" && candidate.outcome !== "unavailable") {
    return { status: "abuse", outcome: "denied", retryable: false, receipt: "provider=invalid; outcome=not-recognized; failClosed=true" };
  }
  if (typeof candidate.retryable !== "boolean") {
    return { status: "abuse", outcome: "denied", retryable: false, receipt: "provider=invalid; retryable=not-boolean; failClosed=true" };
  }
  if (typeof candidate.receipt !== "string" || candidate.receipt.trim().length === 0) {
    return { status: "abuse", outcome: "denied", retryable: false, receipt: "provider=invalid; receipt=missing; failClosed=true" };
  }
  return { status: "abuse", outcome: candidate.outcome, retryable: candidate.retryable, receipt: candidate.receipt };
}

export type PublicGatewaySubmitInput = {
  requestId: string;
  actorId: string;
  contributionId: string;
  payloadDigest: string;
  provider?: PublicGatewayProviderOutcome;
};

export type PublicGatewayResult =
  | { status: "accepted"; decision: PublicIntakeDecision; idempotent: boolean; providerReceipt?: string; providerOutcome?: string }
  | { status: "denied"; decision: PublicIntakeDecision; idempotent: boolean; providerReceipt?: string; providerOutcome?: string }
  | { status: "approval_required"; decision: PublicIntakeDecision; idempotent: boolean; providerReceipt?: string; providerOutcome?: string };

export type PublicGatewayAdminActor = {
  id: string;
  role: PublicIntakeActorRole;
};

export class PublicGatewayError extends Error {
  readonly code: "invalid-request" | "invalid-state" | "provider-unavailable";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: PublicGatewayError["code"];
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "PublicGatewayError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }

  toJSON(): Record<string, unknown> {
    return {
      protocol: PUBLIC_GATEWAY_PROTOCOL,
      code: this.code,
      message: this.message,
      recoveryAction: this.recoveryAction,
      receipt: this.receipt,
    };
  }
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: `${field} is required for the public gateway operation.`,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function initialState(policy: PublicIntakePolicy, now: Date): PublicGatewayState {
  return {
    protocol: PUBLIC_GATEWAY_PROTOCOL,
    intakeProtocol: PUBLIC_INTAKE_PROTOCOL,
    policy: clone(policy),
    status: "closed",
    requests: 0,
    accepted: 0,
    denied: 0,
    pendingReview: 0,
    preservedContributionIds: [],
    requestRecords: [],
    audit: [],
    recoveryCheckpoint: `checkpoint:public-gateway:initial:${now.toISOString()}`,
  };
}

function decision(input: Omit<PublicIntakeDecision, "protocol" | "id" | "projectId" | "publicSourceSpaceId"> & { id: string }, policy: PublicIntakePolicy): PublicIntakeDecision {
  const { id, ...rest } = input;
  return {
    protocol: PUBLIC_INTAKE_PROTOCOL,
    id,
    projectId: policy.projectId,
    publicSourceSpaceId: policy.publicSourceSpaceId,
    ...rest,
  };
}

function findRecord(state: PublicGatewayState, requestId: string): PublicGatewayRequestRecord | undefined {
  return [...state.requestRecords].reverse().find((record) => record.requestId === requestId);
}

function samePolicy(left: PublicIntakePolicy, right: PublicIntakePolicy): boolean {
  return left.protocol === right.protocol
    && left.id === right.id
    && left.realmId === right.realmId
    && left.projectId === right.projectId
    && left.publicSourceSpaceId === right.publicSourceSpaceId
    && left.mode === right.mode
    && left.window === right.window
    && left.owner === right.owner
    && left.receipt === right.receipt
    && JSON.stringify(left.configuredLimit) === JSON.stringify(right.configuredLimit);
}

/**
 * Destination-Realm gateway coordinator. The store is supplied by the
 * customer-owned Durable Object; this class contains no Cloudflare API calls
 * and never grants Landing or private Source Space authority.
 */
export class PublicGatewayCoordinator {
  constructor(
    private readonly policy: PublicIntakePolicy,
    private readonly store: PublicGatewayStore,
    private readonly now: PublicGatewayClock = () => new Date(),
  ) {}

  async snapshot(): Promise<PublicGatewayState> {
    const stored = await this.store.load();
    if (stored && (stored.protocol !== PUBLIC_GATEWAY_PROTOCOL || stored.intakeProtocol !== PUBLIC_INTAKE_PROTOCOL || !samePolicy(stored.policy, this.policy))) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Stored public gateway state does not match the configured policy or protocol.",
        recoveryAction: "stop intake, inspect the Recovery Checkpoint, and migrate or restore the customer-owned coordinator state before retrying",
        receipt: `storedProtocol=${stored?.protocol ?? "missing"}; configuredProtocol=${PUBLIC_GATEWAY_PROTOCOL}; storedPolicy=${stored?.policy.id ?? "missing"}; configuredPolicy=${this.policy.id}; storedMode=${stored?.policy.mode ?? "missing"}; configuredMode=${this.policy.mode}; storedLimit=${stored?.policy.configuredLimit?.value ?? "none"}; configuredLimit=${this.policy.configuredLimit?.value ?? "none"}; stateTransition=denied`,
      });
    }
    return clone(stored ?? initialState(this.policy, this.now()));
  }

  async open(actor: PublicGatewayAdminActor, receipt: string): Promise<PublicGatewayState> {
    required(actor.id, "actor.id");
    required(receipt, "receipt");
    const state = await this.snapshot();
    if (state.status === "suspended") {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Suspended public intake cannot be reopened as an ordinary open operation.",
        recoveryAction: "use the explicit review-backed reopen operation and record its receipt",
        receipt: `policy=${this.policy.id}; state=suspended; transition=open=denied`,
      });
    }
    const next = this.withAudit({ ...state, status: "open" }, {
      action: "open",
      actorId: actor.id,
      outcome: "completed",
      receipt,
    });
    await this.store.save(next);
    return clone(next);
  }

  async suspend(actor: PublicGatewayAdminActor, reason: string, receipt: string): Promise<PublicGatewayState> {
    required(actor.id, "actor.id");
    required(reason, "reason");
    required(receipt, "receipt");
    const state = await this.snapshot();
    const next = this.withAudit({ ...state, status: "suspended", recoveryCheckpoint: `checkpoint:public-gateway:suspended:${this.now().toISOString()}` }, {
      action: "suspend",
      actorId: actor.id,
      outcome: "completed",
      receipt: `${receipt}; reason=${reason}`,
    });
    await this.store.save(next);
    return clone(next);
  }

  async reopen(actor: PublicGatewayAdminActor, reviewReceipt: string): Promise<PublicGatewayState> {
    required(actor.id, "actor.id");
    required(reviewReceipt, "reviewReceipt");
    const state = await this.snapshot();
    if (state.status !== "suspended") {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Only suspended public intake can be reopened.",
        recoveryAction: "inspect the current gateway state and retry the matching transition",
        receipt: `policy=${this.policy.id}; state=${state.status}; transition=reopen=denied`,
      });
    }
    const next = this.withAudit({ ...state, status: "open", recoveryCheckpoint: `checkpoint:public-gateway:reopened:${this.now().toISOString()}` }, {
      action: "reopen",
      actorId: actor.id,
      outcome: "completed",
      receipt: reviewReceipt,
    });
    await this.store.save(next);
    return clone(next);
  }

  async cleanup(actor: PublicGatewayAdminActor, cleanupReceipt: string): Promise<PublicGatewayState> {
    required(actor.id, "actor.id");
    required(cleanupReceipt, "cleanupReceipt");
    const state = await this.snapshot();
    const next = this.withAudit({
      ...state,
      status: "closed",
      pendingReview: 0,
      recoveryCheckpoint: `checkpoint:public-gateway:cleanup:${this.now().toISOString()}`,
    }, {
      action: "cleanup",
      actorId: actor.id,
      outcome: "completed",
      receipt: `${cleanupReceipt}; disposableResources=closed-only; lineagePreserved=true`,
    });
    await this.store.save(next);
    return clone(next);
  }

  async submit(input: PublicGatewaySubmitInput): Promise<PublicGatewayResult> {
    required(input.requestId, "requestId");
    required(input.actorId, "actorId");
    required(input.contributionId, "contributionId");
    required(input.payloadDigest, "payloadDigest");
    const state = await this.snapshot();
    const existing = findRecord(state, input.requestId);
    if (existing && existing.payloadDigest !== input.payloadDigest) {
      const replay = decision({
        id: `public-gateway-decision:replay:${state.requests + 1}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "denied",
        disposition: "not-materialized",
        requested: state.requests + 1,
        consumed: state.accepted,
        nextAction: "use a new requestId for a new payload, then submit through the normal public Change path",
        receipt: `policy=${this.policy.id}; request=${input.requestId}; replay=true; originalDigest=${existing.payloadDigest}; receivedDigest=${input.payloadDigest}; materialized=false`,
      }, this.policy);
      const next = this.withAudit({ ...state, requests: state.requests + 1, denied: state.denied + 1 }, {
        action: "submit",
        actorId: input.actorId,
        requestId: input.requestId,
        outcome: "denied",
        receipt: replay.receipt,
      });
      await this.store.save(next);
      return { status: "denied", decision: replay, idempotent: false };
    }
    if (existing && !existing.retryable) {
      return { status: existing.decision.status, decision: clone(existing.decision), idempotent: true };
    }

    const requested = state.requests + 1;
    const provider = input.provider ?? { status: "ready" as const, receipt: "provider=customer-gateway; outcome=ready" };
    if (provider.status === "abuse") {
      const denied = decision({
        id: `public-gateway-decision:abuse:${requested}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "denied",
        disposition: "not-materialized",
        requested,
        consumed: state.accepted,
        nextAction: provider.outcome === "challenge"
          ? "complete a fresh provider challenge and retry the same request identity with the same envelope"
          : provider.outcome === "unavailable"
            ? "retry with a fresh provider token after the customer-owned provider recovers"
            : "inspect the provider abuse decision and use the owner-approved recovery path",
        receipt: `policy=${this.policy.id}; request=${input.requestId}; providerOutcome=${provider.outcome}; provider=${provider.receipt}; materialized=false; landingAuthority=false`,
      }, this.policy);
      const next = this.withAudit({
        ...state,
        requests: requested,
        denied: state.denied + 1,
        recoveryCheckpoint: `checkpoint:public-gateway:abuse:${provider.outcome}:${requested}`,
        requestRecords: [...state.requestRecords, this.record(input, denied, provider.retryable)],
      }, {
        action: "submit",
        actorId: input.actorId,
        requestId: input.requestId,
        outcome: "denied",
        receipt: denied.receipt,
      });
      await this.store.save(next);
      return { status: "denied", decision: denied, idempotent: false, providerReceipt: provider.receipt, providerOutcome: provider.outcome };
    }
    if (provider.status === "timeout") {
      const unavailable = decision({
        id: `public-gateway-decision:provider-timeout:${requested}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "denied",
        disposition: "not-materialized",
        requested,
        consumed: state.accepted,
        nextAction: "retain the request envelope, retry the same idempotency key after provider recovery, and inspect the Recovery Checkpoint",
        receipt: `policy=${this.policy.id}; request=${input.requestId}; provider=${provider.receipt}; materialized=false`,
      }, this.policy);
      const next = this.withAudit({
        ...state,
        requests: requested,
        denied: state.denied + 1,
        recoveryCheckpoint: `checkpoint:public-gateway:provider-timeout:${requested}`,
        requestRecords: [...state.requestRecords, { requestId: input.requestId, payloadDigest: input.payloadDigest, contributionId: input.contributionId, decision: unavailable, retryable: true, recordedAt: this.now().toISOString() }],
      }, {
        action: "submit",
        actorId: input.actorId,
        requestId: input.requestId,
        outcome: "denied",
        receipt: unavailable.receipt,
      });
      await this.store.save(next);
      return { status: "denied", decision: unavailable, idempotent: false, providerReceipt: provider.receipt };
    }

    let nextState = state;
    let result: PublicGatewayResult;
    if (state.status === "suspended" || state.status === "closed") {
      const denied = decision({
        id: `public-gateway-decision:state:${requested}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "denied",
        disposition: "not-materialized",
        requested,
        consumed: state.accepted,
        nextAction: state.status === "suspended" ? "wait for owner or moderator review, then use the review-backed reopen operation" : "an owner must explicitly open the destination-Realm public projection",
        receipt: `policy=${this.policy.id}; state=${state.status}; request=${input.requestId}; materialized=false`,
      }, this.policy);
      nextState = { ...state, requests: requested, denied: state.denied + 1, requestRecords: [...state.requestRecords, this.record(input, denied)] };
      result = { status: "denied", decision: denied, idempotent: false, providerReceipt: provider.receipt };
    } else if (this.policy.mode === "approval-only") {
      const pending = decision({
        id: `public-gateway-decision:approval:${requested}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "approval_required",
        disposition: "awaiting-owner-review",
        requested,
        consumed: state.accepted,
        nextAction: "owner or moderator reviews the contribution envelope before it becomes an accepted quarantined Change input",
        receipt: `policy=${this.policy.id}; mode=approval-only; request=${input.requestId}; privateSourceSpace=not-materialized`,
      }, this.policy);
      nextState = { ...state, requests: requested, pendingReview: state.pendingReview + 1, requestRecords: [...state.requestRecords, this.record(input, pending)] };
      result = { status: "approval_required", decision: pending, idempotent: false, providerReceipt: provider.receipt };
    } else {
      const limit = this.policy.configuredLimit;
      if (!limit) {
        throw new PublicGatewayError({
          code: "invalid-state",
          message: "Rate-limited public intake has no measured configured limit and is closed at the gateway.",
          recoveryAction: "measure a healthy workload with a receipt or switch this Project to approval-only mode",
          receipt: `policy=${this.policy.id}; configuredLimit=missing; publicIntake=closed`,
        });
      }
      if (requested > limit.value) {
        const denied = decision({
          id: `public-gateway-decision:limit:${requested}`,
          requestId: input.requestId,
          actorId: input.actorId,
          status: "denied",
          disposition: "not-materialized",
          requested,
          consumed: state.accepted,
          configuredLimit: limit,
          nextAction: "wait for the configured policy window, authenticate for a higher-grant path, or ask the owner to remeasure the tripwire",
          receipt: `policy=${this.policy.id}; limit=${limit.unit}; configured=${limit.value}; requested=${requested}; request=${input.requestId}; materialized=false`,
        }, this.policy);
        nextState = { ...state, requests: requested, denied: state.denied + 1, requestRecords: [...state.requestRecords, this.record(input, denied)] };
        result = { status: "denied", decision: denied, idempotent: false, providerReceipt: provider.receipt };
      } else {
        const accepted = decision({
          id: `public-gateway-decision:accepted:${requested}`,
          requestId: input.requestId,
          actorId: input.actorId,
          status: "accepted",
          disposition: "quarantined",
          requested,
          consumed: state.accepted + 1,
          configuredLimit: limit,
          nextAction: "run disclosure checks and create a Change Revision; Landing remains a separate authorized operation",
          receipt: `policy=${this.policy.id}; request=${input.requestId}; contribution=${input.contributionId}; privateSourceSpace=not-materialized; landingAuthority=false`,
        }, this.policy);
        nextState = {
          ...state,
          requests: requested,
          accepted: state.accepted + 1,
          preservedContributionIds: [...state.preservedContributionIds, input.contributionId],
          requestRecords: [...state.requestRecords, this.record(input, accepted)],
        };
        result = { status: "accepted", decision: accepted, idempotent: false, providerReceipt: provider.receipt };
      }
    }
    nextState = this.withAudit(nextState, {
      action: "submit",
      actorId: input.actorId,
      requestId: input.requestId,
      outcome: result.status === "accepted" ? "accepted" : result.decision.status === "approval_required" ? "approval_required" : "denied",
      receipt: result.decision.receipt,
    });
    await this.store.save(nextState);
    return clone(result);
  }

  private record(input: PublicGatewaySubmitInput, value: PublicIntakeDecision, retryable = false): PublicGatewayRequestRecord {
    return {
      requestId: input.requestId,
      payloadDigest: input.payloadDigest,
      contributionId: input.contributionId,
      decision: value,
      retryable,
      recordedAt: this.now().toISOString(),
    };
  }

  private withAudit(state: PublicGatewayState, event: Omit<PublicGatewayAuditEvent, "id" | "recordedAt">): PublicGatewayState {
    return {
      ...state,
      audit: [...state.audit, { ...event, id: `audit:public-gateway:${state.audit.length + 1}`, recordedAt: this.now().toISOString() }],
    };
  }
}

export type PublicGatewayEdgeLimiter = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export type PublicGatewayEdgeDecision = {
  protocol: typeof PUBLIC_GATEWAY_PROTOCOL;
  status: "allowed" | "denied";
  keyClass: "coarse-edge-abuse";
  configuredLimit: PublicIntakeMeasuredLimit;
  requested: 1;
  nextAction: string;
  receipt: string;
};

export async function applyPublicGatewayEdgeLimit(input: {
  limiter: PublicGatewayEdgeLimiter;
  key: string;
  configuredLimit: PublicIntakeMeasuredLimit;
  requestId: string;
}): Promise<PublicGatewayEdgeDecision> {
  required(input.key, "edgeKey");
  required(input.requestId, "requestId");
  const result = await input.limiter.limit({ key: input.key });
  return {
    protocol: PUBLIC_GATEWAY_PROTOCOL,
    status: result.success ? "allowed" : "denied",
    keyClass: "coarse-edge-abuse",
    configuredLimit: clone(input.configuredLimit),
    requested: 1,
    nextAction: result.success ? "continue to the Durable Object Public Intake ledger" : "wait for the edge window or use the owner-approved recovery path; the request was not materialized",
    receipt: `edgeLimiter=cloudflare-workers-rate-limit; request=${input.requestId}; success=${result.success}; configured=${input.configuredLimit.value}; unit=${input.configuredLimit.unit}; receipt=${input.configuredLimit.receipt}; logicalLedger=authoritative=false`,
  };
}
