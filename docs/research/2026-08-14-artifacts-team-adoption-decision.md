# Cloudflare Artifacts role in team adoption

## Question

When, if ever, should Cloudflare Artifacts move from an optional
`RepositoryDriver` to the preferred customer-operated source provider for the
credible-team Adoption Path?

## Decision

Cloudflare Artifacts remains an **optional, replaceable RepositoryDriver**.
It is not the preferred or required source provider for Anyam team adoption
while the selected customer account is behind the Artifacts feature gate and
the complete disposable qualification has not passed.

The default team path is the provider-independent Git Smart HTTP
`RepositoryDriver` already qualified by Anyam. Artifacts may be selected by a
Realm owner as an opt-in data-plane provider after the provider gate is open
and the qualification below produces a green receipt. The Anyam Realm,
Project, Source Space, Change, Evidence, Landing, Release, Target, export, and
recovery contracts do not change when the provider changes.

This is an integration boundary, not a rejection of Cloudflare. Artifacts is
a good fit for isolated Git repositories, agent Workspaces, and short-lived
repository credentials, but those provider mechanics must remain behind the
same driver interface as generic Git Smart HTTP and future providers.

## Current customer receipt

On 2026-08-14, the customer-operated Cloudflare account was remeasured with
the exact namespace-discovery operation:

```text
CLOUDFLARE_ACCOUNT_ID=1e0170aaabc90ecf5f466128d1f0466a
npx wrangler artifacts namespaces list --json
```

The provider returned:

```text
status=blocked
http-operation=GET /accounts/{account}/artifacts/namespaces
provider-code=10004
provider-message=Access denied by feature gate
created-resources=0
cleanup=not-required
credentialMaterialStored=false
recoveryAction=obtain Artifacts access, then rerun the same bounded qualification
```

This is a provider feature-gate receipt. It is not evidence that the Anyam
Cloudflare account, generic Git driver, or token policy is invalid. No
namespace, repository, Git token, or customer data was created by the probe.

The fallback receipt was re-run in the same work session:

```text
node --import tsx --test test/smart-http-repository.test.ts
tests=1; passed=1; failed=0
```

That qualification exercises real Git Smart HTTP clone and fetch, Workspace
push, compare-and-swap refs, canonical-write denial, export and restore with
digest verification, and retryable provider-outage recovery. It is a
qualification-only customer-controlled fixture receipt; it is not a claim
about a third-party provider's availability or capacity.

## Evidence required before Artifacts can be preferred

The account gate must first be open. Then one disposable, customer-owned
qualification must pass all rows below and leave no disposable resource behind.
Every row needs a redacted provider receipt; a documentation page or fixture
does not substitute for live evidence.

| Gate | Required receipt |
| --- | --- |
| Feature and namespace access | Namespace discovery, create, inspect, and delete succeed for the selected customer account. |
| Repository lifecycle | Disposable repository create, fork or import, inspect, and delete succeed; the exact cleanup target is recorded before mutation. |
| Credential lifecycle | Control-plane authentication is separate from repo-scoped Git credentials; read/write scope, expiry, revocation, renewal, and non-disclosure are observed without printing token material. |
| Git compatibility | Standard Git clone, fetch, pull, and push work against the returned Smart HTTP remote; the exact protocol behavior and refs are recorded. |
| Workspace isolation | A disposable Workspace repository can be created from an exact source snapshot, written by its delegated actor, and cannot read or mutate another Source Space or canonical ref. |
| Anyam authority boundary | Realm Authority remains canonical; provider writes are proposals or data-plane mutations only, and canonical Landing still requires Anyam policy and Evidence. |
| Failure and reconciliation | Inject or observe provider outage, rate-limit, duplicate, delayed, and credential-expiry paths; no partial Authority transition is accepted, and the same operation can reconcile or resume explicitly. |
| Export and restore | Export all repository refs/history required by the Project Export contract, restore into a clean destination, and compare refs/object digests and disclosure metadata. |
| Cleanup | Delete every disposable namespace, repository, token, Workspace, queue, and test artifact; cleanup is independently retried and receipt-backed. |
| Provider limits and cost | Record the provider's observed limits, operation counts, bytes, latency, retries, and pricing inputs as provider facts. Do not turn them into Anyam budgets without a separate workload measurement. |
| Replacement proof | Run the same source/Change/Workspace/export workflow through the generic Git driver and compare Anyam identities, policy results, and recovery semantics. |

Artifacts may become the **preferred opt-in provider** only after all rows pass
for the selected account and the team Adoption Path has a measured reason to
prefer it (for example, lower measured Workspace setup cost or simpler
operator recovery). A provider receipt alone does not make Artifacts a product
requirement.

## Operating policy while the gate is closed

- New Realm installations use the generic Git Smart HTTP driver by default.
- Existing projects are not migrated automatically or silently.
- A provider outage never moves canonical authority to Artifacts or another
  provider; the Realm enters an explicit degraded/reconciliation state.
- Project Export remains the recovery and exit path, independent of Artifacts.
- GitHub is a projection/contribution adapter, not a source authority.
- Blacksmith, if adopted later, is an execution/CI Runner adapter. It is not a
  workaround for Artifacts access and does not change the RepositoryDriver
  decision. GitHub Actions quota therefore does not block this qualification.

## Re-measurement trigger

Reopen this decision when Cloudflare grants Artifacts access to the selected
customer account, or when the provider changes its repository, Git, token, or
export contract. Repeat the exact bounded qualification and update this
receipt before changing the default driver or writing any new provider limit.

## Sources

- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Artifacts repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/)
- [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/)
- [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/)
- [Cloudflare Artifacts provider qualification](./2026-08-12-artifacts-provider-qualification.md)
- [Cloudflare-first architecture and provider boundaries](../adr/0015-cloudflare-first-architecture-and-provider-boundaries.md)
