import { mkdtemp, mkdir, readdir, lstat, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createWorkspaceBoundary, LINUX_BWRAP_CONTAINMENT_RECEIPT, removeWorkspaceBoundary, runWorkspaceCommand, type WorkspaceResourceLimits } from "../packages/create-anyam/src/workspace-boundary.ts";

const protocol = "anyam.linux-workspace-qualification/v1" as const;
const root = await mkdtemp(join(tmpdir(), "anyam-linux-workspace-qualification-"));
const sourceDirectory = process.env.GITHUB_WORKSPACE ?? process.cwd();
const stateDirectory = join(root, "state");
const workspaceDirectory = join(root, "workspace");
const execFile = promisify(execFileCallback);

async function fileBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await fileBytes(path);
    else if (entry.isFile()) total += (await lstat(path)).size;
  }
  return total;
}

async function measureHealthyRuntime(): Promise<{ vmsBytes: number; rssBytes: number; openFiles: number; processCount: number; elapsedMs: number; workspaceBytes: number }> {
  const startedAt = Date.now();
  const runtime = await execFile(process.execPath, ["-e", "const fs=require('node:fs');const status=fs.readFileSync('/proc/self/status','utf8');const value=(name)=>Number((status.match(new RegExp('^'+name+'\\\\s+(\\\\d+) kB','m'))||[])[1]||0)*1024;console.log(JSON.stringify({vmsBytes:value('VmSize'),rssBytes:value('VmRSS'),openFiles:fs.readdirSync('/proc/self/fd').length}));"], { encoding: "utf8" });
  const measured = JSON.parse(runtime.stdout.trim()) as { vmsBytes: number; rssBytes: number; openFiles: number };
  const processCount = (await readdir("/proc", { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name)).length;
  return { ...measured, processCount, elapsedMs: Math.max(1, Date.now() - startedAt), workspaceBytes: await fileBytes(sourceDirectory) };
}

let boundary: Awaited<ReturnType<typeof createWorkspaceBoundary>> | undefined;
let receipt: Record<string, unknown> | undefined;
let failure: unknown;
try {
  await mkdir(stateDirectory, { recursive: true });
  const measured = await measureHealthyRuntime();
  const resourceLimits: WorkspaceResourceLimits = {
    maxProcesses: Math.max(measured.processCount * 4, measured.processCount + 128),
    maxAddressSpaceBytes: Math.max(measured.vmsBytes * 2, measured.rssBytes * 8),
    maxCpuSeconds: Math.max(5, Math.ceil(measured.elapsedMs / 1000) * 8),
    maxOpenFiles: measured.openFiles + 256,
    maxFileBytes: Math.max(measured.workspaceBytes * 2, measured.rssBytes),
    maxWorkspaceBytes: Math.max(measured.workspaceBytes * 4, measured.workspaceBytes + 1_048_576),
    monitorIntervalMs: 250,
    receipt: `measurement=linux-healthy-runtime; baselineProcesses=${measured.processCount}; baselineVmsBytes=${measured.vmsBytes}; baselineRssBytes=${measured.rssBytes}; baselineOpenFiles=${measured.openFiles}; baselineWorkspaceBytes=${measured.workspaceBytes}; baselineElapsedMs=${measured.elapsedMs}; tripwireFormula=processes=max(baseline*4,baseline+128);addressSpace=max(vms*2,rss*8);cpuSeconds=max(5,elapsedSeconds*8);openFiles=baseline+256;fileBytes=max(workspace*2,rss);workspaceBytes=max(workspace*4,workspace+1048576);monitorIntervalMs=250`,
  };
  boundary = await createWorkspaceBoundary({
    sourceDirectory,
    stateDirectory,
    projectId: "project:linux-workspace-qualification",
    changeId: "change:linux-workspace-qualification",
    workspaceId: "workspace:linux-workspace-qualification",
    mode: "enforceable",
    network: [],
    executablePaths: [process.execPath],
    resourceLimits,
    workspaceDirectory,
  });
  const result = await runWorkspaceCommand({
    boundary,
    protectGitMetadata: true,
    command: process.execPath,
    args: ["-e", "const fs=require('node:fs');let blocked=false;try{fs.appendFileSync('.git/config','\\n# hostile-action\\n')}catch{blocked=true}const pidIsolated=process.ppid===1;fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/worker.bundle',JSON.stringify({pidIsolated,proc1:fs.readFileSync('/proc/1/comm','utf8').trim()}));if(!blocked||!pidIsolated)process.exit(17)"],
  });
  receipt = {
    protocol,
    status: result.status === "passed" ? "succeeded" : "blocked",
    enforcement: boundary.enforcement,
    containment: LINUX_BWRAP_CONTAINMENT_RECEIPT,
    resourceLimits,
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
