import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "./coordinator-protocol.ts";
import { bootstrapCommand, bootstrapPath, projectBootstrapValue, type BootstrapMutation } from "./bootstrap-contract.ts";
import { revisionPublishCommand, revisionPublishValue, RevisionPublishInputError } from "./revision-contract.ts";
import { runRequestCommand, runRequestValue, RUN_REQUEST_COMMAND, RunEvidenceInputError } from "./run-evidence-contract.ts";
import { landingApplyCommand, landingApplyValue, LANDING_APPLY_COMMAND } from "./landing-contract.ts";
import { releaseCreateCommand, releaseCreateValue, RELEASE_CREATE_COMMAND } from "./release-contract.ts";
import { targetConfigureCommand, targetConfigureValue, TARGET_CONFIGURE_COMMAND } from "./target-contract.ts";
import { promotionRequestCommand, promotionRequestValue, PROMOTION_REQUEST_COMMAND } from "./promotion-contract.ts";
import { MCP_DELIVERY_SCOPE_BY_OPERATION } from "./mcp-delivery-grant.ts";
import type { Capability } from "../../../src/identity/realm.ts";
import type { ResourceRef } from "../../../src/kernel/contracts.ts";

export const ANYAM_MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const ANYAM_MCP_PROTOCOL = "anyam.remote-mcp/v1" as const;
const MCP_PROJECT_SCOPE = "project.read";
const MCP_PROJECT_WRITE_SCOPE = "project.write";
const MCP_WORKSPACE_SCOPE = "workspace.inspect";
const MCP_WORKSPACE_WRITE_SCOPE = "workspace.write";
const MCP_CHANGE_SCOPE = "change.inspect";
const MCP_CHANGE_WRITE_SCOPE = "change.write";
const MCP_READ_TOOL = "project.inspect";
const MCP_LIST_TOOL = "project.list";
const MCP_WORKSPACE_READ_TOOL = "workspace.inspect";
const MCP_WORKSPACE_LIST_TOOL = "workspace.list";
const MCP_CHANGE_READ_TOOL = "change.inspect";
const MCP_CHANGE_LIST_TOOL = "change.list";
const MCP_PROJECT_CREATE_TOOL = "project.create";
const MCP_WORKSPACE_CREATE_TOOL = "workspace.create";
const MCP_CHANGE_CREATE_TOOL = "change.create";
const MCP_CHANGE_REVISION_PUBLISH_TOOL = "change.publish_revision";
const MCP_RUN_REQUEST_TOOL = "run.request";
const MCP_RUN_INSPECT_TOOL = "run.inspect";
const LEGACY_RUN_MUTATION_TOOLS = new Set(["run.record", "evidence.record", "artifact.record"]);
const MCP_RUN_SCOPE = "run.invoke";
const MCP_LANDING_SCOPE = "landing.request";
const MCP_RELEASE_SCOPE = "release.create";
const MCP_TARGET_SCOPE = "target.configure";
const MCP_PROMOTION_SCOPE = "promotion.request";
const MCP_BOOTSTRAP_TOOLS = new Set([MCP_PROJECT_CREATE_TOOL, MCP_WORKSPACE_CREATE_TOOL, MCP_CHANGE_CREATE_TOOL]);
const MCP_DELIVERY_SCOPE_BY_TOOL: Record<string, string> = { ...MCP_DELIVERY_SCOPE_BY_OPERATION };

export type AnyamRealmMcpProps = {
  readonly scopes: readonly string[];
  readonly realmId?: string;
  readonly kernelSessionId?: string;
  /** Provider-issued grant handle carried in the encrypted OAuth grant. */
  readonly anyamGrantId?: string;
  /** Canonical OAuth resource indicator; required for delivery mutations. */
  readonly mcpResource?: string;
  /** Delegated agent identity carried by mutation-capable OAuth grants. */
  readonly agentId?: string;
  readonly taskId?: string;
  readonly capabilityGrantId?: string;
  readonly delegatedBySessionId?: string;
  readonly resource?: ResourceRef;
  readonly sourceSpaceIds?: readonly string[];
};

export type AnyamRealmMcpEnv = {
  readonly ANYAM_INSTALLATION_ID?: string | undefined;
  readonly REALM_COORDINATOR?: unknown;
};

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: unknown };
type McpBootstrapErrorKind = "auth" | "invalid_request" | "not_found" | "conflict" | "coordinator";

class McpBootstrapError extends Error {
  readonly kind: McpBootstrapErrorKind;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(kind: McpBootstrapErrorKind, message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "McpBootstrapError";
    this.kind = kind;
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

type McpDeliveryErrorKind = "auth" | "invalid_request" | "not_found" | "conflict" | "coordinator";

class McpDeliveryError extends Error {
  readonly kind: McpDeliveryErrorKind;
  readonly recoveryAction: string;
  readonly receipt: string;

  constructor(kind: McpDeliveryErrorKind, message: string, recoveryAction: string, receipt: string) {
    super(message);
    this.name = "McpDeliveryError";
    this.kind = kind;
    this.recoveryAction = recoveryAction;
    this.receipt = receipt;
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function mcpJson(body: unknown, status = 200): Response {
  return jsonResponse(body, status, { "mcp-session-id": "not-issued" });
}

function mcpError(id: JsonRpcId, code: number, message: string, data: Record<string, unknown>): Response {
  return mcpJson({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function mcpRequest(value: unknown): JsonRpcRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("jsonrpc_request_object_required");
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method.trim().length === 0) throw new Error("jsonrpc_request_invalid");
  const id = record.id;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") throw new Error("jsonrpc_id_invalid");
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id: id as JsonRpcId }), method: record.method, ...(record.params === undefined ? {} : { params: record.params }) };
}

function mcpParams(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("jsonrpc_params_object_required");
  return value as Record<string, unknown>;
}

function mcpProjectId(value: unknown): string {
  const params = mcpParams(value);
  const projectId = params.projectId;
  if (typeof projectId !== "string" || projectId.trim().length === 0) throw new Error("projectId_required");
  return projectId.trim();
}

function mcpWorkspaceId(value: unknown): string {
  const params = mcpParams(value);
  const workspaceId = params.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) throw new Error("workspaceId_required");
  return workspaceId.trim();
}

function mcpWorkspaceListProjectId(value: unknown): string | undefined {
  const params = mcpParams(value);
  if (params.projectId === undefined) return undefined;
  if (typeof params.projectId !== "string" || params.projectId.trim().length === 0) throw new Error("projectId_required");
  return params.projectId.trim();
}

function mcpChangeId(value: unknown): string {
  const params = mcpParams(value);
  const changeId = params.changeId;
  if (typeof changeId !== "string" || changeId.trim().length === 0) throw new Error("changeId_required");
  return changeId.trim();
}

function mcpRunId(value: unknown): string {
  const params = mcpParams(value);
  const runId = params.runId;
  if (typeof runId !== "string" || runId.trim().length === 0) throw new Error("runId_required");
  return runId.trim();
}

function mcpChangeListFilters(value: unknown): { projectId?: string; workspaceId?: string } {
  const params = mcpParams(value);
  const readFilter = (key: "projectId" | "workspaceId"): string | undefined => {
    if (params[key] === undefined) return undefined;
    if (typeof params[key] !== "string" || (params[key] as string).trim().length === 0) throw new Error(`${key}_required`);
    return (params[key] as string).trim();
  };
  const projectId = readFilter("projectId");
  const workspaceId = readFilter("workspaceId");
  return { ...(projectId ? { projectId } : {}), ...(workspaceId ? { workspaceId } : {}) };
}

function mcpToolResult(value: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

async function requestMcpCoordinator(env: AnyamRealmMcpEnv, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const binding = env.REALM_COORDINATOR as { idFromName(name: string): string; get(id: string): { fetch(request: Request): Promise<Response> } } | undefined;
  if (!binding || typeof binding.idFromName !== "function") throw new Error("realm_coordinator_unavailable");
  const realmId = `realm:${env.ANYAM_INSTALLATION_ID ?? "unconfigured"}`;
  const stub = binding.get(binding.idFromName(realmId));
  const response = await stub.fetch(new Request(`https://anyam-realm-coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [REALM_COORDINATOR_INTERNAL_HEADER]: REALM_COORDINATOR_INTERNAL_VALUE },
    body: JSON.stringify(body),
  }));
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof payload.code === "string" ? payload.code : "realm_coordinator_rejected";
    const recoveryAction = typeof payload.recoveryAction === "string" ? payload.recoveryAction : "inspect the coordinator receipt and retry the same read only when safe";
    const receipt = typeof payload.receipt === "string" ? payload.receipt : "receipt=not-returned";
    throw new Error(`realm_coordinator_${code}; recoveryAction=${recoveryAction}; ${receipt}`);
  }
  return payload;
}

function mcpMutationContext(props: AnyamRealmMcpProps, operation: string, payload: Record<string, unknown>, effects: readonly string[] = []): Record<string, unknown> {
  if (!props.kernelSessionId || !props.realmId || !props.agentId || !props.taskId || !props.capabilityGrantId) throw new McpBootstrapError("auth", "The MCP mutation is not bound to a delegated Agent Task and Capability Grant.", "authorize the MCP client through an owner-approved Agent Task, then retry; no transition was accepted", `mcp=${operation}; agent=${props.agentId ? "present" : "missing"}; task=${props.taskId ? "present" : "missing"}; grant=${props.capabilityGrantId ? "present" : "missing"}; transition=not-applied`);
  const capability: Capability = operation === "workspace.create" ? "workspace.write" : operation === "change.create" || operation === "revision.publish" ? "change.publish_revision" : operation === "run.request" ? "run.invoke" : operation as Capability;
  if (operation === "project.create") throw new McpBootstrapError("auth", "Project creation is an owner operation, not an Agent Task mutation.", "create the Project through the authenticated owner surface before delegating a Workspace Task", "mcp=project.create; agentMutation=not-supported; transition=not-applied");
  const resource: ResourceRef = props.resource ?? {
    realmId: props.realmId,
    ...(typeof payload.projectId === "string" ? { projectId: payload.projectId } : {}),
    ...(typeof payload.workspaceId === "string" ? { workspaceId: payload.workspaceId } : {}),
    ...(typeof payload.changeId === "string" ? { changeId: payload.changeId } : {}),
  };
  return {
    surface: "mcp",
    sessionId: props.kernelSessionId,
    agentId: props.agentId,
    taskId: props.taskId,
    capabilityGrantId: props.capabilityGrantId,
    ...(props.delegatedBySessionId ? { delegatedBySessionId: props.delegatedBySessionId } : {}),
    capability,
    resource,
    sourceSpaceIds: [...(props.sourceSpaceIds ?? [])],
    effects: [...effects],
  };
}

async function requestMcpMutationCoordinator(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, command: Record<string, unknown>, operation: string, effects: readonly string[] = []): Promise<Record<string, unknown>> {
  const payload = command.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new McpBootstrapError("invalid_request", "The MCP mutation payload must be an object.", "send the documented typed mutation payload; no transition was accepted", `mcp=${operation}; payload=object-required; transition=not-applied`);
  return requestMcpCoordinator(env, "/authority/mcp-command/internal", { ...command, ...mcpMutationContext(props, operation, payload as Record<string, unknown>, effects) });
}

async function mcpProjectInspect(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, projectId: string): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new Error("mcp_kernel_session_missing");
  const result = await requestMcpCoordinator(env, "/authority/project/internal", { sessionId: props.kernelSessionId, projectId });
  return {
    protocol: ANYAM_MCP_PROTOCOL,
    status: "ready",
    project: result.project,
    canonicalRevision: result.canonicalRevision,
    sourceSpaces: result.sourceSpaces,
    counts: result.counts,
    receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=project.inspect"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false`,
  };
}

async function mcpProjectList(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, argumentsValue: unknown): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new Error("mcp_kernel_session_missing");
  mcpParams(argumentsValue);
  const result = await requestMcpCoordinator(env, "/authority/projects/internal", { sessionId: props.kernelSessionId });
  return {
    protocol: ANYAM_MCP_PROTOCOL,
    status: "ready",
    projects: result.projects,
    receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=project.list"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false`,
  };
}

async function mcpWorkspaceList(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, argumentsValue: unknown): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new Error("mcp_kernel_session_missing");
  const projectId = mcpWorkspaceListProjectId(argumentsValue);
  const result = await requestMcpCoordinator(env, "/authority/workspaces/internal", { sessionId: props.kernelSessionId, ...(projectId ? { projectId } : {}) });
  return {
    protocol: ANYAM_MCP_PROTOCOL,
    status: "ready",
    workspaces: result.workspaces,
    receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=workspace.list"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false`,
  };
}

async function mcpWorkspaceInspect(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, workspaceId: string): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new Error("mcp_kernel_session_missing");
  const result = await requestMcpCoordinator(env, "/authority/workspaces/internal", { sessionId: props.kernelSessionId, workspaceId });
  return {
    protocol: ANYAM_MCP_PROTOCOL,
    status: "ready",
    workspace: result.workspace,
    project: result.project,
    mountCount: result.mountCount,
    receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=workspace.inspect"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false`,
  };
}

async function mcpChangeList(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, argumentsValue: unknown): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new Error("mcp_kernel_session_missing");
  const filters = mcpChangeListFilters(argumentsValue);
  const result = await requestMcpCoordinator(env, "/authority/changes/internal", { sessionId: props.kernelSessionId, ...filters });
  return {
    protocol: ANYAM_MCP_PROTOCOL,
    status: "ready",
    changes: result.changes,
    receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=change.list"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false`,
  };
}

async function mcpChangeInspect(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, changeId: string): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new Error("mcp_kernel_session_missing");
  const result = await requestMcpCoordinator(env, "/authority/changes/internal", { sessionId: props.kernelSessionId, changeId });
  return {
    protocol: ANYAM_MCP_PROTOCOL,
    status: "ready",
    change: result.change,
    project: result.project,
    revisions: result.revisions,
    receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=change.inspect"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false`,
  };
}

async function mcpRunInspect(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, runId: string): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new RunEvidenceInputError("The MCP grant is not bound to an authenticated Realm session.", "reauthorize the MCP client through the authenticated Realm owner session; no read was exposed", "mcp=run.inspect; kernelSession=missing; read=not-accepted", "auth");
  const result = await requestMcpCoordinator(env, "/authority/runs/internal", { sessionId: props.kernelSessionId, runId });
  return { protocol: ANYAM_MCP_PROTOCOL, status: "ready", run: result.run, receipt: `${typeof result.receipt === "string" ? result.receipt : "authority=coordinator; operation=run.inspect"}; oauth=audience-validated; mcp=read-only; credentialFree=true; canonicalWrite=false` };
}

async function mcpRunRequest(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, argumentsValue: unknown): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new RunEvidenceInputError("The MCP grant is not bound to an authenticated Realm session.", "reauthorize the MCP client through the authenticated Realm owner session; no transition was accepted", "mcp=run.request; kernelSession=missing; transition=not-applied", "auth");
  let input: ReturnType<typeof runRequestCommand>;
  try {
    input = runRequestCommand(argumentsValue);
  } catch (error) {
    if (error instanceof RunEvidenceInputError) throw error;
    throw new RunEvidenceInputError("The typed Run request arguments are invalid.", "send an object containing only the documented typed Run request arguments; no transition was accepted", "mcp=run.request; arguments=invalid; transition=not-applied");
  }
  try {
    const result = await requestMcpMutationCoordinator(env, props, { protocol: "anyam.authority-command/v1", command: input.command, idempotencyKey: input.idempotencyKey, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), payload: input.payload }, "run.request");
    const value = runRequestValue(result, input.idempotencyKey, "mcp");
    return { ...value, protocol: ANYAM_MCP_PROTOCOL, receipt: `${String(value.receipt)}; oauth=audience-validated` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const kind: RunEvidenceInputError["kind"] = detail.includes("not_found") ? "not_found" : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? "conflict" : detail.includes("invalid_request") ? "invalid_request" : detail.includes("session.") || detail.includes("session_") ? "auth" : "coordinator";
    const recoveryAction = kind === "not_found" ? "verify the Project, Project Revision, Project View, Change Revision, and Workspace identifiers without probing hidden resources" : kind === "conflict" ? "reuse the original idempotent request or reconcile the current Authority state before retrying" : kind === "auth" ? "reauthorize the MCP client through the authenticated Realm owner session" : "inspect the Coordinator receipt and retry only the same idempotent request when safe";
    throw new RunEvidenceInputError("The Run request was not accepted.", recoveryAction, `mcp=run.request; errorClass=${kind}; credentialFree=true; canonicalWrite=false`, kind);
  }
}

function mcpBootstrapIdempotency(argumentsValue: Record<string, unknown>): string {
  const value = argumentsValue.idempotencyKey;
  if (typeof value !== "string" || value.trim().length === 0) throw new McpBootstrapError("invalid_request", "idempotencyKey is required for a bootstrap mutation.", "send one stable idempotencyKey for this intent; no transition was accepted", "mcp=typed-bootstrap; idempotencyKey=required; transition=not-applied");
  return value.trim();
}

function mcpBootstrapInput(operation: BootstrapMutation, argumentsValue: unknown): { command: ReturnType<typeof bootstrapCommand>; idempotencyKey: string } {
  const argumentsRecord = mcpParams(argumentsValue);
  const idempotencyKey = mcpBootstrapIdempotency(argumentsRecord);
  const body = { ...argumentsRecord };
  delete body.idempotencyKey;
  let pathname: string;
  if (operation === "project.create") {
    pathname = "/api/projects";
  } else {
    const projectId = body.projectId;
    if (typeof projectId !== "string" || projectId.trim().length === 0) throw new McpBootstrapError("invalid_request", "projectId is required for this bootstrap mutation.", "provide the Project resource identifier in the tool arguments; no transition was accepted", `mcp=typed-bootstrap; operation=${operation}; projectId=required; transition=not-applied`);
    delete body.projectId;
    pathname = `/api/projects/${encodeURIComponent(projectId.trim())}/${operation === "workspace.create" ? "workspaces" : "changes"}`;
  }
  let path: ReturnType<typeof bootstrapPath>;
  try {
    path = bootstrapPath(pathname);
  } catch {
    throw new McpBootstrapError("invalid_request", "The bootstrap resource path is invalid.", "use one safe Project identifier and retry; no transition was accepted", `mcp=typed-bootstrap; operation=${operation}; path=malformed; transition=not-applied`);
  }
  if (path.mutation !== operation) throw new McpBootstrapError("invalid_request", "The bootstrap operation does not match its resource path.", "call the operation on its documented Project resource; no transition was accepted", `mcp=typed-bootstrap; operation=${operation}; path=operation-mismatch; transition=not-applied`);
  try {
    return { command: bootstrapCommand(path, body, idempotencyKey), idempotencyKey };
  } catch (error) {
    const typed = error as Partial<{ recoveryAction: string; receipt: string }>;
    throw new McpBootstrapError("invalid_request", "The typed bootstrap arguments are invalid.", typed.recoveryAction ?? "correct the documented bootstrap arguments and retry; no transition was accepted", typed.receipt ?? `mcp=typed-bootstrap; operation=${operation}; transition=not-applied`);
  }
}

async function mcpBootstrap(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, operation: BootstrapMutation, argumentsValue: unknown): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new McpBootstrapError("auth", "The MCP grant is not bound to an authenticated Realm session.", "reauthorize the MCP client through the authenticated Realm owner session; no transition was accepted", `mcp=typed-bootstrap; operation=${operation}; kernelSession=missing; transition=not-applied`);
  let input: ReturnType<typeof mcpBootstrapInput>;
  try {
    input = mcpBootstrapInput(operation, argumentsValue);
  } catch (error) {
    if (error instanceof McpBootstrapError) throw error;
    throw new McpBootstrapError("invalid_request", "The typed bootstrap arguments are invalid.", "send an object containing only the documented typed arguments; no transition was accepted", `mcp=typed-bootstrap; operation=${operation}; arguments=invalid; transition=not-applied`);
  }
  const { command, idempotencyKey } = input;
  let result: Record<string, unknown>;
  try {
    result = operation === "project.create" && !props.agentId
      ? await requestMcpCoordinator(env, "/authority/command/internal", { protocol: "anyam.authority-command/v1", command: command.command, idempotencyKey, ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }), payload: command.payload, sessionId: props.kernelSessionId })
      : await requestMcpMutationCoordinator(env, props, { protocol: "anyam.authority-command/v1", command: command.command, idempotencyKey, ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }), payload: command.payload }, operation);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const kind: McpBootstrapErrorKind = detail.includes("not_found") ? "not_found" : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? "conflict" : detail.includes("invalid_request") ? "invalid_request" : detail.includes("session.") || detail.includes("session_") ? "auth" : "coordinator";
    throw new McpBootstrapError(kind, "The typed bootstrap transition was not accepted.", kind === "not_found" ? "verify the Project, Project Revision, Workspace, and Source Space identifiers without probing hidden resources" : kind === "conflict" ? "reuse the original idempotency payload or read the current Authority version before retrying" : kind === "auth" ? "reauthorize the MCP client through the authenticated Realm owner session" : "inspect the Coordinator receipt and retry only the same idempotent request when safe", `mcp=typed-bootstrap; operation=${operation}; errorClass=${kind}; credentialFree=true; canonicalWrite=false`);
  }
  try {
    const value = projectBootstrapValue(result, operation, idempotencyKey);
    return { ...value, protocol: ANYAM_MCP_PROTOCOL, receipt: `${String(value.receipt)}; oauth=audience-validated; mcp=typed-bootstrap; credentialFree=true; canonicalWrite=${operation === "project.create" ? "initialization-only" : "false"}` };
  } catch {
    throw new McpBootstrapError("coordinator", "The Coordinator returned an invalid bootstrap projection.", "inspect the Coordinator receipt and retry only after reconciling its authoritative result; no additional transition was accepted", `mcp=typed-bootstrap; operation=${operation}; projection=malformed; credentialFree=true; canonicalWrite=false`);
  }
}

async function mcpRevisionPublish(env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps, argumentsValue: unknown): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId) throw new RevisionPublishInputError("The MCP grant is not bound to an authenticated Realm session.", "reauthorize the MCP client through the authenticated Realm owner session; no transition was accepted", "mcp=revision-publish; kernelSession=missing; transition=not-applied", "auth");
  let input: ReturnType<typeof revisionPublishCommand>;
  try {
    input = revisionPublishCommand(argumentsValue);
  } catch (error) {
    if (error instanceof RevisionPublishInputError) throw error;
    throw new RevisionPublishInputError("The typed revision publication arguments are invalid.", "send an object containing only the documented revision publication arguments; no transition was accepted", "mcp=revision-publish; arguments=invalid; transition=not-applied");
  }
  let result: Record<string, unknown>;
  try {
    result = await requestMcpMutationCoordinator(env, props, { protocol: "anyam.authority-command/v1", command: input.command, idempotencyKey: input.idempotencyKey, ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }), payload: input.payload }, "revision.publish");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const kind: RevisionPublishInputError["kind"] = detail.includes("not_found") ? "not_found" : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? "conflict" : detail.includes("invalid_request") ? "invalid_request" : detail.includes("session.") || detail.includes("session_") ? "auth" : "coordinator";
    const recoveryAction = kind === "not_found" ? "verify the Project, Workspace, Change, and Project View identifiers without probing hidden resources" : kind === "conflict" ? "reuse the original idempotency payload or read the current Authority version before retrying" : kind === "auth" ? "reauthorize the MCP client through the authenticated Realm owner session" : "inspect the Coordinator receipt and retry only the same idempotent request when safe";
    throw new RevisionPublishInputError("The typed Change Revision publication was not accepted.", recoveryAction, `mcp=revision-publish; errorClass=${kind}; credentialFree=true; canonicalWrite=false`, kind === "auth" || kind === "not_found" || kind === "conflict" ? kind : "coordinator");
  }
  try {
    const value = revisionPublishValue(result, input.idempotencyKey);
    return { ...value, protocol: ANYAM_MCP_PROTOCOL, receipt: `${String(value.receipt)}; oauth=audience-validated` };
  } catch {
    throw new RevisionPublishInputError("The Coordinator returned an invalid revision publication projection.", "inspect the Coordinator receipt and retry only after reconciling its authoritative result; no additional transition was accepted", "mcp=revision-publish; projection=malformed; credentialFree=true; canonicalWrite=false", "coordinator");
  }
}


type McpDeliveryOperation = typeof LANDING_APPLY_COMMAND | typeof RELEASE_CREATE_COMMAND | typeof TARGET_CONFIGURE_COMMAND | typeof PROMOTION_REQUEST_COMMAND;
type McpDeliveryMutation =
  | ReturnType<typeof landingApplyCommand>
  | ReturnType<typeof releaseCreateCommand>
  | ReturnType<typeof targetConfigureCommand>
  | ReturnType<typeof promotionRequestCommand>;

function mcpDeliveryInput(operation: McpDeliveryOperation, argumentsValue: unknown): McpDeliveryMutation {
  try {
    switch (operation) {
      case LANDING_APPLY_COMMAND:
        return landingApplyCommand(argumentsValue);
      case RELEASE_CREATE_COMMAND:
        return releaseCreateCommand(argumentsValue);
      case TARGET_CONFIGURE_COMMAND:
        return targetConfigureCommand(argumentsValue);
      case PROMOTION_REQUEST_COMMAND:
        return promotionRequestCommand(argumentsValue);
    }
  } catch (error) {
    const typed = error as Partial<{ kind: McpDeliveryErrorKind; recoveryAction: string; receipt: string }>;
    const kind = typed.kind === "not_found" || typed.kind === "conflict" || typed.kind === "auth" || typed.kind === "coordinator" ? typed.kind : "invalid_request";
    throw new McpDeliveryError(
      kind,
      `The typed ${operation} mutation arguments are invalid.`,
      typed.recoveryAction ?? `send only the documented ${operation} fields; no transition was accepted`,
      typed.receipt ?? `mcp=${operation}; arguments=invalid; transition=not-applied`,
    );
  }
}

function mcpDeliveryProjection(operation: McpDeliveryOperation, result: Record<string, unknown>, idempotencyKey: string): Record<string, unknown> {
  const value = operation === LANDING_APPLY_COMMAND
    ? landingApplyValue(result, idempotencyKey, "mcp")
    : operation === RELEASE_CREATE_COMMAND
      ? releaseCreateValue(result, idempotencyKey, "mcp")
      : operation === TARGET_CONFIGURE_COMMAND
        ? targetConfigureValue(result, idempotencyKey, "mcp")
        : promotionRequestValue(result, idempotencyKey, "mcp");
  return {
    ...value,
    protocol: ANYAM_MCP_PROTOCOL,
    receipt: `${String(value.receipt)}; oauth=audience-validated; mcp=delivery; grant=validated; providerExecution=not-performed`,
  };
}

async function mcpDeliveryMutation(
  env: AnyamRealmMcpEnv,
  props: AnyamRealmMcpProps,
  operation: McpDeliveryOperation,
  argumentsValue: unknown,
): Promise<Record<string, unknown>> {
  if (!props.kernelSessionId || !props.anyamGrantId || props.anyamGrantId.trim().length === 0) {
    throw new McpDeliveryError(
      "auth",
      "The MCP delivery mutation is not bound to a live OAuth grant and Realm session.",
      "reauthorize the MCP client with the requested delivery scope; no transition was accepted",
      `mcp=${operation}; grant=missing; kernelSession=${props.kernelSessionId ? "present" : "missing"}; transition=not-applied`,
    );
  }
  if (!props.mcpResource || props.mcpResource.trim().length === 0) {
    throw new McpDeliveryError(
      "auth",
      "The MCP delivery mutation is not bound to a project-scoped OAuth resource.",
      "reauthorize the MCP client with a resource such as /mcp/projects/<projectId>; no transition was accepted",
      `mcp=${operation}; grant=resource-missing; transition=not-applied; canonicalWrite=false`,
    );
  }
  const requiredScope = MCP_DELIVERY_SCOPE_BY_TOOL[operation];
  if (!requiredScope || !props.scopes.includes(requiredScope)) {
    throw new McpDeliveryError(
      "auth",
      `The MCP grant does not include ${requiredScope ?? operation}.`,
      `authorize the ${requiredScope ?? operation} scope and retry`,
      `mcp=${operation}; scope=${requiredScope ?? "unknown"}; grant=denied; transition=not-applied`,
    );
  }

  const input = mcpDeliveryInput(operation, argumentsValue);
  try {
    await requestMcpCoordinator(env, "/identity/oauth-grant/validate-delivery", {
      sessionId: props.kernelSessionId,
      grantId: props.anyamGrantId,
      operation,
      scope: requiredScope,
      resource: props.mcpResource,
      payload: input.payload,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const kind: McpDeliveryErrorKind = detail.includes("not_found") || detail.includes("discoverable") ? "not_found" : detail.includes("conflict") || detail.includes("mismatch") ? "conflict" : detail.includes("invalid_request") ? "invalid_request" : detail.includes("oauth.") || detail.includes("grant") || detail.includes("session") ? "auth" : "coordinator";
    throw new McpDeliveryError(
      kind,
      "The MCP delivery Task/Grant is not live for this operation.",
      kind === "not_found" ? "verify the Project, Workspace, Change, Source Space, and delivery resource without probing hidden identifiers" : kind === "conflict" ? "use the exact Project, Workspace, Change, and typed delivery lineage bound to this MCP grant" : kind === "auth" ? "reauthorize the MCP client through the authenticated Realm owner session and current project-scoped resource" : "inspect the Coordinator receipt and retry only the same typed operation when safe",
      `mcp=${operation}; taskGrant=not-live; errorClass=${kind}; credentialFree=true; canonicalWrite=false; providerExecution=not-performed`,
    );
  }
  let result: Record<string, unknown>;
  try {
    result = await requestMcpCoordinator(env, "/authority/command/internal", {
      protocol: "anyam.authority-command/v1",
      command: input.command,
      idempotencyKey: input.idempotencyKey,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
      payload: input.payload,
      sessionId: props.kernelSessionId,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "realm_coordinator_rejected";
    const kind: McpDeliveryErrorKind = detail.includes("not_found") ? "not_found" : detail.includes("idempotency_conflict") || detail.includes("stale_state") || detail.includes("conflict") ? "conflict" : detail.includes("invalid_request") ? "invalid_request" : detail.includes("session.") || detail.includes("session_") ? "auth" : "coordinator";
    const recoveryAction = kind === "not_found"
      ? "verify the Project, Change Revision, Artifact, Evidence, Release, and Target identifiers without probing hidden resources"
      : kind === "conflict"
        ? "reuse the original idempotent payload or read the current Authority version and lineage before retrying"
        : kind === "auth"
          ? "reauthorize the MCP client through the authenticated Realm owner session and live OAuth grant"
          : "inspect the Coordinator receipt and retry only the same idempotent delivery intent when safe";
    throw new McpDeliveryError(kind, `The typed ${operation} mutation was not accepted.`, recoveryAction, `mcp=${operation}; errorClass=${kind}; credentialFree=true; canonicalWrite=false; providerExecution=not-performed`);
  }
  try {
    return mcpDeliveryProjection(operation, result, input.idempotencyKey);
  } catch {
    throw new McpDeliveryError(
      "coordinator",
      `The Coordinator returned an invalid ${operation} projection.`,
      "inspect the Coordinator receipt and retry only after reconciling its authoritative result; no additional transition was accepted",
      `mcp=${operation}; projection=malformed; credentialFree=true; canonicalWrite=false`,
    );
  }
}

/**
 * Realm-scoped remote MCP control surface. OAuthProvider has already
 * validated the bearer token, audience, and encrypted grant properties before
 * this function runs. The handler reads safe summaries and exposes only the
 * typed Project/Workspace/Change bootstrap, Revision, Run, Evidence, Artifact,
 * and delivery mutations explicitly authorized by the grant; source transfer
 * and provider execution stay on their own authority boundaries.
 */
export async function handleAnyamRealmMcpRequest(request: Request, env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps): Promise<Response> {
  const canReadProjects = props.scopes.includes(MCP_PROJECT_SCOPE);
  const canReadWorkspaces = props.scopes.includes(MCP_WORKSPACE_SCOPE);
  const canReadChanges = props.scopes.includes(MCP_CHANGE_SCOPE);
  const canWriteProjects = props.scopes.includes(MCP_PROJECT_WRITE_SCOPE);
  const canWriteWorkspaces = props.scopes.includes(MCP_WORKSPACE_WRITE_SCOPE);
  const canWriteChanges = props.scopes.includes(MCP_CHANGE_WRITE_SCOPE);
  const canRecordRuns = props.scopes.includes(MCP_RUN_SCOPE);
  const hasLiveGrant = typeof props.anyamGrantId === "string" && props.anyamGrantId.trim().length > 0;
  const delegatedAgent = typeof props.agentId === "string" && props.agentId.trim().length > 0;
  // v1 has no privileged release-agent grant path. Delivery authority is an
  // owner-created, project-scoped OAuth Task/Grant and is therefore not
  // advertised to delegated coding agents until that path is qualified.
  const hasHumanDeliveryGrant = hasLiveGrant && !delegatedAgent;
  const canCreateProjects = canWriteProjects && !delegatedAgent;
  const canRequestLanding = hasHumanDeliveryGrant && props.scopes.includes(MCP_LANDING_SCOPE);
  const canCreateRelease = hasHumanDeliveryGrant && props.scopes.includes(MCP_RELEASE_SCOPE);
  const canConfigureTarget = hasHumanDeliveryGrant && props.scopes.includes(MCP_TARGET_SCOPE);
  const canRequestPromotion = hasHumanDeliveryGrant && props.scopes.includes(MCP_PROMOTION_SCOPE);
  const hasDeliveryScope = props.scopes.some((scope) => Object.values(MCP_DELIVERY_SCOPE_BY_TOOL).includes(scope));
  if (!canReadProjects && !canReadWorkspaces && !canReadChanges && !canCreateProjects && !canWriteWorkspaces && !canWriteChanges && !canRecordRuns && !canRequestLanding && !canCreateRelease && !canConfigureTarget && !canRequestPromotion) return mcpError(null, -32001, "The MCP grant does not include a supported Project, Workspace, Change, Run, Artifact, or live delivery capability.", { code: "mcp.scope_denied", recoveryAction: delegatedAgent && hasDeliveryScope ? "use the owner-created delivery MCP resource; generic delegated agents cannot request Landing, Release, Target, or Promotion in v1" : hasDeliveryScope && !hasLiveGrant ? "reauthorize the MCP client so the live OAuth grant handle is present, then retry" : "authorize a documented read scope, write scope, or live delivery grant and retry", receipt: `oauth=validated; mcp=scope-denied; grant=${hasDeliveryScope ? (hasLiveGrant ? "present" : "missing") : "not-requested"}; delegatedAgent=${delegatedAgent}; required=project.read|project.write|workspace.inspect|workspace.write|change.inspect|change.write|run.invoke|landing.request|release.create|target.configure|promotion.request; canonicalWrite=false` });
  if (request.method !== "POST") return mcpJson({ code: "method_not_allowed", recoveryAction: "Use POST with a JSON-RPC 2.0 request for the Realm MCP surface.", receipt: "mcp=read-only; method=post-required; canonicalWrite=false" }, 405);

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return mcpError(null, -32700, "Invalid JSON.", { code: "mcp.parse_error", recoveryAction: "send one JSON-RPC 2.0 request object", receipt: "mcp=request-invalid; credentialFree=true" });
  }
  let rpc: JsonRpcRequest;
  try {
    rpc = mcpRequest(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "jsonrpc_request_invalid";
    return mcpError(null, -32600, "Invalid JSON-RPC request.", { code: "mcp.request_invalid", detail, recoveryAction: "send jsonrpc=2.0, a method, and an optional string/number id", receipt: "mcp=request-invalid; canonicalWrite=false" });
  }
  const id = rpc.id ?? null;
  if (rpc.id === undefined && rpc.method === "notifications/initialized") return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });

  if (rpc.method === "initialize") {
    return mcpJson({ jsonrpc: "2.0", id, result: { protocolVersion: ANYAM_MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "anyam", version: "private-alpha" }, receipt: "mcp=initialized; oauth=audience-validated; canonicalWrite=false" } });
  }
  if (rpc.method === "tools/list") {
    const tools: Array<Record<string, unknown>> = [];
    if (canReadProjects) {
      tools.push(
        { name: MCP_LIST_TOOL, description: "List owner-visible project summaries through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
        { name: MCP_READ_TOOL, description: "Inspect one project summary through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string", minLength: 1 } } } },
      );
    }
    if (canCreateProjects) {
      tools.push({ name: MCP_PROJECT_CREATE_TOOL, description: "Create a Project through the authenticated Coordinator using a typed, idempotent bootstrap command.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "name", "sourceSpaces"], properties: { idempotencyKey: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, referenceType: { type: "string", minLength: 1 }, projectRevisionId: { type: "string", minLength: 1 }, sourceSpaces: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "name", "classification", "snapshotId"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, classification: { type: "string", enum: ["public", "internal", "restricted", "result-only"] }, snapshotId: { type: "string", minLength: 1 } } } }, expectedVersion: { type: "integer", minimum: 0 } } } });
    }
    if (canReadWorkspaces) {
      tools.push(
        { name: MCP_WORKSPACE_LIST_TOOL, description: "List safe Workspace summaries through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, properties: { projectId: { type: "string", minLength: 1 } } } },
        { name: MCP_WORKSPACE_READ_TOOL, description: "Inspect one safe Workspace summary through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, required: ["workspaceId"], properties: { workspaceId: { type: "string", minLength: 1 } } } },
      );
    }
    if (canWriteWorkspaces) {
      tools.push({ name: MCP_WORKSPACE_CREATE_TOOL, description: "Create a Workspace through the authenticated Coordinator using a typed, idempotent bootstrap command.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "projectRevisionId", "sourceSpaceIds"], properties: { idempotencyKey: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 }, projectRevisionId: { type: "string", minLength: 1 }, sourceSpaceIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, mounts: { type: "array", items: { type: "string", minLength: 1 } }, projectionId: { type: "string", minLength: 1 }, classification: { type: "string", minLength: 1 }, changeId: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 } } } });
    }
    if (canReadChanges) {
      tools.push(
        { name: MCP_CHANGE_LIST_TOOL, description: "List safe Change summaries through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, properties: { projectId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 } } } },
        { name: MCP_CHANGE_READ_TOOL, description: "Inspect a safe Change and its immutable Revision summaries through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, required: ["changeId"], properties: { changeId: { type: "string", minLength: 1 } } } },
      );
    }
    if (canWriteChanges) {
      tools.push(
        { name: MCP_CHANGE_CREATE_TOOL, description: "Create a Change through the authenticated Coordinator using a typed, idempotent bootstrap command.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "intentId"], properties: { idempotencyKey: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, changeId: { type: "string", minLength: 1 }, intentId: { type: "string", minLength: 1 }, baseProjectRevisionId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 } } } },
        { name: MCP_CHANGE_REVISION_PUBLISH_TOOL, description: "Publish an immutable Change Revision through the authenticated Coordinator; this never transfers source objects or mutates canonical state.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "changeId", "workspaceId", "projectViewId", "projectRevisionId", "sourceSpaceSnapshots", "declaredEffects"], properties: { idempotencyKey: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 }, projectId: { type: "string", minLength: 1 }, changeId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 }, projectViewId: { type: "string", minLength: 1 }, projectRevisionId: { type: "string", minLength: 1 }, sourceSpaceSnapshots: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } }, declaredEffects: { type: "array", items: { type: "string", minLength: 1 } }, revisionId: { type: "string", minLength: 1 }, kind: { type: "string", enum: ["implementation", "rebase", "conflict-resolution", "handoff", "revert"] }, conflictIds: { type: "array", items: { type: "string", minLength: 1 } }, affectedModuleIds: { type: "array", items: { type: "string", minLength: 1 } }, affectedTargetIds: { type: "array", items: { type: "string", minLength: 1 } } } } },
      );
    }
    if (canRecordRuns) {
      tools.push(
        { name: MCP_RUN_REQUEST_TOOL, description: "Request a declared Action Run. This creates a queued Run only; completion is accepted from an enrolled Runner, never from the MCP caller.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "actionId", "actionContractDigest", "projectRevisionId", "projectViewId", "inputDigests", "outputDigests", "policyVersion", "authorizationEpoch", "capabilityGrantId"], properties: { idempotencyKey: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 }, projectId: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, actionId: { type: "string", minLength: 1 }, actionContractDigest: { type: "string", minLength: 1 }, verifierId: { type: "string", minLength: 1 }, verifierContractDigest: { type: "string", minLength: 1 }, projectRevisionId: { type: "string", minLength: 1 }, projectViewId: { type: "string", minLength: 1 }, changeRevisionId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 }, inputDigests: { type: "array", items: { type: "string" } }, outputDigests: { type: "array", items: { type: "string" } }, policyVersion: { type: "string", minLength: 1 }, authorizationEpoch: { type: "string", minLength: 1 }, capabilityGrantId: { type: "string", minLength: 1 } } } },
        { name: MCP_RUN_INSPECT_TOOL, description: "Inspect the credential-free status of one Run. Runner completion, Evidence, and Artifact acceptance remain separate authority operations.", inputSchema: { type: "object", additionalProperties: false, required: ["runId"], properties: { runId: { type: "string", minLength: 1 } } } },
      );
    }
    if (canRequestLanding) {
      tools.push({ name: LANDING_APPLY_COMMAND, description: "Apply one typed Change Revision through the Authority Landing boundary; source transfer and provider execution remain separate.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "changeId", "changeRevisionId", "expectedCanonicalProjectRevisionId"], properties: { idempotencyKey: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 }, projectId: { type: "string", minLength: 1 }, changeId: { type: "string", minLength: 1 }, changeRevisionId: { type: "string", minLength: 1 }, expectedCanonicalProjectRevisionId: { type: "string", minLength: 1 }, projectRevisionId: { type: "string", minLength: 1 }, landingId: { type: "string", minLength: 1 } } } });
    }
    if (canCreateRelease) {
      tools.push({ name: RELEASE_CREATE_COMMAND, description: "Create one typed Release from the exact canonical Project Revision, Artifacts, and passed Evidence; promotion remains separate.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "projectRevisionId", "artifactIds", "evidenceIds", "policyVersion"], properties: { idempotencyKey: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 }, projectId: { type: "string", minLength: 1 }, releaseId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, projectRevisionId: { type: "string", minLength: 1 }, artifactIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, evidenceIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, configurationDigests: { type: "array", items: { type: "string", minLength: 1 } }, stateAssumptions: { type: "array", items: { type: "string", minLength: 1 } }, policyVersion: { type: "string", minLength: 1 }, changeRevisionId: { type: "string", minLength: 1 }, provenanceDigest: { type: "string", minLength: 1 } } } });
    }
    if (canConfigureTarget) {
      tools.push({ name: TARGET_CONFIGURE_COMMAND, description: "Configure one Project-bound Target through Authority, including its credential-free environment, channel, and resource identity boundary; provider qualification and Promotion execution remain separate.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "name", "adapterId", "acceptedArtifactTypes"], properties: { idempotencyKey: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 }, projectId: { type: "string", minLength: 1 }, targetId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, adapterId: { type: "string", minLength: 1 }, acceptedArtifactTypes: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } }, requiredEvidenceKeys: { type: "array", items: { type: "string", minLength: 1 } }, deploymentProfile: { type: "object", additionalProperties: false, required: ["environment", "audience", "runtimeIdentity"], properties: { environment: { type: "string", enum: ["preview", "development", "staging", "production", "custom"] }, channel: { type: "string", enum: ["alpha", "beta", "stable", "custom"] }, audience: { type: "string", minLength: 1 }, runtimeIdentity: { type: "string", minLength: 1 }, routeIdentities: { type: "array", items: { type: "string", minLength: 1 } }, bindingIdentities: { type: "array", items: { type: "string", minLength: 1 } }, dataResourceIdentities: { type: "array", items: { type: "string", minLength: 1 } }, configurationDigests: { type: "array", items: { type: "string", minLength: 1 } }, secretUseAliases: { type: "array", items: { type: "string", minLength: 1 } }, dataClass: { type: "string", enum: ["synthetic", "isolated", "production-shaped", "production", "custom"] }, resourceSharing: { type: "string", enum: ["isolated", "owner-approved"] }, sharingPolicyDigest: { type: "string", minLength: 1 } } } } } });
    }
    if (canRequestPromotion) {
      tools.push({ name: PROMOTION_REQUEST_COMMAND, description: "Request a typed Promotion from one exact Release and Target; provider execution, health, rollback, and approval remain separate.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "releaseId", "targetId"], properties: { idempotencyKey: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 }, projectId: { type: "string", minLength: 1 }, promotionId: { type: "string", minLength: 1 }, releaseId: { type: "string", minLength: 1 }, targetId: { type: "string", minLength: 1 }, releaseDigest: { type: "string", minLength: 1 }, expectedCurrentReleaseId: { type: "string", minLength: 1 } } } });
    }
    return mcpJson({ jsonrpc: "2.0", id, result: { tools, receipt: "mcp=tools-listed; scope-filtered=true; typedCommands=explicit; canonicalWrite=false" } });
  }
  if (rpc.method === "tools/call") {
    let params: Record<string, unknown>;
    try {
      params = mcpParams(rpc.params);
    } catch {
      return mcpError(id, -32602, "tools/call params must be an object.", { code: "mcp.params_invalid", recoveryAction: "send an object containing name and arguments", receipt: "mcp=tool-call-invalid; canonicalWrite=false" });
    }
    const name = params.name;
    if (typeof name !== "string" || name.trim().length === 0) return mcpError(id, -32602, "tools/call requires a tool name.", { code: "mcp.tool_name_required", recoveryAction: "call one of the listed project.list or project.inspect tools", receipt: "mcp=tool-call-invalid; canonicalWrite=false" });
    const deliveryScope = MCP_DELIVERY_SCOPE_BY_TOOL[name];
    const isDeliveryTool = deliveryScope !== undefined;
    if (isDeliveryTool && delegatedAgent) return mcpError(id, -32601, `Tool ${name} is not available to delegated coding agents in v1.`, { code: "mcp.agent_delivery_not_supported", recoveryAction: "use the owner-created project-scoped delivery MCP resource or request the typed delivery operation through the human release workflow", receipt: `mcp=${name}; delegatedAgent=true; delivery=not-advertised; transition=not-applied; canonicalWrite=false` });
    if (isDeliveryTool && (!props.scopes.includes(deliveryScope) || !hasLiveGrant)) return mcpError(id, -32001, `The MCP grant does not include the live capability for ${name}.`, { code: "mcp.scope_denied", recoveryAction: `authorize ${deliveryScope} through a live OAuth grant and retry`, receipt: `oauth=validated; mcp=${name}; grant=${hasLiveGrant ? "present" : "missing"}; scope=${props.scopes.includes(deliveryScope) ? "present" : "missing"}; transition=not-applied; canonicalWrite=false` });
    const isProjectBootstrap = name === MCP_PROJECT_CREATE_TOOL;
    if (isProjectBootstrap && delegatedAgent) return mcpError(id, -32601, "Project creation is not available to delegated coding agents in v1.", { code: "mcp.agent_project_create_not_supported", recoveryAction: "create the Project through the owner surface before delegating a Workspace Task", receipt: "mcp=project.create; delegatedAgent=true; tool=not-advertised; transition=not-applied; canonicalWrite=false" });
    const isWorkspaceBootstrap = name === MCP_WORKSPACE_CREATE_TOOL;
    const isChangeBootstrap = name === MCP_CHANGE_CREATE_TOOL;
    const isProjectTool = name === MCP_READ_TOOL || name === MCP_LIST_TOOL || isProjectBootstrap;
    const isWorkspaceTool = name === MCP_WORKSPACE_READ_TOOL || name === MCP_WORKSPACE_LIST_TOOL || isWorkspaceBootstrap;
    const isRevisionPublish = name === MCP_CHANGE_REVISION_PUBLISH_TOOL;
    const isChangeTool = name === MCP_CHANGE_READ_TOOL || name === MCP_CHANGE_LIST_TOOL || isChangeBootstrap || isRevisionPublish;
    const isRunRequest = name === MCP_RUN_REQUEST_TOOL;
    const isRunInspect = name === MCP_RUN_INSPECT_TOOL;
    const isRunTool = isRunRequest || isRunInspect;
    if (LEGACY_RUN_MUTATION_TOOLS.has(name)) return mcpError(id, -32601, `Tool ${name} is no longer a caller-authoritative mutation.`, { code: "mcp.runner_completion_only", recoveryAction: "use run.request and run.inspect; an enrolled Runner must submit the signed completion before Evidence or Artifact acceptance", receipt: `mcp=${name}; completion=runner-only; transition=not-applied; canonicalWrite=false` });
    if (!isProjectTool && !isWorkspaceTool && !isChangeTool && !isRunTool && !isDeliveryTool) return mcpError(id, -32601, `Tool ${name} is not available.`, { code: "mcp.tool_not_found", recoveryAction: "call tools/list and use a scope-authorized Project, Workspace, Change, Run, or delivery tool", receipt: `mcp=tool-not-found; tool=${name}; canonicalWrite=false` });
    const requiredScope = isDeliveryTool ? deliveryScope : isProjectBootstrap ? MCP_PROJECT_WRITE_SCOPE : isWorkspaceBootstrap ? MCP_WORKSPACE_WRITE_SCOPE : isChangeBootstrap || isRevisionPublish ? MCP_CHANGE_WRITE_SCOPE : isRunTool ? MCP_RUN_SCOPE : isChangeTool ? MCP_CHANGE_SCOPE : isWorkspaceTool ? MCP_WORKSPACE_SCOPE : MCP_PROJECT_SCOPE;
    if (!props.scopes.includes(requiredScope)) return mcpError(id, -32001, `The MCP grant does not include ${requiredScope}.`, { code: "mcp.scope_denied", recoveryAction: `authorize the ${requiredScope} scope and retry`, receipt: `oauth=validated; mcp=scope-denied; required=${requiredScope}; tool=${name}; canonicalWrite=false` });
    try {
      const value = MCP_BOOTSTRAP_TOOLS.has(name)
        ? await mcpBootstrap(env, props, name as BootstrapMutation, params.arguments)
        : isRevisionPublish
        ? await mcpRevisionPublish(env, props, params.arguments)
        : isRunRequest
          ? await mcpRunRequest(env, props, params.arguments)
          : isRunInspect
            ? await mcpRunInspect(env, props, mcpRunId(params.arguments))
              : isDeliveryTool
                ? await mcpDeliveryMutation(env, props, name as McpDeliveryOperation, params.arguments)
        : name === MCP_LIST_TOOL
        ? await mcpProjectList(env, props, params.arguments)
        : name === MCP_READ_TOOL
          ? await mcpProjectInspect(env, props, mcpProjectId(params.arguments))
          : name === MCP_WORKSPACE_LIST_TOOL
            ? await mcpWorkspaceList(env, props, params.arguments)
            : name === MCP_WORKSPACE_READ_TOOL
              ? await mcpWorkspaceInspect(env, props, mcpWorkspaceId(params.arguments))
              : name === MCP_CHANGE_LIST_TOOL
                ? await mcpChangeList(env, props, params.arguments)
                : await mcpChangeInspect(env, props, mcpChangeId(params.arguments));
      return mcpJson({ jsonrpc: "2.0", id, result: mcpToolResult(value) });
    } catch (error) {
      if (error instanceof McpBootstrapError) {
        const code = error.kind === "auth" ? -32001 : error.kind === "not_found" ? -32004 : error.kind === "conflict" ? -32009 : error.kind === "invalid_request" ? -32602 : -32002;
        const errorCode = error.kind === "auth" ? "mcp.scope_denied" : error.kind === "not_found" ? "mcp.bootstrap_not_found" : error.kind === "conflict" ? "mcp.bootstrap_conflict" : error.kind === "invalid_request" ? "mcp.bootstrap_invalid" : "mcp.bootstrap_failed";
        return mcpError(id, code, error.message, { code: errorCode, recoveryAction: error.recoveryAction, receipt: error.receipt });
      }
      if (error instanceof RevisionPublishInputError) {
        const code = error.kind === "invalid_request" ? -32602 : error.kind === "auth" ? -32001 : error.kind === "not_found" ? -32004 : error.kind === "conflict" ? -32009 : -32002;
        return mcpError(id, code, error.message, { code: error.kind === "invalid_request" ? "mcp.revision_publish_invalid" : error.kind === "auth" ? "mcp.scope_denied" : error.kind === "not_found" ? "mcp.revision_publish_not_found" : error.kind === "conflict" ? "mcp.revision_publish_conflict" : "mcp.revision_publish_failed", recoveryAction: error.recoveryAction, receipt: error.receipt });
      }
      if (error instanceof RunEvidenceInputError) {
        const code = error.kind === "auth" ? -32001 : error.kind === "not_found" ? -32004 : error.kind === "conflict" ? -32009 : error.kind === "invalid_request" ? -32602 : -32002;
        const operation = isRunRequest ? RUN_REQUEST_COMMAND : "run.inspect";
        return mcpError(id, code, error.message, { code: error.kind === "invalid_request" ? `mcp.${operation.replace(".", "_")}_invalid` : error.kind === "auth" ? "mcp.scope_denied" : error.kind === "not_found" ? `mcp.${operation.replace(".", "_")}_not_found` : error.kind === "conflict" ? `mcp.${operation.replace(".", "_")}_conflict` : `mcp.${operation.replace(".", "_")}_failed`, recoveryAction: error.recoveryAction, receipt: error.receipt });
      }
      if (error instanceof McpDeliveryError) {
        const code = error.kind === "auth" ? -32001 : error.kind === "not_found" ? -32004 : error.kind === "conflict" ? -32009 : error.kind === "invalid_request" ? -32602 : -32002;
        const errorCode = error.kind === "invalid_request" ? `mcp.${name.replace(".", "_")}_invalid` : error.kind === "auth" ? "mcp.scope_denied" : error.kind === "not_found" ? `mcp.${name.replace(".", "_")}_not_found` : error.kind === "conflict" ? `mcp.${name.replace(".", "_")}_conflict` : `mcp.${name.replace(".", "_")}_failed`;
        return mcpError(id, code, error.message, { code: errorCode, recoveryAction: error.recoveryAction, receipt: error.receipt });
      }
      const detail = error instanceof Error ? error.message : "mcp_tool_call_failed";
      const notFound = detail.includes("not_found");
      const errorClass = notFound ? "not_found" : detail.includes("session.") || detail.includes("session_") ? "session_rejected" : "coordinator_rejected";
      const isWorkspace = isWorkspaceTool;
      const isChange = isChangeTool;
      const isRun = isRunTool;
      const isDelivery = isDeliveryTool;
      const isList = name === MCP_LIST_TOOL || name === MCP_WORKSPACE_LIST_TOOL;
      const operation = isDelivery ? name : isRun ? (isRunRequest ? RUN_REQUEST_COMMAND : "run.inspect") : isChange ? (name === MCP_CHANGE_LIST_TOOL ? "change.list" : name === MCP_CHANGE_READ_TOOL ? "change.inspect" : "revision.publish") : isWorkspace ? (isList ? "workspace.list" : "workspace.inspect") : (isList ? "project.list" : "project.inspect");
      const resource = isDelivery ? "Delivery" : isRun ? "Run" : isChange ? "Change" : isWorkspace ? "Workspace" : "Project";
      return mcpError(id, notFound ? -32004 : -32602, notFound ? `${resource} is not available in this Realm.` : `${operation} arguments are invalid or the coordinator rejected the read.`, { code: notFound ? `mcp.${resource.toLowerCase()}_not_found` : `mcp.${resource.toLowerCase()}_read_failed`, recoveryAction: notFound ? `verify the ${resource} identifier without probing undiscoverable resources` : "inspect the coordinator receipt and retry the same read", receipt: `mcp=${operation}; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` });
    }
  }
  return mcpError(id, -32601, `Method ${rpc.method} is not available.`, { code: "mcp.method_not_found", recoveryAction: "use initialize, tools/list, or tools/call", receipt: `mcp=method-not-found; method=${rpc.method}; canonicalWrite=false` });
}
