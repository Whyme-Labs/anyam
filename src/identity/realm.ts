import { createHash, randomBytes } from "node:crypto";

import {
  CONTRACT_VERSIONS,
  opaqueId,
  type ActorRef,
  type CapabilityGrant,
  type ResourceRef,
} from "../kernel/contracts.ts";
import { base64Url } from "../kernel/encoding.ts";

export type AuthenticationMethod = "passkey" | "oidc";
export type AuthenticationStrength = "oidc" | "passkey";
export type PrincipalStatus = "active" | "disabled";
export type SessionStatus = "active" | "revoked" | "expired";
export type GrantStatus = "active" | "revoked" | "expired";
export type CredentialStatus = "active" | "revoked" | "expired";
export type ActorKind = "human" | "agent" | "service" | "runner";
export type PolicyDecisionKind = "allow" | "deny" | "indeterminate";
export type CredentialClass = "realm-api" | "git" | "mcp" | "runner" | "integration" | "deployment" | "promotion";
export type AuthorityClass = "none" | "change" | "landing" | "promotion";
export type RealmAgentStatus = "active" | "revoked";

export const AGENT_DEFAULT_CREDENTIAL_CLASSES: readonly CredentialClass[] = ["realm-api", "git", "mcp"];
const AGENT_PROHIBITED_CAPABILITIES: readonly Capability[] = ["policy.manage", "identity.manage", "target.promote"];

export type Capability =
  | "project.inspect"
  | "source.read"
  | "source.propose"
  | "workspace.inspect"
  | "workspace.write"
  | "change.inspect"
  | "change.publish_revision"
  | "intent.inspect"
  | "intent.write"
  | "review.submit_finding"
  | "change.approve"
  | "run.invoke"
  | "evidence.read"
  | "secret.use"
  | "secret.value.read"
  | "landing.request"
  | "release.create"
  | "target.configure"
  | "promotion.request"
  | "target.read"
  | "target.promote"
  | "extension.install"
  | "extension.manage"
  | "extension.invoke"
  | "governance.profile.manage"
  | "governance.profile.evaluate"
  | "agent.delegate"
  | "public.moderate"
  | "policy.manage"
  | "identity.manage";

export const CREDENTIAL_AUDIENCES: Readonly<Record<CredentialClass, string>> = {
  "realm-api": "aud:anyam:realm-api",
  git: "aud:anyam:git",
  mcp: "aud:anyam:mcp",
  runner: "aud:anyam:runner",
  integration: "aud:anyam:integration",
  deployment: "aud:anyam:deployment",
  promotion: "aud:anyam:promotion",
};

export const REALM_POLICY_DEFAULTS = {
  sessionLifetimeMs: 8 * 60 * 60 * 1000,
  credentialLifetimeMs: 15 * 60 * 1000,
  receipt: "policy=realm/v1; sizing=configurable-tripwire; remeasure-before-production",
} as const;

export type Realm = {
  protocol: typeof CONTRACT_VERSIONS.realm;
  id: string;
  name: string;
  relyingPartyId: string;
  policyVersion: string;
  authorizationEpoch: number;
  createdAt: string;
};

export type Principal = {
  protocol: typeof CONTRACT_VERSIONS.principal;
  id: string;
  realmId: string;
  displayName: string;
  status: PrincipalStatus;
  createdAt: string;
};

export type PasskeyCredential = {
  id: string;
  principalId: string;
  realmId: string;
  relyingPartyId: string;
  signCount: number;
  status: "active" | "revoked";
};

export type OidcProvider = {
  id: string;
  realmId: string;
  issuer: string;
  clientId: string;
  status: "active" | "disabled";
};

export type OidcIdentity = {
  issuer: string;
  subject: string;
  principalId: string;
};

export type RealmClient = {
  id: string;
  realmId: string;
  kind: "browser" | "cli" | "mcp" | "git" | "runner" | "integration" | "deployment" | "promotion";
  status: "active" | "revoked";
  allowedAudiences: readonly CredentialClass[];
  allowedOperations: readonly string[];
};

export type RealmActor = ActorRef & {
  protocol: typeof CONTRACT_VERSIONS.actor;
  realmId: string;
  kind: ActorKind;
  status: RealmAgentStatus;
  agentId?: string;
  delegatedByActorId?: string;
  delegatedBySessionId?: string;
  modelProvider?: string;
};

export type RealmAgent = {
  protocol: typeof CONTRACT_VERSIONS.agent;
  id: string;
  realmId: string;
  principalId: string;
  name: string;
  runtime: string;
  modelProvider: string;
  clientId: string;
  allowedCredentialClasses: readonly CredentialClass[];
  status: RealmAgentStatus;
  createdAt: string;
  revokedAt?: string;
};

export type RealmSession = {
  protocol: typeof CONTRACT_VERSIONS.session;
  id: string;
  realmId: string;
  principalId: string;
  actorId: string;
  clientId: string;
  method: AuthenticationMethod;
  strength: AuthenticationStrength;
  issuedAt: string;
  expiresAt: string;
  authorizationEpoch: number;
  status: SessionStatus;
  actorKind?: ActorKind;
  agentId?: string;
  delegatedByActorId?: string;
  delegatedBySessionId?: string;
};

export type RealmTask = {
  protocol: typeof CONTRACT_VERSIONS.task;
  id: string;
  realmId: string;
  principalId: string;
  actorId: string;
  sessionId: string;
  purpose: string;
  workspaceId?: string;
  changeId?: string;
  modelProvider?: string;
  agentId?: string;
  delegatedByActorId?: string;
  delegatedBySessionId?: string;
  createdAt: string;
  status: "active" | "closed";
};

export type Relationship = {
  id: string;
  realmId: string;
  principalId: string;
  kind: "organization-member" | "team-member";
  subjectId: string;
  role: RealmRole;
  resource: ResourceRef;
  deniedCapabilities: readonly Capability[];
  status: "active" | "revoked";
};

export type RealmRole = "viewer" | "contributor" | "reviewer" | "maintainer" | "release-manager" | "security-reviewer" | "moderator" | "owner";

export type SourceSpacePolicy = {
  protocol: typeof CONTRACT_VERSIONS.policy;
  id: string;
  realmId: string;
  sourceSpaceId: string;
  classification: "public" | "internal" | "restricted" | "result-only";
  allowedCapabilities: readonly Capability[];
  deniedCapabilities: readonly Capability[];
  readerPrincipalIds: readonly string[];
  allowedModelProviders: readonly string[];
  discoverable: boolean;
  policyVersion: string;
};

export type RealmCapabilityGrant = CapabilityGrant & {
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId: string;
  sourceSpaceIds: readonly string[];
  effects: readonly string[];
  allowedModelProviders: readonly string[];
  allowedCredentialClasses: readonly CredentialClass[];
  deniedActions: readonly Capability[];
  budget: Readonly<Record<string, string | number>>;
  policyVersion: string;
  authorizationEpoch: number;
  agentId?: string;
  delegatedByActorId?: string;
  delegatedBySessionId?: string;
  parentGrantId?: string;
  consentAt?: string;
};

export type IssuedCredentialRecord = {
  protocol: typeof CONTRACT_VERSIONS.credential;
  id: string;
  realmId: string;
  class: CredentialClass;
  audience: string;
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId: string;
  grantId: string;
  resource: ResourceRef;
  tokenDigest: string;
  issuedAt: string;
  expiresAt: string;
  authorizationEpoch: number;
  status: CredentialStatus;
};

export type IssuedCredential = IssuedCredentialRecord & { token: string };

export type PolicyFactor = {
  name: string;
  status: "satisfied" | "missing" | "denied" | "unknown";
  detail?: string;
};

export type PolicyExplanation = {
  protocol: "anyam.policy-explanation/v1";
  id: string;
  decision: PolicyDecisionKind;
  code: "allowed" | "forbidden" | "not_found" | "indeterminate";
  operation: string;
  resource?: ResourceRef;
  policyVersion: string;
  authorizationEpoch: number;
  satisfiedCapabilities: readonly Capability[];
  missingCapabilities: readonly Capability[];
  factors: readonly PolicyFactor[];
  remediation: string;
  recheckAt: string;
  safeProjection: boolean;
};

export type PolicyDecision = {
  allowed: boolean;
  explanation: PolicyExplanation;
};

export type IssueCredentialInput = {
  class: CredentialClass;
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId: string;
  grantId: string;
  resource: ResourceRef;
};

export type CredentialValidationInput = {
  class?: CredentialClass;
  audience?: string;
  resource?: ResourceRef;
};

export type CredentialValidationResult =
  | { valid: true; credential: IssuedCredentialRecord }
  | { valid: false; code: "credential.invalid" | "credential.expired" | "credential.revoked" | "credential.stale" | "credential.audience_mismatch" | "credential.resource_mismatch"; explanation: string; receipt: string };

export type TaskGrantValidationInput = {
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId: string;
  grantId: string;
  resource: ResourceRef;
  sourceSpaceIds: readonly string[];
  action: Capability;
  effects?: readonly string[];
};

export type TaskGrantValidationResult =
  | {
      valid: true;
      taskId: string;
      grantId: string;
      expiresAt: string;
      authorizationEpoch: number;
      sourceSpaceCount: number;
      receipt: string;
    }
  | {
      valid: false;
      code: string;
      recoveryAction: string;
      receipt: string;
    };

export type AuditEvent = {
  protocol: typeof CONTRACT_VERSIONS.audit;
  id: string;
  realmId: string;
  occurredAt: string;
  eventType: string;
  outcome: "succeeded" | "denied" | "revoked" | "observed";
  principalId?: string | undefined;
  actorId?: string | undefined;
  actorKind?: ActorKind | undefined;
  clientId?: string | undefined;
  modelProvider?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  grantId?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  changeId?: string | undefined;
  sourceSpaceId?: string | undefined;
  promotionId?: string | undefined;
  authorityClass?: AuthorityClass | undefined;
  credentialClass?: CredentialClass | undefined;
  policyDecisionId?: string | undefined;
  details: Readonly<Record<string, unknown>>;
};

export type PolicyEvaluationInput = {
  operation: string;
  capability?: Capability;
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId?: string;
  grantId?: string;
  resource: ResourceRef;
  sourceSpaceId?: string;
  effect?: string;
  modelProvider?: string;
  requiredCredentialClass?: CredentialClass;
  requiredAuthStrength?: AuthenticationStrength;
  authorityClass?: AuthorityClass;
  promotionId?: string;
  approval?: {
    required?: boolean;
    approved?: boolean;
    approverActorId?: string;
    authorActorId?: string;
    verifierActorId?: string;
  };
  discoverable?: boolean;
  protected?: boolean;
};

export type CreateTaskGrantInput = {
  principalId: string;
  actorId: string;
  clientId: string;
  sessionId: string;
  taskId: string;
  resource: ResourceRef;
  sourceSpaceIds: readonly string[];
  actions: readonly Capability[];
  effects?: readonly string[];
  allowedModelProviders?: readonly string[];
  allowedCredentialClasses?: readonly CredentialClass[];
  deniedActions?: readonly Capability[];
  budget?: Readonly<Record<string, string | number>>;
  expiresAt?: string;
  parentGrantId?: string;
  agentId?: string;
  delegatedByActorId?: string;
  delegatedBySessionId?: string;
  consentAt?: string;
};

export type AgentDelegationInput = {
  humanSessionId: string;
  parentGrantId: string;
  agentId: string;
  purpose: string;
  resource: ResourceRef;
  sourceSpaceIds: readonly string[];
  actions: readonly Capability[];
  effects?: readonly string[];
  allowedCredentialClasses?: readonly CredentialClass[];
  budget?: Readonly<Record<string, string | number>>;
  expiresAt?: string;
  workspaceId?: string;
  changeId?: string;
  consentAt?: string;
};

export type RealmAgentDelegation = {
  protocol: "anyam.delegation/v1";
  agent: RealmAgent;
  actor: RealmActor;
  session: RealmSession;
  task: RealmTask;
  grant: RealmCapabilityGrant;
  delegatedBy: ActorRef;
  receipt: string;
};

export type RealmIdentityPolicyOptions = {
  realmId?: string;
  name?: string;
  relyingPartyId?: string;
  policyVersion?: string;
  sessionLifetimeMs?: number;
  credentialLifetimeMs?: number;
  now?: () => Date;
};

type RealmState = {
  realm: Realm;
  principals: Record<string, Principal>;
  agents: Record<string, RealmAgent>;
  passkeys: Record<string, PasskeyCredential>;
  oidcProviders: Record<string, OidcProvider>;
  oidcIdentities: Record<string, OidcIdentity>;
  clients: Record<string, RealmClient>;
  actors: Record<string, RealmActor>;
  sessions: Record<string, RealmSession>;
  tasks: Record<string, RealmTask>;
  relationships: Record<string, Relationship>;
  sourceSpacePolicies: Record<string, SourceSpacePolicy>;
  grants: Record<string, RealmCapabilityGrant>;
  credentials: Record<string, IssuedCredentialRecord>;
  audit: AuditEvent[];
};

export type RealmRecoverySnapshot = {
  realm: Realm;
  principals: Record<string, Principal>;
  agents: Record<string, RealmAgent>;
  passkeys: Record<string, PasskeyCredential>;
  oidcProviders: Record<string, OidcProvider>;
  oidcIdentities: Record<string, OidcIdentity>;
  clients: Record<string, RealmClient>;
  actors: Record<string, RealmActor>;
  sessions: Record<string, RealmSession>;
  tasks: Record<string, RealmTask>;
  relationships: Record<string, Relationship>;
  sourceSpacePolicies: Record<string, SourceSpacePolicy>;
  grants: Record<string, RealmCapabilityGrant>;
  audit: readonly AuditEvent[];
  credentialFree: true;
};

export class RealmIdentityError extends Error {
  readonly code: string;
  readonly explanation: PolicyExplanation | undefined;
  readonly affectedObject: string | undefined;
  readonly recoveryAction: string | undefined;
  readonly receipt: string | undefined;

  constructor(input: { code: string; message: string; explanation?: PolicyExplanation; affectedObject?: string; recoveryAction?: string; receipt?: string }) {
    super(input.message);
    this.name = "RealmIdentityError";
    this.code = input.code;
    this.explanation = input.explanation;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.explanation ? { explanation: this.explanation } : {}),
      ...(this.affectedObject ? { affectedObject: this.affectedObject } : {}),
      ...(this.recoveryAction ? { recoveryAction: this.recoveryAction } : {}),
      ...(this.receipt ? { receipt: this.receipt } : {}),
    };
  }
}

const ROLE_CAPABILITIES: Readonly<Record<RealmRole, readonly Capability[]>> = {
  viewer: ["project.inspect", "source.read", "workspace.inspect", "change.inspect", "evidence.read", "target.read"],
  contributor: ["project.inspect", "source.read", "workspace.inspect", "workspace.write", "change.inspect", "change.publish_revision", "review.submit_finding", "run.invoke", "evidence.read", "target.read", "agent.delegate"],
  reviewer: ["project.inspect", "source.read", "workspace.inspect", "change.inspect", "review.submit_finding", "change.approve", "evidence.read", "target.read"],
  maintainer: ["project.inspect", "source.read", "source.propose", "workspace.inspect", "workspace.write", "change.inspect", "change.publish_revision", "review.submit_finding", "change.approve", "run.invoke", "evidence.read", "landing.request", "target.read", "extension.install", "extension.manage", "extension.invoke", "governance.profile.evaluate", "agent.delegate"],
  "release-manager": ["project.inspect", "source.read", "change.inspect", "review.submit_finding", "change.approve", "evidence.read", "target.read", "target.promote", "landing.request", "release.create", "promotion.request", "extension.invoke"],
  "security-reviewer": ["project.inspect", "source.read", "workspace.inspect", "change.inspect", "review.submit_finding", "change.approve", "run.invoke", "evidence.read", "target.read", "governance.profile.evaluate"],
  moderator: ["project.inspect", "change.inspect", "evidence.read", "public.moderate"],
  owner: ["project.inspect", "source.read", "source.propose", "workspace.inspect", "workspace.write", "change.inspect", "change.publish_revision", "review.submit_finding", "change.approve", "run.invoke", "evidence.read", "secret.use", "landing.request", "release.create", "target.configure", "promotion.request", "target.read", "target.promote", "extension.install", "extension.manage", "extension.invoke", "governance.profile.manage", "governance.profile.evaluate", "agent.delegate", "policy.manage", "identity.manage"],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function expiry(now: () => Date, lifetimeMs: number): string {
  return new Date(now().getTime() + lifetimeMs).toISOString();
}

function expired(value: string, now: () => Date): boolean {
  return Date.parse(value) <= now().getTime();
}

function tokenDigest(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function randomToken(): string {
  return base64Url(randomBytes(32));
}

function resourceMatches(scope: ResourceRef, resource: ResourceRef): boolean {
  if (scope.realmId !== resource.realmId) return false;
  for (const key of ["organizationId", "projectId", "sourceSpaceId", "workspaceId", "changeId", "runId", "releaseId", "targetId"] as const) {
    const expected = scope[key];
    if (expected !== undefined && resource[key] !== expected) return false;
  }
  return true;
}

function listIsSubset<T>(candidate: readonly T[], parent: readonly T[]): boolean {
  return candidate.every((value) => parent.includes(value));
}

function budgetIsNarrower(candidate: Readonly<Record<string, string | number>>, parent: Readonly<Record<string, string | number>>): boolean {
  return Object.entries(candidate).every(([key, value]) => {
    const parentValue = parent[key];
    // An omitted parent budget is unbounded for that dimension. Adding a
    // child budget is therefore a narrowing, not a widening.
    if (parentValue === undefined) return true;
    if (typeof parentValue === "number" && typeof value === "number") return value <= parentValue;
    return value === parentValue;
  });
}

function resourceForAudit(resource: ResourceRef, safe: boolean): ResourceRef | undefined {
  if (!safe) return undefined;
  return { ...resource };
}

function capabilityForOperation(operation: string, capability?: Capability): Capability {
  if (capability) return capability;
  const known = new Set<Capability>(ROLE_CAPABILITIES.owner);
  if (known.has(operation as Capability)) return operation as Capability;
  throw new RealmIdentityError({
    code: "policy.capability_missing",
    message: `Operation ${operation} must declare a semantic capability before policy evaluation.`,
    recoveryAction: "map the operation to a stable Anyam capability and retry",
    receipt: "capability mapping required",
  });
}

function defaultClient(id: string, kind: RealmClient["kind"]): RealmClient {
  const audiencesByKind: Readonly<Record<RealmClient["kind"], readonly CredentialClass[]>> = {
    browser: ["realm-api", "mcp"],
    cli: ["realm-api", "git", "mcp"],
    mcp: ["realm-api", "mcp"],
    git: ["git"],
    runner: ["runner"],
    integration: ["integration"],
    deployment: ["deployment"],
    promotion: ["promotion"],
  };
  return {
    id,
    realmId: "",
    kind,
    status: "active",
    allowedAudiences: audiencesByKind[kind],
    allowedOperations: [],
  };
}

function factor(name: string, status: PolicyFactor["status"], detail?: string): PolicyFactor {
  return { name, status, ...(detail ? { detail } : {}) };
}

export class RealmIdentityPolicy {
  private readonly state: RealmState;
  private readonly now: () => Date;
  private readonly sessionLifetimeMs: number;
  private readonly credentialLifetimeMs: number;

  constructor(options: RealmIdentityPolicyOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? REALM_POLICY_DEFAULTS.sessionLifetimeMs;
    this.credentialLifetimeMs = options.credentialLifetimeMs ?? REALM_POLICY_DEFAULTS.credentialLifetimeMs;
    if (!Number.isFinite(this.sessionLifetimeMs) || this.sessionLifetimeMs <= 0) {
      throw new RealmIdentityError({ code: "realm.policy.invalid", message: `session lifetime must be positive; asked=${this.sessionLifetimeMs}`, recoveryAction: "configure a positive session lifetime", receipt: REALM_POLICY_DEFAULTS.receipt });
    }
    if (!Number.isFinite(this.credentialLifetimeMs) || this.credentialLifetimeMs <= 0) {
      throw new RealmIdentityError({ code: "realm.policy.invalid", message: `credential lifetime must be positive; asked=${this.credentialLifetimeMs}`, recoveryAction: "configure a positive credential lifetime", receipt: REALM_POLICY_DEFAULTS.receipt });
    }
    const createdAt = nowIso(this.now);
    const realmId = options.realmId ?? opaqueId("realm");
    const policyVersion = options.policyVersion ?? `${realmId}:policy:v1`;
    this.state = {
      realm: {
        protocol: CONTRACT_VERSIONS.realm,
        id: realmId,
        name: options.name ?? realmId,
        relyingPartyId: options.relyingPartyId ?? "anyam.local",
        policyVersion,
        authorizationEpoch: 1,
        createdAt,
      },
      principals: {},
      agents: {},
      passkeys: {},
      oidcProviders: {},
      oidcIdentities: {},
      clients: {},
      actors: {},
      sessions: {},
      tasks: {},
      relationships: {},
      sourceSpacePolicies: {},
      grants: {},
      credentials: {},
      audit: [],
    };
    this.registerClient({ id: "client:anyam-web", kind: "browser" });
    this.registerClient({ id: "client:anyam-cli", kind: "cli" });
    this.registerClient({ id: "client:anyam-mcp", kind: "mcp" });
  }

  get realm(): Realm {
    return clone(this.state.realm);
  }

  snapshot(): RealmState {
    return clone(this.state);
  }

  /**
   * Returns the effective human capability set for one resource boundary.
   * This is a policy observation for trusted adapters; it does not mint a
   * Task, Grant, credential, or canonical write authority.
   */
  activeCapabilitiesForPrincipal(input: { principalId: string; resource: ResourceRef }): readonly Capability[] {
    const principal = this.state.principals[input.principalId];
    if (!principal || principal.realmId !== this.state.realm.id || principal.status !== "active") return [];
    const allowed = new Set<Capability>();
    const denied = new Set<Capability>();
    for (const relationship of Object.values(this.state.relationships)) {
      if (relationship.status !== "active" || relationship.realmId !== this.state.realm.id || relationship.principalId !== input.principalId || !resourceMatches(relationship.resource, input.resource)) continue;
      for (const capability of ROLE_CAPABILITIES[relationship.role]) allowed.add(capability);
      for (const capability of relationship.deniedCapabilities) denied.add(capability);
    }
    return [...allowed].filter((capability) => !denied.has(capability)).sort();
  }

  getRecoverySnapshot(): RealmRecoverySnapshot {
    return {
      realm: clone(this.state.realm),
      principals: clone(this.state.principals),
      agents: clone(this.state.agents),
      passkeys: clone(this.state.passkeys),
      oidcProviders: clone(this.state.oidcProviders),
      oidcIdentities: clone(this.state.oidcIdentities),
      clients: clone(this.state.clients),
      actors: clone(this.state.actors),
      sessions: clone(this.state.sessions),
      tasks: clone(this.state.tasks),
      relationships: clone(this.state.relationships),
      sourceSpacePolicies: clone(this.state.sourceSpacePolicies),
      grants: clone(this.state.grants),
      audit: this.state.audit.map((event) => clone(event)),
      credentialFree: true,
    };
  }

  restoreRecoverySnapshot(snapshot: RealmRecoverySnapshot): Realm {
    if (snapshot.credentialFree !== true) throw new RealmIdentityError({ code: "recovery.credentials_present", message: "Realm recovery snapshots must not contain active credential material.", recoveryAction: "create a credential-free recovery export and retry verification", receipt: "credentialFree=true required" });
    if (snapshot.realm.id !== this.state.realm.id) throw new RealmIdentityError({ code: "recovery.realm_mismatch", message: "Recovery snapshot belongs to another Realm.", recoveryAction: "restore the snapshot into an installation with the same Realm identity or start a deliberate Realm migration", receipt: `expected=${this.state.realm.id}; actual=${snapshot.realm.id}` });
    return this.loadSnapshot(snapshot, true);
  }

  restoreOperationalSnapshot(snapshot: RealmRecoverySnapshot): Realm {
    if (snapshot.credentialFree !== true) throw new RealmIdentityError({ code: "recovery.credentials_present", message: "Operational Realm snapshots must not contain active credential material.", recoveryAction: "create a credential-free Realm snapshot and retry hydration", receipt: "credentialFree=true required" });
    if (snapshot.realm.id !== this.state.realm.id) throw new RealmIdentityError({ code: "recovery.realm_mismatch", message: "Realm snapshot belongs to another Realm.", recoveryAction: "hydrate the snapshot into an installation with the same Realm identity", receipt: `expected=${this.state.realm.id}; actual=${snapshot.realm.id}` });
    return this.loadSnapshot(snapshot, false);
  }

  private loadSnapshot(snapshot: RealmRecoverySnapshot, revokeAuthority: boolean): Realm {
    const restoredActors = Object.fromEntries(Object.entries(snapshot.actors).map(([id, actor]) => [id, { ...clone(actor), status: actor.status ?? "active" as const }]));
    const restoredSessions = Object.fromEntries(Object.entries(snapshot.sessions).map(([id, session]) => [id, revokeAuthority ? { ...clone(session), status: "revoked" as const } : clone(session)]));
    const restoredTasks = Object.fromEntries(Object.entries(snapshot.tasks).map(([id, task]) => [id, revokeAuthority ? { ...clone(task), status: "closed" as const } : clone(task)]));
    const restoredGrants = Object.fromEntries(Object.entries(snapshot.grants).map(([id, grant]) => [id, revokeAuthority ? { ...clone(grant), status: "revoked" as const } : clone(grant)]));
    const restoredRealm: Realm = { ...clone(snapshot.realm), authorizationEpoch: revokeAuthority ? Math.max(this.state.realm.authorizationEpoch, snapshot.realm.authorizationEpoch) + 1 : snapshot.realm.authorizationEpoch };
    Object.assign(this.state, {
      realm: restoredRealm,
      principals: clone(snapshot.principals),
      agents: clone(snapshot.agents ?? {}),
      passkeys: clone(snapshot.passkeys),
      oidcProviders: clone(snapshot.oidcProviders),
      oidcIdentities: clone(snapshot.oidcIdentities),
      clients: clone(snapshot.clients),
      actors: restoredActors,
      sessions: restoredSessions,
      tasks: restoredTasks,
      relationships: clone(snapshot.relationships),
      sourceSpacePolicies: clone(snapshot.sourceSpacePolicies),
      grants: restoredGrants,
      credentials: {},
      audit: [...clone(snapshot.audit)],
    });
    if (revokeAuthority) {
      this.audit({
        eventType: "realm.recovery.restored",
        outcome: "observed",
        authorityClass: "none",
        details: { restoredRealmId: restoredRealm.id, authorizationEpoch: restoredRealm.authorizationEpoch, activeCredentialsRestored: false, sessionsRevoked: Object.values(restoredSessions).filter((session) => session.status === "revoked").length, grantsRevoked: Object.values(restoredGrants).filter((grant) => grant.status === "revoked").length },
      });
    }
    return clone(restoredRealm);
  }

  listAuditEvents(): readonly AuditEvent[] {
    return this.state.audit.map((event) => clone(event));
  }

  getPrincipal(principalId: string): Principal | undefined {
    const principal = this.state.principals[principalId];
    return principal ? clone(principal) : undefined;
  }

  getAgent(agentId: string): RealmAgent | undefined {
    const agent = this.state.agents[agentId];
    return agent ? clone(agent) : undefined;
  }

  getActor(actorId: string): RealmActor | undefined {
    const actor = this.state.actors[actorId];
    return actor ? clone(actor) : undefined;
  }

  getSession(sessionId: string): RealmSession | undefined {
    const session = this.state.sessions[sessionId];
    return session ? clone(session) : undefined;
  }

  getGrant(grantId: string): RealmCapabilityGrant | undefined {
    const grant = this.state.grants[grantId];
    return grant ? clone(grant) : undefined;
  }

  private audit(input: Omit<AuditEvent, "protocol" | "id" | "realmId" | "occurredAt">): void {
    this.state.audit.push({
      protocol: CONTRACT_VERSIONS.audit,
      id: opaqueId("audit"),
      realmId: this.state.realm.id,
      occurredAt: nowIso(this.now),
      ...input,
    });
  }

  private requirePrincipal(principalId: string): Principal {
    const principal = this.state.principals[principalId];
    if (!principal || principal.realmId !== this.state.realm.id) {
      throw new RealmIdentityError({ code: "identity.not_found", message: "The requested identity is not available in this Realm.", recoveryAction: "use an identity enrolled in this Realm", receipt: "principal lookup" });
    }
    return principal;
  }

  private requireClient(clientId: string): RealmClient {
    const client = this.state.clients[clientId];
    if (!client || client.realmId !== this.state.realm.id || client.status !== "active") {
      throw new RealmIdentityError({ code: "client.invalid", message: `Client ${clientId} is not active in this Realm.`, affectedObject: clientId, recoveryAction: "register or re-enable the client in this Realm", receipt: "client registration lookup" });
    }
    return client;
  }

  private sessionChainIsActive(session: RealmSession, seen = new Set<string>()): boolean {
    if (seen.has(session.id) || session.realmId !== this.state.realm.id || session.status !== "active" || expired(session.expiresAt, this.now) || session.authorizationEpoch !== this.state.realm.authorizationEpoch) return false;
    seen.add(session.id);
    const actor = this.state.actors[session.actorId];
    if (!actor || actor.status !== "active" || actor.realmId !== this.state.realm.id || actor.principalId !== session.principalId || actor.sessionId !== session.id) return false;
    if (actor.kind === "agent" && (!actor.agentId || this.state.agents[actor.agentId]?.status !== "active")) return false;
    if (!session.delegatedBySessionId) return true;
    const parent = this.state.sessions[session.delegatedBySessionId];
    return parent !== undefined && this.sessionChainIsActive(parent, seen);
  }

  private requireSession(sessionId: string): RealmSession {
    const session = this.state.sessions[sessionId];
    if (!session || session.realmId !== this.state.realm.id) {
      throw new RealmIdentityError({ code: "session.not_found", message: "The requested authenticated session is not available in this Realm.", recoveryAction: "authenticate again through the configured Realm provider", receipt: "session lookup" });
    }
    if (session.status === "active" && expired(session.expiresAt, this.now)) session.status = "expired";
    if (session.status !== "active" || !this.sessionChainIsActive(session)) {
      throw new RealmIdentityError({ code: "session.inactive", message: `Session ${session.id} is no longer active in its Principal-to-Actor delegation chain; no protected operation was performed.`, affectedObject: session.id, recoveryAction: "authenticate the delegating human again and create a fresh agent Task", receipt: `session-status=${session.status}; chain=inactive` });
    }
    return session;
  }

  /**
   * Validate one opaque session handle at the durable Realm boundary without
   * exposing the mutable internal state object. This is intentionally the
   * same chain/epoch check used by task and grant issuance.
   */
  validateSession(sessionId: string): RealmSession {
    return clone(this.requireSession(sessionId));
  }

  /**
   * Create a human-owned Task/Grant for a scoped MCP delivery resource.
   *
   * This is intentionally separate from agent delegation: the OAuth resource
   * grant is a transport credential, while this Task/Grant is the live Realm
   * authority that must remain active at delivery time.
   */
  createOwnerTaskGrant(input: {
    sessionId: string;
    purpose: string;
    resource: ResourceRef;
    sourceSpaceIds: readonly string[];
    actions: readonly Capability[];
    effects?: readonly string[];
    expiresAt?: string;
  }): { task: RealmTask; grant: RealmCapabilityGrant } {
    const session = this.requireSession(input.sessionId);
    const actor = this.state.actors[session.actorId];
    if (!actor || actor.kind !== "human") throw new RealmIdentityError({ code: "mcp.delivery_owner_required", message: "MCP delivery authority must be created from an authenticated human Realm Session.", recoveryAction: "authenticate the Realm owner and retry the delivery grant authorization", receipt: "mcpDelivery=owner-session-required; taskGrant=not-created" });
    if (input.sourceSpaceIds.length === 0) throw new RealmIdentityError({ code: "mcp.delivery_source_spaces_required", message: "MCP delivery authority requires an explicit Source Space disclosure set.", recoveryAction: "authorize a project-scoped MCP resource whose Project exposes at least one Source Space", receipt: "mcpDelivery=source-space-disclosure-required; taskGrant=not-created" });
    const bindings = Object.values(this.state.relationships).filter((binding) => binding.status === "active" && binding.realmId === this.state.realm.id && binding.principalId === session.principalId && resourceMatches(binding.resource, input.resource));
    const denied = input.actions.find((action) => bindings.some((binding) => binding.deniedCapabilities.includes(action)));
    const permitted = input.actions.every((action) => bindings.some((binding) => ROLE_CAPABILITIES[binding.role].includes(action)));
    if (!permitted || denied) throw new RealmIdentityError({ code: "mcp.delivery_owner_denied", message: "The authenticated Realm owner has no active relationship permitting this delivery resource and operation set.", recoveryAction: "authorize the MCP resource through an owner relationship that permits the requested delivery actions", receipt: `mcpDelivery=owner-policy-denied; actions=${input.actions.length}; taskGrant=not-created` });
    const effects = [...(input.effects ?? [])];
    // A typed `landing.apply` command is still a request into the protected
    // Authority plane; it is not a bearer grant for direct canonical.write.
    // Keep the stronger effect names reserved for explicit policy decisions.
    const prohibitedEffect = effects.find((effect) => ["canonical.write", "production.deploy", "target.promote"].includes(effect));
    if (prohibitedEffect) throw new RealmIdentityError({ code: "mcp.delivery_effect_denied", message: "MCP delivery authority cannot contain canonical-write or production-promotion effects.", recoveryAction: "request only the typed delivery operation; canonical landing, provider execution, and production approval remain separate", receipt: `mcpDelivery=effect-denied; effect=${prohibitedEffect}; taskGrant=not-created` });
    const task = this.createTask({ principalId: session.principalId, actorId: session.actorId, sessionId: session.id, purpose: input.purpose, ...(input.resource.workspaceId ? { workspaceId: input.resource.workspaceId } : {}), ...(input.resource.changeId ? { changeId: input.resource.changeId } : {}) });
    const grant = this.createCapabilityGrant({ principalId: session.principalId, actorId: session.actorId, clientId: session.clientId, sessionId: session.id, taskId: task.id, resource: input.resource, sourceSpaceIds: [...input.sourceSpaceIds], actions: [...input.actions], effects, allowedCredentialClasses: [], ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) });
    return { task, grant };
  }

  /**
   * Validate the live Principal→Actor→Session→Task→Grant chain for one
   * operation. The returned value is deliberately credential-free and does
   * not include mutable task or grant records.
   */
  validateTaskGrant(input: TaskGrantValidationInput): TaskGrantValidationResult {
    try {
      const session = this.requireSession(input.sessionId);
      const task = this.state.tasks[input.taskId];
      const grant = this.state.grants[input.grantId];
      if (!task || !grant || task.realmId !== this.state.realm.id || grant.realmId !== this.state.realm.id || task.status !== "active" || grant.taskId !== task.id || task.principalId !== input.principalId || task.actorId !== input.actorId || task.sessionId !== session.id || grant.principalId !== input.principalId || grant.actorId !== input.actorId || grant.clientId !== input.clientId || grant.sessionId !== session.id) return { valid: false, code: "mcp.delivery_task_grant_invalid", recoveryAction: "reauthorize the MCP client so Anyam can create a fresh resource-bound Task and Grant", receipt: "mcpDelivery=task-grant-chain-invalid; canonicalWrite=false" };
      if (!this.grantChainIsActive(grant)) return { valid: false, code: "mcp.delivery_task_grant_inactive", recoveryAction: "reauthorize after revocation, expiry, or a Realm authorization-policy change", receipt: `mcpDelivery=task-grant-inactive; epoch=${this.state.realm.authorizationEpoch}; canonicalWrite=false` };
      if (!resourceMatches(grant.resource, input.resource)) return { valid: false, code: "mcp.delivery_resource_denied", recoveryAction: "use the exact project, Workspace, and Change resource bound to this MCP grant", receipt: "mcpDelivery=resource-mismatch; canonicalWrite=false" };
      if (input.sourceSpaceIds.length === 0 || !listIsSubset(input.sourceSpaceIds, grant.sourceSpaceIds)) return { valid: false, code: "mcp.delivery_source_space_denied", recoveryAction: "reauthorize with the exact disclosed Project Source Spaces; no hidden Source Space was disclosed", receipt: "mcpDelivery=source-space-mismatch; canonicalWrite=false" };
      if (!grant.actions.includes(input.action)) return { valid: false, code: "mcp.delivery_action_denied", recoveryAction: "request the operation-specific delivery scope during OAuth authorization", receipt: `mcpDelivery=action-denied; operation=${input.action}; canonicalWrite=false` };
      const missingEffect = (input.effects ?? []).find((effect) => !grant.effects.includes(effect));
      if (missingEffect) return { valid: false, code: "mcp.delivery_effect_denied", recoveryAction: "reauthorize the MCP client for the exact typed delivery effect", receipt: `mcpDelivery=effect-denied; effect=${missingEffect}; canonicalWrite=false` };
      return { valid: true, taskId: task.id, grantId: grant.id, expiresAt: grant.expiresAt, authorizationEpoch: this.state.realm.authorizationEpoch, sourceSpaceCount: grant.sourceSpaceIds.length, receipt: `mcpDelivery=task-grant-live; epoch=${this.state.realm.authorizationEpoch}; sourceSpaces=${grant.sourceSpaceIds.length}; canonicalWrite=false` };
    } catch (error) {
      if (error instanceof RealmIdentityError) return { valid: false, code: error.code, recoveryAction: error.recoveryAction ?? "reauthorize the MCP client through the authenticated Realm owner session", receipt: `${error.receipt ?? "mcpDelivery=task-grant-validation-failed"}; canonicalWrite=false` };
      return { valid: false, code: "mcp.delivery_task_grant_invalid", recoveryAction: "reauthorize the MCP client and retry the same typed operation", receipt: "mcpDelivery=task-grant-validation-failed; canonicalWrite=false" };
    }
  }

  private grantChainIsActive(grant: RealmCapabilityGrant, seen = new Set<string>()): boolean {
    if (seen.has(grant.id)) return false;
    seen.add(grant.id);
    if (grant.status !== "active" || expired(grant.expiresAt, this.now) || grant.authorizationEpoch !== this.state.realm.authorizationEpoch) return false;
    if (!grant.parentGrantId) return true;
    const parent = this.state.grants[grant.parentGrantId];
    return parent !== undefined && this.grantChainIsActive(parent, seen);
  }

  private createHumanSession(input: { principalId: string; clientId: string; method: AuthenticationMethod; strength: AuthenticationStrength }): RealmSession {
    const principal = this.requirePrincipal(input.principalId);
    const client = this.requireClient(input.clientId);
    if (principal.status !== "active") throw new RealmIdentityError({ code: "identity.disabled", message: `Principal ${principal.id} is disabled; authentication did not create a session.`, affectedObject: principal.id, recoveryAction: "re-enable the principal through Realm administration", receipt: `principal-status=${principal.status}` });
    const sessionId = opaqueId("session");
    const actorId = opaqueId("actor");
    const actor: RealmActor = {
      protocol: CONTRACT_VERSIONS.actor,
      principalId: principal.id,
      actorId,
      sessionId,
      clientId: client.id,
      realmId: this.state.realm.id,
      kind: "human",
      status: "active",
    };
    const issuedAt = nowIso(this.now);
    const session: RealmSession = {
      protocol: CONTRACT_VERSIONS.session,
      id: sessionId,
      realmId: this.state.realm.id,
      principalId: principal.id,
      actorId,
      clientId: client.id,
      method: input.method,
      strength: input.strength,
      issuedAt,
      expiresAt: expiry(this.now, this.sessionLifetimeMs),
      authorizationEpoch: this.state.realm.authorizationEpoch,
      status: "active",
      actorKind: "human",
    };
    this.state.actors[actorId] = actor;
    this.state.sessions[sessionId] = session;
    this.audit({
      eventType: "session.authenticated",
      outcome: "succeeded",
      principalId: principal.id,
      actorId,
      actorKind: "human",
      clientId: client.id,
      sessionId,
      authorityClass: "none",
      details: { method: input.method, strength: input.strength, authorizationEpoch: session.authorizationEpoch },
    });
    return session;
  }

  registerClient(input: { id: string; kind: RealmClient["kind"]; allowedAudiences?: readonly CredentialClass[]; allowedOperations?: readonly string[] }): RealmClient {
    const existing = this.state.clients[input.id];
    if (existing?.status === "active") throw new RealmIdentityError({ code: "client.exists", message: `Client ${input.id} is already registered in this Realm.`, affectedObject: input.id, recoveryAction: "use the existing client or register a new client identifier for the changed consent", receipt: "active client uniqueness" });
    const client: RealmClient = {
      ...defaultClient(input.id, input.kind),
      realmId: this.state.realm.id,
      ...(input.allowedAudiences ? { allowedAudiences: [...input.allowedAudiences] } : {}),
      ...(input.allowedOperations ? { allowedOperations: [...input.allowedOperations] } : {}),
    };
    if (existing?.status === "revoked") throw new RealmIdentityError({ code: "client.revoked", message: `Client ${input.id} was revoked and cannot be silently reactivated.`, affectedObject: input.id, recoveryAction: "register a new client identifier and obtain explicit consent", receipt: "revoked client reuse denied" });
    this.state.clients[input.id] = client;
    return clone(client);
  }

  registerAgent(input: { principalId: string; name: string; runtime: string; modelProvider: string; id?: string; clientId?: string; allowedCredentialClasses?: readonly CredentialClass[] }): RealmAgent {
    const principal = this.requirePrincipal(input.principalId);
    if (principal.status !== "active") throw new RealmIdentityError({ code: "agent.principal_disabled", message: "A disabled Principal cannot enroll an agent Actor.", recoveryAction: "re-enable the Principal and retry agent enrollment", receipt: `principal=${principal.id}; status=${principal.status}` });
    if (!input.name.trim() || !input.runtime.trim() || !input.modelProvider.trim()) throw new RealmIdentityError({ code: "agent.registration_invalid", message: "Agent enrollment requires a name, runtime, and model provider.", recoveryAction: "provide the agent runtime identity and model provider, without provider credentials", receipt: "name, runtime, modelProvider required" });
    const id = input.id ?? opaqueId("agent");
    if (this.state.agents[id]) throw new RealmIdentityError({ code: "agent.exists", message: `Agent ${id} is already registered in this Realm.`, affectedObject: id, recoveryAction: "use the existing agent registration or choose a new agent identity", receipt: "agent id uniqueness" });
    const clientId = input.clientId ?? `client:${id}`;
    const allowedCredentialClasses = [...(input.allowedCredentialClasses ?? AGENT_DEFAULT_CREDENTIAL_CLASSES)];
    if (allowedCredentialClasses.length === 0) throw new RealmIdentityError({ code: "agent.registration_invalid", message: "Agent enrollment requires at least one allowed credential audience.", recoveryAction: "allow only the Git, MCP, or Realm API audiences the agent actually needs", receipt: "allowedCredentialClasses must not be empty" });
    let client = this.state.clients[clientId];
    if (!client) client = this.registerClient({ id: clientId, kind: "mcp", allowedAudiences: allowedCredentialClasses, allowedOperations: ["agent.task"] });
    if (client.status !== "active" || !allowedCredentialClasses.every((credentialClass) => client.allowedAudiences.includes(credentialClass))) throw new RealmIdentityError({ code: "agent.client_audience_denied", message: "Agent credential audiences exceed the registered client consent.", recoveryAction: "register a client whose allowed audiences contain the agent's exact credential classes", receipt: `client=${clientId}; audience-intersection=false` });
    const agent: RealmAgent = {
      protocol: CONTRACT_VERSIONS.agent,
      id,
      realmId: this.state.realm.id,
      principalId: principal.id,
      name: input.name,
      runtime: input.runtime,
      modelProvider: input.modelProvider,
      clientId,
      allowedCredentialClasses,
      status: "active",
      createdAt: nowIso(this.now),
    };
    this.state.agents[id] = agent;
    this.audit({ eventType: "agent.registered", outcome: "observed", principalId: principal.id, clientId, modelProvider: agent.modelProvider, details: { agentId: agent.id, runtime: agent.runtime, allowedCredentialClasses: agent.allowedCredentialClasses, credentialMaterialStored: false } });
    return clone(agent);
  }

  private createAgentSession(parentSession: RealmSession, agent: RealmAgent): RealmSession {
    const parentActor = this.state.actors[parentSession.actorId];
    if (!parentActor || parentActor.kind !== "human" || parentActor.status !== "active") throw new RealmIdentityError({ code: "delegation.parent_actor_invalid", message: "Only an active human Actor can create an agent Session.", recoveryAction: "delegate from an active human Session; agent-to-agent delegation is not enabled", receipt: `parent-actor=${parentSession.actorId}; kind=${parentActor?.kind ?? "missing"}; status=${parentActor?.status ?? "missing"}` });
    const sessionId = opaqueId("session");
    const actorId = opaqueId("actor");
    const issuedAt = nowIso(this.now);
    const parentExpiry = Date.parse(parentSession.expiresAt);
    const configuredExpiry = this.now().getTime() + this.sessionLifetimeMs;
    const expiresAt = new Date(Math.min(parentExpiry, configuredExpiry)).toISOString();
    const actor: RealmActor = {
      protocol: CONTRACT_VERSIONS.actor,
      principalId: parentSession.principalId,
      actorId,
      sessionId,
      clientId: agent.clientId,
      realmId: this.state.realm.id,
      kind: "agent",
      status: "active",
      agentId: agent.id,
      delegatedByActorId: parentActor.actorId,
      delegatedBySessionId: parentSession.id,
      modelProvider: agent.modelProvider,
    };
    const session: RealmSession = {
      protocol: CONTRACT_VERSIONS.session,
      id: sessionId,
      realmId: this.state.realm.id,
      principalId: parentSession.principalId,
      actorId,
      clientId: agent.clientId,
      method: parentSession.method,
      strength: parentSession.strength,
      issuedAt,
      expiresAt,
      authorizationEpoch: this.state.realm.authorizationEpoch,
      status: "active",
      actorKind: "agent",
      agentId: agent.id,
      delegatedByActorId: parentActor.actorId,
      delegatedBySessionId: parentSession.id,
    };
    this.state.actors[actorId] = actor;
    this.state.sessions[sessionId] = session;
    this.audit({ eventType: "session.agent_delegated", outcome: "succeeded", principalId: session.principalId, actorId, actorKind: "agent", clientId: agent.clientId, sessionId, modelProvider: agent.modelProvider, details: { agentId: agent.id, delegatedByActorId: parentActor.actorId, delegatedBySessionId: parentSession.id, authenticationStrength: parentSession.strength, credentialMaterialStored: false } });
    return session;
  }

  delegateAgent(input: AgentDelegationInput): RealmAgentDelegation {
    const parentSession = this.requireSession(input.humanSessionId);
    const parentActor = this.state.actors[parentSession.actorId];
    if (!parentActor || parentActor.kind !== "human" || parentActor.status !== "active") throw new RealmIdentityError({ code: "delegation.parent_actor_invalid", message: "Only an active human Actor can delegate an agent Task.", recoveryAction: "authenticate as a human and delegate from that Session; agent-to-agent delegation is not enabled", receipt: `parent-actor=${parentSession.actorId}; kind=${parentActor?.kind ?? "missing"}` });
    if (!input.purpose.trim()) throw new RealmIdentityError({ code: "delegation.purpose_invalid", message: "Agent delegation requires a non-empty Task purpose.", recoveryAction: "describe the outcome the agent is authorized to pursue", receipt: "purpose required" });
    const agent = this.state.agents[input.agentId];
    if (!agent || agent.realmId !== this.state.realm.id || agent.principalId !== parentSession.principalId || agent.status !== "active") throw new RealmIdentityError({ code: "delegation.agent_invalid", message: "The requested agent is not an active agent owned by the delegating Principal in this Realm.", recoveryAction: "enroll the agent in this Realm under the authenticated Principal, then retry", receipt: `agent=${input.agentId}; same-realm-principal=${agent?.principalId === parentSession.principalId}; status=${agent?.status ?? "missing"}` });
    const parentGrant = this.state.grants[input.parentGrantId];
    const parentTask = parentGrant ? this.state.tasks[parentGrant.taskId] : undefined;
    if (!parentGrant || !parentTask || parentGrant.principalId !== parentSession.principalId || parentGrant.actorId !== parentSession.actorId || parentGrant.clientId !== parentSession.clientId || parentGrant.sessionId !== parentSession.id || parentTask.principalId !== parentSession.principalId || parentTask.actorId !== parentSession.actorId || parentTask.sessionId !== parentSession.id || parentTask.status !== "active" || !this.grantChainIsActive(parentGrant)) throw new RealmIdentityError({ code: "delegation.parent_grant_invalid", message: "Agent delegation requires an active human-owned parent Grant and Task in the current Session.", recoveryAction: "create a fresh human Task and Grant, include agent.delegate, and retry delegation", receipt: `parent-grant=${input.parentGrantId}; parent-chain=invalid` });
    if (!parentGrant.actions.includes("agent.delegate")) throw new RealmIdentityError({ code: "delegation.capability_missing", message: "The parent Grant does not authorize human-to-agent delegation.", recoveryAction: "issue the human parent Grant with agent.delegate after the Realm relationship permits it", receipt: "parent-grant=agent.delegate missing" });
    const bindings = Object.values(this.state.relationships).filter((binding) => binding.status === "active" && binding.realmId === this.state.realm.id && binding.principalId === parentSession.principalId && resourceMatches(binding.resource, input.resource));
    const roleAllowsDelegation = bindings.some((binding) => ROLE_CAPABILITIES[binding.role].includes("agent.delegate"));
    const relationshipDeniesDelegation = bindings.some((binding) => binding.deniedCapabilities.includes("agent.delegate"));
    if (!roleAllowsDelegation || relationshipDeniesDelegation) throw new RealmIdentityError({ code: "delegation.relationship_denied", message: "The delegating Principal has no active relationship that permits agent delegation for this resource.", recoveryAction: "grant agent.delegate on an active organization or team relationship, without an explicit deny", receipt: `role-allows=${roleAllowsDelegation}; relationship-deny=${relationshipDeniesDelegation}` });
    if (!resourceMatches(parentGrant.resource, input.resource)) throw new RealmIdentityError({ code: "delegation.resource_widening", message: "Agent delegation cannot escape the parent Grant resource scope.", recoveryAction: "delegate a child resource inside the parent Grant scope", receipt: "parent-resource contains child=false" });
    if (!input.sourceSpaceIds.every((sourceSpaceId) => parentGrant.sourceSpaceIds.includes(sourceSpaceId))) throw new RealmIdentityError({ code: "delegation.source_space_widening", message: "Agent delegation cannot add Source Spaces outside the parent Grant.", recoveryAction: "select only Source Spaces already present in the parent Grant", receipt: "source-space subset=false" });
    if (!input.actions.every((action) => parentGrant.actions.includes(action)) || input.actions.some((action) => AGENT_PROHIBITED_CAPABILITIES.includes(action))) throw new RealmIdentityError({ code: "delegation.action_widening", message: "Agent actions must be a non-promotional subset of the human parent Grant.", recoveryAction: "remove prohibited capabilities and keep every action inside the parent Grant", receipt: "actions subset=false; canonical-promotion=false" });
    const effects = [...(input.effects ?? [])];
    if (!effects.every((effect) => parentGrant.effects.includes(effect))) throw new RealmIdentityError({ code: "delegation.effect_widening", message: "Agent effects must be a subset of the human parent Grant.", recoveryAction: "declare only effects already authorized by the parent Grant", receipt: "effects subset=false" });
    const allowedCredentialClasses = [...(input.allowedCredentialClasses ?? agent.allowedCredentialClasses)];
    if (!listIsSubset(allowedCredentialClasses, agent.allowedCredentialClasses) || !listIsSubset(allowedCredentialClasses, parentGrant.allowedCredentialClasses)) throw new RealmIdentityError({ code: "delegation.audience_widening", message: "Agent credential audiences must remain inside both the enrolled agent audiences and the parent Grant audiences.", recoveryAction: "request only Git, MCP, or Realm API audiences explicitly approved for this agent and parent Grant", receipt: "credential-audience intersection=false" });
    if (parentGrant.allowedModelProviders.length > 0 && !parentGrant.allowedModelProviders.includes(agent.modelProvider)) throw new RealmIdentityError({ code: "delegation.model_denied", message: "The enrolled agent model provider is outside the parent Grant trust zone.", recoveryAction: "delegate to an agent whose provider is allowed by the parent Grant or issue a deliberate parent Grant update", receipt: `modelProvider=${agent.modelProvider}; parent-model-allow=false` });
    const budget = { ...(input.budget ?? {}) };
    if (!budgetIsNarrower(budget, parentGrant.budget)) throw new RealmIdentityError({ code: "delegation.budget_widening", message: "Agent budgets must be no wider than the human parent Grant budget.", recoveryAction: "lower the requested budget or omit dimensions that the parent leaves unbounded", receipt: "budget narrowing=false" });
    const delegatedExpiresAt = input.expiresAt ?? parentGrant.expiresAt;
    if (!Number.isFinite(Date.parse(delegatedExpiresAt)) || expired(delegatedExpiresAt, this.now) || Date.parse(delegatedExpiresAt) > Date.parse(parentGrant.expiresAt)) throw new RealmIdentityError({ code: "delegation.expiry_invalid", message: "Agent delegation expiry must be a future timestamp no later than the parent Grant expiry.", recoveryAction: "choose an expiry inside the active parent Grant window", receipt: `child-expiresAt=${delegatedExpiresAt}; parent-expiresAt=${parentGrant.expiresAt}` });
    const agentSession = this.createAgentSession(parentSession, agent);
    const agentActor = this.state.actors[agentSession.actorId];
    const task = this.createTask({ principalId: parentSession.principalId, actorId: agentSession.actorId, sessionId: agentSession.id, purpose: input.purpose, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.changeId ? { changeId: input.changeId } : {}), modelProvider: agent.modelProvider });
    const grant = this.createCapabilityGrant({ principalId: parentSession.principalId, actorId: agentSession.actorId, clientId: agent.clientId, sessionId: agentSession.id, taskId: task.id, resource: input.resource, sourceSpaceIds: input.sourceSpaceIds, actions: input.actions, effects, allowedModelProviders: [agent.modelProvider], allowedCredentialClasses, budget, expiresAt: delegatedExpiresAt, parentGrantId: parentGrant.id, agentId: agent.id, delegatedByActorId: parentActor.actorId, delegatedBySessionId: parentSession.id, consentAt: input.consentAt ?? nowIso(this.now) });
    if (!agentActor) throw new RealmIdentityError({ code: "delegation.actor_missing", message: "Agent delegation created no Actor record; the operation was not valid.", recoveryAction: "retry after checking the Realm session ledger", receipt: "agent actor record missing" });
    return { protocol: "anyam.delegation/v1", agent: clone(agent), actor: clone(agentActor), session: clone(agentSession), task: clone(task), grant: clone(grant), delegatedBy: { principalId: parentActor.principalId, actorId: parentActor.actorId, sessionId: parentActor.sessionId, clientId: parentActor.clientId }, receipt: `delegation=human-to-agent; agent=${agent.id}; parentGrant=${parentGrant.id}; modelProvider=${agent.modelProvider}; canonicalWrite=false` };
  }

  createPrincipal(input: { id?: string; displayName: string }): Principal {
    const principal: Principal = {
      protocol: CONTRACT_VERSIONS.principal,
      id: input.id ?? opaqueId("principal"),
      realmId: this.state.realm.id,
      displayName: input.displayName,
      status: "active",
      createdAt: nowIso(this.now),
    };
    if (this.state.principals[principal.id]) throw new RealmIdentityError({ code: "identity.exists", message: `Principal ${principal.id} already exists in this Realm.`, affectedObject: principal.id, recoveryAction: "use the existing principal or choose a new identity", receipt: "principal id uniqueness" });
    this.state.principals[principal.id] = principal;
    this.audit({ eventType: "principal.created", outcome: "observed", principalId: principal.id, authorityClass: "none", details: { displayName: principal.displayName } });
    return clone(principal);
  }

  registerPasskey(input: { principalId: string; credentialId: string; relyingPartyId?: string; signCount?: number }): PasskeyCredential {
    const principal = this.requirePrincipal(input.principalId);
    const credential: PasskeyCredential = {
      id: input.credentialId,
      principalId: principal.id,
      realmId: this.state.realm.id,
      relyingPartyId: input.relyingPartyId ?? this.state.realm.relyingPartyId,
      signCount: input.signCount ?? 0,
      status: "active",
    };
    if (this.state.passkeys[credential.id]) throw new RealmIdentityError({ code: "passkey.exists", message: `Passkey ${credential.id} is already registered in this Realm.`, affectedObject: credential.id, recoveryAction: "use the enrolled passkey or register a distinct credential", receipt: "passkey id uniqueness" });
    this.state.passkeys[credential.id] = credential;
    this.audit({ eventType: "passkey.registered", outcome: "observed", principalId: principal.id, details: { credentialId: credential.id, relyingPartyId: credential.relyingPartyId } });
    return clone(credential);
  }

  registerOidcProvider(input: { id?: string; issuer: string; clientId: string }): OidcProvider {
    const provider: OidcProvider = { id: input.id ?? opaqueId("oidc-provider"), realmId: this.state.realm.id, issuer: input.issuer, clientId: input.clientId, status: "active" };
    if (Object.values(this.state.oidcProviders).some((existing) => existing.issuer === provider.issuer)) throw new RealmIdentityError({ code: "oidc.provider_exists", message: `OIDC issuer ${provider.issuer} is already registered in this Realm.`, affectedObject: provider.issuer, recoveryAction: "use the existing provider or register a different issuer", receipt: "OIDC issuer uniqueness" });
    this.state.oidcProviders[provider.id] = provider;
    this.audit({ eventType: "oidc.provider.registered", outcome: "observed", details: { providerId: provider.id, issuer: provider.issuer } });
    return clone(provider);
  }

  linkOidcIdentity(input: { principalId: string; issuer: string; subject: string }): OidcIdentity {
    const principal = this.requirePrincipal(input.principalId);
    const provider = Object.values(this.state.oidcProviders).find((candidate) => candidate.issuer === input.issuer && candidate.status === "active");
    if (!provider) throw new RealmIdentityError({ code: "oidc.provider_not_found", message: "The requested OIDC issuer is not enabled in this Realm.", recoveryAction: "register the selected OIDC provider before linking identities", receipt: `issuer=${input.issuer}; provider=missing` });
    const key = `${input.issuer}|${input.subject}`;
    if (this.state.oidcIdentities[key]) throw new RealmIdentityError({ code: "oidc.identity_exists", message: "That OIDC identity is already linked in this Realm.", recoveryAction: "authenticate with the linked identity or unlink it through an explicit identity Change", receipt: "OIDC issuer and subject uniqueness" });
    const identity = { issuer: provider.issuer, subject: input.subject, principalId: principal.id };
    this.state.oidcIdentities[key] = identity;
    this.audit({ eventType: "oidc.identity.linked", outcome: "observed", principalId: principal.id, details: { issuer: provider.issuer } });
    return clone(identity);
  }

  authenticatePasskey(input: { credentialId: string; relyingPartyId?: string; challenge: string; verified: boolean; signCount?: number; clientId?: string }): RealmSession {
    const credential = this.state.passkeys[input.credentialId];
    if (!credential || credential.status !== "active" || credential.relyingPartyId !== (input.relyingPartyId ?? this.state.realm.relyingPartyId)) throw new RealmIdentityError({ code: "auth.passkey_invalid", message: "Passkey authentication was not accepted by this Realm.", recoveryAction: "retry with a passkey enrolled for this Realm origin", receipt: "passkey credential and relying-party check" });
    if (!input.challenge || !input.verified) throw new RealmIdentityError({ code: "auth.passkey_unverified", message: "The passkey assertion was not verified; no session was created.", recoveryAction: "complete a fresh WebAuthn assertion through the Realm adapter", receipt: "verified WebAuthn assertion required" });
    if (input.signCount !== undefined) {
      if (!Number.isSafeInteger(input.signCount) || input.signCount < credential.signCount) throw new RealmIdentityError({ code: "auth.passkey_counter_regression", message: "The verified passkey counter regressed inside the serialized Realm coordinator.", recoveryAction: "revoke the credential and enroll a fresh passkey after checking for authenticator cloning", receipt: `stored=${credential.signCount}; presented=${input.signCount}; counter=regression` });
      credential.signCount = input.signCount;
    } else {
      credential.signCount += 1;
    }
    return this.createHumanSession({ principalId: credential.principalId, clientId: input.clientId ?? "client:anyam-web", method: "passkey", strength: "passkey" });
  }

  authenticateOidc(input: { issuer: string; subject: string; verified: boolean; clientId?: string }): RealmSession {
    const provider = Object.values(this.state.oidcProviders).find((candidate) => candidate.issuer === input.issuer && candidate.status === "active");
    if (!provider || !input.verified) throw new RealmIdentityError({ code: "auth.oidc_invalid", message: "OIDC authentication was not accepted by this Realm.", recoveryAction: "complete OIDC discovery and authorization through the configured issuer", receipt: `issuer=${input.issuer}; verified=${input.verified}` });
    const identity = this.state.oidcIdentities[`${input.issuer}|${input.subject}`];
    if (!identity) throw new RealmIdentityError({ code: "auth.oidc_unlinked", message: "The verified OIDC identity is not linked to a local Realm principal.", recoveryAction: "ask a Realm owner to link this OIDC subject before retrying", receipt: "issuer-and-subject local identity lookup" });
    return this.createHumanSession({ principalId: identity.principalId, clientId: input.clientId ?? "client:anyam-web", method: "oidc", strength: "oidc" });
  }

  authenticate(input: { method: "passkey"; credentialId: string; relyingPartyId?: string; challenge: string; verified: boolean; signCount?: number; clientId?: string } | { method: "oidc"; issuer: string; subject: string; verified: boolean; clientId?: string }): RealmSession {
    return input.method === "passkey" ? this.authenticatePasskey(input) : this.authenticateOidc(input);
  }

  addRelationship(input: { principalId: string; kind: Relationship["kind"]; subjectId: string; role: RealmRole; resource?: ResourceRef; deniedCapabilities?: readonly Capability[] }): Relationship {
    const principal = this.requirePrincipal(input.principalId);
    const relationship: Relationship = {
      id: opaqueId("relationship"),
      realmId: this.state.realm.id,
      principalId: principal.id,
      kind: input.kind,
      subjectId: input.subjectId,
      role: input.role,
      resource: input.resource ?? { realmId: this.state.realm.id },
      deniedCapabilities: [...(input.deniedCapabilities ?? [])],
      status: "active",
    };
    this.state.relationships[relationship.id] = relationship;
    this.audit({ eventType: "relationship.granted", outcome: "observed", principalId: principal.id, details: { relationshipId: relationship.id, kind: relationship.kind, subjectId: relationship.subjectId, role: relationship.role } });
    return clone(relationship);
  }

  setSourceSpacePolicy(input: { sourceSpaceId: string; classification: SourceSpacePolicy["classification"]; allowedCapabilities: readonly Capability[]; deniedCapabilities?: readonly Capability[]; readerPrincipalIds?: readonly string[]; allowedModelProviders?: readonly string[]; discoverable?: boolean }): SourceSpacePolicy {
    const policy: SourceSpacePolicy = {
      protocol: CONTRACT_VERSIONS.policy,
      id: opaqueId("source-space-policy"),
      realmId: this.state.realm.id,
      sourceSpaceId: input.sourceSpaceId,
      classification: input.classification,
      allowedCapabilities: [...input.allowedCapabilities],
      deniedCapabilities: [...(input.deniedCapabilities ?? [])],
      readerPrincipalIds: [...(input.readerPrincipalIds ?? [])],
      allowedModelProviders: [...(input.allowedModelProviders ?? [])],
      discoverable: input.discoverable ?? true,
      policyVersion: this.state.realm.policyVersion,
    };
    this.state.sourceSpacePolicies[policy.sourceSpaceId] = policy;
    this.audit({ eventType: "source-space.policy.updated", outcome: "observed", sourceSpaceId: policy.sourceSpaceId, details: { policyVersion: policy.policyVersion, classification: policy.classification } });
    return clone(policy);
  }

  createTask(input: { principalId: string; actorId: string; sessionId: string; purpose: string; workspaceId?: string; changeId?: string; modelProvider?: string }): RealmTask {
    const session = this.requireSession(input.sessionId);
    if (session.authorizationEpoch !== this.state.realm.authorizationEpoch) throw new RealmIdentityError({ code: "task.session_stale", message: "Task creation requires a session authenticated under the active Realm authorization policy.", recoveryAction: "authenticate again after the Realm policy change", receipt: `session-epoch=${session.authorizationEpoch}; realm-epoch=${this.state.realm.authorizationEpoch}` });
    if (session.principalId !== input.principalId || session.actorId !== input.actorId) throw new RealmIdentityError({ code: "task.actor_mismatch", message: "Task principal, Actor, and Session do not form one authenticated chain.", recoveryAction: "create the Task from the active session's ActorRef", receipt: `session=${session.id}; principal-match=${session.principalId === input.principalId}; actor-match=${session.actorId === input.actorId}` });
    const actor = this.state.actors[input.actorId];
    const agent = actor?.kind === "agent" && actor.agentId ? this.state.agents[actor.agentId] : undefined;
    if (actor?.kind === "agent" && (!agent || agent.status !== "active" || input.modelProvider !== agent.modelProvider)) throw new RealmIdentityError({ code: "task.agent_model_mismatch", message: "An agent Task must use the enrolled agent runtime and model provider; provider substitution was not accepted.", recoveryAction: "create a fresh Task with the enrolled agent model provider", receipt: `agent=${agent?.id ?? "missing"}; modelProvider=${input.modelProvider ?? "missing"}` });
    const task: RealmTask = {
      protocol: CONTRACT_VERSIONS.task,
      id: opaqueId("task"),
      realmId: this.state.realm.id,
      principalId: input.principalId,
      actorId: input.actorId,
      sessionId: input.sessionId,
      purpose: input.purpose,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.changeId ? { changeId: input.changeId } : {}),
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      ...(agent ? { agentId: agent.id } : {}),
      ...(session.delegatedByActorId ? { delegatedByActorId: session.delegatedByActorId } : {}),
      ...(session.delegatedBySessionId ? { delegatedBySessionId: session.delegatedBySessionId } : {}),
      createdAt: nowIso(this.now),
      status: "active",
    };
    this.state.tasks[task.id] = task;
    this.audit({ eventType: "task.created", outcome: "observed", principalId: task.principalId, actorId: task.actorId, actorKind: this.state.actors[task.actorId]?.kind, clientId: session.clientId, sessionId: task.sessionId, taskId: task.id, workspaceId: task.workspaceId, changeId: task.changeId, modelProvider: task.modelProvider, details: { purpose: task.purpose } });
    return clone(task);
  }

  createCapabilityGrant(input: CreateTaskGrantInput): RealmCapabilityGrant {
    const principal = this.requirePrincipal(input.principalId);
    const session = this.requireSession(input.sessionId);
    const client = this.requireClient(input.clientId);
    const actor = this.state.actors[input.actorId];
    const agent = actor?.kind === "agent" && actor.agentId ? this.state.agents[actor.agentId] : undefined;
    if (input.agentId !== undefined && (!agent || input.agentId !== agent.id)) throw new RealmIdentityError({ code: "grant.agent_mismatch", message: "Capability Grant agent metadata does not match the authenticated agent Actor.", recoveryAction: "issue the Grant through the delegated agent Session and its enrolled agent identity", receipt: `input-agent=${input.agentId}; actor-agent=${agent?.id ?? "missing"}` });
    if (actor?.kind !== "agent" && (input.delegatedByActorId !== undefined || input.delegatedBySessionId !== undefined)) throw new RealmIdentityError({ code: "grant.delegation_metadata_invalid", message: "Delegation metadata is only valid for an agent Actor Grant.", recoveryAction: "remove delegation metadata from a human Grant or create a delegated agent Session", receipt: "delegation metadata requires agent actor" });
    if (actor?.kind === "agent" && (!agent || agent.status !== "active")) throw new RealmIdentityError({ code: "grant.agent_revoked", message: "A revoked agent Actor cannot receive a Capability Grant.", recoveryAction: "enroll or reactivate the agent through an owner-approved Realm operation, then create a fresh delegation", receipt: `agent=${agent?.id ?? "missing"}; status=${agent?.status ?? "missing"}` });
    if (actor?.kind === "agent" && !input.parentGrantId) throw new RealmIdentityError({ code: "grant.agent_parent_required", message: "An agent Capability Grant must be derived from an active human-owned parent Grant.", recoveryAction: "delegate the Task from an active human Session and parent Grant; direct agent authority is not supported", receipt: "agent-parent-grant=required" });
    if (session.authorizationEpoch !== this.state.realm.authorizationEpoch) throw new RealmIdentityError({ code: "grant.session_stale", message: "Capability Grant issuance requires a session authenticated under the active Realm authorization policy.", recoveryAction: "authenticate again after the Realm policy change", receipt: `session-epoch=${session.authorizationEpoch}; realm-epoch=${this.state.realm.authorizationEpoch}` });
    if (session.principalId !== principal.id || session.actorId !== input.actorId || session.clientId !== client.id) throw new RealmIdentityError({ code: "grant.actor_mismatch", message: "Capability Grant identity does not match the authenticated Principal, Actor, Client, and Session.", recoveryAction: "create the Grant from one active Session and ActorRef", receipt: `principal=${session.principalId === principal.id}; actor=${session.actorId === input.actorId}; client=${session.clientId === client.id}` });
    const task = this.state.tasks[input.taskId];
    if (!task || task.status !== "active" || task.principalId !== principal.id || task.actorId !== input.actorId || task.sessionId !== session.id) throw new RealmIdentityError({ code: "grant.task_invalid", message: "Capability Grant must reference an active Task in the same Principal, Actor, and Session chain.", recoveryAction: "create or resume the Task before issuing a Grant", receipt: `task=${input.taskId}; task-chain=invalid` });
    const allowedModelProviders = actor?.kind === "agent" && agent ? [...(input.allowedModelProviders ?? [agent.modelProvider])] : [...(input.allowedModelProviders ?? [])];
    const allowedCredentialClasses = actor?.kind === "agent" && agent ? [...(input.allowedCredentialClasses ?? agent.allowedCredentialClasses)] : [...(input.allowedCredentialClasses ?? ["realm-api", "git", "mcp", "runner", "integration", "deployment", "promotion"] as const)];
    if (actor?.kind === "agent" && agent && (!listIsSubset(allowedModelProviders, [agent.modelProvider]) || !listIsSubset(allowedCredentialClasses, agent.allowedCredentialClasses) || input.actions.some((action) => AGENT_PROHIBITED_CAPABILITIES.includes(action)))) throw new RealmIdentityError({ code: "grant.agent_scope_invalid", message: "Agent authority must remain within the enrolled model provider, credential audiences, and non-promotional capabilities.", recoveryAction: "narrow the agent Grant to its enrolled model provider, allowed audiences, and Workspace/Change operations", receipt: "agent-scope=narrowing-failed; canonical-promotion=false" });
    if (input.parentGrantId) {
      const parent = this.state.grants[input.parentGrantId];
      const parentActor = parent ? this.state.actors[parent.actorId] : undefined;
      const sameChain = actor?.kind !== "agent" && parent !== undefined && parent.actorId === input.actorId && parent.clientId === client.id && parent.sessionId === session.id;
      const delegatedAgentChain = parent !== undefined && actor?.kind === "agent" && agent !== undefined && parentActor?.kind === "human" && input.agentId === agent.id && input.delegatedByActorId === parent.actorId && input.delegatedBySessionId === parent.sessionId && session.delegatedByActorId === parent.actorId && session.delegatedBySessionId === parent.sessionId && task.agentId === agent.id;
      if (!parent || parent.principalId !== principal.id || (!sameChain && !delegatedAgentChain) || !this.grantChainIsActive(parent)) throw new RealmIdentityError({ code: "grant.parent_invalid", message: "Derived Capability Grant cannot use an inactive or unrelated parent Grant.", recoveryAction: "use an active human parent Grant and preserve the Principal, Actor, Session, Task, and delegation chain", receipt: `parent-grant=${input.parentGrantId}; delegation-chain=${delegatedAgentChain}` });
      const parentExpiry = Date.parse(parent.expiresAt);
      const childExpiry = Date.parse(input.expiresAt ?? parent.expiresAt);
      const childModels = allowedModelProviders;
      const childCredentials = allowedCredentialClasses;
      const childEffects = input.effects ?? [];
      const modelsWiden = parent.allowedModelProviders.length > 0 && (childModels.length === 0 || !childModels.every((provider) => parent.allowedModelProviders.includes(provider)));
      // An empty credential audience is an explicit no-audience grant. Unlike
      // model providers (where empty means any provider), child credentials
      // must always be listed by the parent before they can be delegated.
      const credentialsWiden = !childCredentials.every((credentialClass) => parent.allowedCredentialClasses.includes(credentialClass));
      const effectsWiden = !childEffects.every((effect) => parent.effects.includes(effect));
      if (childExpiry > parentExpiry || !input.actions.every((action) => parent.actions.includes(action)) || !input.sourceSpaceIds.every((sourceSpaceId) => parent.sourceSpaceIds.includes(sourceSpaceId)) || modelsWiden || credentialsWiden || effectsWiden || !budgetIsNarrower(input.budget ?? {}, parent.budget)) throw new RealmIdentityError({ code: "grant.widening", message: "Derived Capability Grant would widen parent authority; no Grant was issued.", recoveryAction: "narrow actions, Source Spaces, effects, model providers, credential classes, budgets, and expiry to the parent Grant", receipt: "delegation-narrowing=failed" });
    }
    if (input.expiresAt !== undefined && (!Number.isFinite(Date.parse(input.expiresAt)) || expired(input.expiresAt, this.now))) throw new RealmIdentityError({ code: "grant.expiry_invalid", message: "Capability Grant expiry must be a valid future timestamp.", recoveryAction: "issue the Grant with an expiry after the current Realm time", receipt: `expiresAt=${input.expiresAt}` });
    const grant: RealmCapabilityGrant = {
      protocol: CONTRACT_VERSIONS.capability,
      id: opaqueId("grant"),
      realmId: this.state.realm.id,
      subjectId: input.actorId,
      resource: { ...input.resource, realmId: this.state.realm.id },
      actions: [...input.actions],
      expiresAt: input.expiresAt ?? expiry(this.now, this.credentialLifetimeMs),
      status: "active",
      principalId: principal.id,
      actorId: input.actorId,
      clientId: client.id,
      sessionId: session.id,
      taskId: task.id,
      sourceSpaceIds: [...input.sourceSpaceIds],
      effects: [...(input.effects ?? [])],
      allowedModelProviders,
      allowedCredentialClasses,
      deniedActions: [...(input.deniedActions ?? [])],
      budget: { ...(input.budget ?? {}) },
      policyVersion: this.state.realm.policyVersion,
      authorizationEpoch: this.state.realm.authorizationEpoch,
      ...(actor?.kind === "agent" && agent ? { agentId: agent.id } : input.agentId ? { agentId: input.agentId } : {}),
      ...(input.delegatedByActorId ? { delegatedByActorId: input.delegatedByActorId } : {}),
      ...(input.delegatedBySessionId ? { delegatedBySessionId: input.delegatedBySessionId } : {}),
      ...(input.parentGrantId ? { parentGrantId: input.parentGrantId } : {}),
      ...(input.consentAt ? { consentAt: input.consentAt } : {}),
    };
    this.state.grants[grant.id] = grant;
    this.audit({ eventType: "grant.issued", outcome: "succeeded", principalId: principal.id, actorId: input.actorId, actorKind: this.state.actors[input.actorId]?.kind, clientId: client.id, sessionId: session.id, taskId: task.id, grantId: grant.id, workspaceId: task.workspaceId, changeId: task.changeId, modelProvider: task.modelProvider, details: { actions: grant.actions, sourceSpaceIds: grant.sourceSpaceIds, policyVersion: grant.policyVersion, authorizationEpoch: grant.authorizationEpoch, parentGrantId: grant.parentGrantId } });
    return clone(grant);
  }

  revokeGrant(grantId: string): { grantId: string; revokedCredentialIds: readonly string[] } {
    const grant = this.state.grants[grantId];
    if (!grant) throw new RealmIdentityError({ code: "grant.not_found", message: `Capability Grant ${grantId} is not available in this Realm.`, affectedObject: grantId, recoveryAction: "inspect the active Task and grant chain", receipt: "grant lookup" });
    const revokedGrantIds = new Set<string>([grantId]);
    grant.status = "revoked";
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const child of Object.values(this.state.grants)) {
        if (child.parentGrantId && revokedGrantIds.has(child.parentGrantId) && child.status === "active") {
          child.status = "revoked";
          revokedGrantIds.add(child.id);
          expanded = true;
        }
      }
    }
    const revokedCredentialIds: string[] = [];
    for (const credential of Object.values(this.state.credentials)) {
      if (!revokedGrantIds.has(credential.grantId) || credential.status !== "active") continue;
      credential.status = "revoked";
      revokedCredentialIds.push(credential.id);
    }
    this.audit({ eventType: "grant.revoked", outcome: "revoked", principalId: grant.principalId, actorId: grant.actorId, actorKind: this.state.actors[grant.actorId]?.kind, clientId: grant.clientId, sessionId: grant.sessionId, taskId: grant.taskId, grantId, workspaceId: grant.resource.workspaceId, projectId: grant.resource.projectId, changeId: grant.resource.changeId, sourceSpaceId: grant.resource.sourceSpaceId, details: { revokedCredentialIds } });
    return { grantId, revokedCredentialIds };
  }

  revokeAgent(agentId: string): { agentId: string; revokedActorIds: readonly string[]; revokedSessionIds: readonly string[]; revokedGrantIds: readonly string[]; revokedCredentialIds: readonly string[]; receipt: string } {
    const agent = this.state.agents[agentId];
    if (!agent || agent.realmId !== this.state.realm.id) throw new RealmIdentityError({ code: "agent.not_found", message: `Agent ${agentId} is not available in this Realm.`, affectedObject: agentId, recoveryAction: "inspect the Realm-owned agent registry and retry with an enrolled agent", receipt: "agent lookup" });
    if (agent.status !== "active") throw new RealmIdentityError({ code: "agent.revoked", message: `Agent ${agentId} is already revoked; existing delegated authority remains closed.`, affectedObject: agentId, recoveryAction: "enroll a new agent identity for a deliberate fresh delegation", receipt: `agent=${agentId}; status=${agent.status}` });
    agent.status = "revoked";
    agent.revokedAt = nowIso(this.now);
    const revokedActorIds: string[] = [];
    const revokedSessionIds: string[] = [];
    const revokedGrantIds = new Set<string>();
    const revokedCredentialIds = new Set<string>();
    for (const actor of Object.values(this.state.actors)) {
      if (actor.agentId !== agentId) continue;
      revokedActorIds.push(actor.actorId);
      const result = this.revokeSession(actor.sessionId);
      revokedSessionIds.push(...result.sessionId === actor.sessionId ? [result.sessionId] : []);
      result.revokedGrantIds.forEach((grantId) => revokedGrantIds.add(grantId));
      result.revokedCredentialIds.forEach((credentialId) => revokedCredentialIds.add(credentialId));
    }
    this.audit({ eventType: "agent.revoked", outcome: "revoked", principalId: agent.principalId, clientId: agent.clientId, modelProvider: agent.modelProvider, details: { agentId, revokedActorIds, revokedSessionIds, revokedGrantIds: [...revokedGrantIds], revokedCredentialIds: [...revokedCredentialIds], delegatedAuthorityClosed: true } });
    return { agentId, revokedActorIds, revokedSessionIds, revokedGrantIds: [...revokedGrantIds], revokedCredentialIds: [...revokedCredentialIds], receipt: `agent=${agentId}; status=revoked; delegated-authority=closed; human-sessions=untouched` };
  }

  revokeSession(sessionId: string): { sessionId: string; revokedGrantIds: readonly string[]; revokedCredentialIds: readonly string[] } {
    const session = this.state.sessions[sessionId];
    if (!session) throw new RealmIdentityError({ code: "session.not_found", message: `Session ${sessionId} is not available in this Realm.`, affectedObject: sessionId, recoveryAction: "authenticate again or inspect the Realm session ledger", receipt: "session lookup" });
    const delegatedSessionIds = new Set<string>([sessionId]);
    let expandedSessions = true;
    while (expandedSessions) {
      expandedSessions = false;
      for (const candidate of Object.values(this.state.sessions)) {
        if (candidate.delegatedBySessionId && delegatedSessionIds.has(candidate.delegatedBySessionId) && !delegatedSessionIds.has(candidate.id)) {
          delegatedSessionIds.add(candidate.id);
          expandedSessions = true;
        }
      }
    }
    for (const affectedSessionId of delegatedSessionIds) {
      const affectedSession = this.state.sessions[affectedSessionId];
      if (!affectedSession) continue;
      affectedSession.status = "revoked";
      const affectedActor = this.state.actors[affectedSession.actorId];
      if (affectedActor) affectedActor.status = "revoked";
      for (const task of Object.values(this.state.tasks)) if (task.sessionId === affectedSessionId && task.status === "active") task.status = "closed";
    }
    const revokedGrantIds = new Set<string>();
    let expandedGrants = true;
    while (expandedGrants) {
      expandedGrants = false;
      for (const grant of Object.values(this.state.grants)) {
        if ((delegatedSessionIds.has(grant.sessionId) || (grant.parentGrantId !== undefined && revokedGrantIds.has(grant.parentGrantId))) && grant.status === "active") {
          grant.status = "revoked";
          revokedGrantIds.add(grant.id);
          expandedGrants = true;
        }
      }
    }
    const revokedCredentialIds = new Set<string>();
    for (const credential of Object.values(this.state.credentials)) {
      if (credential.status !== "active" || (!delegatedSessionIds.has(credential.sessionId) && !revokedGrantIds.has(credential.grantId))) continue;
      credential.status = "revoked";
      revokedCredentialIds.add(credential.id);
    }
    this.audit({ eventType: "session.revoked", outcome: "revoked", principalId: session.principalId, actorId: session.actorId, actorKind: this.state.actors[session.actorId]?.kind, clientId: session.clientId, sessionId, authorityClass: "none", details: { revokedGrantIds: [...revokedGrantIds], revokedCredentialIds: [...revokedCredentialIds], delegatedSessionIds: [...delegatedSessionIds], delegatedSessionsRevoked: delegatedSessionIds.size - 1, authorizationEpoch: this.state.realm.authorizationEpoch } });
    return { sessionId, revokedGrantIds: [...revokedGrantIds], revokedCredentialIds: [...revokedCredentialIds] };
  }

  revokeCredential(credentialId: string): IssuedCredentialRecord {
    const credential = this.state.credentials[credentialId];
    if (!credential) throw new RealmIdentityError({ code: "credential.not_found", message: `Credential ${credentialId} is not available in this Realm.`, affectedObject: credentialId, recoveryAction: "inspect active credential records without exposing token values", receipt: "credential id lookup" });
    credential.status = "revoked";
    this.audit({ eventType: "credential.revoked", outcome: "revoked", principalId: credential.principalId, actorId: credential.actorId, actorKind: this.state.actors[credential.actorId]?.kind, clientId: credential.clientId, sessionId: credential.sessionId, taskId: credential.taskId, grantId: credential.grantId, credentialClass: credential.class, details: { credentialId: credential.id, audience: credential.audience } });
    return clone(credential);
  }

  issueCredential(input: IssueCredentialInput): IssuedCredential {
    const principal = this.requirePrincipal(input.principalId);
    const session = this.requireSession(input.sessionId);
    const client = this.requireClient(input.clientId);
    const grant = this.state.grants[input.grantId];
    const task = this.state.tasks[input.taskId];
    if (!grant || !task || grant.taskId !== task.id || task.id !== input.taskId || grant.principalId !== principal.id || grant.actorId !== input.actorId || grant.clientId !== client.id || grant.sessionId !== session.id || task.principalId !== principal.id || task.actorId !== input.actorId || task.sessionId !== session.id) {
      throw new RealmIdentityError({ code: "credential.chain_invalid", message: "Credential issuance requires one active Principal, Actor, Client, Session, Task, and Grant chain.", recoveryAction: "request a fresh task-scoped credential through the Realm broker", receipt: "credential delegation chain" });
    }
    if (!this.grantChainIsActive(grant)) throw new RealmIdentityError({ code: "credential.grant_inactive", message: "Credential issuance was denied because the Capability Grant is revoked, expired, or stale.", recoveryAction: "renew the task grant after re-authentication and policy evaluation", receipt: `grant=${grant.id}; epoch=${this.state.realm.authorizationEpoch}` });
    if (!client.allowedAudiences.includes(input.class)) throw new RealmIdentityError({ code: "credential.audience_denied", message: `Client ${client.id} is not allowed to issue ${input.class} credentials.`, recoveryAction: "use the client registered for this credential audience", receipt: `client=${client.id}; class=${input.class}` });
    if (!grant.allowedCredentialClasses.includes(input.class)) throw new RealmIdentityError({ code: "credential.class_denied", message: `Capability Grant does not allow ${input.class} credentials.`, recoveryAction: "request an explicit, narrower credential class in the Task Grant", receipt: `grant=${grant.id}; class=${input.class}` });
    if (!resourceMatches(grant.resource, input.resource)) throw new RealmIdentityError({ code: "credential.resource_denied", message: "Capability Grant does not cover the requested credential resource.", recoveryAction: "issue the credential for the exact granted Project, Source Space, Change, or Target", receipt: "credential resource scope" });
    const issuedAt = nowIso(this.now);
    const grantExpiry = Date.parse(grant.expiresAt);
    const requestedExpiry = this.now().getTime() + this.credentialLifetimeMs;
    const expiresAt = new Date(Math.min(grantExpiry, requestedExpiry)).toISOString();
    const token = randomToken();
    const record: IssuedCredentialRecord = {
      protocol: CONTRACT_VERSIONS.credential,
      id: opaqueId("credential"),
      realmId: this.state.realm.id,
      class: input.class,
      audience: CREDENTIAL_AUDIENCES[input.class],
      principalId: principal.id,
      actorId: input.actorId,
      clientId: client.id,
      sessionId: session.id,
      taskId: task.id,
      grantId: grant.id,
      resource: { ...input.resource, realmId: this.state.realm.id },
      tokenDigest: tokenDigest(token),
      issuedAt,
      expiresAt,
      authorizationEpoch: this.state.realm.authorizationEpoch,
      status: "active",
    };
    this.state.credentials[record.id] = record;
    this.audit({ eventType: "credential.issued", outcome: "succeeded", principalId: principal.id, actorId: input.actorId, actorKind: this.state.actors[input.actorId]?.kind, clientId: client.id, sessionId: session.id, taskId: task.id, grantId: grant.id, credentialClass: input.class, workspaceId: task.workspaceId, projectId: record.resource.projectId, changeId: record.resource.changeId, sourceSpaceId: record.resource.sourceSpaceId, authorityClass: input.class === "promotion" ? "promotion" : input.class === "deployment" ? "landing" : "change", details: { credentialId: record.id, audience: record.audience, expiresAt, tokenStored: false } });
    return { ...clone(record), token };
  }

  validateCredential(token: string, input: CredentialValidationInput = {}): CredentialValidationResult {
    const record = Object.values(this.state.credentials).find((candidate) => candidate.tokenDigest === tokenDigest(token));
    if (!record) return { valid: false, code: "credential.invalid", explanation: "Credential is not recognised by this Realm.", receipt: "opaque credential digest lookup" };
    if (record.status === "revoked") return { valid: false, code: "credential.revoked", explanation: "Credential was revoked and cannot be used.", receipt: `credential=${record.id}; status=revoked` };
    if (record.status === "expired" || expired(record.expiresAt, this.now)) {
      record.status = "expired";
      return { valid: false, code: "credential.expired", explanation: "Credential has expired; obtain a fresh short-lived credential.", receipt: `credential=${record.id}; expiresAt=${record.expiresAt}` };
    }
    const grant = this.state.grants[record.grantId];
    const session = this.state.sessions[record.sessionId];
    const principal = this.state.principals[record.principalId];
    const client = this.state.clients[record.clientId];
    if (!grant || !session || !principal || !client || principal.status !== "active" || !this.sessionChainIsActive(session) || !this.grantChainIsActive(grant) || record.authorizationEpoch !== this.state.realm.authorizationEpoch) {
      record.status = "revoked";
      return { valid: false, code: "credential.stale", explanation: "Credential is no longer valid for the current Realm session, grant, or authorization epoch.", receipt: `credential=${record.id}; epoch=${this.state.realm.authorizationEpoch}` };
    }
    if (input.class !== undefined && record.class !== input.class) return { valid: false, code: "credential.audience_mismatch", explanation: "Credential class does not match the requested transport audience.", receipt: `expected-class=${input.class}; actual-class=${record.class}` };
    if (input.audience !== undefined && record.audience !== input.audience) return { valid: false, code: "credential.audience_mismatch", explanation: "Credential audience does not match the requested resource server.", receipt: `expected-audience=${input.audience}; actual-audience=${record.audience}` };
    if (input.resource !== undefined && !resourceMatches(record.resource, input.resource)) return { valid: false, code: "credential.resource_mismatch", explanation: "Credential is scoped to another resource.", receipt: "credential resource scope" };
    this.audit({ eventType: "credential.validated", outcome: "succeeded", principalId: record.principalId, actorId: record.actorId, actorKind: this.state.actors[record.actorId]?.kind, clientId: record.clientId, sessionId: record.sessionId, taskId: record.taskId, grantId: record.grantId, credentialClass: record.class, workspaceId: record.resource.workspaceId, projectId: record.resource.projectId, changeId: record.resource.changeId, sourceSpaceId: record.resource.sourceSpaceId, details: { credentialId: record.id, audience: record.audience } });
    return { valid: true, credential: clone(record) };
  }

  activatePolicy(policyVersion: string): Realm {
    if (!policyVersion.trim()) throw new RealmIdentityError({ code: "policy.version_invalid", message: "Policy version must not be empty.", recoveryAction: "activate an immutable, named policy version", receipt: "policy version validation" });
    this.state.realm.policyVersion = policyVersion;
    this.state.realm.authorizationEpoch += 1;
    this.audit({ eventType: "policy.activated", outcome: "observed", authorityClass: "none", details: { policyVersion, authorizationEpoch: this.state.realm.authorizationEpoch } });
    return clone(this.state.realm);
  }

  evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const capability = capabilityForOperation(input.operation, input.capability);
    const requestedSourceSpaceId = input.sourceSpaceId ?? input.resource.sourceSpaceId;
    const sourcePolicy = requestedSourceSpaceId ? this.state.sourceSpacePolicies[requestedSourceSpaceId] : undefined;
    const sourcePolicyRequired = requestedSourceSpaceId !== undefined || capability === "source.read" || capability === "source.propose";
    const hidden = (sourcePolicy !== undefined && !sourcePolicy.discoverable && !sourcePolicy.readerPrincipalIds.includes(input.principalId)) || input.discoverable === false;
    const safeProjection = !hidden && input.discoverable !== false;
    const visibleResource = resourceForAudit(input.resource, safeProjection);
    const factors: PolicyFactor[] = [];
    const missingCapabilities: Capability[] = [];
    const satisfiedCapabilities: Capability[] = [];
    let unknown = false;
    let denied = false;

    const principal = this.state.principals[input.principalId];
    if (!principal || principal.realmId !== this.state.realm.id || principal.status !== "active") {
      factors.push(factor("principal", principal ? "denied" : "unknown", safeProjection ? "principal is not active in this Realm" : undefined));
      denied = true;
    } else factors.push(factor("principal", "satisfied"));

    const actor = this.state.actors[input.actorId];
    if (!actor || actor.status !== "active" || actor.principalId !== input.principalId || actor.realmId !== this.state.realm.id || (actor.kind === "agent" && (!actor.agentId || this.state.agents[actor.agentId]?.status !== "active"))) {
      factors.push(factor("actor-chain", "denied", safeProjection ? "Actor does not belong to the Principal" : undefined));
      denied = true;
    } else factors.push(factor("actor-chain", "satisfied"));

    const client = this.state.clients[input.clientId];
    if (!client || client.status !== "active" || client.realmId !== this.state.realm.id) {
      factors.push(factor("client", "unknown", safeProjection ? "client is not active" : undefined));
      unknown = true;
    } else if (client.allowedOperations.length > 0 && !client.allowedOperations.includes(input.operation) && !client.allowedOperations.includes(capability)) {
      factors.push(factor("client-consent", "denied", safeProjection ? "client did not consent to this operation" : undefined));
      denied = true;
    } else {
      factors.push(factor("client-consent", "satisfied"));
    }
    if (input.requiredCredentialClass !== undefined) {
      if (!client || !client.allowedAudiences.includes(input.requiredCredentialClass)) {
        factors.push(factor("client-audience", "denied", safeProjection ? `client is not registered for the ${input.requiredCredentialClass} audience` : undefined));
        denied = true;
      } else factors.push(factor("client-audience", "satisfied"));
    }

    const session = this.state.sessions[input.sessionId];
    if (!session || session.principalId !== input.principalId || session.actorId !== input.actorId || session.clientId !== input.clientId) {
      factors.push(factor("session-chain", "unknown", safeProjection ? "session does not match the request chain" : undefined));
      unknown = true;
    } else if (!this.sessionChainIsActive(session)) {
      if (session.status === "active" && expired(session.expiresAt, this.now)) session.status = "expired";
      factors.push(factor("session", "denied", safeProjection ? session.status === "active" ? "the delegated Session chain is inactive" : `session is ${session.status}` : undefined));
      denied = true;
    } else if (input.requiredAuthStrength === "passkey" && session.strength !== "passkey") {
      factors.push(factor("authentication-strength", "denied", safeProjection ? "recent passkey authentication is required" : undefined));
      denied = true;
    } else {
      factors.push(factor("session", "satisfied"));
    }

    const bindings = Object.values(this.state.relationships).filter((binding) => binding.status === "active" && binding.realmId === this.state.realm.id && binding.principalId === input.principalId && resourceMatches(binding.resource, input.resource));
    const roleCapabilities = new Set<Capability>();
    const relationshipDenies = new Set<Capability>();
    for (const binding of bindings) {
      for (const allowed of ROLE_CAPABILITIES[binding.role]) roleCapabilities.add(allowed);
      for (const blocked of binding.deniedCapabilities) relationshipDenies.add(blocked);
    }
    if (roleCapabilities.has(capability)) {
      satisfiedCapabilities.push(capability);
      factors.push(factor("role-and-relationships", "satisfied", safeProjection ? `bindings=${bindings.length}` : undefined));
    } else {
      missingCapabilities.push(capability);
      factors.push(factor("role-and-relationships", "missing", safeProjection ? "no matching role or relationship grants this capability" : undefined));
      denied = true;
    }
    if (relationshipDenies.has(capability)) {
      factors.push(factor("relationship-deny", "denied", safeProjection ? "an explicit relationship deny applies" : undefined));
      denied = true;
    }

    if (!sourcePolicy && sourcePolicyRequired) {
      if (input.protected !== false) {
        factors.push(factor("source-space-policy", "unknown", safeProjection ? "Source Space policy is unavailable" : undefined));
        unknown = true;
      } else factors.push(factor("source-space-policy", "satisfied"));
    } else if (!sourcePolicy) {
      factors.push(factor("source-space-policy", "satisfied", "not applicable to this resource"));
    } else if (hidden) {
      factors.push(factor("source-space-policy", "unknown"));
      unknown = true;
    } else if (sourcePolicy.policyVersion !== this.state.realm.policyVersion) {
      factors.push(factor("source-space-policy", "unknown", safeProjection ? "Source Space policy is stale for the active Realm policy version" : undefined));
      unknown = true;
    } else if (sourcePolicy.readerPrincipalIds.length > 0 && !sourcePolicy.readerPrincipalIds.includes(input.principalId)) {
      factors.push(factor("source-space-readers", "denied", "Principal is not in the Source Space reader set"));
      denied = true;
    } else if (!sourcePolicy.allowedCapabilities.includes(capability)) {
      factors.push(factor("source-space-policy", "denied", "Source Space policy does not allow this capability"));
      denied = true;
    } else {
      factors.push(factor("source-space-policy", "satisfied"));
    }
    if (sourcePolicy?.deniedCapabilities.includes(capability)) {
      factors.push(factor("source-space-deny", "denied", safeProjection ? "Source Space policy explicitly denies this capability" : undefined));
      denied = true;
    }
    if (input.modelProvider && sourcePolicy && sourcePolicy.allowedModelProviders.length > 0 && !sourcePolicy.allowedModelProviders.includes(input.modelProvider)) {
      factors.push(factor("model-provider", "denied", safeProjection ? "model provider is outside the Source Space trust zone" : undefined));
      denied = true;
    }

    let grant: RealmCapabilityGrant | undefined;
    if (!input.grantId || !input.taskId) {
      factors.push(factor("task-grant", "missing", safeProjection ? "protected operations require a task-scoped Capability Grant" : undefined));
      denied = true;
    } else {
      grant = this.state.grants[input.grantId];
      const task = this.state.tasks[input.taskId];
      if (!grant || !task || grant.taskId !== input.taskId || grant.sessionId !== input.sessionId || grant.principalId !== input.principalId || grant.actorId !== input.actorId || grant.clientId !== input.clientId) {
        factors.push(factor("task-grant", "unknown", safeProjection ? "Capability Grant and Task chain do not match" : undefined));
        unknown = true;
      } else if (!this.grantChainIsActive(grant)) {
        if (grant.status === "active" && expired(grant.expiresAt, this.now)) grant.status = "expired";
        factors.push(factor("task-grant", "denied", safeProjection ? "Capability Grant is expired, revoked, or stale" : undefined));
        denied = true;
      } else if (!resourceMatches(grant.resource, input.resource)) {
        factors.push(factor("grant-resource", "denied", safeProjection ? "Capability Grant is scoped to another resource" : undefined));
        denied = true;
      } else if (!grant.actions.includes(capability)) {
        factors.push(factor("grant-capability", "missing", safeProjection ? "Capability Grant does not include the requested capability" : undefined));
        missingCapabilities.push(capability);
        denied = true;
      } else if (grant.deniedActions.includes(capability)) {
        factors.push(factor("grant-deny", "denied", safeProjection ? "Capability Grant explicitly denies the requested capability" : undefined));
        denied = true;
      } else if (requestedSourceSpaceId && !grant.sourceSpaceIds.includes(requestedSourceSpaceId)) {
        factors.push(factor("grant-source-space", "denied", safeProjection ? "Capability Grant does not include this Source Space" : undefined));
        denied = true;
      } else if (input.effect && !grant.effects.includes(input.effect)) {
        factors.push(factor("grant-effect", "missing", safeProjection ? "Capability Grant does not include the requested effect" : undefined));
        denied = true;
      } else if (input.modelProvider && grant.allowedModelProviders.length > 0 && !grant.allowedModelProviders.includes(input.modelProvider)) {
        factors.push(factor("grant-model-provider", "denied", safeProjection ? "Capability Grant does not permit this model provider" : undefined));
        denied = true;
      } else if (input.requiredCredentialClass && !grant.allowedCredentialClasses.includes(input.requiredCredentialClass)) {
        factors.push(factor("grant-audience", "denied", safeProjection ? "Capability Grant does not permit this credential class" : undefined));
        denied = true;
      } else {
        factors.push(factor("task-grant", "satisfied"));
      }
    }

    if (input.approval?.required) {
      if (input.approval.approverActorId && (input.approval.approverActorId === input.approval.authorActorId || input.approval.approverActorId === input.approval.verifierActorId)) {
        factors.push(factor("separation-of-duty", "denied", safeProjection ? "author and verifier cannot approve this operation" : undefined));
        denied = true;
      } else if (input.approval.approved) factors.push(factor("approval", "satisfied"));
      else {
        factors.push(factor("approval", "missing", safeProjection ? "an independent approval is required" : undefined));
        denied = true;
      }
    }

    if (input.authorityClass === "promotion" && !input.promotionId) {
      factors.push(factor("promotion-authority", "missing", safeProjection ? "Promotion authority requires a Promotion identity" : undefined));
      denied = true;
    }

    const decision: PolicyDecisionKind = hidden ? "deny" : denied ? "deny" : unknown ? "indeterminate" : "allow";
    const code = hidden ? "not_found" : decision === "allow" ? "allowed" : decision === "indeterminate" ? "indeterminate" : "forbidden";
    const explanation: PolicyExplanation = {
      protocol: "anyam.policy-explanation/v1",
      id: opaqueId("policy-decision"),
      decision,
      code,
      operation: input.operation,
      ...(visibleResource ? { resource: visibleResource } : {}),
      policyVersion: this.state.realm.policyVersion,
      authorizationEpoch: this.state.realm.authorizationEpoch,
      satisfiedCapabilities,
      missingCapabilities: [...new Set(missingCapabilities)],
      factors,
      remediation: hidden
        ? "request the resource through an owner-approved Source Space or Project View; hidden resources are not disclosed"
        : decision === "allow"
          ? "none"
          : "request the missing capability or approval from the Realm owner, then re-evaluate against the current policy and grant epoch",
      recheckAt: nowIso(this.now),
      safeProjection: !hidden,
    };
    this.audit({
      eventType: "policy.evaluated",
      outcome: decision === "allow" ? "succeeded" : "denied",
      principalId: input.principalId,
      actorId: input.actorId,
      actorKind: actor?.kind,
      clientId: input.clientId,
      modelProvider: input.modelProvider,
      sessionId: input.sessionId,
      taskId: input.taskId,
      grantId: input.grantId,
      workspaceId: input.resource.workspaceId,
      projectId: input.resource.projectId,
      changeId: input.resource.changeId,
      sourceSpaceId: safeProjection ? requestedSourceSpaceId : undefined,
      promotionId: input.promotionId,
      authorityClass: input.authorityClass,
      policyDecisionId: explanation.id,
      details: { operation: input.operation, capability, decision, code, safeProjection: !hidden },
    });
    return { allowed: decision === "allow", explanation };
  }

  authorize(input: PolicyEvaluationInput): PolicyExplanation {
    const result = this.evaluate(input);
    if (!result.allowed) {
      throw new RealmIdentityError({
        code: result.explanation.code,
        message: result.explanation.code === "not_found"
          ? "The requested resource is not available in this Realm."
          : `Capability ${input.capability ?? input.operation} is ${result.explanation.decision} for this request.`,
        explanation: result.explanation,
        recoveryAction: result.explanation.remediation,
        receipt: `policy=${result.explanation.policyVersion}; epoch=${result.explanation.authorizationEpoch}; decision=${result.explanation.decision}`,
      });
    }
    return result.explanation;
  }
}

export { RealmIdentityPolicy as RealmPolicy };
