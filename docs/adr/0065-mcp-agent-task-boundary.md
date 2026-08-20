# ADR 0065: Remote MCP writes execute as delegated Agent Tasks

- Status: Accepted
- Date: 2026-08-21
- Scope: OAuth-backed remote MCP mutations

## Context

The MCP handler previously forwarded the authenticated human owner kernel
session directly to the Authority for ordinary Project, Workspace, Change,
Run, and delivery mutations. The OAuth grant could be revoked, but normal
coding writes did not carry the Agent Actor, Task, or Capability Grant chain
that the identity system already used for credential exchange.

## Decision

Mutation-capable MCP resources carry an explicit delegated context in the
resource indicator:

`agentId`, `agentSessionId`, `taskId`, `capabilityGrantId`, and one or more
explicit `sourceSpaceId` values.

The owner authorization adapter validates that context before the provider
grant is created. MCP mutations then use a dedicated
`/authority/mcp-command/internal` boundary. That boundary verifies:

- the session is the named active Agent Actor;
- the Agent Session was delegated by the consenting human Session;
- the Task and Capability Grant are the exact same chain;
- the Project/Workspace/Change/Source Space resource is unchanged;
- the requested capability and effects are in the Grant;
- Source Space policy, team relationships, explicit denies, model-provider
  policy, and the current authorization epoch still allow the operation.

The human session remains the delegating consent authority. It is not reused
as the Agent execution identity. Project creation remains an owner bootstrap
operation; coding mutations require a delegated Task.

## Revocation behavior

Every mutation revalidates the live chain at the Authority boundary. Revoking
the Agent, parent Session, Task, or Grant therefore blocks the next mutation
without relying on cached OAuth scope state.

## Non-claims

This ADR does not claim enterprise SAML/SCIM, universal team workflows, or
promotion authority for agents. Landing, release, target, and promotion
operations remain subject to their own separation-of-duty policies.

## Receipt

- MCP tests cover delegated-context forwarding, request/inspect, and legacy
  completion denial.
- Realm identity already provides the live Task/Grant, Source Space, model,
  explicit-deny, and authorization-epoch checks used by the new boundary.
- No credential material is placed in the resource indicator or persisted in
  receipts.
