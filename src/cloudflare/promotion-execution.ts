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
import { targetDeploymentProfile } from "../delivery/target-deployment.ts";
import type {
  AuthorityPlaneSnapshot,
  AuthoritySession,
} from "./authority-plane.ts";
import type {
  PromotionReconciliationCheckpoint,
  PromotionRecord,
} from "../delivery/promotion.ts";
import { CREDENTIAL_MATERIAL_SCANNER_PROTOCOL, scanCredentialMaterial } from "../security/credential-material.ts";

/**
 * The internal handoff is deliberately separate from promotion.request. A
 * request records owner intent; an execution invokes a provider capability
 * selected by the trusted coordinator and then validates the returned result
 * before mutating Anyam-owned Target state.
 */
export const PROMOTION_EXECUTION_PROTOCOL = CONTRACT_VERSIONS.promotionExecution;
export const PROMOTION_HANDOFF_TTL_MS = 5 * 60 * 1000;
export const PROMOTION_HANDOFF_SIZING_RECEIPT = "handoffTtl=300000ms; sizing=qualification-tripwire; remeasure-before-production";

export type PromotionExecutionReleaseBundle = {
  release: Release;
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
};

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
  /** Exact previous known-good inputs needed for provider-side rollback. */
  previousRelease: PromotionExecutionReleaseBundle | null;
  target: Target;
  expectedCurrentReleaseId: string | null;
  executionIdempotencyKey: string;
  actor: ActorRef;
  /** Digest over the immutable Authority inputs supplied to the provider. */
  executionDigest: string;
};

export type PromotionHandoffNonceStore = {
  claim(input: { nonce: string; expiresAt: string }): Promise<boolean>;
};

export type PromotionHandoffKey = {
  id: string;
  secret: string;
};

export type PromotionHandoffKeyring = {
  active: PromotionHandoffKey;
  previous?: PromotionHandoffKey;
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
    deploymentProfile?: Target["deploymentProfile"];
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

/**
 * Reconciliation is a new Authority command identity, but it deliberately
 * reuses the immutable executionIdempotencyKey recorded on the Promotion.
 * This lets an operator retry/poll one provider operation without creating a
 * second provider-side deployment identity.
 */
export type PromotionReconciliationRequest = {
  promotionId: string;
  reconciliationIdempotencyKey: string;
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

export function promotionHandoffMessage(context: Readonly<PromotionExecutionContext>, nonce: string, expiresAt: string, keyId?: string): string {
  return stableJson({ protocol: PROMOTION_EXECUTION_PROTOCOL, nonce, expiresAt, ...(keyId ? { keyId } : {}), context });
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function handoffKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  if (secret.trim().length === 0) throw new Error("promotion handoff secret is empty");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function signPromotionHandoff(input: { context: Readonly<PromotionExecutionContext>; nonce: string; expiresAt: string; secret: string; keyId?: string }): Promise<string> {
  const key = await handoffKey(input.secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(promotionHandoffMessage(input.context, input.nonce, input.expiresAt, input.keyId)));
  return base64Url(new Uint8Array(signature));
}

export async function verifyPromotionHandoff(input: { context: Readonly<PromotionExecutionContext>; nonce: string; expiresAt: string; signature: string; secret: string; keyId?: string }): Promise<boolean> {
  if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) return false;
  try {
    const key = await handoffKey(input.secret, ["verify"]);
    const signature = decodeBase64Url(input.signature);
    const signatureBytes = new Uint8Array(signature.byteLength);
    signatureBytes.set(signature);
    return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer, new TextEncoder().encode(promotionHandoffMessage(input.context, input.nonce, input.expiresAt, input.keyId)));
  } catch {
    return false;
  }
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
  return scanCredentialMaterial(value)?.path;
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
  project: Project;
  promotion: PromotionRecord;
  release: Release;
  artifacts: readonly Artifact[];
  evidence: readonly Evidence[];
  previousRelease: PromotionExecutionReleaseBundle | null;
  target: Target;
  expectedCurrentReleaseId: string | null;
  executionIdempotencyKey: string;
}): string {
  // The provider handoff is an immutable execution identity.  Authority
  // state, Promotion status, attempt counters, and receipts may change while
  // an operation is being reconciled; none of those changes may manufacture a
  // new provider operation or make a late result look current.  Bind only the
  // immutable Project/Release/Target inputs and the execution identity.
  return digest({
    protocol: PROMOTION_EXECUTION_PROTOCOL,
    realmId: input.realmId,
    project: {
      protocol: input.project.protocol,
      id: input.project.id,
      referenceType: input.project.referenceType,
      sourceSpaceIds: input.project.sourceSpaceIds,
    },
    promotion: {
      protocol: input.promotion.protocol,
      id: input.promotion.id,
      projectId: input.promotion.projectId,
      targetId: input.promotion.targetId,
      releaseId: input.promotion.releaseId,
      releaseDigest: input.promotion.releaseDigest,
      previousReleaseId: input.promotion.previousReleaseId,
      expectedCurrentReleaseId: input.promotion.expectedCurrentReleaseId,
      kind: input.promotion.kind,
      idempotencyKey: input.promotion.idempotencyKey,
    },
    release: input.release,
    artifacts: input.artifacts,
    evidence: input.evidence,
    previousRelease: input.previousRelease,
    target: {
      protocol: input.target.protocol,
      id: input.target.id,
      projectId: input.target.projectId,
      adapterId: input.target.adapterId,
      acceptedArtifactTypes: input.target.acceptedArtifactTypes,
      requiredEvidenceKeys: input.target.requiredEvidenceKeys,
      deploymentProfile: targetDeploymentProfile(input.target),
    },
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
  const previousReleaseId = promotion.previousReleaseId;
  const previousRelease = previousReleaseId ? input.snapshot.releases[previousReleaseId] : undefined;
  const previousProject = previousRelease ? projectForRelease(input.snapshot, previousRelease) : undefined;
  const previousArtifacts = previousRelease?.artifactIds.map((id) => input.snapshot.artifacts[id]) ?? [];
  const previousEvidence = previousRelease?.evidenceIds.map((id) => input.snapshot.evidence[id]) ?? [];
  if (previousReleaseId && (!previousRelease || previousProject?.id !== project.id || previousArtifacts.some((artifact) => !artifact) || previousEvidence.some((record) => !record))) {
    resultError({
      code: "context-mismatch",
      message: `Promotion ${input.promotionId} does not have a complete immutable previous Release lineage for rollback.`,
      recoveryAction: "restore the exact previous Release, Artifact, and Evidence records before invoking the provider; no provider call was made",
      receipt: `promotion=${input.promotionId}; previousRelease=${previousReleaseId}; lineage=incomplete; providerInvocation=false`,
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
    previousRelease: previousRelease
      ? { release: previousRelease, artifacts: previousArtifacts as Artifact[], evidence: previousEvidence as Evidence[] }
      : null,
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
  if (resultPromotion.protocol !== CONTRACT_VERSIONS.promotion || resultPromotion.id !== input.promotion.id || resultPromotion.projectId !== input.project.id || resultPromotion.targetId !== input.target.id || resultPromotion.releaseId !== input.release.id || resultPromotion.expectedCurrentReleaseId !== input.expectedCurrentReleaseId || resultPromotion.kind !== input.promotion.kind || (!input.promotion.releaseDigest.startsWith("declared:") && resultPromotion.releaseDigest !== input.promotion.releaseDigest) || resultPromotion.previousReleaseId !== input.promotion.previousReleaseId || (resultPromotion.executionIdempotencyKey !== undefined && resultPromotion.executionIdempotencyKey !== input.executionIdempotencyKey)) {
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
  if (resultTarget.deploymentProfile !== undefined && resultTarget.deploymentProfile.profileDigest !== targetDeploymentProfile(input.target).profileDigest) {
    resultError({
      code: "lineage-mismatch",
      message: "Provider Promotion result returned a different Target Deployment Profile.",
      recoveryAction: "return the exact Authority-bound Target profile or reconcile the provider operation before retrying",
      receipt: `target=${input.target.id}; expectedProfile=${targetDeploymentProfile(input.target).profileDigest}; receivedProfile=${resultTarget.deploymentProfile.profileDigest}; targetMutation=false`,
    });
  }
  const forbidden = forbiddenCredentialMaterial(result);
  if (forbidden) {
    resultError({
      code: "credential-material",
      message: "Promotion execution result contains credential material or a credential-shaped field.",
      recoveryAction: "remove credential material; return provider IDs, digests, and safe receipts only",
      receipt: `promotion=${input.promotion.id}; credentialMaterial=${forbidden}; scanner=${CREDENTIAL_MATERIAL_SCANNER_PROTOCOL}; targetMutation=false`,
    });
  }
  if (result.checkpoint && result.checkpoint.idempotencyKey !== input.executionIdempotencyKey) {
    resultError({
      code: "lineage-mismatch",
      message: "Provider reconciliation checkpoint belongs to a different immutable execution identity.",
      recoveryAction: "discard the stale callback and reconcile the recorded execution identity",
      receipt: `promotion=${input.promotion.id}; checkpointIdentity=${result.checkpoint.idempotencyKey}; expectedIdentity=${input.executionIdempotencyKey}; targetMutation=false`,
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
