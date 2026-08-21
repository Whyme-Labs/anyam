import assert from "node:assert/strict";
import test from "node:test";

import { createCloudflareSandboxEgressClient } from "../src/execution/cloudflare-sandbox-egress.ts";

test("Cloudflare Sandbox egress client binds exact Task, Workspace, Run, and allowlist without returning its control credential", async () => {
  let observed: Record<string, unknown> | undefined;
  const client = createCloudflareSandboxEgressClient({
    controlToken: "control-token-never-returned",
    fetcher: async (request) => {
      assert.equal(request.url, "https://anyam-sandbox-egress/run");
      assert.equal(request.headers.get("authorization"), "Bearer control-token-never-returned");
      observed = await request.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ protocol: "anyam.workspace-egress/v1", status: "succeeded", taskId: "task:one", workspaceId: "workspace:one", runId: "run:one", network: ["example.com"], networkEnforcement: "cloudflare-sandbox", networkBoundaryReceipt: "networkEnforcement=cloudflare-sandbox; allowedHosts=example.com; task=task:one; workspace=workspace:one; run=run:one; cleanup=destroyed", output: { stdout: "ok", stderr: "", exitCode: 0 }, receipt: "credentialMaterialStored=false", canonicalWrite: false }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.execute({ taskId: "task:one", workspaceId: "workspace:one", runId: "run:one", network: ["example.com"], command: "node probe" });
  assert.deepEqual(observed, { protocol: "anyam.workspace-egress/v1", taskId: "task:one", workspaceId: "workspace:one", runId: "run:one", network: ["example.com"], command: "node probe" });
  assert.equal(result.networkEnforcement, "cloudflare-sandbox");
  assert.equal(JSON.stringify(result).includes("control-token-never-returned"), false);
});

test("Cloudflare Sandbox egress client fails closed when the boundary response omits enforcement", async () => {
  const client = createCloudflareSandboxEgressClient({
    controlToken: "control-token",
    fetcher: async () => new Response(JSON.stringify({ protocol: "anyam.workspace-egress/v1", status: "succeeded", taskId: "task:one", workspaceId: "workspace:one", runId: "run:one", network: [], output: { stdout: "", stderr: "", exitCode: 0 }, receipt: "not-enough", canonicalWrite: false }), { status: 200 }),
  });
  await assert.rejects(client.execute({ taskId: "task:one", workspaceId: "workspace:one", runId: "run:one", network: [], command: "true" }), /cloudflare-sandbox enforcement/);
});
