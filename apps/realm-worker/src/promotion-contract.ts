import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";

export const PROMOTION_REQUEST_COMMAND = "promotion.request" as const;

export class PromotionRequestInputError extends Error {
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "PromotionRequestInputError";
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function invalid(message: string, recoveryAction: string, receipt: string): never {
  throw new PromotionRequestInputError(message, recoveryAction, receipt);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${PROMOTION_REQUEST_COMMAND} arguments must be an object.`, "send the documented typed Promotion arguments; no transition was accepted", `operation=${PROMOTION_REQUEST_COMMAND}; arguments=object-required; transition=not-applied`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(`${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${PROMOTION_REQUEST_COMMAND}; field=${field}; transition=not-applied`);
  }
  return value.trim();
}

function safeIdentifier(value: unknown, field: string): string {
  const identifier = requiredString(value, field);
  if (identifier.includes("/") || identifier.includes("\\") || identifier === "." || identifier === "..") {
    return invalid(`${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${PROMOTION_REQUEST_COMMAND}; field=${field}; identifier=safe-required; transition=not-applied`);
  }
  return identifier;
}

function optionalSafeIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : safeIdentifier(value, field);
}

function expectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalid("expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${PROMOTION_REQUEST_COMMAND}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  }
  return value;
}

function assertAllowed(body: Record<string, unknown>): void {
  const allowed = ["idempotencyKey", "expectedVersion", "projectId", "promotionId", "releaseId", "targetId", "releaseDigest", "expectedCurrentReleaseId"];
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) return invalid(`Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${PROMOTION_REQUEST_COMMAND} fields; no transition was accepted`, `operation=${PROMOTION_REQUEST_COMMAND}; field=${unknown}; transition=not-applied`);
}

export type PromotionRequestMutation = {
  command: typeof PROMOTION_REQUEST_COMMAND;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export function promotionRequestCommand(value: unknown): PromotionRequestMutation {
  const body = objectBody(value);
  assertAllowed(body);
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  const version = expectedVersion(body.expectedVersion);
  const projectId = safeIdentifier(body.projectId, "projectId");
  const promotionId = optionalSafeIdentifier(body.promotionId, "promotionId");
  const releaseId = safeIdentifier(body.releaseId, "releaseId");
  const targetId = safeIdentifier(body.targetId, "targetId");
  const releaseDigest = body.releaseDigest === undefined ? undefined : requiredString(body.releaseDigest, "releaseDigest");
  const expectedCurrentReleaseId = optionalSafeIdentifier(body.expectedCurrentReleaseId, "expectedCurrentReleaseId");
  return {
    command: PROMOTION_REQUEST_COMMAND,
    idempotencyKey,
    ...(version === undefined ? {} : { expectedVersion: version }),
    payload: {
      projectId,
      ...(promotionId ? { promotionId } : {}),
      releaseId,
      targetId,
      ...(releaseDigest ? { releaseDigest } : {}),
      ...(expectedCurrentReleaseId ? { expectedCurrentReleaseId } : {}),
    },
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`coordinator_${field}_malformed`);
  return value as Record<string, unknown>;
}

function valueString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function optionalStringValue(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : valueString(value, field);
}

function valueStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`coordinator_${field}_malformed`);
  return [...(value as string[])];
}

function safeDeploymentProfile(value: unknown): Record<string, unknown> {
  const profile = record(value, "deploymentProfile");
  return {
    protocol: valueString(profile.protocol, "deploymentProfile.protocol"),
    environment: valueString(profile.environment, "deploymentProfile.environment"),
    channel: valueString(profile.channel, "deploymentProfile.channel"),
    audience: valueString(profile.audience, "deploymentProfile.audience"),
    runtimeIdentity: valueString(profile.runtimeIdentity, "deploymentProfile.runtimeIdentity"),
    routeIdentities: valueStringList(profile.routeIdentities, "deploymentProfile.routeIdentities"),
    bindingIdentities: valueStringList(profile.bindingIdentities, "deploymentProfile.bindingIdentities"),
    dataResourceIdentities: valueStringList(profile.dataResourceIdentities, "deploymentProfile.dataResourceIdentities"),
    configurationDigests: valueStringList(profile.configurationDigests, "deploymentProfile.configurationDigests"),
    secretUseAliases: valueStringList(profile.secretUseAliases, "deploymentProfile.secretUseAliases"),
    dataClass: valueString(profile.dataClass, "deploymentProfile.dataClass"),
    resourceSharing: valueString(profile.resourceSharing, "deploymentProfile.resourceSharing"),
    ...(profile.sharingPolicyDigest === undefined ? {} : { sharingPolicyDigest: valueString(profile.sharingPolicyDigest, "deploymentProfile.sharingPolicyDigest") }),
    profileDigest: valueString(profile.profileDigest, "deploymentProfile.profileDigest"),
  };
}

function safeInputSet(value: unknown): Record<string, unknown> {
  const inputSet = record(value, "inputSet");
  return {
    protocol: valueString(inputSet.protocol, "inputSet.protocol"),
    buildDefinitionDigest: valueString(inputSet.buildDefinitionDigest, "inputSet.buildDefinitionDigest"),
    dependencyDigest: valueString(inputSet.dependencyDigest, "inputSet.dependencyDigest"),
    toolchainDigest: valueString(inputSet.toolchainDigest, "inputSet.toolchainDigest"),
    environmentDigest: valueString(inputSet.environmentDigest, "inputSet.environmentDigest"),
    artifactDigests: valueStringList(inputSet.artifactDigests, "inputSet.artifactDigests"),
    inputClosureDigest: valueString(inputSet.inputClosureDigest, "inputSet.inputClosureDigest"),
  };
}

function safeMigrationPlan(value: unknown): Record<string, unknown> {
  const plan = record(value, "migrationPlan");
  return {
    protocol: valueString(plan.protocol, "migrationPlan.protocol"),
    strategy: valueString(plan.strategy, "migrationPlan.strategy"),
    ...(plan.beforeSchemaDigest === undefined ? {} : { beforeSchemaDigest: valueString(plan.beforeSchemaDigest, "migrationPlan.beforeSchemaDigest") }),
    ...(plan.afterSchemaDigest === undefined ? {} : { afterSchemaDigest: valueString(plan.afterSchemaDigest, "migrationPlan.afterSchemaDigest") }),
    compatibility: valueString(plan.compatibility, "migrationPlan.compatibility"),
    rollback: valueString(plan.rollback, "migrationPlan.rollback"),
    migrationArtifactIds: valueStringList(plan.migrationArtifactIds, "migrationPlan.migrationArtifactIds"),
    requiredEvidenceKeys: valueStringList(plan.requiredEvidenceKeys, "migrationPlan.requiredEvidenceKeys"),
    planDigest: valueString(plan.planDigest, "migrationPlan.planDigest"),
  };
}

function safePromotion(value: unknown): Record<string, unknown> {
  const promotion = record(value, "promotion");
  const previousReleaseId = promotion.previousReleaseId === null ? null : valueString(promotion.previousReleaseId, "promotion.previousReleaseId");
  const expectedCurrentReleaseId = promotion.expectedCurrentReleaseId === null ? null : valueString(promotion.expectedCurrentReleaseId, "promotion.expectedCurrentReleaseId");
  return {
    protocol: valueString(promotion.protocol, "promotion.protocol"),
    id: valueString(promotion.id, "promotion.id"),
    projectId: valueString(promotion.projectId, "promotion.projectId"),
    targetId: valueString(promotion.targetId, "promotion.targetId"),
    releaseId: valueString(promotion.releaseId, "promotion.releaseId"),
    releaseDigest: valueString(promotion.releaseDigest, "promotion.releaseDigest"),
    previousReleaseId,
    expectedCurrentReleaseId,
    state: valueString(promotion.state, "promotion.state"),
    attempt: typeof promotion.attempt === "number" && Number.isSafeInteger(promotion.attempt) ? promotion.attempt : (() => { throw new Error("coordinator_promotion.attempt_malformed"); })(),
    kind: valueString(promotion.kind, "promotion.kind"),
    ...(optionalStringValue(promotion.previewId, "promotion.previewId") ? { previewId: optionalStringValue(promotion.previewId, "promotion.previewId") } : {}),
    ...(optionalStringValue(promotion.deploymentId, "promotion.deploymentId") ? { deploymentId: optionalStringValue(promotion.deploymentId, "promotion.deploymentId") } : {}),
  };
}

function safeTarget(value: unknown): Record<string, unknown> {
  const target = record(value, "target");
  return {
    protocol: valueString(target.protocol, "target.protocol"),
    id: valueString(target.id, "target.id"),
    projectId: valueString(target.projectId, "target.projectId"),
    name: valueString(target.name, "target.name"),
    adapterId: valueString(target.adapterId, "target.adapterId"),
    state: valueString(target.state, "target.state"),
    ...(target.deploymentProfile === undefined ? {} : { deploymentProfile: safeDeploymentProfile(target.deploymentProfile) }),
  };
}

function safeRelease(value: unknown): Record<string, unknown> {
  const release = record(value, "release");
  return {
    protocol: valueString(release.protocol, "release.protocol"),
    id: valueString(release.id, "release.id"),
    projectRevisionId: valueString(release.projectRevisionId, "release.projectRevisionId"),
    status: valueString(release.status, "release.status"),
    ...(release.inputSet === undefined ? {} : { inputSet: safeInputSet(release.inputSet) }),
    ...(release.migrationPlan === undefined ? {} : { migrationPlan: safeMigrationPlan(release.migrationPlan) }),
  };
}

export function promotionRequestValue(result: Record<string, unknown>, idempotencyKey: string, surface: "rest" | "mcp" = "rest"): Record<string, unknown> {
  const value = record(result.value, "value");
  const recoveryAction = optionalStringValue(result.recoveryAction, "recoveryAction");
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    status: valueString(result.status, "status"),
    version: typeof result.version === "number" && Number.isSafeInteger(result.version) ? result.version : (() => { throw new Error("coordinator_version_malformed"); })(),
    idempotencyKey,
    credentialFree: true,
    canonicalWrite: false,
    promotion: safePromotion(value.promotion),
    target: safeTarget(value.target),
    release: safeRelease(value.release),
    ...(recoveryAction ? { recoveryAction } : {}),
    receipt: `operation=${PROMOTION_REQUEST_COMMAND}; typedSurface=${surface}; credentialFree=true; canonicalWrite=false; providerExecution=not-performed; authorityResult=projected`,
  };
}
