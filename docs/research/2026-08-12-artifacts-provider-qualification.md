# Cloudflare Artifacts provider qualification

## Receipt

On 2026-08-12, the customer-owned Cloudflare account was selected explicitly:

    account=1e0170aaabc90ecf5f466128d1f0466a

Wrangler authentication was verified before the provider probe. The local
Wrangler OAuth session reported the `artifacts=write` scope for the selected
account. The bounded provider operation was:

    CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a npx wrangler artifacts namespaces list --json

The provider returned:

    status=blocked
    http-operation=GET /accounts/{account}/artifacts/namespaces
    provider-code=10004
    provider-message=Access denied by feature gate
    credentialMaterialStored=false
    cleanup=not-required; no namespace or repository was created
    recoveryAction=obtain Artifacts access for this account, then rerun the same bounded qualification

This is a provider gate, not an Anyam policy decision and not evidence that
the account token is invalid. No repository, token, Git remote, or customer
data was created by this probe.

## Provider facts used for the boundary

Cloudflare documents three interfaces to the same Artifacts repository:

- Workers binding for repository lifecycle and token management.
- REST API for external control-plane operations.
- Git Smart HTTP for clone, fetch, pull, and push.

The documented REST path requires Artifacts Read/Edit access. Git uses a
separate repository-scoped token rather than the Cloudflare API token. The
documented Git surface supports protocol v1 for pushes and v1/v2 for clone and
fetch. Artifacts is documented as closed beta, so feature access is an
external prerequisite rather than an Anyam guarantee.

Sources:

- <https://developers.cloudflare.com/artifacts/concepts/repositories/>
- <https://developers.cloudflare.com/artifacts/api/git-protocol/>
- <https://developers.cloudflare.com/artifacts/get-started/rest-api/>
- <https://developers.cloudflare.com/artifacts/>

## Boundary decision

Anyam keeps the provider-independent `RepositoryDriver` boundary and the
qualified Smart HTTP path as the private-alpha default. Cloudflare Artifacts
is an optional provider adapter and cannot be treated as the canonical source
of truth until the account's feature gate is cleared and a disposable
create/token/Git/Workspace/export/restore/delete qualification succeeds.

The private-alpha invariants therefore remain:

- provider control-plane authority is separate from Git credentials;
- Git credentials are short-lived, repository-scoped, and audience-bound;
- canonical source mutation is Landing-only;
- Workspaces are the only agent-writable repositories;
- Project Export and recovery remain provider-independent;
- a fixture or a provider documentation page never becomes a live provider
  receipt.

The existing Smart HTTP qualification is the fallback evidence for the current
journey. This receipt deliberately does not claim Cloudflare Artifacts support,
capacity, availability, or production SLOs.

## Remeasurement trigger

When Cloudflare grants Artifacts access to the account, rerun the exact bounded
qualification with a disposable namespace and repositories. The qualification
must capture repository creation, read/write token issuance without printing
token material, Git push/clone/fetch, Workspace isolation, export/restore,
verification, and cleanup. Any provider limit or TTL written into a production
policy needs a new measurement receipt from that run.
