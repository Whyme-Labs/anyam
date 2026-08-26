# ADR 0108: Explicit Pull Request transition table

Status: Accepted

Issue: [#302](https://github.com/Whyme-Labs/anyam/issues/302)

## Context

Pull Requests are a compatibility projection over Anyam Changes. Approval and
Landing are necessary for merge, but they do not make a closed or blocked
Pull Request open again. Without an explicit state transition rule, a caller
could approve and land a Change, then merge a Pull Request that had been
closed or blocked without recording a reopen transition.

## Decision

Authority uses one exhaustive transition table:

| Current | Allowed next states |
| --- | --- |
| `open` | `closed`, `blocked`, `merged` |
| `closed` | `open` |
| `blocked` | `open` |
| `merged` | none |

Idempotent requests for the current state remain no-ops. Every non-idempotent
transition is checked against the table before merge-specific approval,
Landing, or provider projection work. A rejected transition names the current
state, desired state, allowed transitions, and recovery action in its receipt.

REST and MCP error projections preserve the coordinator detail in a redacted,
URL-encoded receipt so agents can correct the state rather than seeing a blank
failure.

## Consequences

- Direct merge from `closed` or `blocked` is impossible without explicit
  reopen.
- `merged` remains terminal and cannot be reopened, closed, blocked, or
  updated.
- Mirror, REST, MCP, export, and restore surfaces retain one stable state
  model because they all project the Authority Pull Request.

## Receipt

- Authority tests cover closed and blocked direct-merge rejection.
- REST and MCP tests cover visible conflict receipts and explicit reopen before
  merge.
- Mirror projection tests cover a closed external proposal after Landing.
- Existing terminal, review invalidation, export, and restore tests remain
  green.
