/// <reference types="@cloudflare/workers-types" />

import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox";

export { ContainerProxy };

const PROTOCOL = "anyam.workspace-egress/v1" as const;
const NETWORK_ENFORCEMENT = "cloudflare-sandbox" as const;
const COMMAND_MAX_BYTES = 16_384;
const EGRESS_POLICY_RECEIPT = "policy=workspace-egress/v1; commandMaxBytes=16384; sizing=qualification-tripwire; remeasure-before-production";

type JsonObject = Record<string, unknown>;

type Env = {
  SANDBOX: DurableObjectNamespace<AnyamEgressSandbox>;
  ANYAM_EGRESS_CONTROL_TOKEN?: string;
  ANYAM_EGRESS_PROTOCOL?: string;
};

type EgressRequest = {
  protocol: typeof PROTOCOL;
  taskId: string;
  workspaceId: string;
  runId: string;
  network: readonly string[];
  command: string;
};

export class AnyamEgressSandbox extends Sandbox<Env> {
  defaultPort = undefined;
  requiredPorts = [];
  enableInternet = false;
  interceptHttps = true;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function hosts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("network must be a string array");
  return [...new Set(value.map((item) => requiredString(item, "network host")).map((host) => host.toLowerCase()).map((host) => {
    if (host === "*" || host.includes("/") || host.includes(":") || host.includes(" ") || host.includes("\n") || host.includes("\r")) throw new Error(`network host ${JSON.stringify(host)} must be a concrete hostname`);
    return host;
  }))];
}

function bodyObject(value: unknown): JsonObject {
  if (!isRecord(value)) throw new Error("request body must be a JSON object");
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) result |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  return result === 0;
}

function authorized(request: Request, env: Env): boolean {
  const configured = env.ANYAM_EGRESS_CONTROL_TOKEN?.trim();
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/u, "").trim();
  return Boolean(configured && presented && constantTimeEqual(configured, presented));
}

function safeCommand(command: string): string {
  if (new TextEncoder().encode(command).byteLength > COMMAND_MAX_BYTES) throw new Error(`command exceeds the egress qualification command tripwire; limit=${COMMAND_MAX_BYTES}bytes; asked=command-bytes`);
  if (command.includes("\0")) throw new Error("command contains a NUL byte");
  return command;
}

async function run(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ protocol: PROTOCOL, status: "blocked", code: "unauthorized", recoveryAction: "use the customer-owned egress control credential", receipt: "control=unauthorized; sandbox=not-started; credentialMaterialStored=false" }, 401);
  let body: JsonObject;
  try {
    body = bodyObject(await request.json());
  } catch (error) {
    return json({ protocol: PROTOCOL, status: "blocked", code: "invalid-request", message: error instanceof Error ? error.message : String(error), recoveryAction: "send a typed egress request", receipt: "request=invalid; sandbox=not-started; credentialMaterialStored=false" }, 422);
  }
  try {
    const input: EgressRequest = {
      protocol: requiredString(body.protocol, "protocol") as typeof PROTOCOL,
      taskId: requiredString(body.taskId, "taskId"),
      workspaceId: requiredString(body.workspaceId, "workspaceId"),
      runId: requiredString(body.runId, "runId"),
      network: hosts(body.network),
      command: safeCommand(requiredString(body.command, "command")),
    };
    if (input.protocol !== PROTOCOL) throw new Error(`protocol must be ${PROTOCOL}`);
    const sandbox = getSandbox(env.SANDBOX, input.runId);
    let cleanup = "not-attempted";
    let result: Awaited<ReturnType<typeof sandbox.exec>>;
    try {
      await sandbox.setAllowedHosts([...input.network]);
      result = await sandbox.exec(input.command, { origin: "user" });
    } finally {
      try {
        await sandbox.destroy();
        cleanup = "destroyed";
      } catch {
        cleanup = "unverified";
      }
    }
    return json({
      protocol: PROTOCOL,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      output: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      network: input.network,
      networkEnforcement: NETWORK_ENFORCEMENT,
      networkBoundaryReceipt: `${EGRESS_POLICY_RECEIPT}; networkEnforcement=${NETWORK_ENFORCEMENT}; enableInternet=false; allowedHosts=${input.network.join(",") || "none"}; task=${input.taskId}; workspace=${input.workspaceId}; run=${input.runId}; cleanup=${cleanup}; credentialMaterialStored=false`,
      canonicalWrite: false,
    }, result.exitCode === 0 ? 200 : 409);
  } catch (error) {
    return json({ protocol: PROTOCOL, status: "blocked", code: "sandbox-boundary-failed", message: error instanceof Error ? error.message : String(error), recoveryAction: "inspect the Sandbox provider receipt and retry the same Run only after the egress boundary is available", receipt: `${EGRESS_POLICY_RECEIPT}; networkEnforcement=${NETWORK_ENFORCEMENT}; sandbox=unavailable; providerMutation=false; credentialMaterialStored=false` }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run") return json({ protocol: PROTOCOL, status: "blocked", code: "not-found", recoveryAction: "send POST /run through the customer-owned egress control path", receipt: "operation=not-found; sandbox=not-started" }, 404);
    return run(request, env);
  },
};
