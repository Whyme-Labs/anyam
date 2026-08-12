import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  deriveProjectView,
  opaqueId,
  type ActorRef,
  type Artifact,
  type Change,
  type ChangeRevision,
  type DisclosureClassification,
  type Evidence,
  type Landing,
  type Project,
  type ProjectRevision,
  type ProjectView,
  type Release,
  type Run,
  type SourceSpace,
  type Target,
  type Workspace,
  type WorkspaceMount,
} from "../kernel/contracts.ts";
import type { PromotionRecord } from "../delivery/promotion.ts";
import {
  PROMOTION_EXECUTION_PROTOCOL,
  createPromotionExecutionContext,
  normalizePromotionExecutionResult,
  targetAfterPromotion,
  type PromotionExecutionRequest,
  type PromotionExecutionResult,
  PromotionExecutionValidationError,
} from "./promotion-execution.ts";

export const AUTHORITY_PLANE_PROTOCOL = "anyam.authority-plane/v1" as const;
export const AUTHORITY_COMMAND_PROTOCOL = "anyam.authority-command/v1" as const;

export type AuthorityCommandName =
  | "project.create"
  | "workspace.create"
  | "change.create"
  | "revision.publish"
  | "run.record"
  | "evidence.record"
  | "artifact.record"
  | "landing.apply"
  | "release.create"
  | "target.configure"
  | "promotion.request"
  | "promotion.execute";

export type AuthoritySession = {
  realmId: string;
  principalId: string;
  actorId: string;
  sessionId: string;
  clientId: string;
  authorizationEpoch: number;
};

export type AuthorityAuditEvent = {
  id: string;
  command: AuthorityCommandName;
  idempotencyKey: string;
  actor: ActorRef;
  outcome: "succeeded" | "blocked" | "indeterminate";
  stateVersion: number;
  occurredAt: string;
  receipt: string;
};

type IdempotencyRecord = {
  fingerprint: string;
  result: AuthorityCommandResult;
};

export type AuthorityPlaneSnapshot = {
  protocol: typeof AUTHORITY_PLANE_PROTOCOL;
  realmId: string;
  version: number;
  projects: Record<string, Project>;
  sourceSpaces: Record<string, SourceSpace>;
  projectRevisions: Record<string, ProjectRevision>;
  projectViews: Record<string, ProjectView>;
  workspaces: Record<string, Workspace>;
  changes: Record<string, Change>;
  changeRevisions: Record<string, ChangeRevision>;
  runs: Record<string, Run>;
  evidence: Record<string, Evidence>;
  artifacts: Record<string, Artifact>;
  landings: Record<string, Landing>;
  releases: Record<string, Release>;
  targets: Record<string, Target>;
  promotions: Record<string, PromotionRecord>;
  canonicalByProject: Record<string, string>;
  idempotency: Record<string, IdempotencyRecord>;
  audit: AuthorityAuditEvent[];
};

export type AuthorityCommand = {
  protocol: typeof AUTHORITY_COMMAND_PROTOCOL;
  command: AuthorityCommandName;
  idempotencyKey: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
};

export type AuthorityCommandResult = {
  protocol: typeof AUTHORITY_PLANE_PROTOCOL;
  command: AuthorityCommandName;
  status: "succeeded" | "blocked" | "indeterminate";
  version: number;
  value: Record<string, unknown>;
  receipt: string;
  recoveryAction?: string;
};

export class AuthorityPlaneError extends Error {
  readonly code:
    | "invalid_request"
    | "idempotency_conflict"
    | "stale_state"
    | "not_found"
    | "conflict"
    | "blocked"
    | "indeterminate";
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(input: {
    code: AuthorityPlaneError["code"];
    message: string;
    recoveryAction: string;
    receipt: string;
  }) {
    super(input.message);
    this.name = "AuthorityPlaneError";
    this.code = input.code;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} is required.`,
      recoveryAction: `provide a non-empty ${field} and retry; no authority transition was accepted`,
      receipt: `${field}=required; transition=not-applied`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} must be an array of non-empty strings.`,
      recoveryAction: `provide a valid ${field} array and retry; no authority transition was accepted`,
      receipt: `${field}=string-array-required; transition=not-applied`,
    });
  }
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function record<T>(value: unknown, field: string): Record<string, T> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthorityPlaneError({
      code: "invalid_request",
      message: `${field} must be an object.`,
      recoveryAction: `provide a JSON object for ${field} and retry; no authority transition was accepted`,
      receipt: `${field}=object-required; transition=not-applied`,
    });
  }
  return value as Record<string, T>;
}

function fingerprint(command: AuthorityCommand): string {
  return JSON.stringify({
    protocol: command.protocol,
    command: command.command,
    idempotencyKey: command.idempotencyKey,
    expectedVersion: command.expectedVersion,
    payload: command.payload,
  });
}

function actorRef(session: AuthoritySession): ActorRef {
  return {
    principalId: session.principalId,
    actorId: session.actorId,
    sessionId: session.sessionId,
    clientId: session.clientId,
  };
}

function now(): string {
  return new Date().toISOString();
}

export function emptyAuthorityPlaneSnapshot(realmId: string): AuthorityPlaneSnapshot {
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    realmId,
    version: 0,
    projects: {},
    sourceSpaces: {},
    projectRevisions: {},
    projectViews: {},
    workspaces: {},
    changes: {},
    changeRevisions: {},
    runs: {},
    evidence: {},
    artifacts: {},
    landings: {},
    releases: {},
    targets: {},
    promotions: {},
    canonicalByProject: {},
    idempotency: {},
    audit: [],
  };
}

export class AuthorityPlaneCoordinator {
  private state: AuthorityPlaneSnapshot;

  constructor(snapshot: AuthorityPlaneSnapshot) {
    this.state = clone(snapshot);
  }

  snapshot(): AuthorityPlaneSnapshot {
    return clone(this.state);
  }

  execute(command: AuthorityCommand, session: AuthoritySession): AuthorityCommandResult {
    if (command.protocol !== AUTHORITY_COMMAND_PROTOCOL) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: `Unsupported authority command protocol ${command.protocol}.`,
        recoveryAction: "send an anyam.authority-command/v1 envelope; no authority transition was accepted",
        receipt: `protocol=${command.protocol}; transition=not-applied`,
      });
    }
    if (session.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: "The authenticated session belongs to a different Realm.",
        recoveryAction: "route the command through the Durable Object bound to the authenticated Realm",
        receipt: `sessionRealm=${session.realmId}; stateRealm=${this.state.realmId}; transition=not-applied`,
      });
    }
    const idempotencyKey = requiredString(command.idempotencyKey, "idempotencyKey");
    const existing = this.state.idempotency[idempotencyKey];
    const requestFingerprint = fingerprint({ ...command, idempotencyKey });
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AuthorityPlaneError({
          code: "idempotency_conflict",
          message: `Idempotency key ${idempotencyKey} was already used for a different Authority command.`,
          recoveryAction: "reuse the original command payload or choose a new idempotency key; authoritative state was unchanged",
          receipt: `idempotencyKey=${idempotencyKey}; conflict=true; stateVersion=${this.state.version}; overwritten=false`,
        });
      }
      return clone(existing.result);
    }
    if (command.expectedVersion !== undefined && command.expectedVersion !== this.state.version) {
      throw new AuthorityPlaneError({
        code: "stale_state",
        message: `Authority state changed before ${command.command} was accepted.`,
        recoveryAction: "read the current authority state and retry the same intent with its version and a fresh idempotency key",
        receipt: `expectedVersion=${command.expectedVersion}; actualVersion=${this.state.version}; overwritten=false`,
      });
    }

    const next = clone(this.state);
    const result = this.apply(next, command, session);
    next.version += 1;
    result.version = next.version;
    next.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
    next.audit.push({
      id: opaqueId("authority-audit"),
      command: command.command,
      idempotencyKey,
      actor: actorRef(session),
      outcome: result.status,
      stateVersion: next.version,
      occurredAt: now(),
      receipt: result.receipt,
    });
    this.state = next;
    return clone(result);
  }

  /**
   * Execute one already-recorded Promotion through a trusted provider
   * capability. The executor is injected by the coordinator boundary; a
   * caller can supply only the Promotion identity and execution idempotency
   * key. Provider results are validated against a detached Authority context
   * before the Target pointer or Promotion state changes.
   */
  async executePromotion(input: PromotionExecutionRequest): Promise<AuthorityCommandResult> {
    if (input.session.realmId !== this.state.realmId) {
      throw new AuthorityPlaneError({
        code: "invalid_request",
        message: "The authenticated session belongs to a different Realm.",
        recoveryAction: "route Promotion execution through the coordinator bound to the authenticated Realm",
        receipt: `sessionRealm=${input.session.realmId}; stateRealm=${this.state.realmId}; promotionExecution=not-accepted`,
      });
    }
    const executionIdempotencyKey = requiredString(input.executionIdempotencyKey, "executionIdempotencyKey");
    const idempotencyKey = `promotion.execute:${executionIdempotencyKey}`;
    const command: AuthorityCommand = {
      protocol: AUTHORITY_COMMAND_PROTOCOL,
      command: "promotion.execute",
      idempotencyKey,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      payload: { promotionId: input.promotionId, executionIdempotencyKey },
    };
    const existing = this.state.idempotency[idempotencyKey];
    const requestFingerprint = fingerprint(command);
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AuthorityPlaneError({
          code: "idempotency_conflict",
          message: `Execution idempotency key ${executionIdempotencyKey} was already used for a different Promotion handoff.`,
          recoveryAction: "reuse the original execution payload or choose a new execution idempotency key",
          receipt: `executionIdempotencyKey=${executionIdempotencyKey}; conflict=true; stateVersion=${this.state.version}; overwritten=false`,
        });
      }
      return clone(existing.result);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== this.state.version) {
      throw new AuthorityPlaneError({
        code: "stale_state",
        message: `Authority state changed before Promotion ${input.promotionId} execution was accepted.`,
        recoveryAction: "read the current Authority state and retry with a fresh execution idempotency key",
        receipt: `expectedVersion=${input.expectedVersion}; actualVersion=${this.state.version}; promotionExecution=not-accepted`,
      });
    }

    const promotion = this.state.promotions[input.promotionId];
    if (!promotion) {
      throw new AuthorityPlaneError({
        code: "not_found",
        message: `Promotion ${input.promotionId} does not exist.`,
        recoveryAction: "inspect the authoritative Promotion ledger and retry with the recorded Promotion ID",
        receipt: `promotion=${input.promotionId}; execution=not-started; discoverable=false`,
      });
    }
    if (!["blocked", "failed", "degraded"].includes(promotion.state)) {
      if (promotion.state === "healthy" || promotion.state === "rolled-back") {
        const target = this.state.targets[promotion.targetId];
        const release = this.state.releases[promotion.releaseId];
        const result: AuthorityCommandResult = {
          protocol: AUTHORITY_PLANE_PROTOCOL,
          command: "promotion.execute",
          status: "succeeded",
          version: this.state.version,
          value: { promotion, target, release },
          receipt: `promotion=${promotion.id}; execution=already-terminal; state=${promotion.state}; providerInvocation=false; credentialFree=true; canonicalWrite=false`,
        };
        this.state.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
        return clone(result);
      }
      throw new AuthorityPlaneError({
        code: "conflict",
        message: `Promotion ${promotion.id} is ${promotion.state}; it is not ready for a provider handoff.`,
        recoveryAction: "wait for a recoverable Promotion state or request a new Promotion without changing the existing record",
        receipt: `promotion=${promotion.id}; state=${promotion.state}; execution=not-started`,
      });
    }

    let context;
    try {
      context = createPromotionExecutionContext({ snapshot: this.state, promotionId: input.promotionId, executionIdempotencyKey, session: input.session });
    } catch (error) {
      if (error instanceof PromotionExecutionValidationError) {
        throw new AuthorityPlaneError({ code: "conflict", message: error.message, recoveryAction: error.recoveryAction, receipt: `${error.receipt}; promotionExecution=not-accepted` });
      }
      throw error;
    }

    let execution: PromotionExecutionResult;
    try {
      execution = await input.executor.execute(clone(context));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      execution = this.indeterminatePromotionExecution(promotion, input.promotionId, executionIdempotencyKey, context.executionDigest, `provider executor threw: ${message}`, "inspect the provider operation by its immutable execution identity before retrying", `promotion=${promotion.id}; providerResult=thrown; message=${message}`);
    }

    const next = clone(this.state);
    let normalized: PromotionExecutionResult;
    try {
      normalized = normalizePromotionExecutionResult(context, execution);
    } catch (error) {
      if (!(error instanceof PromotionExecutionValidationError)) throw error;
      normalized = this.indeterminatePromotionExecution(promotion, input.promotionId, executionIdempotencyKey, context.executionDigest, `provider result rejected: ${error.message}`, error.recoveryAction, `${error.receipt}; providerResult=untrusted; promotionExecution=indeterminate`);
    }
    const target = next.targets[promotion.targetId];
    if (!target) throw new AuthorityPlaneError({ code: "not_found", message: `Target ${promotion.targetId} disappeared before Promotion execution was recorded.`, recoveryAction: "restore the exact Target record and reconcile the provider operation", receipt: `promotion=${promotion.id}; target=${promotion.targetId}; execution=not-recorded` });
    const updatedTarget = targetAfterPromotion({ target, result: normalized });
    const checkpoint = normalized.promotion.reconciliationCheckpoint ?? {
      idempotencyKey: executionIdempotencyKey,
      attempt: normalized.promotion.attempt,
      stage: normalized.status === "indeterminate" ? "reconcile" : "complete",
      providerOperationIds: [normalized.promotion.providerOperationId, normalized.promotion.rollbackProviderOperationId].filter((value): value is string => Boolean(value)),
      receipt: `promotion=${promotion.id}; execution=${normalized.status}; checkpoint=authority-recorded; credentialFree=true`,
    };
    next.promotions[promotion.id] = { ...normalized.promotion, reconciliationCheckpoint: checkpoint };
    next.targets[target.id] = { ...updatedTarget, currentReleaseId: normalized.target.currentReleaseId, releaseHistory: [...normalized.target.releaseHistory], lastPromotionId: promotion.id };
    next.version += 1;
    const result: AuthorityCommandResult = {
      protocol: AUTHORITY_PLANE_PROTOCOL,
      command: "promotion.execute",
      status: normalized.status,
      version: next.version,
      value: { promotion: next.promotions[promotion.id], target: next.targets[target.id], release: next.releases[promotion.releaseId], checkpoint },
      receipt: `${normalized.receipt}; executionIdempotencyKey=${executionIdempotencyKey}; authorityStateVersion=${next.version}`,
      ...(normalized.recoveryAction ? { recoveryAction: normalized.recoveryAction } : {}),
    };
    next.idempotency[idempotencyKey] = { fingerprint: requestFingerprint, result: clone(result) };
    next.audit.push({ id: opaqueId("authority-audit"), command: "promotion.execute", idempotencyKey, actor: actorRef(input.session), outcome: normalized.status, stateVersion: next.version, occurredAt: now(), receipt: result.receipt });
    this.state = next;
    return clone(result);
  }

  private indeterminatePromotionExecution(promotion: PromotionRecord, promotionId: string, executionIdempotencyKey: string, executionDigest: string, message: string, recoveryAction: string, receipt: string): PromotionExecutionResult {
    const updated: PromotionRecord = {
      ...clone(promotion),
      state: "degraded",
      attempt: promotion.attempt + 1,
      updatedAt: now(),
      executionIdempotencyKey,
      recoveryAction,
      receipt: `promotion=degraded; ${message}; ${receipt}`,
      reconciliationCheckpoint: { idempotencyKey: executionIdempotencyKey, attempt: promotion.attempt + 1, stage: "reconcile", providerOperationIds: [], receipt: `promotion=${promotionId}; providerResult=indeterminate; credentialFree=true` },
    };
    const target = this.state.targets[promotion.targetId];
    return {
      protocol: PROMOTION_EXECUTION_PROTOCOL,
      status: "indeterminate",
      adapterId: target?.adapterId ?? "unknown",
      executionDigest,
      promotion: updated,
      target: { id: promotion.targetId, projectId: promotion.projectId, state: "degraded", currentReleaseId: target?.currentReleaseId ?? null, releaseHistory: [...(target?.releaseHistory ?? [])] },
      ...(updated.reconciliationCheckpoint ? { checkpoint: updated.reconciliationCheckpoint } : {}),
      receipt: updated.receipt,
      recoveryAction,
    };
  }

  private apply(next: AuthorityPlaneSnapshot, command: AuthorityCommand, session: AuthoritySession): AuthorityCommandResult {
    const payload = command.payload;
    const actor = actorRef(session);
    const success = (value: Record<string, unknown>, receipt: string): AuthorityCommandResult => ({ protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: "succeeded", version: next.version, value, receipt });
    const blocked = (value: Record<string, unknown>, receipt: string, recoveryAction: string): AuthorityCommandResult => ({ protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: "blocked", version: next.version, value, receipt, recoveryAction });
    const indeterminate = (value: Record<string, unknown>, receipt: string, recoveryAction: string): AuthorityCommandResult => ({ protocol: AUTHORITY_PLANE_PROTOCOL, command: command.command, status: "indeterminate", version: next.version, value, receipt, recoveryAction });
    const projectId = optionalString(payload.projectId);
    const project = projectId ? next.projects[projectId] : undefined;

    switch (command.command) {
      case "project.create": {
        const id = optionalString(payload.projectId) ?? opaqueId("project");
        if (next.projects[id]) throw new AuthorityPlaneError({ code: "conflict", message: `Project ${id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Project identity", receipt: `project=${id}; exists=true; transition=not-applied` });
        const sourcesValue = payload.sourceSpaces;
        if (!Array.isArray(sourcesValue) || sourcesValue.length === 0) throw new AuthorityPlaneError({ code: "invalid_request", message: "sourceSpaces must contain at least one declared Source Space.", recoveryAction: "declare each Source Space with an immutable snapshot identifier", receipt: "sourceSpaces=non-empty-required; transition=not-applied" });
        const sourceSpaces: SourceSpace[] = sourcesValue.map((entry, index) => {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new AuthorityPlaneError({ code: "invalid_request", message: `sourceSpaces[${index}] must be an object.`, recoveryAction: "declare Source Space objects with id, name, classification, and snapshotId", receipt: `sourceSpaces[${index}]=object-required; transition=not-applied` });
          const source = entry as Record<string, unknown>;
          const sourceId = requiredString(source.id, `sourceSpaces[${index}].id`);
          const classification = requiredString(source.classification, `sourceSpaces[${index}].classification`) as SourceSpace["classification"];
          if (!["public", "internal", "restricted", "result-only"].includes(classification)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Source Space ${sourceId} has an unsupported classification.`, recoveryAction: "choose public, internal, restricted, or result-only", receipt: `sourceSpace=${sourceId}; classification=${classification}; transition=not-applied` });
          const sourceSpace: SourceSpace = { protocol: CONTRACT_VERSIONS.sourceSpace, id: sourceId, name: requiredString(source.name, `sourceSpaces[${index}].name`), classification };
          if (next.sourceSpaces[sourceId]) throw new AuthorityPlaneError({ code: "conflict", message: `Source Space ${sourceId} already exists.`, recoveryAction: "use a new Source Space identity", receipt: `sourceSpace=${sourceId}; exists=true; transition=not-applied` });
          next.sourceSpaces[sourceId] = sourceSpace;
          return sourceSpace;
        });
        const createdProject = createProject({ id, name: requiredString(payload.name, "name"), referenceType: optionalString(payload.referenceType) ?? "git", sourceSpaceIds: sourceSpaces.map((source) => source.id) });
        const sourceSpaceSnapshots = Object.fromEntries(sourcesValue.map((entry) => { const source = entry as Record<string, unknown>; return [requiredString(source.id, "sourceSpace.id"), requiredString(source.snapshotId, "sourceSpace.snapshotId")]; }));
        const requestedProjectRevisionId = optionalString(payload.projectRevisionId);
        const initialRevision = createProjectRevision({ ...(requestedProjectRevisionId ? { id: requestedProjectRevisionId } : {}), projectId: id, sourceSpaceSnapshots });
        next.projects[id] = createdProject;
        next.projectRevisions[initialRevision.id] = initialRevision;
        next.canonicalByProject[id] = initialRevision.id;
        return success({ project: createdProject, canonicalRevision: initialRevision, sourceSpaces }, `project=${id}; canonicalRevision=${initialRevision.id}; sourceTransfer=not-performed; authority=coordinator`);
      }
      case "workspace.create": {
        const currentProject = project ?? (() => { throw new AuthorityPlaneError({ code: "not_found", message: `Project ${requiredString(payload.projectId, "projectId")} does not exist.`, recoveryAction: "create or import the Project before creating a Workspace", receipt: `project=${payload.projectId ?? "missing"}; workspace=not-created` }); })();
        const revisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const revision = next.projectRevisions[revisionId];
        if (!revision || revision.projectId !== currentProject.id) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${revisionId} is not available for Project ${currentProject.id}.`, recoveryAction: "read the current canonical Project Revision and retry", receipt: `project=${currentProject.id}; revision=${revisionId}; workspace=not-created` });
        const sourceIds = stringArray(payload.sourceSpaceIds ?? currentProject.sourceSpaceIds, "sourceSpaceIds");
        const sourceSpaces = sourceIds.map((id) => next.sourceSpaces[id]).filter((value): value is SourceSpace => value !== undefined);
        const requestedClassification = optionalString(payload.classification) as ProjectView["classification"] | undefined;
        const view = deriveProjectView({ project: currentProject, revision, sourceSpaces, allowedSourceSpaceIds: sourceIds, projectionId: optionalString(payload.projectionId) ?? opaqueId("projection"), ...(requestedClassification ? { classification: requestedClassification } : {}) });
        const mountsValue = payload.mounts;
        const mounts: WorkspaceMount[] = mountsValue === undefined
          ? sourceIds.map((sourceSpaceId) => ({ sourceSpaceId, snapshotId: revision.sourceSpaceSnapshots[sourceSpaceId]!, mountPath: sourceSpaceId.replaceAll(":", "-") }))
          : stringArray(mountsValue, "mounts").map((mountPath, index) => ({ sourceSpaceId: sourceIds[index]!, snapshotId: revision.sourceSpaceSnapshots[sourceIds[index]!]!, mountPath }));
        const requestedWorkspaceChangeId = optionalString(payload.changeId);
        const workspace: Workspace = { protocol: CONTRACT_VERSIONS.workspace, id: optionalString(payload.workspaceId) ?? opaqueId("workspace"), projectId: currentProject.id, projectRevisionId: revision.id, projectViewId: view.id, mounts, state: "active", ...(requestedWorkspaceChangeId ? { changeId: requestedWorkspaceChangeId } : {}), actorId: session.actorId };
        if (next.workspaces[workspace.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${workspace.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Workspace identity", receipt: `workspace=${workspace.id}; exists=true; transition=not-applied` });
        next.projectViews[view.id] = view;
        next.workspaces[workspace.id] = workspace;
        return success({ workspace, view }, `workspace=${workspace.id}; base=${revision.id}; actor=${session.actorId}; sourceTransfer=not-performed`);
      }
      case "change.create": {
        const currentProject = project ?? (() => { throw new AuthorityPlaneError({ code: "not_found", message: `Project ${requiredString(payload.projectId, "projectId")} does not exist.`, recoveryAction: "create the Project before creating a Change", receipt: `project=${payload.projectId ?? "missing"}; change=not-created` }); })();
        const baseRevisionId = optionalString(payload.baseProjectRevisionId) ?? next.canonicalByProject[currentProject.id];
        if (!baseRevisionId || !next.projectRevisions[baseRevisionId]) throw new AuthorityPlaneError({ code: "not_found", message: "The Change base Project Revision is unavailable.", recoveryAction: "read the canonical Project Revision and retry the Change creation", receipt: `project=${currentProject.id}; baseRevision=missing; change=not-created` });
        const workspaceId = optionalString(payload.workspaceId);
        if (workspaceId && (!next.workspaces[workspaceId] || next.workspaces[workspaceId].projectId !== currentProject.id)) throw new AuthorityPlaneError({ code: "not_found", message: `Workspace ${workspaceId} is not available for Project ${currentProject.id}.`, recoveryAction: "create a Workspace for this Project before creating the Change", receipt: `workspace=${workspaceId}; change=not-created` });
        const change: Change = { protocol: CONTRACT_VERSIONS.change, id: optionalString(payload.changeId) ?? opaqueId("change"), projectId: currentProject.id, intentId: requiredString(payload.intentId, "intentId"), baseProjectRevisionId: baseRevisionId, status: "active", latestRevisionId: null, ...(workspaceId ? { workspaceId } : {}), author: actor };
        if (next.changes[change.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Change ${change.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Change identity", receipt: `change=${change.id}; exists=true; transition=not-applied` });
        next.changes[change.id] = change;
        if (workspaceId) next.workspaces[workspaceId] = { ...next.workspaces[workspaceId]!, changeId: change.id };
        return success({ change }, `change=${change.id}; base=${baseRevisionId}; canonicalWrite=false`);
      }
      case "revision.publish": {
        const changeId = requiredString(payload.changeId, "changeId");
        const change = next.changes[changeId];
        if (!change) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} does not exist.`, recoveryAction: "create the Change before publishing a Revision", receipt: `change=${changeId}; revision=not-created` });
        const requestedProjectId = optionalString(payload.projectId);
        if (requestedProjectId && requestedProjectId !== change.projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${changeId} is not available for Project ${requestedProjectId}.`, recoveryAction: "verify the Project and Change identifiers without probing hidden resources", receipt: `project=${requestedProjectId}; change=not-available; discoverable=false` });
        if (change.status === "landed" || change.status === "abandoned") throw new AuthorityPlaneError({ code: "conflict", message: `Change ${changeId} is ${change.status} and cannot publish another Revision.`, recoveryAction: "create a new Change from the current canonical Project Revision", receipt: `change=${changeId}; status=${change.status}; revision=not-created` });
        const workspaceId = optionalString(payload.workspaceId) ?? change.workspaceId;
        const workspace = workspaceId ? next.workspaces[workspaceId] : undefined;
        if (workspaceId && (!workspace || workspace.changeId !== changeId || workspace.projectId !== change.projectId)) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${workspaceId} is not assigned to Change ${changeId}.`, recoveryAction: "publish from the assigned Change Workspace in the same Project", receipt: `change=${changeId}; workspace=${workspaceId}; revision=not-created` });
        const projectViewId = requiredString(payload.projectViewId ?? workspace?.projectViewId, "projectViewId");
        if (workspace && workspace.projectViewId !== projectViewId) throw new AuthorityPlaneError({ code: "conflict", message: `Project View ${projectViewId} is not the View mounted by Workspace ${workspace.id}.`, recoveryAction: "publish with the Project View bound to the assigned Workspace", receipt: `workspace=${workspace.id}; projectView=${projectViewId}; revision=not-created` });
        const sourceSnapshots = record<string>(payload.sourceSpaceSnapshots ?? next.projectRevisions[change.baseProjectRevisionId]?.sourceSpaceSnapshots, "sourceSpaceSnapshots");
        const project = next.projects[change.projectId];
        if (!project) throw new AuthorityPlaneError({ code: "indeterminate", message: `Change ${changeId} refers to a Project that is not readable.`, recoveryAction: "reconcile the Authority snapshot before publishing a Revision", receipt: `change=${changeId}; project=${change.projectId}; revision=not-created` });
        const unknownSourceSpaceId = Object.keys(sourceSnapshots).find((sourceSpaceId) => !project.sourceSpaceIds.includes(sourceSpaceId));
        if (unknownSourceSpaceId) throw new AuthorityPlaneError({ code: "conflict", message: `Source Space ${unknownSourceSpaceId} is not part of Project ${project.id}.`, recoveryAction: "publish only snapshots belonging to the Change Project View", receipt: `project=${project.id}; sourceSpace=${unknownSourceSpaceId}; revision=not-created` });
        const sequence = Object.values(next.changeRevisions).filter((revision) => revision.changeId === changeId).length + 1;
        const projectRevisionId = optionalString(payload.projectRevisionId) ?? opaqueId("candidate-revision");
        const revisionKind = optionalString(payload.kind) as ChangeRevision["kind"] | undefined;
        const revision: ChangeRevision = { protocol: CONTRACT_VERSIONS.change, id: optionalString(payload.revisionId) ?? opaqueId("change-revision"), changeId, projectRevisionId, projectViewId, sequence, parentRevisionId: change.latestRevisionId ?? undefined, declaredEffects: stringArray(payload.declaredEffects ?? [], "declaredEffects", true), baseProjectRevisionId: change.baseProjectRevisionId, ...(workspaceId ? { workspaceId } : {}), sourceSpaceSnapshots: { ...sourceSnapshots }, affectedSourceSpaceIds: Object.keys(sourceSnapshots), author: actor, ...(revisionKind ? { kind: revisionKind } : {}) };
        if (next.changeRevisions[revision.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${revision.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Revision identity", receipt: `revision=${revision.id}; exists=true; transition=not-applied` });
        next.changeRevisions[revision.id] = revision;
        next.changes[changeId] = { ...change, latestRevisionId: revision.id, status: "submitted" };
        return success({ revision, change: next.changes[changeId] }, `change=${changeId}; revision=${revision.id}; sequence=${sequence}; canonicalWrite=false`);
      }
      case "run.record": {
        const requestedRunProjectId = optionalString(payload.projectId);
        const runProjectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const runProjectRevision = next.projectRevisions[runProjectRevisionId];
        const runChangeRevisionId = optionalString(payload.changeRevisionId);
        const runChangeRevision = runChangeRevisionId ? next.changeRevisions[runChangeRevisionId] : undefined;
        const runChangeProjectId = runChangeRevision ? next.changes[runChangeRevision.changeId]?.projectId : undefined;
        const runWorkspaceId = optionalString(payload.workspaceId);
        const runWorkspace = runWorkspaceId ? next.workspaces[runWorkspaceId] : undefined;
        const runWorkspaceProjectId = runWorkspace?.projectId;
        const enforceRunBinding = requestedRunProjectId !== undefined || runChangeRevisionId !== undefined || runWorkspaceId !== undefined;
        if (enforceRunBinding && !runProjectRevision && ((!runChangeRevision || runChangeRevision.projectRevisionId !== runProjectRevisionId) && !runWorkspaceProjectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${runProjectRevisionId} is not available.`, recoveryAction: "record the Run against an existing Project Revision or its exact published Change Revision", receipt: `projectRevision=${runProjectRevisionId}; run=not-created; discoverable=false` });
        if (requestedRunProjectId && ((runProjectRevision && runProjectRevision.projectId !== requestedRunProjectId) || (runChangeProjectId && runChangeProjectId !== requestedRunProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${runProjectRevisionId} is not available for Project ${requestedRunProjectId}.`, recoveryAction: "record the Run against the Project Revision belonging to the requested Project", receipt: `project=${requestedRunProjectId}; projectRevision=${runProjectRevisionId}; run=not-created; discoverable=false` });
        const runProjectId = requestedRunProjectId ?? runProjectRevision?.projectId ?? runChangeProjectId ?? runWorkspaceProjectId;
        const runProject = runProjectId ? next.projects[runProjectId] : undefined;
        if (runProjectId && !runProject) throw new AuthorityPlaneError({ code: "indeterminate", message: `Run Project ${runProjectId} is not readable.`, recoveryAction: "reconcile the Authority snapshot before recording the Run", receipt: `project=${runProjectId}; run=not-created` });
        const runProjectViewId = requiredString(payload.projectViewId, "projectViewId");
        const runProjectView = next.projectViews[runProjectViewId];
        if (runProjectId && (!runProjectView || runProjectView.projectId !== runProjectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Project View ${runProjectViewId} is not available for Project ${runProjectId}.`, recoveryAction: "record the Run against the Project View mounted by the Workspace", receipt: `project=${runProjectId}; projectView=${runProjectViewId}; run=not-created; discoverable=false` });
        if (runWorkspaceId && (!runWorkspace || (runProjectId && runWorkspace.projectId !== runProjectId) || runWorkspace.projectViewId !== runProjectViewId)) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${runWorkspaceId} is not bound to Project ${runProjectId ?? "the Run"} and Project View ${runProjectViewId}.`, recoveryAction: "record the Run from the assigned Workspace and its mounted Project View", receipt: `project=${runProjectId ?? "not-supplied"}; workspace=${runWorkspaceId}; projectView=${runProjectViewId}; run=not-created` });
        if (runChangeRevisionId && (!runChangeRevision || (runProjectId && runChangeProjectId !== runProjectId) || runChangeRevision.projectViewId !== runProjectViewId || runChangeRevision.projectRevisionId !== runProjectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${runChangeRevisionId} is not bound to the Run Project, View, and Revision.`, recoveryAction: "record the Run against the exact Change Revision and Project View that produced its result", receipt: `project=${runProjectId ?? "not-supplied"}; changeRevision=${runChangeRevisionId}; projectRevision=${runProjectRevisionId}; projectView=${runProjectViewId}; run=not-created` });
        if (runWorkspace && runChangeRevision && runChangeRevision.workspaceId !== runWorkspace.id) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${runChangeRevision.id} is not bound to Workspace ${runWorkspace.id}.`, recoveryAction: "record the Run against the Change Workspace that produced the Revision", receipt: `workspace=${runWorkspace.id}; changeRevision=${runChangeRevision.id}; run=not-created` });
        const run: Run = { protocol: CONTRACT_VERSIONS.run, id: optionalString(payload.runId) ?? opaqueId("run"), actionId: requiredString(payload.actionId, "actionId"), projectRevisionId: runProjectRevisionId, projectViewId: runProjectViewId, runnerId: requiredString(payload.runnerId, "runnerId"), status: (optionalString(payload.status) ?? "succeeded") as Run["status"], outputDigest: optionalString(payload.outputDigest), ...(runChangeRevisionId ? { changeRevisionId: runChangeRevisionId } : {}), ...(runWorkspaceId ? { workspaceId: runWorkspaceId } : {}), ...(Array.isArray(payload.inputDigests) ? { inputDigests: stringArray(payload.inputDigests, "inputDigests", true) } : {}), ...(Array.isArray(payload.outputDigests) ? { outputDigests: stringArray(payload.outputDigests, "outputDigests", true) } : {}), actor };
        if (!["queued", "running", "succeeded", "failed", "indeterminate"].includes(run.status)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Run status ${run.status} is unsupported.`, recoveryAction: "record queued, running, succeeded, failed, or indeterminate", receipt: `run=${run.id}; status=${run.status}; transition=not-applied` });
        if (next.runs[run.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Run ${run.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Run identity", receipt: `run=${run.id}; exists=true; transition=not-applied` });
        next.runs[run.id] = run;
        const status = run.status === "indeterminate" ? "indeterminate" : "succeeded";
        return status === "indeterminate" ? indeterminate({ run }, `run=${run.id}; status=indeterminate; evidence=not-yet-valid`, "reconcile the Runner attempt and record a determinate Run before creating Evidence") : success({ run }, `run=${run.id}; status=${run.status}; runner=${run.runnerId}`);
      }
      case "evidence.record": {
        const runId = requiredString(payload.runId, "runId");
        const run = next.runs[runId];
        if (!run) throw new AuthorityPlaneError({ code: "not_found", message: `Run ${runId} does not exist.`, recoveryAction: "record the Run before attaching Evidence", receipt: `run=${runId}; evidence=not-created` });
        if (run.status !== "succeeded") throw new AuthorityPlaneError({ code: "conflict", message: `Run ${runId} is ${run.status}; Evidence cannot assert success from it.`, recoveryAction: "record a successful determinate Run or preserve the failure as an explicit non-passing result", receipt: `run=${runId}; status=${run.status}; evidence=not-created` });
        const evidenceProjectId = optionalString(payload.projectId);
        const evidenceProjectRevisionId = requiredString(payload.projectRevisionId ?? run.projectRevisionId, "projectRevisionId");
        if (evidenceProjectRevisionId !== run.projectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Project Revision ${evidenceProjectRevisionId} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Project Revision used by the successful Run", receipt: `run=${run.id}; runProjectRevision=${run.projectRevisionId}; evidenceProjectRevision=${evidenceProjectRevisionId}; evidence=not-created` });
        const evidenceProjectRevision = next.projectRevisions[evidenceProjectRevisionId];
        const evidenceChangeRevisionId = optionalString(payload.changeRevisionId ?? run.changeRevisionId);
        const evidenceChangeRevision = evidenceChangeRevisionId ? next.changeRevisions[evidenceChangeRevisionId] : undefined;
        const evidenceChangeProjectId = evidenceChangeRevision ? next.changes[evidenceChangeRevision.changeId]?.projectId : undefined;
        const evidenceRevisionIsBoundByChange = evidenceChangeRevision?.projectRevisionId === evidenceProjectRevisionId;
        const enforceEvidenceBinding = evidenceProjectId !== undefined || evidenceChangeRevisionId !== undefined || run.workspaceId !== undefined;
        if (enforceEvidenceBinding && !evidenceProjectRevision && (!evidenceRevisionIsBoundByChange || (evidenceProjectId !== undefined && evidenceChangeProjectId !== evidenceProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Evidence Project Revision ${evidenceProjectRevisionId} is not available for the requested Project.`, recoveryAction: "record Evidence against an existing Project Revision or its exact published Change Revision", receipt: `project=${evidenceProjectId ?? evidenceProjectRevisionId}; projectRevision=${evidenceProjectRevisionId}; evidence=not-created; discoverable=false` });
        if (evidenceProjectId && ((evidenceProjectRevision && evidenceProjectRevision.projectId !== evidenceProjectId) || (evidenceChangeProjectId && evidenceChangeProjectId !== evidenceProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Evidence Project Revision ${evidenceProjectRevisionId} is not available for the requested Project.`, recoveryAction: "record Evidence against a Project Revision belonging to the requested Project", receipt: `project=${evidenceProjectId}; projectRevision=${evidenceProjectRevisionId}; evidence=not-created; discoverable=false` });
        const resolvedEvidenceProjectId = evidenceProjectId ?? evidenceProjectRevision?.projectId ?? evidenceChangeProjectId;
        const evidenceProjectViewId = requiredString(payload.projectViewId ?? run.projectViewId, "projectViewId");
        if (evidenceProjectViewId !== run.projectViewId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Project View ${evidenceProjectViewId} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Project View used by the successful Run", receipt: `run=${run.id}; runProjectView=${run.projectViewId}; evidenceProjectView=${evidenceProjectViewId}; evidence=not-created` });
        const evidenceProjectView = next.projectViews[evidenceProjectViewId];
        if (resolvedEvidenceProjectId && (!evidenceProjectView || evidenceProjectView.projectId !== resolvedEvidenceProjectId)) throw new AuthorityPlaneError({ code: "not_found", message: `Project View ${evidenceProjectViewId} is not available for Project ${resolvedEvidenceProjectId}.`, recoveryAction: "record Evidence against the Project View mounted by the Run Workspace", receipt: `project=${resolvedEvidenceProjectId}; projectView=${evidenceProjectViewId}; evidence=not-created; discoverable=false` });
        if (run.changeRevisionId && evidenceChangeRevisionId !== run.changeRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Change Revision ${evidenceChangeRevisionId ?? "missing"} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Change Revision used by the successful Run", receipt: `run=${run.id}; runChangeRevision=${run.changeRevisionId}; evidenceChangeRevision=${evidenceChangeRevisionId ?? "missing"}; evidence=not-created` });
        if (evidenceChangeRevisionId && (!evidenceChangeRevision || (resolvedEvidenceProjectId && evidenceChangeProjectId !== resolvedEvidenceProjectId) || evidenceChangeRevision.projectViewId !== evidenceProjectViewId || evidenceChangeRevision.projectRevisionId !== evidenceProjectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Change Revision ${evidenceChangeRevisionId} is not bound to the Run Project, View, and Revision.`, recoveryAction: "record Evidence against the exact Change Revision that produced the Run", receipt: `project=${resolvedEvidenceProjectId ?? "not-supplied"}; changeRevision=${evidenceChangeRevisionId}; evidence=not-created` });
        const evidenceTargetId = optionalString(payload.targetId);
        const evidenceWorkspaceId = optionalString(payload.workspaceId ?? run.workspaceId);
        if (run.workspaceId && evidenceWorkspaceId !== run.workspaceId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Workspace ${evidenceWorkspaceId ?? "missing"} does not match Run ${run.id}.`, recoveryAction: "record Evidence against the exact Workspace used by the successful Run", receipt: `run=${run.id}; runWorkspace=${run.workspaceId}; evidenceWorkspace=${evidenceWorkspaceId ?? "missing"}; evidence=not-created` });
        const evidenceWorkspace = evidenceWorkspaceId ? next.workspaces[evidenceWorkspaceId] : undefined;
        if (evidenceWorkspaceId && (!evidenceWorkspace || (resolvedEvidenceProjectId && evidenceWorkspace.projectId !== resolvedEvidenceProjectId) || evidenceWorkspace.projectViewId !== evidenceProjectViewId)) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Workspace ${evidenceWorkspaceId} is not bound to the Run Project and View.`, recoveryAction: "record Evidence from the Run Workspace and its mounted Project View", receipt: `project=${resolvedEvidenceProjectId ?? "not-supplied"}; workspace=${evidenceWorkspaceId}; evidence=not-created` });
        const disclosure = payload.disclosure as Record<string, unknown> | undefined;
        const evidenceActionId = requiredString(payload.actionId, "actionId");
        if (evidenceActionId !== run.actionId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Action ${evidenceActionId} does not match Run ${run.id}.`, recoveryAction: "record Evidence for the Action that produced the successful Run", receipt: `run=${run.id}; runAction=${run.actionId}; evidenceAction=${evidenceActionId}; evidence=not-created` });
        const evidenceRunnerId = requiredString(payload.runnerId ?? run.runnerId, "runnerId");
        if (evidenceRunnerId !== run.runnerId) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence Runner ${evidenceRunnerId} does not match Run ${run.id}.`, recoveryAction: "record Evidence from the Runner that produced the successful Run", receipt: `run=${run.id}; runRunner=${run.runnerId}; evidenceRunner=${evidenceRunnerId}; evidence=not-created` });
        const evidenceOutputDigest = requiredString(payload.outputDigest, "outputDigest");
        if (run.outputDigest && run.outputDigest !== evidenceOutputDigest) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence output digest does not match Run ${run.id}.`, recoveryAction: "record Evidence with the exact output digest produced by the successful Run", receipt: `run=${run.id}; outputDigest=match-required; evidence=not-created` });
        const evidence: Evidence = { protocol: CONTRACT_VERSIONS.evidence, version: "v1", id: optionalString(payload.evidenceId) ?? opaqueId("evidence"), key: requiredString(payload.key, "key"), criterion: requiredString(payload.criterion, "criterion"), outcome: (optionalString(payload.outcome) ?? "passed") as Evidence["outcome"], validityKey: requiredString(payload.validityKey, "validityKey"), actionId: evidenceActionId, verifierId: requiredString(payload.verifierId, "verifierId"), toolchainDigest: requiredString(payload.toolchainDigest, "toolchainDigest"), dependencyDigest: requiredString(payload.dependencyDigest, "dependencyDigest"), environmentDigest: requiredString(payload.environmentDigest, "environmentDigest"), inputDigests: stringArray(payload.inputDigests, "inputDigests", true), effectDigests: stringArray(payload.effectDigests, "effectDigests", true), outputDigest: evidenceOutputDigest, createdAt: now(), producer: { kind: "run", id: runId, version: CONTRACT_VERSIONS.run }, projectRevisionId: evidenceProjectRevisionId, projectViewId: evidenceProjectViewId, ...(evidenceChangeRevisionId ? { changeRevisionId: evidenceChangeRevisionId } : {}), runId, actor, runnerId: evidenceRunnerId, policyVersion: requiredString(payload.policyVersion, "policyVersion"), authorizationEpoch: String(payload.authorizationEpoch ?? session.authorizationEpoch), capabilityGrantId: requiredString(payload.capabilityGrantId, "capabilityGrantId"), disclosure: { projectionId: requiredString(disclosure?.projectionId, "disclosure.projectionId"), classification: requiredString(disclosure?.classification, "disclosure.classification") as DisclosureClassification }, receipt: requiredString(payload.receipt, "receipt"), invalidators: stringArray(payload.invalidators, "invalidators", true), owner: requiredString(payload.owner, "owner"), ...(evidenceTargetId ? { targetId: evidenceTargetId } : {}), ...(evidenceWorkspaceId ? { workspaceId: evidenceWorkspaceId } : {}) };
        if (!["passed", "failed", "stale", "indeterminate"].includes(evidence.outcome)) throw new AuthorityPlaneError({ code: "invalid_request", message: `Evidence outcome ${evidence.outcome} is unsupported.`, recoveryAction: "record passed, failed, stale, or indeterminate Evidence", receipt: `evidence=${evidence.id}; outcome=${evidence.outcome}; transition=not-applied` });
        if (next.evidence[evidence.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Evidence ${evidence.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Evidence identity", receipt: `evidence=${evidence.id}; exists=true; transition=not-applied` });
        next.evidence[evidence.id] = evidence;
        return success({ evidence }, `evidence=${evidence.id}; outcome=${evidence.outcome}; run=${runId}`);
      }
      case "artifact.record": {
        const requestedArtifactProjectId = optionalString(payload.projectId);
        const artifactProjectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const artifactProjectRevision = next.projectRevisions[artifactProjectRevisionId];
        const artifactChangeRevisionId = optionalString(payload.changeRevisionId);
        const artifactChangeRevision = artifactChangeRevisionId ? next.changeRevisions[artifactChangeRevisionId] : undefined;
        const artifactChangeProjectId = artifactChangeRevision ? next.changes[artifactChangeRevision.changeId]?.projectId : undefined;
        const artifactRunId = optionalString(payload.runId);
        const artifactRun = artifactRunId ? next.runs[artifactRunId] : undefined;
        const artifactActionId = optionalString(payload.actionId);
        const artifactWorkspaceId = optionalString(payload.workspaceId);
        const artifactWorkspace = artifactWorkspaceId ? next.workspaces[artifactWorkspaceId] : undefined;
        const enforceArtifactBinding = requestedArtifactProjectId !== undefined || artifactChangeRevisionId !== undefined || artifactRunId !== undefined || artifactWorkspaceId !== undefined;
        if (enforceArtifactBinding && !artifactProjectRevision && !artifactChangeRevision) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${artifactProjectRevisionId} is not available.`, recoveryAction: "record the Artifact against an existing Project Revision or its exact published Change Revision", receipt: `project=${requestedArtifactProjectId ?? artifactProjectRevisionId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created; discoverable=false` });
        if (requestedArtifactProjectId && ((artifactProjectRevision && artifactProjectRevision.projectId !== requestedArtifactProjectId) || (artifactChangeProjectId && artifactChangeProjectId !== requestedArtifactProjectId))) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${artifactProjectRevisionId} is not available for Project ${requestedArtifactProjectId}.`, recoveryAction: "record the Artifact against the Project Revision belonging to the requested Project", receipt: `project=${requestedArtifactProjectId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created; discoverable=false` });
        const artifactProjectId = requestedArtifactProjectId ?? artifactProjectRevision?.projectId ?? artifactChangeProjectId ?? artifactWorkspace?.projectId;
        if (artifactProjectId && !next.projects[artifactProjectId]) throw new AuthorityPlaneError({ code: "indeterminate", message: `Artifact Project ${artifactProjectId} is not readable.`, recoveryAction: "reconcile the Authority snapshot before recording the Artifact", receipt: `project=${artifactProjectId}; artifact=not-created` });
        if (artifactChangeRevisionId && (!artifactChangeRevision || !artifactChangeProjectId || (artifactProjectId && artifactChangeProjectId !== artifactProjectId) || artifactChangeRevision.projectRevisionId !== artifactProjectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: `Change Revision ${artifactChangeRevisionId} is not bound to the Artifact Project and Project Revision.`, recoveryAction: "record the Artifact from the exact Change Revision that produced it", receipt: `project=${artifactProjectId ?? "not-supplied"}; changeRevision=${artifactChangeRevisionId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created` });
        if (artifactRunId && (!artifactRun || (artifactProjectId && (artifactRun.projectRevisionId !== artifactProjectRevisionId || (artifactChangeProjectId && next.changes[artifactChangeRevision!.changeId]?.projectId !== artifactProjectId))) || (artifactChangeRevisionId && artifactRun.changeRevisionId !== artifactChangeRevisionId))) throw new AuthorityPlaneError({ code: "conflict", message: `Run ${artifactRunId} is not bound to the Artifact Project, Project Revision, or Change Revision.`, recoveryAction: "record the Artifact from the exact Run that produced it", receipt: `run=${artifactRunId}; projectRevision=${artifactProjectRevisionId}; artifact=not-created` });
        if (artifactRunId && artifactRun?.status !== "succeeded") throw new AuthorityPlaneError({ code: "conflict", message: `Run ${artifactRunId} is ${artifactRun?.status ?? "missing"}; Artifact cannot assert a successful output from it.`, recoveryAction: "record a successful determinate Run before recording the Artifact", receipt: `run=${artifactRunId}; status=${artifactRun?.status ?? "missing"}; artifact=not-created` });
        if (artifactRunId && artifactActionId && artifactRun?.actionId !== artifactActionId) throw new AuthorityPlaneError({ code: "conflict", message: `Artifact Action ${artifactActionId} does not match Run ${artifactRunId}.`, recoveryAction: "record the Artifact with the Action that produced the Run", receipt: `run=${artifactRunId}; action=match-required; artifact=not-created` });
        if (artifactWorkspaceId && (!artifactWorkspace || (artifactProjectId && artifactWorkspace.projectId !== artifactProjectId) || (artifactChangeRevision && artifactChangeRevision.workspaceId !== artifactWorkspaceId))) throw new AuthorityPlaneError({ code: "conflict", message: `Workspace ${artifactWorkspaceId} is not bound to the Artifact Project or Change Revision.`, recoveryAction: "record the Artifact from the Workspace that produced the output", receipt: `workspace=${artifactWorkspaceId}; artifact=not-created` });
        const artifactOutputPath = optionalString(payload.outputPath);
        const artifactProvenanceDigest = optionalString(payload.provenanceDigest);
        const artifactDisclosure = payload.disclosure as Record<string, unknown> | undefined;
        const artifact: Artifact = { protocol: CONTRACT_VERSIONS.artifact, id: optionalString(payload.artifactId) ?? opaqueId("artifact"), type: requiredString(payload.type, "type"), digest: requiredString(payload.digest, "digest"), projectRevisionId: artifactProjectRevisionId, ...(artifactChangeRevisionId ? { changeRevisionId: artifactChangeRevisionId } : {}), ...(artifactRunId ? { runId: artifactRunId } : {}), ...(artifactActionId ? { actionId: artifactActionId } : {}), ...(artifactOutputPath ? { outputPath: artifactOutputPath } : {}), ...(artifactProvenanceDigest ? { provenanceDigest: artifactProvenanceDigest } : {}), ...(artifactDisclosure ? { disclosure: { projectionId: requiredString(artifactDisclosure.projectionId, "disclosure.projectionId"), classification: requiredString(artifactDisclosure.classification, "disclosure.classification") as DisclosureClassification } } : {}) };
        if (next.artifacts[artifact.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Artifact ${artifact.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Artifact identity", receipt: `artifact=${artifact.id}; exists=true; transition=not-applied` });
        next.artifacts[artifact.id] = artifact;
        return success({ artifact }, `artifact=${artifact.id}; digest=${artifact.digest}; immutable=true`);
      }
      case "landing.apply": {
        const changeRevisionId = requiredString(payload.changeRevisionId, "changeRevisionId");
        const revision = next.changeRevisions[changeRevisionId];
        if (!revision) throw new AuthorityPlaneError({ code: "not_found", message: `Change Revision ${changeRevisionId} does not exist.`, recoveryAction: "publish the Change Revision before Landing", receipt: `changeRevision=${changeRevisionId}; landing=not-created` });
        const change = next.changes[revision.changeId];
        if (!change) throw new AuthorityPlaneError({ code: "not_found", message: `Change ${revision.changeId} does not exist for Change Revision ${changeRevisionId}.`, recoveryAction: "restore the stable Change record before Landing", receipt: `changeRevision=${changeRevisionId}; landing=not-created` });
        const projectId = change.projectId;
        const requestedProjectId = optionalString(payload.projectId);
        if (requestedProjectId && requestedProjectId !== projectId) throw new AuthorityPlaneError({ code: "not_found", message: `Change Revision ${changeRevisionId} is not available for Project ${requestedProjectId}.`, recoveryAction: "verify the Project and Change Revision identifiers without probing hidden resources", receipt: `project=${requestedProjectId}; changeRevision=${changeRevisionId}; landing=not-created; discoverable=false` });
        const requestedChangeId = optionalString(payload.changeId);
        if (requestedChangeId && requestedChangeId !== change.id) throw new AuthorityPlaneError({ code: "not_found", message: `Change Revision ${changeRevisionId} is not available for Change ${requestedChangeId}.`, recoveryAction: "verify the Change and Change Revision identifiers without probing hidden resources", receipt: `change=${requestedChangeId}; changeRevision=${changeRevisionId}; landing=not-created; discoverable=false` });
        const expected = optionalString(payload.expectedCanonicalProjectRevisionId);
        const actual = next.canonicalByProject[projectId];
        if (expected !== undefined && expected !== actual) throw new AuthorityPlaneError({ code: "stale_state", message: `Canonical Project Revision changed before Landing ${changeRevisionId}.`, recoveryAction: "read the current canonical Project Revision, rebase or compose the Change, and retry with a new idempotency key", receipt: `project=${projectId}; expectedCanonical=${expected}; actualCanonical=${actual}; landing=not-created` });
        if (actual !== change.baseProjectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Change ${change.id} was based on ${change.baseProjectRevisionId}, not the current canonical Project Revision ${actual}.`, recoveryAction: "publish a rebase or conflict-resolution Revision before Landing", receipt: `change=${change.id}; base=${change.baseProjectRevisionId}; canonical=${actual}; landing=not-created` });
        if (change.status !== "submitted" || change.latestRevisionId !== revision.id) throw new AuthorityPlaneError({ code: "conflict", message: `Change ${change.id} is not ready to Land at Change Revision ${revision.id}.`, recoveryAction: "publish the latest Revision and submit the Change before Landing", receipt: `change=${change.id}; status=${change.status}; latest=${change.latestRevisionId ?? "none"}; requested=${revision.id}; landing=not-created` });
        const requestedLandedRevisionId = optionalString(payload.projectRevisionId);
        if (requestedLandedRevisionId && next.projectRevisions[requestedLandedRevisionId]) throw new AuthorityPlaneError({ code: "conflict", message: `Project Revision ${requestedLandedRevisionId} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Project Revision identity", receipt: `projectRevision=${requestedLandedRevisionId}; exists=true; landing=not-created` });
        const nextProjectRevision = createProjectRevision({ ...(requestedLandedRevisionId ? { id: requestedLandedRevisionId } : {}), projectId, sourceSpaceSnapshots: revision.sourceSpaceSnapshots ?? next.projectRevisions[change.baseProjectRevisionId]!.sourceSpaceSnapshots, parentProjectRevisionId: actual, landedChangeRevisionId: revision.id });
        const landing: Landing = { protocol: CONTRACT_VERSIONS.landing, id: optionalString(payload.landingId) ?? opaqueId("landing"), projectId, changeId: change.id, changeRevisionId: revision.id, previousProjectRevisionId: actual, projectRevisionId: nextProjectRevision.id, receipt: `landing=accepted; canonicalMutation=coordinator-only; previous=${actual}; next=${nextProjectRevision.id}` };
        next.projectRevisions[nextProjectRevision.id] = nextProjectRevision;
        next.canonicalByProject[projectId] = nextProjectRevision.id;
        next.landings[landing.id] = landing;
        next.changes[change.id] = { ...change, status: "landed" };
        if (change.workspaceId && next.workspaces[change.workspaceId]) next.workspaces[change.workspaceId] = { ...next.workspaces[change.workspaceId]!, state: "closed" };
        return success({ landing, canonicalRevision: nextProjectRevision, change: next.changes[change.id] }, `landing=${landing.id}; canonicalMutation=accepted; sourceWrite=landing-only`);
      }
      case "release.create": {
        const releaseProjectId = requiredString(payload.projectId, "projectId");
        const releaseProject = next.projects[releaseProjectId];
        if (!releaseProject) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${releaseProjectId} does not exist.`, recoveryAction: "verify the Project identifier without probing hidden resources before creating a Release", receipt: `project=${releaseProjectId}; release=not-created; discoverable=false` });
        const projectRevisionId = requiredString(payload.projectRevisionId, "projectRevisionId");
        const projectRevision = next.projectRevisions[projectRevisionId];
        if (!projectRevision || projectRevision.projectId !== releaseProject.id) throw new AuthorityPlaneError({ code: "not_found", message: `Project Revision ${projectRevisionId} is not available for Project ${releaseProjectId}.`, recoveryAction: "verify the Project and Project Revision identifiers without probing hidden resources", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; release=not-created; discoverable=false` });
        if (next.canonicalByProject[releaseProjectId] !== projectRevisionId) throw new AuthorityPlaneError({ code: "conflict", message: `Project Revision ${projectRevisionId} is not the current canonical Revision for Project ${releaseProjectId}.`, recoveryAction: "Land the Change first, then create the Release from the current canonical Project Revision", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; canonical=${next.canonicalByProject[releaseProjectId] ?? "missing"}; release=not-created` });
        const artifactIds = stringArray(payload.artifactIds, "artifactIds");
        const evidenceIds = stringArray(payload.evidenceIds, "evidenceIds");
        const artifacts = artifactIds.map((id) => next.artifacts[id]);
        const evidence = evidenceIds.map((id) => next.evidence[id]);
        if (artifacts.some((item) => !item) || evidence.some((item) => !item)) throw new AuthorityPlaneError({ code: "not_found", message: "Release references an Artifact or Evidence record that is not present.", recoveryAction: "restore the complete immutable lineage before creating the Release", receipt: `projectRevision=${projectRevisionId}; artifacts=${artifactIds.length}; evidence=${evidenceIds.length}; release=not-created` });
        if (artifacts.some((item) => item!.projectRevisionId !== projectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: "Release Artifacts must be bound to the exact canonical Project Revision.", recoveryAction: "record or select Artifacts produced from the exact canonical Project Revision before creating the Release", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; artifacts=exact-project-revision-required; release=not-created` });
        if (evidence.some((item) => item!.projectRevisionId !== projectRevisionId || item!.outcome !== "passed")) throw new AuthorityPlaneError({ code: "conflict", message: "Release Evidence must be passed and bound to the exact Project Revision.", recoveryAction: "rerun the verifier against the exact Project Revision and attach fresh passed Evidence", receipt: `projectRevision=${projectRevisionId}; evidence=exact-passed-required; release=not-created` });
        const releaseName = optionalString(payload.name);
        const releaseChangeRevisionId = optionalString(payload.changeRevisionId);
        const releaseChangeRevision = releaseChangeRevisionId ? next.changeRevisions[releaseChangeRevisionId] : undefined;
        if (releaseChangeRevisionId && (!releaseChangeRevision || next.changes[releaseChangeRevision.changeId]?.projectId !== releaseProjectId || releaseChangeRevision.projectRevisionId !== projectRevisionId)) throw new AuthorityPlaneError({ code: "conflict", message: "Release Change Revision must belong to the exact Project and canonical Project Revision.", recoveryAction: "create the Release from the Change Revision that produced this canonical Project Revision", receipt: `project=${releaseProjectId}; projectRevision=${projectRevisionId}; changeRevision=${releaseChangeRevisionId}; release=not-created` });
        const releaseProvenanceDigest = optionalString(payload.provenanceDigest);
        const release: Release = { protocol: CONTRACT_VERSIONS.release, id: optionalString(payload.releaseId) ?? opaqueId("release"), projectRevisionId, artifactIds, evidenceIds, configurationDigests: stringArray(payload.configurationDigests ?? [], "configurationDigests", true), stateAssumptions: stringArray(payload.stateAssumptions ?? [], "stateAssumptions", true), policyVersion: requiredString(payload.policyVersion, "policyVersion"), status: "ready", ...(releaseName ? { name: releaseName } : {}), ...(releaseChangeRevisionId ? { changeRevisionId: releaseChangeRevisionId } : {}), ...(releaseProvenanceDigest ? { provenanceDigest: releaseProvenanceDigest } : {}), receipt: `release=ready; project=${releaseProjectId}; projectRevision=${projectRevisionId}; artifacts=${artifactIds.length}; evidence=${evidenceIds.length}` };
        if (next.releases[release.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Release ${release.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Release identity", receipt: `release=${release.id}; exists=true; transition=not-applied` });
        next.releases[release.id] = release;
        return success({ release: { ...release, projectId: releaseProjectId } }, `release=${release.id}; project=${releaseProjectId}; status=ready; providerPromotion=not-performed; canonicalWrite=false`);
      }
      case "target.configure": {
        const target: Target = { protocol: CONTRACT_VERSIONS.target, id: optionalString(payload.targetId) ?? opaqueId("target"), projectId: requiredString(payload.projectId, "projectId"), name: requiredString(payload.name, "name"), adapterId: requiredString(payload.adapterId, "adapterId"), acceptedArtifactTypes: stringArray(payload.acceptedArtifactTypes, "acceptedArtifactTypes"), requiredEvidenceKeys: stringArray(payload.requiredEvidenceKeys ?? [], "requiredEvidenceKeys", true), state: "configured" };
        if (!next.projects[target.projectId]) throw new AuthorityPlaneError({ code: "not_found", message: `Project ${target.projectId} does not exist.`, recoveryAction: "create the Project before configuring its Target", receipt: `target=${target.id}; project=${target.projectId}; target=not-configured` });
        if (next.targets[target.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Target ${target.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Target identity", receipt: `target=${target.id}; exists=true; transition=not-applied` });
        next.targets[target.id] = target;
        return success({ target }, `target=${target.id}; state=configured; providerAdapter=${target.adapterId}; qualification=not-performed; canonicalWrite=false`);
      }
      case "promotion.request": {
        const promotionProjectId = requiredString(payload.projectId, "projectId");
        const releaseId = requiredString(payload.releaseId, "releaseId");
        const targetId = requiredString(payload.targetId, "targetId");
        const release = next.releases[releaseId];
        const target = next.targets[targetId];
        if (!next.projects[promotionProjectId] || !release || !target) throw new AuthorityPlaneError({ code: "not_found", message: "Promotion requires an existing Project, Release, and Target.", recoveryAction: "verify the Project, Release, and Target identifiers without probing hidden resources before requesting Promotion", receipt: `promotion=not-created; discoverable=false` });
        const releaseProjectId = next.projectRevisions[release.projectRevisionId]?.projectId;
        if (!releaseProjectId || releaseProjectId !== promotionProjectId || target.projectId !== promotionProjectId) throw new AuthorityPlaneError({ code: "conflict", message: "Promotion Project, Release, and Target bindings do not match.", recoveryAction: "request Promotion against the Target and Release belonging to the same Project", receipt: `project=${promotionProjectId}; promotion=not-created; exact-project-binding-required` });
        const expectedCurrentReleaseId = optionalString(payload.expectedCurrentReleaseId) ?? null;
        const promotion: PromotionRecord = { protocol: CONTRACT_VERSIONS.promotion, id: optionalString(payload.promotionId) ?? opaqueId("promotion"), projectId: promotionProjectId, targetId, releaseId, releaseDigest: optionalString(payload.releaseDigest) ?? `declared:${release.id}`, previousReleaseId: null, expectedCurrentReleaseId, state: "blocked", attempt: 0, kind: "promotion", idempotencyKey: command.idempotencyKey, actor, createdAt: now(), updatedAt: now(), receipt: `promotion=blocked; project=${promotionProjectId}; target=${targetId}; release=${releaseId}; expectedCurrentRelease=${expectedCurrentReleaseId ?? "not-declared"}; providerAdapter=${target.adapterId}; canonicalWrite=false`, recoveryAction: "qualify and bind the Target adapter, then request Promotion again after inspecting the immutable Release lineage" };
        if (next.promotions[promotion.id]) throw new AuthorityPlaneError({ code: "conflict", message: `Promotion ${promotion.id} already exists.`, recoveryAction: "reuse the original idempotency key or choose a new Promotion identity", receipt: `promotion=${promotion.id}; exists=true; transition=not-applied` });
        next.promotions[promotion.id] = promotion;
        return blocked({ promotion, target, release }, promotion.receipt, promotion.recoveryAction!);
      }
      case "promotion.execute": {
        throw new AuthorityPlaneError({
          code: "invalid_request",
          message: "promotion.execute is an internal provider handoff and cannot be submitted as a public Authority command.",
          recoveryAction: "use the coordinator's internal Promotion execution boundary; no provider operation was started",
          receipt: "command=promotion.execute; publicCommand=false; transition=not-applied",
        });
      }
    }
  }
}

export function authorityStateSummary(snapshot: AuthorityPlaneSnapshot): Record<string, unknown> {
  return {
    protocol: AUTHORITY_PLANE_PROTOCOL,
    realmId: snapshot.realmId,
    version: snapshot.version,
    canonicalByProject: { ...snapshot.canonicalByProject },
    counts: {
      projects: Object.keys(snapshot.projects).length,
      workspaces: Object.keys(snapshot.workspaces).length,
      changes: Object.keys(snapshot.changes).length,
      revisions: Object.keys(snapshot.changeRevisions).length,
      runs: Object.keys(snapshot.runs).length,
      evidence: Object.keys(snapshot.evidence).length,
      artifacts: Object.keys(snapshot.artifacts).length,
      landings: Object.keys(snapshot.landings).length,
      releases: Object.keys(snapshot.releases).length,
      targets: Object.keys(snapshot.targets).length,
      promotions: Object.keys(snapshot.promotions).length,
      audit: snapshot.audit.length,
    },
    credentialFree: true,
    canonicalWrite: "landing-only",
    recovery: "snapshot-and-idempotency-record-persisted-by-coordinator",
  };
}
