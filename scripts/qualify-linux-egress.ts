type Json = Record<string, unknown>;

const protocol = "anyam.linux-egress-qualification/v1" as const;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function object(value: unknown, label: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} was not a JSON object`);
  return value as Json;
}

async function runCase(input: { url: string; token: string; taskId: string; workspaceId: string; runId: string; network: readonly string[]; command: string; expectedHttp: number; expectedStatus: string }): Promise<Json> {
  const response = await fetch(`${input.url.replace(/\/$/u, "")}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
    body: JSON.stringify({ protocol: "anyam.workspace-egress/v1", taskId: input.taskId, workspaceId: input.workspaceId, runId: input.runId, network: input.network, command: input.command }),
  });
  const body = object(await response.json().catch(() => ({})), "Sandbox egress response");
  if (response.status !== input.expectedHttp || body.status !== input.expectedStatus) throw new Error(`case ${input.runId} returned HTTP ${response.status}/${String(body.status)}; expected HTTP ${input.expectedHttp}/${input.expectedStatus}; message=${String(body.message ?? "not-provided")}; receipt=${String(body.receipt ?? "not-provided")}`);
  if (JSON.stringify(body).includes(input.token)) throw new Error(`case ${input.runId} returned control credential material`);
  return body;
}

function probeCommand(host: string): string {
  const script = `fetch(${JSON.stringify(`https://${host}/`)}).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(2))`;
  return `node -e ${JSON.stringify(script)}`;
}

async function main(): Promise<void> {
  const url = required("ANYAM_LINUX_EGRESS_URL");
  const token = required("ANYAM_LINUX_EGRESS_CONTROL_TOKEN");
  const allowHost = process.env.ANYAM_LINUX_EGRESS_ALLOW_HOST?.trim() || "example.com";
  const deniedHost = process.env.ANYAM_LINUX_EGRESS_DENIED_HOST?.trim() || "example.org";
  const taskId = `task:linux-egress:${crypto.randomUUID()}`;
  const workspaceId = `workspace:linux-egress:${crypto.randomUUID()}`;
  const allow = await runCase({ url, token, taskId, workspaceId, runId: `run:allow:${crypto.randomUUID()}`, network: [allowHost], command: probeCommand(allowHost), expectedHttp: 200, expectedStatus: "succeeded" });
  const denied = await runCase({ url, token, taskId, workspaceId, runId: `run:denied:${crypto.randomUUID()}`, network: [allowHost], command: probeCommand(deniedHost), expectedHttp: 409, expectedStatus: "failed" });
  const denyAll = await runCase({ url, token, taskId, workspaceId, runId: `run:deny-all:${crypto.randomUUID()}`, network: [], command: probeCommand(allowHost), expectedHttp: 409, expectedStatus: "failed" });
  console.log(JSON.stringify({ protocol, status: "succeeded", taskId, workspaceId, cases: { allowlisted: { status: allow.status, networkBoundaryReceipt: allow.networkBoundaryReceipt }, denied: { status: denied.status, networkBoundaryReceipt: denied.networkBoundaryReceipt }, denyAll: { status: denyAll.status, networkBoundaryReceipt: denyAll.networkBoundaryReceipt } }, credentialValues: "not-printed", canonicalWrite: false, providerFactsAreNotAnyamLimits: true, cleanup: "per-Run Sandbox destroyed by boundary Worker" }, null, 2));
}

try {
  await main();
} catch (error) {
  console.log(JSON.stringify({ protocol, status: "blocked", error: error instanceof Error ? error.message : String(error), credentialValues: "not-printed", recoveryAction: "deploy the customer-owned Sandbox boundary, set its control credential, and rerun the same bounded qualification", receipt: "networkEnforcement=cloudflare-sandbox; providerReceipt=not-established; canonicalWrite=false" }, null, 2));
  process.exitCode = 2;
}
