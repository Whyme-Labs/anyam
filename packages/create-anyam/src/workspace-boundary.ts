import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type WorkspaceBoundaryMode = "enforceable" | "supervised";
export type WorkspaceBoundaryEnforcement = "macos-sandbox-exec" | "linux-bwrap" | "none";
export type WorkspaceMountMode = "read-only" | "read-write";

export type WorkspaceMount = {
  sourcePath: string;
  mountPath: string;
  mode: WorkspaceMountMode;
};

export type WorkspaceBoundaryInput = {
  sourceDirectory: string;
  stateDirectory: string;
  projectId: string;
  changeId: string;
  workspaceId: string;
  mode: WorkspaceBoundaryMode;
  /** Explicitly permitted tracked-file prefixes. Omit only for a full source clone. */
  authorizedPaths?: readonly string[];
  /** Hosts permitted for outbound HTTP/HTTPS. An empty list means deny all. */
  network?: readonly string[];
  /** Additional paths the child must not read or write. */
  excludedPaths?: readonly string[];
  /** Host executable paths required by the child process; these are read-only mounts. */
  executablePaths?: readonly string[];
  workspaceDirectory?: string;
};

export type WorkspaceBoundary = {
  protocol: "anyam.workspace-boundary/v1";
  id: string;
  mode: WorkspaceBoundaryMode;
  enforcement: WorkspaceBoundaryEnforcement;
  workspaceDirectory: string;
  sourceDirectory: string;
  mounts: readonly WorkspaceMount[];
  network: readonly string[];
  environment: Readonly<Record<string, string>>;
  executablePaths: readonly string[];
  profile?: string;
  temporary: boolean;
  receipt: string;
};

export type WorkspaceBoundaryCommandResult = {
  boundaryId: string;
  command: string;
  args: readonly string[];
  status: "passed" | "failed";
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  stdoutDigest: string;
  stderrDigest: string;
  receipt: string;
};

export class WorkspaceBoundaryError extends Error {
  readonly code: string;
  readonly affectedObject: string | undefined;
  readonly recoveryAction: string | undefined;
  readonly receipt: string | undefined;

  constructor(input: { code: string; message: string; affectedObject?: string; recoveryAction?: string; receipt?: string }) {
    super(input.message);
    this.name = "WorkspaceBoundaryError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }
}

export const WORKSPACE_BOUNDARY_POLICY = {
  commandTimeoutMs: 2 * 60 * 1000,
  maxOutputBytes: 4 * 1024 * 1024,
  receipt: "policy=workspace-boundary/v1; sizing=provisional-tripwire; remeasure-before-production",
} as const;

const SAFE_ENVIRONMENT_KEYS = new Set([
  "CI",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "TERM",
]);

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

function quoteProfile(value: string): string {
  return JSON.stringify(value);
}

function normalizedHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!host || host === "*" || host.includes("/") || host.includes(" ") || host.includes("\n") || host.includes("\r")) {
    throw new WorkspaceBoundaryError({ code: "workspace.network_invalid", message: `Network policy host ${JSON.stringify(value)} is not a concrete hostname; wildcard and path access are not allowed.`, affectedObject: value, recoveryAction: "declare concrete HTTP/HTTPS hostnames or leave network empty", receipt: "network=explicit-host-allowlist" });
  }
  return host;
}

function normalizedRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === ".." || segment.includes("\0"))) {
    throw new WorkspaceBoundaryError({ code: "workspace.mount_invalid", message: `Authorized Workspace path ${JSON.stringify(value)} must be a non-empty relative path without traversal.`, affectedObject: value, recoveryAction: "declare a relative tracked-file prefix", receipt: "authorized-path=relative-no-traversal" });
  }
  return normalized;
}

function pathPrefixMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function commandExists(command: string): boolean {
  if (command.startsWith("/")) return existsSync(command);
  return ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].some((root) => existsSync(join(root, command)));
}

async function gitOutput(directory: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFile("git", [...args], { cwd: directory, encoding: "utf8" });
    return result.stdout.trim();
  } catch (error) {
    throw new WorkspaceBoundaryError({ code: "workspace.git_unavailable", message: `Git could not prepare the isolated Workspace; no agent process was started.`, affectedObject: directory, recoveryAction: "verify Git is installed and the source Workspace is a clean committed repository", receipt: `git=${args.join(" ")}; error=${error instanceof Error ? error.message.slice(0, 160) : String(error)}` });
  }
}

async function ensureCleanSource(directory: string): Promise<void> {
  const inside = await gitOutput(directory, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new WorkspaceBoundaryError({ code: "workspace.git_metadata_missing", message: `Source directory ${directory} is not a Git worktree; an enforceable Workspace cannot be based on an uncommitted or ambiguous source.`, affectedObject: directory, recoveryAction: "initialize Git, create a committed baseline, and retry enforceable agent launch", receipt: "git=inside-work-tree:false" });
  const status = await gitOutput(directory, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changedPaths = status.split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, "")).filter((path) => path !== ".anyam" && !path.startsWith(".anyam/"));
  if (changedPaths.length > 0) throw new WorkspaceBoundaryError({ code: "workspace.source_dirty", message: `Source directory ${directory} has uncommitted source changes; the enforceable Workspace was not materialized.`, affectedObject: directory, recoveryAction: "commit or discard source changes before launching an enforceable agent", receipt: `git-status=dirty; changed-paths=${changedPaths.length}; metadata-excluded=.anyam/**` });
}

async function trackedFiles(directory: string): Promise<readonly string[]> {
  const output = await gitOutput(directory, ["ls-files", "-z"]);
  return output.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

async function copyProjection(input: { sourceDirectory: string; destination: string; authorizedPaths: readonly string[] }): Promise<void> {
  const prefixes = [...new Set(["anyam.json", ...input.authorizedPaths].map(normalizedRelative))];
  const files = await trackedFiles(input.sourceDirectory);
  const selected = files.filter((path) => prefixes.some((prefix) => pathPrefixMatches(path, prefix)));
  if (selected.length === 0) throw new WorkspaceBoundaryError({ code: "workspace.projection_empty", message: "Authorized Workspace projection contains no tracked files; no agent process was started.", affectedObject: input.destination, recoveryAction: "authorize at least one tracked source path and retry", receipt: `authorized-paths=${prefixes.length}; tracked-files=${files.length}; selected-files=0` });
  for (const path of selected) {
    const source = join(input.sourceDirectory, path);
    const destination = join(input.destination, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
  await gitOutput(input.destination, ["init", "--quiet"]);
  await gitOutput(input.destination, ["config", "user.email", "agent@anyam.dev"]);
  await gitOutput(input.destination, ["config", "user.name", "Anyam Workspace"]);
  await gitOutput(input.destination, ["add", "--", "."]);
  await gitOutput(input.destination, ["commit", "--quiet", "-m", "Materialize authorized Project View"]);
}

async function cloneWorkspace(input: { sourceDirectory: string; destination: string }): Promise<void> {
  await gitOutput(dirname(input.destination), ["clone", "--no-local", "--no-hardlinks", "--no-tags", input.sourceDirectory, input.destination]);
  await gitOutput(input.destination, ["remote", "set-url", "origin", "https://workspace.anyam.local/agent.git"]);
}

async function realPathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return resolve(path);
  }
}

async function resolveExecutablePath(value: string): Promise<string> {
  if (value.includes("/")) {
    try {
      return await realpath(value);
    } catch (error) {
      if (isNotFound(error)) throw new WorkspaceBoundaryError({ code: "workspace.executable_missing", message: `Agent executable ${value} does not exist; no process was started.`, affectedObject: value, recoveryAction: "install the selected agent or pass its absolute executable path", receipt: "executable=host-path-verified" });
      throw error;
    }
  }
  try {
    const result = await execFile("/usr/bin/which", [value], { encoding: "utf8" });
    const path = result.stdout.trim().split("\n")[0] ?? "";
    if (path) return await realpath(path);
  } catch {
    // The boundary reports a named missing executable below.
  }
  throw new WorkspaceBoundaryError({ code: "workspace.executable_missing", message: `Agent executable ${value} is not discoverable on PATH; no process was started.`, affectedObject: value, recoveryAction: "install the selected agent or pass its absolute executable path", receipt: "executable=host-path-verified" });
}

function backendForHost(mode: WorkspaceBoundaryMode): WorkspaceBoundaryEnforcement {
  if (mode === "supervised") return "none";
  if (process.platform === "darwin" && commandExists("sandbox-exec")) return "macos-sandbox-exec";
  if (process.platform === "linux" && commandExists("bwrap")) return "linux-bwrap";
  throw new WorkspaceBoundaryError({ code: "workspace.enforcement_unavailable", message: `No qualified host sandbox is available for enforceable agent execution on ${process.platform}/${process.arch}; the agent was not started.`, recoveryAction: "install the qualified host sandbox or explicitly choose --mode supervised for developer-owned local work", receipt: `${WORKSPACE_BOUNDARY_POLICY.receipt}; host=${process.platform}/${process.arch}; backend=none` });
}

function sandboxProfile(input: { workspaceDirectory: string; stateDirectory: string; sourceDirectory: string; network: readonly string[]; excludedPaths: readonly string[]; executableRoots: readonly string[] }): string {
  const runtimeRoots = new Set<string>([
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/private/etc",
    "/private/var/select",
    "/dev",
    dirname(process.execPath),
    dirname(dirname(process.execPath)),
    ...input.executableRoots,
  ]);
  const lines = [
    "(version 1)",
    "(import \"system.sb\")",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read-metadata (subpath \"/private/tmp\"))",
  ];
  for (const root of runtimeRoots) lines.push(`(allow file-read* (subpath ${quoteProfile(root)}))`);
  lines.push(`(allow file-read* (subpath ${quoteProfile(input.workspaceDirectory)}))`);
  lines.push(`(allow file-write* (subpath ${quoteProfile(input.workspaceDirectory)}))`);
  for (const host of input.network) lines.push(`(allow network-outbound (remote-name ${quoteProfile(host)}))`);
  for (const path of new Set([input.stateDirectory, input.sourceDirectory, homedir(), ...input.excludedPaths])) {
    lines.push(`(deny file-read* (subpath ${quoteProfile(path)}))`);
    lines.push(`(deny file-write* (subpath ${quoteProfile(path)}))`);
  }
  return lines.join(" ");
}

function sanitizedEnvironment(input: { workspaceDirectory: string; boundaryId: string; mode: WorkspaceBoundaryMode; executableRoots?: readonly string[] }): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = `${[...(input.executableRoots ?? []), dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")}`;
  environment.HOME = join(input.workspaceDirectory, ".home");
  environment.TMPDIR = join(input.workspaceDirectory, ".tmp");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_CONFIG_SYSTEM = "/dev/null";
  environment.SSH_AUTH_SOCK = "";
  environment.GIT_SSH_COMMAND = "false";
  environment.AWS_ACCESS_KEY_ID = "";
  environment.AWS_SECRET_ACCESS_KEY = "";
  environment.CLOUDFLARE_API_TOKEN = "";
  environment.ANYAM_WORKSPACE_MODE = input.mode;
  environment.ANYAM_WORKSPACE_BOUNDARY_ID = input.boundaryId;
  return environment;
}

async function prepareDirectories(directory: string): Promise<void> {
  await mkdir(join(directory, ".home"), { recursive: true });
  await mkdir(join(directory, ".tmp"), { recursive: true });
}

export async function createWorkspaceBoundary(input: WorkspaceBoundaryInput): Promise<WorkspaceBoundary> {
  const sourceDirectory = await realPathOrResolve(input.sourceDirectory);
  const stateDirectory = await realPathOrResolve(input.stateDirectory);
  const network = [...new Set((input.network ?? []).map(normalizedHost))];
  const enforcement = backendForHost(input.mode);
  const executablePaths = input.mode === "enforceable" ? [...new Set(await Promise.all((input.executablePaths ?? []).map(resolveExecutablePath)))] : [];
  const executableRoots = executablePaths.map((path) => dirname(path));
  if (input.mode === "supervised") {
    const id = `boundary:${randomUUID()}`;
    const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    environment.ANYAM_WORKSPACE_MODE = input.mode;
    environment.ANYAM_WORKSPACE_BOUNDARY_ID = id;
    return {
      protocol: "anyam.workspace-boundary/v1",
      id,
      mode: input.mode,
      enforcement,
      workspaceDirectory: sourceDirectory,
      sourceDirectory,
      mounts: [{ sourcePath: sourceDirectory, mountPath: "/workspace", mode: "read-write" }],
      network,
      environment,
      executablePaths,
      temporary: false,
      receipt: `${WORKSPACE_BOUNDARY_POLICY.receipt}; mode=supervised; enforcement=none; source=${digest(sourceDirectory)}; credentials=ambient-host-not-enforced`,
    };
  }

  await ensureCleanSource(sourceDirectory);
  const destination = input.workspaceDirectory ? resolve(input.workspaceDirectory) : await mkdtemp(join(tmpdir(), "anyam-workspace-"));
  const temporary = !input.workspaceDirectory;
  if (input.workspaceDirectory) {
    try {
      await stat(destination);
      throw new WorkspaceBoundaryError({ code: "workspace.directory_exists", message: `Enforceable Workspace destination ${destination} already exists; refusing to overwrite it.`, affectedObject: destination, recoveryAction: "choose a new disposable Workspace destination", receipt: "overwrite=false" });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: true });
  if (input.authorizedPaths && input.authorizedPaths.length > 0) await copyProjection({ sourceDirectory, destination, authorizedPaths: input.authorizedPaths });
  else await cloneWorkspace({ sourceDirectory, destination });
  const workspaceDirectory = await realPathOrResolve(destination);
  await prepareDirectories(workspaceDirectory);
  const id = `boundary:${randomUUID()}`;
  const environment = sanitizedEnvironment({ workspaceDirectory, boundaryId: id, mode: input.mode, executableRoots });
  const excludedPaths = [...(input.excludedPaths ?? [])].map((path) => resolve(path));
  const profile = process.platform === "darwin"
    ? sandboxProfile({ workspaceDirectory, stateDirectory, sourceDirectory, network, excludedPaths, executableRoots })
    : undefined;
  const mounts: WorkspaceMount[] = [{ sourcePath: sourceDirectory, mountPath: "/workspace/source", mode: "read-only" }, { sourcePath: workspaceDirectory, mountPath: "/workspace", mode: "read-write" }];
  return {
    protocol: "anyam.workspace-boundary/v1",
    id,
    mode: input.mode,
    enforcement,
    workspaceDirectory,
    sourceDirectory,
    mounts,
    network,
    environment,
    executablePaths,
    ...(profile ? { profile } : {}),
    temporary,
    receipt: `${WORKSPACE_BOUNDARY_POLICY.receipt}; mode=${input.mode}; enforcement=${enforcement}; mounts=${mounts.length}; network-hosts=${network.length}; canonicalWrite=false; ambientCredentials=blocked`,
  };
}

export async function runWorkspaceCommand(input: { boundary: WorkspaceBoundary; command: string; args?: readonly string[]; timeoutMs?: number; onProcess?: (process: ChildProcess) => void }): Promise<WorkspaceBoundaryCommandResult> {
  const args = [...(input.args ?? [])];
  const timeoutMs = input.timeoutMs ?? WORKSPACE_BOUNDARY_POLICY.commandTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkspaceBoundaryError({ code: "workspace.command_timeout_invalid", message: `Workspace command timeout must be positive; asked=${timeoutMs}.`, recoveryAction: "provide a positive timeout or use the provisional boundary tripwire", receipt: WORKSPACE_BOUNDARY_POLICY.receipt });
  const command = input.boundary.enforcement === "none" ? input.command : input.boundary.executablePaths[0] ?? input.command;
  const executable = input.boundary.enforcement === "macos-sandbox-exec" ? "sandbox-exec" : command;
  const executableArgs = input.boundary.enforcement === "macos-sandbox-exec"
    ? ["-p", input.boundary.profile ?? "", command, ...args]
    : input.boundary.enforcement === "linux-bwrap"
      ? ["--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--bind", input.boundary.workspaceDirectory, input.boundary.workspaceDirectory, "--chdir", input.boundary.workspaceDirectory, command, ...args]
      : ["-c", `${input.command} ${args.map((arg) => JSON.stringify(arg)).join(" ")}`];
  const child = spawn(executable, executableArgs, { cwd: input.boundary.workspaceDirectory, env: input.boundary.environment, stdio: ["inherit", "pipe", "pipe"] });
  input.onProcess?.(child);
  let stdout = "";
  let stderr = "";
  let outputLimitExceeded = false;
  const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
    if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") + chunk.byteLength > WORKSPACE_BOUNDARY_POLICY.maxOutputBytes) {
      if (!outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
      }
      return;
    }
    if (target === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
  const result = await new Promise<{ exitCode?: number; signal?: string }>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new WorkspaceBoundaryError({ code: "workspace.command_timeout", message: `Workspace command exceeded the execution boundary. budget=workspace.command; limit=${timeoutMs}ms; asked=running process`, affectedObject: input.command, recoveryAction: "inspect the command or request an explicitly measured larger boundary", receipt: `${WORKSPACE_BOUNDARY_POLICY.receipt}; timeout-ms=${timeoutMs}` }));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(new WorkspaceBoundaryError({ code: "workspace.command_failed", message: `Enforceable Workspace command could not start: ${error.message}`, affectedObject: input.command, recoveryAction: "verify the agent executable is installed and allowed", receipt: `${WORKSPACE_BOUNDARY_POLICY.receipt}; process-start=failed` })); });
    child.once("close", (exitCode, signal) => { clearTimeout(timer); resolveResult({ ...(exitCode === null ? {} : { exitCode }), ...(signal ? { signal } : {}) }); });
  });
  const status = !outputLimitExceeded && result.exitCode === 0 ? "passed" : "failed";
  return {
    boundaryId: input.boundary.id,
    command,
    args,
    status,
    ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result.signal ? { signal: result.signal } : {}),
    stdout,
    stderr,
    stdoutDigest: digest(stdout),
    stderrDigest: digest(stderr),
    receipt: `${WORKSPACE_BOUNDARY_POLICY.receipt}; enforcement=${input.boundary.enforcement}; status=${status};${outputLimitExceeded ? ` budget=workspace.output; limit=${WORKSPACE_BOUNDARY_POLICY.maxOutputBytes}bytes; asked=output-exceeded;` : ""}`,
  };
}

export async function removeWorkspaceBoundary(boundary: WorkspaceBoundary): Promise<void> {
  if (!boundary.temporary) return;
  const workspace = await realPathOrResolve(boundary.workspaceDirectory);
  const temporaryRoot = await realPathOrResolve(tmpdir());
  const relativePath = relative(temporaryRoot, workspace);
  if (!relativePath || relativePath.startsWith("..") || resolve(workspace) === resolve(temporaryRoot)) throw new WorkspaceBoundaryError({ code: "workspace.cleanup_refused", message: `Workspace cleanup refused because ${workspace} is outside the disposable temp root.`, affectedObject: workspace, recoveryAction: "inspect the Workspace path and remove it manually only after owner review", receipt: "cleanup=path-confined-to-temp-root" });
  await rm(workspace, { recursive: true, force: true });
}
