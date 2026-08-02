# Realm identity and Capability policy kernel

Status: Accepted

## Context

Anyam has several clients that must not share one credential or one implicit
authorization decision:

- browser sessions authenticated with passkeys or an approved OIDC provider;
- the TypeScript CLI and Git credential helper;
- local and remote MCP clients;
- agent Tasks and Workspaces;
- CI and external Runners;
- installed integrations;
- Deployment and Promotion services.

The client and the deployed Project application must remain separate. A
credential that can read a Source Space must not automatically be able to
write canonical source, invoke a Runner, or promote a Release.

## Decision

`src/identity/realm.ts` provides the framework-neutral Realm policy kernel.
It is deliberately an in-memory state machine at this stage. Cloudflare D1,
Durable Objects, WebAuthn, OIDC discovery, token endpoints, and provider SDKs
will be adapters around this contract; they must not become a second policy
engine.

### Realm-local authentication

The Realm retains the local Principal record after an upstream authentication
event. The kernel accepts a verified passkey assertion or a verified OIDC
identity from an adapter, then creates a local Session and Actor chain:

```text
Principal → Actor → Session → Task → Capability Grant
```

Passkey credentials are bound to the Realm relying-party ID. OIDC identities
are keyed by issuer and subject and must be explicitly linked to a local
Principal. The kernel does not pretend to perform WebAuthn signature
verification or OIDC discovery itself; the adapter must supply `verified:
true` only after those checks succeed.

### Deny-first effective authority

Every protected operation is evaluated against the same ordered factors:

```text
active Principal
∩ Actor and Session chain
∩ client operation and audience consent
∩ role and Relationship grants
∩ Source Space policy
∩ Task Capability Grant
∩ model, authentication, approval, and Promotion conditions
− explicit denies
```

An explicit deny wins over an otherwise satisfied factor. An unknown protected
factor returns `indeterminate` unless a deny or hidden-resource rule already
requires `deny`. The result is a structured Policy Explanation with the
missing capability and remediation. Protected resource identifiers are omitted
when the caller is not entitled to discover them; the caller receives
`not_found`, not a private metadata oracle.

### Narrow delegated grants

Capability Grants preserve the delegating Principal, Actor, client, Session,
Task, Project/Source Space resource, Change/Workspace scope, effects, model
providers, credential classes, budgets, policy version, and authorization
epoch. A derived Grant can only narrow its parent actions, Source Spaces,
effects, model providers, credential classes, and expiry. Revoking a parent
revokes its descendants and issued credentials.

Policy activation increments the Realm authorization epoch. Existing Grants,
credentials, and stale Sessions cannot silently cross that boundary; they must
be re-evaluated or re-authenticated.

### Separate credential audiences

The kernel issues opaque, short-lived credentials with distinct audiences:

```text
realm-api, git, mcp, runner, integration, deployment, promotion
```

The issued token value is returned only once. The Realm state stores only its
digest. Validation checks the credential class/audience, resource, Session,
Grant chain, Principal status, and current authorization epoch. Revoking one
credential does not revoke another audience. Revoking a Grant or Session
revokes the credentials derived from that authority.

The numeric lifetimes are configurable and carry the receipt
`policy=realm/v1; sizing=configurable-tripwire; remeasure-before-production`.
Production adapters must replace these provisional values with measured
receipts before publishing a customer-facing limit.

### Audit attribution

Authentication, Grant, credential, policy, and revocation events retain the
Principal, Actor, client, model provider, Session, Task, Grant, Workspace,
Change, Source Space, Promotion, and authority class whenever present. Audit
records contain token IDs/digests and never token values.

## Consequences

- Web, CLI, Git, MCP, Runner, integration, Deployment, and Promotion adapters
  all call one policy surface.
- Authentication providers establish identity; the Realm remains the source of
  Anyam authorization.
- The local MCP broker can keep refresh credentials outside the model context
  and request a Task-scoped credential through this kernel.
- Provider implementations can use D1/DO state, but they must preserve the
  same deny-first result, disclosure-safe errors, epoch checks, and audit
  fields.
- A verified passkey/OIDC adapter and a durable credential/token store remain
  required before production deployment. This module is a policy contract, not
  a claim that production cryptography has been implemented.

## Rejected alternatives

- **One universal PAT:** cannot express transport audience, Task scope, model
  policy, or independent revocation.
- **Role-only authorization:** cannot constrain one Task, Workspace, Source
  Space, client, model, or Promotion.
- **Flat OAuth scopes as the ACL:** cannot safely represent resource-specific
  effects and disclosure rules.
- **Hidden files in one Git object graph:** leaks metadata and makes public
  Project Views unsafe; Anyam keeps Source Spaces independently protected.
- **MCP token passthrough:** permits cross-service replay and confused-deputy
  behavior; downstream adapters must exchange for their own audience.
- **Direct canonical writes:** ordinary clients and agents write task
  Workspaces; trusted Landing authority performs canonical mutation.
