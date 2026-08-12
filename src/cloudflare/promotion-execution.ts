import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  type ActorRef,
  type Artifact,
  type Evidence,
  type Project,
  type Release,
  type Target,
  type TargetState,
} from "../kernel/contracts.ts";
import type {
  AuthorityPlaneSnapshot,
  AuthoritySession,
} from "./authority-plane.ts";
import type {
  PromotionReconciliationCheckpoint,
  PromotionRecord,
} from "../delivery/promotion.ts";

/**
 * The internal handoff is deliberately separate from promotion.request. A
 * request records owner intent; an execution invokes a provider capability
 * selected by the trusted coordinator and then validates the returned result
 * before mutating Anyam-owned Target state.
 */
export const PROMOTION_EXECUTION_PROTOCOL = CONTRACT_VERSIONS.promotionExecution;

export type PromotionExecutionStatus = "succeeded" | "blocked" | "indeterminate";

export type PromotionExecutionContext = {
  protocol: typeof PROMOTION_EXECUTION_PROTOCOL;
  realmId: string;
  stateVersion: number;
  project: Project;
  promotion: PromotionRecord;
  release: Release;
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
  target: Target;
  expectedCurrentReleaseId: string | null;
  executionIdempotencyKey: string;
  actor: ActorRef;
  /** Digest over the exact Authority records supplied to the provider. */
  executionDigest: string;
};

export type PromotionExecutionResult = {
  protocol: typeof PROMOTION_EXECUTION_PROTOCOL;
  status: PromotionExecutionStatus;
  adapterId: string;
  executionDigest: string;
  promotion: PromotionRecord;
  target: {
    id: string;
    projectId: string;
    state: TargetState;
    currentReleaseId: string | null;
    releaseHistory: readonly string[];
  };
  checkpoint?: PromotionReconciliationCheckpoint;
  receipt: string;
  recoveryAction?: string;
};

export type TrustedPromotionExecutor = {
  execute(input: Readonly<PromotionExecutionContext>): Promise<PromotionExecutionResult>;
};

export type PromotionExecutionRequest = {
  promotionId: string;
  executionIdempotencyKey: string;
  expectedVersion?: number;
  executor: TrustedPromotionExecutor;
  session: AuthoritySession;
};

export type PromotionExecutionValidationErrorCode =
  | "invalid-result"
  | "context-mismatch"
  | "lineage-mismatch"
  | "state-mismatch"
  | "credential-material";

export class PromotionExecutionValidationError extends Error {
  readonly code: PromotionExecutionValidationErrorCode;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: PromotionExecutionValidationErrorCode;
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "PromotionExecutionValidationError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PromotionExecutionValidationError({
      code: "invalid-result",
      message: `${field} must be a non-empty string in a Promotion execution result.`,
      recoveryAction: `return a normalized result with a non-empty ${field}; no Target pointer was advanced`,
      receipt: `field=${field}; result=invalid; targetMutation=false`,
    });
  }
  return value.trim();
}

function resultError(input: ConstructorParameters<typeof PromotionExecutionValidationError>[0]): never {
  throw new PromotionExecutionValidationError(input);
}

function forbiddenCredentialMaterial(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    return /(?:bearer\s+[A-Za-z0-9._~-]{8,}|cfat_[A-Za-z0-9]+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^;\s]{4,})/iu.test(value) ? "string" : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = forbiddenCredentialMaterial(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:token|secret|password|credentials?|api[_-]?key)$/iu.test(key)) return key;
      const found = forbiddenCredentialMaterial(entry);
      if (found) return found;
    }
  }
  return undefined;
}

function baseTargetState(target: Target): {
  currentReleaseId: string | null;
  releaseHistory: string[];
} {
  const currentReleaseId = target.currentReleaseId ?? null;
  const releaseHistory = [...(target.releaseHistory ?? [])];
  if (new Set(releaseHistory).size !== releaseHistory.length) {
    resultError({
      code: "context-mismatch",
      message: `Target ${target.id} has duplicate known-good Release history entries.`,
      recoveryAction: "repair the authoritative Target history before executing Promotion",
      receipt: `target=${target.id}; history=duplicate; targetMutation=false`,
    });
  }
  if (currentReleaseId !== null && !releaseHistory.includes(currentReleaseId)) {
    resultError({
      code: "context-mismatch",
      message: `Target ${target.id} current Release is outside its known-good history.`,
      recoveryAction: "reconcile the Target pointer and history before executing Promotion",
      receipt: `target=${target.id}; currentRelease=${currentReleaseId}; history=missing-current; targetMutation=false`,
    });
  }
  return { currentReleaseId, releaseHistory };
}

function contextDigest(input: {
  realmId: string;
  stateVersion: number;
  project: Project;
  promotion: PromotionRecord;
  release: Release;
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
  target: Target;
  expectedCurrentReleaseId: string | null;
  executionIdempotencyKey: string;
}): string {
  return digest({
    protocol: PROMOTION_EXECUTION_PROTOCOL,
    realmId: input.realmId,
    stateVersion: input.stateVersion,
    project: input.project,
    promotion: input.promotion,
    release: input.release,
    artifacts: input.artifacts,
    evidence: input.evidence,
    target: input.target,
    expectedCurrentReleaseId: input.expectedCurrentReleaseId,
    executionIdempotencyKey: input.executionIdempotencyKey,
  });
}

function actorFromSession(session: AuthoritySession): ActorRef {
  return {
    principalId: session.principalId,
    actorId: session.actorId,
    sessionId: session.sessionId,
    clientId: session.clientId,
  };
}

function projectForRelease(snapshot: AuthorityPlaneSnapshot, release: Release): Project | undefined {
  const projectId = snapshot.projectRevisions[release.projectRevisionId]?.projectId;
  return projectId ? snapshot.projects[projectId] : undefined;
}

/**
 * Builds a detached provider input from the authoritative snapshot. This is
 * the only source of provider execution context; callers cannot supply a
 * replacement Release, Target, Artifact, or Evidence object.
 */
export function createPromotionExecutionContext(input: {
  snapshot: AuthorityPlaneSnapshot;
  promotionId: string;
  executionIdempotencyKey: string;
  session: AuthoritySession;
}): PromotionExecutionContext {
  const promotion = input.snapshot.promotions[input.promotionId];
  if (!promotion) {
    resultError({
      code: "context-mismatch",
      message: `Promotion ${input.promotionId} does not exist in the authoritative snapshot.`,
      recoveryAction: "inspect the current Authority Promotion ledger and retry with the recorded Promotion ID",
      receipt: `promotion=${input.promotionId}; record=missing; providerInvocation=false`,
    });
  }
  const release = input.snapshot.releases[promotion.releaseId];
  const project = release ? projectForRelease(input.snapshot, release) : undefined;
  const target = input.snapshot.targets[promotion.targetId];
  if (!release || !project || !target || project.id !== promotion.projectId || target.projectId !== promotion.projectId) {
    resultError({
      code: "context-mismatch",
      message: `Promotion ${input.promotionId} is not bound to one exact Project, Release, and Target.`,
      recoveryAction: "repair the authoritative lineage before invoking a provider; no provider call was made",
      receipt: `promotion=${input.promotionId}; exact-binding=false; providerInvocation=false`,
    });
  }
  const artifacts = release.artifactIds.map((id) => input.snapshot.artifacts[id]);
  const evidence = release.evidenceIds.map((id) => input.snapshot.evidence[id]);
  if (artifacts.some((artifact) => !artifact) || evidence.some((record) => !record)) {
    resultError({
      code: "context-mismatch",
      message: `Promotion ${input.promotionId} does not have a complete immutable Artifact and Evidence lineage.`,
      recoveryAction: "restore the exact Release inputs before invoking the provider; no provider call was made",
      receipt: `promotion=${input.promotionId}; artifacts=${artifacts.length}; evidence=${evidence.length}; lineage= incomplete; providerInvocation=false`,
    });
  }
  const targetState = baseTargetState(target);
  const expectedCurrentReleaseId = promotion.expectedCurrentReleaseId ?? null;
  if (expectedCurrentReleaseId !== targetState.currentReleaseId) {
    resultError({
      code: "context-mismatch",
      message: `Promotion ${promotion.id} expected Release ${expectedCurrentReleaseId ?? "none"}, but Target ${target.id} is at ${targetState.currentReleaseId ?? "none"}.`,
      recoveryAction: "read the current Target pointer and request a new Promotion execution with a fresh expected state",
      receipt: `promotion=${promotion.id}; expectedCurrent=${expectedCurrentReleaseId ?? "none"}; actualCurrent=${targetState.currentReleaseId ?? "none"}; providerInvocation=false`,
    });
  }
  if (input.session.realmId !== input.snapshot.realmId) {
    resultError({
      code: "context-mismatch",
      message: "The authenticated session belongs to a different Realm than the Authority snapshot.",
      recoveryAction: "invoke the handoff through the coordinator bound to the authenticated Realm",
      receipt: `sessionRealm=${input.session.realmId}; stateRealm=${input.snapshot.realmId}; providerInvocation=false`,
    });
  }
  const contextInput = {
    realmId: input.snapshot.realmId,
    stateVersion: input.snapshot.version,
    project,
    promotion,
    release,
    artifacts: artifacts as Artifact[],
    evidence: evidence as Evidence[],
    target,
    expectedCurrentReleaseId,
    executionIdempotencyKey: input.executionIdempotencyKey,
  };
  return {
    protocol: PROMOTION_EXECUTION_PROTOCOL,
    ...contextInput,
    actor: actorFromSession(input.session),
    executionDigest: contextDigest(contextInput),
  };
}

function expectedTarget(input: PromotionExecutionContext): {
  currentReleaseId: string | null;
  releaseHistory: string[];
} {
  const target = baseTargetState(input.target);
  return target;
}

function validateResultState(input: PromotionExecutionContext, result: PromotionExecutionResult): void {
  const expected = expectedTarget(input);
  const resultPromotion = result.promotion;
  const resultTarget = result.target;
  const success = result.status === "succeeded";
  const terminalSuccess = resultPromotion.state === "healthy" || resultPromotion.state === "rolled-back";
  if (success !== terminalSuccess || (success && resultTarget.state !== "healthy")) {
    resultError({
      code: "state-mismatch",
      message: `Promotion execution status ${result.status} does not match Promotion state ${resultPromotion.state} and Target state ${resultTarget.state}.`,
      recoveryAction: "return a terminal normalized result or reconcile the provider as indeterminate",
      receipt: `promotion=${resultPromotion.id}; status=${result.status}; promotionState=${resultPromotion.state}; targetState=${resultTarget.state}; targetMutation=false`,
    });
  }
  if (result.status === "indeterminate" && (resultPromotion.state !== "degraded" || resultTarget.state !== "degraded")) {
    resultError({
      code: "state-mismatch",
      message: "An indeterminate provider result must leave Promotion and Target visibly degraded.",
      recoveryAction: "reconcile the provider and return Promotion state degraded with a recovery action",
      receipt: `promotion=${resultPromotion.id}; indeterminate=true; degraded-required=true; targetMutation=false`,
    });
  }
  if (!success && resultPromotion.state !== "degraded" && resultTarget.currentReleaseId !== expected.currentReleaseId) {
    resultError({
      code: "state-mismatch",
      message: "A failed or blocked provider result cannot move the Anyam Target pointer.",
      recoveryAction: "preserve the known-good Target pointer and return a degraded or blocked result",
      receipt: `promotion=${resultPromotion.id}; pointerMoved=true; targetMutation=false`,
    });
  }
  if (success && resultTarget.currentReleaseId !== resultPromotion.releaseId) {
    resultError({
      code: "lineage-mismatch",
      message: "A healthy Promotion result must make the exact promoted Release current at the Target.",
      recoveryAction: "return the provider-verified Release pointer or leave the Promotion indeterminate",
      receipt: `promotion=${resultPromotion.id}; release=${resultPromotion.releaseId}; targetCurrent=${resultTarget.currentReleaseId ?? "none"}; targetMutation=false`,
    });
  }
  const expectedHistory = [...expected.releaseHistory];
  if (success && !expectedHistory.includes(resultPromotion.releaseId)) expectedHistory.push(resultPromotion.releaseId);
  if (resultTarget.releaseHistory.length !== expectedHistory.length || resultTarget.releaseHistory.some((id, index) => id !== expectedHistory[index])) {
    resultError({
      code: "lineage-mismatch",
      message: "Promotion execution returned a Target history that is not the exact append-only history.",
      recoveryAction: "return the prior known-good history with only the verified Release appended",
      receipt: `target=${resultTarget.id}; history=unexpected; targetMutation=false`,
    });
  }
}

/** Validate a provider result before it can cross into Authority state. */
export function validatePromotionExecutionResult(input: PromotionExecutionContext, result: PromotionExecutionResult): void {
  if (result.protocol !== PROMOTION_EXECUTION_PROTOCOL) {
    resultError({
      code: "invalid-result",
      message: `Unsupported Promotion execution protocol ${result.protocol}.`,
      recoveryAction: "return anyam.promotion-execution/v1 from the trusted provider executor",
      receipt: `promotion=${input.promotion.id}; protocol=${String(result.protocol)}; targetMutation=false`,
    });
  }
  if (!["succeeded", "blocked", "indeterminate"].includes(result.status)) {
    resultError({
      code: "invalid-result",
      message: `Unsupported Promotion execution status ${String(result.status)}.`,
      recoveryAction: "return succeeded, blocked, or indeterminate and include a recovery action for non-success",
      receipt: `promotion=${input.promotion.id}; status=invalid; targetMutation=false`,
    });
  }
  if (result.executionDigest !== input.executionDigest) {
    resultError({
      code: "lineage-mismatch",
      message: "Provider execution did not bind its result to the exact Authority context digest.",
      recoveryAction: "discard the stale provider result and reconcile the immutable operation before retrying",
      receipt: `promotion=${input.promotion.id}; expectedExecutionDigest=${input.executionDigest}; receivedExecutionDigest=${result.executionDigest}; targetMutation=false`,
    });
  }
  if (result.adapterId !== input.target.adapterId) {
    resultError({
      code: "context-mismatch",
      message: `Provider executor ${result.adapterId} does not match Target adapter ${input.target.adapterId}.`,
      recoveryAction: "select the qualified adapter declared by the Target and retry only after reconciling the provider",
      receipt: `target=${input.target.id}; expectedAdapter=${input.target.adapterId}; receivedAdapter=${result.adapterId}; targetMutation=false`,
    });
  }
  const resultPromotion = result.promotion;
  const resultTarget = result.target;
  if (resultPromotion.protocol !== CONTRACT_VERSIONS.promotion || resultPromotion.id !== input.promotion.id || resultPromotion.projectId !== input.project.id || resultPromotion.targetId !== input.target.id || resultPromotion.releaseId !== input.release.id || resultPromotion.expectedCurrentReleaseId !== input.expectedCurrentReleaseId || resultPromotion.kind !== input.promotion.kind || (!input.promotion.releaseDigest.startsWith("declared:") && resultPromotion.releaseDigest !== input.promotion.releaseDigest) || resultPromotion.previousReleaseId !== input.promotion.previousReleaseId) {
    resultError({
      code: "lineage-mismatch",
      message: "Provider Promotion result is not bound to the requested Project, Release, Target, or expected current state.",
      recoveryAction: "discard the result and reconcile the provider operation against the exact Promotion identity",
      receipt: `promotion=${input.promotion.id}; exactBinding=false; targetMutation=false`,
    });
  }
  if (resultTarget.id !== input.target.id || resultTarget.projectId !== input.project.id) {
    resultError({
      code: "lineage-mismatch",
      message: "Provider Target result is not bound to the requested Project and Target.",
      recoveryAction: "return the Target identity from the trusted executor context",
      receipt: `target=${input.target.id}; resultTarget=${resultTarget.id}; targetMutation=false`,
    });
  }
  const forbidden = forbiddenCredentialMaterial(result);
  if (forbidden) {
    resultError({
      code: "credential-material",
      message: "Promotion execution result contains credential material or a credential-shaped field.",
      recoveryAction: "remove credential material; return provider IDs, digests, and safe receipts only",
      receipt: `promotion=${input.promotion.id}; credentialMaterial=${forbidden}; targetMutation=false`,
    });
  }
  validateResultState(input, result);
}

export function normalizePromotionExecutionResult(input: PromotionExecutionContext, result: PromotionExecutionResult): PromotionExecutionResult {
  validatePromotionExecutionResult(input, result);
  const promotion: PromotionRecord = {
    ...clone(result.promotion),
    projectId: input.project.id,
    targetId: input.target.id,
    releaseId: input.release.id,
    idempotencyKey: input.promotion.idempotencyKey,
    actor: clone(input.actor),
    createdAt: input.promotion.createdAt,
    previousReleaseId: input.promotion.previousReleaseId,
    expectedCurrentReleaseId: input.expectedCurrentReleaseId,
    executionIdempotencyKey: input.executionIdempotencyKey,
    ...(result.checkpoint ? { reconciliationCheckpoint: clone(result.checkpoint) } : {}),
  };
  return {
    ...clone(result),
    promotion,
    target: clone(result.target),
    receipt: `${result.receipt}; authorityHandoff=validated; credentialFree=true; canonicalWrite=false`,
  };
}

export function authorityPromotionExecutionContextDigest(input: Parameters<typeof createPromotionExecutionContext>[0]): string {
  return createPromotionExecutionContext(input).executionDigest;
}

export function targetAfterPromotion(input: {
  target: Target;
  result: PromotionExecutionResult;
}): Target {
  return {
    ...clone(input.target),
    state: input.result.target.state,
    currentReleaseId: input.result.target.currentReleaseId,
    releaseHistory: [...input.result.target.releaseHistory],
    lastPromotionId: input.result.promotion.id,
  };
}
