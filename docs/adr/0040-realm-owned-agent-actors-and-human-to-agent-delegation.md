# ADR 0040: Realm-owned agent Actors and human-to-agent delegation

- Status: Accepted
- Date: 2026-08-03
- Issue: [Implement Realm-owned agent Actors and human-to-agent delegation](https://github.com/Whyme-Labs/anyam/issues/90)
- Depends on: [ADR 0030](./0030-realm-identity-and-capability-policy.md), [ADR 0039](./0039-customer-operated-installation-control-path.md)

## Context

The Realm identity kernel already distinguished a human Principal, Actor,
Client, Session, Task, Capability Grant, and credential audience. The
`ActorKind` union also named `agent`, but no Realm-owned agent registration or
delegation operation existed. A model runtime could therefore be recorded as
metadata while still inheriting the human session's authority, and there was
no durable parent chain for revocation or audit.

The missing boundary must work for local and remote agent clients without
making an agent a second human account. It must preserve the human Principal
who delegated the work, identify the concrete agent runtime and model
provider, narrow authority to the Task, and close all derived authority when
the parent Session, parent Grant, or enrolled agent is revoked.

## Decision

### Realm-owned agent registration

`RealmIdentityPolicy.registerAgent` creates a Realm-local `RealmAgent` record
with:

- an opaque agent identity;
- the owning Principal and Realm;
- a human-readable name and runtime identity (for example `codex-cli`);
- one enrolled model provider;
- an agent-specific client identity; and
- an explicit allow-list of credential audiences.

Registration stores no provider secret, refresh token, Git token, MCP token, or
other credential material. The agent client is an ordinary Realm client with
the intersection of its configured audiences and the agent registration's
audiences.

Agent registrations are Realm-local. An agent ID or client ID from another
Realm is not a discoverable or usable identity in this Realm.

### Human-only delegation

`RealmIdentityPolicy.delegateAgent` is the only constructor for a delegated
agent Session. It accepts an active human Session and a human-owned parent
Capability Grant whose actions include `agent.delegate`. The human's active
Realm relationship must also grant `agent.delegate` for the requested
resource and must not explicitly deny it.

Agent-to-agent delegation is intentionally not enabled by this ADR. That
keeps the delegation graph one level deep until a measured need and a new
policy contract justify another authority hop.

The operation creates, in order:

```text
RealmAgent
  ↓
agent Actor + delegated Session
  ↓
agent Task
  ↓
child Capability Grant
```

The Actor, Session, Task, and Grant retain:

- `agentId`;
- `delegatedByActorId`;
- `delegatedBySessionId`; and
- the parent Grant relationship.

The returned `anyam.delegation/v1` envelope includes a receipt that states the
human-to-agent boundary and `canonicalWrite=false`.

### Narrowing rules

The child Grant must remain inside the parent Grant and agent registration:

- resource scope and Source Spaces are subsets;
- actions and declared effects are subsets;
- the enrolled model provider is the only child model provider;
- credential classes are in both the agent allow-list and parent Grant;
- a child expiry is no later than the parent expiry;
- an explicitly declared budget cannot exceed the parent budget; and
- agent authority rejects `target.promote`, `policy.manage`, and
  `identity.manage`.

The parent Grant must explicitly list credential classes before they can be
delegated. An empty parent credential audience is therefore no audience, not
an implicit wildcard. An omitted parent model provider or budget dimension
remains unbounded, so a child may add a stricter model or budget constraint.

Direct `createCapabilityGrant` calls for an agent Actor without a human parent
Grant are rejected. Canonical source mutation, Landing, and production
promotion remain outside the agent capability set; an agent can propose a
Change and publish a revision only through its isolated Task authority.

### Revocation lineage

Session activity is evaluated across the complete parent Session chain. A
parent Session revocation closes every descendant Session and Task, revokes
their Grants and credentials, and records the delegated-session count in one
receipt. Revoking an agent registration closes all Sessions, Grants, and
credentials created for that agent but does not revoke the owning human's
Session or Principal.

Grant revocation continues to cascade through child Grants. Credential
validation checks the Session chain, agent registration status, Grant chain,
Realm authorization epoch, audience, and resource before returning success.

### Recovery and compatibility

Recovery snapshots include the credential-free agent registry. Older snapshots
without an `agents` collection hydrate as an empty registry; older human
Actors without a status hydrate as active for compatibility. Recovery restore
still revokes Sessions and Grants and never restores credential material.

The protocol version is `anyam.agent/v1`; the existing Actor, Session, Task,
Grant, and audit contracts carry the delegation fields without changing Git,
MCP, or external provider transport contracts.

## Consequences

- Codex, Claude Code, Cursor, and other clients can use one Realm-owned agent
  identity while retaining their provider-specific authentication outside the
  Realm credential store.
- Audit records distinguish a human Principal delegating work from the agent
  runtime performing it.
- Git and MCP credentials can be issued to a Task-specific agent client while
  remaining audience-bound and revocable.
- Parent revocation is visible and complete rather than relying on token
  expiry or an agent's cooperation.
- Human sessions remain independent: revoking one agent does not log the human
  out or revoke the human's other work.
- The one-level delegation boundary is intentionally narrower than a general
  OAuth token exchange and can be extended only through a new decision backed
  by a concrete use case and receipt.

## Rejected alternatives

- **Treat the model provider string as agent identity:** it is not unique,
  revocable, or Realm-owned and cannot distinguish two concurrent sessions.
- **Give the agent the human Session or PAT:** this collapses Principal and
  Actor, prevents precise revocation, and leaks human authority into the
  agent runtime.
- **Register one global agent account for all Realms:** this breaks customer
  ownership and cross-Realm isolation.
- **Let agents delegate more agents immediately:** it adds an unmeasured
  authority graph and makes revocation and review harder before the first
  human-to-agent path is qualified.
- **Use an agent deny-list only:** deny-lists are not a positive scope proof;
  the child Grant must be a subset of the parent and enrolled audience.
- **Let the parent Session revocation rely on short token TTLs:** expiry is a
  delay, not revocation; the Session and Grant chains must fail closed online.
