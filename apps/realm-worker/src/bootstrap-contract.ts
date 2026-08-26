import { AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";

export type BootstrapMutation = "project.create" | "workspace.create" | "change.create";

export type BootstrapPath = {
  readonly mutation?: BootstrapMutation;
  readonly projectId?: string;
  readonly malformed: boolean;
};

function safePathIdentifier(value: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${field}_malformed`);
  }
  if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded === "." || decoded === "..") throw new Error(`${field}_malformed`);
  return decoded;
}

export function bootstrapPath(pathname: string): BootstrapPath {
  const segments = pathname.split("/");
  if (segments[1] !== "api" || segments[2] !== "projects") return { malformed: false };
  if (segments.length === 3) return { mutation: "project.create", malformed: false };
  if (segments.length === 4) return { malformed: false };
  if (segments.length === 5 && (segments[4] === "workspaces" || segments[4] === "changes")) {
    try {
      return { mutation: segments[4] === "workspaces" ? "workspace.create" : "change.create", projectId: safePathIdentifier(segments[3] ?? "", "projectId"), malformed: false };
    } catch {
      return { malformed: true };
    }
  }
  return { malformed: true };
}

function bootstrapRequestError(operation: BootstrapMutation, message: string, recoveryAction: string, receipt: string): Error & { readonly operation: BootstrapMutation; readonly recoveryAction: string; readonly receipt: string } {
  const error = new Error(message) as Error & { readonly operation: BootstrapMutation; readonly recoveryAction: string; readonly receipt: string };
  Object.defineProperties(error, {
    operation: { value: operation, enumerable: false },
    recoveryAction: { value: recoveryAction, enumerable: false },
    receipt: { value: receipt, enumerable: false },
  });
  return error;
}

function assertBootstrapFields(body: Record<string, unknown>, operation: BootstrapMutation, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw bootstrapRequestError(operation, `Field ${unknown} is not accepted by this typed route.`, `remove ${unknown} and send only the documented ${operation} fields; no transition was accepted`, `operation=${operation}; field=${unknown}; transition=not-applied`);
}

function requiredBootstrapString(body: Record<string, unknown>, operation: BootstrapMutation, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) throw bootstrapRequestError(operation, `${field} is required.`, `provide a non-empty ${field}; no transition was accepted`, `operation=${operation}; field=${field}; required=true; transition=not-applied`);
  return value.trim();
}

function optionalBootstrapString(body: Record<string, unknown>, operation: BootstrapMutation, field: string): string | undefined {
  if (body[field] === undefined) return undefined;
  return requiredBootstrapString(body, operation, field);
}

function safeBodyIdentifier(body: Record<string, unknown>, operation: BootstrapMutation, field: string, required = false): string | undefined {
  if (body[field] === undefined) {
    if (required) return requiredBootstrapString(body, operation, field);
    return undefined;
  }
  const value = requiredBootstrapString(body, operation, field);
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") throw bootstrapRequestError(operation, `${field} must be one safe identifier.`, `remove path separators from ${field} and retry; no transition was accepted`, `operation=${operation}; field=${field}; identifier=safe-required; transition=not-applied`);
  return value;
}

function bootstrapStringList(body: Record<string, unknown>, operation: BootstrapMutation, field: string, required = true): string[] | undefined {
  if (body[field] === undefined) {
    if (required) throw bootstrapRequestError(operation, `${field} must be a non-empty array of strings.`, `provide ${field} as a non-empty string array; no transition was accepted`, `operation=${operation}; field=${field}; stringArray=required; transition=not-applied`);
    return undefined;
  }
  const value = body[field];
  if (!Array.isArray(value) || (required && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) throw bootstrapRequestError(operation, `${field} must be an array of non-empty strings.`, `provide ${field} as a valid string array; no transition was accepted`, `operation=${operation}; field=${field}; stringArray=invalid; transition=not-applied`);
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

function bootstrapExpectedVersion(body: Record<string, unknown>, operation: BootstrapMutation): number | undefined {
  if (body.expectedVersion === undefined) return undefined;
  if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw bootstrapRequestError(operation, "expectedVersion must be a non-negative safe integer.", "read the current Authority version and retry with that expectedVersion; no transition was accepted", `operation=${operation}; expectedVersion=non-negative-safe-integer-required; transition=not-applied`);
  return body.expectedVersion;
}

function bootstrapSourceSpaces(body: Record<string, unknown>, operation: BootstrapMutation): Array<Record<string, string>> {
  const value = body.sourceSpaces;
  if (!Array.isArray(value) || value.length === 0) throw bootstrapRequestError(operation, "sourceSpaces must contain at least one Source Space.", "declare each Source Space with id, name, classification, and snapshotId; no transition was accepted", `operation=${operation}; sourceSpaces=non-empty-required; transition=not-applied`);
  const allowed = ["id", "name", "classification", "snapshotId", "repositoryId"] as const;
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw bootstrapRequestError(operation, `sourceSpaces[${index}] must be an object.`, "declare Source Space objects with id, name, classification, and snapshotId; no transition was accepted", `operation=${operation}; sourceSpaces[${index}]=object-required; transition=not-applied`);
    const source = entry as Record<string, unknown>;
    const unknown = Object.keys(source).find((key) => !allowed.includes(key as typeof allowed[number]));
    if (unknown) throw bootstrapRequestError(operation, `sourceSpaces[${index}] contains unsupported field ${unknown}.`, "remove unsupported Source Space fields and retry; no transition was accepted", `operation=${operation}; sourceSpaces[${index}].field=${unknown}; transition=not-applied`);
    const id = typeof source.id === "string" && source.id.trim().length > 0 ? source.id.trim() : undefined;
    const name = typeof source.name === "string" && source.name.trim().length > 0 ? source.name.trim() : undefined;
    const classification = typeof source.classification === "string" ? source.classification.trim() : "";
    const snapshotId = typeof source.snapshotId === "string" && source.snapshotId.trim().length > 0 ? source.snapshotId.trim() : undefined;
    const repositoryId = source.repositoryId === undefined ? undefined : typeof source.repositoryId === "string" && source.repositoryId.trim().length > 0 ? source.repositoryId.trim() : undefined;
    if (!id || !name || !snapshotId || !["public", "internal", "restricted", "result-only"].includes(classification)) throw bootstrapRequestError(operation, `sourceSpaces[${index}] is incomplete or has an unsupported classification.`, "provide id, name, snapshotId, and one of public, internal, restricted, or result-only; no transition was accepted", `operation=${operation}; sourceSpaces[${index}]=invalid; transition=not-applied`);
    return { id, name, classification, snapshotId, ...(repositoryId ? { repositoryId } : {}) };
  });
}

export function bootstrapCommand(path: BootstrapPath, body: Record<string, unknown>, idempotencyKeyValue: string | undefined): { command: BootstrapMutation; idempotencyKey: string; expectedVersion?: number; payload: Record<string, unknown> } {
  const operation = path.mutation;
  if (!operation) throw new Error("bootstrap_mutation_not_found");
  const idempotencyKey = idempotencyKeyValue?.trim();
  if (!idempotencyKey) throw bootstrapRequestError(operation, "The Idempotency-Key header is required.", "send one stable Idempotency-Key for this intent; no transition was accepted", `operation=${operation}; idempotencyKey=required; transition=not-applied`);
  const expectedVersion = bootstrapExpectedVersion(body, operation);
  if (operation === "project.create") {
    assertBootstrapFields(body, operation, ["projectId", "name", "referenceType", "sourceSpaces", "projectRevisionId", "expectedVersion"]);
    const projectId = safeBodyIdentifier(body, operation, "projectId");
    const projectRevisionId = safeBodyIdentifier(body, operation, "projectRevisionId");
    const referenceType = optionalBootstrapString(body, operation, "referenceType");
    return { command: operation, idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload: { ...(projectId ? { projectId } : {}), name: requiredBootstrapString(body, operation, "name"), ...(referenceType ? { referenceType } : {}), sourceSpaces: bootstrapSourceSpaces(body, operation), ...(projectRevisionId ? { projectRevisionId } : {}) } };
  }
  assertBootstrapFields(body, operation, operation === "workspace.create" ? ["workspaceId", "projectRevisionId", "sourceSpaceIds", "mounts", "projectionId", "classification", "expectedVersion"] : ["changeId", "intentId", "baseProjectRevisionId", "workspaceId", "expectedVersion"]);
  const projectId = path.projectId;
  if (!projectId) throw bootstrapRequestError(operation, "The Project path is required.", "use /api/projects/{projectId}/workspaces or /api/projects/{projectId}/changes; no transition was accepted", `operation=${operation}; projectId=required; transition=not-applied`);
  if (operation === "workspace.create") {
    const workspaceId = safeBodyIdentifier(body, operation, "workspaceId");
    const projectRevisionId = safeBodyIdentifier(body, operation, "projectRevisionId", true)!;
    const sourceSpaceIds = bootstrapStringList(body, operation, "sourceSpaceIds");
    const mounts = bootstrapStringList(body, operation, "mounts", false);
    const projectionId = safeBodyIdentifier(body, operation, "projectionId");
    const classification = optionalBootstrapString(body, operation, "classification");
    return { command: operation, idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload: { projectId, ...(workspaceId ? { workspaceId } : {}), projectRevisionId, sourceSpaceIds, ...(mounts ? { mounts } : {}), ...(projectionId ? { projectionId } : {}), ...(classification ? { classification } : {}) } };
  }
  const changeId = safeBodyIdentifier(body, operation, "changeId");
  const intentId = safeBodyIdentifier(body, operation, "intentId", true)!;
  const baseProjectRevisionId = safeBodyIdentifier(body, operation, "baseProjectRevisionId");
  const workspaceId = safeBodyIdentifier(body, operation, "workspaceId");
  return { command: operation, idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload: { projectId, ...(changeId ? { changeId } : {}), intentId, ...(baseProjectRevisionId ? { baseProjectRevisionId } : {}), ...(workspaceId ? { workspaceId } : {}) } };
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`coordinator_${field}_malformed`);
  return value as Record<string, unknown>;
}

function requiredValueString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`coordinator_${field}_malformed`);
  return value;
}

function requiredValueStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`coordinator_${field}_malformed`);
  return [...(value as string[])];
}

function optionalValueString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredValueString(value, field);
}

function safeProject(value: unknown): Record<string, unknown> {
  const project = recordValue(value, "project");
  return { protocol: requiredValueString(project.protocol, "project.protocol"), id: requiredValueString(project.id, "project.id"), name: requiredValueString(project.name, "project.name"), referenceType: requiredValueString(project.referenceType, "project.referenceType"), sourceSpaceIds: requiredValueStringArray(project.sourceSpaceIds, "project.sourceSpaceIds") };
}

function safeCanonicalRevision(value: unknown): Record<string, unknown> {
  const revision = recordValue(value, "canonicalRevision");
  return { protocol: requiredValueString(revision.protocol, "canonicalRevision.protocol"), id: requiredValueString(revision.id, "canonicalRevision.id"), projectId: requiredValueString(revision.projectId, "canonicalRevision.projectId") };
}

function safeSourceSpaces(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("coordinator_sourceSpaces_malformed");
  return value.map((entry) => {
    const source = recordValue(entry, "sourceSpace");
    const repositoryId = optionalValueString(source.repositoryId, "sourceSpace.repositoryId");
    return { protocol: requiredValueString(source.protocol, "sourceSpace.protocol"), id: requiredValueString(source.id, "sourceSpace.id"), name: requiredValueString(source.name, "sourceSpace.name"), classification: requiredValueString(source.classification, "sourceSpace.classification"), ...(repositoryId ? { repositoryId } : {}) };
  });
}

function safeWorkspace(value: unknown): Record<string, unknown> {
  const workspace = recordValue(value, "workspace");
  const changeId = optionalValueString(workspace.changeId, "workspace.changeId");
  return { protocol: requiredValueString(workspace.protocol, "workspace.protocol"), id: requiredValueString(workspace.id, "workspace.id"), projectId: requiredValueString(workspace.projectId, "workspace.projectId"), projectRevisionId: requiredValueString(workspace.projectRevisionId, "workspace.projectRevisionId"), projectViewId: requiredValueString(workspace.projectViewId, "workspace.projectViewId"), state: requiredValueString(workspace.state, "workspace.state"), ...(changeId ? { changeId } : {}) };
}

function safeProjectView(value: unknown): Record<string, unknown> {
  const view = recordValue(value, "view");
  return { protocol: requiredValueString(view.protocol, "view.protocol"), id: requiredValueString(view.id, "view.id"), projectId: requiredValueString(view.projectId, "view.projectId"), projectRevisionId: requiredValueString(view.projectRevisionId, "view.projectRevisionId"), projectionId: requiredValueString(view.projectionId, "view.projectionId"), classification: requiredValueString(view.classification, "view.classification"), visibleSourceSpaceIds: requiredValueStringArray(view.visibleSourceSpaceIds, "view.visibleSourceSpaceIds") };
}

function safeChange(value: unknown): Record<string, unknown> {
  const change = recordValue(value, "change");
  const latestRevisionId = change.latestRevisionId === null ? null : optionalValueString(change.latestRevisionId, "change.latestRevisionId");
  const workspaceId = optionalValueString(change.workspaceId, "change.workspaceId");
  return { protocol: requiredValueString(change.protocol, "change.protocol"), id: requiredValueString(change.id, "change.id"), projectId: requiredValueString(change.projectId, "change.projectId"), intentId: requiredValueString(change.intentId, "change.intentId"), baseProjectRevisionId: requiredValueString(change.baseProjectRevisionId, "change.baseProjectRevisionId"), status: requiredValueString(change.status, "change.status"), latestRevisionId: latestRevisionId ?? null, ...(workspaceId ? { workspaceId } : {}) };
}

export function projectBootstrapValue(result: Record<string, unknown>, command: BootstrapMutation, idempotencyKey: string): Record<string, unknown> {
  const value = recordValue(result.value, "value");
  const base = { protocol: AUTHORITY_PLANE_PROTOCOL, status: result.status, version: result.version, idempotencyKey, credentialFree: true, canonicalWrite: command === "project.create" ? "initialization-only" : false, receipt: `operation=${command}; typedRest=true; credentialFree=true; canonicalWrite=${command === "project.create" ? "initialization-only" : "false"}; authorityResult=projected` };
  if (command === "project.create") return { ...base, project: safeProject(value.project), canonicalRevision: safeCanonicalRevision(value.canonicalRevision), sourceSpaces: safeSourceSpaces(value.sourceSpaces) };
  if (command === "workspace.create") return { ...base, workspace: safeWorkspace(value.workspace), view: safeProjectView(value.view) };
  return { ...base, change: safeChange(value.change) };
}
