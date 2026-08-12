import { customerRealmWorkerHealth } from "../../../src/cloudflare/realm-worker.ts";
import { AUTHORITY_COMMAND_PROTOCOL, AUTHORITY_PLANE_PROTOCOL } from "../../../src/cloudflare/authority-plane.ts";
import { anyamRealmOwnerSessionId, requestAnyamRealmCoordinator } from "./passkey-owner.ts";
import type { AnyamRealmOAuthEnv } from "./oauth-provider.ts";
import { bootstrapCommand, bootstrapPath, projectBootstrapValue, type BootstrapMutation, type BootstrapPath } from "./bootstrap-contract.ts";
import { RevisionPublishInputError, revisionPublishCommand, revisionPublishValue, REVISION_PUBLISH_COMMAND } from "./revision-contract.ts";
import { EVIDENCE_RECORD_COMMAND, evidenceRecordCommand, evidenceRecordValue, RunEvidenceInputError, RUN_RECORD_COMMAND, runRecordCommand, runRecordValue } from "./run-evidence-contract.ts";
import { ARTIFACT_RECORD_COMMAND, artifactRecordCommand, artifactRecordValue, ArtifactRecordInputError } from "./artifact-contract.ts";

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

function projectBootstrapResponse(result: Record<string, unknown>, command: BootstrapMutation, idempotencyKey: string): Response {
  return json(projectBootstrapValue(result, command, idempotencyKey));
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
    command = bootstrapCommand(path, body, request.headers.get("idempotency-key") ?? undefined);
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

type RestRecordOperation = typeof RUN_RECORD_COMMAND | typeof EVIDENCE_RECORD_COMMAND | typeof ARTIFACT_RECORD_COMMAND;

function recordInput(operation: RestRecordOperation, body: Record<string, unknown>, idempotencyKey: string): ReturnType<typeof runRecordCommand> | ReturnType<typeof evidenceRecordCommand> | ReturnType<typeof artifactRecordCommand> {
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== idempotencyKey) {
    const ErrorType = operation === ARTIFACT_RECORD_COMMAND ? ArtifactRecordInputError : RunEvidenceInputError;
    throw new ErrorType("The body idempotencyKey does not match the Idempotency-Key header.", "send one Idempotency-Key header and omit body.idempotencyKey, or make both values identical; no transition was accepted", `operation=${operation}; idempotencyKey=transport-mismatch; transition=not-applied`);
  }
  const typedBody = { ...body, idempotencyKey };
  return operation === RUN_RECORD_COMMAND ? runRecordCommand(typedBody) : operation === EVIDENCE_RECORD_COMMAND ? evidenceRecordCommand(typedBody) : artifactRecordCommand(typedBody);
}

function recordError(operation: RestRecordOperation, status: number, code: string, recoveryAction: string, receipt: string): Response {
  return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code, recoveryAction, receipt: `operation=${operation}; ${receipt}; credentialFree=true; canonicalWrite=false` }, status);
}

async function recordMutation(request: Request, env: AnyamRealmOAuthEnv, operation: RestRecordOperation): Promise<Response> {
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return recordError(operation, 401, "owner_authentication_required", `Authenticate the Realm owner through /owner/login before recording a ${operation === RUN_RECORD_COMMAND ? "Run" : operation === EVIDENCE_RECORD_COMMAND ? "Evidence" : "Artifact"}.`, "ownerSession=missing-or-invalid; transition=not-applied");
  if (request.method !== "POST") return recordError(operation, 405, "method_not_allowed", `Use POST /api/${operation === RUN_RECORD_COMMAND ? "runs" : operation === EVIDENCE_RECORD_COMMAND ? "evidence" : "artifacts"} with one Idempotency-Key header.`, "method=post-required; transition=not-applied");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return recordError(operation, 422, "invalid_request", "Send one non-empty Idempotency-Key header; no transition was accepted.", "idempotencyKey=required; transition=not-applied");
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return recordError(operation, 422, "invalid_request", `Send a JSON object containing only the documented ${operation} fields; no transition was accepted.`, "body=object-required; transition=not-applied");
  }
  let command: ReturnType<typeof runRecordCommand> | ReturnType<typeof evidenceRecordCommand> | ReturnType<typeof artifactRecordCommand>;
  try {
    command = recordInput(operation, body, idempotencyKey);
  } catch (error) {
    if (error instanceof RunEvidenceInputError || error instanceof ArtifactRecordInputError) return recordError(operation, 422, "invalid_request", error.recoveryAction, error.receipt);
    return recordError(operation, 422, "invalid_request", "Correct the typed request and retry; no transition was accepted.", "arguments=invalid; transition=not-applied");
  }
  try {
    const result = await requestAnyamRealmCoordinator(env, "/authority/command/internal", { protocol: AUTHORITY_COMMAND_PROTOCOL, command: command.command, idempotencyKey: command.idempotencyKey, ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }), payload: command.payload, sessionId });
    return json(operation === RUN_RECORD_COMMAND ? runRecordValue(result, idempotencyKey, "rest") : operation === EVIDENCE_RECORD_COMMAND ? evidenceRecordValue(result, idempotencyKey, "rest") : artifactRecordValue(result, idempotencyKey, "rest"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("invalid_request") ? 422 : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? 409 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : status === 422 ? "invalid_request" : status === 409 ? "conflict" : "coordinator_rejected";
    const code = status === 404 ? `${operation.replace(".", "_")}_not_found` : status === 403 ? "owner_session_rejected" : status === 422 ? "invalid_request" : status === 409 ? `${operation.replace(".", "_")}_conflict` : "authority_coordinator_rejected";
    const recoveryAction = status === 404 ? "Verify the Project, Project Revision, Project View, Workspace, Change Revision, Run, and Artifact identifiers without probing hidden resources." : status === 409 ? "Read the current Authority version, reuse the original idempotency payload, or reconcile the exact lifecycle relationship before retrying." : status === 403 ? "Authenticate the Realm owner again and retry the same typed request." : "Inspect the Durable Object receipt and retry only the same idempotent request when safe.";
    return recordError(operation, status, code, recoveryAction, `authority=coordinator-rejected; errorClass=${errorClass}`);
  }
}

type RevisionPublishPath = { matched: boolean; changeId?: string; malformed: boolean };

function revisionPublishPath(pathname: string): RevisionPublishPath {
  const segments = pathname.split("/");
  if (segments[1] !== "api" || segments[2] !== "changes") return { matched: false, malformed: false };
  if (segments.length !== 5 || segments[4] !== "revisions") return { matched: false, malformed: false };
  const encodedChangeId = segments[3];
  if (!encodedChangeId) return { matched: true, malformed: true };
  try {
    const changeId = decodeURIComponent(encodedChangeId);
    if (!changeId || changeId.includes("/") || changeId.includes("\\") || changeId === "." || changeId === "..") return { matched: true, malformed: true };
    return { matched: true, changeId, malformed: false };
  } catch {
    return { matched: true, malformed: true };
  }
}

function revisionError(status: number, code: string, recoveryAction: string, receipt: string): Response {
  return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code, recoveryAction, receipt: `operation=${REVISION_PUBLISH_COMMAND}; ${receipt}; credentialFree=true; canonicalWrite=false` }, status);
}

async function revisionMutation(request: Request, env: AnyamRealmOAuthEnv, path: RevisionPublishPath): Promise<Response> {
  const changeId = path.changeId;
  if (!changeId) return revisionError(400, "invalid_revision_path", "Use POST /api/changes/{changeId}/revisions with one safe URL-encoded Change identifier.", "path=malformed; transition=not-applied");
  const sessionId = await anyamRealmOwnerSessionId(request, env);
  if (!sessionId) return revisionError(401, "owner_authentication_required", "Authenticate the Realm owner through /owner/login before publishing a Change Revision.", "ownerSession=missing-or-invalid; transition=not-applied");
  if (request.method !== "POST") return revisionError(405, "method_not_allowed", "Use POST /api/changes/{changeId}/revisions with one Idempotency-Key header.", "method=post-required; transition=not-applied");
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) return revisionError(422, "invalid_request", "Send one non-empty Idempotency-Key header; no transition was accepted.", "idempotencyKey=required; transition=not-applied");
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    return revisionError(422, "invalid_request", "Send a JSON object containing only the documented revision.publish fields; no transition was accepted.", "body=object-required; transition=not-applied");
  }
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== idempotencyKey) return revisionError(422, "invalid_request", "The body idempotencyKey does not match the Idempotency-Key header.", "idempotencyKey=transport-mismatch; transition=not-applied");
  if (body.changeId !== undefined && body.changeId !== changeId) return revisionError(422, "invalid_request", "The Change path and body changeId must identify the same Change; no transition was accepted.", "changeId=path-body-mismatch; transition=not-applied");
  let command: ReturnType<typeof revisionPublishCommand>;
  try {
    command = revisionPublishCommand({ ...body, changeId, idempotencyKey });
  } catch (error) {
    if (error instanceof RevisionPublishInputError) return revisionError(422, "invalid_request", error.recoveryAction, error.receipt);
    return revisionError(422, "invalid_request", "Correct the typed revision request and retry; no transition was accepted.", "arguments=invalid; transition=not-applied");
  }
  try {
    const result = await requestAnyamRealmCoordinator(env, "/authority/command/internal", { protocol: AUTHORITY_COMMAND_PROTOCOL, command: command.command, idempotencyKey: command.idempotencyKey, ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }), payload: command.payload, sessionId });
    return json(revisionPublishValue(result, idempotencyKey));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const status = detail.includes("not_found") ? 404 : detail.includes("owner_denied") || detail.includes("session.") || detail.includes("session_") ? 403 : detail.includes("invalid_request") ? 422 : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? 409 : 503;
    const errorClass = status === 404 ? "not_found" : status === 403 ? "session_rejected" : status === 422 ? "invalid_request" : status === 409 ? "conflict" : "coordinator_rejected";
    const code = status === 404 ? "revision_publish_not_found" : status === 403 ? "owner_session_rejected" : status === 422 ? "invalid_request" : status === 409 ? "revision_publish_conflict" : "authority_coordinator_rejected";
    const recoveryAction = status === 404 ? "Verify the Project, Change, Workspace, Project View, and Source Space identifiers without probing hidden resources." : status === 409 ? "Read the current Authority version, reuse the original idempotency payload, or reconcile the exact Change/Workspace relationship before retrying." : status === 403 ? "Authenticate the Realm owner again and retry the same typed request." : "Inspect the Durable Object receipt and retry only the same idempotent request when safe.";
    return revisionError(status, code, recoveryAction, `authority=coordinator-rejected; errorClass=${errorClass}`);
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
  const isRunRoute = url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/");
  const isEvidenceRoute = url.pathname === "/api/evidence" || url.pathname.startsWith("/api/evidence/");
  const isArtifactRoute = url.pathname === "/api/artifacts" || url.pathname.startsWith("/api/artifacts/");
  const revisionRoute = revisionPublishPath(url.pathname);
  if (!url.pathname.startsWith("/api/authority") && !isProjectRoute && !isChangeRoute && !isWorkspaceRoute && !isRunRoute && !isEvidenceRoute && !isArtifactRoute && !revisionRoute.matched) return undefined;

  const health = customerRealmWorkerHealth(env);
  if (health.status !== "ready") {
    return json({ protocol: AUTHORITY_PLANE_PROTOCOL, status: "blocked", code: "customer_realm_configuration_invalid", missingConfiguration: health.missingConfiguration, recoveryAction: health.recoveryAction, receipt: `${health.receipt}; authority=blocked; productReady=false` }, 503);
  }

  if (isRunRoute) {
    if (url.pathname !== "/api/runs") return recordError(RUN_RECORD_COMMAND, 400, "invalid_run_path", "Use POST /api/runs with the Project binding in the typed JSON body.", "path=malformed; transition=not-applied");
    return recordMutation(request, env, RUN_RECORD_COMMAND);
  }

  if (isEvidenceRoute) {
    if (url.pathname !== "/api/evidence") return recordError(EVIDENCE_RECORD_COMMAND, 400, "invalid_evidence_path", "Use POST /api/evidence with the Project and Run bindings in the typed JSON body.", "path=malformed; transition=not-applied");
    return recordMutation(request, env, EVIDENCE_RECORD_COMMAND);
  }

  if (isArtifactRoute) {
    if (url.pathname !== "/api/artifacts") return recordError(ARTIFACT_RECORD_COMMAND, 400, "invalid_artifact_path", "Use POST /api/artifacts with the Project and lifecycle bindings in the typed JSON body.", "path=malformed; transition=not-applied");
    return recordMutation(request, env, ARTIFACT_RECORD_COMMAND);
  }

  if (revisionRoute.matched) {
    if (revisionRoute.malformed) return revisionError(400, "invalid_revision_path", "Use POST /api/changes/{changeId}/revisions with one safe URL-encoded Change identifier.", "path=malformed; transition=not-applied");
    return revisionMutation(request, env, revisionRoute);
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
