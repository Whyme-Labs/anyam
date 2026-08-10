import {
  PUBLIC_INTAKE_PROTOCOL,
  type PublicIntakeActorRole,
  type PublicIntakeDecision,
  type PublicIntakeMeasuredLimit,
  type PublicIntakePolicy,
} from "../disclosure/public-intake.ts";
import { CONTRACT_VERSIONS } from "../kernel/contracts.ts";

export const PUBLIC_GATEWAY_PROTOCOL = CONTRACT_VERSIONS.publicGateway;
export const PUBLIC_GATEWAY_LEDGER_PROTOCOL = CONTRACT_VERSIONS.publicGatewayLedger;
export const PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL = CONTRACT_VERSIONS.publicGatewayReplayArchive;

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
  action: "open" | "submit" | "suspend" | "reopen" | "cleanup" | "ledger-export" | "ledger-compact" | "replay-archive-delete";
  actorId: string;
  requestId?: string;
  outcome: "accepted" | "denied" | "approval_required" | "completed";
  receipt: string;
  recordedAt: string;
};

export type PublicGatewayRequestTombstone = {
  requestId: string;
  payloadDigest: string;
  contributionId: string;
  originalStatus: PublicIntakeDecision["status"];
  /** Whether the denied record was still retryable when compacted. */
  retryable?: boolean;
  recordedAt: string;
  compactedAt: string;
  /** Fixed at compaction from the receipt-backed replay-defense policy. */
  replayDefenseUntil?: string;
  exportDigest: string;
  receipt: string;
};

export type PublicGatewayLedgerMetadata = {
  protocol: typeof PUBLIC_GATEWAY_LEDGER_PROTOCOL;
  generation: number;
  requestTombstones: readonly PublicGatewayRequestTombstone[];
  auditCompactedCount: number;
  archivedTombstoneCount: number;
  replayArchiveDeletedCount: number;
  lastArchive?: {
    protocol: typeof PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL;
    exportDigest: string;
    archivedCount: number;
    createdAt: string;
    receipt: string;
  };
  lastExport?: {
    exportId: string;
    digest: string;
    sourceStateDigest: string;
    createdAt: string;
    requestRecordCount: number;
    auditEventCount: number;
    receipt: string;
  };
  lastArchiveDeletion?: {
    exportId: string;
    exportDigest: string;
    requested: number;
    deleted: number;
    alreadyAbsent: number;
    protectedRetryable: number;
    protectedUnexpired: number;
    protectedLegacy: number;
    createdAt: string;
    receipt: string;
  };
};

export type PublicGatewayReplayArchiveReceipt = {
  protocol: typeof PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL;
  requestId: string;
  digest: string;
  bytes: number;
  key: string;
  idempotent: boolean;
  receipt: string;
};

export type PublicGatewayReplayArchiveCandidate = {
  requestId: string;
  key: string;
  digest: string;
  bytes: number;
  tombstone: PublicGatewayRequestTombstone;
};

export type PublicGatewayReplayArchiveDeletionReceipt = {
  requestId: string;
  key: string;
  digest: string;
  status: "deleted" | "already-absent";
  receipt: string;
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
  ledger: PublicGatewayLedgerMetadata;
  recoveryCheckpoint: string;
};

export type PublicGatewayLedgerRetentionPolicy = {
  protocol: typeof PUBLIC_GATEWAY_LEDGER_PROTOCOL;
  requestRecordLimit: PublicIntakeMeasuredLimit;
  requestTombstoneLimit: PublicIntakeMeasuredLimit;
  auditEventLimit: PublicIntakeMeasuredLimit;
  retryableRetentionMs: PublicIntakeMeasuredLimit;
  terminalDenialRetentionMs: PublicIntakeMeasuredLimit;
  retryableReplayWindowMs: PublicIntakeMeasuredLimit;
  terminalDenialReplayWindowMs: PublicIntakeMeasuredLimit;
  receipt: string;
};

export type PublicGatewayLedgerExport = {
  protocol: typeof PUBLIC_GATEWAY_LEDGER_PROTOCOL;
  exportId: string;
  gatewayProtocol: typeof PUBLIC_GATEWAY_PROTOCOL;
  policyId: string;
  createdAt: string;
  sourceGeneration: number;
  sourceStateDigest: string;
  state: PublicGatewayState;
  digest: string;
  receipt: string;
};

export type PublicGatewayLedgerCompactionResult = {
  protocol: typeof PUBLIC_GATEWAY_LEDGER_PROTOCOL;
  status: "compacted";
  exportId: string;
  exportDigest: string;
  before: { requestRecords: number; requestTombstones: number; auditEvents: number };
  after: { requestRecords: number; requestTombstones: number; auditEvents: number };
  compacted: { requestRecords: number; auditEvents: number };
  recoveryCheckpoint: string;
  receipt: string;
};

export type PublicGatewayReplayArchiveDeletionResult = {
  protocol: typeof PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL;
  status: "deleted" | "nothing-eligible";
  exportId: string;
  exportDigest: string;
  requested: number;
  deleted: number;
  alreadyAbsent: number;
  protectedRetryable: number;
  protectedUnexpired: number;
  protectedLegacy: number;
  recoveryCheckpoint: string;
  receipt: string;
};

export type PublicGatewayStore = {
  load(): Promise<PublicGatewayState | undefined>;
  save(state: PublicGatewayState): Promise<void>;
  saveLedgerExport?(bundle: PublicGatewayLedgerExport): Promise<void>;
  loadLedgerExport?(exportId: string): Promise<PublicGatewayLedgerExport | undefined>;
  archiveReplayTombstone?(tombstone: PublicGatewayRequestTombstone): Promise<PublicGatewayReplayArchiveReceipt>;
  loadReplayTombstone?(requestId: string): Promise<PublicGatewayRequestTombstone | undefined>;
  listReplayTombstones?(): Promise<readonly PublicGatewayReplayArchiveCandidate[]>;
  deleteReplayTombstone?(input: { requestId: string; expectedDigest: string }): Promise<PublicGatewayReplayArchiveDeletionReceipt>;
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
  readonly code: "invalid-request" | "invalid-state" | "provider-unavailable" | "budget-exceeded";
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly budget: PublicGatewayBudgetReceipt | undefined;

  constructor(input: {
    code: PublicGatewayError["code"];
    message: string;
    recoveryAction: string;
    receipt: string;
    budget?: PublicGatewayBudgetReceipt;
  }) {
    super(input.message);
    this.name = "PublicGatewayError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
    this.budget = input.budget;
  }

  toJSON(): Record<string, unknown> {
    return {
      protocol: PUBLIC_GATEWAY_PROTOCOL,
      code: this.code,
      message: this.message,
      recoveryAction: this.recoveryAction,
      receipt: this.receipt,
      ...(this.budget ? { budget: this.budget } : {}),
    };
  }
}

export type PublicGatewayBudgetReceipt = {
  name: string;
  limit: PublicIntakeMeasuredLimit;
  asked: number;
  receipt: string;
};

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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const webCrypto = (globalThis as unknown as { crypto?: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto;
  if (!webCrypto) throw new Error("Web Crypto is unavailable for the Public Gateway ledger export");
  const hash = await webCrypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function measuredLimit(value: unknown, field: string): PublicIntakeMeasuredLimit {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: `${field} must be a measured limit object.`,
      recoveryAction: `provide ${field} with value, unit, measuredAt, method, and receipt`,
      receipt: `field=${field}; measuredLimit=missing`,
    });
  }
  const candidate = value as Record<string, unknown>;
  const numberValue = candidate.value as number | undefined;
  const unit = candidate.unit;
  const measuredAt = candidate.measuredAt;
  const method = candidate.method;
  const receipt = candidate.receipt;
  if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue) || numberValue < 1 || typeof unit !== "string" || unit.trim().length === 0 || typeof measuredAt !== "string" || measuredAt.trim().length === 0 || typeof method !== "string" || method.trim().length === 0 || typeof receipt !== "string" || receipt.trim().length === 0) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: `${field} is missing a positive measured value or receipt.`,
      recoveryAction: `remeasure ${field} and provide value, unit, measuredAt, method, and receipt`,
      receipt: `field=${field}; measuredLimit=invalid`,
    });
  }
  return { value: numberValue, unit: unit as string, measuredAt: measuredAt as string, method: method as string, receipt: receipt as string };
}

export function parsePublicGatewayLedgerRetentionPolicy(value: unknown): PublicGatewayLedgerRetentionPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: "Public Gateway ledger retention requires a measured policy object.",
      recoveryAction: "provide request-record, replay-tombstone, audit, retryable-age, terminal-denial-age, retryable-replay-window, and terminal-denial-replay-window receipts",
      receipt: "ledgerRetention=missing",
    });
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.protocol !== PUBLIC_GATEWAY_LEDGER_PROTOCOL) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: "Public Gateway ledger retention uses an unsupported protocol.",
      recoveryAction: `use ${PUBLIC_GATEWAY_LEDGER_PROTOCOL}`,
      receipt: `ledgerRetentionProtocol=${String(candidate.protocol ?? "missing")}; expected=${PUBLIC_GATEWAY_LEDGER_PROTOCOL}`,
    });
  }
  const receipt = candidate.receipt;
  if (typeof receipt !== "string" || receipt.trim().length === 0) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: "Public Gateway ledger retention requires an operator receipt.",
      recoveryAction: "record the workload measurement and include its retention-policy receipt",
      receipt: "ledgerRetentionReceipt=missing",
    });
  }
  const retryableRetentionMs = measuredLimit(candidate.retryableRetentionMs, "retryableRetentionMs");
  const terminalDenialRetentionMs = measuredLimit(candidate.terminalDenialRetentionMs, "terminalDenialRetentionMs");
  const retryableReplayWindowMs = measuredLimit(candidate.retryableReplayWindowMs, "retryableReplayWindowMs");
  const terminalDenialReplayWindowMs = measuredLimit(candidate.terminalDenialReplayWindowMs, "terminalDenialReplayWindowMs");
  if ([retryableRetentionMs, terminalDenialRetentionMs, retryableReplayWindowMs, terminalDenialReplayWindowMs].some((limit) => limit.unit !== "milliseconds")) {
    throw new PublicGatewayError({
      code: "invalid-request",
      message: "Ledger age and replay-defense limits must use milliseconds as their unit.",
      recoveryAction: "remeasure retryableRetentionMs, terminalDenialRetentionMs, retryableReplayWindowMs, and terminalDenialReplayWindowMs with unit=milliseconds",
      receipt: `retryableUnit=${retryableRetentionMs.unit}; terminalDenialUnit=${terminalDenialRetentionMs.unit}; retryableReplayUnit=${retryableReplayWindowMs.unit}; terminalReplayUnit=${terminalDenialReplayWindowMs.unit}; expectedUnit=milliseconds`,
    });
  }
  return {
    protocol: PUBLIC_GATEWAY_LEDGER_PROTOCOL,
    requestRecordLimit: measuredLimit(candidate.requestRecordLimit, "requestRecordLimit"),
    requestTombstoneLimit: measuredLimit(candidate.requestTombstoneLimit, "requestTombstoneLimit"),
    auditEventLimit: measuredLimit(candidate.auditEventLimit, "auditEventLimit"),
    retryableRetentionMs,
    terminalDenialRetentionMs,
    retryableReplayWindowMs,
    terminalDenialReplayWindowMs,
    receipt,
  };
}

function defaultLedgerMetadata(): PublicGatewayLedgerMetadata {
  return {
    protocol: PUBLIC_GATEWAY_LEDGER_PROTOCOL,
    generation: 0,
    requestTombstones: [],
    auditCompactedCount: 0,
    archivedTombstoneCount: 0,
    replayArchiveDeletedCount: 0,
  };
}

function normalizeState(state: PublicGatewayState): PublicGatewayState {
  const ledger = state.ledger && state.ledger.protocol === PUBLIC_GATEWAY_LEDGER_PROTOCOL
    ? state.ledger
    : defaultLedgerMetadata();
  return clone({
    ...state,
    ledger: {
      ...defaultLedgerMetadata(),
      ...ledger,
      requestTombstones: ledger.requestTombstones ?? [],
      auditCompactedCount: ledger.auditCompactedCount ?? 0,
      archivedTombstoneCount: ledger.archivedTombstoneCount ?? 0,
      replayArchiveDeletedCount: ledger.replayArchiveDeletedCount ?? 0,
    },
  });
}

function stateForDigest(state: PublicGatewayState): PublicGatewayState {
  const normalized = normalizeState(state);
  const copy = clone(normalized);
  delete copy.ledger.lastExport;
  copy.ledger.generation = 0;
  return copy;
}

function budgetFailure(name: string, limit: PublicIntakeMeasuredLimit, asked: number, receipt: string, recoveryAction: string): never {
  const budget: PublicGatewayBudgetReceipt = { name, limit: clone(limit), asked, receipt };
  throw new PublicGatewayError({
    code: "budget-exceeded",
    message: `Public Gateway ledger budget exceeded; budget=${name}; limit=${limit.value} ${limit.unit}; asked=${asked}; receipt=${receipt}; fix=${recoveryAction}.`,
    recoveryAction,
    receipt: `budget=${name}; limit=${limit.value}; unit=${limit.unit}; asked=${asked}; receipt=${receipt}`,
    budget,
  });
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
    ledger: defaultLedgerMetadata(),
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

function findTombstone(state: PublicGatewayState, requestId: string): PublicGatewayRequestTombstone | undefined {
  return [...state.ledger.requestTombstones].reverse().find((tombstone) => tombstone.requestId === requestId);
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
    return normalizeState(stored ?? initialState(this.policy, this.now()));
  }

  private async saveState(state: PublicGatewayState): Promise<void> {
    const current = await this.store.load();
    const normalized = normalizeState(state);
    await this.store.save({
      ...normalized,
      ledger: {
        ...normalized.ledger,
        generation: Math.max(normalized.ledger.generation, current ? normalizeState(current).ledger.generation : 0) + 1,
      },
    });
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
    await this.saveState(next);
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
    await this.saveState(next);
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
    await this.saveState(next);
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
    await this.saveState(next);
    return clone(next);
  }

  async submit(input: PublicGatewaySubmitInput): Promise<PublicGatewayResult> {
    required(input.requestId, "requestId");
    required(input.actorId, "actorId");
    required(input.contributionId, "contributionId");
    required(input.payloadDigest, "payloadDigest");
    const state = await this.snapshot();
    const existing = findRecord(state, input.requestId);
    let tombstone = existing ? undefined : findTombstone(state, input.requestId);
    if (!existing && !tombstone && this.store.loadReplayTombstone) {
      try {
        tombstone = await this.store.loadReplayTombstone(input.requestId);
      } catch (error) {
        throw new PublicGatewayError({
          code: "provider-unavailable",
          message: "The Public Gateway replay archive could not be verified; the request was not materialized.",
          recoveryAction: "restore the customer-owned replay archive or retry after its provider recovers; no new request identity was accepted",
          receipt: `replayArchive=lookup-failed; request=${input.requestId}; materialized=false; cause=${error instanceof Error ? error.name : "unknown"}`,
        });
      }
    }
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
      await this.saveState(next);
      return { status: "denied", decision: replay, idempotent: false };
    }
    if (tombstone && tombstone.payloadDigest !== input.payloadDigest) {
      const replay = decision({
        id: `public-gateway-decision:compacted-replay:${state.requests + 1}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "denied",
        disposition: "not-materialized",
        requested: state.requests + 1,
        consumed: state.accepted,
        nextAction: "use a new requestId for a new payload; the original request identity is retained in the compacted replay index",
        receipt: `policy=${this.policy.id}; request=${input.requestId}; replay=true; compacted=true; originalDigest=${tombstone.payloadDigest}; receivedDigest=${input.payloadDigest}; materialized=false`,
      }, this.policy);
      const next = this.withAudit({ ...state, requests: state.requests + 1, denied: state.denied + 1 }, {
        action: "submit",
        actorId: input.actorId,
        requestId: input.requestId,
        outcome: "denied",
        receipt: replay.receipt,
      });
      await this.saveState(next);
      return { status: "denied", decision: replay, idempotent: false };
    }
    if (existing && !existing.retryable) {
      return { status: existing.decision.status, decision: clone(existing.decision), idempotent: true };
    }
    if (tombstone) {
      const compacted = decision({
        id: `public-gateway-decision:compacted:${state.requests}`,
        requestId: input.requestId,
        actorId: input.actorId,
        status: "denied",
        disposition: "not-materialized",
        requested: state.requests,
        consumed: state.accepted,
        nextAction: "use a new requestId; the original request identity is retained as a compacted terminal denial",
        receipt: `policy=${this.policy.id}; request=${input.requestId}; compacted=true; originalStatus=${tombstone.originalStatus}; export=${tombstone.exportDigest}; materialized=false`,
      }, this.policy);
      return { status: "denied", decision: compacted, idempotent: true };
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
      await this.saveState(next);
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
      await this.saveState(next);
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
    await this.saveState(nextState);
    return clone(result);
  }

  async exportLedger(input: { actorId: string; exportId: string; receipt: string }): Promise<PublicGatewayLedgerExport> {
    required(input.actorId, "actorId");
    required(input.exportId, "exportId");
    required(input.receipt, "receipt");
    if (!this.store.saveLedgerExport) {
      throw new PublicGatewayError({
        code: "provider-unavailable",
        message: "The customer-owned Public Gateway store cannot persist a recovery export.",
        recoveryAction: "bind a durable ledger-export object store before compacting the Public Gateway ledger",
        receipt: "ledgerExportStore=missing; compaction=false",
      });
    }
    const state = await this.snapshot();
    if (this.store.loadLedgerExport) {
      const existing = await this.store.loadLedgerExport(input.exportId);
      if (existing) {
        const currentDigest = await digest(stateForDigest(state));
        if (existing.sourceStateDigest === currentDigest) return clone(existing);
        throw new PublicGatewayError({
          code: "invalid-state",
          message: "The requested Public Gateway exportId already names a different ledger state.",
          recoveryAction: "choose a new exportId for the current state; existing recovery exports are immutable",
          receipt: `exportId=${input.exportId}; existingDigest=${existing.digest}; currentStateDigest=${currentDigest}; export=false`,
        });
      }
    }
    const createdAt = this.now().toISOString();
    const exportedState = normalizeState(this.withAudit(state, {
      action: "ledger-export",
      actorId: input.actorId,
      outcome: "completed",
      receipt: `${input.receipt}; exportId=${input.exportId}; lineagePreserved=true`,
    }));
    const sourceStateDigest = await digest(stateForDigest(exportedState));
    const unsigned: Omit<PublicGatewayLedgerExport, "digest"> = {
      protocol: PUBLIC_GATEWAY_LEDGER_PROTOCOL,
      exportId: input.exportId,
      gatewayProtocol: PUBLIC_GATEWAY_PROTOCOL,
      policyId: this.policy.id,
      createdAt,
      sourceGeneration: state.ledger.generation,
      sourceStateDigest,
      state: exportedState,
      receipt: `ledgerExport=${PUBLIC_GATEWAY_LEDGER_PROTOCOL}; exportId=${input.exportId}; sourceGeneration=${state.ledger.generation}; requestRecords=${state.requestRecords.length}; auditEvents=${state.audit.length}; lineagePreserved=true`,
    };
    const bundle: PublicGatewayLedgerExport = { ...unsigned, digest: await digest(unsigned) };
    await this.store.saveLedgerExport(clone(bundle));
    const next = {
      ...exportedState,
      ledger: {
        ...exportedState.ledger,
        lastExport: {
          exportId: bundle.exportId,
          digest: bundle.digest,
          sourceStateDigest: bundle.sourceStateDigest,
          createdAt: bundle.createdAt,
          requestRecordCount: state.requestRecords.length,
          auditEventCount: exportedState.audit.length,
          receipt: bundle.receipt,
        },
      },
    };
    await this.saveState(next);
    return clone(bundle);
  }

  async compactLedger(input: { actorId: string; exportId: string; policy: PublicGatewayLedgerRetentionPolicy; receipt: string }): Promise<PublicGatewayLedgerCompactionResult> {
    required(input.actorId, "actorId");
    required(input.exportId, "exportId");
    required(input.receipt, "receipt");
    const retention = parsePublicGatewayLedgerRetentionPolicy(input.policy);
    if (!this.store.loadLedgerExport) {
      throw new PublicGatewayError({
        code: "provider-unavailable",
        message: "The customer-owned Public Gateway store cannot load a recovery export for compaction.",
        recoveryAction: "bind the durable ledger-export object store and retry export-before-compaction",
        receipt: "ledgerExportStore=missing; compaction=false",
      });
    }
    const state = await this.snapshot();
    const bundle = await this.store.loadLedgerExport(input.exportId);
    if (!bundle) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Public Gateway ledger compaction requires a persisted export for the current ledger.",
        recoveryAction: "export the current ledger, verify its digest, then retry compaction with that exportId",
        receipt: `exportId=${input.exportId}; exportFound=false; compaction=false`,
      });
    }
    const { digest: recordedDigest, ...unsignedBundle } = bundle;
    const calculatedDigest = await digest(unsignedBundle);
    if (recordedDigest !== calculatedDigest) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "The persisted Public Gateway ledger export failed digest verification; no records were compacted.",
        recoveryAction: "restore a verified export object and retry from a new export-before-compaction checkpoint",
        receipt: `exportId=${input.exportId}; recordedDigest=${recordedDigest}; calculatedDigest=${calculatedDigest}; compaction=false`,
      });
    }
    const currentDigest = await digest(stateForDigest(state));
    if (bundle.sourceStateDigest !== currentDigest) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "The requested Public Gateway ledger export is stale; no records were compacted.",
        recoveryAction: "export the current ledger again and retry compaction from the new Recovery Checkpoint",
        receipt: `exportId=${input.exportId}; expectedStateDigest=${bundle.sourceStateDigest}; currentStateDigest=${currentDigest}; compaction=false`,
      });
    }
    if (bundle.gatewayProtocol !== PUBLIC_GATEWAY_PROTOCOL || bundle.policyId !== this.policy.id || bundle.protocol !== PUBLIC_GATEWAY_LEDGER_PROTOCOL) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "The requested Public Gateway ledger export does not match this coordinator.",
        recoveryAction: "use an export produced by this Project Gateway and retry without changing the policy identity",
        receipt: `exportId=${input.exportId}; gatewayProtocol=${bundle.gatewayProtocol}; policyId=${bundle.policyId}; compaction=false`,
      });
    }

    const now = this.now();
    const nowMs = now.getTime();
    const eligible: PublicGatewayRequestRecord[] = [];
    const retained: PublicGatewayRequestRecord[] = [];
    for (const record of state.requestRecords) {
      const recordedMs = Date.parse(record.recordedAt);
      if (!Number.isFinite(recordedMs)) {
        throw new PublicGatewayError({
          code: "invalid-state",
          message: "Public Gateway ledger compaction found a request record with an invalid timestamp.",
          recoveryAction: "stop compaction, restore the exported ledger, and repair the timestamp through a reviewed migration",
          receipt: `requestId=${record.requestId}; recordedAt=invalid; compaction=false`,
        });
      }
      const ageMs = Math.max(0, nowMs - recordedMs);
      const retentionMs = record.retryable ? retention.retryableRetentionMs.value : retention.terminalDenialRetentionMs.value;
      const compactable = record.decision.status === "denied" && ageMs >= retentionMs;
      (compactable ? eligible : retained).push(record);
    }

    const newTombstones = eligible.map((record): PublicGatewayRequestTombstone => {
      const replayWindowMs = record.retryable ? retention.retryableReplayWindowMs.value : retention.terminalDenialReplayWindowMs.value;
      // The replay-defense clock starts when the exact tombstone is
      // materialized, not when the request first arrived. This prevents a
      // long local-retention period from silently consuming the archive's
      // protection window before the provider projection exists.
      const replayDefenseUntilMs = nowMs + replayWindowMs;
      if (!Number.isFinite(replayDefenseUntilMs)) {
        throw new PublicGatewayError({
          code: "invalid-state",
          message: "Public Gateway compaction could not derive a replay-defense expiry for a denied record.",
          recoveryAction: "retain the exported ledger and repair the measured replay-window or record timestamp through a reviewed migration",
          receipt: `requestId=${record.requestId}; replayDefenseUntil=invalid; replayIndex=not-written`,
        });
      }
      const replayDefenseUntilDate = new Date(replayDefenseUntilMs);
      if (!Number.isFinite(replayDefenseUntilDate.getTime())) {
        throw new PublicGatewayError({
          code: "invalid-state",
          message: "Public Gateway compaction produced an unrepresentable replay-defense expiry.",
          recoveryAction: "retain the exported ledger and remeasure the replay window or repair the record timestamp through a reviewed migration",
          receipt: `requestId=${record.requestId}; replayDefenseUntil=unrepresentable; replayIndex=not-written`,
        });
      }
      const replayDefenseUntil = replayDefenseUntilDate.toISOString();
      return {
        requestId: record.requestId,
        payloadDigest: record.payloadDigest,
        contributionId: record.contributionId,
        originalStatus: record.decision.status,
        retryable: record.retryable,
        recordedAt: record.recordedAt,
        compactedAt: now.toISOString(),
        replayDefenseUntil,
        exportDigest: bundle.digest,
        receipt: `ledger=${PUBLIC_GATEWAY_LEDGER_PROTOCOL}; retentionClass=${record.retryable ? "retryable-window" : "terminal-denial"}; requestId=${record.requestId}; export=${bundle.digest}; replayDefenseUntil=${replayDefenseUntil}; replayIndex=retained`,
      };
    });
    const tombstones = [...state.ledger.requestTombstones, ...newTombstones];
    let retainedTombstones = tombstones;
    let archivedTombstones: PublicGatewayReplayArchiveReceipt[] = [];
    if (tombstones.length > retention.requestTombstoneLimit.value) {
      if (!this.store.archiveReplayTombstone || !this.store.loadReplayTombstone) {
        budgetFailure("public-gateway-request-tombstones", retention.requestTombstoneLimit, tombstones.length, retention.requestTombstoneLimit.receipt, "bind a customer-owned exact replay archive or raise/remeasure the local replay-index tripwire before accepting more public intake");
      }
      try {
        archivedTombstones = [];
        for (const tombstone of tombstones) archivedTombstones.push(await this.store.archiveReplayTombstone(tombstone));
      } catch (error) {
        throw new PublicGatewayError({
          code: "provider-unavailable",
          message: "The Public Gateway replay archive could not durably store every exact tombstone; no coordinator state was compacted.",
          recoveryAction: "retry export-before-compaction after the customer-owned replay archive recovers; already-written immutable objects are safe to replay",
          receipt: `replayArchive=write-failed; exportId=${input.exportId}; tombstones=${tombstones.length}; materialized=false; cause=${error instanceof Error ? error.name : "unknown"}`,
        });
      }
      retainedTombstones = [];
    }
    if (retained.length > retention.requestRecordLimit.value) {
      budgetFailure("public-gateway-request-records", retention.requestRecordLimit, retained.length, retention.requestRecordLimit.receipt, "retain the exported ledger and remeasure the detailed-record tripwire; accepted or pending lineage is never deleted");
    }

    const controlAudit = state.audit.filter((event) => event.action !== "submit");
    const submitAudit = state.audit.filter((event) => event.action === "submit");
    if (controlAudit.length + 1 > retention.auditEventLimit.value) {
      budgetFailure("public-gateway-control-audit-events", retention.auditEventLimit, controlAudit.length + 1, retention.auditEventLimit.receipt, "retain the exported ledger and remeasure the audit tripwire; moderation and recovery decisions are never deleted");
    }
    const submitSlots = retention.auditEventLimit.value - controlAudit.length - 1;
    const retainedSubmitAudit = submitSlots > 0 ? submitAudit.slice(-submitSlots) : [];
    const audit = [...controlAudit, ...retainedSubmitAudit];
    const compactedAuditEvents = state.ledger.auditCompactedCount + (submitAudit.length - retainedSubmitAudit.length);
    const compactedAt = now.toISOString();
    const next = this.withAudit({
      ...state,
      requestRecords: retained,
      audit,
      recoveryCheckpoint: `checkpoint:public-gateway:${archivedTombstones.length > 0 ? "ledger-archived" : "ledger-compacted"}:${state.ledger.generation + 1}`,
      ledger: {
        ...state.ledger,
        requestTombstones: retainedTombstones,
        auditCompactedCount: compactedAuditEvents,
        archivedTombstoneCount: state.ledger.archivedTombstoneCount + archivedTombstones.length,
        ...(archivedTombstones.length > 0 ? {
          lastArchive: {
            protocol: PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL,
            exportDigest: bundle.digest,
            archivedCount: archivedTombstones.length,
            createdAt: compactedAt,
            receipt: `replayArchive=${PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL}; export=${bundle.digest}; archived=${archivedTombstones.length}; exact=true; providerAuthority=false`,
          },
        } : {}),
      },
    }, {
      action: "ledger-compact",
      actorId: input.actorId,
      outcome: "completed",
      receipt: `${input.receipt}; exportId=${input.exportId}; exportDigest=${bundle.digest}; requestRecordsCompacted=${eligible.length}; auditEventsCompacted=${submitAudit.length - retainedSubmitAudit.length}; replayIndex=retained`,
    });
    await this.saveState(next);
    return {
      protocol: PUBLIC_GATEWAY_LEDGER_PROTOCOL,
      status: "compacted",
      exportId: input.exportId,
      exportDigest: bundle.digest,
      before: { requestRecords: state.requestRecords.length, requestTombstones: state.ledger.requestTombstones.length, auditEvents: state.audit.length },
      after: { requestRecords: retained.length, requestTombstones: retainedTombstones.length, auditEvents: next.audit.length },
      compacted: { requestRecords: eligible.length, auditEvents: submitAudit.length - retainedSubmitAudit.length },
      recoveryCheckpoint: next.recoveryCheckpoint,
      receipt: `ledger=${PUBLIC_GATEWAY_LEDGER_PROTOCOL}; export=${bundle.digest}; compactedAt=${compactedAt}; acceptedLineage=preserved; replayIndex=${archivedTombstones.length > 0 ? "archived-exact" : "retained"}; archived=${archivedTombstones.length}; canonicalProjectMutation=false`,
    };
  }

  /**
   * Owner-authorized maintenance operation for the explicit retention policy.
   * It never deletes accepted/pending lineage or audit/recovery state. Only
   * terminal-denial replay objects with a recorded, expired replay-defense
   * boundary are eligible; retryable or legacy objects remain protected.
   */
  async deleteExpiredReplayArchive(input: {
    actor: PublicGatewayAdminActor;
    exportId: string;
    legalHold: "clear" | "active";
    authorizationReceipt: string;
    holdReceipt: string;
    receipt: string;
  }): Promise<PublicGatewayReplayArchiveDeletionResult> {
    required(input.actor.id, "actor.id");
    required(input.exportId, "exportId");
    required(input.authorizationReceipt, "authorizationReceipt");
    required(input.holdReceipt, "holdReceipt");
    required(input.receipt, "receipt");
    if (input.actor.role !== "owner") {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Replay archive deletion requires an owner-authorized maintenance operation.",
        recoveryAction: "authenticate the customer-owned Realm owner and retry with an owner-scoped archive-maintenance capability",
        receipt: `actor=${input.actor.id}; role=${input.actor.role}; replayArchiveDeletion=denied; mutation=false`,
      });
    }
    if (input.legalHold !== "clear") {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Replay archive deletion is blocked while a legal or recovery hold is active.",
        recoveryAction: "clear the applicable hold through the customer governance process, create a fresh verified export, then retry",
        receipt: `exportId=${input.exportId}; legalHold=${input.legalHold}; deleted=0; mutation=false`,
      });
    }
    if (!this.store.loadLedgerExport || !this.store.listReplayTombstones || !this.store.deleteReplayTombstone) {
      throw new PublicGatewayError({
        code: "provider-unavailable",
        message: "The customer-owned replay archive does not expose the maintenance operations required for safe deletion.",
        recoveryAction: "bind owner-only list and digest-checked delete operations, then retry without changing the export identity",
        receipt: `exportId=${input.exportId}; replayArchiveMaintenance=missing; deleted=0`,
      });
    }
    const state = await this.snapshot();
    const lastExport = state.ledger.lastExport;
    if (!lastExport || lastExport.exportId !== input.exportId) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "Replay archive deletion requires the latest verified coordinator export.",
        recoveryAction: "export the current coordinator ledger, verify its digest, and retry with that exportId",
        receipt: `exportId=${input.exportId}; latestExport=${lastExport?.exportId ?? "missing"}; deleted=0`,
      });
    }
    const bundle = await this.store.loadLedgerExport(input.exportId);
    if (!bundle) {
      throw new PublicGatewayError({
        code: "provider-unavailable",
        message: "The verified coordinator export required for replay archive deletion is unavailable.",
        recoveryAction: "restore the customer-owned export object and retry the same owner-authorized operation",
        receipt: `exportId=${input.exportId}; exportFound=false; deleted=0`,
      });
    }
    const { digest: recordedDigest, ...unsignedBundle } = bundle;
    const calculatedDigest = await digest(unsignedBundle);
    if (recordedDigest !== calculatedDigest || recordedDigest !== lastExport.digest) {
      throw new PublicGatewayError({
        code: "invalid-state",
        message: "The coordinator export for replay archive deletion failed digest verification.",
        recoveryAction: "restore a verified export and retry without deleting any archive object",
        receipt: `exportId=${input.exportId}; recordedDigest=${recordedDigest}; calculatedDigest=${calculatedDigest}; expectedDigest=${lastExport.digest}; deleted=0`,
      });
    }

    let candidates: readonly PublicGatewayReplayArchiveCandidate[];
    try {
      candidates = await this.store.listReplayTombstones();
    } catch (error) {
      throw new PublicGatewayError({
        code: "provider-unavailable",
        message: "The replay archive could not be enumerated for owner-authorized deletion.",
        recoveryAction: "restore the customer-owned replay archive and retry the same export-bound deletion operation",
        receipt: `exportId=${input.exportId}; archiveList=false; deleted=0; cause=${error instanceof Error ? error.name : "unknown"}`,
      });
    }

    const nowMs = this.now().getTime();
    const eligible: PublicGatewayReplayArchiveCandidate[] = [];
    let protectedRetryable = 0;
    let protectedUnexpired = 0;
    let protectedLegacy = 0;
    for (const candidate of candidates) {
      const tombstone = candidate.tombstone;
      if (tombstone.originalStatus !== "denied") {
        throw new PublicGatewayError({
          code: "invalid-state",
          message: "The replay archive contains a non-denial object in the deletion scope.",
          recoveryAction: "quarantine the object, restore a verified terminal-denial projection, and retry without deleting archive data",
          receipt: `exportId=${input.exportId}; requestId=${candidate.requestId}; originalStatus=${tombstone.originalStatus}; deleted=0`,
        });
      }
      if (tombstone.retryable === undefined || !tombstone.replayDefenseUntil) {
        protectedLegacy += 1;
        continue;
      }
      if (tombstone.retryable) {
        protectedRetryable += 1;
        continue;
      }
      const replayDefenseUntilMs = Date.parse(tombstone.replayDefenseUntil);
      if (!Number.isFinite(replayDefenseUntilMs)) {
        protectedLegacy += 1;
      } else if (nowMs < replayDefenseUntilMs) {
        protectedUnexpired += 1;
      } else {
        eligible.push(candidate);
      }
    }

    let deleted = 0;
    let alreadyAbsent = 0;
    try {
      for (const candidate of eligible) {
        const result = await this.store.deleteReplayTombstone({ requestId: candidate.requestId, expectedDigest: candidate.digest });
        if (result.status === "deleted") deleted += 1;
        else alreadyAbsent += 1;
      }
    } catch (error) {
      throw new PublicGatewayError({
        code: "provider-unavailable",
        message: "Replay archive deletion stopped after a provider or integrity failure; remaining objects are retained for retry.",
        recoveryAction: "inspect the owner-visible deletion receipt, restore the archive if needed, and retry the same export-bound operation; already-deleted objects are idempotent",
        receipt: `exportId=${input.exportId}; requested=${eligible.length}; deleted=${deleted}; alreadyAbsent=${alreadyAbsent}; protectedRetryable=${protectedRetryable}; protectedUnexpired=${protectedUnexpired}; protectedLegacy=${protectedLegacy}; mutation=partial; cause=${error instanceof Error ? error.name : "unknown"}`,
      });
    }

    const createdAt = this.now().toISOString();
    const status = eligible.length === 0 ? "nothing-eligible" : "deleted";
    const deletionReceipt = `replayArchive=${PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL}; exportId=${input.exportId}; exportDigest=${bundle.digest}; requested=${eligible.length}; deleted=${deleted}; alreadyAbsent=${alreadyAbsent}; protectedRetryable=${protectedRetryable}; protectedUnexpired=${protectedUnexpired}; protectedLegacy=${protectedLegacy}; legalHold=clear; lineagePreserved=true; auditPreserved=true; ownerAuthorization=${input.authorizationReceipt}; hold=${input.holdReceipt}; ${input.receipt}`;
    const next = this.withAudit({
      ...state,
      recoveryCheckpoint: `checkpoint:public-gateway:replay-archive-delete:${state.ledger.generation + 1}`,
      ledger: {
        ...state.ledger,
        replayArchiveDeletedCount: state.ledger.replayArchiveDeletedCount + deleted + alreadyAbsent,
        lastArchiveDeletion: {
          exportId: input.exportId,
          exportDigest: bundle.digest,
          requested: eligible.length,
          deleted,
          alreadyAbsent,
          protectedRetryable,
          protectedUnexpired,
          protectedLegacy,
          createdAt,
          receipt: deletionReceipt,
        },
      },
    }, {
      action: "replay-archive-delete",
      actorId: input.actor.id,
      outcome: "completed",
      receipt: deletionReceipt,
    });
    await this.saveState(next);
    return {
      protocol: PUBLIC_GATEWAY_REPLAY_ARCHIVE_PROTOCOL,
      status,
      exportId: input.exportId,
      exportDigest: bundle.digest,
      requested: eligible.length,
      deleted,
      alreadyAbsent,
      protectedRetryable,
      protectedUnexpired,
      protectedLegacy,
      recoveryCheckpoint: next.recoveryCheckpoint,
      receipt: deletionReceipt,
    };
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
