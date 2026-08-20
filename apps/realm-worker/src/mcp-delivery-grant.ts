import type { ResourceRef } from "../../../src/kernel/contracts.ts";

export const MCP_DELIVERY_SCOPE_BY_OPERATION = {
  "landing.apply": "landing.request",
  "release.create": "release.create",
  "target.configure": "target.configure",
  "promotion.request": "promotion.request",
} as const;

export type McpDeliveryOperation = keyof typeof MCP_DELIVERY_SCOPE_BY_OPERATION;
export type McpDeliveryScope = (typeof MCP_DELIVERY_SCOPE_BY_OPERATION)[McpDeliveryOperation];
export const MCP_DELIVERY_OPERATIONS = Object.keys(MCP_DELIVERY_SCOPE_BY_OPERATION) as McpDeliveryOperation[];

export type McpDeliveryBinding = {
  readonly resource: string;
  readonly resourcePath: string;
  readonly resourceRef: ResourceRef;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly changeId?: string;
  readonly sourceSpaceIds: readonly string[];
  readonly agentId?: string;
  readonly agentSessionId?: string;
  readonly taskId?: string;
  readonly capabilityGrantId?: string;
};

function safePathIdentifier(value: string): string | undefined {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) return undefined;
  return value;
}

/**
 * Parse the resource indicator used by a delivery-capable MCP grant.
 *
 * A bare `/mcp` resource is deliberately not a delivery binding. Delivery
 * needs a project boundary and may optionally narrow to one Workspace or
 * Change. Source Spaces are disclosed as repeated `sourceSpaceId` query
 * parameters; the coordinator verifies them against the live Project.
 */
export function parseMcpDeliveryBinding(value: unknown, realmId: string): McpDeliveryBinding | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return "";
    }
  });
  const mcpIndex = segments.indexOf("mcp");
  if (mcpIndex < 0 || segments[mcpIndex + 1] !== "projects") return undefined;
  const projectId = safePathIdentifier(segments[mcpIndex + 2] ?? "");
  if (!projectId) return undefined;
  const tail = segments.slice(mcpIndex + 3);
  let workspaceId: string | undefined;
  let changeId: string | undefined;
  if (tail.length > 0) {
    if (tail[0] === "workspaces") {
      workspaceId = safePathIdentifier(tail[1] ?? "");
      if (!workspaceId) return undefined;
      if (tail.length > 2) {
        if (tail[2] !== "changes" || tail.length !== 4) return undefined;
        changeId = safePathIdentifier(tail[3] ?? "");
        if (!changeId) return undefined;
      }
    } else if (tail[0] === "changes" && tail.length === 2) {
      changeId = safePathIdentifier(tail[1] ?? "");
      if (!changeId) return undefined;
    } else {
      return undefined;
    }
  }
  const sourceSpaceIds = [...new Set(parsed.searchParams.getAll("sourceSpaceId").map((entry) => entry.trim()))];
  if (sourceSpaceIds.some((entry) => !safePathIdentifier(entry))) return undefined;
  const agentId = parsed.searchParams.get("agentId")?.trim() || undefined;
  const agentSessionId = parsed.searchParams.get("agentSessionId")?.trim() || undefined;
  const taskId = parsed.searchParams.get("taskId")?.trim() || undefined;
  const capabilityGrantId = parsed.searchParams.get("capabilityGrantId")?.trim() || undefined;
  const delegatedValues = [agentId, agentSessionId, taskId, capabilityGrantId];
  if (delegatedValues.some((entry) => entry !== undefined && !safePathIdentifier(entry))) return undefined;
  if (delegatedValues.some((entry) => entry !== undefined) && delegatedValues.some((entry) => entry === undefined)) return undefined;
  const resourceRef: ResourceRef = {
    realmId,
    projectId,
    ...(sourceSpaceIds.length === 1 ? { sourceSpaceId: sourceSpaceIds[0] } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(changeId ? { changeId } : {}),
  };
  return {
    resource: value.trim(),
    resourcePath: parsed.pathname,
    resourceRef,
    projectId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(changeId ? { changeId } : {}),
    sourceSpaceIds,
    ...(agentId ? { agentId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(capabilityGrantId ? { capabilityGrantId } : {}),
  };
}

export function isMcpDeliveryOperation(value: string): value is McpDeliveryOperation {
  return Object.prototype.hasOwnProperty.call(MCP_DELIVERY_SCOPE_BY_OPERATION, value);
}

export function mcpDeliveryScope(operation: McpDeliveryOperation): McpDeliveryScope;
export function mcpDeliveryScope(operation: string): McpDeliveryScope | undefined;
export function mcpDeliveryScope(operation: string): McpDeliveryScope | undefined {
  return isMcpDeliveryOperation(operation) ? MCP_DELIVERY_SCOPE_BY_OPERATION[operation] : undefined;
}
