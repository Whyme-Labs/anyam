import { REALM_COORDINATOR_INTERNAL_HEADER, REALM_COORDINATOR_INTERNAL_VALUE } from "./coordinator-protocol.ts";

export const ANYAM_MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const ANYAM_MCP_PROTOCOL = "anyam.remote-mcp/v1" as const;
const MCP_READ_SCOPE = "project.read";
const MCP_READ_TOOL = "project.inspect";
const MCP_MUTATION_TOOLS = new Set(["workspace.create", "change.create", "change.publish_revision", "landing.apply", "promotion.request"]);

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

/**
 * Project-scoped remote MCP control surface. OAuthProvider has already
 * validated the bearer token, audience, and encrypted grant properties before
 * this function runs. The handler only reads a project summary through the
 * Realm Coordinator; source transfer and all mutations stay on their own
 * authority boundaries.
 */
export async function handleAnyamRealmMcpRequest(request: Request, env: AnyamRealmMcpEnv, props: AnyamRealmMcpProps): Promise<Response> {
  if (!props.scopes.includes(MCP_READ_SCOPE)) return mcpError(null, -32001, "The MCP grant does not include project.read.", { code: "mcp.scope_denied", recoveryAction: "authorize the project.read scope and retry", receipt: "oauth=validated; mcp=scope-denied; canonicalWrite=false" });
  if (request.method !== "POST") return mcpJson({ code: "method_not_allowed", recoveryAction: "Use POST with a JSON-RPC 2.0 request for the project-scoped MCP surface.", receipt: "mcp=read-only; method=post-required; canonicalWrite=false" }, 405);

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
    return mcpJson({ jsonrpc: "2.0", id, result: { tools: [{ name: MCP_READ_TOOL, description: "Inspect one project summary through the authenticated Realm Coordinator.", inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string", minLength: 1 } } } }], receipt: "mcp=tools-listed; tools=read-only; canonicalWrite=false" } });
  }
  if (rpc.method === "tools/call") {
    let params: Record<string, unknown>;
    try {
      params = mcpParams(rpc.params);
    } catch {
      return mcpError(id, -32602, "tools/call params must be an object.", { code: "mcp.params_invalid", recoveryAction: "send an object containing name and arguments", receipt: "mcp=tool-call-invalid; canonicalWrite=false" });
    }
    const name = params.name;
    if (typeof name !== "string" || name.trim().length === 0) return mcpError(id, -32602, "tools/call requires a tool name.", { code: "mcp.tool_name_required", recoveryAction: "call the listed project.inspect tool", receipt: "mcp=tool-call-invalid; canonicalWrite=false" });
    if (MCP_MUTATION_TOOLS.has(name)) return mcpError(id, -32003, `Tool ${name} is not available on the read-only MCP surface.`, { code: "mcp.mutation_denied", recoveryAction: "use the qualified Authority or future task-grant surface; this token cannot write canonical state", receipt: `mcp=read-only; tool=${name}; canonicalWrite=false` });
    if (name !== MCP_READ_TOOL) return mcpError(id, -32601, `Tool ${name} is not available.`, { code: "mcp.tool_not_found", recoveryAction: "call tools/list and use project.inspect", receipt: `mcp=tool-not-found; tool=${name}; canonicalWrite=false` });
    try {
      const value = await mcpProjectInspect(env, props, mcpProjectId(params.arguments));
      return mcpJson({ jsonrpc: "2.0", id, result: mcpToolResult(value) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "mcp_project_inspect_failed";
      const notFound = detail.includes("not_found");
      return mcpError(id, notFound ? -32004 : -32602, notFound ? "Project is not available in this Realm." : "project.inspect arguments are invalid or the coordinator rejected the read.", { code: notFound ? "mcp.project_not_found" : "mcp.project_inspect_failed", recoveryAction: notFound ? "verify the Project identifier without probing undiscoverable resources" : "inspect the coordinator receipt and retry the same read", receipt: `mcp=project.inspect; detail=${detail}; credentialFree=true; canonicalWrite=false` });
    }
  }
  return mcpError(id, -32601, `Method ${rpc.method} is not available.`, { code: "mcp.method_not_found", recoveryAction: "use initialize, tools/list, or tools/call", receipt: `mcp=method-not-found; method=${rpc.method}; canonicalWrite=false` });
}
