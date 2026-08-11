# Anyam authentication and delegation standards profile

**Research snapshot:** 2 August 2026
**Ticket:** [#15](https://github.com/Whyme-Labs/anyam/issues/15)
**Status:** Decision-grade research; implementation commitments are limited to the “implement now” profile below.

This snapshot refreshes the authentication section of [`2026-07-31-platform-and-standards-assumptions.md`](2026-07-31-platform-and-standards-assumptions.md); it does not replace that broader platform audit.

## Executive decision

Anyam should use established identity and transport standards, but it must not mistake a protocol token for project authority.

The durable boundary is:

```text
External identity or local authenticator
        ↓
Anyam Realm principal
        ↓
Realm roles, relationships, Source Space policy, and explicit denies
        ↓
Task-scoped Capability Grant
        ↓
Audience-bound protocol credential
        ↓
Online policy decision for the exact operation
        ↓
Separate Git, MCP, runner, integration, or Target credential
```

Anyam owns the Realm, principal/actor/session/task model, grants, policy, consent, revocation, model-provider restrictions, and audit. OAuth, OIDC, MCP, Git credential helpers, SAML, SCIM, and workload identity provide interoperable ways to authenticate or carry a request; none of them defines Anyam’s Source Space, Change, Workspace, Evidence, Landing, or Promotion authority.

## Implement now, qualify, and defer

| Area | Implement now | Qualify before promising | Defer from the first interoperability contract |
|---|---|---|---|
| Browser identity | WebAuthn/passkeys; authorization-code OIDC/OAuth; host-only web sessions | Recovery, cross-device passkey behavior, enterprise IdP claims | Password-only login |
| Native CLI | Authorization Code + S256 PKCE using the system browser and loopback callback | macOS, Windows, Linux, SSH/headless callback behavior | Custom password grant |
| Headless CLI | Device Authorization only behind a verified server/client matrix | Phishing, polling, rate-limit, and recovery behavior | Treating device flow as universally available |
| Remote MCP | MCP `2026-07-28` HTTP authorization profile; RFC 9728, RFC 8414/OIDC discovery, RFC 8707 resource indicators, RFC 9207 issuer validation, Bearer header | Codex/Claude/Cursor/client compatibility, step-up, refresh, CIMD | Private protocol or token passthrough |
| Local MCP | `anyam mcp serve --stdio` broker using the local authenticated session | Process isolation, socket permissions, broker crash/restart | HTTP OAuth inside stdio |
| Git | Smart HTTP through the Anyam Git Gateway; `git-credential-anyam`; short-lived repository credentials | Git/Jujutsu/IDE compatibility, expiry/revocation, public projection | Making SSH the primary transport |
| Agent delegation | Anyam Capability Grant with principal, actor, task, resources, effects, model policy, budgets, and expiry | RFC 8693 token exchange and bounded actor chains | Unbounded impersonation or direct canonical writes |
| Rich authorization | Internal versioned authorization-details schema inspired by RFC 9396 | Interoperable RAR clients and consent UX | Encoding the entire ACL into OAuth scopes |
| Workload identity | Run-scoped job credentials exchanged by enrolled runners; OIDC or mTLS/SPIFFE adapter boundary | Provider-specific attestation and revocation behavior | Long-lived PATs in CI |
| Enterprise identity | OIDC first; SAML through an identity broker/Access adapter | Claim normalization, logout, tenant policy | Anyam-specific SAML protocol |
| Enterprise provisioning | SCIM 2.0 adapter for principals, groups, and deprovisioning | IdP-specific schemas and reconciliation | Making SCIM the authorization source of truth |
| SSH | Optional gateway-issued short-lived OpenSSH certificates after Git HTTPS works | CA rotation, host-key UX, certificate principals | Permanent user-uploaded SSH keys as the only identity |

## Standards status and source receipts

The dates and maturity labels below are part of the receipt for this profile. Drafts and beta libraries are not treated as stable standards.

### WebAuthn and passkeys

Use WebAuthn as the preferred local authentication method for browser users and Realm Owners. A passkey is a public-key credential scoped to the Realm’s relying-party origin; the private key remains with the authenticator. The browser account is not the same authority as an application user session.

Use passkeys for:

- Realm Owner and administrator authentication.
- Step-up authentication for visibility changes, Publication Changes, policy changes, exports, and protected Target Promotion.
- Recovery enrollment and device/session management.

Do not require a passkey for every public read or every low-risk Git fetch. Authentication strength is an input to policy, not a universal product gate.

Primary source: [W3C Web Authentication: An API for accessing Public Key Credentials Level 3](https://www.w3.org/TR/webauthn-3/).

### OAuth and OIDC

The stable security baseline is [RFC 9700, OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html), combined with the individual standards required by the client or resource:

- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html) for native applications.
- [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html) for PKCE; require `S256`.
- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html) for authorization-server metadata.
- [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) for resource indicators and audience restriction.
- [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html) for protected-resource metadata.
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) for issuer identification and mix-up protection.

[OAuth 2.1 draft-15](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15) is still an active Internet-Draft with no intended RFC status at this snapshot. Anyam should follow its direction but must not describe OAuth 2.1 as a finalized RFC. The normative implementation baseline remains the published RFCs above and RFC 9700.

Use OIDC Discovery and OIDC Core when a Realm trusts an external identity provider. The upstream `iss + sub` pair becomes the stable external identity key. Email is an attribute, not the permanent identity key.

Anyam should issue its own downstream resource credentials after upstream authentication. A Google, GitHub, Microsoft, Cloudflare Access, or customer-IdP token must not be accepted directly as authority to mutate Anyam state.

Primary sources: [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html), [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html), and the RFCs linked above.

### MCP HTTP authorization

The current MCP specification is `2026-07-28`. A protected HTTP MCP server is an OAuth resource server. Anyam’s remote MCP endpoint must:

1. Publish RFC 9728 protected-resource metadata.
2. Advertise an authorization server through RFC 8414 or OIDC discovery.
3. Require clients to use RFC 8707 `resource` in authorization and token requests.
4. Use one canonical project-scoped MCP resource URI as the audience.
5. Require the `Authorization: Bearer` header and reject query-string credentials.
6. Validate issuer, expiry, signature/introspection, audience, and grant state.
7. Return `401` for missing/invalid credentials and `403` for insufficient authority.
8. Never accept or forward a token issued for another resource.
9. Support step-up authorization for operations whose required scopes or capabilities increase.
10. Treat Client ID Metadata Documents as the preferred new-client path when compatible; retain pre-registration and Dynamic Client Registration as explicit compatibility options.

The MCP specification says HTTP authorization should conform to its profile, while stdio should not use that HTTP OAuth flow. That supports the Anyam split: remote MCP is an OAuth-protected resource; local stdio MCP is a local broker that retrieves credentials outside model context.

Primary sources: [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28/), and the [MCP release explanation](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).

### Token exchange, Rich Authorization Requests, and sender constraint

[RFC 8693 OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html) is the right standard shape for a human-to-agent, controller-to-runner, or integration-to-Target exchange, but it is not sufficient by itself. Anyam must prove that an exchange can only narrow authority, preserve the delegating principal, preserve the acting actor, bind the new token to the intended audience, and stop renewal after parent-grant revocation.

Therefore:

- Model the grant as an Anyam object first.
- Use RFC 8693 only as an interoperability envelope after the delegation spike passes.
- Reject subject substitution that loses the principal or task.
- Reject exchanges that widen Source Space, tool, network, Secret Use, Target, or budget authority.
- Bound delegation depth and record every exchange in the Audit Ledger.

[RFC 9396 Rich Authorization Requests](https://www.rfc-editor.org/rfc/rfc9396.html) is a good model for structured resource-specific consent. Anyam should use an internal versioned `authorization_details` representation before depending on RAR support in every client. OAuth scopes remain stable verbs; resource, Change, Workspace, Source Space, effect, budget, and expiry details belong in the grant object.

[RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html) is useful sender-constrained hardening for first-party API clients. It should remain optional post-v1 because MCP and Git interoperability still need ordinary Bearer behavior and because binding every Git request to a proof key requires client support.

### Git credentials and SSH

Git source transfer remains the data plane. Anyam should provide an Anyam Git Gateway and a `git-credential-anyam` helper.

The helper should:

- discover the Realm and Source Space from the remote URL;
- use the local CLI session or broker, not a plaintext PAT;
- request a short-lived repository credential for the exact operation;
- return an ephemeral Bearer credential where the Git client supports it;
- fall back to HTTP Basic compatibility without changing token lifetime;
- honor `credential.useHttpPath` so repositories on one host do not share credentials accidentally;
- erase or forget credentials on expiry and revocation.

The canonical Repository Driver credential is never exposed to the user or agent. Canonical repositories are read-only to ordinary clients; Workspace Repository credentials are the only normal write credentials. The Landing service performs the protected canonical mutation.

SSH is optional. OpenSSH certificates can be supported by a dedicated Git SSH gateway after HTTPS interoperability is proven, but a permanent uploaded SSH key is not the preferred identity model. SSH certificate support is a gateway and CA contract rather than a complete Anyam authorization model.

Primary sources: [Git credential API](https://git-scm.com/docs/git-credential), [Git credential helper protocol](https://git-scm.com/docs/gitcredentials), [Git credential interface](https://git-scm.com/docs/git-credential-interface), [RFC 4252](https://www.rfc-editor.org/rfc/rfc4252.html), and the [OpenSSH certificate documentation](https://man.openbsd.org/ssh-keygen.1).

### SAML and SCIM

SAML 2.0 remains an enterprise federation input, not Anyam’s native session format. A customer Realm may accept SAML through Cloudflare Access or an identity broker, then normalize the assertion into the Realm’s local principal and policy model. The integration must define issuer, audience, signing-key rotation, clock handling, NameID/subject mapping, logout behavior, and group-claim limits.

SCIM 2.0 is the right provisioning interface for enterprise lifecycle management:

- [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643.html) defines the core schema.
- [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644.html) defines the protocol.

Anyam should support SCIM for principal and group provisioning/deprovisioning at the Realm boundary after the core identity model is stable. SCIM changes membership; it does not directly grant Source Space or Target authority. Anyam policy still evaluates the resulting relationships and explicit denies.

### Workload identity and runners

CI and external runners must not receive long-lived personal tokens. The v1 contract is:

```text
Runner enrollment key or provider workload identity
        ↓
Match an authorized Run
        ↓
Exchange for a run-scoped job credential
        ↓
Read the exact immutable input Snapshot
        ↓
Write only the declared logs, Artifacts, and Evidence
        ↓
Credential and lease expire or are revoked
```

Anyam can provide adapters for OIDC workload identity, mTLS, or SPIFFE/SPIRE SVIDs. The kernel contract is provider-neutral: an enrolled runner proves possession of its workload identity, receives a job capability, and cannot write canonical source or approve its own Change.

Cloudflare Access service tokens are useful as an outer bootstrap identity for a trusted service, but they are static and do not carry the Project, Source Space, Change, Workspace, effects, or budget. They must be exchanged for a short-lived Anyam job credential and never enter model context.

Primary sources: [SPIFFE specification](https://spiffe.io/docs/latest/spiffe-about/overview/), [OIDC Federation/workload patterns](https://openid.net/specs/openid-connect-federation-1_0.html), and the applicable Cloudflare Access service-token documentation at implementation time.

## Client matrix

| Client | Login/authentication | Anyam credential | Server-side enforcement |
|---|---|---|---|
| Browser portal | Passkey or upstream OIDC/SAML | Host-only web session | Realm membership, Source Space policy, step-up, CSRF/session controls |
| `anyam` CLI | Authorization Code + S256 PKCE; device flow only when qualified | Rotated refresh token in OS keychain plus short-lived API tokens | Client, Realm, device/session, grant, and policy checks |
| Git | Git Gateway + credential helper | Short-lived read or Workspace write credential | Repository, Source Space, operation, and expiry checks |
| Local coding agent | Local stdio MCP broker and local Git helper | Task-scoped capability handle outside model context | Workspace, Change, tool, model, network, and Secret Use policy |
| Remote coding agent | Project MCP OAuth | Audience-bound MCP token plus delegated Anyam grant | MCP audience, scope/capability, task, and online grant epoch |
| CI Run | Workload identity or enrolled runner | Run-scoped job token | Exact input Snapshot and declared output set |
| Installed integration | App registration and asymmetric client assertion | Installation token | Project/Source Space/action installation permissions |
| Production application | Separate deploy identity | Runtime read-only release/provenance access | No source write, no policy administration, no self-promotion |
| Customer-operated Realm | Local passkey, OIDC, SAML, optional Access | Realm-issued downstream credentials | Local Realm policy; no required Anyam SaaS account |

## Credential classes and audience isolation

The following are different credential classes, even when they are all represented as opaque Bearer tokens at the wire:

```text
Browser session
Realm API token
Project MCP token
Git read credential
Workspace Git write credential
Agent task capability
Run job token
Installed-app token
Target/deployment token
PAT compatibility token
Optional SSH certificate
```

Every token class needs an explicit audience, issuer, subject/actor relationship, grant reference, expiry, and revocation behavior. A token issued for MCP must fail at the Git Gateway; a Git credential must fail at the MCP endpoint; a runner token must fail at Source Space mutation and Target Promotion.

Tokens should be opaque to clients. A signed JWT may be used internally, but clients must not depend on decoding claims or on stale embedded ACLs. High-risk requests resolve the live `grant_id` and authorization epoch through Realm authority.

PATs remain a compatibility fallback for tools that cannot use OAuth or the helper. They must be named, resource-scoped, action-scoped, expiring, revocable, and denied Realm administration or production Promotion by default. No unbounded, non-expiring “all repositories” PAT should exist in the default UX.

## Realm authorization calculation

The effective authority for an operation is the intersection of:

```text
Realm role
∩ organization/team relationships
∩ Source Space policy
∩ Project/Change/Workspace state
∩ client consent
∩ delegated Capability Grant
∩ device/network/model conditions
− explicit denies
```

An explicit deny wins. A successful authentication does not imply project access. A project-level grant does not imply access to every Source Space, private verifier, Secret Use operation, or Target.

The grant should preserve:

```text
principal: who delegated authority
actor: who/what is acting
client: which tool or integration
session: which authenticated execution
task: why the authority exists
project and Source Spaces: where it applies
Change and Workspace: which work it may alter
actions/effects/tools/network: what it may do
model policy: which provider may receive source
budgets and expiry: how much and how long
```

## Required negative tests and receipts

The following are release gates for the standards profile. A documentation check is not enough; each must be exercised against the actual implementation and supported client matrix.

1. **MCP audience isolation:** a valid MCP token for Project A fails for Project B, Git, runner, and deployment endpoints.
2. **Issuer/mix-up protection:** an authorization response with the wrong `iss` is rejected before code exchange.
3. **Resource binding:** the `resource` value in authorization and token requests is the exact canonical MCP URI.
4. **PKCE downgrade:** `plain` PKCE is rejected; a missing or mismatched verifier fails.
5. **Redirect validation:** unregistered, wildcard, or scheme-downgraded redirect URIs fail.
6. **Scope step-up:** an insufficient-scope operation returns a useful challenge without granting unrelated capabilities.
7. **Delegation narrowing:** every token exchange preserves principal and actor and cannot widen Source Space, effects, network, Secret Use, Target, or budget authority.
8. **Parent revocation:** revoking a parent task prevents renewal and high-risk operations from derived credentials.
9. **Credential class isolation:** MCP, Git, runner, installation, and Target credentials are mutually unusable.
10. **Canonical write protection:** a stolen Workspace credential cannot mutate the canonical repository or another Source Space.
11. **Local broker safety:** refresh tokens never appear in repository files, MCP configuration, model context, process arguments, or normal logs.
12. **Enterprise deprovisioning:** a SCIM removal and IdP disablement prevent new sessions and block online high-risk operations.
13. **Runner replay:** a completed or revoked Run token cannot be replayed to upload unrelated Evidence or Artifacts.
14. **Public read boundary:** anonymous public Git reads reveal no private object, identifier, path, notification, timing, or verifier metadata.

Any fixed token lifetime, quota, or retry budget must be measured by the relevant spike and recorded with a receipt. Until that measurement exists, the implementation should use configurable policy values rather than claiming a universal safe number.

## Cloudflare boundary

Cloudflare can supply useful implementation plumbing:

- Workers for the HTTP API, Git Gateway, OAuth endpoints, and MCP resource.
- Durable Objects for active grants, authorization epochs, session/device state, and serialized protected transitions.
- D1 for rebuildable identity indexes, membership views, and search.
- R2 for recovery exports and immutable audit/evidence objects.
- Cloudflare Access as an optional upstream identity/perimeter provider.
- `workers-oauth-provider` as an OAuth implementation toolkit after hardening.

Anyam must still own the data model and policy. In particular, Access is not Anyam authorization, the OAuth library is not a Realm, KV propagation is not an immediate-revocation guarantee, and an MCP token must never be passed through to Artifacts, Git, Cloudflare APIs, runners, or Targets.

## Qualification order

Run these qualification spikes before expanding the auth surface:

1. Workers OAuth hardening: S256-only, exact redirects, issuer/audience/resource checks, disabled implicit flow, online grant lookup, and authorization epochs.
2. CLI browser callback: system browser, loopback callback, keychain storage, cancellation, and headless fallback.
3. MCP client matrix: current Codex, Claude Code, Cursor, and representative SDK clients against discovery, PKCE, issuer, resource, `401/403`, refresh, step-up, and client-registration paths.
4. Delegation exchange: RFC 8693 envelope over a narrowing Anyam grant with bounded actor chain and parent revocation.
5. Credential isolation: a negative matrix for every token class and endpoint.
6. Runner workload identity: enrollment, job lease, immutable input, output binding, replay, and revocation.
7. Managed enterprise topology: Realm-level versus project-level Access applications, claims, provisioning, and customer-operated installation behavior.

## Final profile

The first Anyam implementation should ship:

```text
passkey and one upstream OIDC path
authorization code + S256 PKCE
host-only browser sessions
OAuth-protected project MCP
local stdio MCP broker
Anyam Git Gateway + credential helper
Workspace-only user/agent writes
Anyam Capability Grants
run-scoped runner credentials
app installation credentials
SCIM/SAML adapter boundaries, not core dependencies
explicit audit and revocation
```

It should not ship a private authentication protocol, direct canonical write tokens, universal device flow, unconditional token exchange, mandatory DPoP, permanent SSH-key-only access, or a claim of universal MCP client compatibility.

## Primary source list

- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [OAuth 2.1 draft-15](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15)
- [RFC 9700 OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html)
- [RFC 8252 OAuth for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [RFC 7636 PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
- [RFC 8414 Authorization Server Metadata](https://www.rfc-editor.org/rfc/rfc8414.html)
- [RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html)
- [RFC 8725 JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html)
- [RFC 8693 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html)
- [RFC 9068 JWT Access Token Profile](https://www.rfc-editor.org/rfc/rfc9068.html)
- [RFC 9207 Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207.html)
- [RFC 9396 Rich Authorization Requests](https://www.rfc-editor.org/rfc/rfc9396.html)
- [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 7643 SCIM Core Schema](https://www.rfc-editor.org/rfc/rfc7643.html)
- [RFC 7644 SCIM Protocol](https://www.rfc-editor.org/rfc/rfc7644.html)
- [MCP 2026-07-28 authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Git credential API](https://git-scm.com/docs/git-credential)
- [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)

This document is a standards profile, not a certification. Current client behavior, Cloudflare product maturity, and draft specifications must be re-verified before each architecture freeze.
