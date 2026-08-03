# ADR 0042: P3 Realm-local identity and Federation boundary

- Status: Accepted
- Date: 2026-08-03
- Issue: [Decide whether Realm federation belongs in P3](https://github.com/wms2537/anyam/issues/101)
- Depends on: [ADR 0024](./0024-open-governance-profiles-and-compliance-boundaries.md), [ADR 0030](./0030-realm-identity-and-capability-policy.md), [ADR 0040](./0040-realm-owned-agent-actors-and-human-to-agent-delegation.md)

## Context

Anyam must support public contribution, private and customer-operated Realms,
and independently managed installations without making a hosted Anyam identity
or cross-Realm trust a prerequisite. The Realm identity qualification already
showed that two Realms can map the same upstream issuer and subject to distinct
local Principals, keep Source Space disclosure local, reject foreign
credentials, and revoke authority independently. Realm-owned agent delegation
now preserves the same boundary for agent Actors and their parent Grants.

P3 still needs a sharp answer to whether a contributor or customer must join a
Realm-to-Realm federation network before using a public project or a
customer-operated install. Federation is a hard-to-reverse trust and protocol
surface, so leaving the answer implicit would become a landmine.

## Decision

P3/public beta is **Realm-local by default**. Federation is not a P3
requirement and is not enabled implicitly.

The minimum P3 trust contract is:

```text
upstream passkey/OIDC authentication
        ↓
destination Realm maps issuer + subject to a local Principal
        ↓
Realm membership, Source Space policy, Capability Grants, and explicit denies
        ↓
audience-bound Git, MCP, Runner, integration, or Target credentials
```

Each Realm owns its own:

- Principal and team records;
- membership and Source Space policy;
- Capability Grants, authorization epoch, and revocation;
- credential audiences and exchange policy; and
- Audit Events and disclosure decisions.

The same external identity, team name, project name, agent ID, or client ID in
two Realms does not create authority in either Realm. A credential, Grant,
agent registration, or session issued by one Realm is rejected by another
Realm. Explicit denies and hidden-resource responses remain destination-local.

### Public contribution without federation

Public contribution uses the destination Realm's public Project View or Source
Space projection. A contributor may clone the public projection, propose a
Change, and submit a signed or authenticated contribution envelope. The
destination Realm decides whether to create a local contributor Principal,
accept the Change through its public gateway, or reject it under its own abuse,
policy, and quota controls.

The public projection contains no private Source Space identifiers, object IDs,
paths, Change metadata, agent context, or sealed-test implementation. A public
contributor does not need a credential issued by a private source Realm.

### Customer-operated installs without federation

A customer-operated Realm is standalone and recoverable. It may trust one or
more approved upstream OIDC providers and passkeys, but it does not require an
Anyam SaaS account, global identity, or federation service to authenticate its
members, operate its Projects, or export its state. Provider adapters establish
identity; the customer Realm remains authoritative for authorization and audit.

### Later Federation adapter

Federation may be added after P3 as an explicit adapter. A future Federation
relationship must specify, at minimum:

- the two Realm identifiers and their signing/trust metadata;
- the exact Projects, Source Spaces, Actions, Targets, and disclosure classes;
- resource indicators and audience-bound exchanged credentials;
- local Principal/Actor mapping without automatic membership propagation;
- independent revocation, authorization epochs, and expiry;
- attribution of the originating Principal, Actor, Session, Task, and Grant;
- replay, abuse, rate, and loop controls; and
- export, recovery, and trust-removal behavior.

Federation must never create shared canonical authority, bypass a destination
Realm's policy, expose private metadata through a public projection, or pass a
source Realm's bearer token to Git, MCP, a Runner, or a Target. Git-compatible
mirroring remains the lower-trust interoperability path and is not Federation.

This decision is the explicit P3 default under the absence of a contrary
product requirement. It is reopenable if a concrete cross-Realm customer or
ecosystem requirement supplies a trust, disclosure, revocation, abuse, and
operational receipt that cannot be met by Realm-local membership and public
contribution envelopes.

## Consequences

- P3 can qualify public contribution and customer-operated installs without
  waiting for a new cross-Realm protocol or global identity service.
- Customer-owned Realms remain independently operable, exportable, and
  recoverable.
- The implementation can keep the Federation adapter boundary open without
  weakening today's fail-closed cross-Realm behavior.
- Public contribution is a destination-Realm operation with explicit
  disclosure and abuse controls, not an implicit trust relationship.
- A future Federation implementation must preserve local authority and add
  receipts before it can be enabled for a customer cohort.

## Rejected alternatives

- **Require Realm federation for P3:** adds a new trust network and failure
  surface before public contribution or customer-operated installs need it.
- **Create a global Anyam identity:** conflicts with customer ownership and
  makes the hosted service a hidden dependency for self-hosted Realms.
- **Treat matching issuer, team, or project names as trust:** names are not
  authority and can cause accidental cross-Realm disclosure.
- **Pass source-Realm credentials to the destination:** violates audience
  isolation and makes revocation and audit ambiguous.
- **Use Git mirroring as federation:** mirroring transfers permitted source
  state; it does not establish identity, membership, or cross-Realm authority.
