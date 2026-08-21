import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspaceBoundary, LINUX_BWRAP_CONTAINMENT_RECEIPT, removeWorkspaceBoundary, runWorkspaceCommand } from "../packages/create-anyam/src/workspace-boundary.ts";

const protocol = "anyam.linux-workspace-qualification/v1" as const;
const root = await mkdtemp(join(tmpdir(), "anyam-linux-workspace-qualification-"));
const sourceDirectory = process.env.GITHUB_WORKSPACE ?? process.cwd();
const stateDirectory = join(root, "state");
const workspaceDirectory = join(root, "workspace");

let boundary: Awaited<ReturnType<typeof createWorkspaceBoundary>> | undefined;
let receipt: Record<string, unknown> | undefined;
let failure: unknown;
try {
  await mkdir(stateDirectory, { recursive: true });
  boundary = await createWorkspaceBoundary({
    sourceDirectory,
    stateDirectory,
    projectId: "project:linux-workspace-qualification",
    changeId: "change:linux-workspace-qualification",
    workspaceId: "workspace:linux-workspace-qualification",
    mode: "enforceable",
    network: [],
    workspaceDirectory,
  });
  const result = await runWorkspaceCommand({
    boundary,
    shell: true,
    protectGitMetadata: true,
    command: "node -e \"const fs=require('node:fs');let blocked=false;try{fs.appendFileSync('.git/config','\\n# hostile-action\\n')}catch{blocked=true}const pidIsolated=process.ppid===1;fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/worker.bundle',JSON.stringify({pidIsolated,proc1:fs.readFileSync('/proc/1/comm','utf8').trim()}));if(!blocked||!pidIsolated)process.exit(17)\"",
  });
  receipt = {
    protocol,
    status: result.status === "passed" ? "succeeded" : "blocked",
    enforcement: boundary.enforcement,
    containment: LINUX_BWRAP_CONTAINMENT_RECEIPT,
    networkEnforcement: boundary.networkEnforcement,
    exitCode: result.exitCode,
    stdoutDigest: result.stdoutDigest,
    stderrDigest: result.stderrDigest,
    stderrPreview: result.status === "failed" ? result.stderr.slice(0, 512) : "",
    credentialMaterialStored: false,
    canonicalWrite: false,
    cleanup: "pending",
  };
  if (result.status !== "passed") failure = new Error(`Linux Workspace command failed: ${result.stderr || result.receipt}`);
} catch (error) {
  failure = error;
  receipt ??= {
    protocol,
    status: "blocked",
    credentialMaterialStored: false,
    canonicalWrite: false,
    cleanup: "pending",
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  if (boundary) await removeWorkspaceBoundary(boundary).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
  if (receipt) receipt.cleanup = "destroyed";
}

console.log(JSON.stringify(receipt, null, 2));
if (failure) throw failure;
