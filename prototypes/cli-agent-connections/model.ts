/**
 * THROWAWAY PROTOTYPE — do not treat this as production Anyam code.
 *
 * Question:
 * Can one local/remote session connect the CLI, Git, MCP, and a coding agent
 * without exposing a refresh token or canonical repository write authority?
 *
 * This module is intentionally pure. The terminal shell in cli.ts is the
 * disposable part; the state transitions are the part we are evaluating.
 */

export type AgentName = "codex" | "claude" | "cursor" | "cli";
export type CredentialStatus = "active" | "expired" | "revoked";

export interface EventRecord {
  step: number;
  action: string;
  result: "ok" | "blocked";
  message: string;
}

export interface AgentSetup {
  agent: AgentName;
  transport: "local-stdio-mcp" | "direct-cli";
  configPath: string;
  credentialSource: "local-broker";
  status: "ready";
}

export interface Session {
  id: string;
  agent: AgentName;
  status: "active" | "revoked";
  mcpAudience: string;
  gitAudience: string;
  grant: "task-scoped";
  canonicalWrite: "denied";
}

export interface ChangeState {
  id: string;
  intent: string;
  status: "idle" | "active" | "ready" | "blocked";
  workspace: string;
  baseRevision: string;
  latestRevision: string;
  revisionCount: number;
  activeAgent?: AgentName;
  sessions: Session[];
}

export interface State {
  realm: string;
  repository: string;
  view: string;
  auth: {
    principal: string;
    browserSession: CredentialStatus | "none";
    accessToken: "ephemeral" | "none";
    refreshToken: "os-keychain-only" | "none";
    authorizationEpoch: number;
  };
  git: {
    cloned: boolean;
    helper: "git-credential-anyam" | "not-configured";
    credentialStatus: CredentialStatus | "none";
    credentialAudience?: string;
    canonicalWrite: "denied";
  };
  setups: AgentSetup[];
  change: ChangeState;
  events: EventRecord[];
  lastError?: string;
  next: {
    workspace: number;
    session: number;
    revision: number;
    event: number;
  };
}

export type Action =
  | { type: "login" }
  | { type: "clone" }
  | { type: "setup-agent"; agent: AgentName }
  | { type: "launch"; agent: AgentName }
  | { type: "publish" }
  | { type: "expire-git" }
  | { type: "reauth" }
  | { type: "handoff"; agent: AgentName }
  | { type: "revoke" }
  | { type: "reset" };

const agentConfig: Record<AgentName, AgentSetup> = {
  codex: {
    agent: "codex",
    transport: "local-stdio-mcp",
    configPath: ".codex/config.toml",
    credentialSource: "local-broker",
    status: "ready",
  },
  claude: {
    agent: "claude",
    transport: "local-stdio-mcp",
    configPath: ".mcp.json",
    credentialSource: "local-broker",
    status: "ready",
  },
  cursor: {
    agent: "cursor",
    transport: "local-stdio-mcp",
    configPath: ".cursor/mcp.json",
    credentialSource: "local-broker",
    status: "ready",
  },
  cli: {
    agent: "cli",
    transport: "direct-cli",
    configPath: "anyam agent exec",
    credentialSource: "local-broker",
    status: "ready",
  },
};

export function initialState(): State {
  return {
    realm: "https://source.anyam.dev/acme",
    repository: "acme/video-player",
    view: "community",
    auth: {
      principal: "none",
      browserSession: "none",
      accessToken: "none",
      refreshToken: "none",
      authorizationEpoch: 0,
    },
    git: {
      cloned: false,
      helper: "not-configured",
      credentialStatus: "none",
      canonicalWrite: "denied",
    },
    setups: [],
    change: {
      id: "none",
      intent: "none",
      status: "idle",
      workspace: "none",
      baseRevision: "main@91bd",
      latestRevision: "none",
      revisionCount: 0,
      sessions: [],
    },
    events: [],
    next: { workspace: 1, session: 1, revision: 1, event: 1 },
  };
}

function event(
  state: State,
  action: string,
  result: EventRecord["result"],
  message: string,
): State {
  return {
    ...state,
    events: [
      ...state.events,
      { step: state.next.event, action, result, message },
    ],
    next: { ...state.next, event: state.next.event + 1 },
    lastError: result === "blocked" ? message : undefined,
  };
}

function blocked(state: State, action: string, message: string): State {
  return event(state, action, "blocked", message);
}

function ok(state: State, action: string, message: string): State {
  return event(state, action, "ok", message);
}

function hasSetup(state: State, agent: AgentName): boolean {
  return state.setups.some((setup) => setup.agent === agent);
}

function activeSession(state: State): Session | undefined {
  return state.change.sessions.find((session) => session.status === "active");
}

function readyForGit(state: State): string | undefined {
  if (state.auth.browserSession !== "active") return "login is required";
  if (!state.git.cloned) return "clone the Project first";
  if (state.git.credentialStatus !== "active") {
    return "Workspace Git credential is not active; run reauth";
  }
  return undefined;
}

export function reduce(state: State, action: Action): State {
  if (action.type === "reset") return initialState();

  if (action.type === "login") {
    return event(
      {
        ...state,
        auth: {
          principal: "principal:wei",
          browserSession: "active",
          accessToken: "ephemeral",
          refreshToken: "os-keychain-only",
          authorizationEpoch: state.auth.authorizationEpoch + 1,
        },
      },
      "login",
      "ok",
      "Browser login completed; refresh credential remains in the OS keychain",
    );
  }

  if (action.type === "clone") {
    if (state.auth.browserSession !== "active") {
      return blocked(state, "clone", "login is required before clone");
    }
    return event(
      {
        ...state,
        git: {
          cloned: true,
          helper: "git-credential-anyam",
          credentialStatus: "active",
          credentialAudience: `${state.realm}/git/${state.repository}/workspace`,
          canonicalWrite: "denied",
        },
      },
      "clone",
      "ok",
      "Project View cloned; Git helper issued a short-lived Workspace credential",
    );
  }

  if (action.type === "setup-agent") {
    if (state.auth.browserSession !== "active") {
      return blocked(state, `setup ${action.agent}`, "login is required before agent setup");
    }
    if (hasSetup(state, action.agent)) {
      return blocked(state, `setup ${action.agent}`, "agent is already configured for the local broker");
    }
    return event(
      { ...state, setups: [...state.setups, agentConfig[action.agent]] },
      `setup ${action.agent}`,
      "ok",
      `${action.agent} configured through ${agentConfig[action.agent].configPath}; no token was written to project config`,
    );
  }

  if (action.type === "launch") {
    const failure = readyForGit(state);
    if (failure) return blocked(state, `launch ${action.agent}`, failure);
    if (!hasSetup(state, action.agent)) {
      return blocked(state, `launch ${action.agent}`, `run setup ${action.agent} first`);
    }

    const sessionId = `session-${state.next.session}`;
    const workspaceId = `workspace-${state.next.workspace}`;
    const changeId = state.change.id === "none" ? "CHG-1" : state.change.id;
    const session: Session = {
      id: sessionId,
      agent: action.agent,
      status: "active",
      mcpAudience: `${state.realm}/mcp/${changeId}`,
      gitAudience: `${state.realm}/git/${state.repository}/${workspaceId}`,
      grant: "task-scoped",
      canonicalWrite: "denied",
    };

    return event(
      {
        ...state,
        change: {
          ...state.change,
          id: changeId,
          intent: state.change.intent === "none" ? "Improve the public video player" : state.change.intent,
          status: "active",
          workspace: workspaceId,
          activeAgent: action.agent,
          sessions: [...state.change.sessions, session],
        },
        next: {
          ...state.next,
          workspace: state.next.workspace + 1,
          session: state.next.session + 1,
        },
      },
      `launch ${action.agent}`,
      "ok",
      `${action.agent} received a task grant and isolated Workspace; canonical write remains denied`,
    );
  }

  if (action.type === "publish") {
    const failure = readyForGit(state);
    if (failure) return blocked(state, "publish revision", failure);
    const session = activeSession(state);
    if (!session) return blocked(state, "publish revision", "no active agent session; launch or handoff first");
    if (state.change.status === "blocked") {
      return blocked(state, "publish revision", "Change is blocked; recover the active grant before publishing");
    }

    const revision = `rev-${state.next.revision}`;
    return event(
      {
        ...state,
        change: {
          ...state.change,
          status: "ready",
          latestRevision: revision,
          revisionCount: state.change.revisionCount + 1,
        },
        next: { ...state.next, revision: state.next.revision + 1 },
      },
      "publish revision",
      "ok",
      `${revision} published through MCP/Git coordination; canonical repository was not written`,
    );
  }

  if (action.type === "expire-git") {
    return event(
      { ...state, git: { ...state.git, credentialStatus: "expired" } },
      "expire git credential",
      "ok",
      "Workspace Git credential expired; refresh is required before another publish",
    );
  }

  if (action.type === "reauth") {
    if (state.auth.refreshToken !== "os-keychain-only") {
      return blocked(state, "reauth", "no refresh credential is available in the OS keychain");
    }
    if (state.auth.browserSession === "none") {
      return blocked(state, "reauth", "browser session is not active; login is required");
    }
    return event(
      {
        ...state,
        git: { ...state.git, credentialStatus: "active" },
        auth: { ...state.auth, accessToken: "ephemeral" },
      },
      "reauth",
      "ok",
      "Broker refreshed short-lived credentials without exposing the refresh token",
    );
  }

  if (action.type === "handoff") {
    const failure = readyForGit(state);
    if (failure) return blocked(state, `handoff ${action.agent}`, failure);
    const current = activeSession(state);
    if (!current) return blocked(state, `handoff ${action.agent}`, "no active session to hand off");
    if (!hasSetup(state, action.agent)) {
      return blocked(state, `handoff ${action.agent}`, `run setup ${action.agent} first`);
    }

    const sessionId = `session-${state.next.session}`;
    const newSession: Session = {
      id: sessionId,
      agent: action.agent,
      status: "active",
      mcpAudience: `${state.realm}/mcp/${state.change.id}`,
      gitAudience: `${state.realm}/git/${state.repository}/${state.change.workspace}`,
      grant: "task-scoped",
      canonicalWrite: "denied",
    };
    return event(
      {
        ...state,
        change: {
          ...state.change,
          status: "active",
          activeAgent: action.agent,
          sessions: [
            ...state.change.sessions.map((session) =>
              session.id === current.id ? { ...session, status: "revoked" as const } : session,
            ),
            newSession,
          ],
        },
        next: { ...state.next, session: state.next.session + 1 },
      },
      `handoff ${action.agent}`,
      "ok",
      `${current.agent} session revoked; ${action.agent} received a fresh grant from ${state.change.latestRevision === "none" ? state.change.baseRevision : state.change.latestRevision}`,
    );
  }

  if (action.type === "revoke") {
    if (!activeSession(state)) return blocked(state, "revoke", "no active agent session");
    return event(
      {
        ...state,
        auth: {
          ...state.auth,
          authorizationEpoch: state.auth.authorizationEpoch + 1,
        },
        git: { ...state.git, credentialStatus: "revoked" },
        change: {
          ...state.change,
          status: "blocked",
          activeAgent: undefined,
          sessions: state.change.sessions.map((session) =>
            session.status === "active" ? { ...session, status: "revoked" as const } : session,
          ),
        },
      },
      "revoke",
      "ok",
      "Task grant, active MCP session, and Workspace credential revoked; canonical source unchanged",
    );
  }

  return blocked(state, "unknown", "unsupported prototype action");
}

export function demoActions(): Action[] {
  return [
    { type: "login" },
    { type: "clone" },
    { type: "setup-agent", agent: "codex" },
    { type: "setup-agent", agent: "claude" },
    { type: "launch", agent: "codex" },
    { type: "publish" },
    { type: "handoff", agent: "claude" },
    { type: "expire-git" },
    { type: "publish" },
    { type: "reauth" },
    { type: "publish" },
    { type: "revoke" },
    { type: "publish" },
  ];
}
