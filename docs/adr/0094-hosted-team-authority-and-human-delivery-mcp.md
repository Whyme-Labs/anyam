# ADR 0094: Hosted team Authority policy and human delivery MCP

Status: Accepted

Issue: [#271](https://github.com/Whyme-Labs/anyam/issues/271)

## Context

The Realm identity kernel already models Organization/Team relationships and
roles, but the hosted Authority edge used an owner-only shortcut for ordinary
Project, Workspace, Change, Run, Mirror, Promotion, and delivery operations.
The same mismatch made a human delivery MCP grant unreachable: the OAuth
adapter demanded Agent identity fields for every mutation scope even though the
coordinator had a separate owner-created delivery Task/Grant path.

## Decision

The identity policy exposes a read-only, resource-scoped effective capability
set for a Principal. The hosted Authority edge uses it for normal human
commands and safe resource reads. Explicit relationship denies remove a
capability even when another active relationship grants it.

Protected delivery execution requires `target.promote` and a fresh passkey
session. Landing, Release creation, Target configuration, and Promotion
request use their semantic capabilities; Release Manager receives the explicit
Release/Promotion capabilities in the role table.

Remote MCP authorization separates two paths:

- coding-agent mutations require the complete Agent/Session/Task/Grant
  binding;
- human delivery MCP uses a project-scoped resource with Source Space
  disclosure and no Agent fields. The coordinator creates and validates the
  owner Task/Grant for that OAuth grant before delivery mutation.

The hosted edge still keeps identity/recovery administration owner-only. A
normal team operation must never gain Realm-wide metadata by omitting its
Project resource.

## Consequences

- Contributors, reviewers, maintainers, and release managers can use the
  hosted Authority path according to their resource relationship.
- Delivery tools are reachable through a real human authorization journey,
  while coding agents remain unable to land, create Releases, configure
  Targets, or promote.
- The team path is additive to the identity kernel; it does not create a
  second policy engine or a second canonical authority.
- Full two-person approval and policy invalidation remain explicit follow-up
  work in the delivery governance layer; a green capability decision alone is
  not a production deployment receipt.

