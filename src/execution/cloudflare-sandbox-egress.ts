export const WORKSPACE_EGRESS_PROTOCOL = "anyam.workspace-egress/v1" as const;
export const CLOUDFLARE_SANDBOX_NETWORK_ENFORCEMENT = "cloudflare-sandbox" as const;

export type CloudflareSandboxEgressRequest = {
  taskId: string;
  workspaceId: string;
  runId: string;
  network: readonly string[];
  command: string;
};

export type CloudflareSandboxEgressResult = {
  protocol: typeof WORKSPACE_EGRESS_PROTOCOL;
  status: "succeeded" | "failed" | "blocked";
  output?: { stdout: string; stderr: string; exitCode: number };
  taskId: string;
  workspaceId: string;
  runId: string;
  network: readonly string[];
  networkEnforcement: typeof CLOUDFLARE_SANDBOX_NETWORK_ENFORCEMENT;
  networkBoundaryReceipt: string;
  recoveryAction?: string;
  receipt: string;
  canonicalWrite: false;
};

export type CloudflareSandboxEgressClient = {
  execute(input: CloudflareSandboxEgressRequest): Promise<CloudflareSandboxEgressResult>;
};

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Sandbox egress response must be an object");
  return value as Record<string, unknown>;
}

function safeResponseBody(value: Record<string, unknown>, httpStatus: number): CloudflareSandboxEgressResult {
  const protocol = nonEmpty(value.protocol, "response.protocol");
  if (protocol !== WORKSPACE_EGRESS_PROTOCOL) throw new Error(`Sandbox egress response protocol must be ${WORKSPACE_EGRESS_PROTOCOL}`);
  const state = value.status;
  if (state !== "succeeded" && state !== "failed" && state !== "blocked") throw new Error("Sandbox egress response status is invalid");
  const resultStatus: CloudflareSandboxEgressResult["status"] = state;
  const result = {
    protocol: WORKSPACE_EGRESS_PROTOCOL,
    status: resultStatus,
    taskId: nonEmpty(value.taskId, "response.taskId"),
    workspaceId: nonEmpty(value.workspaceId, "response.workspaceId"),
    runId: nonEmpty(value.runId, "response.runId"),
    network: Array.isArray(value.network) ? value.network.filter((host): host is string => typeof host === "string") : [],
    networkEnforcement: value.networkEnforcement === CLOUDFLARE_SANDBOX_NETWORK_ENFORCEMENT ? CLOUDFLARE_SANDBOX_NETWORK_ENFORCEMENT : (() => { throw new Error("Sandbox egress response omitted cloudflare-sandbox enforcement"); })(),
    networkBoundaryReceipt: nonEmpty(value.networkBoundaryReceipt, "response.networkBoundaryReceipt"),
    ...(typeof value.recoveryAction === "string" ? { recoveryAction: value.recoveryAction } : {}),
    receipt: typeof value.receipt === "string" && value.receipt.trim().length > 0 ? value.receipt : `sandboxHttpStatus=${httpStatus}; networkEnforcement=${CLOUDFLARE_SANDBOX_NETWORK_ENFORCEMENT}`,
    canonicalWrite: false as const,
  };
  if (result.status === "succeeded" || result.status === "failed") {
    const output = object(value.output);
    const exitCode = output.exitCode;
    if (typeof output.stdout !== "string" || typeof output.stderr !== "string" || typeof exitCode !== "number" || !Number.isInteger(exitCode)) throw new Error("Sandbox egress response output is incomplete");
    return { ...result, output: { stdout: output.stdout, stderr: output.stderr, exitCode } };
  }
  return result;
}

/**
 * Customer-owned service-binding client. The bearer is used only in the
 * request and is never returned in Anyam state, receipts, or Runner results.
 */
export function createCloudflareSandboxEgressClient(input: { fetcher: (request: Request) => Promise<Response>; controlToken: string }): CloudflareSandboxEgressClient {
  const controlToken = nonEmpty(input.controlToken, "controlToken");
  return {
    async execute(requestInput) {
      const response = await input.fetcher(new Request("https://anyam-sandbox-egress/run", {
        method: "POST",
        headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
        body: JSON.stringify({ protocol: WORKSPACE_EGRESS_PROTOCOL, ...requestInput }),
      }));
      const value = object(await response.json().catch(() => ({})));
      return safeResponseBody(value, response.status);
    },
  };
}
