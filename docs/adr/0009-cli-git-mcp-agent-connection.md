# CLI, Git, MCP, and coding-agent connection

Status: Accepted

## Context

Anyam must connect developers and coding agents without replacing Codex, Claude Code, Cursor, or other agent runtimes. Git is the source-object data plane; MCP and the CLI are semantic control surfaces. The connection must preserve the Realm authorization model, keep refresh credentials out of repositories and model context, and prevent ordinary clients from writing canonical source.

The connection was exercised in the throwaway prototype on branch [`codex/prototype-cli-agent-connections`](https://github.com/wms2537/anyam/tree/codex/prototype-cli-agent-connections), commit `5d1b4a4`. The owner accepted its command/session/credential behavior in ticket [#17](https://github.com/wms2537/anyam/issues/17).

## Decision

### One connection model, four surfaces

Anyam ships four coordinated interfaces:

1. `anyam` CLI for login, Project cloning, Change lifecycle, agent setup, handoff, checks, and revocation.
2. Standard Git HTTPS through the Anyam Git Gateway for clone, fetch, push, and source-object transfer.
3. Remote project-scoped HTTP MCP for semantic operations by hosted or remote agents.
4. Local stdio MCP broker for local Codex, Claude Code, Cursor, and CLI-only agents.

The CLI and MCP server share the same Realm authorization and Capability Grant model. MCP does not transfer the whole repository file-by-file; the local agent edits its Workspace filesystem and Git moves source objects.

### User-facing command shape

The prototype used short commands; the production CLI keeps the same semantics with Git-compatible nouns:

```text
anyam login
anyam clone <project-or-view>
anyam agent setup <codex|claude|cursor|cli>
anyam change start --agent <agent>
anyam change publish
anyam agent handoff <agent>
anyam auth reauth
anyam auth revoke
```

Aliases may improve ergonomics, but they must not change the underlying state transitions or authority boundaries.

### Login and credential storage

`anyam login` uses the Realm’s browser authentication flow. The CLI stores a rotated refresh credential in the operating system’s secure keychain and receives short-lived API credentials. The refresh credential is never written to a repository, MCP configuration, process arguments, normal logs, or model context.

`anyam clone` resolves the Realm and Project View, materializes authorized Workspace Repositories, configures `git-credential-anyam`, and obtains a short-lived credential for the exact Git audience. The helper may use Bearer credentials or HTTP Basic compatibility, but lifetime and audience restrictions remain server-enforced.

### Agent setup and local MCP

`anyam agent setup` installs a local broker configuration for the selected client:

| Agent | Configuration surface | Transport |
|---|---|---|
| Codex | `.codex/config.toml` | local stdio MCP |
| Claude Code | `.mcp.json` | local stdio MCP |
| Cursor | `.cursor/mcp.json` | local stdio MCP |
| CLI-only agent | `anyam agent exec` | direct CLI plus local broker |

The checked-in configuration contains a command or broker reference, never a Realm refresh token, Git credential, MCP bearer token, provider key, or secret.

The local broker:

- reads the human session from the OS keychain;
- identifies the current Project, Change, Workspace, and agent client;
- requests or renews a task-scoped Capability Grant;
- exposes only tools permitted by the current grant;
- keeps credentials outside model context;
- records the agent client and session in the Audit Ledger;
- revokes or releases the task session when the process exits or the user requests revocation.

### Change launch and Workspace authority

`anyam change start --agent <agent>` creates or reuses a Change Workspace from an exact base Project Revision, starts a task session, and gives the agent:

```text
read access to the authorized Project View
write access to the Workspace Repository or repositories
task-scoped MCP tools
approved checks and Secret Use operations
publish-revision authority for this Change
```

It does not give the agent:

```text
canonical repository write
arbitrary Git ref write
policy administration
production secret values
Change approval
Landing authority
Production Promotion authority
```

### Revision publication

`anyam change publish` coordinates Git Workspace pushes and MCP metadata to create an immutable Change Revision. The revision is bound to its base Project Revision and current task grant. The operation does not write canonical source; only trusted Landing authority can perform that protected transition later.

An expired Git credential produces an explicit, recoverable failure. `anyam auth reauth` obtains a fresh short-lived credential through the broker without exposing the refresh credential, after which publication can be retried. No hidden retry changes the source or Change state.

### Agent handoff

`anyam agent handoff <agent>` revokes the old session before creating a new task session from the latest accepted Change Revision (or the base Project Revision if no revision exists). The new session gets a new MCP and Git audience and a new grant. The old session remains visible as revoked history and cannot continue editing or publishing.

Agents do not share one mutable Workspace concurrently. Parallel work uses separate Workspaces and later Integration Cohort composition.

### Remote MCP

Remote agents use a project-scoped MCP HTTP resource with the MCP `2026-07-28` authorization profile and the Realm’s audience-bound OAuth credentials. The MCP endpoint exposes semantic operations such as inspecting a Change, publishing a revision, running approved checks, requesting review, and requesting Promotion. Git remains the source-object transfer plane.

An MCP token is never passed through to Git, Repository Drivers, Cloudflare APIs, runners, or Targets. Any downstream credential is minted through a separate, narrower exchange and is recorded against the task.

### Revocation and failure recovery

`anyam auth revoke` increments the authorization epoch, revokes the active task grant and MCP session, and revokes or quarantines the Workspace Git credential. The Change remains immutable history but becomes blocked until a new authorized session is created. A subsequent publish must fail explicitly; the local process remaining open does not preserve authority.

Failures name the credential or grant, its state, the requested operation, and the recovery action. Empty output, silent fallback to canonical credentials, and automatic authority widening are prohibited.

## Consequences

- Any supported coding agent can use its native interface while Anyam supplies the Workspace, context, credentials, checks, revision history, and safe delivery path.
- The CLI is useful to humans and scripts even when an agent does not support MCP.
- Local and remote agents share the same policy model and audit semantics.
- Git clients remain compatible without receiving broad personal tokens.
- Agent handoff is safe and inspectable, but it creates more explicit session and grant records than sharing one branch.
- The CLI, local broker, Git Gateway, and remote MCP endpoint are first-party client surfaces and require a compatibility matrix before release claims.

## Rejected alternatives

- **MCP as the repository data plane:** inefficient, awkward for editors, and incompatible with normal Git clients; MCP coordinates semantic operations while Git transfers source.
- **One long-lived agent token:** cannot express task scope, handoff, revocation, or audience separation safely.
- **Agent access to canonical `main`:** violates protected Landing and makes a stolen Workspace credential materially dangerous.
- **Refresh tokens in `.mcp.json`, `.git/config`, or environment files:** creates copy, log, and model-context leakage.
- **Two agents sharing one mutable Workspace:** causes ambiguous writes and makes provenance and rollback unclear.
- **Silent reauthentication or retry:** hides expiry and can make an agent believe it retained authority it no longer has.
- **Direct dependence on vendor cloud-agent repository integrations:** provider-specific repository limitations would make Anyam’s connection path brittle; run local or Anyam-controlled agent clients against the same contract instead.
