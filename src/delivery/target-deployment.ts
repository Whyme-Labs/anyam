import { createHash } from "node:crypto";

import type {
  Target,
  TargetChannel,
  TargetDataClass,
  TargetDeploymentProfile,
  TargetEnvironment,
  TargetResourceSharing,
} from "../kernel/contracts.ts";

export type { TargetChannel, TargetDataClass, TargetDeploymentProfile, TargetEnvironment, TargetResourceSharing } from "../kernel/contracts.ts";

export const TARGET_DEPLOYMENT_PROFILE_PROTOCOL = "anyam.target-deployment/v1" as const;

export type TargetDeploymentProfileInput = Omit<TargetDeploymentProfile, "protocol" | "profileDigest"> & {
  profileDigest?: string;
};

export class TargetDeploymentProfileError extends Error {
  readonly code: "invalid-profile" | "incomplete-profile" | "resource-conflict";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: TargetDeploymentProfileError["code"]; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "TargetDeploymentProfileError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function fail(input: ConstructorParameters<typeof TargetDeploymentProfileError>[0]): never {
  throw new TargetDeploymentProfileError(input);
}

function safeMetadata(value: string, field: string): string {
  if (/(?:bearer\s+|(?:access|refresh|api|client)[_-]?token\s*[:=]|secret\s*[:=]|password\s*[:=]|private[_ -]?key\s*[:=]|\b(?:cfat|gho|sk)-[A-Za-z0-9])/iu.test(value)) {
    fail({ code: "invalid-profile", message: `${field} contains credential-like material.`, recoveryAction: `send a digest or non-secret identity for ${field}; no credential values are accepted`, receipt: `field=${field}; credential-material=rejected` });
  }
  return value;
}

function nonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail({ code: "invalid-profile", message: `${field} must be a non-empty string.`, recoveryAction: `provide a non-empty ${field} and retry`, receipt: `field=${field}; expected=non-empty-string` });
  }
  return safeMetadata(value.trim(), field);
}

function list(values: readonly string[] | undefined, field: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    fail({ code: "invalid-profile", message: `${field} must be an array of non-empty strings.`, recoveryAction: `provide a valid ${field} list and retry`, receipt: `field=${field}; expected=string[]` });
  }
  const normalized = values.map((value) => safeMetadata(value.trim(), field));
  if (new Set(normalized).size !== normalized.length) {
    fail({ code: "invalid-profile", message: `${field} must not contain duplicate identities.`, recoveryAction: `remove duplicate ${field} entries and retry`, receipt: `field=${field}; unique=${new Set(normalized).size}; count=${normalized.length}` });
  }
  return normalized;
}

function enumValue<T extends string>(value: T | undefined, field: string, allowed: readonly T[], fallback: T): T {
  const normalized = value ?? fallback;
  if (!allowed.includes(normalized)) {
    fail({ code: "invalid-profile", message: `${field} must be one of ${allowed.join(", ")}.`, recoveryAction: `choose a supported ${field} and retry`, receipt: `field=${field}; value=${normalized}; allowed=${allowed.join(",")}` });
  }
  return normalized;
}

function profileBody(input: TargetDeploymentProfileInput): Omit<TargetDeploymentProfile, "protocol" | "profileDigest"> {
  const resourceSharing = enumValue(input.resourceSharing, "resourceSharing", ["isolated", "owner-approved"] as const, "isolated");
  const sharingPolicyDigest = input.sharingPolicyDigest === undefined ? undefined : nonEmpty(input.sharingPolicyDigest, "sharingPolicyDigest");
  if (resourceSharing === "owner-approved" && sharingPolicyDigest === undefined) {
    fail({ code: "invalid-profile", message: "owner-approved resource sharing requires a sharing policy digest.", recoveryAction: "record the owner-approved sharing policy digest or use isolated sharing", receipt: "resourceSharing=owner-approved; sharingPolicyDigest=missing" });
  }
  if (resourceSharing === "isolated" && sharingPolicyDigest !== undefined) {
    fail({ code: "invalid-profile", message: "isolated resource sharing cannot carry an approval digest.", recoveryAction: "remove sharingPolicyDigest or explicitly select owner-approved sharing", receipt: "resourceSharing=isolated; sharingPolicyDigest=unexpected" });
  }
  return {
    environment: enumValue(input.environment, "environment", ["preview", "development", "staging", "production", "custom"] as const, "custom"),
    channel: enumValue(input.channel, "channel", ["alpha", "beta", "stable", "custom"] as const, "stable"),
    audience: nonEmpty(input.audience, "audience"),
    runtimeIdentity: nonEmpty(input.runtimeIdentity, "runtimeIdentity"),
    routeIdentities: list(input.routeIdentities, "routeIdentities"),
    bindingIdentities: list(input.bindingIdentities, "bindingIdentities"),
    dataResourceIdentities: list(input.dataResourceIdentities, "dataResourceIdentities"),
    configurationDigests: list(input.configurationDigests, "configurationDigests"),
    secretUseAliases: list(input.secretUseAliases, "secretUseAliases"),
    dataClass: enumValue(input.dataClass, "dataClass", ["synthetic", "isolated", "production-shaped", "production", "custom"] as const, "custom"),
    resourceSharing,
    ...(sharingPolicyDigest ? { sharingPolicyDigest } : {}),
  };
}

export function createTargetDeploymentProfile(input: TargetDeploymentProfileInput): TargetDeploymentProfile {
  const body = profileBody(input);
  const profileDigest = digest({ protocol: TARGET_DEPLOYMENT_PROFILE_PROTOCOL, ...body });
  if (input.profileDigest !== undefined && input.profileDigest !== profileDigest) {
    fail({ code: "invalid-profile", message: "Target Deployment Profile digest does not match its fields.", recoveryAction: "recompute the profile digest from the exact profile fields and retry", receipt: `profileDigest=${input.profileDigest}; expected=${profileDigest}; digest=invalid` });
  }
  return { protocol: TARGET_DEPLOYMENT_PROFILE_PROTOCOL, ...body, profileDigest };
}

export function defaultTargetDeploymentProfile(target: Pick<Target, "id">): TargetDeploymentProfile {
  return createTargetDeploymentProfile({
    environment: "custom",
    channel: "stable",
    audience: target.id,
    runtimeIdentity: `target:${target.id}`,
    routeIdentities: [],
    bindingIdentities: [],
    dataResourceIdentities: [],
    configurationDigests: [],
    secretUseAliases: [],
    dataClass: "custom",
    resourceSharing: "isolated",
  });
}

export function targetDeploymentProfile(target: Target): TargetDeploymentProfile {
  return target.deploymentProfile ?? defaultTargetDeploymentProfile(target);
}

/**
 * A legacy Target can still be read and exported, but it must not enter a
 * Promotion without a complete deployment contract. The configuration digest
 * is the minimum proof that the Target's provider-facing configuration was
 * intentionally assembled rather than synthesized by the legacy fallback.
 */
export function assertTargetCanPromote(target: Target): TargetDeploymentProfile {
  const profile = target.deploymentProfile;
  if (!profile || profile.configurationDigests.length === 0) {
    fail({
      code: "incomplete-profile",
      message: `Target ${target.id} does not have a complete Deployment Profile.`,
      recoveryAction: "configure an explicit Target Deployment Profile with a configuration digest before requesting Promotion",
      receipt: `target=${target.id}; deploymentProfile=${profile ? "incomplete" : "missing"}; configurationDigests=${profile?.configurationDigests.length ?? 0}; promotion=blocked`,
    });
  }
  return profile;
}

export function targetDeploymentContractDigest(target: Target): string {
  const profile = targetDeploymentProfile(target);
  return digest({
    protocol: target.protocol,
    id: target.id,
    projectId: target.projectId,
    name: target.name,
    adapterId: target.adapterId,
    acceptedArtifactTypes: target.acceptedArtifactTypes,
    requiredEvidenceKeys: target.requiredEvidenceKeys,
    deploymentProfile: profile,
  });
}

function resourceIdentities(profile: TargetDeploymentProfile): readonly string[] {
  return [
    `runtime:${profile.runtimeIdentity}`,
    ...profile.routeIdentities.map((value) => `route:${value}`),
    ...profile.bindingIdentities.map((value) => `binding:${value}`),
    ...profile.dataResourceIdentities.map((value) => `data:${value}`),
    ...profile.secretUseAliases.map((value) => `secret-use:${value}`),
  ];
}

export function assertTargetResourceIsolation(input: { existing: readonly Target[]; candidate: Target }): void {
  const candidateProfile = targetDeploymentProfile(input.candidate);
  const candidateResources = new Set(resourceIdentities(candidateProfile));
  for (const existing of input.existing) {
    if (existing.id === input.candidate.id) continue;
    const existingProfile = targetDeploymentProfile(existing);
    const overlap = resourceIdentities(existingProfile).filter((identity) => candidateResources.has(identity));
    if (overlap.length === 0) continue;
    const matchingOwnerApproval = candidateProfile.resourceSharing === "owner-approved"
      && existingProfile.resourceSharing === "owner-approved"
      && candidateProfile.sharingPolicyDigest !== undefined
      && candidateProfile.sharingPolicyDigest === existingProfile.sharingPolicyDigest;
    if (matchingOwnerApproval) continue;
    fail({
      code: "resource-conflict",
      message: `Target ${input.candidate.id} shares resource identity with Target ${existing.id} without one matching owner-approved sharing policy.`,
      recoveryAction: "use an environment-specific resource identity or record matching owner-approved sharing policy digests on both Targets",
      receipt: `candidate=${input.candidate.id}; existing=${existing.id}; overlap=${overlap.join(",")}; sharingPolicyMatch=${matchingOwnerApproval}; isolation=blocked`,
    });
  }
}
