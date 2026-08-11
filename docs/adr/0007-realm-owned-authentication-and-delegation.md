# Realm-owned authentication and delegation

Status: Accepted

## Context

Anyam must support browser users, native CLI clients, headless automation, Git clients, local and remote MCP clients, coding agents, CI runners, installed integrations, production applications, and Customer-operated Realms. These clients have different transport and credential requirements, but they must not create independent or conflicting authorization models.

The owner resolved this standards profile in ticket [#15](https://github.com/Whyme-Labs/anyam/issues/15). The dated research receipt is [`docs/research/2026-08-02-authentication-and-delegation-standards.md`](../research/2026-08-02-authentication-and-delegation-standards.md).

## Decision

1. A Realm owns local principals, organization membership, Source Space policy, grants, consent, revocation, model-provider policy, and audit. Upstream identity providers authenticate a principal but do not directly authorize Anyam operations.
2. Browser authentication uses WebAuthn/passkeys and authorization-code OIDC/OAuth. Sensitive operations require policy-controlled step-up authentication. Browser sessions are host-only and are never shared with a deployed Project application.
3. Native CLI authentication uses the system browser with authorization code + S256 PKCE and a loopback callback. Device Authorization is a qualified optional path, not a universal assumption. Refresh credentials are stored in the OS keychain or an equivalent secure store.
4. Remote HTTP MCP uses the MCP `2026-07-28` authorization profile: RFC 9728 protected-resource metadata, RFC 8414/OIDC discovery, RFC 8707 resource indicators, RFC 9207 issuer validation, Bearer authorization headers, exact audience validation, and explicit `401`/`403` handling. Local stdio MCP uses an authenticated local broker instead of HTTP OAuth.
5. Anyam exposes source through an Anyam Git Gateway and `git-credential-anyam`. Git credentials are short-lived and Source Space/repository scoped. Canonical repositories are not writable by ordinary humans, agents, or integrations; only trusted Landing authority writes them.
6. Every delegated operation is represented by an Anyam Capability Grant preserving the principal, actor, client, session, task, Project, Source Spaces, Change, Workspace, effects, tools, network, model policy, Secret Use, budgets, and expiry. Explicit denies win.
7. RFC 8693 Token Exchange is an interoperability envelope to qualify after the internal grant model. Exchange can only narrow authority, preserve principal and actor attribution, bind the new audience, and stop renewal after parent revocation. RAR (RFC 9396) inspires the structured grant representation before it becomes a client interoperability dependency.
8. MCP, Git, runner, installed-app, and Target credentials are distinct audiences and cannot be used interchangeably. MCP tokens are never passed through to Git, Artifacts, Cloudflare APIs, runners, or Targets. Tokens are opaque to clients.
9. CI and external runners use enrolled workload identity or an approved provider adapter to obtain run-scoped job credentials. Personal tokens are not placed in CI. SAML and SCIM are enterprise adapter boundaries: SAML authenticates through a broker, and SCIM provisions principals/groups; neither becomes the source of Anyam authorization.
10. SSH certificates are optional gateway support after HTTPS interoperability is proven. Permanent user-uploaded SSH keys are not the primary identity model. DPoP is optional post-v1 hardening because MCP and Git interoperability still require Bearer-capable clients.

## Consequences

- The product has one authorization model across the Web UI, CLI, Git, MCP, agents, runners, and integrations.
- The implementation must maintain a live grant/revocation check for high-risk operations; an embedded token ACL is not authoritative.
- Anyam must build a Git credential helper, local MCP broker, token-exchange boundary, and audience-isolation tests in addition to ordinary OAuth endpoints.
- Customer-operated Realms remain independently operable and do not require an Anyam SaaS account or global account.
- Protocol drafts, client support, and Cloudflare OAuth tooling remain qualification dependencies. The implementation must negotiate and record supported client/protocol versions rather than claim universal compatibility.
- Credential classes and audience boundaries are testable security invariants, not documentation-only conventions.

## Rejected alternatives

- **One universal PAT:** too broad, hard to revoke safely, unsuitable for agent delegation, and incompatible with separate Git/MCP/runner/Target audiences.
- **Cloudflare Access as the authorization system:** Access can provide upstream identity and perimeter controls but does not model Source Spaces, Changes, Workspaces, effects, model policies, or Promotion.
- **MCP token passthrough:** creates confused-deputy and cross-service replay risk; MCP credentials must be exchanged or mapped to separate downstream credentials.
- **Direct canonical Git writes:** current repository-provider credentials are too coarse to express Anyam’s Landing policy; task work must land through trusted authority.
- **OAuth scopes as the complete ACL:** flat scopes cannot safely express exact Source Spaces, Change/Workspace, effects, budgets, model restrictions, or Target state; those belong in the live Capability Grant.
- **SAML/SCIM as the source of truth:** enterprise identity and lifecycle systems are inputs to Realm relationships, not Anyam policy or protected-state authority.
- **SSH-only access:** unnecessary for the first HTTPS-native Git implementation and prevents clean browser/CLI/agent credential lifetimes.
