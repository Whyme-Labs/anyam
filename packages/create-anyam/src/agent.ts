import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { execFile as execFileCallback, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { basename, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gitCommitIdentity, gitProjectRevisionId, gitTreeIdentity, inspectGitSource, isGitAncestor, LocalGitSourceError, trackedGitPaths } from "./git-source.js";
import { createWorkspaceBoundary, removeWorkspaceBoundary, runWorkspaceCommand, terminateWorkspaceProcess, WorkspaceBoundaryError, type WorkspaceBoundary, type WorkspaceBoundaryEnforcement, type WorkspaceBoundaryMode } from "./workspace-boundary.js";
import { trustedGitArgs, trustedGitEnvironment } from "./trusted-git.js";

const execFile = promisify(execFileCallback);

export const AGENT_SESSION_PROTOCOL = "anyam.agent-session/v1";
export const AGENT_STATE_PROTOCOL = "anyam.agent-state/v1";
export const AGENT_CONTEXT_PROTOCOL = "anyam.context/v1";
export const AGENT_AUDIT_PROTOCOL = "anyam.agent-audit/v1";
export const AGENT_SETUP_PROTOCOL = "anyam.agent-setup/v1";

export type AgentKind = "codex" | "claude" | "cursor" | "cli";

export const AGENT_KINDS: readonly AgentKind[] = ["codex", "claude", "cursor", "cli"];

export type AgentCapability =
  | "project.inspect"
  | "change.inspect"
  | "workspace.inspect"
  | "run.start"
  | "run.inspect"
  | "evidence.inspect"
  | "review.submit_finding"
  | "change.publish_revision"
  | "source.read"
  | "workspace.write";

export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "project.inspect",
  "change.inspect",
  "workspace.inspect",
  "run.start",
  "run.inspect",
  "evidence.inspect",
  "review.submit_finding",
  "change.publish_revision",
  "source.read",
  "workspace.write",
];

export const PROHIBITED_OPERATIONS = [
  "repository.write",
  "git.push:canonical",
  "secret.read",
  "change.approve",
  "target.promote:production",
  "policy.manage",
] as const;

export const LOCAL_AGENT_POLICY = {
  credentialLifetimeMs: 15 * 60 * 1000,
  sessionLifetimeMs: 2 * 60 * 60 * 1000,
  stateLockTimeoutMs: 5_000,
  stateLockRetryDelayMs: 10,
  receipt: "policy=local-agent/v1; sizing=provisional-tripwire; remeasure-before-production",
} as const;

export const LOCAL_ACTION_POLICY = {
  timeoutMs: 2 * 60 * 1000,
  maxOutputBytes: 4 * 1024 * 1024,
  receipt: "policy=local-action/v1; sizing=provisional-tripwire; remeasure-before-production",
} as const;

export type AgentResource = {
  projectId: string;
  changeId: string;
  workspaceId: string;
};

export type LocalCapabilityGrant = {
  protocol: "anyam.capability/v1";
  id: string;
  realmId: "realm:local";
  subjectId: string;
  resource: AgentResource;
  actions: readonly AgentCapability[];
  deniedActions: readonly string[];
  canonicalWrite: false;
  issuedAt: string;
  expiresAt: string;
  authorizationEpoch: number;
  status: "active" | "revoked" | "expired";
};

export type LocalAgentSession = {
  protocol: "anyam.agent-session/v1";
  id: string;
  taskId: string;
  grantId: string;
  agent: AgentKind;
  projectId: string;
  changeId: string;
  workspaceId: string;
  principalId: string;
  actorId: string;
  clientId: string;
  authorizationEpoch: number;
  startedAt: string;
  expiresAt: string;
  status: "active" | "revoked" | "expired";
  issuedCredentialDigests: string[];
  workspaceMode?: WorkspaceBoundaryMode;
  workspaceDirectory?: string;
  workspaceBoundaryId?: string;
  workspaceEnforcement?: WorkspaceBoundaryEnforcement;
  workspaceTemporary?: boolean;
  processPid?: number;
  processGroupId?: number;
  revokedAt?: string;
};

export type AgentContextManifest = {
  protocol: "anyam.context/v1";
  id: string;
  project: { id: string; name: string; manifestDigest: string };
  sourceSpaces: {
    readable: readonly string[];
    writable: readonly string[];
    hidden: readonly string[];
  };
  baseProjectRevisionId: string;
  changeId: string;
  workspaceId: string;
  actorId: string;
  taskId: string;
  grantId: string;
  capabilities: readonly AgentCapability[];
  prohibitedOperations: readonly string[];
  actions: readonly string[];
  verifiers: readonly string[];
  authorizationEpoch: number;
  disclosure: "local-owner";
  createdAt: string;
  expiresAt: string;
  receipt: string;
  workspaceMode?: WorkspaceBoundaryMode;
  workspaceEnforcement?: WorkspaceBoundaryEnforcement;
};

export type WorkspaceCredential = {
  protocol: "anyam.git-credential/v1";
  token: string;
  audience: string;
  sessionId: string;
  projectId: string;
  changeId: string;
  workspaceId: string;
  permissions: readonly ["read", "write-workspace"];
  canonicalWrite: false;
  issuedAt: string;
  expiresAt: string;
};

export type LocalRunObservation = {
  id: string;
  actionId: string;
  status: "passed" | "failed" | "blocked";
  evidenceId: string;
  evidenceDigest: string;
  startedAt: string;
  completedAt: string;
  sourceRevision: string;
  sourceSnapshot: string;
  actionContractDigest: string;
  verifierId: string;
  verifierContractDigest?: string;
  exitCode?: number;
  stdoutDigest: string;
  stderrDigest: string;
  inputDigests: readonly string[];
  outputDigests: readonly string[];
  outputDigest: string;
  toolchainDigest: string;
  environmentDigest: string;
  actorId: string;
  grantId: string;
  taskId: string;
  receipt: string;
};

export type LocalReviewFinding = {
  id: string;
  severity: "info" | "warning" | "error";
  summary: string;
  details?: string;
  createdAt: string;
  actorId: string;
};

export type LocalProposedRevision = {
  id: string;
  changeId: string;
  workspaceId: string;
  sourceSnapshot: string;
  sourceRepositoryId: string;
  sourceRevision: string;
  baseProjectRevisionId: string;
  gitRef: string;
  gitObjectFormat: "sha1" | "sha256";
  treeDigest: string;
  sourceKind: "git";
  declaredEffects: readonly string[];
  createdAt: string;
  actorId: string;
  canonicalWrite: false;
};

export type AgentAuditEvent = {
  protocol: "anyam.agent-audit/v1";
  id: string;
  occurredAt: string;
  operation: string;
  outcome: "allowed" | "denied" | "observed";
  sessionId?: string;
  grantId?: string;
  taskId?: string;
  projectId?: string;
  changeId?: string;
  workspaceId?: string;
  actorId?: string;
  agent?: AgentKind;
  details?: Record<string, unknown>;
};

type StoredCredential = {
  digest: string;
  sessionId: string;
  audience: string;
  workspaceId: string;
  issuedAt: string;
  expiresAt: string;
};

type AgentState = {
  protocol: "anyam.agent-state/v1";
  authorizationEpoch: number;
  currentSessionId: string | null;
  sessions: Record<string, LocalAgentSession>;
  grants: Record<string, LocalCapabilityGrant>;
  contexts: Record<string, AgentContextManifest>;
  credentials: Record<string, StoredCredential>;
  runs: Record<string, LocalRunObservation>;
  findings: Record<string, LocalReviewFinding>;
  revisions: Record<string, LocalProposedRevision>;
  audit: AgentAuditEvent[];
};

export type AgentSetupResult = {
  protocol: "anyam.agent-setup/v1";
  directory: string;
  agent: AgentKind;
  files: readonly string[];
  broker: { command: "anyam"; args: readonly string[]; transport: "stdio" };
  credentialStorage: "memory-only";
  canonicalWrite: false;
};

export type AgentStatus = {
  session: LocalAgentSession | null;
  grant: LocalCapabilityGrant | null;
  context: AgentContextManifest | null;
  activeCredentialCount: number;
  auditCount: number;
};

type ProjectMetadata = {
  id: string;
  name: string;
  manifestDigest: string;
  sourceSpaceIds: readonly string[];
  actions: readonly LocalDeclaredAction[];
  verifiers: readonly LocalDeclaredVerifier[];
};

type LocalDeclaredAction = {
  id: string;
  moduleId: string;
  moduleRoot: string;
  command: string;
  inputGlobs: readonly string[];
  outputPaths: readonly string[];
  network: readonly string[];
  resources: Readonly<Record<string, string | number | boolean>>;
  contractDigest: string;
};

type LocalDeclaredVerifier = {
  id: string;
  actionId: string;
  disclosure: "full" | "result-only";
  requiredFor: readonly string[];
  contractDigest: string;
};

type ChangeMetadata = {
  id: string;
  projectId: string;
  title: string;
  baseProjectRevisionId: string;
  workspaceId: string;
  baseRepositoryId: string;
};

export type LocalAgentManagerOptions = {
  directory: string;
  stateDirectory?: string;
  principalId?: string;
  clientId?: string;
  credentialLifetimeMs?: number;
  sessionLifetimeMs?: number;
  now?: () => Date;
};

export type AgentLaunchInput = {
  agent: string;
  command: string;
  args?: readonly string[];
  mode?: WorkspaceBoundaryMode;
  authorizedPaths?: readonly string[];
  network?: readonly string[];
  workspaceDirectory?: string;
};

export type AgentLaunchResult = {
  session: LocalAgentSession;
  boundary: WorkspaceBoundary;
  command: Awaited<ReturnType<typeof runWorkspaceCommand>>;
};

export function defaultAgentStateDirectory(): string {
  const configured = process.env.ANYAM_STATE_HOME?.trim();
  if (configured) return resolve(configured);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Anyam");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"), "Anyam");
  return join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "anyam");
}

export function localAgentStatePath(directoryInput: string, stateDirectory = defaultAgentStateDirectory()): string {
  const directory = resolve(directoryInput);
  const projectKey = createHash("sha256").update(directory).digest("hex");
  return join(resolve(stateDirectory), "projects", projectKey, "state.json");
}

export class LocalAgentError extends Error {
  readonly code: string;
  readonly affectedObject: string | undefined;
  readonly recoveryAction: string | undefined;
  readonly receipt: string | undefined;

  constructor(input: { code: string; message: string; affectedObject?: string; recoveryAction?: string; receipt?: string }) {
    super(input.message);
    this.name = "LocalAgentError";
    this.code = input.code;
    this.affectedObject = input.affectedObject;
    this.recoveryAction = input.recoveryAction;
    this.receipt = input.receipt;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.affectedObject ? { affectedObject: this.affectedObject } : {}),
      ...(this.recoveryAction ? { recoveryAction: this.recoveryAction } : {}),
      ...(this.receipt ? { receipt: this.receipt } : {}),
    };
  }
}

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const LOCAL_MCP_TOOLS: readonly ToolDefinition[] = [
  tool("project.inspect", "Inspect the current Project and authorised source spaces.", {
    type: "object",
    additionalProperties: false,
  }),
  tool("change.inspect", "Inspect the active Change and its latest local revision.", {
    type: "object",
    additionalProperties: false,
  }),
  tool("workspace.inspect", "Inspect the task Workspace and its capability boundary.", {
    type: "object",
    additionalProperties: false,
  }),
  tool("run.start", "Run an explicitly declared local action and record an observation.", {
    type: "object",
    properties: { actionId: { type: "string" } },
    required: ["actionId"],
    additionalProperties: false,
  }),
  tool("run.inspect", "Inspect a previously observed local run.", {
    type: "object",
    properties: { runId: { type: "string" } },
    required: ["runId"],
    additionalProperties: false,
  }),
  tool("evidence.inspect", "Inspect evidence produced by a local run.", {
    type: "object",
    properties: { evidenceId: { type: "string" } },
    required: ["evidenceId"],
    additionalProperties: false,
  }),
  tool("review.submit_finding", "Submit a structured review finding for the active Change.", {
    type: "object",
    properties: {
      severity: { type: "string", enum: ["info", "warning", "error"] },
      summary: { type: "string" },
      details: { type: "string" },
    },
    required: ["severity", "summary"],
    additionalProperties: false,
  }),
  tool("change.publish_revision", "Publish a Change revision from the isolated Workspace.", {
    type: "object",
    properties: {
      declaredEffects: { type: "array", items: { type: "string" } },
    },
    required: ["declaredEffects"],
    additionalProperties: false,
  }),
];

function tool(name: string, description: string, inputSchema: Record<string, unknown>): ToolDefinition {
  return { name, description, inputSchema };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function expiresAt(now: () => Date, lifetimeMs: number): string {
  return new Date(now().getTime() + lifetimeMs).toISOString();
}

function isExpired(value: string, now: () => Date): boolean {
  return Date.parse(value) <= now().getTime();
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, path);
}

async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  if (await exists(path)) return false;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
  return true;
}

async function writeJsonIfAbsent(path: string, value: unknown): Promise<boolean> {
  return writeIfAbsent(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function declaredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocalAgentError({ code: "run.manifest_invalid", message: `Declared Action field ${field} must be a non-empty string; no run was started.`, affectedObject: field, recoveryAction: "repair anyam.json and rerun anyam check", receipt: `field=${field}; expected=non-empty-string` });
  }
  return value;
}

function declaredStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new LocalAgentError({ code: "run.manifest_invalid", message: `Declared Action field ${field} must be an array of strings; no run was started.`, affectedObject: field, recoveryAction: "repair anyam.json and rerun anyam check", receipt: `field=${field}; expected=string[]` });
  }
  return value.map((item) => item as string);
}

function declaredWorkspacePathArray(value: unknown, field: string): readonly string[] {
  return declaredStringArray(value, field).map((item) => {
    const normalized = item.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === ".." || segment.includes("\0"))) {
      throw new LocalAgentError({ code: "run.manifest_invalid", message: `Declared Action path ${field} contains traversal or an absolute path; no run was started.`, affectedObject: field, recoveryAction: "use a path relative to the Project Workspace and rerun anyam check", receipt: `field=${field}; path=${item}; relative-only=true` });
    }
    return normalized;
  });
}

function protectedOutputPaths(paths: readonly string[], trackedPaths: readonly string[]): readonly string[] {
  const tracked = new Set(trackedPaths);
  return paths.filter((path) => path === ".git" || path.startsWith(".git/") || path === ".anyam" || path.startsWith(".anyam/") || tracked.has(path));
}

function declaredResources(value: unknown, field: string): Readonly<Record<string, string | number | boolean>> {
  if (!isRecord(value) || Object.values(value).some((item) => !["string", "number", "boolean"].includes(typeof item))) {
    throw new LocalAgentError({ code: "run.manifest_invalid", message: `Declared Action field ${field} must contain only scalar resources; no run was started.`, affectedObject: field, recoveryAction: "repair anyam.json and rerun anyam check", receipt: `field=${field}; expected=scalar-record` });
  }
  return value as Readonly<Record<string, string | number | boolean>>;
}

function localActionContractDigest(action: Omit<LocalDeclaredAction, "contractDigest">): string {
  return digest(action);
}

function localVerifierContractDigest(verifier: Omit<LocalDeclaredVerifier, "contractDigest">): string {
  return digest(verifier);
}

function localGlobRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
      expression += "(?:.*/)?";
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${expression}$`);
}

async function localWalkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const pathname = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await localWalkFiles(root, pathname));
    else if (entry.isFile()) files.push(relative(root, pathname).replaceAll("\\", "/"));
  }
  return files.sort();
}

function byteDigest(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function localInputDigests(root: string, patterns: readonly string[]): Promise<{ digests: readonly string[]; missing: readonly string[] }> {
  const allFiles = await localWalkFiles(root);
  const digests: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const matches = allFiles.filter((path) => localGlobRegExp(pattern).test(path));
    if (matches.length === 0) missing.push(pattern);
    for (const path of matches) {
      if (seen.has(path)) continue;
      seen.add(path);
      digests.push(`${path}=${byteDigest(await readFile(join(root, path)))}`);
    }
  }
  return { digests, missing };
}

async function localOutputDigests(root: string, paths: readonly string[]): Promise<{ digests: readonly string[]; missing: readonly string[]; error?: string }> {
  const digests: string[] = [];
  const missing: string[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    try {
      const outputPath = join(root, path);
      const before = await lstat(outputPath);
      if (!before.isFile()) return { digests: [], missing: [], error: `output=${path}; regular-file=false; recovery=replace symlinks, FIFOs, devices, and directories with regular files` };
      const hash = createHash("sha256");
      let fileBytes = 0;
      const handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stream = handle.createReadStream();
        for await (const chunk of stream) {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          fileBytes += value.byteLength;
          totalBytes += value.byteLength;
          if (fileBytes > LOCAL_ACTION_POLICY.maxOutputBytes || totalBytes > LOCAL_ACTION_POLICY.maxOutputBytes) {
            stream.destroy();
            return { digests: [], missing: [], error: `budget=action.artifact-output; limit=${LOCAL_ACTION_POLICY.maxOutputBytes}bytes; asked=${path}; receipt=${LOCAL_ACTION_POLICY.receipt}` };
          }
          hash.update(value);
        }
      } finally {
        await handle.close();
      }
      const after = await lstat(outputPath);
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) return { digests: [], missing: [], error: `output=${path}; file-changed-during-ingestion=true; recovery=produce a stable regular file before retrying` };
      digests.push(`${path}=sha256:${hash.digest("hex")}`);
    } catch (error) {
      if (isNotFound(error)) missing.push(path);
      else throw error;
    }
  }
  return { digests, missing };
}

type LocalActionCommandResult = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
};

async function executeDeclaredAction(boundary: WorkspaceBoundary, command: string, onProcess?: (process: ChildProcess) => void): Promise<LocalActionCommandResult> {
  try {
    const result = await runWorkspaceCommand({
      boundary,
      command,
      shell: true,
      protectGitMetadata: true,
      timeoutMs: LOCAL_ACTION_POLICY.timeoutMs,
      ...(onProcess ? { onProcess } : {}),
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut === true, outputLimitExceeded: result.receipt.includes("asked=output-exceeded") };
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) {
      return { exitCode: undefined, stdout: "", stderr: error.message, timedOut: error.code === "workspace.command_timeout", outputLimitExceeded: error.code === "workspace.output_limit" };
    }
    throw error;
  }
}

function ensureAgent(agent: string | undefined): AgentKind {
  if (agent && (AGENT_KINDS as readonly string[]).includes(agent)) return agent as AgentKind;
  throw new LocalAgentError({
    code: "agent.invalid",
    message: `Agent must be one of ${AGENT_KINDS.join(", ")}; asked=${agent ?? "missing"}.`,
    recoveryAction: "rerun anyam agent setup <codex|claude|cursor|cli>",
    receipt: "agent kind was validated against anyam.agent-setup/v1",
  });
}

function agentInstructions(): string {
  return `# Anyam local agent contract\n\nThis project uses Anyam's local agent broker.\n\n- The private-alpha launch path is anyam agent exec <agent> -- <command>; it materializes an enforceable Workspace when the host backend is qualified.\n- anyam agent start and anyam agent exec --mode supervised are developer-supervised local modes. They are explicitly not restricted-source isolation boundaries.\n- Work only in the assigned Change Workspace.\n- Use the Anyam MCP tools for project, Change, Workspace, checks, evidence, review, and revision operations.\n- Never attempt to write canonical Git refs, read secret values, approve a Change, change policy, or promote production.\n- Publish a revision with declared effects after the local checks pass.\n- Treat every budget error as actionable: it names the budget, limit, ask, receipt, and fix.\n- Never print, commit, or store credentials.\n`;
}

function sharedSkill(): string {
  return `---\nname: anyam-change\ndescription: Work safely inside an Anyam Change Workspace.\n---\n\n# Anyam Change\n\n1. Inspect the active Change and Context Manifest.\n2. Read only the Source Spaces named in the manifest.\n3. Make edits in the assigned Workspace.\n4. Run an approved action before publishing.\n5. Declare API, schema, dependency, and infrastructure effects.\n6. Publish a Change revision through Anyam MCP.\n7. Never write canonical source or request secret values.\n8. Treat supervised local mode as developer convenience only; it does not enforce source or credential isolation.\n`;
}

function mergeJsonObject(existing: unknown, key: string, value: unknown): Record<string, unknown> {
  const result = isRecord(existing) ? { ...existing } : {};
  const current = result[key];
  result[key] = isRecord(current) ? { ...current, ...(isRecord(value) ? value : {}) } : value;
  return result;
}

export async function setupAgent(input: { directory: string; agent: string }): Promise<AgentSetupResult> {
  const directory = resolve(input.directory);
  const agent = ensureAgent(input.agent);
  if (!(await exists(join(directory, "anyam.json")))) {
    throw new LocalAgentError({
      code: "project.missing",
      message: `No anyam.json found in ${directory}; setup needs an initialized Anyam Project.`,
      recoveryAction: `run anyam init ${directory} before configuring an agent`,
      receipt: "anyam.json was not found",
    });
  }

  const createdFiles: string[] = [];
  const agentsDirectory = join(directory, ".anyam", "agents");
  const skillDirectory = join(agentsDirectory, "skills", "anyam-change");
  if (await writeJsonIfAbsent(join(agentsDirectory, "manifest.json"), {
    protocol: AGENT_SETUP_PROTOCOL,
    agent,
    broker: { command: "anyam", args: ["mcp", "serve", "--stdio", "--agent", agent], transport: "stdio" },
    credentialStorage: "memory-only",
    canonicalWrite: false,
  })) createdFiles.push(".anyam/agents/manifest.json");
  if (await writeIfAbsent(join(agentsDirectory, "AGENTS.md"), agentInstructions())) createdFiles.push(".anyam/agents/AGENTS.md");
  if (await writeIfAbsent(join(skillDirectory, "SKILL.md"), sharedSkill())) createdFiles.push(".anyam/agents/skills/anyam-change/SKILL.md");
  if (await writeJsonIfAbsent(join(agentsDirectory, "git-credential.json"), {
    protocol: "anyam.git-credential/v1",
    helper: "git-credential-anyam",
    tokenStorage: "memory-only",
    audience: "workspace-only",
    permissions: ["read", "write-workspace"],
    canonicalWrite: false,
  })) createdFiles.push(".anyam/agents/git-credential.json");

  const rootInstructions = join(directory, "AGENTS.md");
  if (await writeIfAbsent(rootInstructions, agentInstructions())) createdFiles.push("AGENTS.md");

  if (agent === "codex") {
    const path = join(directory, ".codex", "config.toml");
    const current = await exists(path) ? await readFile(path, "utf8") : "";
    if (!current.includes("[mcp_servers.anyam]")) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}\n[mcp_servers.anyam]\ncommand = \"anyam\"\nargs = [\"mcp\", \"serve\", \"--stdio\", \"--agent\", \"codex\"]\n`, "utf8");
      createdFiles.push(".codex/config.toml");
    }
  }
  if (agent === "claude") {
    const path = join(directory, ".mcp.json");
    const current = await exists(path) ? await readJson<unknown>(path) : {};
    const merged = mergeJsonObject(current, "mcpServers", {
      anyam: { command: "anyam", args: ["mcp", "serve", "--stdio", "--agent", "claude"] },
    });
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    createdFiles.push(".mcp.json");
  }
  if (agent === "cursor") {
    const path = join(directory, ".cursor", "mcp.json");
    const current = await exists(path) ? await readJson<unknown>(path) : {};
    const merged = mergeJsonObject(current, "mcpServers", {
      anyam: { command: "anyam", args: ["mcp", "serve", "--stdio", "--agent", "cursor"] },
    });
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    createdFiles.push(".cursor/mcp.json");
  }

  return {
    protocol: AGENT_SETUP_PROTOCOL,
    directory,
    agent,
    files: createdFiles,
    broker: { command: "anyam", args: ["mcp", "serve", "--stdio", "--agent", agent], transport: "stdio" },
    credentialStorage: "memory-only",
    canonicalWrite: false,
  };
}

function emptyState(): AgentState {
  return {
    protocol: AGENT_STATE_PROTOCOL,
    authorizationEpoch: 1,
    currentSessionId: null,
    sessions: {},
    grants: {},
    contexts: {},
    credentials: {},
    runs: {},
    findings: {},
    revisions: {},
    audit: [],
  };
}

export class LocalAgentManager {
  readonly directory: string;
  readonly statePathname: string;
  private readonly principalId: string;
  private readonly clientId: string;
  private readonly credentialLifetimeMs: number;
  private readonly sessionLifetimeMs: number;
  private readonly now: () => Date;
  private readonly boundaries = new Map<string, WorkspaceBoundary>();
  private readonly runningProcesses = new Map<string, ChildProcess>();

  constructor(options: LocalAgentManagerOptions) {
    this.directory = resolve(options.directory);
    this.statePathname = localAgentStatePath(this.directory, options.stateDirectory);
    this.principalId = options.principalId ?? "principal:local-owner";
    this.clientId = options.clientId ?? "client:anyam-local-broker";
    this.credentialLifetimeMs = options.credentialLifetimeMs ?? LOCAL_AGENT_POLICY.credentialLifetimeMs;
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? LOCAL_AGENT_POLICY.sessionLifetimeMs;
    this.now = options.now ?? (() => new Date());
    if (!Number.isFinite(this.credentialLifetimeMs) || this.credentialLifetimeMs <= 0) {
      throw new LocalAgentError({ code: "agent.policy.invalid", message: `credential lifetime must be positive; asked=${this.credentialLifetimeMs}`, recoveryAction: "set a positive credentialLifetimeMs", receipt: LOCAL_AGENT_POLICY.receipt });
    }
    if (!Number.isFinite(this.sessionLifetimeMs) || this.sessionLifetimeMs <= 0) {
      throw new LocalAgentError({ code: "agent.policy.invalid", message: `session lifetime must be positive; asked=${this.sessionLifetimeMs}`, recoveryAction: "set a positive sessionLifetimeMs", receipt: LOCAL_AGENT_POLICY.receipt });
    }
  }

  private statePath(): string {
    return this.statePathname;
  }

  private stateLockPath(): string {
    return `${this.statePath()}.lock`;
  }

  private async acquireStateLock(): Promise<() => Promise<void>> {
    const lockPath = this.stateLockPath();
    await mkdir(join(lockPath, ".."), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
          return async () => {
            await handle.close();
            await unlink(lockPath).catch(() => undefined);
          };
        } catch (error) {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
        if (code !== "EEXIST") throw error;
        if (Date.now() - startedAt >= LOCAL_AGENT_POLICY.stateLockTimeoutMs) {
          let stale = false;
          try {
            const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
            if (typeof lock.pid === "number" && lock.pid !== process.pid) {
              try {
                process.kill(lock.pid, 0);
              } catch {
                stale = true;
              }
            }
          } catch {
            stale = true;
          }
          if (stale) {
            await unlink(lockPath).catch(() => undefined);
            continue;
          }
          throw new LocalAgentError({
            code: "agent.state.busy",
            message: `Agent state is locked by another broker; budget=state-lock; limit=${LOCAL_AGENT_POLICY.stateLockTimeoutMs}ms; asked=one exclusive state transaction; no state mutation was performed.`,
            affectedObject: this.statePath(),
            recoveryAction: "wait for the other broker to finish, then retry the operation",
            receipt: `${LOCAL_AGENT_POLICY.receipt}; state-lock-timeout-ms=${LOCAL_AGENT_POLICY.stateLockTimeoutMs}`,
          });
        }
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCAL_AGENT_POLICY.stateLockRetryDelayMs));
      }
    }
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireStateLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async readState(): Promise<AgentState> {
    const path = this.statePath();
    if (!(await exists(path))) return emptyState();
    const value = await readJson<unknown>(path);
    if (!isRecord(value) || value.protocol !== AGENT_STATE_PROTOCOL) {
      throw new LocalAgentError({ code: "agent.state.invalid", message: `Agent state at ${path} does not use ${AGENT_STATE_PROTOCOL}.`, recoveryAction: "move the invalid state aside and rerun anyam agent setup", receipt: "state.json was read" });
    }
    return {
      ...emptyState(),
      ...(value as Partial<AgentState>),
      sessions: isRecord(value.sessions) ? value.sessions as Record<string, LocalAgentSession> : {},
      grants: isRecord(value.grants) ? value.grants as Record<string, LocalCapabilityGrant> : {},
      contexts: isRecord(value.contexts) ? value.contexts as Record<string, AgentContextManifest> : {},
      credentials: isRecord(value.credentials) ? value.credentials as Record<string, StoredCredential> : {},
      runs: isRecord(value.runs) ? value.runs as Record<string, LocalRunObservation> : {},
      findings: isRecord(value.findings) ? value.findings as Record<string, LocalReviewFinding> : {},
      revisions: isRecord(value.revisions) ? value.revisions as Record<string, LocalProposedRevision> : {},
      audit: Array.isArray(value.audit) ? value.audit as AgentAuditEvent[] : [],
    };
  }

  private async writeState(state: AgentState): Promise<void> {
    const path = this.statePath();
    await mkdir(join(path, ".."), { recursive: true });
    await writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
  }

  private record(state: AgentState, event: Omit<AgentAuditEvent, "protocol" | "id" | "occurredAt">): void {
    state.audit.push({ protocol: AGENT_AUDIT_PROTOCOL, id: `audit:${randomUUID()}`, occurredAt: nowIso(this.now), ...event });
  }

  private async projectMetadata(directory = this.directory): Promise<ProjectMetadata> {
    const path = join(directory, "anyam.json");
    let value: unknown;
    try {
      value = await readJson<unknown>(path);
    } catch (error) {
      if (isNotFound(error)) throw new LocalAgentError({ code: "project.missing", message: `No anyam.json found in ${directory}; the agent needs an initialized Project.`, recoveryAction: "run anyam init and rerun anyam agent setup", receipt: "anyam.json was not found" });
      throw error;
    }
    if (!isRecord(value)) throw new LocalAgentError({ code: "project.invalid", message: "anyam.json must be a JSON object; the agent cannot construct a Context Manifest.", recoveryAction: "repair anyam.json and rerun anyam check", receipt: "anyam.json was read" });
    if (!Array.isArray(value.modules) || value.modules.length === 0) throw new LocalAgentError({ code: "run.manifest_invalid", message: "Project Manifest has no declared Modules; no Action run was started.", affectedObject: "modules", recoveryAction: "repair anyam.json and rerun anyam check", receipt: "field=modules; expected=non-empty-array" });
    const actions: LocalDeclaredAction[] = [];
    for (const [moduleIndex, moduleValue] of value.modules.entries()) {
      if (!isRecord(moduleValue)) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Project Manifest module ${moduleIndex} is malformed; no Action run was started.`, affectedObject: `modules[${moduleIndex}]`, recoveryAction: "repair anyam.json and rerun anyam check", receipt: `module-index=${moduleIndex}; expected=object` });
      const moduleId = declaredString(moduleValue.id, `modules[${moduleIndex}].id`);
      const moduleRoot = declaredString(moduleValue.root, `modules[${moduleIndex}].root`);
      if (!Array.isArray(moduleValue.actions) || moduleValue.actions.length === 0) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Project Manifest module ${moduleId} has no declared Actions; no run was started.`, affectedObject: moduleId, recoveryAction: "declare an Action with command, inputs, outputs, network, and resources", receipt: `module=${moduleId}; expected=non-empty-action-array` });
      for (const [actionIndex, actionValue] of moduleValue.actions.entries()) {
        if (!isRecord(actionValue)) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Project Manifest Action ${moduleId}[${actionIndex}] is malformed; no run was started.`, affectedObject: `modules[${moduleIndex}].actions[${actionIndex}]`, recoveryAction: "repair anyam.json and rerun anyam check", receipt: `module=${moduleId}; action-index=${actionIndex}; expected=object` });
        const actionWithoutDigest: Omit<LocalDeclaredAction, "contractDigest"> = {
          id: declaredString(actionValue.id, `modules[${moduleIndex}].actions[${actionIndex}].id`),
          moduleId,
          moduleRoot,
          command: declaredString(actionValue.command, `modules[${moduleIndex}].actions[${actionIndex}].command`),
          inputGlobs: declaredWorkspacePathArray(actionValue.inputs, `modules[${moduleIndex}].actions[${actionIndex}].inputs`),
          outputPaths: declaredWorkspacePathArray(actionValue.outputs, `modules[${moduleIndex}].actions[${actionIndex}].outputs`),
          network: declaredStringArray(actionValue.network, `modules[${moduleIndex}].actions[${actionIndex}].network`),
          resources: declaredResources(actionValue.resources, `modules[${moduleIndex}].actions[${actionIndex}].resources`),
        };
        if (actions.some((candidate) => candidate.id === actionWithoutDigest.id)) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Project Manifest declares duplicate Action ${actionWithoutDigest.id}; no run was started.`, affectedObject: actionWithoutDigest.id, recoveryAction: "give every Action a unique id and rerun anyam check", receipt: `action=${actionWithoutDigest.id}; rule=unique-action-id` });
        actions.push({ ...actionWithoutDigest, contractDigest: localActionContractDigest(actionWithoutDigest) });
      }
    }
    if (!Array.isArray(value.verifiers)) throw new LocalAgentError({ code: "run.manifest_invalid", message: "Project Manifest has no Verifier declarations; no Action run was started.", affectedObject: "verifiers", recoveryAction: "declare a Verifier for the Action and rerun anyam check", receipt: "field=verifiers; expected=array" });
    const verifiers: LocalDeclaredVerifier[] = [];
    for (const [verifierIndex, verifierValue] of value.verifiers.entries()) {
      if (!isRecord(verifierValue)) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Project Manifest Verifier ${verifierIndex} is malformed; no Action run was started.`, affectedObject: `verifiers[${verifierIndex}]`, recoveryAction: "repair anyam.json and rerun anyam check", receipt: `verifier-index=${verifierIndex}; expected=object` });
      const verifierWithoutDigest: Omit<LocalDeclaredVerifier, "contractDigest"> = {
        id: declaredString(verifierValue.id, `verifiers[${verifierIndex}].id`),
        actionId: declaredString(verifierValue.actionId, `verifiers[${verifierIndex}].actionId`),
        disclosure: verifierValue.disclosure === "result-only" ? "result-only" : verifierValue.disclosure === "full" ? "full" : (() => { throw new LocalAgentError({ code: "run.manifest_invalid", message: `Verifier ${String(verifierValue.id)} must declare full or result-only disclosure; no run was started.`, affectedObject: `verifiers[${verifierIndex}].disclosure`, recoveryAction: "repair anyam.json and rerun anyam check", receipt: "verifier disclosure enum" }); })(),
        requiredFor: declaredStringArray(verifierValue.requiredFor, `verifiers[${verifierIndex}].requiredFor`),
      };
      if (!actions.some((action) => action.id === verifierWithoutDigest.actionId)) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Verifier ${verifierWithoutDigest.id} references unknown Action ${verifierWithoutDigest.actionId}; no run was started.`, affectedObject: verifierWithoutDigest.id, recoveryAction: "bind the Verifier to a declared Action and rerun anyam check", receipt: `verifier=${verifierWithoutDigest.id}; action=${verifierWithoutDigest.actionId}; reference=missing` });
      if (verifiers.some((candidate) => candidate.id === verifierWithoutDigest.id)) throw new LocalAgentError({ code: "run.manifest_invalid", message: `Project Manifest declares duplicate Verifier ${verifierWithoutDigest.id}; no run was started.`, affectedObject: verifierWithoutDigest.id, recoveryAction: "give every Verifier a unique id and rerun anyam check", receipt: `verifier=${verifierWithoutDigest.id}; rule=unique-verifier-id` });
      verifiers.push({ ...verifierWithoutDigest, contractDigest: localVerifierContractDigest(verifierWithoutDigest) });
    }
    const manifestDigest = digest(value);
    return {
      id: stringField(value.id, `project:local:${basename(directory)}`),
      name: stringField(value.name, basename(directory)),
      manifestDigest,
      sourceSpaceIds: stringArray(value.sourceSpaceIds),
      actions,
      verifiers,
    };
  }

  private async changeMetadata(): Promise<ChangeMetadata> {
    const path = join(this.directory, ".anyam", "change.json");
    let value: unknown;
    try {
      value = await readJson<unknown>(path);
    } catch (error) {
      if (isNotFound(error)) throw new LocalAgentError({ code: "change.missing", message: `No active Change found in ${this.directory}; an agent needs a Change Workspace.`, recoveryAction: "run anyam change start \"Describe the Change\"", receipt: ".anyam/change.json was not found" });
      throw error;
    }
    if (!isRecord(value)) throw new LocalAgentError({ code: "change.invalid", message: ".anyam/change.json must be a JSON object.", recoveryAction: "repair the Change metadata and rerun anyam change start", receipt: ".anyam/change.json was read" });
    const id = stringField(value.id ?? value.changeId, "");
    const local = isRecord(value.local) ? value.local : {};
    if (!id) throw new LocalAgentError({ code: "change.invalid", message: ".anyam/change.json has no canonical Change id.", recoveryAction: "repair the Change metadata or remove it and start a new Change", receipt: "Change id was missing" });
    return {
      id,
      projectId: stringField(value.projectId, "project:local:unknown"),
      title: stringField(value.title, id),
      baseProjectRevisionId: stringField(value.baseProjectRevisionId, "project-revision:local:working-tree"),
      workspaceId: stringField(local.workspaceId, "workspace:local:working-tree"),
      baseRepositoryId: stringField(local.baseRepositoryId, ""),
    };
  }

  private expireIfNeeded(state: AgentState, session: LocalAgentSession, grant: LocalCapabilityGrant): boolean {
    if (session.status === "active" && !isExpired(session.expiresAt, this.now)) return false;
    if (session.status === "active") session.status = "expired";
    if (grant.status === "active") grant.status = "expired";
    return true;
  }

  private activeSession(state: AgentState): { session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest } | null {
    const id = state.currentSessionId;
    if (!id) return null;
    const session = state.sessions[id];
    if (!session) return null;
    const grant = state.grants[session.grantId];
    const context = state.contexts[session.id];
    if (!grant || !context) return null;
    return { session, grant, context };
  }

  private async requireActiveSessionUnlocked(): Promise<{ state: AgentState; session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
    const state = await this.readState();
    const active = this.activeSession(state);
    if (!active) throw new LocalAgentError({ code: "agent.session.missing", message: "No active local agent session is available for this Project.", recoveryAction: "run anyam agent start <codex|claude|cursor|cli>", receipt: "currentSessionId did not resolve to an active session" });
    if (this.expireIfNeeded(state, active.session, active.grant)) {
      state.currentSessionId = null;
      await this.writeState(state);
      throw new LocalAgentError({ code: "agent.session.expired", message: `Agent session ${active.session.id} expired; no operation was performed.`, affectedObject: active.session.id, recoveryAction: "start a new agent session and retry", receipt: `session-expiry=${active.session.expiresAt}` });
    }
    if (active.grant.status !== "active") throw new LocalAgentError({ code: "agent.grant.revoked", message: `Capability Grant ${active.grant.id} is not active; no operation was performed.`, affectedObject: active.grant.id, recoveryAction: "start a new agent session", receipt: `grant-status=${active.grant.status}` });
    return { state, session: active.session, grant: active.grant, context: active.context };
  }

  private async startSessionUnlocked(input: { agent: string; changeId?: string; mode?: WorkspaceBoundaryMode; authorizedPaths?: readonly string[]; network?: readonly string[]; executablePaths?: readonly string[]; workspaceDirectory?: string }): Promise<{ session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
    const agent = ensureAgent(input.agent);
    const mode = input.mode ?? "supervised";
    const project = await this.projectMetadata();
    const change = await this.changeMetadata();
    if (change.projectId !== project.id) throw new LocalAgentError({ code: "change.project_mismatch", message: `Change ${change.id} belongs to ${change.projectId}, not ${project.id}.`, affectedObject: change.id, recoveryAction: "start the agent from the Change's Project directory", receipt: `manifest-project=${project.id}; change-project=${change.projectId}` });
    if (input.changeId && input.changeId !== change.id) throw new LocalAgentError({ code: "change.not_active", message: `Requested Change ${input.changeId} is not the local active Change ${change.id}.`, affectedObject: input.changeId, recoveryAction: "switch to the Change Workspace before starting the agent", receipt: `active-change=${change.id}` });

    const state = await this.readState();
    const existing = this.activeSession(state);
    if (existing && !this.expireIfNeeded(state, existing.session, existing.grant)) {
      if (existing.session.agent !== agent) throw new LocalAgentError({ code: "agent.session.busy", message: `Change ${change.id} already has an active ${existing.session.agent} session; hand it off before starting ${agent}.`, affectedObject: existing.session.id, recoveryAction: `run anyam agent handoff ${agent}`, receipt: `active-session=${existing.session.id}` });
      const existingMode = existing.session.workspaceMode ?? "supervised";
      if (existingMode !== mode) throw new LocalAgentError({ code: "agent.session.mode_mismatch", message: `Change ${change.id} already has an active ${existingMode} session; it cannot be reused as ${mode}.`, affectedObject: existing.session.id, recoveryAction: "revoke the current session and start a new session with the requested Workspace mode", receipt: `active-mode=${existingMode}; requested-mode=${mode}` });
      await this.writeState(state);
      return { session: clone(existing.session), grant: clone(existing.grant), context: clone(existing.context) };
    }

    const startedAt = nowIso(this.now);
    const sessionId = `agent-session:${randomUUID()}`;
    const taskId = `task:${randomUUID()}`;
    const grantId = `grant:${randomUUID()}`;
    const expires = expiresAt(this.now, this.sessionLifetimeMs);
    const actorId = `agent:${agent}:${randomUUID()}`;
    const resource: AgentResource = { projectId: project.id, changeId: change.id, workspaceId: change.workspaceId };
    const boundary = await createWorkspaceBoundary({
      sourceDirectory: this.directory,
      stateDirectory: resolve(this.statePath(), ".."),
      projectId: project.id,
      changeId: change.id,
      workspaceId: change.workspaceId,
      mode,
      ...(input.authorizedPaths ? { authorizedPaths: input.authorizedPaths } : {}),
      ...(input.network ? { network: input.network } : {}),
      ...(input.executablePaths ? { executablePaths: input.executablePaths } : {}),
      ...(input.workspaceDirectory ? { workspaceDirectory: input.workspaceDirectory } : {}),
      excludedPaths: [this.statePath(), resolve(this.statePath(), "..")],
    });
    boundary.environment = {
      ...boundary.environment,
      ANYAM_WORKSPACE_SESSION_ID: sessionId,
      ANYAM_WORKSPACE_SOURCE_DIRECTORY: this.directory,
      ANYAM_WORKSPACE_STATE_PATH: this.statePath(),
    };
    const grant: LocalCapabilityGrant = {
      protocol: "anyam.capability/v1",
      id: grantId,
      realmId: "realm:local",
      subjectId: actorId,
      resource,
      actions: AGENT_CAPABILITIES,
      deniedActions: PROHIBITED_OPERATIONS,
      canonicalWrite: false,
      issuedAt: startedAt,
      expiresAt: expires,
      authorizationEpoch: state.authorizationEpoch,
      status: "active",
    };
    const context: AgentContextManifest = {
      protocol: AGENT_CONTEXT_PROTOCOL,
      id: `context:${sessionId}`,
      project: { id: project.id, name: project.name, manifestDigest: project.manifestDigest },
      sourceSpaces: { readable: project.sourceSpaceIds, writable: project.sourceSpaceIds, hidden: [] },
      baseProjectRevisionId: change.baseProjectRevisionId,
      changeId: change.id,
      workspaceId: change.workspaceId,
      actorId,
      taskId,
      grantId,
      capabilities: AGENT_CAPABILITIES,
      prohibitedOperations: PROHIBITED_OPERATIONS,
      actions: project.actions.map((action) => action.id),
      verifiers: project.verifiers.map((verifier) => verifier.id),
      authorizationEpoch: state.authorizationEpoch,
      disclosure: "local-owner",
      createdAt: startedAt,
      expiresAt: expires,
      workspaceMode: mode,
      workspaceEnforcement: boundary.enforcement,
      receipt: `${LOCAL_AGENT_POLICY.receipt}; manifest=${project.manifestDigest}; mode=${mode}; enforcement=${boundary.enforcement}; ${boundary.receipt}`,
    };
    const session: LocalAgentSession = {
      protocol: AGENT_SESSION_PROTOCOL,
      id: sessionId,
      taskId,
      grantId,
      agent,
      projectId: project.id,
      changeId: change.id,
      workspaceId: change.workspaceId,
      principalId: this.principalId,
      actorId,
      clientId: this.clientId,
      authorizationEpoch: state.authorizationEpoch,
      startedAt,
      expiresAt: expires,
      status: "active",
      issuedCredentialDigests: [],
      workspaceMode: mode,
      ...(mode === "enforceable" ? {
        workspaceDirectory: boundary.workspaceDirectory,
        workspaceBoundaryId: boundary.id,
        workspaceEnforcement: boundary.enforcement,
        workspaceTemporary: boundary.temporary,
      } : {
        workspaceEnforcement: boundary.enforcement,
      }),
    };
    state.sessions[sessionId] = session;
    state.grants[grantId] = grant;
    state.contexts[sessionId] = context;
    state.currentSessionId = sessionId;
    this.boundaries.set(sessionId, boundary);
    this.record(state, { operation: "session.started", outcome: "observed", sessionId, grantId, taskId, projectId: project.id, changeId: change.id, workspaceId: change.workspaceId, actorId, agent, details: { receipt: context.receipt } });
    await this.writeState(state);
    return { session, grant, context };
  }

  async startSession(input: { agent: string; changeId?: string; mode?: WorkspaceBoundaryMode; authorizedPaths?: readonly string[]; network?: readonly string[]; executablePaths?: readonly string[]; workspaceDirectory?: string }): Promise<{ session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
    return this.withStateLock(() => this.startSessionUnlocked(input));
  }

  async ensureActiveSession(agent: string): Promise<{ session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
    return this.withStateLock(async () => {
      const requested = ensureAgent(agent);
      const state = await this.readState();
      const active = this.activeSession(state);
      if (active && !this.expireIfNeeded(state, active.session, active.grant) && active.session.agent === requested) {
        await this.writeState(state);
        return { session: clone(active.session), grant: clone(active.grant), context: clone(active.context) };
      }
      return this.startSessionUnlocked({ agent: requested });
    });
  }

  private async revokeUnlocked(sessionId?: string): Promise<{ sessionId: string; grantId: string; status: "revoked" | "missing" }> {
    const state = await this.readState();
    const id = sessionId ?? state.currentSessionId;
    if (!id || !state.sessions[id]) return { sessionId: id ?? "", grantId: "", status: "missing" };
    const session = state.sessions[id];
    const grant = state.grants[session.grantId];
    const running = this.runningProcesses.get(id);
    await terminateWorkspaceProcess({ ...(running ? { process: running } : {}), ...(session.processGroupId ? { processGroupId: session.processGroupId } : {}) });
    this.runningProcesses.delete(id);
    const revokedAt = nowIso(this.now);
    session.status = "revoked";
    session.revokedAt = revokedAt;
    if (grant) grant.status = "revoked";
    state.authorizationEpoch += 1;
    if (state.currentSessionId === id) state.currentSessionId = null;
    this.record(state, { operation: "session.revoked", outcome: "observed", sessionId: id, grantId: session.grantId, taskId: session.taskId, projectId: session.projectId, changeId: session.changeId, workspaceId: session.workspaceId, actorId: session.actorId, agent: session.agent, details: { authorizationEpoch: state.authorizationEpoch } });
    await this.writeState(state);
    const boundary = this.boundaries.get(id) ?? (session.workspaceTemporary && session.workspaceDirectory ? {
      protocol: "anyam.workspace-boundary/v1" as const,
      id: session.workspaceBoundaryId ?? `boundary:restored:${id}`,
      mode: session.workspaceMode ?? "enforceable",
      enforcement: session.workspaceEnforcement ?? "none",
      workspaceDirectory: session.workspaceDirectory,
      sourceDirectory: this.directory,
      mounts: [],
      network: [],
      networkEnforcement: "not-enforced" as const,
      environment: {},
      executablePaths: [],
      temporary: true,
      receipt: "boundary=restored-for-cross-process-cleanup",
    } : undefined);
    this.boundaries.delete(id);
    if (boundary) await removeWorkspaceBoundary(boundary);
    return { sessionId: id, grantId: session.grantId, status: "revoked" };
  }

  async revoke(sessionId?: string): Promise<{ sessionId: string; grantId: string; status: "revoked" | "missing" }> {
    return this.withStateLock(() => this.revokeUnlocked(sessionId));
  }

  async launchAgent(input: AgentLaunchInput): Promise<AgentLaunchResult> {
    const mode = input.mode ?? "enforceable";
    const started = await this.startSession({
      agent: input.agent,
      mode,
      ...(input.authorizedPaths ? { authorizedPaths: input.authorizedPaths } : {}),
      ...(input.network ? { network: input.network } : {}),
      executablePaths: [input.command],
      ...(input.workspaceDirectory ? { workspaceDirectory: input.workspaceDirectory } : {}),
    });
    const boundary = this.boundaries.get(started.session.id);
    if (!boundary) throw new LocalAgentError({ code: "workspace.boundary_missing", message: `Agent session ${started.session.id} has no live Workspace boundary; no process was started.`, affectedObject: started.session.id, recoveryAction: "revoke the session and start the agent again through the boundary launcher", receipt: `mode=${mode}; boundary=missing` });
    await this.withStateLock(async () => {
      const state = await this.readState();
      this.record(state, { operation: "agent.process.started", outcome: "observed", sessionId: started.session.id, grantId: started.grant.id, taskId: started.session.taskId, projectId: started.session.projectId, changeId: started.session.changeId, workspaceId: started.session.workspaceId, actorId: started.session.actorId, agent: started.session.agent, details: { command: input.command, args: input.args ?? [], mode, enforcement: boundary.enforcement, workspaceDirectory: boundary.workspaceDirectory, canonicalWrite: false, receipt: boundary.receipt } });
      await this.writeState(state);
    });
    let commandResult: Awaited<ReturnType<typeof runWorkspaceCommand>>;
    try {
      commandResult = await runWorkspaceCommand({
        boundary,
        command: input.command,
        ...(input.args ? { args: input.args } : {}),
        onProcess: (child) => {
          this.runningProcesses.set(started.session.id, child);
          void this.withStateLock(async () => {
            const state = await this.readState();
            const session = state.sessions[started.session.id];
            if (session && child.pid) {
              session.processPid = child.pid;
              session.processGroupId = child.pid;
              await this.writeState(state);
            }
          });
        },
      });
    } finally {
      this.runningProcesses.delete(started.session.id);
      await this.withStateLock(async () => {
        const state = await this.readState();
        const session = state.sessions[started.session.id];
        if (session) {
          delete session.processPid;
          delete session.processGroupId;
          await this.writeState(state);
        }
      });
    }
    await this.withStateLock(async () => {
      const state = await this.readState();
      this.record(state, { operation: "agent.process.completed", outcome: "observed", sessionId: started.session.id, grantId: started.grant.id, taskId: started.session.taskId, projectId: started.session.projectId, changeId: started.session.changeId, workspaceId: started.session.workspaceId, actorId: started.session.actorId, agent: started.session.agent, details: { command: input.command, args: input.args ?? [], status: commandResult.status, exitCode: commandResult.exitCode, signal: commandResult.signal, mode, enforcement: boundary.enforcement, receipt: commandResult.receipt } });
      await this.writeState(state);
    });
    return { session: clone(started.session), boundary, command: commandResult };
  }

  async handoff(input: { agent: string; changeId?: string }): Promise<{ previousSessionId: string | null; next: Awaited<ReturnType<LocalAgentManager["startSession"]>> }> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const previousSessionId = state.currentSessionId;
      if (previousSessionId) await this.revokeUnlocked(previousSessionId);
      const next = await this.startSessionUnlocked({ agent: input.agent, ...(input.changeId ? { changeId: input.changeId } : {}) });
      const nextState = await this.readState();
      this.record(nextState, { operation: "session.handoff", outcome: "observed", sessionId: next.session.id, grantId: next.grant.id, taskId: next.session.taskId, projectId: next.session.projectId, changeId: next.session.changeId, workspaceId: next.session.workspaceId, actorId: next.session.actorId, agent: next.session.agent, details: { previousSessionId } });
      await this.writeState(nextState);
      return { previousSessionId, next };
    });
  }

  async status(): Promise<AgentStatus> {
    return this.withStateLock(async () => {
      const state = await this.readState();
      const active = this.activeSession(state);
      if (active && this.expireIfNeeded(state, active.session, active.grant)) {
        state.currentSessionId = null;
        await this.writeState(state);
        return { session: null, grant: null, context: null, activeCredentialCount: 0, auditCount: state.audit.length };
      }
      const activeCredentialCount = active ? Object.values(state.credentials).filter((credential) => credential.sessionId === active.session.id && !isExpired(credential.expiresAt, this.now)).length : 0;
      return { session: active ? clone(active.session) : null, grant: active ? clone(active.grant) : null, context: active ? clone(active.context) : null, activeCredentialCount, auditCount: state.audit.length };
    });
  }

  async issueWorkspaceCredential(sessionId?: string): Promise<WorkspaceCredential> {
    return this.withStateLock(async () => {
      const active = await this.requireActiveSessionUnlocked();
      if (sessionId && sessionId !== active.session.id) throw new LocalAgentError({ code: "credential.session_mismatch", message: `Credential request targeted ${sessionId}, not the active session ${active.session.id}.`, affectedObject: sessionId, recoveryAction: "request a credential for the active Change Workspace", receipt: `active-session=${active.session.id}` });
      const issuedAt = nowIso(this.now);
      const expiry = expiresAt(this.now, this.credentialLifetimeMs);
      const token = randomBytes(32).toString("base64url");
      const tokenDigest = digest(token);
      const audience = `git:workspace:${active.session.workspaceId}`;
      active.state.credentials[tokenDigest] = { digest: tokenDigest, sessionId: active.session.id, audience, workspaceId: active.session.workspaceId, issuedAt, expiresAt: expiry };
      active.session.issuedCredentialDigests.push(tokenDigest);
      this.record(active.state, { operation: "credential.issued", outcome: "observed", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: active.session.changeId, workspaceId: active.session.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { audience, permissions: ["read", "write-workspace"], canonicalWrite: false, receipt: `${LOCAL_AGENT_POLICY.receipt}; credential-ttl-ms=${this.credentialLifetimeMs}` } });
      await this.writeState(active.state);
      return { protocol: "anyam.git-credential/v1", token, audience, sessionId: active.session.id, projectId: active.session.projectId, changeId: active.session.changeId, workspaceId: active.session.workspaceId, permissions: ["read", "write-workspace"], canonicalWrite: false, issuedAt, expiresAt: expiry };
    });
  }

  async validateWorkspaceCredential(credential: WorkspaceCredential): Promise<{ valid: true; sessionId: string; workspaceId: string } | { valid: false; code: string }> {
    const state = await this.readState();
    const tokenDigest = digest(credential.token);
    const stored = state.credentials[tokenDigest];
    const session = stored ? state.sessions[stored.sessionId] : undefined;
    const grant = session ? state.grants[session.grantId] : undefined;
    if (!stored || !session || !grant) return { valid: false, code: "credential.unknown" };
    if (session.status !== "active" || grant.status !== "active") return { valid: false, code: "credential.session_inactive" };
    if (isExpired(stored.expiresAt, this.now)) return { valid: false, code: "credential.expired" };
    if (credential.audience !== stored.audience || credential.workspaceId !== stored.workspaceId || credential.canonicalWrite || !credential.permissions.includes("write-workspace")) return { valid: false, code: "credential.boundary_mismatch" };
    return { valid: true, sessionId: session.id, workspaceId: session.workspaceId };
  }

  private async denial(active: { state: AgentState; session: LocalAgentSession; grant: LocalCapabilityGrant }, operation: string): Promise<never> {
    this.record(active.state, { operation: "tool.denied", outcome: "denied", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: active.session.changeId, workspaceId: active.session.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { operation, reason: "explicitly prohibited", canonicalWrite: false } });
    await this.writeState(active.state);
    throw new LocalAgentError({ code: "agent.operation.denied", message: `Operation ${operation} is denied for this agent session; canonical source and production authority remain outside the local broker.`, affectedObject: active.session.id, recoveryAction: "use the Change revision and review workflow; ask a human for protected operations", receipt: `deniedActions=${PROHIBITED_OPERATIONS.join(",")}` });
  }

  private async appendToolAudit(active: { state: AgentState; session: LocalAgentSession; grant: LocalCapabilityGrant }, name: string): Promise<void> {
    this.record(active.state, { operation: "tool.invoked", outcome: "allowed", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: active.session.changeId, workspaceId: active.session.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { tool: name } });
    await this.writeState(active.state);
  }

  private async prepareRunStart(args: Record<string, unknown>): Promise<{
    session: LocalAgentSession;
    grant: LocalCapabilityGrant;
    project: ProjectMetadata;
    change: ChangeMetadata;
    boundary: WorkspaceBoundary;
    source: Awaited<ReturnType<typeof inspectGitSource>>;
    inputs: Awaited<ReturnType<typeof localInputDigests>>;
    action: LocalDeclaredAction;
    verifier?: LocalDeclaredVerifier;
    startedAt: string;
    toolchainDigest: string;
    environmentDigest: string;
    runId: string;
    evidenceId: string;
  }> {
    return this.withStateLock(async () => {
      const active = await this.requireActiveSessionUnlocked();
      if (!LOCAL_MCP_TOOLS.some((entry) => entry.name === "run.start")) return this.denial(active, "run.start");
      const project = await this.projectMetadata();
      const change = await this.changeMetadata();
      const boundary = this.boundaries.get(active.session.id);
      if (!boundary) throw new LocalAgentError({ code: "workspace.boundary_missing", message: `Agent session ${active.session.id} has no live Workspace Runner boundary; no Action run was started.`, affectedObject: active.session.id, recoveryAction: "start a new agent session through the Workspace Runner", receipt: "run=not-started; boundary=missing; canonicalWrite=false" });
      const actionId = stringField(args.actionId, "");
      const action = project.actions.find((candidate) => candidate.id === actionId);
      if (!action) throw new LocalAgentError({ code: "run.action_unknown", message: `Action ${actionId || "missing"} is not declared by the Project; no run was started.`, affectedObject: actionId || "action:missing", recoveryAction: `choose one of ${project.actions.map((candidate) => candidate.id).join(", ") || "the actions in anyam.json"}`, receipt: `declared-actions=${project.actions.map((candidate) => candidate.id).join(",")}` });
      const requestedVerifierId = stringField(args.verifierId, "");
      const verifier = requestedVerifierId
        ? project.verifiers.find((candidate) => candidate.id === requestedVerifierId)
        : project.verifiers.find((candidate) => candidate.actionId === action.id);
      if (requestedVerifierId && !verifier) throw new LocalAgentError({ code: "run.verifier_unknown", message: `Verifier ${requestedVerifierId} is not declared by the Project; no run was started.`, affectedObject: requestedVerifierId, recoveryAction: `choose one of ${project.verifiers.map((candidate) => candidate.id).join(", ") || "the verifiers in anyam.json"}`, receipt: `declared-verifiers=${project.verifiers.map((candidate) => candidate.id).join(",")}` });
      if (verifier && verifier.actionId !== action.id) throw new LocalAgentError({ code: "run.verifier_mismatch", message: `Verifier ${verifier.id} is bound to Action ${verifier.actionId}, not ${action.id}; no run was started.`, affectedObject: verifier.id, recoveryAction: "select the Verifier bound to the requested Action", receipt: `verifier=${verifier.id}; action=${action.id}; reference=mismatch` });
      let source: Awaited<ReturnType<typeof inspectGitSource>>;
      try {
        source = await inspectGitSource(boundary.workspaceDirectory);
      } catch (error) {
        if (error instanceof LocalGitSourceError) throw new LocalAgentError({ code: error.code, message: `${error.message} No Action run was started.`, affectedObject: change.id, recoveryAction: error.recoveryAction, receipt: `run=${action.id}; git-code=${error.code}` });
        throw error;
      }
      if (!source.clean) throw new LocalAgentError({ code: "run.source_dirty", message: `Action ${action.id} requires a clean committed source revision; no run was started. budget=git.worktree; limit=clean source tree; asked=${source.changedPaths.length} changed paths.`, affectedObject: source.repositoryId, recoveryAction: "commit or discard changes before starting the Action", receipt: `git-status=dirty; changed-paths=${source.changedPaths.length}` });
      const protectedPaths = protectedOutputPaths(action.outputPaths, await trackedGitPaths(boundary.workspaceDirectory));
      if (protectedPaths.length > 0) throw new LocalAgentError({ code: "run.output_source_overlap", message: `Action ${action.id} declares protected output paths ${protectedPaths.join(", ")} that overlap tracked source or trusted metadata; no run was started.`, affectedObject: protectedPaths.join(","), recoveryAction: "write outputs beneath a dedicated untracked artifact directory", receipt: `output-source-overlap=${protectedPaths.join(",")}; canonicalWrite=false` });
      return {
        session: clone(active.session),
        grant: clone(active.grant),
        project,
        change,
        boundary,
        source,
        inputs: await localInputDigests(boundary.workspaceDirectory, action.inputGlobs),
        action,
        ...(verifier ? { verifier } : {}),
        startedAt: nowIso(this.now),
        toolchainDigest: digest({ node: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath }),
        environmentDigest: digest({ cwd: boundary.workspaceDirectory, nodeEnv: process.env.NODE_ENV ?? "", shell: process.platform === "win32" ? "cmd.exe" : "sh", workspaceMode: boundary.mode, networkEnforcement: boundary.networkEnforcement }),
        runId: `run:${randomUUID()}`,
        evidenceId: `evidence:${randomUUID()}`,
      };
    });
  }

  private async invokeRunStart(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prepared = await this.prepareRunStart(args);
    let processRegistration: Promise<void> | undefined;
    let commandResult: LocalActionCommandResult;
    try {
      commandResult = prepared.inputs.missing.length === 0
        ? await executeDeclaredAction(prepared.boundary, prepared.action.command, (child) => {
          this.runningProcesses.set(prepared.session.id, child);
          processRegistration = this.withStateLock(async () => {
            const state = await this.readState();
            const session = state.sessions[prepared.session.id];
            if (session && child.pid) {
              session.processPid = child.pid;
              session.processGroupId = child.pid;
              await this.writeState(state);
            }
          });
        })
        : { exitCode: undefined, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false };
      if (processRegistration) await processRegistration;
    } finally {
      this.runningProcesses.delete(prepared.session.id);
    }
    let sourceMutated = false;
    if (prepared.boundary.mode === "enforceable") {
      try {
        const after = await inspectGitSource(prepared.boundary.workspaceDirectory);
        const allowedOutputs = new Set(prepared.action.outputPaths);
        sourceMutated = after.commitId !== prepared.source.commitId
          || after.treeId !== prepared.source.treeId
          || after.changedPaths.some((path) => !path.startsWith(".anyam/") && !allowedOutputs.has(path));
      } catch {
        sourceMutated = true;
      }
    }
    const outputs = commandResult.exitCode === 0 && !commandResult.timedOut && !commandResult.outputLimitExceeded
      ? await localOutputDigests(prepared.boundary.workspaceDirectory, prepared.action.outputPaths)
      : { digests: [], missing: [] };
    const failureReason = prepared.inputs.missing.length > 0
      ? `missing-input-patterns=${prepared.inputs.missing.join(",")}`
      : sourceMutated
        ? "source-mutated-during-run"
        : commandResult.timedOut
          ? `budget=action.timeout; limit=${LOCAL_ACTION_POLICY.timeoutMs}ms; asked=command exceeded the execution boundary`
          : commandResult.outputLimitExceeded
            ? `budget=action.output; limit=${LOCAL_ACTION_POLICY.maxOutputBytes}bytes; asked=stdout or stderr exceeded the execution boundary`
            : outputs.error
              ? outputs.error
            : commandResult.exitCode !== 0
              ? `exit-code=${commandResult.exitCode ?? "unknown"}`
              : outputs.missing.length > 0
                ? `missing-output-paths=${outputs.missing.join(",")}`
                : undefined;
    const inputDigests = prepared.inputs.digests;
    const outputDigests = outputs.digests;
    const stdoutDigest = digest(commandResult.stdout);
    const stderrDigest = digest(commandResult.stderr);
    const outputDigest = digest({ outputDigests, stdoutDigest, stderrDigest, exitCode: commandResult.exitCode });

    return this.withStateLock(async () => {
      const state = await this.readState();
      const session = state.sessions[prepared.session.id];
      const grant = session ? state.grants[session.grantId] : undefined;
      const revokedDuringRun = !session || !grant || session.status !== "active" || grant.status !== "active";
      const status = revokedDuringRun ? "blocked" : failureReason ? "failed" : "passed";
      const completedAt = nowIso(this.now);
      const finalReason = revokedDuringRun ? "session-revoked-during-run" : failureReason;
      const evidenceDigest = digest({ actionId: prepared.action.id, verifierId: prepared.verifier?.id ?? "verifier:missing", sourceRevision: gitCommitIdentity(prepared.source.commitId), sourceSnapshot: `git:snapshot:${prepared.source.commitId}`, inputDigests, outputDigests, outputDigest, stdoutDigest, stderrDigest, status, sourceMutated, actorId: prepared.session.actorId, grantId: prepared.grant.id });
      const observation: LocalRunObservation = {
        id: prepared.runId,
        actionId: prepared.action.id,
        status,
        evidenceId: prepared.evidenceId,
        evidenceDigest,
        startedAt: prepared.startedAt,
        completedAt,
        sourceRevision: gitCommitIdentity(prepared.source.commitId),
        sourceSnapshot: `git:snapshot:${prepared.source.commitId}`,
        actionContractDigest: prepared.action.contractDigest,
        verifierId: prepared.verifier?.id ?? "verifier:missing",
        ...(prepared.verifier ? { verifierContractDigest: prepared.verifier.contractDigest } : {}),
        ...(commandResult.exitCode !== undefined ? { exitCode: commandResult.exitCode } : {}),
        stdoutDigest,
        stderrDigest,
        inputDigests,
        outputDigests,
        outputDigest,
        toolchainDigest: prepared.toolchainDigest,
        environmentDigest: prepared.environmentDigest,
        actorId: prepared.session.actorId,
        grantId: prepared.grant.id,
        taskId: prepared.session.taskId,
        receipt: `${LOCAL_ACTION_POLICY.receipt}; action=${prepared.action.id}; verifier=${prepared.verifier?.id ?? "verifier:missing"}; source=${gitCommitIdentity(prepared.source.commitId)}; boundary=${prepared.boundary.id}; enforcement=${prepared.boundary.enforcement}; networkEnforcement=${prepared.boundary.networkEnforcement}; inputs=${inputDigests.length}; outputs=${outputDigests.length}; ${finalReason ?? "status=passed"}`,
      };
      state.runs[prepared.runId] = observation;
      this.record(state, { operation: "run.completed", outcome: "observed", sessionId: prepared.session.id, grantId: prepared.grant.id, taskId: prepared.session.taskId, projectId: prepared.project.id, changeId: prepared.change.id, workspaceId: prepared.change.workspaceId, actorId: prepared.session.actorId, agent: prepared.session.agent, details: { runId: prepared.runId, evidenceId: prepared.evidenceId, actionId: prepared.action.id, verifierId: prepared.verifier?.id ?? "verifier:missing", status, sourceRevision: gitCommitIdentity(prepared.source.commitId), inputDigests, outputDigests, outputDigest, stdoutDigest, stderrDigest, toolchainDigest: prepared.toolchainDigest, environmentDigest: prepared.environmentDigest, exitCode: commandResult.exitCode, failureReason: finalReason } });
      this.record(state, { operation: "tool.invoked", outcome: "allowed", sessionId: prepared.session.id, grantId: prepared.grant.id, taskId: prepared.session.taskId, projectId: prepared.project.id, changeId: prepared.change.id, workspaceId: prepared.change.workspaceId, actorId: prepared.session.actorId, agent: prepared.session.agent, details: { tool: "run.start", boundary: prepared.boundary.id, enforcement: prepared.boundary.enforcement, networkEnforcement: prepared.boundary.networkEnforcement } });
      const currentSession = state.sessions[prepared.session.id];
      if (currentSession) {
        delete currentSession.processPid;
        delete currentSession.processGroupId;
      }
      await this.writeState(state);
      return { run: observation, evidence: { id: prepared.evidenceId, digest: evidenceDigest, status, actionId: prepared.action.id, verifierId: prepared.verifier?.id ?? "verifier:missing", sourceRevision: gitCommitIdentity(prepared.source.commitId), actionContractDigest: prepared.action.contractDigest, ...(prepared.verifier ? { verifierContractDigest: prepared.verifier.contractDigest } : {}), inputDigests, outputDigests, outputDigest, stdoutDigest, stderrDigest, toolchainDigest: prepared.toolchainDigest, environmentDigest: prepared.environmentDigest, exitCode: commandResult.exitCode, actorId: prepared.session.actorId, grantId: prepared.grant.id, receipt: observation.receipt }, canonicalWrite: false };
    });
  }

  private async invokeToolUnlocked(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const active = await this.requireActiveSessionUnlocked();
    if (!LOCAL_MCP_TOOLS.some((entry) => entry.name === name)) return this.denial(active, name);
    const project = await this.projectMetadata();
    const change = await this.changeMetadata();
    const boundary = this.boundaries.get(active.session.id);
    if (!boundary) throw new LocalAgentError({ code: "workspace.boundary_missing", message: `Agent session ${active.session.id} has no live Workspace Runner boundary; no Action run was started.`, affectedObject: active.session.id, recoveryAction: "start a new agent session through the Workspace Runner", receipt: `run=not-started; boundary=missing; canonicalWrite=false` });
    const executionDirectory = boundary.workspaceDirectory;
    if (name === "project.inspect") {
      await this.appendToolAudit(active, name);
      return { project: { id: project.id, name: project.name, manifestDigest: project.manifestDigest }, sourceSpaces: { readable: project.sourceSpaceIds, writable: project.sourceSpaceIds, hidden: [] }, changeId: change.id, workspaceId: change.workspaceId, canonicalWrite: false };
    }
    if (name === "change.inspect") {
      await this.appendToolAudit(active, name);
      const state = active.state;
      return { change: { id: change.id, projectId: change.projectId, title: change.title, baseProjectRevisionId: change.baseProjectRevisionId, workspaceId: change.workspaceId }, latestRevision: Object.values(state.revisions).filter((revision) => revision.changeId === change.id).at(-1) ?? null, findings: Object.values(state.findings), runs: Object.values(state.runs), canonicalWrite: false };
    }
    if (name === "workspace.inspect") {
      await this.appendToolAudit(active, name);
      return { workspace: active.grant.resource, sessionId: active.session.id, contextId: active.context.id, capabilities: active.grant.actions, prohibitedOperations: active.grant.deniedActions, canonicalWrite: false };
    }
    if (name === "run.start") {
      const actionId = stringField(args.actionId, "");
      const action = project.actions.find((candidate) => candidate.id === actionId);
      if (!action) throw new LocalAgentError({ code: "run.action_unknown", message: `Action ${actionId || "missing"} is not declared by the Project; no run was started.`, affectedObject: actionId || "action:missing", recoveryAction: `choose one of ${project.actions.map((candidate) => candidate.id).join(", ") || "the actions in anyam.json"}`, receipt: `declared-actions=${project.actions.map((candidate) => candidate.id).join(",")}` });
      const requestedVerifierId = stringField(args.verifierId, "");
      const verifier = requestedVerifierId
        ? project.verifiers.find((candidate) => candidate.id === requestedVerifierId)
        : project.verifiers.find((candidate) => candidate.actionId === action.id);
      if (requestedVerifierId && !verifier) throw new LocalAgentError({ code: "run.verifier_unknown", message: `Verifier ${requestedVerifierId} is not declared by the Project; no run was started.`, affectedObject: requestedVerifierId, recoveryAction: `choose one of ${project.verifiers.map((candidate) => candidate.id).join(", ") || "the verifiers in anyam.json"}`, receipt: `declared-verifiers=${project.verifiers.map((candidate) => candidate.id).join(",")}` });
      if (verifier && verifier.actionId !== action.id) throw new LocalAgentError({ code: "run.verifier_mismatch", message: `Verifier ${verifier.id} is bound to Action ${verifier.actionId}, not ${action.id}; no run was started.`, affectedObject: verifier.id, recoveryAction: "select the Verifier bound to the requested Action", receipt: `verifier=${verifier.id}; action=${action.id}; reference=mismatch` });
      let source: Awaited<ReturnType<typeof inspectGitSource>>;
      try {
        source = await inspectGitSource(executionDirectory);
      } catch (error) {
        if (error instanceof LocalGitSourceError) throw new LocalAgentError({ code: error.code, message: `${error.message} No Action run was started.`, affectedObject: change.id, recoveryAction: error.recoveryAction, receipt: `run=${action.id}; git-code=${error.code}` });
        throw error;
      }
      if (!source.clean) throw new LocalAgentError({ code: "run.source_dirty", message: `Action ${action.id} requires a clean committed source revision; no run was started. budget=git.worktree; limit=clean source tree; asked=${source.changedPaths.length} changed paths.`, affectedObject: source.repositoryId, recoveryAction: "commit or discard changes before starting the Action", receipt: `git-status=dirty; changed-paths=${source.changedPaths.length}` });
      const startedAt = nowIso(this.now);
      const inputs = await localInputDigests(executionDirectory, action.inputGlobs);
      const toolchainDigest = digest({ node: process.version, platform: process.platform, arch: process.arch, execPath: process.execPath });
      const environmentDigest = digest({ cwd: executionDirectory, nodeEnv: process.env.NODE_ENV ?? "", shell: process.platform === "win32" ? "cmd.exe" : "sh", workspaceMode: active.session.workspaceMode ?? "supervised" });
      const commandResult: LocalActionCommandResult = inputs.missing.length === 0 ? await executeDeclaredAction(boundary, action.command, (child) => {
        this.runningProcesses.set(active.session.id, child);
        void this.withStateLock(async () => {
          const state = await this.readState();
          const session = state.sessions[active.session.id];
          if (session && child.pid) {
            session.processPid = child.pid;
            session.processGroupId = child.pid;
            await this.writeState(state);
          }
        });
      }) : { exitCode: undefined, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false };
      this.runningProcesses.delete(active.session.id);
      delete active.session.processPid;
      delete active.session.processGroupId;
      let sourceMutated = false;
      if (boundary.mode === "enforceable") {
        try {
          const after = await inspectGitSource(executionDirectory);
          const allowedOutputs = new Set(action.outputPaths);
          sourceMutated = after.commitId !== source.commitId
            || after.treeId !== source.treeId
            || after.changedPaths.some((path) => !path.startsWith(".anyam/") && !allowedOutputs.has(path));
        } catch {
          sourceMutated = true;
        }
      }
      const outputs = commandResult.exitCode === 0 && !commandResult.timedOut && !commandResult.outputLimitExceeded ? await localOutputDigests(executionDirectory, action.outputPaths) : { digests: [], missing: [] };
      const failureReason = inputs.missing.length > 0
        ? `missing-input-patterns=${inputs.missing.join(",")}`
        : sourceMutated
          ? "source-mutated-during-run"
        : commandResult.timedOut
          ? `budget=action.timeout; limit=${LOCAL_ACTION_POLICY.timeoutMs}ms; asked=command exceeded the execution boundary`
          : commandResult.outputLimitExceeded
            ? `budget=action.output; limit=${LOCAL_ACTION_POLICY.maxOutputBytes}bytes; asked=stdout or stderr exceeded the execution boundary`
            : outputs.error
              ? outputs.error
            : commandResult.exitCode !== 0
              ? `exit-code=${commandResult.exitCode ?? "unknown"}`
              : outputs.missing.length > 0
                ? `missing-output-paths=${outputs.missing.join(",")}`
                : undefined;
      const status = failureReason ? "failed" : "passed";
      const completedAt = nowIso(this.now);
      const inputDigests = inputs.digests;
      const outputDigests = outputs.digests;
      const stdoutDigest = digest(commandResult.stdout);
      const stderrDigest = digest(commandResult.stderr);
      const outputDigest = digest({ outputDigests, stdoutDigest, stderrDigest, exitCode: commandResult.exitCode });
      const runId = `run:${randomUUID()}`;
      const evidenceId = `evidence:${randomUUID()}`;
      const evidenceDigest = digest({ actionId, verifierId: verifier?.id ?? "verifier:missing", sourceRevision: gitCommitIdentity(source.commitId), sourceSnapshot: `git:snapshot:${source.commitId}`, inputDigests, outputDigests, outputDigest, stdoutDigest, stderrDigest, status, sourceMutated, actorId: active.session.actorId, grantId: active.grant.id });
      const observation: LocalRunObservation = {
        id: runId,
        actionId,
        status,
        evidenceId,
        evidenceDigest,
        startedAt,
        completedAt,
        sourceRevision: gitCommitIdentity(source.commitId),
        sourceSnapshot: `git:snapshot:${source.commitId}`,
        actionContractDigest: action.contractDigest,
        verifierId: verifier?.id ?? "verifier:missing",
        ...(verifier ? { verifierContractDigest: verifier.contractDigest } : {}),
        ...(commandResult.exitCode !== undefined ? { exitCode: commandResult.exitCode } : {}),
        stdoutDigest,
        stderrDigest,
        inputDigests,
        outputDigests,
        outputDigest,
        toolchainDigest,
        environmentDigest,
        actorId: active.session.actorId,
        grantId: active.grant.id,
        taskId: active.session.taskId,
        receipt: `${LOCAL_ACTION_POLICY.receipt}; action=${actionId}; verifier=${verifier?.id ?? "verifier:missing"}; source=${gitCommitIdentity(source.commitId)}; boundary=${boundary.id}; enforcement=${boundary.enforcement}; networkEnforcement=${boundary.networkEnforcement}; inputs=${inputDigests.length}; outputs=${outputDigests.length}; ${failureReason ?? "status=passed"}`,
      };
      active.state.runs[runId] = observation;
      this.record(active.state, { operation: "run.completed", outcome: "observed", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: change.id, workspaceId: change.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { runId, evidenceId, actionId, verifierId: verifier?.id ?? "verifier:missing", status, sourceRevision: gitCommitIdentity(source.commitId), inputDigests, outputDigests, outputDigest, stdoutDigest, stderrDigest, toolchainDigest, environmentDigest, exitCode: commandResult.exitCode, failureReason } });
      await this.writeState(active.state);
      return { run: observation, evidence: { id: evidenceId, digest: evidenceDigest, status, actionId, verifierId: verifier?.id ?? "verifier:missing", sourceRevision: gitCommitIdentity(source.commitId), actionContractDigest: action.contractDigest, ...(verifier ? { verifierContractDigest: verifier.contractDigest } : {}), inputDigests, outputDigests, outputDigest, stdoutDigest, stderrDigest, toolchainDigest, environmentDigest, exitCode: commandResult.exitCode, actorId: active.session.actorId, grantId: active.grant.id, receipt: observation.receipt }, canonicalWrite: false };
    }
    if (name === "run.inspect") {
      const runId = stringField(args.runId, "");
      const run = active.state.runs[runId];
      if (!run) throw new LocalAgentError({ code: "run.missing", message: `Run ${runId || "missing"} was not found in this task session.`, affectedObject: runId || "run:missing", recoveryAction: "inspect the Change for the available run ids", receipt: "run ledger lookup" });
      await this.appendToolAudit(active, name);
      return { run, canonicalWrite: false };
    }
    if (name === "evidence.inspect") {
      const evidenceId = stringField(args.evidenceId, "");
      const run = Object.values(active.state.runs).find((candidate) => candidate.evidenceId === evidenceId);
      if (!run) throw new LocalAgentError({ code: "evidence.missing", message: `Evidence ${evidenceId || "missing"} was not found in this task session.`, affectedObject: evidenceId || "evidence:missing", recoveryAction: "inspect the Change for the available evidence ids", receipt: "evidence ledger lookup" });
      await this.appendToolAudit(active, name);
      return { evidence: { id: run.evidenceId, digest: run.evidenceDigest, status: run.status, runId: run.id, receipt: run.receipt }, canonicalWrite: false };
    }
    if (name === "review.submit_finding") {
      const severity = stringField(args.severity, "");
      if (!( ["info", "warning", "error"] as readonly string[]).includes(severity)) throw new LocalAgentError({ code: "review.severity_invalid", message: `Review severity must be info, warning, or error; asked=${severity || "missing"}.`, recoveryAction: "submit a structured finding with a supported severity", receipt: "review severity enum" });
      const summary = stringField(args.summary, "");
      if (!summary) throw new LocalAgentError({ code: "review.summary_missing", message: "Review finding summary must not be empty.", recoveryAction: "provide a concise finding summary", receipt: "review finding schema" });
      const finding: LocalReviewFinding = { id: `finding:${randomUUID()}`, severity: severity as LocalReviewFinding["severity"], summary, ...(typeof args.details === "string" ? { details: args.details } : {}), createdAt: nowIso(this.now), actorId: active.session.actorId };
      active.state.findings[finding.id] = finding;
      await this.appendToolAudit(active, name);
      return { finding, canonicalWrite: false };
    }
    if (name === "change.publish_revision") {
      if (!Array.isArray(args.declaredEffects) || args.declaredEffects.some((effect) => typeof effect !== "string")) throw new LocalAgentError({ code: "change.effects_invalid", message: "Change revision declaredEffects must be an array of strings; no revision was published.", recoveryAction: "declare the semantic effects of the proposed revision", receipt: "change.publish_revision input schema" });
      const declaredEffects = args.declaredEffects as string[];
      let source: Awaited<ReturnType<typeof inspectGitSource>>;
      try {
        source = await inspectGitSource(executionDirectory);
      } catch (error) {
        if (error instanceof LocalGitSourceError) {
          throw new LocalAgentError({
            code: error.code,
            message: `${error.message} No revision was published.`,
            affectedObject: change.id,
            recoveryAction: error.recoveryAction,
            receipt: `change=${change.id}; git-code=${error.code}; directory=${this.directory}`,
          });
        }
        throw error;
      }
      if (!source.clean) {
        throw new LocalAgentError({
          code: "change.source_dirty",
          message: `Change ${change.id} has uncommitted Git source; no Git revision was published. budget=git.worktree; limit=clean source tree; asked=${source.changedPaths.length} changed paths; changedPaths=${source.changedPaths.join(",") || "unknown"}.`,
          affectedObject: source.repositoryId,
          recoveryAction: "commit or explicitly discard the changed source, then rerun change.publish_revision",
          receipt: `git-status=dirty; changed-paths=${source.changedPaths.length}; metadata-excluded=.anyam/**`,
        });
      }
      const baseMatch = /^git:project-revision:([0-9a-f]{40,64})$/.exec(change.baseProjectRevisionId);
      if (!baseMatch) {
        throw new LocalAgentError({
          code: "change.base_unbound",
          message: `Change ${change.id} has no committed Git base identity; base=${change.baseProjectRevisionId} is an explicit named snapshot, not a Git revision.`,
          affectedObject: change.id,
          recoveryAction: "create a committed baseline, remove the ambiguous Change metadata, and start the Change again",
          receipt: `base=${change.baseProjectRevisionId}; source-repository=${source.repositoryId}`,
        });
      }
      const baseCommit = baseMatch[1]!;
      if (change.baseRepositoryId && change.baseRepositoryId !== source.repositoryId) {
        throw new LocalAgentError({
          code: "change.base_repository_mismatch",
          message: `Change ${change.id} was based on Git repository ${change.baseRepositoryId}, but the Workspace resolves to ${source.repositoryId}; no revision was published.`,
          affectedObject: change.id,
          recoveryAction: "open the original Change Workspace or create a new Change from this repository",
          receipt: `base-repository=${change.baseRepositoryId}; current-repository=${source.repositoryId}`,
        });
      }
      if (!(await isGitAncestor(executionDirectory, baseCommit, source.commitId))) {
        throw new LocalAgentError({
          code: "change.base_stale",
          message: `Change ${change.id} is based on Git commit ${baseCommit}, which is not an ancestor of current commit ${source.commitId}; no revision was published.`,
          affectedObject: change.id,
          recoveryAction: `rebase or restart the Change onto git commit ${source.commitId}, then rerun change.publish_revision`,
          receipt: `base-commit=${baseCommit}; current-commit=${source.commitId}; ancestor=false`,
        });
      }
      const revision: LocalProposedRevision = {
        id: `revision:${randomUUID()}`,
        changeId: change.id,
        workspaceId: change.workspaceId,
        sourceSnapshot: `git:snapshot:${source.commitId}`,
        sourceRepositoryId: source.repositoryId,
        sourceRevision: gitCommitIdentity(source.commitId),
        baseProjectRevisionId: gitProjectRevisionId(baseCommit),
        gitRef: source.gitRef,
        gitObjectFormat: source.objectFormat,
        treeDigest: gitTreeIdentity(source.treeId),
        sourceKind: "git",
        declaredEffects,
        createdAt: nowIso(this.now),
        actorId: active.session.actorId,
        canonicalWrite: false,
      };
      active.state.revisions[revision.id] = revision;
      const changePath = join(this.directory, ".anyam", "change.json");
      const changeFile = await readJson<Record<string, unknown>>(changePath);
      changeFile.latestRevisionId = revision.id;
      await writeAtomic(changePath, `${JSON.stringify(changeFile, null, 2)}\n`);
      this.record(active.state, { operation: "change.revision_proposed", outcome: "observed", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: change.id, workspaceId: change.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { revisionId: revision.id, declaredEffects, sourceRepositoryId: source.repositoryId, sourceRevision: revision.sourceRevision, baseProjectRevisionId: revision.baseProjectRevisionId, treeDigest: revision.treeDigest, gitRef: source.gitRef, gitObjectFormat: source.objectFormat, canonicalWrite: false } });
      await this.appendToolAudit(active, name);
      return { revision, canonicalWrite: false, next: "review or request protected landing through the project policy" };
    }
    return this.denial(active, name);
  }

  async invokeTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (name === "run.start") return this.invokeRunStart(args);
    return this.withStateLock(() => this.invokeToolUnlocked(name, args));
  }
}

export type McpStdioOptions = {
  directory: string;
  agent: string;
  input: Readable;
  output: Writable;
  manager?: LocalAgentManager;
};

export class LocalMcpBroker {
  private readonly manager: LocalAgentManager;
  private readonly agent: AgentKind;
  private sessionId: string | null = null;

  constructor(input: { manager: LocalAgentManager; agent: string }) {
    this.manager = input.manager;
    this.agent = ensureAgent(input.agent);
  }

  async handle(request: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = request.id;
    const method = typeof request.method === "string" ? request.method : "";
    if (method === "notifications/initialized") return null;
    if (method === "initialize") {
      const session = await this.manager.ensureActiveSession(this.agent);
      this.sessionId = session.session.id;
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "anyam", version: "0.0.0" }, instructions: "Anyam MCP is a semantic Change broker. Git transfers source objects; canonical writes, secret reads, approvals, and production promotion are not available to this local session." } };
    }
    if (!this.sessionId) {
      const session = await this.manager.ensureActiveSession(this.agent);
      this.sessionId = session.session.id;
    }
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: LOCAL_MCP_TOOLS } };
    if (method === "tools/call") {
      const params = isRecord(request.params) ? request.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const result = await this.manager.invokeTool(name, args);
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false } };
      } catch (error) {
        const detail = error instanceof LocalAgentError ? error.toJSON() : { code: "agent.broker.error", message: error instanceof Error ? error.message : String(error) };
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(detail) }], structuredContent: { error: detail }, isError: true } };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method ${method || "missing"} is not supported by the Anyam local MCP broker.` } };
  }
}

export async function runMcpStdio(options: McpStdioOptions): Promise<void> {
  const manager = options.manager ?? new LocalAgentManager({ directory: options.directory });
  const broker = new LocalMcpBroker({ manager, agent: options.agent });
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try {
      request = JSON.parse(line) as unknown;
    } catch {
      await writeLine(options.output, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON; send one JSON-RPC request per line." } });
      continue;
    }
    if (!isRecord(request)) {
      await writeLine(options.output, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC request must be an object." } });
      continue;
    }
    const response = await broker.handle(request);
    if (response) await writeLine(options.output, response);
  }
}

async function writeLine(output: Writable, value: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolveWrite, reject) => {
    output.write(`${JSON.stringify(value)}\n`, (error?: Error | null) => error ? reject(error) : resolveWrite());
  });
}

export type GitCredentialContext = {
  protocol: string;
  host: string;
  path: string;
  username?: string;
  operation?: string;
};

function normalizedGitPath(value: string): string {
  const path = `/${value.trim().replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return path.endsWith(".git") ? path.slice(0, -4) : path;
}

export async function readGitCredentialContext(input: Readable): Promise<GitCredentialContext> {
  const fields = new Map<string, string>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) break;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new LocalAgentError({ code: "git.credential.protocol_invalid", message: `Git credential context contains a malformed field; asked=${line.slice(0, 80) || "empty"}.`, recoveryAction: "let Git invoke git-credential-anyam with protocol, host, and path fields", receipt: "credential protocol line parsing" });
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (fields.has(key)) throw new LocalAgentError({ code: "git.credential.protocol_duplicate", message: `Git credential context contains duplicate field ${key}; no credential was issued.`, affectedObject: key, recoveryAction: "remove duplicate credential context fields and retry", receipt: "credential protocol field uniqueness" });
    fields.set(key, value);
  }
  const protocol = fields.get("protocol")?.trim().toLowerCase() ?? "";
  const host = fields.get("host")?.trim().toLowerCase() ?? "";
  const path = fields.get("path")?.trim() ?? "";
  if (!protocol || !host || !path) throw new LocalAgentError({ code: "git.credential.context_missing", message: `Git credential context must include protocol, host, and path; received=${["protocol", "host", "path"].filter((key) => !fields.get(key)).join(",") || "unknown"}.`, recoveryAction: "run the helper through Git so it supplies the full remote context", receipt: "credential protocol required fields" });
  const operation = fields.get("operation")?.trim().toLowerCase();
  if (operation && operation !== "get") throw new LocalAgentError({ code: "git.credential.operation_denied", message: `Git credential operation ${operation} is not permitted; Anyam only issues credentials for a matching read/write Workspace context.`, affectedObject: operation, recoveryAction: "invoke git-credential-anyam for a get operation", receipt: "credential operation allowlist=get" });
  const username = fields.get("username")?.trim();
  if (username && username !== "x-anyam-token") throw new LocalAgentError({ code: "git.credential.username_denied", message: `Git credential username ${username} is not an Anyam Workspace identity; no credential was issued.`, affectedObject: username, recoveryAction: "clear the unrelated Git credential and retry the Anyam remote", receipt: "credential username=x-anyam-token" });
  return { protocol, host, path, ...(username ? { username } : {}), ...(operation ? { operation } : {}) };
}

async function remoteOrigin(directory: string): Promise<{ protocol: string; host: string; path: string }> {
  let stdout: string;
  try {
    ({ stdout } = await execFile("git", trustedGitArgs(["config", "--get", "remote.origin.url"]), { cwd: directory, encoding: "utf8", env: trustedGitEnvironment() }));
  } catch {
    throw new LocalAgentError({ code: "git.credential.remote_missing", message: `No remote.origin.url is configured for ${directory}; no Workspace credential was issued.`, affectedObject: directory, recoveryAction: "configure the Anyam HTTPS Workspace remote before invoking Git", receipt: "git config --get remote.origin.url" });
  }
  const value = stdout.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalAgentError({ code: "git.credential.transport_unsupported", message: "The Git remote is not an HTTPS URL; Anyam does not issue a Workspace credential for SSH or scp-style remotes.", affectedObject: value.slice(0, 120), recoveryAction: "set remote.origin.url to the Anyam HTTPS Workspace remote", receipt: "remote transport=https" });
  }
  if (parsed.protocol !== "https:" || !parsed.host) throw new LocalAgentError({ code: "git.credential.transport_unsupported", message: `Git remote transport ${parsed.protocol || "missing"} is not supported by the Anyam credential helper.`, affectedObject: parsed.host || value.slice(0, 120), recoveryAction: "use the Anyam HTTPS Workspace remote", receipt: "remote transport=https" });
  return { protocol: "https", host: parsed.host.toLowerCase(), path: parsed.pathname };
}

export async function gitCredentialGet(input: { directory: string; agent?: string; context: GitCredentialContext; stateDirectory?: string }): Promise<{ username: string; password: string; credential: WorkspaceCredential }> {
  const context = input.context;
  if (context.protocol !== "https") throw new LocalAgentError({ code: "git.credential.protocol_denied", message: `Git credential protocol ${context.protocol || "missing"} is not permitted; Anyam issues credentials only for HTTPS remotes.`, affectedObject: context.protocol || "missing", recoveryAction: "invoke the helper for an HTTPS Anyam remote", receipt: "credential protocol=https" });
  const origin = await remoteOrigin(input.directory);
  if (origin.host !== context.host || normalizedGitPath(origin.path) !== normalizedGitPath(context.path)) throw new LocalAgentError({ code: "git.credential.context_mismatch", message: `Git credential context does not match remote.origin.url; host/path are bound to one Anyam Workspace and no credential was issued.`, affectedObject: `${context.host}${normalizedGitPath(context.path)}`, recoveryAction: "run the helper from the matching Anyam Workspace repository", receipt: `remote=${origin.host}${normalizedGitPath(origin.path)}; requested=${context.host}${normalizedGitPath(context.path)}` });
  const manager = new LocalAgentManager({ directory: input.directory, ...(input.stateDirectory ? { stateDirectory: input.stateDirectory } : {}) });
  await manager.ensureActiveSession(input.agent ?? "cli");
  const credential = await manager.issueWorkspaceCredential();
  return { username: "x-anyam-token", password: credential.token, credential };
}
