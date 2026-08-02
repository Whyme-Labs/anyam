# Local agent broker and Workspace credentials

Status: Accepted

## Context

Anyam needs one practical connection path for Codex, Claude Code, Cursor, and
CLI-only coding agents before the hosted Realm and remote MCP service are
available. The local path must preserve the durable boundaries in
[ADR-0009](0009-cli-git-mcp-agent-connection.md): Git transfers source objects,
MCP coordinates semantic work, and only protected Landing authority may update
canonical source.

The package-manager CLI is already the first user-facing Anyam surface. It has
to be useful in an initialized local Project with an active Change, without
pretending that a local prototype has a production identity provider or a
Cloudflare Repository Driver.

## Decision

### `anyam agent setup` configures clients, not credentials

`anyam agent setup <codex|claude|cursor|cli>` writes a portable setup manifest,
shared `AGENTS.md` guidance, the `anyam-change` Agent Skill, and the selected
client's local stdio MCP configuration:

| Client | Configuration |
|---|---|
| Codex | `.codex/config.toml` |
| Claude Code | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| CLI-only | `.anyam/agents/manifest.json` |

Existing configuration is preserved and the Anyam entry is merged. No refresh
credential, access token, Git password, provider key, or secret is written to
the Project. The Git helper contract is described as `memory-only` and
Workspace-only.

### The local broker is a bounded semantic surface

`anyam mcp serve --stdio --agent <agent>` speaks newline-delimited JSON-RPC and
exposes exactly these semantic tools:

```text
project.inspect
change.inspect
workspace.inspect
run.start
run.inspect
evidence.inspect
review.submit_finding
change.publish_revision
```

It does not expose arbitrary repository writes, canonical Git ref writes,
secret-value reads, Change approval, policy administration, or production
promotion. Unknown names fail through the same explicit denial path as known
prohibited operations.

### A session creates a local Capability Grant and Context Manifest

`anyam agent start <agent>` resolves `anyam.json` and `.anyam/change.json`, then
creates four linked records:

```text
Agent Session
Capability Grant
Context Manifest
Audit events
```

The grant is bound to the Project, Change, and Workspace. The context records
the exact manifest digest, base Project Revision, readable/writable Source
Spaces, declared Actions and Verifiers, actor, task, capabilities, prohibited
operations, and disclosure boundary. This local adapter uses the explicit
`local-owner` disclosure profile; hosted Realm policy will replace that lookup
without changing the record shape.

The persisted state contains session/grant/context metadata and credential
digests only. It never contains the bearer credential.

### Git credentials are short-lived and Workspace-only

`git-credential-anyam get` obtains an opaque credential for the active
Workspace. The returned credential carries:

```text
audience = git:workspace:<workspace-id>
permissions = read, write-workspace
canonicalWrite = false
```

The local state stores only a hash of the token. Validation fails when the
session or grant is revoked, when the token expires, or when the audience or
Workspace does not match. This is the local equivalent of the production
Repository Driver contract; it is not a canonical Git authentication path.

### Handoff and revocation are state transitions

`anyam agent handoff <agent>` revokes the current session before creating the
next one. `anyam agent revoke` increments the local authorization epoch,
revokes the grant, and records an audit event. A prior session cannot validate
its Workspace credential or invoke a broker tool after that transition.

All failures identify the budget or boundary, the requested value, a receipt,
and a recovery action. The local policy values are deliberately named as
provisional tripwires:

```text
policy=local-agent/v1;
sizing=provisional-tripwire;
remeasure-before-production
```

Before hosted production sizing, measure real agent session and credential
lifetimes and replace these values with a receipt-backed policy.

## Consequences

- Developers can keep using each agent's native interface while Anyam supplies
  the Change context and semantic controls.
- A local agent can run checks, inspect evidence, submit findings, and publish
  a revision without receiving canonical write authority.
- Credential leakage through checked-in MCP configuration and model context is
  materially reduced.
- The package remains independently buildable because the local adapter owns
  its CLI boundary and does not import Cloudflare or Realm code.
- The local adapter is deliberately not the hosted Realm implementation; the
  persisted record shapes and explicit denial semantics are the compatibility
  seam for the next identity/capability ticket.

## Rejected alternatives

- **Put a PAT in `.mcp.json` or `AGENTS.md`:** credentials spread into source,
  logs, backups, and model context.
- **Give the agent a canonical repository token:** violates the Landing
  boundary and makes a compromised local session materially dangerous.
- **Expose raw shell, arbitrary Git refs, or secret reads through MCP:** turns a
  semantic broker into an unbounded authority tunnel.
- **Make MCP the source data plane:** editors and agents already have a local
  filesystem and Git; MCP should coordinate, not reimplement Git transfer.
- **Persist bearer tokens for convenience:** the local state should survive a
  restart as metadata, not as reusable authority.
