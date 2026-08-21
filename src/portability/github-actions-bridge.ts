import { CONTRACT_VERSIONS, opaqueId } from "../kernel/contracts.ts";

export const GITHUB_ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com" as const;

export type GitHubActionsBridgeOperation = "inbound" | "outbound";
export type GitHubActionsEventName = "push" | "pull_request" | "workflow_dispatch";

export type GitHubActionsBridgeConnectionInput = {
  id?: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  repository: string;
  repositoryId: string;
  workflowRef: string;
  expectedJobWorkflowRef: string | null;
  ref: string;
  audience: string;
  allowedEvents: readonly GitHubActionsEventName[];
  allowedOperations: readonly GitHubActionsBridgeOperation[];
  expiresAt: string;
};

type ConnectionBase = {
  protocol: typeof CONTRACT_VERSIONS.githubActionsBridge;
  id: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  repository: string;
  repositoryId: string;
  workflowRef: string;
  expectedJobWorkflowRef: string | null;
  ref: string;
  audience: string;
  allowedEvents: readonly GitHubActionsEventName[];
  allowedOperations: readonly GitHubActionsBridgeOperation[];
  createdAt: string;
};

export type GitHubActionsBridgeConnection =
  | (ConnectionBase & { status: "pending"; workflowSha: null; expiresAt: string })
  | (ConnectionBase & { status: "active"; workflowSha: string; expiresAt: null; activatedAt: string })
  | (ConnectionBase & { status: "revoked" | "expired" | "blocked"; workflowSha: string | null; expiresAt: string | null; closedAt: string; reason: string });

export type GitHubActionsOidcClaims = {
  issuer: typeof GITHUB_ACTIONS_OIDC_ISSUER;
  subject: string;
  audience: string;
  repositoryOwner: string;
  repositoryOwnerId: string;
  repository: string;
  repositoryId: string;
  workflowRef: string;
  workflowSha: string;
  ref: string;
  eventName: GitHubActionsEventName;
  jti: string;
  runId: string;
  issuedAt: string;
  expiresAt: string;
  notBefore: string | undefined;
  jobWorkflowRef: string | undefined;
  jobWorkflowSha: string | undefined;
};

export type GitHubActionsOidcVerification =
  | { status: "verified"; claims: unknown; receipt: string }
  | { status: "failed"; code: string; recoveryAction: string; receipt: string };

export type GitHubActionsOidcVerifier = {
  verify(input: { token: string; audience: string }): Promise<GitHubActionsOidcVerification>;
};

export type GitHubActionsBridgeCapability = {
  protocol: typeof CONTRACT_VERSIONS.githubActionsBridge;
  id: string;
  connectionId: string;
  realmId: string;
  projectId: string;
  sourceSpaceId: string;
  operation: GitHubActionsBridgeOperation;
  repositoryOwnerId: string;
  repositoryId: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  jtiDigest: string;
  issuedAt: string;
  expiresAt: string;
  status: "active";
  canonicalWrite: false;
  receipt: string;
};

export type GitHubActionsBridgeFailure = {
  status: "failed";
  code: string;
  message: string;
  recoveryAction: string;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeSuccess<T> = {
  status: "succeeded";
  value: T;
  receipt: string;
  credentialMaterialStored: false;
};

export type GitHubActionsBridgeResult<T> = GitHubActionsBridgeSuccess<T> | GitHubActionsBridgeFailure;

export type GitHubActionsBridgeReplayLedger = {
  claim(input: { connectionId: string; jtiDigest: string; expiresAt: string }): Promise<"claimed" | "duplicate">;
};

export class MemoryGitHubActionsBridgeReplayLedger implements GitHubActionsBridgeReplayLedger {
  private readonly claims = new Map<string, number>();
  private readonly now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now;
  }

  async claim(input: { connectionId: string; jtiDigest: string; expiresAt: string }): Promise<"claimed" | "duplicate"> {
    const now = Date.parse(this.now());
    for (const [key, expiresAt] of this.claims) if (expiresAt <= now) this.claims.delete(key);
    const key = `${input.connectionId}:${input.jtiDigest}`;
    if (this.claims.has(key)) return "duplicate";
    this.claims.set(key, Date.parse(input.expiresAt));
    return "claimed";
  }
}

export class GitHubActionsBridgeInputError extends Error {
  readonly code: string;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: { code: string; message: string; recoveryAction: string; receipt: string }) {
    super(input.message);
    this.name = "GitHubActionsBridgeInputError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function failure(input: { code: string; message: string; recoveryAction: string; receipt: string }): GitHubActionsBridgeFailure {
  return { status: "failed", ...input, credentialMaterialStored: false };
}

function success<T>(value: T, receipt: string): GitHubActionsBridgeSuccess<T> {
  return { status: "succeeded", value, receipt, credentialMaterialStored: false };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubActionsBridgeInputError({ code: "claims_malformed", message: `${field} must be a JSON object.`, recoveryAction: "retry the bridge run with the verifier's parsed OIDC claims; no capability was issued", receipt: `${field}=object-required; capability=not-issued` });
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new GitHubActionsBridgeInputError({ code: "input_invalid", message: `${field} must be a non-empty string.`, recoveryAction: `provide a non-empty ${field} and retry; no bridge state changed`, receipt: `${field}=required; transition=not-applied` });
  return value.trim();
}

function timestamp(value: unknown, field: string, now: number, relation: "future" | "past-or-present"): string {
  const text = nonEmpty(value, field);
  const parsed = Date.parse(text);
  const valid = Number.isFinite(parsed) && (relation === "future" ? parsed > now : parsed <= now);
  if (!valid) throw new GitHubActionsBridgeInputError({ code: "timestamp_invalid", message: `${field} must be a valid ${relation === "future" ? "future" : "past or present"} ISO timestamp.`, recoveryAction: `provide a measured ${field} timestamp and retry; no bridge state changed`, receipt: `${field}=${text}; relation=${relation}; transition=not-applied` });
  return text;
}

function list<T extends string>(value: unknown, field: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length === 0) throw new GitHubActionsBridgeInputError({ code: "input_invalid", message: `${field} must contain at least one supported value.`, recoveryAction: `provide a non-empty ${field} list and retry; no bridge state changed`, receipt: `${field}=non-empty-list-required; transition=not-applied` });
  const result: T[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new GitHubActionsBridgeInputError({ code: "input_invalid", message: `${field} contains a non-string value.`, recoveryAction: `provide only supported ${field} values and retry; no bridge state changed`, receipt: `${field}=string-required; transition=not-applied` });
    const found = allowed.find((candidate) => candidate === item);
    if (!found) throw new GitHubActionsBridgeInputError({ code: "input_invalid", message: `${field} contains unsupported value ${item}.`, recoveryAction: `choose a supported ${field} value and retry; no bridge state changed`, receipt: `${field}=${item}; supported=false; transition=not-applied` });
    if (!result.includes(found)) result.push(found);
  }
  return result;
}

function digest(value: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((bytes) => `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`);
}

function parseClaims(value: unknown, now: number): GitHubActionsOidcClaims {
  const raw = object(value, "claims");
  const issuer = nonEmpty(raw.iss, "claims.iss");
  if (issuer !== GITHUB_ACTIONS_OIDC_ISSUER) throw new GitHubActionsBridgeInputError({ code: "issuer_mismatch", message: "The OIDC issuer is not GitHub Actions.", recoveryAction: "request a token from https://token.actions.githubusercontent.com and retry; no capability was issued", receipt: `issuer=${issuer}; expected=${GITHUB_ACTIONS_OIDC_ISSUER}; capability=not-issued` });
  const eventName = nonEmpty(raw.event_name, "claims.event_name");
  if (eventName !== "push" && eventName !== "pull_request" && eventName !== "workflow_dispatch") throw new GitHubActionsBridgeInputError({ code: "event_invalid", message: `GitHub Actions event ${eventName} is unsupported.`, recoveryAction: "use push, pull_request, or workflow_dispatch according to the Bridge connection policy", receipt: `event=${eventName}; capability=not-issued` });
  return {
    issuer: GITHUB_ACTIONS_OIDC_ISSUER,
    subject: nonEmpty(raw.sub, "claims.sub"),
    audience: nonEmpty(raw.aud, "claims.aud"),
    repositoryOwner: nonEmpty(raw.repository_owner, "claims.repository_owner"),
    repositoryOwnerId: nonEmpty(raw.repository_owner_id, "claims.repository_owner_id"),
    repository: nonEmpty(raw.repository, "claims.repository"),
    repositoryId: nonEmpty(raw.repository_id, "claims.repository_id"),
    workflowRef: nonEmpty(raw.workflow_ref, "claims.workflow_ref"),
    workflowSha: nonEmpty(raw.workflow_sha, "claims.workflow_sha"),
    ref: nonEmpty(raw.ref, "claims.ref"),
    eventName,
    jti: nonEmpty(raw.jti, "claims.jti"),
    runId: nonEmpty(raw.run_id, "claims.run_id"),
    issuedAt: timestamp(raw.iat, "claims.iat", now, "past-or-present"),
    expiresAt: timestamp(raw.exp, "claims.exp", now, "future"),
    notBefore: raw.nbf === undefined ? undefined : timestamp(raw.nbf, "claims.nbf", now, "past-or-present"),
    jobWorkflowRef: raw.job_workflow_ref === undefined ? undefined : nonEmpty(raw.job_workflow_ref, "claims.job_workflow_ref"),
    jobWorkflowSha: raw.job_workflow_sha === undefined ? undefined : nonEmpty(raw.job_workflow_sha, "claims.job_workflow_sha"),
  };
}

function connectionFields(input: GitHubActionsBridgeConnectionInput, now: number): Omit<ConnectionBase, "id" | "createdAt"> & { expiresAt: string } {
  const realmId = nonEmpty(input.realmId, "realmId");
  const projectId = nonEmpty(input.projectId, "projectId");
  const sourceSpaceId = nonEmpty(input.sourceSpaceId, "sourceSpaceId");
  const repositoryOwner = nonEmpty(input.repositoryOwner, "repositoryOwner");
  const repositoryOwnerId = nonEmpty(input.repositoryOwnerId, "repositoryOwnerId");
  const repository = nonEmpty(input.repository, "repository");
  const repositoryId = nonEmpty(input.repositoryId, "repositoryId");
  const workflowRef = nonEmpty(input.workflowRef, "workflowRef");
  const expectedJobWorkflowRef = input.expectedJobWorkflowRef === null ? null : nonEmpty(input.expectedJobWorkflowRef, "expectedJobWorkflowRef");
  const ref = nonEmpty(input.ref, "ref");
  const audience = nonEmpty(input.audience, "audience");
  const allowedEvents = list(input.allowedEvents, "allowedEvents", ["push", "pull_request", "workflow_dispatch"] as const);
  const allowedOperations = list(input.allowedOperations, "allowedOperations", ["inbound", "outbound"] as const);
  const expiresAt = timestamp(input.expiresAt, "expiresAt", now, "future");
  return { protocol: CONTRACT_VERSIONS.githubActionsBridge, realmId, projectId, sourceSpaceId, repositoryOwner, repositoryOwnerId, repository, repositoryId, workflowRef, expectedJobWorkflowRef, ref, audience, allowedEvents, allowedOperations, expiresAt };
}

function stateFailure(connection: GitHubActionsBridgeConnection): GitHubActionsBridgeFailure {
  const recoveryAction = connection.status === "expired" ? "create a fresh pending Bridge connection and rerun the workflow" : connection.status === "blocked" ? "inspect and approve the exact workflow revision before creating a fresh connection" : "revoke or reactivate the Bridge through its owner-controlled connection operation";
  return failure({ code: `connection_${connection.status}`, message: `GitHub Actions Bridge connection ${connection.id} is ${connection.status}.`, recoveryAction, receipt: `connection=${connection.id}; status=${connection.status}; capability=not-issued` });
}

/**
 * Provider-neutral trust kernel. A customer Realm must persist the connection,
 * capability, and replay maps in its durable coordinator before production
 * use; this in-memory implementation is the qualification seam.
 */
export class GitHubActionsBridgeAuthority {
  private readonly connections = new Map<string, GitHubActionsBridgeConnection>();
  private readonly capabilities = new Map<string, GitHubActionsBridgeCapability>();
  private readonly replayLedger: GitHubActionsBridgeReplayLedger;
  private readonly now: () => string;

  constructor(input: { now?: () => string; replayLedger?: GitHubActionsBridgeReplayLedger } = {}) {
    this.now = input.now ?? (() => new Date().toISOString());
    this.replayLedger = input.replayLedger ?? new MemoryGitHubActionsBridgeReplayLedger(this.now);
  }

  createPendingConnection(input: GitHubActionsBridgeConnectionInput): GitHubActionsBridgeResult<GitHubActionsBridgeConnection> {
    try {
      const createdAt = this.now();
      const fields = connectionFields(input, Date.parse(createdAt));
      const id = input.id === undefined ? opaqueId("github-bridge") : nonEmpty(input.id, "id");
      if (this.connections.has(id)) return failure({ code: "connection_exists", message: `GitHub Actions Bridge connection ${id} already exists.`, recoveryAction: "reuse the existing pending connection or choose a new connection identity", receipt: `connection=${id}; exists=true; transition=not-applied` });
      const connection: GitHubActionsBridgeConnection = { ...fields, id, createdAt, status: "pending", workflowSha: null };
      this.connections.set(id, connection);
      return success(clone(connection), `connection=${id}; status=pending; provider=github-actions-oidc; credentialMaterialStored=false`);
    } catch (error) {
      return error instanceof GitHubActionsBridgeInputError ? failure(error) : failure({ code: "connection_create_failed", message: "GitHub Actions Bridge connection was not created.", recoveryAction: "inspect the connection inputs and retry without changing an existing connection", receipt: "connection=not-created; transition=not-applied" });
    }
  }

  async exchange(input: { connectionId: string; operation: GitHubActionsBridgeOperation; token: string; verifier: GitHubActionsOidcVerifier }): Promise<GitHubActionsBridgeResult<{ connection: GitHubActionsBridgeConnection; capability: GitHubActionsBridgeCapability }>> {
    const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
    const connection = this.connections.get(connectionId);
    if (!connection) return failure({ code: "connection_not_found", message: `GitHub Actions Bridge connection ${connectionId || "missing"} is not available.`, recoveryAction: "start a new Anyam GitHub connection and use its generated workflow identifier", receipt: `connection=${connectionId || "missing"}; capability=not-issued; discoverable=false` });
    const nowText = this.now();
    const now = Date.parse(nowText);
    if (connection.status === "pending" && Date.parse(connection.expiresAt) <= now) {
      const expired: GitHubActionsBridgeConnection = { ...connection, status: "expired", closedAt: nowText, reason: "pending connection expired", expiresAt: connection.expiresAt };
      this.connections.set(connection.id, expired);
      return stateFailure(expired);
    }
    if (connection.status !== "pending" && connection.status !== "active") return stateFailure(connection);
    if (!connection.allowedOperations.includes(input.operation)) return failure({ code: "operation_denied", message: `Bridge connection ${connection.id} does not allow ${input.operation}.`, recoveryAction: "create a connection whose declared operation set includes this exact direction", receipt: `connection=${connection.id}; operation=${input.operation}; allowed=${connection.allowedOperations.join(",")}; capability=not-issued` });
    if (typeof input.token !== "string" || input.token.trim().length === 0) return failure({ code: "oidc_token_missing", message: "The GitHub OIDC token is missing.", recoveryAction: "request a fresh OIDC token from the GitHub Actions job and retry; no capability was issued", receipt: `connection=${connection.id}; token=missing; capability=not-issued; credentialMaterialStored=false` });
    let verification: GitHubActionsOidcVerification;
    try {
      verification = await input.verifier.verify({ token: input.token, audience: connection.audience });
    } catch {
      return failure({ code: "oidc_verification_failed", message: "The GitHub OIDC verifier failed before returning a result.", recoveryAction: "inspect the customer-owned OIDC verifier and retry the same Bridge connection", receipt: `connection=${connection.id}; verifier=exception; capability=not-issued; credentialMaterialStored=false` });
    }
    if (verification.status !== "verified") return failure({ code: verification.code, message: "The GitHub OIDC assertion was not verified.", recoveryAction: verification.recoveryAction, receipt: `${verification.receipt}; connection=${connection.id}; capability=not-issued; credentialMaterialStored=false` });
    let claims: GitHubActionsOidcClaims;
    try {
      claims = parseClaims(verification.claims, now);
    } catch (error) {
      return error instanceof GitHubActionsBridgeInputError ? failure(error) : failure({ code: "claims_malformed", message: "The verified GitHub OIDC claims were malformed.", recoveryAction: "return the standard GitHub Actions claims and retry; no capability was issued", receipt: `connection=${connection.id}; claims=malformed; capability=not-issued` });
    }
    const claimFailure = this.validateClaims(connection, claims);
    if (claimFailure) return claimFailure;
    let jtiDigest: string;
    let replay: "claimed" | "duplicate";
    try {
      jtiDigest = await digest(claims.jti);
      replay = await this.replayLedger.claim({ connectionId: connection.id, jtiDigest, expiresAt: claims.expiresAt });
    } catch {
      return failure({ code: "replay_ledger_unavailable", message: "The Bridge replay ledger was unavailable; no capability was issued.", recoveryAction: "restore the durable replay ledger and retry the same workflow run only after checking whether its jti was accepted", receipt: `connection=${connection.id}; replayLedger=unavailable; capability=not-issued; credentialMaterialStored=false` });
    }
    if (replay === "duplicate") return failure({ code: "oidc_replay", message: "The GitHub OIDC assertion was already used for this Bridge connection.", recoveryAction: "request a fresh OIDC token from a new workflow run; no capability was issued", receipt: `connection=${connection.id}; jtiDigest=${jtiDigest}; replay=true; capability=not-issued; credentialMaterialStored=false` });
    const activeConnection: GitHubActionsBridgeConnection = connection.status === "pending"
      ? { ...connection, status: "active", workflowSha: claims.workflowSha, expiresAt: null, activatedAt: nowText }
      : connection;
    this.connections.set(connection.id, activeConnection);
    const capability: GitHubActionsBridgeCapability = { protocol: CONTRACT_VERSIONS.githubActionsBridge, id: opaqueId("github-bridge-capability"), connectionId: connection.id, realmId: connection.realmId, projectId: connection.projectId, sourceSpaceId: connection.sourceSpaceId, operation: input.operation, repositoryOwnerId: connection.repositoryOwnerId, repositoryId: connection.repositoryId, workflowRef: connection.workflowRef, workflowSha: claims.workflowSha, runId: claims.runId, jtiDigest, issuedAt: claims.issuedAt, expiresAt: claims.expiresAt, status: "active", canonicalWrite: false, receipt: `capability=issued; connection=${connection.id}; operation=${input.operation}; repositoryId=${connection.repositoryId}; workflowSha=${claims.workflowSha}; jtiDigest=${jtiDigest}; canonicalWrite=false; credentialMaterialStored=false` };
    this.capabilities.set(capability.id, capability);
    return success({ connection: clone(activeConnection), capability: clone(capability) }, `${capability.receipt}; provider=github-actions-oidc; liveProviderQualification=not-claimed`);
  }

  authorize(capabilityId: string, operation: GitHubActionsBridgeOperation): GitHubActionsBridgeResult<GitHubActionsBridgeCapability> {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) return failure({ code: "capability_not_found", message: `GitHub Actions Bridge capability ${capabilityId || "missing"} is not available.`, recoveryAction: "exchange a fresh verified OIDC assertion for the exact Bridge operation", receipt: `capability=${capabilityId || "missing"}; capability=denied; credentialMaterialStored=false` });
    if (capability.operation !== operation) return failure({ code: "capability_operation_mismatch", message: `Bridge capability ${capability.id} is scoped to ${capability.operation}, not ${operation}.`, recoveryAction: "request the capability for the exact operation; authority was not widened", receipt: `capability=${capability.id}; expected=${capability.operation}; asked=${operation}; capability=denied` });
    if (Date.parse(capability.expiresAt) <= Date.parse(this.now())) return failure({ code: "capability_expired", message: `Bridge capability ${capability.id} has expired.`, recoveryAction: "request a fresh OIDC token from a new workflow run", receipt: `capability=${capability.id}; expiresAt=${capability.expiresAt}; capability=expired; credentialMaterialStored=false` });
    const connection = this.connections.get(capability.connectionId);
    if (!connection || connection.status === "revoked") return failure({ code: "connection_revoked", message: `Bridge connection ${capability.connectionId} is revoked or unavailable.`, recoveryAction: "reconnect the repository through a new owner-approved Bridge connection", receipt: `capability=${capability.id}; connection=${capability.connectionId}; capability=denied; credentialMaterialStored=false` });
    if (connection.status !== "active") return failure({ code: `connection_${connection.status}`, message: `Bridge connection ${capability.connectionId} is ${connection.status}.`, recoveryAction: "inspect the connection state and create a fresh connection when required", receipt: `capability=${capability.id}; connection=${capability.connectionId}; status=${connection.status}; capability=denied` });
    return success(clone(capability), `capability=${capability.id}; operation=${operation}; connection=${connection.id}; authorized=true; credentialMaterialStored=false`);
  }

  revokeConnection(connectionId: string, reason: string): GitHubActionsBridgeResult<GitHubActionsBridgeConnection> {
    const connection = this.connections.get(connectionId);
    if (!connection) return failure({ code: "connection_not_found", message: `GitHub Actions Bridge connection ${connectionId || "missing"} is not available.`, recoveryAction: "inspect the connection identifier and retry the same disconnect operation", receipt: `connection=${connectionId || "missing"}; transition=not-applied; discoverable=false` });
    if (connection.status === "revoked") return success(clone(connection), `connection=${connection.id}; status=revoked; transition=idempotent; credentialMaterialStored=false`);
    let normalizedReason: string;
    try {
      normalizedReason = nonEmpty(reason, "reason");
    } catch (error) {
      return error instanceof GitHubActionsBridgeInputError ? failure(error) : failure({ code: "reason_invalid", message: "Bridge disconnect reason was not accepted.", recoveryAction: "provide a non-empty owner-visible disconnect reason and retry", receipt: `connection=${connection.id}; reason=invalid; transition=not-applied` });
    }
    const closed: GitHubActionsBridgeConnection = { ...connection, status: "revoked", closedAt: this.now(), reason: normalizedReason, ...(connection.status === "pending" ? { workflowSha: null, expiresAt: connection.expiresAt } : { workflowSha: connection.workflowSha, expiresAt: null }) };
    this.connections.set(connection.id, closed);
    return success(clone(closed), `connection=${connection.id}; status=revoked; activeCapabilities=denied-at-check; credentialMaterialStored=false`);
  }

  snapshot(): { connections: Readonly<Record<string, GitHubActionsBridgeConnection>>; capabilities: Readonly<Record<string, GitHubActionsBridgeCapability>>; credentialMaterialStored: false; receipt: string } {
    return { connections: Object.fromEntries([...this.connections].map(([id, value]) => [id, clone(value)])), capabilities: Object.fromEntries([...this.capabilities].map(([id, value]) => [id, clone(value)])), credentialMaterialStored: false, receipt: `provider=github-actions-oidc; connections=${this.connections.size}; capabilities=${this.capabilities.size}; storage=memory-qualification; tokenMaterial=not-stored; liveProviderQualification=not-claimed` };
  }

  private validateClaims(connection: GitHubActionsBridgeConnection, claims: GitHubActionsOidcClaims): GitHubActionsBridgeFailure | undefined {
    if (claims.audience !== connection.audience) return failure({ code: "audience_mismatch", message: "The GitHub OIDC audience does not match the Bridge connection.", recoveryAction: "request the token with the exact customer Realm Bridge audience", receipt: `connection=${connection.id}; audience=denied; capability=not-issued` });
    if (claims.repositoryId !== connection.repositoryId || claims.repositoryOwnerId !== connection.repositoryOwnerId || claims.repository !== connection.repository || claims.repositoryOwner !== connection.repositoryOwner) return failure({ code: "repository_mismatch", message: "The GitHub OIDC repository identity does not match the Bridge connection.", recoveryAction: "reconcile the repository transfer or create a fresh connection for the exact repository IDs", receipt: `connection=${connection.id}; repositoryIdentity=denied; capability=not-issued` });
    if (claims.workflowRef !== connection.workflowRef) return failure({ code: "workflow_mismatch", message: "The GitHub workflow ref does not match the Bridge connection.", recoveryAction: "run the generated Anyam workflow from the approved workflow path and ref", receipt: `connection=${connection.id}; workflowRef=denied; capability=not-issued` });
    if (claims.ref !== connection.ref) return failure({ code: "ref_mismatch", message: "The GitHub workflow ref is outside the Bridge connection policy.", recoveryAction: "run the Bridge from the configured repository ref", receipt: `connection=${connection.id}; ref=${claims.ref}; expected=${connection.ref}; capability=not-issued` });
    if (!connection.allowedEvents.includes(claims.eventName)) return failure({ code: "event_denied", message: `The GitHub event ${claims.eventName} is not allowed for this Bridge connection.`, recoveryAction: "use an allowed Bridge event or create a connection with an explicit event policy", receipt: `connection=${connection.id}; event=${claims.eventName}; capability=not-issued` });
    if (connection.expectedJobWorkflowRef !== null && claims.jobWorkflowRef !== connection.expectedJobWorkflowRef) return failure({ code: "reusable_workflow_mismatch", message: "The reusable workflow identity does not match the Bridge connection.", recoveryAction: "run the approved reusable workflow or update the connection through owner review", receipt: `connection=${connection.id}; jobWorkflowRef=denied; capability=not-issued` });
    if (connection.status === "active" && claims.workflowSha !== connection.workflowSha) {
      const blocked: GitHubActionsBridgeConnection = { ...connection, status: "blocked", closedAt: this.now(), reason: "workflow SHA changed", expiresAt: null };
      this.connections.set(connection.id, blocked);
      return failure({ code: "workflow_changed", message: "The approved GitHub workflow changed after the Bridge was activated.", recoveryAction: "review the workflow change and create a fresh owner-approved Bridge connection", receipt: `connection=${connection.id}; workflowSha=changed; status=blocked; capability=not-issued` });
    }
    return undefined;
  }
}
