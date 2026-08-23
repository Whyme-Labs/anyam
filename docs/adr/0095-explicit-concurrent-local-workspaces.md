# ADR 0095: Explicit concurrent local Workspaces

Status: Accepted

Issue: [#272](https://github.com/Whyme-Labs/anyam/issues/272)

## Context

The local broker persisted multiple historical sessions but used one
`currentSessionId` for every operation. Starting another agent on the same
Project either reused the current session or required a handoff that revoked
the previous one. That was safe for a linear qualification but not for the
intended Codex/Claude/Cursor parallel workflow.

## Decision

`currentSessionId` is now only a convenience default. The state ledger remains
the source of truth for all active sessions.

- `startSession({ parallel: true })` creates an additional isolated Workspace
  for the same active Change without revoking the existing session;
- `listSessions()` and `inspectSession(sessionId)` expose explicit selectors;
- `status(sessionId)` and credential issuance accept an explicit session;
- `workspace start`, `workspace list`, `workspace inspect`, and
  `workspace exec --session <id>` expose the selection in the CLI;
- `agent handoff --session <id>` revokes only the selected session.

Revocation remains per-session and per-Workspace. No command may silently
change another session's credential or process boundary.

## Consequences

- Linear existing scripts keep working through the current-session default.
- Parallel Workspaces have a visible identity and independent revocation.
- The local state file remains one serialized ledger; Workspaces themselves
  remain separate boundaries.
- Hosted multi-Change persistence and provider Workspace materialization remain
  separate product/qualification work.

