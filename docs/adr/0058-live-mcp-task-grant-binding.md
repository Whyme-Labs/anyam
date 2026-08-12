# ADR 0058: Bind MCP delivery grants to live delegated Task capabilities

## Status

Accepted for the Realm OAuth and remote MCP delivery boundary.

## Context

An OAuth provider grant authenticates an MCP client to a resource server, but
it is not the Realm's durable authorization decision. A provider-side grant
can outlive the human Session, be replayed after a policy epoch change, or be
presented against a different Project resource. Scope-filtered tool discovery
is therefore not sufficient protection for mutations such as landing a Change,
creating a Release, configuring a Target, or requesting a Promotion.

Anyam already models the stronger chain:

```text
Principal → human Actor → Session → Task → Capability Grant
```

The MCP delivery path must validate that chain immediately before it enters
the typed Authority command surface. Read-only MCP grants do not need a Task
or Grant because they do not request delivery authority.

## Decision

### Resource-bound delivery authorization

An OAuth grant that requests a delivery scope MUST carry a project-scoped MCP
resource indicator. The supported shape is:

```text
https://host/mcp/projects/project:video-player
https://host/mcp/projects/project:video-player/workspaces/workspace:editor
https://host/mcp/projects/project:video-player/workspaces/workspace:editor/changes/change:codec
https://host/mcp/projects/project:video-player/changes/change:codec
```

The URI may include repeated `sourceSpaceId` query parameters. The coordinator
resolves those identifiers against the live Project and refuses a missing,
foreign, hidden, or stale Source Space. A bare `/mcp` resource is valid for
read-only access but cannot create a delivery grant.

### Owner-created Task and Grant

After provider authorization is persisted, the Realm coordinator creates an
Anyam human-owned Task and Capability Grant for the exact MCP resource. The
provider grant and the Task/Grant remain separate records:

```text
OAuth grant: transport authentication and revocation mapping
Task/Grant:  live Realm authority for the requested delivery operations
```

The Task/Grant is created only from the authenticated human Session. It binds
the Principal, human Actor, Session, client, Project/Workspace/Change resource,
Source Space disclosure set, operation capabilities, typed effects, expiry,
and current authorization epoch. It has no Git, MCP, deployment, promotion,
or other bearer credential material; credentials are not issued by this
delivery grant.

Delivery operations map to stable capabilities as follows:

| Typed operation | Required capability | Effect checked at delivery |
|---|---|---|
| `landing.apply` | `landing.request` | `landing.apply` |
| `release.create` | `release.create` | `release.create` |
| `target.configure` | `target.configure` | `target.configure` |
| `promotion.request` | `promotion.request` | `promotion.request` |

The grant cannot contain `canonical.write`, `production.deploy`, or
`target.promote`. `landing.apply` is a typed request into the protected
Authority plane; it is not direct canonical-write authority.

### Fail-closed delivery validation

Immediately before every typed delivery mutation, the MCP handler calls the
Realm coordinator's `validate-delivery` operation. Validation MUST confirm:

- the OAuth record is active, unexpired, and bound to the current Session,
  Actor, client, and authorization epoch;
- the stored Task and Capability Grant are active and form the same
  Principal → Actor → Session chain;
- the exact audience/resource URI is unchanged;
- the Project, optional Workspace, optional Change, and Source Space set still
  exist and have the expected lineage;
- the operation maps to the requested OAuth scope and the Task/Grant action;
- the typed effect is present in the grant and no prohibited effect is added.

Only a credential-free validation receipt permits the subsequent typed
`/authority/command/internal` call. Provider execution, canonical source
mutation, production approval, and bearer-token issuance remain outside this
validation operation. A failed or ambiguous validation stops before Authority
and returns a disclosure-safe, actionable error.

### Safe projections and revocation

OAuth grant listing and MCP validation responses expose only safe projections:
status, expiry, scope/resource-bound booleans, counts, and receipts. Provider
grant identifiers, Task/Grant identifiers, session handles, source object
identifiers, and credential material are not returned to the MCP client.

Revoking the provider mapping, Realm Session, Task, Grant, or authorization
epoch invalidates the delivery path. Reauthorization creates a fresh binding;
an old MCP token cannot be upgraded or widened in place.

## Consequences

- A remote MCP client must consent to a project audience before it can request
  delivery mutations.
- The extra coordinator validation round trip is intentional: it is the
  receipt-backed boundary between transport authentication and durable
  delivery authority.
- Read-only MCP OAuth remains compatible and does not create a Task/Grant.
- Human owners can use the same path for solo delivery without exposing a
  canonical repository credential.
- Agents remain separate: agent delegation uses the existing parent-grant and
  child-task chain and cannot inherit this human delivery authority.
- Typed mutation qualification must prove stale, revoked, denied, and
  cross-Project bindings stop before Authority, with no credential material in
  the response.

## Rejected alternatives

- **Treat OAuth scopes as the complete authorization model:** provider scopes
  do not represent Realm policy epochs, Source Space disclosure, or the live
  Principal/Actor/Session chain.
- **Validate only when tools are listed:** a grant may be revoked or narrowed
  after discovery; mutation-time validation is required.
- **Pass the MCP token to Git, Cloudflare, or a provider:** this breaks
  audience isolation and turns a transport credential into an unrelated
  capability.
- **Give the Task/Grant canonical-write effects:** delivery requests must still
  pass through the protected Authority and Promotion state machines.

## Evidence and gates

The boundary is covered by:

- Realm identity tests for valid and revoked human-owned Task/Grant chains;
- remote MCP tests for stale, revoked, denied, and cross-Project delivery;
- Worker entrypoint coverage proving validation precedes Authority;
- the fixture-only `qualification:mcp-delivery-mutations` script, which proves
  all four typed operations remain idempotent and credential-free;
- `build:realm`, focused tests, and the full repository test gate.

Any timeout, provider error, or missing receipt keeps the qualification
indeterminate. The Worker Target qualification is separate provider evidence;
it does not establish MCP grant validity.
