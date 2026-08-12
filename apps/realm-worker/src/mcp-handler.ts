import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "./coordinator-protocol.ts";
import { bootstrapCommand, bootstrapPath, projectBootstrapValue, type BootstrapMutation } from "./bootstrap-contract.ts";

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
const MCP_BOOTSTRAP_TOOLS = new Set([MCP_PROJECT_CREATE_TOOL, MCP_WORKSPACE_CREATE_TOOL, MCP_CHANGE_CREATE_TOOL]);
const MCP_MUTATION_TOOLS = new Set(["change.publish_revision", "landing.apply", "promotion.request"]);

export type AnyamRealmMcpProps = {
  readonly scopes: readonly string[];
  readonly kernelSessionId?: string;
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
    result = await requestMcpCoordinator(env, "/authority/command/internal", { protocol: "anyam.authority-command/v1", command: command.command, idempotencyKey, ...(command.expectedVersion === undefined ? {} : { expectedVersion: command.expectedVersion }), payload: command.payload, sessionId: props.kernelSessionId });
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

/**
 * Realm-scoped remote MCP control surface. OAuthProvider has already
 * validated the bearer token, audience, and encrypted grant properties before
 * this function runs. The handler only reads safe Project, Workspace, and
 * Change summaries through the Realm Coordinator; source transfer and all
 * mutations stay on their own authority boundaries.
 */
export async function handleAnyamRealmMcpRequest(request: Request, env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps): Promise<Response> {
  const canReadProjects = props.scopes.includes(MCP_PROJECT_SCOPE);
  const canReadWorkspaces = props.scopes.includes(MCP_WORKSPACE_SCOPE);
  const canReadChanges = props.scopes.includes(MCP_CHANGE_SCOPE);
  const canWriteProjects = props.scopes.includes(MCP_PROJECT_WRITE_SCOPE);
  const canWriteWorkspaces = props.scopes.includes(MCP_WORKSPACE_WRITE_SCOPE);
  const canWriteChanges = props.scopes.includes(MCP_CHANGE_WRITE_SCOPE);
  if (!canReadProjects && !canReadWorkspaces && !canReadChanges && !canWriteProjects && !canWriteWorkspaces && !canWriteChanges) return mcpError(null, -32001, "The MCP grant does not include a supported Project, Workspace, or Change scope.", { code: "mcp.scope_denied", recoveryAction: "authorize a documented read scope or the explicit write scope for the typed bootstrap tool you need", receipt: "oauth=validated; mcp=scope-denied; required=project.read|project.write|workspace.inspect|workspace.write|change.inspect|change.write; canonicalWrite=false" });
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
    if (canWriteProjects) {
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
      tools.push({ name: MCP_CHANGE_CREATE_TOOL, description: "Create a Change through the authenticated Coordinator using a typed, idempotent bootstrap command.", inputSchema: { type: "object", additionalProperties: false, required: ["idempotencyKey", "projectId", "intentId"], properties: { idempotencyKey: { type: "string", minLength: 1 }, projectId: { type: "string", minLength: 1 }, changeId: { type: "string", minLength: 1 }, intentId: { type: "string", minLength: 1 }, baseProjectRevisionId: { type: "string", minLength: 1 }, workspaceId: { type: "string", minLength: 1 }, expectedVersion: { type: "integer", minimum: 0 } } } });
    }
    return mcpJson({ jsonrpc: "2.0", id, result: { tools, receipt: "mcp=tools-listed; scope-filtered=true; typedBootstrap=explicit; canonicalWrite=false" } });
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
    if (MCP_MUTATION_TOOLS.has(name)) return mcpError(id, -32003, `Tool ${name} is not available on this MCP surface.`, { code: "mcp.mutation_denied", recoveryAction: "use the qualified Authority or a future task-grant surface; this MCP token cannot publish revisions, land, or promote", receipt: `mcp=mutation-denied; tool=${name}; canonicalWrite=false` });
    const isProjectBootstrap = name === MCP_PROJECT_CREATE_TOOL;
    const isWorkspaceBootstrap = name === MCP_WORKSPACE_CREATE_TOOL;
    const isChangeBootstrap = name === MCP_CHANGE_CREATE_TOOL;
    const isProjectTool = name === MCP_READ_TOOL || name === MCP_LIST_TOOL || isProjectBootstrap;
    const isWorkspaceTool = name === MCP_WORKSPACE_READ_TOOL || name === MCP_WORKSPACE_LIST_TOOL || isWorkspaceBootstrap;
    const isChangeTool = name === MCP_CHANGE_READ_TOOL || name === MCP_CHANGE_LIST_TOOL || isChangeBootstrap;
    if (!isProjectTool && !isWorkspaceTool && !isChangeTool) return mcpError(id, -32601, `Tool ${name} is not available.`, { code: "mcp.tool_not_found", recoveryAction: "call tools/list and use a scope-authorized Project, Workspace, or Change tool", receipt: `mcp=tool-not-found; tool=${name}; canonicalWrite=false` });
    const requiredScope = isProjectBootstrap ? MCP_PROJECT_WRITE_SCOPE : isWorkspaceBootstrap ? MCP_WORKSPACE_WRITE_SCOPE : isChangeBootstrap ? MCP_CHANGE_WRITE_SCOPE : isChangeTool ? MCP_CHANGE_SCOPE : isWorkspaceTool ? MCP_WORKSPACE_SCOPE : MCP_PROJECT_SCOPE;
    if (!props.scopes.includes(requiredScope)) return mcpError(id, -32001, `The MCP grant does not include ${requiredScope}.`, { code: "mcp.scope_denied", recoveryAction: `authorize the ${requiredScope} scope and retry`, receipt: `oauth=validated; mcp=scope-denied; required=${requiredScope}; tool=${name}; canonicalWrite=false` });
    try {
      const value = MCP_BOOTSTRAP_TOOLS.has(name)
        ? await mcpBootstrap(env, props, name as BootstrapMutation, params.arguments)
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
      const detail = error instanceof Error ? error.message : "mcp_tool_call_failed";
      const notFound = detail.includes("not_found");
      const errorClass = notFound ? "not_found" : detail.includes("session.") || detail.includes("session_") ? "session_rejected" : "coordinator_rejected";
      const isWorkspace = isWorkspaceTool;
      const isChange = isChangeTool;
      const isList = name === MCP_LIST_TOOL || name === MCP_WORKSPACE_LIST_TOOL;
      const operation = isChange ? (name === MCP_CHANGE_LIST_TOOL ? "change.list" : "change.inspect") : isWorkspace ? (isList ? "workspace.list" : "workspace.inspect") : (isList ? "project.list" : "project.inspect");
      const resource = isChange ? "Change" : isWorkspace ? "Workspace" : "Project";
      return mcpError(id, notFound ? -32004 : -32602, notFound ? `${resource} is not available in this Realm.` : `${operation} arguments are invalid or the coordinator rejected the read.`, { code: notFound ? `mcp.${resource.toLowerCase()}_not_found` : `mcp.${resource.toLowerCase()}_read_failed`, recoveryAction: notFound ? `verify the ${resource} identifier without probing undiscoverable resources` : "inspect the coordinator receipt and retry the same read", receipt: `mcp=${operation}; errorClass=${errorClass}; credentialFree=true; canonicalWrite=false` });
    }
  }
  return mcpError(id, -32601, `Method ${rpc.method} is not available.`, { code: "mcp.method_not_found", recoveryAction: "use initialize, tools/list, or tools/call", receipt: `mcp=method-not-found; method=${rpc.method}; canonicalWrite=false` });
}
