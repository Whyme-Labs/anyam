import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { basename, join, resolve } from "node:path";
import { runLocalCheck } from "./scaffold.js";

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
  receipt: "policy=local-agent/v1; sizing=provisional-tripwire; remeasure-before-production",
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
  status: "passed" | "blocked";
  evidenceId: string;
  evidenceDigest: string;
  startedAt: string;
  completedAt: string;
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
  actions: readonly string[];
  verifiers: readonly string[];
};

type ChangeMetadata = {
  id: string;
  projectId: string;
  title: string;
  baseProjectRevisionId: string;
  workspaceId: string;
};

export type LocalAgentManagerOptions = {
  directory: string;
  principalId?: string;
  clientId?: string;
  credentialLifetimeMs?: number;
  sessionLifetimeMs?: number;
  now?: () => Date;
};

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
  return `# Anyam local agent contract\n\nThis project uses Anyam's local agent broker.\n\n- Work only in the assigned Change Workspace.\n- Use the Anyam MCP tools for project, Change, Workspace, checks, evidence, review, and revision operations.\n- Never attempt to write canonical Git refs, read secret values, approve a Change, change policy, or promote production.\n- Publish a revision with declared effects after the local checks pass.\n- Treat every budget error as actionable: it names the budget, limit, ask, receipt, and fix.\n- Never print, commit, or store credentials.\n`;
}

function sharedSkill(): string {
  return `---\nname: anyam-change\ndescription: Work safely inside an Anyam Change Workspace.\n---\n\n# Anyam Change\n\n1. Inspect the active Change and Context Manifest.\n2. Read only the Source Spaces named in the manifest.\n3. Make edits in the assigned Workspace.\n4. Run an approved action before publishing.\n5. Declare API, schema, dependency, and infrastructure effects.\n6. Publish a Change revision through Anyam MCP.\n7. Never write canonical source or request secret values.\n`;
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
  private readonly principalId: string;
  private readonly clientId: string;
  private readonly credentialLifetimeMs: number;
  private readonly sessionLifetimeMs: number;
  private readonly now: () => Date;

  constructor(options: LocalAgentManagerOptions) {
    this.directory = resolve(options.directory);
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
    return join(this.directory, ".anyam", "agents", "state.json");
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

  private async projectMetadata(): Promise<ProjectMetadata> {
    const path = join(this.directory, "anyam.json");
    let value: unknown;
    try {
      value = await readJson<unknown>(path);
    } catch (error) {
      if (isNotFound(error)) throw new LocalAgentError({ code: "project.missing", message: `No anyam.json found in ${this.directory}; the agent needs an initialized Project.`, recoveryAction: "run anyam init and rerun anyam agent setup", receipt: "anyam.json was not found" });
      throw error;
    }
    if (!isRecord(value)) throw new LocalAgentError({ code: "project.invalid", message: "anyam.json must be a JSON object; the agent cannot construct a Context Manifest.", recoveryAction: "repair anyam.json and rerun anyam check", receipt: "anyam.json was read" });
    const modules = Array.isArray(value.modules) ? value.modules.filter(isRecord) : [];
    const actions = modules.flatMap((module) => Array.isArray(module.actions) ? module.actions.filter(isRecord).map((action) => stringField(action.id, "")) : []).filter(Boolean);
    const manifestDigest = digest(value);
    return {
      id: stringField(value.id, `project:local:${basename(this.directory)}`),
      name: stringField(value.name, basename(this.directory)),
      manifestDigest,
      sourceSpaceIds: stringArray(value.sourceSpaceIds),
      actions,
      verifiers: Array.isArray(value.verifiers) ? value.verifiers.filter(isRecord).map((verifier) => stringField(verifier.id, "")).filter(Boolean) : [],
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

  private async requireActiveSession(): Promise<{ state: AgentState; session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
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

  async startSession(input: { agent: string; changeId?: string }): Promise<{ session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
    const agent = ensureAgent(input.agent);
    const project = await this.projectMetadata();
    const change = await this.changeMetadata();
    if (change.projectId !== project.id) throw new LocalAgentError({ code: "change.project_mismatch", message: `Change ${change.id} belongs to ${change.projectId}, not ${project.id}.`, affectedObject: change.id, recoveryAction: "start the agent from the Change's Project directory", receipt: `manifest-project=${project.id}; change-project=${change.projectId}` });
    if (input.changeId && input.changeId !== change.id) throw new LocalAgentError({ code: "change.not_active", message: `Requested Change ${input.changeId} is not the local active Change ${change.id}.`, affectedObject: input.changeId, recoveryAction: "switch to the Change Workspace before starting the agent", receipt: `active-change=${change.id}` });

    const state = await this.readState();
    const existing = this.activeSession(state);
    if (existing && !this.expireIfNeeded(state, existing.session, existing.grant)) {
      if (existing.session.agent !== agent) throw new LocalAgentError({ code: "agent.session.busy", message: `Change ${change.id} already has an active ${existing.session.agent} session; hand it off before starting ${agent}.`, affectedObject: existing.session.id, recoveryAction: `run anyam agent handoff ${agent}`, receipt: `active-session=${existing.session.id}` });
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
      actions: project.actions,
      verifiers: project.verifiers,
      authorizationEpoch: state.authorizationEpoch,
      disclosure: "local-owner",
      createdAt: startedAt,
      expiresAt: expires,
      receipt: `${LOCAL_AGENT_POLICY.receipt}; manifest=${project.manifestDigest}`,
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
    };
    state.sessions[sessionId] = session;
    state.grants[grantId] = grant;
    state.contexts[sessionId] = context;
    state.currentSessionId = sessionId;
    this.record(state, { operation: "session.started", outcome: "observed", sessionId, grantId, taskId, projectId: project.id, changeId: change.id, workspaceId: change.workspaceId, actorId, agent, details: { receipt: context.receipt } });
    await this.writeState(state);
    return { session, grant, context };
  }

  async ensureActiveSession(agent: string): Promise<{ session: LocalAgentSession; grant: LocalCapabilityGrant; context: AgentContextManifest }> {
    const requested = ensureAgent(agent);
    const state = await this.readState();
    const active = this.activeSession(state);
    if (active && !this.expireIfNeeded(state, active.session, active.grant) && active.session.agent === requested) {
      await this.writeState(state);
      return { session: clone(active.session), grant: clone(active.grant), context: clone(active.context) };
    }
    return this.startSession({ agent: requested });
  }

  async revoke(sessionId?: string): Promise<{ sessionId: string; grantId: string; status: "revoked" | "missing" }> {
    const state = await this.readState();
    const id = sessionId ?? state.currentSessionId;
    if (!id || !state.sessions[id]) return { sessionId: id ?? "", grantId: "", status: "missing" };
    const session = state.sessions[id];
    const grant = state.grants[session.grantId];
    const revokedAt = nowIso(this.now);
    session.status = "revoked";
    session.revokedAt = revokedAt;
    if (grant) grant.status = "revoked";
    state.authorizationEpoch += 1;
    if (state.currentSessionId === id) state.currentSessionId = null;
    this.record(state, { operation: "session.revoked", outcome: "observed", sessionId: id, grantId: session.grantId, taskId: session.taskId, projectId: session.projectId, changeId: session.changeId, workspaceId: session.workspaceId, actorId: session.actorId, agent: session.agent, details: { authorizationEpoch: state.authorizationEpoch } });
    await this.writeState(state);
    return { sessionId: id, grantId: session.grantId, status: "revoked" };
  }

  async handoff(input: { agent: string; changeId?: string }): Promise<{ previousSessionId: string | null; next: Awaited<ReturnType<LocalAgentManager["startSession"]>> }> {
    const state = await this.readState();
    const previousSessionId = state.currentSessionId;
    if (previousSessionId) await this.revoke(previousSessionId);
    const next = await this.startSession({ agent: input.agent, ...(input.changeId ? { changeId: input.changeId } : {}) });
    const nextState = await this.readState();
    this.record(nextState, { operation: "session.handoff", outcome: "observed", sessionId: next.session.id, grantId: next.grant.id, taskId: next.session.taskId, projectId: next.session.projectId, changeId: next.session.changeId, workspaceId: next.session.workspaceId, actorId: next.session.actorId, agent: next.session.agent, details: { previousSessionId } });
    await this.writeState(nextState);
    return { previousSessionId, next };
  }

  async status(): Promise<AgentStatus> {
    const state = await this.readState();
    const active = this.activeSession(state);
    if (active && this.expireIfNeeded(state, active.session, active.grant)) {
      state.currentSessionId = null;
      await this.writeState(state);
      return { session: null, grant: null, context: null, activeCredentialCount: 0, auditCount: state.audit.length };
    }
    const activeCredentialCount = active ? Object.values(state.credentials).filter((credential) => credential.sessionId === active.session.id && !isExpired(credential.expiresAt, this.now)).length : 0;
    return { session: active ? clone(active.session) : null, grant: active ? clone(active.grant) : null, context: active ? clone(active.context) : null, activeCredentialCount, auditCount: state.audit.length };
  }

  async issueWorkspaceCredential(sessionId?: string): Promise<WorkspaceCredential> {
    const active = await this.requireActiveSession();
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

  async invokeTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const active = await this.requireActiveSession();
    if (!LOCAL_MCP_TOOLS.some((entry) => entry.name === name)) return this.denial(active, name);
    const project = await this.projectMetadata();
    const change = await this.changeMetadata();
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
      if (!project.actions.includes(actionId)) throw new LocalAgentError({ code: "run.action_unknown", message: `Action ${actionId || "missing"} is not declared by the Project; no run was started.`, affectedObject: actionId || "action:missing", recoveryAction: `choose one of ${project.actions.join(", ") || "the actions in anyam.json"}`, receipt: `declared-actions=${project.actions.join(",")}` });
      const startedAt = nowIso(this.now);
      const report = await runLocalCheck(this.directory);
      const completedAt = nowIso(this.now);
      const runId = `run:${randomUUID()}`;
      const evidenceId = `evidence:${randomUUID()}`;
      const evidenceDigest = digest({ report, actionId, sessionId: active.session.id });
      const observation: LocalRunObservation = { id: runId, actionId, status: report.status, evidenceId, evidenceDigest, startedAt, completedAt, receipt: `${LOCAL_AGENT_POLICY.receipt}; action=${actionId}; blockers=${report.blockers.length}` };
      active.state.runs[runId] = observation;
      this.record(active.state, { operation: "run.completed", outcome: "observed", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: change.id, workspaceId: change.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { runId, evidenceId, status: report.status, blockerCount: report.blockers.length } });
      await this.writeState(active.state);
      return { run: observation, report, evidence: { id: evidenceId, digest: evidenceDigest, status: report.status }, canonicalWrite: false };
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
      const revision: LocalProposedRevision = { id: `revision:${randomUUID()}`, changeId: change.id, workspaceId: change.workspaceId, sourceSnapshot: `snapshot:local:${digest({ project: project.manifestDigest, changeId: change.id, workspaceId: change.workspaceId, effects: declaredEffects })}`, declaredEffects, createdAt: nowIso(this.now), actorId: active.session.actorId, canonicalWrite: false };
      active.state.revisions[revision.id] = revision;
      const changePath = join(this.directory, ".anyam", "change.json");
      const changeFile = await readJson<Record<string, unknown>>(changePath);
      changeFile.latestRevisionId = revision.id;
      await writeAtomic(changePath, `${JSON.stringify(changeFile, null, 2)}\n`);
      this.record(active.state, { operation: "change.revision_proposed", outcome: "observed", sessionId: active.session.id, grantId: active.grant.id, taskId: active.session.taskId, projectId: active.session.projectId, changeId: change.id, workspaceId: change.workspaceId, actorId: active.session.actorId, agent: active.session.agent, details: { revisionId: revision.id, declaredEffects, canonicalWrite: false } });
      await this.appendToolAudit(active, name);
      return { revision, canonicalWrite: false, next: "review or request protected landing through the project policy" };
    }
    return this.denial(active, name);
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

export async function gitCredentialGet(input: { directory: string; agent?: string }): Promise<{ username: string; password: string; credential: WorkspaceCredential }> {
  const manager = new LocalAgentManager({ directory: input.directory });
  await manager.ensureActiveSession(input.agent ?? "cli");
  const credential = await manager.issueWorkspaceCredential();
  return { username: "x-anyam-token", password: credential.token, credential };
}
