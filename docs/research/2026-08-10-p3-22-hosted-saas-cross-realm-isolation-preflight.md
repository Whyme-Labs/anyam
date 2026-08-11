# Shared Hosted SaaS cross-Realm isolation preflight

Date: 2026-08-10
Issue: [Qualify shared Hosted SaaS cross-Realm isolation](https://github.com/Whyme-Labs/anyam/issues/128)
Map: [Plan Anyam beyond bounded P3 public beta](https://github.com/Whyme-Labs/anyam/issues/118)
Protocol: `anyam.p3-22-hosted-saas-cross-realm-isolation-preflight/v1`
Status: preflight blocked; no live Hosted SaaS qualification claimed

## Question

Can a deployed shared Hosted SaaS control plane prove that two independent
Realms cannot read, mutate, enumerate, or infer one another's state across
storage, Durable Object identity, credentials, caches, queues, search/read
models, events, exports, logs, errors, and timing metadata?

## Decision

Not yet. The current checkout contains a customer-operated Realm foundation
and a framework-neutral Realm policy kernel, but it does not contain a deployed
shared Hosted SaaS control plane against which the required negative matrix can
run. Local policy tests are useful boundary evidence; they are not a live
shared-tenant qualification.

The issue must remain open until a shared Hosted SaaS release, disposable
two-Realm cohort, and owner-authorized cleanup path exist. No provider account,
resource, SLO, quota, latency, or physical-isolation claim is made by this
preflight.

## Current repository evidence

### The deployed Worker contract is customer-operated only

`src/cloudflare/realm-worker.ts` declares
`CUSTOMER_REALM_HOSTING_MODE = "customer-operated"`. Its health response
reports `authority=customer-owned`, requires an installation identity, and only
exposes health and bootstrap metadata until a customer control route is bound.
The module explicitly does not perform Hosted SaaS bootstrap, shared routing,
or tenant orchestration.

### Persistence is installation-scoped and customer-operated

`src/cloudflare/customer-realm-persistence.ts` keys state by installation ID
and rejects state whose hosting mode is not `customer-operated`. This is a
valuable installation boundary, but it does not prove a shared control-plane
namespace with multiple Hosted SaaS Realms.

### The installation control plane is customer-owned

`src/installation/customer-realm.ts` and
`src/installation/customer-realm-control.ts` implement owner-authorized
customer installation, recovery, and provider-grant workflows. They do not
implement the Hosted SaaS request router, pooled read models, shared cache
namespace, or multi-Realm event/export service required by this ticket.

### Existing tests are local/kernel evidence

The current checkout passes `npm test`: 124 tests passed, 0 failed. The tests
cover Realm-local policy intersection, audience separation, disclosure-safe
hidden Source Spaces, delegated agent revocation, customer-operated recovery,
and provider-independent persistence. They do not exercise a deployed shared
Hosted SaaS control plane or the full cross-product negative matrix.

The earlier multi-Realm qualification is explicitly framework-neutral and
credential-free. It qualifies distinct local principals, policy, credentials,
revocation, and disclosure behavior; it does not qualify live WebAuthn/OIDC,
HTTP routing, shared storage, caches, queues, search, events, exports, logs, or
timing paths.

The provider-reliability receipt already records the same boundary:
shared Hosted SaaS cross-Realm isolation is **unqualified** because there is no
deployed shared control-plane negative matrix.

## Provider facts that shape the qualification

These facts are inputs, not Anyam isolation claims:

- Cloudflare describes each Durable Object as a globally unique instance with
  its own persistent storage and recommends modeling one object per tenant or
  other logical coordination unit. See [Rules of Durable
  Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- Workers for Platforms' default untrusted dispatch mode provides isolated
  Worker caches; trusted mode shares cache space and therefore requires
  customer-specific cache keys or equivalent isolation. See [Worker
  Isolation](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/worker-isolation/).
- D1 is a managed SQL service, but a shared database still requires Anyam's
  Realm-scoped query, key, and projection policy. See [D1](https://developers.cloudflare.com/d1/).
- Queue pull consumers use leases, explicit acknowledgement, retries, and
  redelivery. Queue delivery is not an Anyam authoritative state transition.
  See [Queues pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
  and [batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/).

Provider topology or a successful same-Realm request cannot substitute for an
Anyam negative test. A provider primitive may be correctly isolated while an
Anyam routing key, read model, cache key, error, export, or event projection is
wrong.

## Required live qualification

The future receipt must bind:

```text
Anyam Release and source digest
Hosted SaaS deployment and adapter versions
Realm A and Realm B identifiers
policy versions and authorization epochs
synthetic Project/Source Space/Change data
provider account and resource identifiers
test client, credential audiences, and capability grants
correlation and idempotency keys
observed operations and population/exclusions
cleanup authority and exact deletion receipts
```

### Positive journey

An authorized principal in Realm A must be able to create, read, mutate, and
export its own synthetic Project through the deployed HTTP/API/Git/MCP path.
The receipt must show the expected Realm A lineage and read-back digests.

### Negative cross-Realm matrix

Using Realm A credentials, identifiers, and correlation material, attempt to
read, mutate, enumerate, or infer Realm B across:

```text
HTTP/API routing and host aliases
Durable Object names and storage keys
D1 rows and search/read-model projections
R2 objects and Project Export/recovery bundles
Git and MCP credential audiences
Workers cache keys and cache reads
Queues, leases, retries, dead-letter, and consumer scope
Workflow/event/webhook routing
provider account/resource identifiers
logs, traces, audit entries, error bodies, and timing metadata
```

Every unauthorized result must be disclosure-safe. A single cross-Realm source,
credential, object identity, metadata, event, or authority leak blocks the
qualification; there is no acceptable percentage for a security boundary.

### Recovery and cleanup

The cohort must exercise at least one revoked credential, duplicate or
redelivered event, stale authorization epoch, restart/redeploy, and export or
read-model rebuild. Each ambiguous result must remain `indeterminate` until
the Coordinator proves the expected authoritative effect, lineage, and digest.
All synthetic resources and data must be deleted and independently verified.

## Preconditions before live execution

1. A shared Hosted SaaS Worker/router and Coordinator release exists.
2. Realm scope is explicit in every authority-bearing key, lookup, cache,
   queue, event, export, log, and error projection.
3. A disposable owner-authorized account and two synthetic Realms are available.
4. A negative-matrix harness can assert both non-disclosure and non-mutation.
5. The deployment has a bounded cleanup plan and no production data is used.
6. The receipt schema can record provider observations without turning them into
   Anyam quotas or SLOs.

Until these preconditions are met, the correct state is `unqualified`, not a
green Hosted SaaS claim.

## Next action

Implement the smallest shared Hosted SaaS control-plane fixture that can run
the above two-Realm positive/negative matrix. Keep the customer-operated Realm
path as a separate Hosting Mode and preserve the provider/adapter boundary.
Then rerun this ticket as a live, disposable qualification with a new receipt.

