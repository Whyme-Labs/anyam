# ADR 0048: Native Workers OAuth with optional Cloudflare Access

- Status: Accepted
- Date: 2026-08-08
- Depends on: [ADR 0030](./0030-realm-identity-and-capability-policy.md), [ADR 0042](./0042-p3-realm-local-identity-and-federation-boundary.md)

## Context

Anyam's customer-operated Realm exposes a project-scoped MCP resource. MCP
clients need a standards-based OAuth authorization server, but a customer
installation must remain self-owned and must not require Cloudflare Zero Trust
or an Anyam-hosted identity service.

Cloudflare provides two different OAuth layers:

1. `@cloudflare/workers-oauth-provider` is an origin-side Workers library. It
   implements the OAuth/MCP protocol boundary in the Anyam Worker, including
   client registration, authorization-code handling, token storage, and bearer
   validation.
2. Cloudflare Access Managed OAuth is a perimeter feature for an Access-
   protected application. It makes Access the OAuth authorization server and
   delivers an Access assertion to an origin that understands that boundary.

These layers solve different problems. Enabling both by default would create
two authorization servers for one resource, make `WWW-Authenticate` ownership
ambiguous, and introduce an unnecessary dependency on a customer's Access
configuration.

## Decision

The Anyam Realm Worker uses the official Cloudflare Workers OAuth Provider as
its native MCP OAuth implementation.

The boundary is:

```text
MCP client
  → Anyam Worker OAuth Provider
  → Anyam Realm owner authentication and consent
  → Anyam Capability policy
  → project-scoped MCP handler
```

Anyam owns:

- Realm-local Principals, membership, roles, relationships, and policy;
- owner authentication and step-up requirements;
- MCP resource and scope consent;
- task and agent Capability Grants;
- separate Git, MCP, Runner, and Target credential audiences;
- revocation, audit, and recovery semantics; and
- the semantic MCP tool surface.

`OAUTH_KV` is provider state only. The durable Realm coordinator remains the
authority for identity and capability decisions. The provider must not be
treated as a substitute for Anyam authorization.

Cloudflare Access Managed OAuth is an optional adapter for customers who
already protect the Worker with Access and want Access to provide the outer
enterprise identity or device/network policy. It is not required for a
customer-operated Realm, the default deployment, local development, or the
Anyam MCP contract.

If Access Managed OAuth is enabled around an Anyam Worker, the deployment
must choose one clear protocol owner. Anyam must not advertise its own OAuth
discovery and `WWW-Authenticate` contract behind an Access configuration that
rewrites those responses unless the adapter explicitly validates the Access
assertion and maps it into a Realm Principal. A customer must never enable
Managed OAuth merely because the MCP endpoint exists.

## Consequences

- A customer can deploy Anyam into its own Cloudflare account without
  provisioning Zero Trust or relying on Anyam SaaS.
- The official Cloudflare provider receives protocol maintenance while Anyam
  retains product-specific authorization and portability.
- MCP clients see one Anyam resource audience and one discovery surface.
- Access can be added at the perimeter for enterprise posture without
  changing the Realm capability model.
- A provider outage or API change does not silently widen Anyam authority;
  provider state remains separate from kernel state.
- The Workers OAuth Provider remains an isolated adapter so a future
  self-hosted or non-Cloudflare OAuth provider can implement the same Anyam
  contract.

## Rejected alternatives

- **Require Cloudflare Access Managed OAuth:** this makes customer-owned
  deployments depend on a separate Zero Trust product and gives Access
  responsibility for identity semantics that belong to the Realm.
- **Implement all OAuth protocol machinery ourselves:** this duplicates a
  maintained Cloudflare boundary and increases protocol/security surface
  without improving Anyam's differentiator.
- **Run both OAuth servers by default:** this creates ambiguous discovery,
  audience, consent, and `WWW-Authenticate` behavior.
- **Use Cloudflare Access as the Realm authorization database:** Access can
  authenticate and enforce perimeter conditions, but it cannot replace
  Source Space, Task, Agent, Grant, model-provider, or promotion policy.

## Receipt

The current qualification Worker imports
`@cloudflare/workers-oauth-provider`, serves MCP OAuth routes through that
provider, and leaves Access Managed OAuth optional. The local and deployed
qualification surfaces must continue to report provider and kernel evidence
separately.
