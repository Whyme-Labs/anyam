import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspaceBoundary, removeWorkspaceBoundary, runWorkspaceCommand } from "../packages/create-anyam/src/workspace-boundary.ts";

const protocol = "anyam.linux-workspace-qualification/v1" as const;
const root = await mkdtemp(join(tmpdir(), "anyam-linux-workspace-qualification-"));
const sourceDirectory = process.env.GITHUB_WORKSPACE ?? process.cwd();
const stateDirectory = join(root, "state");
const workspaceDirectory = join(root, "workspace");

let boundary: Awaited<ReturnType<typeof createWorkspaceBoundary>> | undefined;
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
    command: "node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/worker.bundle','private-alpha')\"",
  });
  const receipt = {
    protocol,
    status: result.status === "passed" ? "succeeded" : "blocked",
    enforcement: boundary.enforcement,
    networkEnforcement: boundary.networkEnforcement,
    exitCode: result.exitCode,
    stdoutDigest: result.stdoutDigest,
    stderrDigest: result.stderrDigest,
    stderrPreview: result.status === "failed" ? result.stderr.slice(0, 512) : "",
    credentialMaterialStored: false,
    canonicalWrite: false,
    cleanup: "pending",
  };
  console.log(JSON.stringify(receipt, null, 2));
  if (result.status !== "passed") throw new Error(`Linux Workspace command failed: ${result.stderr || result.receipt}`);
} finally {
  if (boundary) await removeWorkspaceBoundary(boundary).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
