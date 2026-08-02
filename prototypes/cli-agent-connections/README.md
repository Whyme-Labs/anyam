# CLI, Git, MCP, and coding-agent connection prototype

**THROWAWAY PROTOTYPE — not production Anyam code.**

## Question

Can one local session connect the Anyam CLI, Git, MCP, and coding agents without exposing a refresh token or canonical repository write authority?

The prototype exercises:

```text
login
→ clone Project View
→ configure Codex/Claude/Cursor/CLI
→ launch an isolated Change Workspace
→ publish a Change Revision
→ hand off to another agent
→ recover from an expired Git credential
→ revoke the active grant
→ prove the next publish is blocked
```

## Run

Node 22+ can execute this TypeScript prototype directly through its built-in type stripping:

```bash
node prototypes/cli-agent-connections/cli.ts
```

For the complete scripted scenario:

```bash
node prototypes/cli-agent-connections/cli.ts --demo
```

## Interactive commands

```text
login
clone
setup codex|claude|cursor|cli
launch codex|claude|cursor|cli
publish
handoff codex|claude|cursor|cli
expire-git
reauth
revoke
reset
demo
quit
```

## What to inspect

- The refresh credential is always shown as `os-keychain-only`; no token value exists in the model.
- Git and MCP sessions have different audience strings.
- Git credentials point at a Workspace and always show `canonical write: denied`.
- A handoff revokes the old session and creates a fresh task grant.
- Publishing after credential expiry is blocked until `reauth`.
- Publishing after revocation remains blocked even though the local process still exists.
- The event timeline shows successful and blocked operations as the user drives the state.

## Verdict capture

This prototype is a primary source for Wayfinder ticket [#17](https://github.com/wms2537/anyam/issues/17). It should remain on its throwaway branch. Only the validated command/session/credential decisions should be absorbed into Anyam’s durable architecture after review.
