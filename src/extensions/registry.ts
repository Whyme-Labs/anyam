import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type ExtensionEvent,
  type ExtensionEventKind,
  type ExtensionInstallation,
  type ExtensionKind,
  type ExtensionLifecycle,
  type ExtensionManifest,
  type ExtensionScope,
  type ExtensionTrust,
  type ResourceRef,
} from "../kernel/contracts.ts";
import {
  type AuthenticationStrength,
  type Capability,
  type PolicyExplanation,
  type PolicyEvaluationInput,
  type RealmIdentityPolicy,
} from "../identity/realm.ts";

export type ExtensionAuthorization = {
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId: string;
  grantId: string;
  resource: ResourceRef;
  modelProvider?: string;
  requiredAuthStrength?: AuthenticationStrength;
  authorityClass?: PolicyEvaluationInput["authorityClass"];
  promotionId?: string;
  approval?: PolicyEvaluationInput["approval"];
};

export type RegisterExtensionInput = {
  manifest: ExtensionManifest;
  packageDigest: string;
};

export type InstallExtensionInput = {
  manifestId: string;
  manifestVersion: string;
  packageDigest: string;
  scope: ExtensionScope;
  grantedEffects: readonly string[];
  grantedCapabilities: readonly Capability[];
  authorization: ExtensionAuthorization;
  receipt?: string;
  replacesInstallationId?: string;
  providerMigrationFrom?: string;
};

export type ExtensionTransitionInput = {
  installationId: string;
  authorization: ExtensionAuthorization;
  reason: string;
};

export type ReplaceExtensionInput = {
  installationId: string;
  replacement: Omit<InstallExtensionInput, "replacesInstallationId" | "providerMigrationFrom">;
  authorization: ExtensionAuthorization;
  reason: string;
  providerMigration?: boolean;
};

export type InvokeExtensionInput = {
  installationId: string;
  requestedEffects: readonly string[];
  requestedCapabilities: readonly Capability[];
  resource: ResourceRef;
  authorization: ExtensionAuthorization;
  operation?: string;
};

export type ExtensionInvocationStatus = "allowed" | "blocked" | "proposal";

export type ExtensionInvocationResult = {
  status: ExtensionInvocationStatus;
  installationId: string;
  requestedEffects: readonly string[];
  requestedCapabilities: readonly Capability[];
  policyExplanations: readonly PolicyExplanation[];
  nextAction: string;
  receipt: string;
};

export type ExtensionRegistrySnapshot = {
  manifests: readonly ExtensionManifest[];
  installations: readonly ExtensionInstallation[];
  events: readonly ExtensionEvent[];
};

export type ExtensionRegistryOptions = {
  realm: RealmIdentityPolicy;
  now?: () => Date;
  kernelCompatibility?: readonly string[];
};

export type ExtensionErrorCode =
  | "invalid-input"
  | "manifest-invalid"
  | "manifest-not-found"
  | "digest-mismatch"
  | "compatibility-mismatch"
  | "trust-boundary"
  | "installation-not-found"
  | "scope-mismatch"
  | "grant-widening"
  | "policy-denied"
  | "lifecycle-blocked"
  | "lineage-invalid";

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly explanation: PolicyExplanation | undefined;

  constructor(input: {
    code: ExtensionErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
    explanation?: PolicyExplanation;
  }) {
    super(input.message);
    this.name = "ExtensionError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
    this.explanation = input.explanation;
  }
}

const HIGH_RISK_EFFECTS = new Set([
  "canonical.write",
  "change.approve",
  "identity.manage",
  "policy.manage",
  "secret.value.read",
  "target-promote",
  "target.promote",
]);

const KERNEL_AUTHORITY_CAPABILITIES = new Set<Capability>([
  "change.approve",
  "landing.request",
  "policy.manage",
  "identity.manage",
  "target.promote",
]);

const ALL_EXTENSION_KINDS: readonly ExtensionKind[] = [
  "repository-driver",
  "action",
  "verifier",
  "target-adapter",
  "project-experience",
  "ide",
  "agent-skill",
  "app",
];

const ALL_TRUST_LEVELS: readonly ExtensionTrust[] = ["first-party", "verified", "unverified"];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function requireText(value: string, field: string, code: ExtensionErrorCode = "invalid-input"): void {
  if (value.trim().length === 0) {
    throw new ExtensionError({
      code,
      message: `${field} must not be empty.`,
      affectedObject: field,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function unique(values: readonly string[], field: string): readonly string[] {
  if (values.some((value) => value.trim().length === 0)) {
    throw new ExtensionError({
      code: "invalid-input",
      message: `${field} contains an empty value.`,
      affectedObject: field,
      recoveryAction: `remove empty ${field} entries and retry`,
      receipt: `field=${field}; count=${values.length}`,
    });
  }
  const distinct = [...new Set(values)];
  if (distinct.length !== values.length) {
    throw new ExtensionError({
      code: "invalid-input",
      message: `${field} contains duplicate values.`,
      affectedObject: field,
      recoveryAction: `deduplicate ${field} and retry`,
      receipt: `field=${field}; count=${values.length}; unique=${distinct.length}`,
    });
  }
  return distinct;
}

function assertDigest(value: string, field: string): void {
  requireText(value, field, "digest-mismatch");
  if (!value.startsWith("sha256:")) {
    throw new ExtensionError({
      code: "digest-mismatch",
      message: `${field} must be an explicit sha256 digest.`,
      affectedObject: field,
      recoveryAction: `publish the package with a sha256 digest and retry`,
      receipt: `field=${field}; value=${value}`,
    });
  }
}

function manifestKey(id: string, version: string, digest: string): string {
  return `${id}@${version}#${digest}`;
}

function scopeResource(scope: ExtensionScope): ResourceRef {
  return {
    realmId: scope.realmId,
    ...(scope.kind === "organization" ? { organizationId: scope.organizationId } : {}),
    ...(scope.kind === "project" && scope.organizationId !== undefined ? { organizationId: scope.organizationId } : {}),
    ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
  };
}

function scopeContains(scope: ExtensionScope, resource: ResourceRef): boolean {
  if (scope.realmId !== resource.realmId) return false;
  if (scope.kind === "realm") return true;
  if (resource.organizationId !== scope.organizationId) return false;
  return scope.kind === "organization" || resource.projectId === scope.projectId;
}

function actorRef(authorization: ExtensionAuthorization): ActorRef {
  return {
    principalId: authorization.principalId,
    actorId: authorization.actorId,
    sessionId: authorization.sessionId,
    clientId: authorization.clientId,
  };
}

function highRisk(values: readonly string[]): readonly string[] {
  return values.filter((value) => HIGH_RISK_EFFECTS.has(value));
}

function capabilityAsString(value: Capability): string {
  return value;
}

function asPolicyInput(
  authorization: ExtensionAuthorization,
  input: { operation: string; capability: Capability; resource: ResourceRef; effect?: string },
): PolicyEvaluationInput {
  return {
    operation: input.operation,
    capability: input.capability,
    principalId: authorization.principalId,
    actorId: authorization.actorId,
    clientId: authorization.clientId,
    sessionId: authorization.sessionId,
    taskId: authorization.taskId,
    grantId: authorization.grantId,
    resource: input.resource,
    ...(input.resource.sourceSpaceId ? { sourceSpaceId: input.resource.sourceSpaceId } : {}),
    ...(input.effect ? { effect: input.effect } : {}),
    ...(authorization.modelProvider ? { modelProvider: authorization.modelProvider } : {}),
    ...(authorization.requiredAuthStrength ? { requiredAuthStrength: authorization.requiredAuthStrength } : {}),
    ...(authorization.authorityClass ? { authorityClass: authorization.authorityClass } : {}),
    ...(authorization.promotionId ? { promotionId: authorization.promotionId } : {}),
    ...(authorization.approval ? { approval: authorization.approval } : {}),
    protected: true,
  };
}

export class ExtensionRegistry {
  private readonly manifests = new Map<string, ExtensionManifest>();
  private readonly installations = new Map<string, ExtensionInstallation>();
  private readonly events: ExtensionEvent[] = [];
  private readonly now: () => Date;
  private readonly kernelCompatibility: readonly string[];

  constructor(private readonly options: ExtensionRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.kernelCompatibility = unique(options.kernelCompatibility ?? [CONTRACT_VERSIONS.kernel], "kernelCompatibility");
  }

  snapshot(): ExtensionRegistrySnapshot {
    return {
      manifests: [...this.manifests.values()].map(clone),
      installations: [...this.installations.values()].map(clone),
      events: this.events.map(clone),
    };
  }

  getManifest(input: { id: string; version?: string; digest?: string }): ExtensionManifest | undefined {
    const candidates = [...this.manifests.values()].filter((manifest) => manifest.id === input.id);
    const versioned = input.version ? candidates.filter((manifest) => manifest.version === input.version) : candidates;
    const digested = input.digest ? versioned.filter((manifest) => manifest.digest === input.digest) : versioned;
    return digested[0] ? clone(digested[0]) : undefined;
  }

  getInstallation(installationId: string): ExtensionInstallation | undefined {
    const installation = this.installations.get(installationId);
    return installation ? clone(installation) : undefined;
  }

  registerManifest(input: RegisterExtensionInput): ExtensionManifest {
    const manifest = input.manifest;
    requireText(manifest.id, "manifest.id");
    requireText(manifest.name, "manifest.name");
    requireText(manifest.version, "manifest.version");
    requireText(manifest.source, "manifest.source");
    requireText(manifest.provenance.source, "manifest.provenance.source");
    requireText(manifest.provenance.publisher, "manifest.provenance.publisher");
    requireText(manifest.provenance.receipt, "manifest.provenance.receipt");
    assertDigest(manifest.digest, "manifest.digest");
    assertDigest(input.packageDigest, "packageDigest");
    if (manifest.digest !== input.packageDigest) {
      throw new ExtensionError({
        code: "digest-mismatch",
        message: `Extension package digest does not match the manifest pin for ${manifest.id}@${manifest.version}.`,
        affectedObject: manifest.id,
        recoveryAction: "fetch the exact package named by the manifest digest or publish a new manifest",
        receipt: `manifest=${manifest.digest}; package=${input.packageDigest}`,
      });
    }
    if (manifest.protocol !== CONTRACT_VERSIONS.extension || !ALL_EXTENSION_KINDS.includes(manifest.kind)) {
      throw new ExtensionError({
        code: "manifest-invalid",
        message: `Extension ${manifest.id} does not declare a supported anyam.extension/v1 kind.`,
        affectedObject: manifest.id,
        recoveryAction: "publish a manifest with a supported extension kind and protocol",
        receipt: `protocol=${manifest.protocol}; kind=${manifest.kind}`,
      });
    }
    if (!ALL_TRUST_LEVELS.includes(manifest.trust)) {
      throw new ExtensionError({
        code: "manifest-invalid",
        message: `Extension ${manifest.id} declares an unknown trust level.`,
        affectedObject: manifest.id,
        recoveryAction: "declare first-party, verified, or unverified trust",
        receipt: `trust=${manifest.trust}`,
      });
    }
    const compatibility = unique(manifest.compatibility, "manifest.compatibility");
    const missingCompatibility = this.kernelCompatibility.filter((version) => !compatibility.includes(version));
    if (missingCompatibility.length > 0 || !compatibility.includes(CONTRACT_VERSIONS.extension)) {
      throw new ExtensionError({
        code: "compatibility-mismatch",
        message: `Extension ${manifest.id}@${manifest.version} is not compatible with the active Anyam contracts.`,
        affectedObject: manifest.id,
        recoveryAction: `publish a manifest compatible with ${[...this.kernelCompatibility, CONTRACT_VERSIONS.extension].join(", ")}`,
        receipt: `missing=${[...missingCompatibility, ...(compatibility.includes(CONTRACT_VERSIONS.extension) ? [] : [CONTRACT_VERSIONS.extension])].join(",")}`,
      });
    }
    const requestedEffects = unique(manifest.requestedEffects, "manifest.requestedEffects");
    const requestedCapabilities = unique(manifest.requestedCapabilities, "manifest.requestedCapabilities");
    const unverifiedHighRisk = manifest.trust === "unverified" ? highRisk([...requestedEffects, ...requestedCapabilities]) : [];
    const lifecycle: ExtensionLifecycle = unverifiedHighRisk.length > 0
      ? "blocked"
      : manifest.lifecycle === "deprecated" || manifest.lifecycle === "revoked"
        ? manifest.lifecycle
        : "proposed";
    const normalized: ExtensionManifest = {
      ...clone(manifest),
      lifecycle,
      source: manifest.source,
      requestedEffects,
      requestedCapabilities,
      compatibility,
      provenance: { ...clone(manifest.provenance), source: manifest.source },
    };
    const key = manifestKey(normalized.id, normalized.version, normalized.digest);
    const existing = this.manifests.get(key);
    if (existing) return clone(existing);
    if ([...this.manifests.values()].some((candidate) => candidate.id === normalized.id && candidate.version === normalized.version && candidate.digest !== normalized.digest)) {
      throw new ExtensionError({
        code: "digest-mismatch",
        message: `Extension ${normalized.id}@${normalized.version} is already registered with another digest.`,
        affectedObject: normalized.id,
        recoveryAction: "publish a new version instead of mutating an existing package pin",
        receipt: "immutable extension version pin",
      });
    }
    this.manifests.set(key, normalized);
    this.event({
      kind: lifecycle === "blocked" ? "blocked" : "registered",
      manifestId: normalized.id,
      reason: lifecycle === "blocked" ? `unverified extension requests high-risk effects: ${unverifiedHighRisk.join(", ")}` : "manifest accepted for review",
      receipt: `manifest=${normalized.id}@${normalized.version}; digest=${normalized.digest}; trust=${normalized.trust}`,
    });
    return clone(normalized);
  }

  install(input: InstallExtensionInput): ExtensionInstallation {
    const manifest = this.getManifest({ id: input.manifestId, version: input.manifestVersion, digest: input.packageDigest });
    if (!manifest) this.fail("manifest-not-found", input.manifestId, "install the exact registered manifest and package digest before granting it", `manifest=${input.manifestId}@${input.manifestVersion}; digest=${input.packageDigest}`);
    if (manifest.lifecycle === "blocked" || manifest.lifecycle === "deprecated" || manifest.lifecycle === "revoked") this.fail("lifecycle-blocked", manifest.id, `use an enabled, non-deprecated extension manifest or register a replacement`, `lifecycle=${manifest.lifecycle}`);
    this.validateScope(input.scope);
    if (!scopeContains(input.scope, input.authorization.resource)) this.fail("scope-mismatch", manifest.id, "request installation against a Resource inside the declared Realm/Organization/Project scope", `scope=${input.scope.kind}; resource-project=${input.authorization.resource.projectId ?? "none"}`);
    const grantedEffects = unique(input.grantedEffects, "grantedEffects");
    const grantedCapabilities = unique(input.grantedCapabilities.map(capabilityAsString), "grantedCapabilities");
    const missingEffects = grantedEffects.filter((effect) => !manifest.requestedEffects.includes(effect));
    const missingCapabilities = grantedCapabilities.filter((capability) => !manifest.requestedCapabilities.includes(capability));
    if (missingEffects.length > 0 || missingCapabilities.length > 0) {
      this.fail("grant-widening", manifest.id, "grant only effects and capabilities declared by the pinned manifest", `missing-effects=${missingEffects.join(",")}; missing-capabilities=${missingCapabilities.join(",")}`);
    }
    if (grantedEffects.includes("canonical.write") || grantedCapabilities.includes("landing.request") && grantedEffects.includes("canonical.write")) {
      this.fail("trust-boundary", manifest.id, "extensions publish a proposal; trusted Landing authority performs canonical writes", `canonical-write=${grantedEffects.includes("canonical.write")}`);
    }
    const resource = scopeResource(input.scope);
    this.authorize(input.authorization, { capability: "extension.install", operation: "extension.install", resource, effect: "extension.install" });
    for (const capability of grantedCapabilities as Capability[]) {
      const effect = grantedEffects.find((candidate) => candidate === capability || candidate.replaceAll("-", ".") === capability) ?? capability;
      this.authorize(input.authorization, { capability, operation: `extension.grant.${capability}`, resource: input.authorization.resource, effect });
    }
    const installedAt = nowIso(this.now);
    const installation: ExtensionInstallation = {
      protocol: CONTRACT_VERSIONS.extensionInstallation,
      id: opaqueId("extension-installation"),
      manifestId: manifest.id,
      manifestVersion: manifest.version,
      manifestDigest: manifest.digest,
      scope: clone(input.scope),
      lifecycle: "enabled",
      grantedEffects,
      grantedCapabilities,
      grantId: input.authorization.grantId,
      policyVersion: this.options.realm.realm.policyVersion,
      authorizationEpoch: this.options.realm.realm.authorizationEpoch,
      installedBy: actorRef(input.authorization),
      installedAt,
      lineageId: input.replacesInstallationId ? (this.installations.get(input.replacesInstallationId)?.lineageId ?? opaqueId("extension-lineage")) : opaqueId("extension-lineage"),
      ...(input.replacesInstallationId ? { replacesInstallationId: input.replacesInstallationId } : {}),
      ...(input.providerMigrationFrom ? { providerMigrationFrom: input.providerMigrationFrom } : {}),
      receipt: input.receipt ?? `manifest=${manifest.id}@${manifest.version}; digest=${manifest.digest}; scope=${input.scope.kind}; policy=${this.options.realm.realm.policyVersion}; epoch=${this.options.realm.realm.authorizationEpoch}`,
    };
    this.installations.set(installation.id, installation);
    this.event({ kind: "install-requested", installationId: installation.id, manifestId: manifest.id, actor: actorRef(input.authorization), reason: "extension installation authorized against current Capability Grant and policy", receipt: `installation=${installation.id}; grant=intersection` });
    this.event({ kind: "installed", installationId: installation.id, manifestId: manifest.id, actor: actorRef(input.authorization), reason: "exact package digest and scoped grant recorded", receipt: installation.receipt });
    this.event({ kind: "enabled", installationId: installation.id, manifestId: manifest.id, actor: actorRef(input.authorization), reason: "installation enabled only after policy intersection", receipt: `installation=${installation.id}; lifecycle=enabled` });
    return clone(installation);
  }

  replace(input: ReplaceExtensionInput): ExtensionInstallation {
    const current = this.requireInstallation(input.installationId);
    const currentManifest = this.requireManifest(current.manifestId, current.manifestVersion, current.manifestDigest);
    if (!scopeContains(current.scope, input.authorization.resource)) this.fail("scope-mismatch", current.id, "replace an extension from the same or narrower installation scope", `current-scope=${current.scope.kind}; resource-project=${input.authorization.resource.projectId ?? "none"}`);
    this.authorize(input.authorization, { capability: "extension.manage", operation: "extension.replace", resource: scopeResource(current.scope), effect: "extension.replace" });
    if (input.replacement.scope.kind !== current.scope.kind || input.replacement.scope.realmId !== current.scope.realmId) this.fail("scope-mismatch", current.id, "replacement must remain in the same Realm and scope class", `current=${current.scope.kind}; replacement=${input.replacement.scope.kind}`);
    const replacement = this.install({
      ...input.replacement,
      scope: input.replacement.scope,
      authorization: input.authorization,
      replacesInstallationId: current.id,
      ...(input.providerMigration ? { providerMigrationFrom: currentManifest.source } : {}),
    });
    current.lifecycle = "replaced";
    this.installations.set(current.id, current);
    this.event({ kind: input.providerMigration ? "provider-migrated" : "replaced", installationId: current.id, manifestId: current.manifestId, previousInstallationId: current.id, nextInstallationId: replacement.id, actor: actorRef(input.authorization), reason: input.reason, receipt: `previous=${current.id}; next=${replacement.id}; lineage=${replacement.lineageId}` });
    return clone(replacement);
  }

  migrateProvider(input: Omit<ReplaceExtensionInput, "providerMigration">): ExtensionInstallation {
    return this.replace({ ...input, providerMigration: true });
  }

  deprecate(input: ExtensionTransitionInput): ExtensionInstallation {
    return this.transition(input, "deprecated");
  }

  suspend(input: ExtensionTransitionInput): ExtensionInstallation {
    return this.transition(input, "suspended");
  }

  revoke(input: ExtensionTransitionInput): ExtensionInstallation {
    return this.transition(input, "revoked");
  }

  invoke(input: InvokeExtensionInput): ExtensionInvocationResult {
    const installation = this.requireInstallation(input.installationId);
    const manifest = this.requireManifest(installation.manifestId, installation.manifestVersion, installation.manifestDigest);
    const requestedEffects = unique(input.requestedEffects, "requestedEffects");
    const requestedCapabilities = unique(input.requestedCapabilities.map(capabilityAsString), "requestedCapabilities") as Capability[];
    if (!scopeContains(installation.scope, input.resource)) {
      return this.blockedInvocation(input, installation, requestedEffects, requestedCapabilities, "scope-mismatch", "invoke only against a resource inside the installation scope");
    }
    if (installation.lifecycle !== "enabled") {
      return this.blockedInvocation(input, installation, requestedEffects, requestedCapabilities, "lifecycle-blocked", `installation lifecycle is ${installation.lifecycle}; use an enabled replacement`);
    }
    if (requestedCapabilities.includes("secret.value.read")) {
      return this.blockedInvocation(input, installation, requestedEffects, requestedCapabilities, "trust-boundary", "Secret Use may invoke a brokered operation; extension processes never receive raw secret values");
    }
    const missingEffects = requestedEffects.filter((effect) => !installation.grantedEffects.includes(effect) || !manifest.requestedEffects.includes(effect));
    const missingCapabilities = requestedCapabilities.filter((capability) => !installation.grantedCapabilities.includes(capability) || !manifest.requestedCapabilities.includes(capability));
    if (missingEffects.length > 0 || missingCapabilities.length > 0) {
      return this.blockedInvocation(input, installation, requestedEffects, requestedCapabilities, "grant-widening", `missing granted effects=${missingEffects.join(",")}; capabilities=${missingCapabilities.join(",")}`);
    }
    const explanations: PolicyExplanation[] = [];
    for (const capability of requestedCapabilities) {
      try {
        const effect = requestedEffects.find((candidate) => candidate === capability || candidate.replaceAll("-", ".") === capability);
        explanations.push(this.authorize(input.authorization, {
          capability,
          operation: input.operation ?? `extension.invoke.${capability}`,
          resource: input.resource,
          ...(effect ? { effect } : {}),
        }));
      } catch (error) {
        if (error instanceof ExtensionError && error.explanation) explanations.push(error.explanation);
        return this.blockedInvocation(input, installation, requestedEffects, requestedCapabilities, "policy-denied", error instanceof Error ? error.message : "policy denied the extension invocation", explanations);
      }
    }
    const proposal = requestedCapabilities.some((capability) => KERNEL_AUTHORITY_CAPABILITIES.has(capability));
    const status: ExtensionInvocationStatus = proposal ? "proposal" : "allowed";
    const nextAction = proposal
      ? "submit the normalized proposal to the trusted Anyam authority; the extension cannot apply the protected transition"
      : "execute only the declared effect inside the assigned Runner or provider boundary";
    const receipt = `installation=${installation.id}; manifest=${manifest.id}@${manifest.version}; digest=${manifest.digest}; status=${status}; policy=${this.options.realm.realm.policyVersion}; epoch=${this.options.realm.realm.authorizationEpoch}`;
    this.event({ kind: proposal ? "invocation-proposed" : "invoked", installationId: installation.id, manifestId: manifest.id, actor: actorRef(input.authorization), reason: nextAction, receipt });
    return { status, installationId: installation.id, requestedEffects, requestedCapabilities, policyExplanations: explanations, nextAction, receipt };
  }

  private transition(input: ExtensionTransitionInput, lifecycle: Extract<ExtensionLifecycle, "deprecated" | "suspended" | "revoked">): ExtensionInstallation {
    const installation = this.requireInstallation(input.installationId);
    this.authorize(input.authorization, { capability: "extension.manage", operation: `extension.${lifecycle}`, resource: scopeResource(installation.scope), effect: `extension.${lifecycle}` });
    if (installation.lifecycle === "replaced" || installation.lifecycle === "revoked") this.fail("lifecycle-blocked", installation.id, "transition only an active installation and preserve its prior lineage", `lifecycle=${installation.lifecycle}`);
    installation.lifecycle = lifecycle;
    this.installations.set(installation.id, installation);
    this.event({ kind: lifecycle, installationId: installation.id, manifestId: installation.manifestId, actor: actorRef(input.authorization), reason: input.reason, receipt: `installation=${installation.id}; lifecycle=${lifecycle}; lineage=${installation.lineageId}` });
    return clone(installation);
  }

  private validateScope(scope: ExtensionScope): void {
    requireText(scope.realmId, "scope.realmId");
    if (scope.kind === "organization") requireText(scope.organizationId, "scope.organizationId");
    if (scope.kind === "project") {
      requireText(scope.projectId, "scope.projectId");
      if (scope.organizationId !== undefined) requireText(scope.organizationId, "scope.organizationId");
    }
    if (scope.realmId !== this.options.realm.realm.id) this.fail("scope-mismatch", scope.realmId, "install extensions only in the active Realm", `active-realm=${this.options.realm.realm.id}; requested=${scope.realmId}`);
  }

  private requireManifest(id: string, version: string, digest: string): ExtensionManifest {
    const manifest = this.getManifest({ id, version, digest });
    if (!manifest) this.fail("manifest-not-found", id, "restore the exact registered manifest before using this installation", `manifest=${id}@${version}; digest=${digest}`);
    return manifest;
  }

  private requireInstallation(id: string): ExtensionInstallation {
    const installation = this.installations.get(id);
    if (!installation) this.fail("installation-not-found", id, "inspect the active Extension Installation and retry", `installation=${id}; present=false`);
    return installation;
  }

  private authorize(authorization: ExtensionAuthorization, input: { operation: string; capability: Capability; resource: ResourceRef; effect?: string }): PolicyExplanation {
    const result = this.options.realm.evaluate(asPolicyInput(authorization, input));
    if (!result.allowed) {
      throw new ExtensionError({
        code: "policy-denied",
        message: `Extension operation ${input.operation} is ${result.explanation.decision}; no protected operation was performed.`,
        affectedObject: input.resource.projectId ?? input.resource.realmId,
        recoveryAction: result.explanation.remediation,
        receipt: `policy=${result.explanation.policyVersion}; epoch=${result.explanation.authorizationEpoch}; decision=${result.explanation.decision}`,
        explanation: result.explanation,
      });
    }
    return result.explanation;
  }

  private blockedInvocation(input: InvokeExtensionInput, installation: ExtensionInstallation, requestedEffects: readonly string[], requestedCapabilities: readonly Capability[], code: ExtensionErrorCode, nextAction: string, explanations: readonly PolicyExplanation[] = []): ExtensionInvocationResult {
    const receipt = `installation=${installation.id}; status=blocked; code=${code}; requested-effects=${requestedEffects.join(",")}; requested-capabilities=${requestedCapabilities.join(",")}`;
    this.event({ kind: "invocation-blocked", installationId: installation.id, manifestId: installation.manifestId, actor: actorRef(input.authorization), reason: nextAction, receipt });
    return { status: "blocked", installationId: installation.id, requestedEffects, requestedCapabilities, policyExplanations: [...explanations], nextAction, receipt };
  }

  private event(input: { kind: ExtensionEventKind; manifestId: string; installationId?: string; previousInstallationId?: string; nextInstallationId?: string; actor?: ActorRef; reason: string; receipt: string }): void {
    this.events.push({
      protocol: CONTRACT_VERSIONS.extensionEvent,
      id: opaqueId("extension-event"),
      kind: input.kind,
      ...(input.installationId ? { installationId: input.installationId } : {}),
      manifestId: input.manifestId,
      ...(input.previousInstallationId ? { previousInstallationId: input.previousInstallationId } : {}),
      ...(input.nextInstallationId ? { nextInstallationId: input.nextInstallationId } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      occurredAt: nowIso(this.now),
      reason: input.reason,
      receipt: input.receipt,
    });
  }

  private fail(code: ExtensionErrorCode, affectedObject: string, recoveryAction: string, receipt: string): never {
    throw new ExtensionError({
      code,
      message: `${code} for ${affectedObject}; receipt=${receipt}; fix=${recoveryAction}.`,
      affectedObject,
      recoveryAction,
      receipt,
    });
  }
}
