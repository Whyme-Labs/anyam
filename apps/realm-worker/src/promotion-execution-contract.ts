import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";

export const PROMOTION_EXECUTE_COMMAND = "promotion.execute" as const;
export const PROMOTION_RECONCILE_COMMAND = "promotion.reconcile" as const;

export class PromotionExecutionInputError extends Error {
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "PromotionExecutionInputError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new PromotionExecutionInputError(message, recoveryAction, receipt);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("Promotion execution arguments must be an object.", "send only the documented expectedVersion field; no provider operation was started", `operation=${PROMOTION_EXECUTE_COMMAND}; arguments=object-required; providerInvocation=false`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalid(`${field} is required.`, `provide a non-empty ${field}; no provider operation was started`, `operation=${PROMOTION_EXECUTE_COMMAND}; field=${field}; providerInvocation=false`);
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no provider operation was started`, `operation=${PROMOTION_EXECUTE_COMMAND}; field=${field}; identifier=safe-required; providerInvocation=false`);
  return identifier;
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion", `operation=${PROMOTION_EXECUTE_COMMAND}; expectedVersion=non-negative-safe-integer-required; providerInvocation=false`);
  return value;
}

export type PromotionExecutionMutation = {
  command: typeof PROMOTION_EXECUTE_COMMAND;
  promotionId: string;
  executionIdempotencyKey: string;
  expectedVersion?: number;
};

export type PromotionReconciliationMutation = {
  command: typeof PROMOTION_RECONCILE_COMMAND;
  promotionId: string;
  reconciliationIdempotencyKey: string;
  expectedVersion?: number;
};

export function promotionExecutionCommand(promotionId: unknown, body: unknown, executionIdempotencyKey: string | null): PromotionExecutionMutation {
  const parsed = record(body);
  const unknown = Object.keys(parsed).find((key) => key !== "expectedVersion");
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown}; provider execution accepts only expectedVersion and the path Promotion identity`, `operation=${PROMOTION_EXECUTE_COMMAND}; field=${unknown}; providerInvocation=false`);
  const key = requiredString(executionIdempotencyKey, "Idempotency-Key header");
  const version = expectedVersion(parsed.expectedVersion);
  return {
    command: PROMOTION_EXECUTE_COMMAND,
    promotionId: safeIdentifier(promotionId, "promotionId"),
    executionIdempotencyKey: key,
    ...(version === undefined ? {} : { expectedVersion: version }),
  };
}

export function promotionReconciliationCommand(promotionId: unknown, body: unknown, reconciliationIdempotencyKey: string | null): PromotionReconciliationMutation {
  const parsed = record(body);
  const unknown = Object.keys(parsed).find((key) => key !== "expectedVersion");
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown}; reconciliation derives the immutable provider identity from the recorded Promotion checkpoint`, `operation=${PROMOTION_RECONCILE_COMMAND}; field=${unknown}; providerInvocation=false`);
  const key = requiredString(reconciliationIdempotencyKey, "Idempotency-Key header");
  const version = expectedVersion(parsed.expectedVersion);
  return {
    command: PROMOTION_RECONCILE_COMMAND,
    promotionId: safeIdentifier(promotionId, "promotionId"),
    reconciliationIdempotencyKey: key,
    ...(version === undefined ? {} : { expectedVersion: version }),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`coordinator_${field}_malformed`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`coordinator_${field}_malformed`);
  return [...(value as string[])];
}

function safeDeploymentProfile(value: unknown): Record<string, unknown> {
  const profile = object(value, "deploymentProfile");
  return {
    protocol: string(profile.protocol, "deploymentProfile.protocol"),
    environment: string(profile.environment, "deploymentProfile.environment"),
    channel: string(profile.channel, "deploymentProfile.channel"),
    audience: string(profile.audience, "deploymentProfile.audience"),
    runtimeIdentity: string(profile.runtimeIdentity, "deploymentProfile.runtimeIdentity"),
    routeIdentities: stringList(profile.routeIdentities, "deploymentProfile.routeIdentities"),
    bindingIdentities: stringList(profile.bindingIdentities, "deploymentProfile.bindingIdentities"),
    dataResourceIdentities: stringList(profile.dataResourceIdentities, "deploymentProfile.dataResourceIdentities"),
    configurationDigests: stringList(profile.configurationDigests, "deploymentProfile.configurationDigests"),
    secretUseAliases: stringList(profile.secretUseAliases, "deploymentProfile.secretUseAliases"),
    dataClass: string(profile.dataClass, "deploymentProfile.dataClass"),
    resourceSharing: string(profile.resourceSharing, "deploymentProfile.resourceSharing"),
    ...(profile.sharingPolicyDigest === undefined ? {} : { sharingPolicyDigest: string(profile.sharingPolicyDigest, "deploymentProfile.sharingPolicyDigest") }),
    profileDigest: string(profile.profileDigest, "deploymentProfile.profileDigest"),
  };
}

function safeInputSet(value: unknown): Record<string, unknown> {
  const inputSet = object(value, "inputSet");
  return {
    protocol: string(inputSet.protocol, "inputSet.protocol"),
    buildDefinitionDigest: string(inputSet.buildDefinitionDigest, "inputSet.buildDefinitionDigest"),
    dependencyDigest: string(inputSet.dependencyDigest, "inputSet.dependencyDigest"),
    toolchainDigest: string(inputSet.toolchainDigest, "inputSet.toolchainDigest"),
    environmentDigest: string(inputSet.environmentDigest, "inputSet.environmentDigest"),
    artifactDigests: stringList(inputSet.artifactDigests, "inputSet.artifactDigests"),
    inputClosureDigest: string(inputSet.inputClosureDigest, "inputSet.inputClosureDigest"),
  };
}

function safeMigrationPlan(value: unknown): Record<string, unknown> {
  const plan = object(value, "migrationPlan");
  return {
    protocol: string(plan.protocol, "migrationPlan.protocol"),
    strategy: string(plan.strategy, "migrationPlan.strategy"),
    ...(plan.beforeSchemaDigest === undefined ? {} : { beforeSchemaDigest: string(plan.beforeSchemaDigest, "migrationPlan.beforeSchemaDigest") }),
    ...(plan.afterSchemaDigest === undefined ? {} : { afterSchemaDigest: string(plan.afterSchemaDigest, "migrationPlan.afterSchemaDigest") }),
    compatibility: string(plan.compatibility, "migrationPlan.compatibility"),
    rollback: string(plan.rollback, "migrationPlan.rollback"),
    migrationArtifactIds: stringList(plan.migrationArtifactIds, "migrationPlan.migrationArtifactIds"),
    requiredEvidenceKeys: stringList(plan.requiredEvidenceKeys, "migrationPlan.requiredEvidenceKeys"),
    planDigest: string(plan.planDigest, "migrationPlan.planDigest"),
  };
}

function safePromotion(value: unknown): Record<string, unknown> {
  const promotion = object(value, "promotion");
  const previousReleaseId = promotion.previousReleaseId === null ? null : string(promotion.previousReleaseId, "promotion.previousReleaseId");
  const expectedCurrentReleaseId = promotion.expectedCurrentReleaseId === null ? null : string(promotion.expectedCurrentReleaseId, "promotion.expectedCurrentReleaseId");
  return {
    protocol: string(promotion.protocol, "promotion.protocol"),
    id: string(promotion.id, "promotion.id"),
    projectId: string(promotion.projectId, "promotion.projectId"),
    targetId: string(promotion.targetId, "promotion.targetId"),
    releaseId: string(promotion.releaseId, "promotion.releaseId"),
    releaseDigest: string(promotion.releaseDigest, "promotion.releaseDigest"),
    previousReleaseId,
    expectedCurrentReleaseId,
    state: string(promotion.state, "promotion.state"),
    attempt: typeof promotion.attempt === "number" && Number.isSafeInteger(promotion.attempt) ? promotion.attempt : (() => { throw new Error("coordinator_promotion.attempt_malformed"); })(),
    kind: string(promotion.kind, "promotion.kind"),
    ...(optionalString(promotion.previewId, "promotion.previewId") ? { previewId: optionalString(promotion.previewId, "promotion.previewId") } : {}),
    ...(optionalString(promotion.deploymentId, "promotion.deploymentId") ? { deploymentId: optionalString(promotion.deploymentId, "promotion.deploymentId") } : {}),
    ...(optionalString(promotion.providerOperationId, "promotion.providerOperationId") ? { providerOperationId: optionalString(promotion.providerOperationId, "promotion.providerOperationId") } : {}),
    ...(optionalString(promotion.rollbackDeploymentId, "promotion.rollbackDeploymentId") ? { rollbackDeploymentId: optionalString(promotion.rollbackDeploymentId, "promotion.rollbackDeploymentId") } : {}),
    ...(optionalString(promotion.rollbackProviderOperationId, "promotion.rollbackProviderOperationId") ? { rollbackProviderOperationId: optionalString(promotion.rollbackProviderOperationId, "promotion.rollbackProviderOperationId") } : {}),
    ...(optionalString(promotion.executionIdempotencyKey, "promotion.executionIdempotencyKey") ? { executionIdempotencyKey: optionalString(promotion.executionIdempotencyKey, "promotion.executionIdempotencyKey") } : {}),
    ...(promotion.health === undefined ? {} : { health: safeHealth(promotion.health, "promotion.health") }),
    ...(promotion.rollbackHealth === undefined ? {} : { rollbackHealth: safeHealth(promotion.rollbackHealth, "promotion.rollbackHealth") }),
    ...(optionalString(promotion.healthFailure, "promotion.healthFailure") ? { healthFailure: optionalString(promotion.healthFailure, "promotion.healthFailure") } : {}),
    ...(optionalString(promotion.recoveryAction, "promotion.recoveryAction") ? { recoveryAction: optionalString(promotion.recoveryAction, "promotion.recoveryAction") } : {}),
    ...(promotion.reconciliationCheckpoint === undefined ? {} : { reconciliationCheckpoint: safeCheckpoint(promotion.reconciliationCheckpoint) }),
  };
}

function safeHealth(value: unknown, field: string): Record<string, unknown> {
  const health = object(value, field);
  const state = string(health.state, `${field}.state`);
  if (!['healthy', 'unhealthy', 'unknown'].includes(state)) throw new Error(`${field}.state_malformed`);
  return {
    protocol: string(health.protocol, `${field}.protocol`),
    id: string(health.id, `${field}.id`),
    targetId: string(health.targetId, `${field}.targetId`),
    releaseId: string(health.releaseId, `${field}.releaseId`),
    state,
    checkId: string(health.checkId, `${field}.checkId`),
    checkedAt: string(health.checkedAt, `${field}.checkedAt`),
    receipt: string(health.receipt, `${field}.receipt`),
    ...(optionalString(health.outputDigest, `${field}.outputDigest`) ? { outputDigest: optionalString(health.outputDigest, `${field}.outputDigest`) } : {}),
  };
}

function safeTarget(value: unknown): Record<string, unknown> {
  const target = object(value, "target");
  const history = target.releaseHistory;
  if (!Array.isArray(history) || history.some((entry) => typeof entry !== "string")) throw new Error("coordinator_target.releaseHistory_malformed");
  return {
    protocol: string(target.protocol, "target.protocol"),
    id: string(target.id, "target.id"),
    projectId: string(target.projectId, "target.projectId"),
    name: string(target.name, "target.name"),
    adapterId: string(target.adapterId, "target.adapterId"),
    state: string(target.state, "target.state"),
    currentReleaseId: target.currentReleaseId === null ? null : string(target.currentReleaseId, "target.currentReleaseId"),
    releaseHistory: [...history],
    ...(optionalString(target.lastPromotionId, "target.lastPromotionId") ? { lastPromotionId: optionalString(target.lastPromotionId, "target.lastPromotionId") } : {}),
    ...(target.deploymentProfile === undefined ? {} : { deploymentProfile: safeDeploymentProfile(target.deploymentProfile) }),
  };
}

function safeRelease(value: unknown): Record<string, unknown> {
  const release = object(value, "release");
  return { protocol: string(release.protocol, "release.protocol"), id: string(release.id, "release.id"), projectRevisionId: string(release.projectRevisionId, "release.projectRevisionId"), status: string(release.status, "release.status"), ...(release.inputSet === undefined ? {} : { inputSet: safeInputSet(release.inputSet) }), ...(release.migrationPlan === undefined ? {} : { migrationPlan: safeMigrationPlan(release.migrationPlan) }) };
}

function safeCheckpoint(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const checkpoint = object(value, "checkpoint");
  const ids = checkpoint.providerOperationIds;
  if (!Array.isArray(ids) || ids.some((entry) => typeof entry !== "string")) throw new Error("coordinator_checkpoint.providerOperationIds_malformed");
  return {
    idempotencyKey: string(checkpoint.idempotencyKey, "checkpoint.idempotencyKey"),
    attempt: typeof checkpoint.attempt === "number" && Number.isSafeInteger(checkpoint.attempt) ? checkpoint.attempt : (() => { throw new Error("coordinator_checkpoint.attempt_malformed"); })(),
    stage: string(checkpoint.stage, "checkpoint.stage"),
    providerOperationIds: [...ids],
    receipt: string(checkpoint.receipt, "checkpoint.receipt"),
    ...(optionalString(checkpoint.executionDigest, "checkpoint.executionDigest") ? { executionDigest: optionalString(checkpoint.executionDigest, "checkpoint.executionDigest") } : {}),
    ...(optionalString(checkpoint.releaseId, "checkpoint.releaseId") ? { releaseId: optionalString(checkpoint.releaseId, "checkpoint.releaseId") } : {}),
    ...(optionalString(checkpoint.targetId, "checkpoint.targetId") ? { targetId: optionalString(checkpoint.targetId, "checkpoint.targetId") } : {}),
    ...(optionalString(checkpoint.status, "checkpoint.status") ? { status: optionalString(checkpoint.status, "checkpoint.status") } : {}),
    ...(optionalString(checkpoint.updatedAt, "checkpoint.updatedAt") ? { updatedAt: optionalString(checkpoint.updatedAt, "checkpoint.updatedAt") } : {}),
  };
}

export function promotionExecutionValue(result: Record<string, unknown>, executionIdempotencyKey: string): Record<string, unknown> {
  const value = object(result.value, "value");
  const recoveryAction = optionalString(result.recoveryAction, "recoveryAction");
  const checkpoint = safeCheckpoint(value.checkpoint);
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: string(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey: executionIdempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    promotion: safePromotion(value.promotion),
    target: safeTarget(value.target),
    release: safeRelease(value.release),
    ...(checkpoint ? { checkpoint } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
    receipt: `operation=${PROMOTION_EXECUTE_COMMAND}; typedSurface=rest; credentialFree=true; canonicalWrite=false; providerExecution=trusted-handoff; result=validated`,
  };
}

export function promotionReconciliationValue(result: Record<string, unknown>, reconciliationIdempotencyKey: string): Record<string, unknown> {
  const value = object(result.value, "value");
  const recoveryAction = optionalString(result.recoveryAction, "recoveryAction");
  const checkpoint = safeCheckpoint(value.checkpoint);
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: string(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey: reconciliationIdempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    promotion: safePromotion(value.promotion),
    target: safeTarget(value.target),
    release: safeRelease(value.release),
    ...(checkpoint ? { checkpoint } : {}),
    ...(recoveryAction ? { recoveryAction } : {}),
    receipt: `operation=${PROMOTION_RECONCILE_COMMAND}; typedSurface=rest; credentialFree=true; canonicalWrite=false; providerExecution=trusted-handoff; result=validated`,
  };
}

export function promotionStatusValue(result: Record<string, unknown>): Record<string, unknown> {
  const promotion = safePromotion(result.promotion);
  const target = safeTarget(result.target);
  const release = safeRelease(result.release);
  const checkpoint = result.checkpoint === undefined ? undefined : safeCheckpoint(result.checkpoint);
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: string(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    credentialFree: true,
    canonicalWrite: false,
    promotion,
    target,
    release,
    ...(checkpoint ? { checkpoint } : {}),
    receipt: `operation=promotion.status; typedSurface=rest; readOnly=true; credentialFree=true; canonicalWrite=false`,
  };
}
