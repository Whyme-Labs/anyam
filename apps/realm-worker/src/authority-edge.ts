import { customerRealmWorkerHealth } from "../../../src/cloudflare/realm-worker.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";
import { anyamRealmOwnerSessionId, requestAnyamRealmCoordinator } from "./passkey-owner.ts";
import type { AnyamRealmOAuthEnv } from "./oauth-provider.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("authority request body must be a JSON object");
  return value as Record<string, unknown>;
}

type BootstrapMutation = "project.create" | "workspace.create" | "change.create";

type BootstrapPath = {
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

function bootstrapPath(pathname: string): BootstrapPath {
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
  if (unknown) throw bootstrapRequestError(operation, `Field ${unknown} is not accepted by this typed REST route.`, `remove ${unknown} and send only the documented ${operation} fields; no transition was accepted`, `operation=${operation}; field=${unknown}; transition=not-applied`);
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
  const allowed = ["id", "name", "classification", "snapshotId"] as const;
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw bootstrapRequestError(operation, `sourceSpaces[${index}] must be an object.`, "declare Source Space objects with id, name, classification, and snapshotId; no transition was accepted", `operation=${operation}; sourceSpaces[${index}]=object-required; transition=not-applied`);
    const source = entry as Record<string, unknown>;
    const unknown = Object.keys(source).find((key) => !allowed.includes(key as typeof allowed[number]));
    if (unknown) throw bootstrapRequestError(operation, `sourceSpaces[${index}] contains unsupported field ${unknown}.`, "remove unsupported Source Space fields and retry; no transition was accepted", `operation=${operation}; sourceSpaces[${index}].field=${unknown}; transition=not-applied`);
    const id = typeof source.id === "string" && source.id.trim().length > 0 ? source.id.trim() : undefined;
    const name = typeof source.name === "string" && source.name.trim().length > 0 ? source.name.trim() : undefined;
    const classification = typeof source.classification === "string" ? source.classification.trim() : "";
    const snapshotId = typeof source.snapshotId === "string" && source.snapshotId.trim().length > 0 ? source.snapshotId.trim() : undefined;
    if (!id || !name || !snapshotId || !["public", "internal", "restricted", "result-only"].includes(classification)) throw bootstrapRequestError(operation, `sourceSpaces[${index}] is incomplete or has an unsupported classification.`, "provide id, name, snapshotId, and one of public, internal, restricted, or result-only; no transition was accepted", `operation=${operation}; sourceSpaces[${index}]=invalid; transition=not-applied`);
    return { id, name, classification, snapshotId };
  });
}

function bootstrapCommand(request: Request, path: BootstrapPath, body: Record<string, unknown>): { command: BootstrapMutation; idempotencyKey: string; expectedVersion?: number; payload: Record<string, unknown> } {
  const operation = path.mutation;
  if (!operation) throw new Error("bootstrap_mutation_not_found");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) throw bootstrapRequestError(operation, "The Idempotency-Key header is required.", "send one stable Idempotency-Key for this intent; no transition was accepted", `operation=${operation}; idempotencyKey=required; transition=not-applied`);
  const expectedVersion = bootstrapExpectedVersion(body, operation);
  if (operation === "project.create") {
    assertBootstrapFields(body, operation, ["projectId", "name", "referenceType", "sourceSpaces", "projectRevisionId", "expectedVersion"]);
    const projectId = safeBodyIdentifier(body, operation, "projectId");
    const projectRevisionId = safeBodyIdentifier(body, operation, "projectRevisionId");
    const referenceType = optionalBootstrapString(body, operation, "referenceType");
    return { command: operation, idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload: { ...(projectId ? { projectId } : {}), name: requiredBootstrapString(body, operation, "name"), ...(referenceType ? { referenceType } : {}), sourceSpaces: bootstrapSourceSpaces(body, operation), ...(projectRevisionId ? { projectRevisionId } : {}) } };
  }
  assertBootstrapFields(body, operation, operation === "workspace.create" ? ["workspaceId", "projectRevisionId", "sourceSpaceIds", "mounts", "projectionId", "classification", "changeId", "expectedVersion"] : ["changeId", "intentId", "baseProjectRevisionId", "workspaceId", "expectedVersion"]);
  const projectId = path.projectId;
  if (!projectId) throw bootstrapRequestError(operation, "The Project path is required.", "use /api/projects/{projectId}/workspaces or /api/projects/{projectId}/changes; no transition was accepted", `operation=${operation}; projectId=required; transition=not-applied`);
  if (operation === "workspace.create") {
    const workspaceId = safeBodyIdentifier(body, operation, "workspaceId");
    const projectRevisionId = safeBodyIdentifier(body, operation, "projectRevisionId", true)!;
    const sourceSpaceIds = bootstrapStringList(body, operation, "sourceSpaceIds");
    const mounts = bootstrapStringList(body, operation, "mounts", false);
    const projectionId = safeBodyIdentifier(body, operation, "projectionId");
    const changeId = safeBodyIdentifier(body, operation, "changeId");
    const classification = optionalBootstrapString(body, operation, "classification");
    return { command: operation, idempotencyKey, ...(expectedVersion === undefined ? {} : { expectedVersion }), payload: { projectId, ...(workspaceId ? { workspaceId } : {}), projectRevisionId, sourceSpaceIds, ...(mounts ? { mounts } : {}), ...(projectionId ? { projectionId } : {}), ...(classification ? { classification } : {}), ...(changeId ? { changeId } : {}) } };
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
    return { protocol: requiredValueString(source.protocol, "sourceSpace.protocol"), id: requiredValueString(source.id, "sourceSpace.id"), name: requiredValueString(source.name, "sourceSpace.name"), classification: requiredValueString(source.classification, "sourceSpace.classification") };
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

function projectBootstrapResponse(result: Record<string, unknown>, command: BootstrapMutation, idempotencyKey: string): Response {
  const value = recordValue(result.value, "value");
  const base = { protocol: AUTHORITY_PLANE_PROTOCOL, status: result.status, version: result.version, idempotencyKey, credentialFree: true, canonicalWrite: command === "project.create" ? "initialization-only" : false, receipt: `operation=${command}; typedRest=true; credentialFree=true; canonicalWrite=${command === "project.create" ? "initialization-only" : "false"}; coordinatorReceipt=redacted` };
  if (command === "project.create") return json({ ...base, project: safeProject(value.project), canonicalRevision: safeCanonicalRevision(value.canonicalRevision), sourceSpaces: safeSourceSpaces(value.sourceSpaces) });
  if (command === "workspace.create") return json({ ...base, workspace: safeWorkspace(value.workspace), view: safeProjectView(value.view) });
  return json({ ...base, change: safeChange(value.change) });
}

async function bootstrapMutation(request: Request, env: AnyamRealmOAuthEnv, path: BootstrapPath): Promise<Response> {
  const operation = path.mutation;
  if (!operation) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_bootstrap_path", recoveryAction: "Use POST /api/projects, POST /api/projects/{projectId}/workspaces, or POST /api/projects/{projectId}/changes.", receipt: "typedRest=not-accepted; transition=not-applied" }, 400);
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before creating a Project, Workspace, or Change.", receipt: `operation=${operation}; ownerSession=missing-or-invalid; transition=not-applied; canonicalWrite=false` }, 401);
  if (request.method !== "POST") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: `Use POST for ${operation} and send one Idempotency-Key header.`, receipt: `operation=${operation}; method=post-required; transition=not-applied; canonicalWrite=false` }, 405);
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_request", recoveryAction: `Send a JSON object containing only the documented ${operation} fields.`, receipt: `operation=${operation}; body=object-required; transition=not-applied; canonicalWrite=false` }, 422);
  }
  let command: ReturnType<typeof bootstrapCommand>;
  try {
    command = bootstrapCommand(request, path, body);
  } catch (error) {
    const typed = error as Partial<{ operation: BootstrapMutation; recoveryAction: string; receipt: string }>;
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_request", recoveryAction: typed.recoveryAction ?? `Correct the ${operation} request and retry; no transition was accepted.`, receipt: typed.receipt ?? `operation=${operation}; transition=not-applied; canonicalWrite=false` }, 422);
  }
  try {
    const result = await requestAnyamRealmCoordinator(env, "/authority/command/internal", { protocol: AUTHORITY_COMMAND_PROTOCOL, command: command.command, idempotencyKey: command.idempotencyKey, ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }), payload: command.payload, sessionId });
    return projectBootstrapResponse(result, command.command, command.idempotencyKey);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("invalid_request") ? 400 : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? 409 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : status === 400 ? "invalid_request" : status === 409 ? "conflict" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: status === 404 ? "bootstrap_resource_not_found" : status === 400 ? "invalid_request" : status === 409 ? "bootstrap_conflict" : "authority_coordinator_rejected", recoveryAction: status === 404 ? "Verify the Project, Project Revision, Workspace, and Source Space identifiers without probing hidden resources." : status === 409 ? "Read the current Authority version, reuse the original idempotency payload, or create a fresh intent; no partial transition was accepted." : status === 403 ? "Authenticate the Realm owner again and retry the same typed request." : "Inspect the Durable Object receipt and retry only the same idempotent request when safe.", receipt: `authority=coordinator-rejected; operation=${operation}; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, status);
  }
}

function projectIdFromPath(pathname: string): { projectId?: string; malformed: boolean } {
  const segments = pathname.split("/");
  if (segments.length !== 4 || segments[1] !== "api" || segments[2] !== "projects") return { malformed: false };
  const encodedProjectId = segments[3];
  if (!encodedProjectId) return { malformed: true };
  try {
    const projectId = decodeURIComponent(encodedProjectId);
    if (!projectId || projectId.includes("/") || projectId.includes("\\") || projectId === "." || projectId === "..") return { malformed: true };
    return { projectId, malformed: false };
  } catch {
    return { malformed: true };
  }
}

function changeIdFromPath(pathname: string): { changeId?: string; malformed: boolean } {
  const segments = pathname.split("/");
  if (segments[1] !== "api" || segments[2] !== "changes") return { malformed: false };
  if (segments.length === 3) return { malformed: false };
  if (segments.length !== 4 || !segments[3]) return { malformed: true };
  try {
    const changeId = decodeURIComponent(segments[3]);
    if (!changeId || changeId.includes("/") || changeId.includes("\\") || changeId === "." || changeId === "..") return { malformed: true };
    return { changeId, malformed: false };
  } catch {
    return { malformed: true };
  }
}

function workspaceIdFromPath(pathname: string): { workspaceId?: string; malformed: boolean } {
  const segments = pathname.split("/");
  if (segments[1] !== "api" || segments[2] !== "workspaces") return { malformed: false };
  if (segments.length === 3) return { malformed: false };
  if (segments.length !== 4 || !segments[3]) return { malformed: true };
  try {
    const workspaceId = decodeURIComponent(segments[3]);
    if (!workspaceId || workspaceId.includes("/") || workspaceId.includes("\\") || workspaceId === "." || workspaceId === "..") return { malformed: true };
    return { workspaceId, malformed: false };
  } catch {
    return { malformed: true };
  }
}

function changeFiltersFromUrl(url: URL): { filters?: { projectId?: string; workspaceId?: string }; malformedParameter?: string } {
  const supported = new Set(["projectId", "workspaceId"]);
  for (const key of url.searchParams.keys()) {
    if (!supported.has(key)) return { malformedParameter: key };
  }
  const read = (key: "projectId" | "workspaceId"): string | undefined => {
    const values = url.searchParams.getAll(key);
    if (values.length === 0) return undefined;
    if (values.length !== 1) throw new Error(`${key}_duplicate`);
    const value = values[0];
    if (!value || value.includes("/") || value.includes("\\") || value === "." || value === "..") throw new Error(`${key}_malformed`);
    return value;
  };
  try {
    const projectId = read("projectId");
    const workspaceId = read("workspaceId");
    return { filters: { ...(projectId ? { projectId } : {}), ...(workspaceId ? { workspaceId } : {}) } };
  } catch (error) {
    return { malformedParameter: error instanceof Error ? error.message.replace(/_(duplicate|malformed)$/, "") : "unknown" };
  }
}

function workspaceFiltersFromUrl(url: URL): { projectId?: string; malformed: boolean } {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "projectId")) return { malformed: true };
  const values = url.searchParams.getAll("projectId");
  if (values.length > 1 || (values.length === 1 && (!values[0] || values[0].includes("/") || values[0].includes("\\") || values[0] === "." || values[0] === ".."))) return { malformed: true };
  return { ...(values[0] ? { projectId: values[0] } : {}), malformed: false };
}

async function projectRead(request: Request, env: AnyamRealmOAuthEnv, projectId: string): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before inspecting a Project.", receipt: "ownerSession=missing-or-invalid; projectRead=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/projects/{projectId} for the read-only Project summary.", receipt: `project=${projectId}; method=get-required; canonicalWrite=false` }, 405);
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/project/internal", { sessionId, projectId }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: status === 404 ? "project_not_found" : "authority_coordinator_rejected", recoveryAction: status === 404 ? "Verify the Project identifier without probing undiscoverable resources." : "Inspect the Durable Object receipt and retry the same read only when safe.", receipt: `authority=coordinator-rejected; operation=project.inspect; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, status);
  }
}

async function projectList(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before listing Projects.", receipt: "ownerSession=missing-or-invalid; projectList=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/projects for the read-only Project discovery surface.", receipt: "projectList=read-only; method=get-required; canonicalWrite=false" }, 405);
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/projects/internal", { sessionId }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const errorClass = detail.includes("session.") || detail.includes("session_") ? "session_rejected" : detail.includes("indeterminate") ? "indeterminate" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "authority_coordinator_rejected", recoveryAction: "Inspect the Durable Object receipt and retry the same discovery read only when safe.", receipt: `authority=coordinator-rejected; operation=project.list; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, errorClass === "session_rejected" ? 403 : 503);
  }
}

function changeQueryError(): Response {
  return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_change_query", recoveryAction: "Use only one non-empty projectId and/or workspaceId query parameter, each as one safe identifier.", receipt: "changeRead=not-accepted; parameter=unsupported-or-malformed; canonicalWrite=false" }, 400);
}

function workspaceQueryError(): Response {
  return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_workspace_query", recoveryAction: "Use only one non-empty projectId query parameter as one safe identifier.", receipt: "workspaceRead=not-accepted; parameter=unsupported-or-malformed; canonicalWrite=false" }, 400);
}

async function changeRead(request: Request, env: AnyamRealmOAuthEnv, changeId: string): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before inspecting a Change.", receipt: "ownerSession=missing-or-invalid; changeRead=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/changes/{changeId} for the read-only Change summary.", receipt: `changeRead=read-only; method=get-required; canonicalWrite=false` }, 405);
  const parsed = changeFiltersFromUrl(new URL(request.url));
  if (parsed.malformedParameter) return changeQueryError();
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/changes/internal", { sessionId, changeId, ...parsed.filters }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("invalid_request") ? 400 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : status === 400 ? "invalid_request" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: status === 404 ? "change_not_found" : status === 400 ? "invalid_change_query" : "authority_coordinator_rejected", recoveryAction: status === 404 ? "Verify the Change identifier without probing undiscoverable resources." : status === 400 ? "Correct the Change read parameters and retry; no read was exposed." : "Inspect the Durable Object receipt and retry the same read only when safe.", receipt: `authority=coordinator-rejected; operation=change.inspect; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, status);
  }
}

async function changeList(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before listing Changes.", receipt: "ownerSession=missing-or-invalid; changeList=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/changes for the read-only Change discovery surface.", receipt: "changeList=read-only; method=get-required; canonicalWrite=false" }, 405);
  const parsed = changeFiltersFromUrl(new URL(request.url));
  if (parsed.malformedParameter) return changeQueryError();
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/changes/internal", { sessionId, ...parsed.filters }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const errorClass = detail.includes("session.") || detail.includes("session_") ? "session_rejected" : detail.includes("invalid_request") ? "invalid_request" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: errorClass === "invalid_request" ? "invalid_change_query" : "authority_coordinator_rejected", recoveryAction: errorClass === "invalid_request" ? "Correct the Change discovery filters and retry; no read was exposed." : "Inspect the Durable Object receipt and retry the same discovery read only when safe.", receipt: `authority=coordinator-rejected; operation=change.list; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, errorClass === "session_rejected" ? 403 : errorClass === "invalid_request" ? 400 : 503);
  }
}

async function workspaceRead(request: Request, env: AnyamRealmOAuthEnv, workspaceId: string): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before inspecting a Workspace.", receipt: "ownerSession=missing-or-invalid; workspaceRead=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/workspaces/{workspaceId} for the read-only Workspace summary.", receipt: "workspaceRead=read-only; method=get-required; canonicalWrite=false" }, 405);
  const parsed = workspaceFiltersFromUrl(new URL(request.url));
  if (parsed.malformed) return workspaceQueryError();
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/workspaces/internal", { sessionId, workspaceId, ...(parsed.projectId ? { projectId: parsed.projectId } : {}) }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("invalid_request") ? 400 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : status === 400 ? "invalid_request" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: status === 404 ? "workspace_not_found" : status === 400 ? "invalid_workspace_query" : "authority_coordinator_rejected", recoveryAction: status === 404 ? "Verify the Workspace identifier without probing undiscoverable resources." : status === 400 ? "Correct the Workspace read parameters and retry; no read was exposed." : "Inspect the Durable Object receipt and retry the same read only when safe.", receipt: `authority=coordinator-rejected; operation=workspace.inspect; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, status);
  }
}

async function workspaceList(request: Request, env: AnyamRealmOAuthEnv): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before listing Workspaces.", receipt: "ownerSession=missing-or-invalid; workspaceList=not-accepted; canonicalWrite=false" }, 401);
  if (request.method !== "GET") return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "method_not_allowed", recoveryAction: "Use GET /api/workspaces for the read-only Workspace discovery surface.", receipt: "workspaceList=read-only; method=get-required; canonicalWrite=false" }, 405);
  const parsed = workspaceFiltersFromUrl(new URL(request.url));
  if (parsed.malformed) return workspaceQueryError();
  try {
    return json(await requestAnyamRealmCoordinator(env, "/authority/workspaces/internal", { sessionId, ...(parsed.projectId ? { projectId: parsed.projectId } : {}) }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const errorClass = detail.includes("session.") || detail.includes("session_") ? "session_rejected" : detail.includes("invalid_request") ? "invalid_request" : "coordinator_rejected";
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: errorClass === "invalid_request" ? "invalid_workspace_query" : "authority_coordinator_rejected", recoveryAction: errorClass === "invalid_request" ? "Correct the Workspace discovery filter and retry; no read was exposed." : "Inspect the Durable Object receipt and retry the same discovery read only when safe.", receipt: `authority=coordinator-rejected; operation=workspace.list; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` }, errorClass === "session_rejected" ? 403 : errorClass === "invalid_request" ? 400 : 503);
  }
}

/**
 * Public Authority Plane edge. The host-only owner session is the current
 * authenticated principal boundary; the Durable Object revalidates the
 * kernel session and owner relationship before applying any command.
 */
export async function handleAuthorityRequest(request: Request, env: AnyamRealmOAuthEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const bootstrap = bootstrapPath(url.pathname);
  const projectRoute = projectIdFromPath(url.pathname);
  const changeRoute = changeIdFromPath(url.pathname);
  const workspaceRoute = workspaceIdFromPath(url.pathname);
  const isProjectRoute = url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/");
  const isChangeRoute = url.pathname === "/api/changes" || url.pathname.startsWith("/api/changes/");
  const isWorkspaceRoute = url.pathname === "/api/workspaces" || url.pathname.startsWith("/api/workspaces/");
  if (!url.pathname.startsWith("/api/authority") && !isProjectRoute && !isChangeRoute && !isWorkspaceRoute) return undefined;

  const health = customerRealmWorkerHealth(env);
  if (health.status !== "ready") {
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "customer_realm_configuration_invalid", missingConfiguration: health.missingConfiguration, recoveryAction: health.recoveryAction, receipt: `${health.receipt}; authority=blocked; productReady=false` }, 503);
  }

  if (bootstrap.mutation && (url.pathname !== "/api/projects" || request.method !== "GET")) return bootstrapMutation(request, env, bootstrap);
  if (bootstrap.malformed && url.pathname.startsWith("/api/projects/")) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_bootstrap_path", recoveryAction: "Use one of /api/projects/{projectId}, /api/projects/{projectId}/workspaces, or /api/projects/{projectId}/changes with one safe URL-encoded identifier.", receipt: "typedRest=path-malformed; transition=not-applied; canonicalWrite=false" }, 400);

  if (isProjectRoute) {
    if (projectRoute.malformed) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_project_path", recoveryAction: "Use GET /api/projects/{projectId} with one URL-encoded Project identifier.", receipt: "projectRead=not-accepted; path=malformed; canonicalWrite=false" }, 400);
    if (!projectRoute.projectId) return projectList(request, env);
    return projectRead(request, env, projectRoute.projectId);
  }

  if (isChangeRoute) {
    if (changeRoute.malformed) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_change_path", recoveryAction: "Use GET /api/changes/{changeId} with one URL-encoded Change identifier.", receipt: "changeRead=not-accepted; path=malformed; canonicalWrite=false" }, 400);
    if (changeRoute.changeId) return changeRead(request, env, changeRoute.changeId);
    return changeList(request, env);
  }

  if (isWorkspaceRoute) {
    if (workspaceRoute.malformed) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "invalid_workspace_path", recoveryAction: "Use GET /api/workspaces/{workspaceId} with one URL-encoded Workspace identifier.", receipt: "workspaceRead=not-accepted; path=malformed; canonicalWrite=false" }, 400);
    if (workspaceRoute.workspaceId) return workspaceRead(request, env, workspaceRoute.workspaceId);
    return workspaceList(request, env);
  }

  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "owner_authentication_required", recoveryAction: "Authenticate the Realm owner through /owner/login before issuing an Authority command.", receipt: "ownerSession=missing-or-invalid; authorityCommand=not-accepted" }, 401);

  try {
    if (url.pathname === "/api/authority/state" && request.method === "GET") return json(await requestAnyamRealmCoordinator(env, "/authority/state/internal", { sessionId }));
    if (url.pathname === "/api/authority/command" && request.method === "POST") return json(await requestAnyamRealmCoordinator(env, "/authority/command/internal", { ...(await readBody(request)), sessionId }));
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, code: "not_found", recoveryAction: "Use GET /api/authority/state or POST /api/authority/command.", receipt: `authorityRoute=${url.pathname}; method=${request.method}; transition=not-started` }, 404);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") || detail.includes("promotion=blocked") ? 409 : 503;
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "authority_coordinator_rejected", recoveryAction: "Inspect the Durable Object receipt and retry only the same idempotent command when safe.", receipt: `authority=coordinator-rejected; detail=${detail}; credentialFree=true` }, status);
  }
}
