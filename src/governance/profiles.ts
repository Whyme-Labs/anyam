import { createHash } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type GovernanceControl,
  type GovernanceControlEvidence,
  type GovernanceControlObservation,
  type GovernanceEvaluation,
  type GovernanceProfile,
  type GovernanceProfileExport,
  type GovernanceScope,
  type ResourceRef,
} from "../kernel/contracts.ts";
import {
  RealmIdentityError,
  type Capability,
  type PolicyExplanation,
  type PolicyEvaluationInput,
  type RealmIdentityPolicy,
} from "../identity/realm.ts";
import type { ExtensionAuthorization } from "../extensions/registry.ts";

export type GovernanceProfileAuthorization = ExtensionAuthorization;

export type CreateGovernanceProfileInput = Omit<GovernanceProfile, "protocol" | "digest" | "lifecycle"> & {
  lifecycle?: GovernanceProfile["lifecycle"];
};

export type ActivateGovernanceProfileInput = {
  profileId: string;
  scope: GovernanceScope;
  authorization: GovernanceProfileAuthorization;
};

export type EvaluateGovernanceProfileInput = {
  profileId: string;
  scope: GovernanceScope;
  observations: readonly GovernanceControlObservation[];
  authorization: GovernanceProfileAuthorization;
};

export type ReplayGovernanceProfileInput = {
  scope: GovernanceScope;
  authorization: GovernanceProfileAuthorization;
  observations?: readonly GovernanceControlObservation[];
};

export type GovernanceProfileApplication = {
  id: string;
  profileId: string;
  profileDigest: string;
  scope: GovernanceScope;
  policyVersion: string;
  authorizationEpoch: number;
  status: "active" | "retired";
  activatedBy: GovernanceProfileAuthorization["principalId"];
  activatedAt: string;
  receipt: string;
};

export type GovernanceProfileSnapshot = {
  profiles: readonly GovernanceProfile[];
  applications: readonly GovernanceProfileApplication[];
  evidence: readonly GovernanceControlEvidence[];
  evaluations: readonly GovernanceEvaluation[];
};

export type GovernanceErrorCode =
  | "invalid-input"
  | "profile-invalid"
  | "profile-not-found"
  | "profile-digest-mismatch"
  | "scope-mismatch"
  | "profile-inactive"
  | "policy-denied"
  | "export-invalid";

export class GovernanceProfileError extends Error {
  readonly code: GovernanceErrorCode;
  readonly affectedObject: string;
  readonly recoveryAction: string;
  readonly receipt: string;
  readonly explanation: PolicyExplanation | undefined;

  constructor(input: {
    code: GovernanceErrorCode;
    message: string;
    affectedObject: string;
    recoveryAction: string;
    receipt: string;
    explanation?: PolicyExplanation;
  }) {
    super(input.message);
    this.name = "GovernanceProfileError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
    this.explanation = input.explanation;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableValue(nested)]));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function profileDigestInput(profile: Omit<GovernanceProfile, "digest">): unknown {
  return {
    protocol: profile.protocol,
    id: profile.id,
    name: profile.name,
    version: profile.version,
    controls: profile.controls,
    provenance: profile.provenance,
  };
}

export function governanceProfileDigest(profile: GovernanceProfile | Omit<GovernanceProfile, "digest">): string {
  return digest(profileDigestInput(profile));
}

export function createGovernanceProfile(input: CreateGovernanceProfileInput): GovernanceProfile {
  const profileWithoutDigest: Omit<GovernanceProfile, "digest"> = {
    protocol: CONTRACT_VERSIONS.governanceProfile,
    id: input.id,
    name: input.name,
    version: input.version,
    scope: clone(input.scope),
    controls: input.controls.map(clone),
    provenance: clone(input.provenance),
    policyVersion: input.policyVersion,
    lifecycle: input.lifecycle ?? "draft",
    receipt: input.receipt,
  };
  return { ...profileWithoutDigest, digest: governanceProfileDigest(profileWithoutDigest) };
}

function requireText(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new GovernanceProfileError({
      code: "invalid-input",
      message: `${field} must not be empty.`,
      affectedObject: field,
      recoveryAction: `provide a non-empty ${field} and retry`,
      receipt: `field=${field}; present=false`,
    });
  }
}

function unique(values: readonly string[], field: string): readonly string[] {
  if (values.some((value) => value.trim().length === 0) || new Set(values).size !== values.length) {
    throw new GovernanceProfileError({
      code: "invalid-input",
      message: `${field} must contain distinct non-empty values.`,
      affectedObject: field,
      recoveryAction: `deduplicate and populate ${field} before retrying`,
      receipt: `field=${field}; count=${values.length}; unique=${new Set(values).size}`,
    });
  }
  return [...values];
}

function validateScope(scope: GovernanceScope, realmId: string): void {
  requireText(scope.realmId, "scope.realmId");
  if (scope.organizationId !== undefined) requireText(scope.organizationId, "scope.organizationId");
  if (scope.projectId !== undefined) requireText(scope.projectId, "scope.projectId");
  if (scope.realmId !== realmId) {
    throw new GovernanceProfileError({
      code: "scope-mismatch",
      message: `Governance Profile scope ${scope.realmId} belongs to another Realm.`,
      affectedObject: scope.realmId,
      recoveryAction: `replay or activate the profile in Realm ${realmId}`,
      receipt: `active-realm=${realmId}; requested-realm=${scope.realmId}`,
    });
  }
}

function scopeResource(scope: GovernanceScope): ResourceRef {
  return {
    realmId: scope.realmId,
    ...(scope.organizationId !== undefined ? { organizationId: scope.organizationId } : {}),
    ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
  };
}

function scopeKey(scope: GovernanceScope): string {
  return `${scope.realmId}|${scope.organizationId ?? ""}|${scope.projectId ?? ""}`;
}

function controlMap(controls: readonly GovernanceControl[]): Map<string, GovernanceControl> {
  const result = new Map<string, GovernanceControl>();
  for (const control of controls) {
    requireText(control.id, "control.id");
    requireText(control.title, `control.${control.id}.title`);
    requireText(control.requirement, `control.${control.id}.requirement`);
    requireText(control.owner, `control.${control.id}.owner`);
    unique(control.evidenceKinds, `control.${control.id}.evidenceKinds`);
    if (result.has(control.id)) {
      throw new GovernanceProfileError({
        code: "profile-invalid",
        message: `Governance Profile contains duplicate control ${control.id}.`,
        affectedObject: control.id,
        recoveryAction: "give every Governance Control a unique stable identifier",
        receipt: `control=${control.id}; duplicate=true`,
      });
    }
    result.set(control.id, clone(control));
  }
  if (result.size === 0) {
    throw new GovernanceProfileError({
      code: "profile-invalid",
      message: "Governance Profile must declare at least one control.",
      affectedObject: "controls",
      recoveryAction: "declare the first versioned control before activating the Profile",
      receipt: "controls=0",
    });
  }
  return result;
}

function asPolicyInput(authorization: GovernanceProfileAuthorization, capability: Capability, resource: ResourceRef, operation: string): PolicyEvaluationInput {
  return {
    operation,
    capability,
    principalId: authorization.principalId,
    actorId: authorization.actorId,
    clientId: authorization.clientId,
    sessionId: authorization.sessionId,
    taskId: authorization.taskId,
    grantId: authorization.grantId,
    resource,
    ...(resource.sourceSpaceId ? { sourceSpaceId: resource.sourceSpaceId } : {}),
    ...(authorization.modelProvider ? { modelProvider: authorization.modelProvider } : {}),
    ...(authorization.requiredAuthStrength ? { requiredAuthStrength: authorization.requiredAuthStrength } : {}),
    protected: true,
  };
}

function observationsDigest(observations: readonly GovernanceControlObservation[]): string {
  return digest(observations.map(clone));
}

function exportDigest(bundle: Omit<GovernanceProfileExport, "integrityDigest">): string {
  return digest(bundle);
}

function credentialField(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = credentialField(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower !== "credentialfree" && /token|password|secret|credential|privatekey|accesskey/.test(lower)) return key;
    const found = credentialField(nested);
    if (found) return found;
  }
  return undefined;
}

export function verifyGovernanceProfileExport(bundle: GovernanceProfileExport): GovernanceProfileExport {
  if (bundle.protocol !== CONTRACT_VERSIONS.governanceProfileExport || bundle.version !== "v1" || bundle.credentialFree !== true) {
    throw new GovernanceProfileError({
      code: "export-invalid",
      message: "Governance Profile export is not a credential-free anyam.governance-profile-export/v1 bundle.",
      affectedObject: bundle.exportId,
      recoveryAction: "regenerate the export with the supported protocol and without credential material",
      receipt: `protocol=${bundle.protocol}; version=${bundle.version}; credentialFree=${bundle.credentialFree}`,
    });
  }
  const { integrityDigest: _integrityDigest, ...withoutDigest } = bundle;
  const actual = exportDigest(withoutDigest);
  if (actual !== bundle.integrityDigest) {
    throw new GovernanceProfileError({
      code: "export-invalid",
      message: "Governance Profile export digest does not match its contents.",
      affectedObject: bundle.exportId,
      recoveryAction: "restore the owner-controlled bundle and rerun verification",
      receipt: `expected=${bundle.integrityDigest}; actual=${actual}`,
    });
  }
  const credentialKey = credentialField(withoutDigest);
  if (credentialKey) {
    throw new GovernanceProfileError({
      code: "export-invalid",
      message: `Governance Profile export contains credential-shaped field ${credentialKey}.`,
      affectedObject: bundle.exportId,
      recoveryAction: "remove credential material and regenerate the credential-free export",
      receipt: `credentialField=${credentialKey}; credentialFree=true required`,
    });
  }
  if (governanceProfileDigest(bundle.profile) !== bundle.profile.digest) {
    throw new GovernanceProfileError({
      code: "profile-digest-mismatch",
      message: `Governance Profile ${bundle.profile.id} has a stale digest inside the export.`,
      affectedObject: bundle.profile.id,
      recoveryAction: "recreate the bundle from the immutable profile definition",
      receipt: `expected=${bundle.profile.digest}; actual=${governanceProfileDigest(bundle.profile)}`,
    });
  }
  return clone(bundle);
}

export class GovernanceProfileRegistry {
  private readonly profiles = new Map<string, GovernanceProfile>();
  private readonly applications = new Map<string, GovernanceProfileApplication>();
  private readonly evidence = new Map<string, GovernanceControlEvidence>();
  private readonly evaluations = new Map<string, GovernanceEvaluation>();
  private readonly now: () => Date;

  constructor(private readonly realm: RealmIdentityPolicy, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  snapshot(): GovernanceProfileSnapshot {
    return {
      profiles: [...this.profiles.values()].map(clone),
      applications: [...this.applications.values()].map(clone),
      evidence: [...this.evidence.values()].map(clone),
      evaluations: [...this.evaluations.values()].map(clone),
    };
  }

  registerProfile(profile: GovernanceProfile): GovernanceProfile {
    requireText(profile.id, "profile.id");
    requireText(profile.name, "profile.name");
    requireText(profile.version, "profile.version");
    requireText(profile.policyVersion, "profile.policyVersion");
    requireText(profile.provenance.source, "profile.provenance.source");
    requireText(profile.provenance.publisher, "profile.provenance.publisher");
    requireText(profile.provenance.receipt, "profile.provenance.receipt");
    validateScope(profile.scope, this.realm.realm.id);
    controlMap(profile.controls);
    if (profile.protocol !== CONTRACT_VERSIONS.governanceProfile) {
      throw new GovernanceProfileError({
        code: "profile-invalid",
        message: `Governance Profile ${profile.id} does not use anyam.governance-profile/v1.`,
        affectedObject: profile.id,
        recoveryAction: "publish a versioned Governance Profile before registration",
        receipt: `protocol=${profile.protocol}`,
      });
    }
    const actualDigest = governanceProfileDigest(profile);
    if (actualDigest !== profile.digest) {
      throw new GovernanceProfileError({
        code: "profile-digest-mismatch",
        message: `Governance Profile ${profile.id}@${profile.version} digest does not match its requirements.`,
        affectedObject: profile.id,
        recoveryAction: "recreate the profile with createGovernanceProfile or publish the matching digest",
        receipt: `expected=${profile.digest}; actual=${actualDigest}`,
      });
    }
    const key = `${profile.id}@${profile.version}#${profile.digest}`;
    const existing = this.profiles.get(key);
    if (existing) return clone(existing);
    this.profiles.set(key, clone(profile));
    return clone(profile);
  }

  getProfile(profileId: string): GovernanceProfile | undefined {
    const profile = [...this.profiles.values()].find((candidate) => candidate.id === profileId);
    return profile ? clone(profile) : undefined;
  }

  activateProfile(input: ActivateGovernanceProfileInput): GovernanceProfileApplication {
    const profile = this.requireProfile(input.profileId);
    if (profile.lifecycle === "retired") {
      throw new GovernanceProfileError({
        code: "profile-inactive",
        message: `Governance Profile ${profile.id} is retired and cannot be activated.`,
        affectedObject: profile.id,
        recoveryAction: "publish a new versioned Governance Profile and activate that replacement",
        receipt: `profile=${profile.id}; lifecycle=retired`,
      });
    }
    validateScope(input.scope, this.realm.realm.id);
    this.authorize(input.authorization, "governance.profile.manage", scopeResource(input.scope), "governance.profile.activate");
    profile.lifecycle = "active";
    this.profiles.set(`${profile.id}@${profile.version}#${profile.digest}`, profile);
    const key = `${profile.id}#${profile.digest}|${scopeKey(input.scope)}`;
    const application: GovernanceProfileApplication = {
      id: this.applications.get(key)?.id ?? opaqueId("governance-application"),
      profileId: profile.id,
      profileDigest: profile.digest,
      scope: clone(input.scope),
      policyVersion: this.realm.realm.policyVersion,
      authorizationEpoch: this.realm.realm.authorizationEpoch,
      status: "active",
      activatedBy: input.authorization.principalId,
      activatedAt: this.now().toISOString(),
      receipt: `profile=${profile.id}@${profile.version}; digest=${profile.digest}; scope=${scopeKey(input.scope)}; policy=${this.realm.realm.policyVersion}; epoch=${this.realm.realm.authorizationEpoch}`,
    };
    this.applications.set(key, application);
    return clone(application);
  }

  evaluate(input: EvaluateGovernanceProfileInput): GovernanceEvaluation {
    const profile = this.requireProfile(input.profileId);
    validateScope(input.scope, this.realm.realm.id);
    const application = this.applicationFor(profile, input.scope);
    if (!application || application.status !== "active") {
      throw new GovernanceProfileError({
        code: "profile-inactive",
        message: `Governance Profile ${profile.id} is not active for the requested scope.`,
        affectedObject: profile.id,
        recoveryAction: "activate the profile through an owner-authorized Governance Profile Change before evaluating it",
        receipt: `profile=${profile.id}; scope=${scopeKey(input.scope)}; active=false`,
      });
    }
    this.authorize(input.authorization, "governance.profile.evaluate", scopeResource(input.scope), "governance.profile.evaluate");
    const controls = controlMap(profile.controls);
    const observed = new Map<string, GovernanceControlObservation>();
    for (const observation of input.observations) {
      if (!controls.has(observation.controlId)) {
        throw new GovernanceProfileError({
          code: "profile-invalid",
          message: `Observation references unknown Governance Control ${observation.controlId}.`,
          affectedObject: observation.controlId,
          recoveryAction: "record observations only for controls declared by the immutable profile",
          receipt: `profile=${profile.id}; control=${observation.controlId}; known=false`,
        });
      }
      if (observed.has(observation.controlId)) {
        throw new GovernanceProfileError({
          code: "profile-invalid",
          message: `Governance Control ${observation.controlId} has duplicate observations.`,
          affectedObject: observation.controlId,
          recoveryAction: "publish one exact-context observation per control and retry",
          receipt: `profile=${profile.id}; control=${observation.controlId}; duplicate=true`,
        });
      }
      requireText(observation.owner, `observation.${observation.controlId}.owner`);
      requireText(observation.nextAction, `observation.${observation.controlId}.nextAction`);
      requireText(observation.receipt, `observation.${observation.controlId}.receipt`);
      requireText(observation.observedAt, `observation.${observation.controlId}.observedAt`);
      unique(observation.evidenceRefs, `observation.${observation.controlId}.evidenceRefs`);
      observed.set(observation.controlId, clone(observation));
    }
    const blockers: string[] = [];
    const advisories: string[] = [];
    const evidenceIds: string[] = [];
    for (const control of controls.values()) {
      const observation = observed.get(control.id);
      if (!observation) {
        const message = `Control ${control.id} is missing an observation; next=${control.required ? "record exact-context control Evidence" : "record or explicitly defer the optional control"}.`;
        if (control.required) blockers.push(message); else advisories.push(message);
        continue;
      }
      const evidence: GovernanceControlEvidence = {
        protocol: CONTRACT_VERSIONS.governanceControlEvidence,
        id: opaqueId("governance-evidence"),
        profileId: profile.id,
        profileDigest: profile.digest,
        scope: clone(input.scope),
        controlId: control.id,
        status: observation.status,
        evidenceRefs: [...observation.evidenceRefs],
        policyVersion: this.realm.realm.policyVersion,
        authorizationEpoch: this.realm.realm.authorizationEpoch,
        observedAt: observation.observedAt,
        owner: observation.owner,
        nextAction: observation.nextAction,
        disclosure: clone(observation.disclosure),
        certificationClaim: false,
        receipt: `profile=${profile.id}; control=${control.id}; status=${observation.status}; source=${observationsDigest([observation])}`,
      };
      this.evidence.set(evidence.id, evidence);
      evidenceIds.push(evidence.id);
      if (observation.status === "failed" && control.required) blockers.push(`Control ${control.id} failed; next=${observation.nextAction}.`);
      else if (observation.status === "indeterminate" && control.required) blockers.push(`Control ${control.id} is indeterminate; next=${observation.nextAction}.`);
      else if (observation.status !== "satisfied") advisories.push(`Control ${control.id} is ${observation.status}; next=${observation.nextAction}.`);
    }
    const hasIndeterminate = evidenceIds.some((id) => this.evidence.get(id)?.status === "indeterminate");
    const status: GovernanceEvaluation["status"] = blockers.length > 0 ? "blocked" : hasIndeterminate ? "indeterminate" : "ready";
    const evaluation: GovernanceEvaluation = {
      protocol: CONTRACT_VERSIONS.governanceEvaluation,
      id: opaqueId("governance-evaluation"),
      profileId: profile.id,
      profileDigest: profile.digest,
      scope: clone(input.scope),
      status,
      evidenceIds,
      blockers,
      advisories,
      policyVersion: this.realm.realm.policyVersion,
      authorizationEpoch: this.realm.realm.authorizationEpoch,
      certificationClaim: false,
      receipt: `profile=${profile.id}; digest=${profile.digest}; status=${status}; evidence=${evidenceIds.length}; certificationClaim=false`,
    };
    this.evaluations.set(evaluation.id, evaluation);
    return clone(evaluation);
  }

  exportProfile(profileId: string, input: EvaluateGovernanceProfileInput): GovernanceProfileExport {
    if (input.profileId !== profileId) {
      throw new GovernanceProfileError({
        code: "profile-invalid",
        message: "Export profile ID must match the evaluated profile ID.",
        affectedObject: profileId,
        recoveryAction: "evaluate and export the same immutable profile definition",
        receipt: `export=${profileId}; evaluated=${input.profileId}`,
      });
    }
    const profile = this.requireProfile(profileId);
    const evaluation = this.evaluate(input);
    const observations = input.observations.map(clone);
    const withoutDigest: Omit<GovernanceProfileExport, "integrityDigest"> = {
      protocol: CONTRACT_VERSIONS.governanceProfileExport,
      version: "v1",
      exportId: opaqueId("governance-export"),
      createdAt: this.now().toISOString(),
      profile: clone(profile),
      observations,
      evaluation,
      credentialFree: true,
      receipt: `profile=${profile.id}; digest=${profile.digest}; evaluation=${evaluation.id}; credentialFree=true`,
    };
    return { ...withoutDigest, integrityDigest: exportDigest(withoutDigest) };
  }

  replay(bundle: GovernanceProfileExport, input: ReplayGovernanceProfileInput): GovernanceEvaluation {
    const verified = verifyGovernanceProfileExport(bundle);
    validateScope(input.scope, this.realm.realm.id);
    const targetProfile: GovernanceProfile = { ...clone(verified.profile), scope: clone(input.scope), lifecycle: "draft" };
    this.registerProfile(targetProfile);
    if (!this.applicationFor(targetProfile, input.scope)) this.activateProfile({ profileId: targetProfile.id, scope: input.scope, authorization: input.authorization });
    return this.evaluate({ profileId: targetProfile.id, scope: input.scope, observations: input.observations ?? verified.observations, authorization: input.authorization });
  }

  listEvidence(): readonly GovernanceControlEvidence[] {
    return [...this.evidence.values()].map(clone);
  }

  listEvaluations(): readonly GovernanceEvaluation[] {
    return [...this.evaluations.values()].map(clone);
  }

  private requireProfile(profileId: string): GovernanceProfile {
    const profile = [...this.profiles.values()].find((candidate) => candidate.id === profileId);
    if (!profile) {
      throw new GovernanceProfileError({
        code: "profile-not-found",
        message: `Governance Profile ${profileId} is not registered in this Realm.`,
        affectedObject: profileId,
        recoveryAction: "register the owner-controlled profile export before activation",
        receipt: `profile=${profileId}; present=false`,
      });
    }
    return profile;
  }

  private applicationFor(profile: GovernanceProfile, scope: GovernanceScope): GovernanceProfileApplication | undefined {
    const key = `${profile.id}#${profile.digest}|${scopeKey(scope)}`;
    return this.applications.get(key);
  }

  private authorize(authorization: GovernanceProfileAuthorization, capability: Capability, resource: ResourceRef, operation: string): PolicyExplanation {
    const result = this.realm.evaluate(asPolicyInput(authorization, capability, resource, operation));
    if (!result.allowed) {
      throw new GovernanceProfileError({
        code: "policy-denied",
        message: `Governance Profile operation ${operation} is ${result.explanation.decision}; no profile transition was performed.`,
        affectedObject: resource.projectId ?? resource.realmId,
        recoveryAction: result.explanation.remediation,
        receipt: `policy=${result.explanation.policyVersion}; epoch=${result.explanation.authorizationEpoch}; decision=${result.explanation.decision}`,
        explanation: result.explanation,
      });
    }
    return result.explanation;
  }
}
