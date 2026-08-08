# Post-P3 provider-feed, reliability, and tenant-isolation receipts

Date: 2026-08-08  
Issue: [Measure provider feed, reliability, and tenant-isolation receipts](https://github.com/wms2537/anyam/issues/120)  
Map: [Plan Anyam beyond bounded P3 public beta](https://github.com/wms2537/anyam/issues/118)  
Protocol: `anyam.post-p3-provider-reliability-tenant-isolation/v1`  
Status: bounded receipt and measurement contract qualified; live provider-feed, shared-hosted reliability, and live cross-Realm isolation remain unqualified

## Question

What operational measurements are required before Anyam can make a next-stage
claim about provider feeds, request/error latency, recovery, availability,
cross-Realm isolation, and customer-owned resource failures? Establish the
receipt schema, measurement journeys, tripwires, failure disclosure, and
explicit limits without inventing quotas or universal reliability claims.

## Decision

Anyam may make only per-surface, per-Hosting-Mode claims that are backed by a
receipt bound to an exact release, policy, provider, resource, workload, and
measurement method. It must not publish one platform-wide uptime number, copy a
provider quota into an Anyam quota, or treat a provider acknowledgement,
Queue acknowledgement, Workflow state, dashboard metric, or sampled trace as
an authoritative Anyam transition.

The current evidence is sufficient to qualify the measurement contract and the
framework-neutral logical isolation/recovery seams. It is not sufficient to
qualify:

- a current provider usage or billing feed;
- a hosted-SaaS availability or latency SLO;
- shared-infrastructure cross-Realm isolation in a deployed control plane;
- customer-owned D1/R2/Queue/Workflow failure injection and recovery; or
- a universal reliability, capacity, quota, residency, or cost claim.

Those gaps are explicit next tickets, not silent assumptions.

## Existing receipt contract

The existing TypeScript qualification registry already has the right durable
record families. `src/qualification/stages.ts` defines:

- `QualificationContext` — Project Revision, Project View, Source Space
  snapshots, policy and authorization epochs, toolchain/dependency/environment
  digests, Runner, Grant, disclosure, Action, Verifier, Change, Target, input
  and effect digests;
- `MeasuredQuantity` — value, unit, source, method, measured-at timestamp, and
  a human-readable measurement receipt;
- `ReliabilityObjective` — SLI, measured target and error budget, method
  receipt, owner, Hosting Mode, and lifecycle receipt;
- `UsageReceipt` — Realm/Project/Source Space/Workspace/Task/Run scope,
  provider resource, logical unit, quantity, optional cost, retry class,
  idempotency key, disclosure, and receipt;
- `ProviderCostReceipt` — provider quantity, Anyam-attributed quantity,
  optional billed quantity/cost/variance, feed status, correction pointer, and
  receipt;
- `BudgetPolicy` and `BudgetDecision` — configured/provider limit, requested
  and consumed quantities, state, uncertainty, recovery action, and receipt;
- `RecoveryDrill` — checkpoint, validity context, expected invariant, observed
  result, status, owner, next action, and receipt; and
- `QualifiedResidualRisk` — owner, mitigation, qualification gate, explicit
  open/accepted/deferred decision, decision receipt, and next action.

These types are the authority for the qualification record. Dashboards and
provider telemetry are inputs to those records, not replacements for them.

## Receipt schema

Every provider or reliability receipt must carry these dimensions, even when a
field is `unavailable` or `indeterminate`:

```text
protocol
receiptId
observedAt
validityKey
releaseDigest
policyVersion
authorizationEpoch
hostingMode
realmId / organizationId / projectId
sourceSpaceId / workspaceId / changeId / runId / attemptId / targetId
provider
providerAccountOrInstallation
providerResource
providerOperationId
operation
correlationId
idempotencyKey
inputDigests
outputDigests
status
providerStatus / HTTP status / error class
startedAt / completedAt / duration
quantity and unit, where applicable
sample population and exclusions, where applicable
recoveryAction
disclosure policy
owner
source and method
receipt text
```

The record must distinguish:

```text
provider accepted a request
Anyam recorded an authoritative transition
customer-visible operation completed
```

These are different facts. A provider acknowledgement may be recorded as an
input while the Anyam operation remains `pending`, `degraded`, or
`indeterminate` until the owning Coordinator verifies the expected version,
read-back digest, and idempotency state.

## Measurement journeys

### 1. Provider-feed journey

For usage, cost, quota, or provider-health data:

```text
record Anyam Usage Receipt
  → query the provider feed for the same provider resource and period
  → bind the response to provider account, SKU, and feed version
  → compare provider and attributed quantities
  → record current, delayed, unavailable, or reconciled
  → expose variance and next reconciliation action
```

`unavailable` is a valid receipt. It must not be converted into zero cost,
zero usage, or a guessed invoice. A delayed feed remains advisory until a
current feed reconciles it.

### 2. Request/error/latency journey

Measure each user-visible operation separately rather than averaging all
traffic together:

```text
safe public Project View read
authenticated command
Git clone/fetch/push
Change publish
Run dispatch and completion
Evidence read-back
Release creation
Target Promotion and health check
mirror reconciliation
export and restore
```

Each observation records total requests, successful requests, client errors,
provider errors, Anyam errors, timeouts, cancellations, disconnected clients,
and the latency distribution. Percentiles are computed only from a named
population with explicit exclusions; a mean or provider invocation success
count is not a substitute for the user-visible SLI.

### 3. Failure and recovery journey

For each authority-bearing operation:

```text
capture precondition and checkpoint
  → inject or observe one failure class
  → verify visible pending/degraded/indeterminate state
  → restart or redeploy the coordinator where relevant
  → retry the same operation/idempotency key
  → verify one authoritative effect, exact lineage, and digest/read-back
  → record recovery checkpoint and safe next action
```

The matrix must cover provider timeout, HTTP failure, authorization loss,
duplicate delivery, redelivery, out-of-order delivery, Workflow stall, partial
provider mutation, stale compare-and-swap, credential revocation, export
restore, and remote mirror divergence. A missing or ambiguous result is
`indeterminate`, never success.

### 4. Cross-Realm isolation journey

Isolation must be tested as a negative matrix, not inferred from a successful
same-Realm request. For two distinct Realms, test:

```text
storage and Durable Object identity
token and credential audience
cache keys and cache reads
Queue messages and consumer scope
search/read-model rows
event and webhook delivery
Project Export and recovery objects
provider account/resource identifiers
logs, traces, error bodies, and timing metadata
```

The positive case proves an authorized operation works in Realm A. The negative
case proves the same principal, token, operation, and resource identifiers do
not read, mutate, enumerate, or infer Realm B. Any cross-Realm source,
credential, object identity, metadata, event, or authority leak is a blocker;
there is no acceptable percentage for a security boundary.

### 5. Customer-owned resource failure journey

For each customer-owned adapter, bind the exact customer resource and run a
disposable failure matrix:

```text
D1 unavailable or stale
R2 write/read-back failure
Queue publish, redelivery, and dead-letter
Workflow stall or duplicate callback
Worker deployment propagation failure
provider authorization revoke/restore
```

The receipt must show what remains authoritative in Anyam, which writes pause,
which reads remain safe, how the customer resumes, and how cleanup is verified.
Existing customer Realm persistence receipts qualify the local/provider seam
and exact recovery shape; they do not qualify every live customer-owned
resource failure or availability claim.

## Tripwires and limits

The following are product tripwires, not arbitrary fixed quotas:

| Dimension | Tripwire | Healthy path | Failure disclosure |
| --- | --- | --- | --- |
| Provider feed | feed state is not `current` or reconciled | attributed and provider quantities agree | show `delayed`/`unavailable`, variance, owner, and reconciliation action |
| Request latency | measured distribution is outside the named objective | per-surface SLI remains within its measured objective | name operation, population, observation, objective, and next action |
| Availability | required observations are missing or include unexplained failure | complete denominator and explicit exclusions | `indeterminate`; do not claim uptime |
| Recovery | checkpoint, digest, or idempotency proof is missing | one effect and resumable lineage | leave operation pending/degraded and block high-risk continuation |
| Isolation | any cross-Realm disclosure or mutation | only authorized Realm state is reachable | fail closed, revoke/quarantine, preserve audit, and block the gate |
| Budget | requested or consumed quantity exceeds measured policy | tripwire is beyond healthy workload | name budget, configured limit, request, consumed, receipt, and recovery |
| Provider authority | grant/account/resource scope is absent or stale | customer authority is current and exact | deny or quarantine; never fall back to an Anyam-owned broad token |

No numeric Anyam limit is introduced by this receipt. A future numeric limit
must be sized from a workload measurement and include the measurement receipt,
population, account/plan, method, and remeasurement trigger. Provider-documented
limits remain adapter facts and are surfaced separately from Anyam policy.

## Failure disclosure contract

Every failure exposed to a developer, agent, or operator must name:

```text
dependency/provider
operation and resource scope
current state
provider status or error class, if safe to disclose
configured limit and requested amount, if a limit was involved
receipt or correlation id
whether an authoritative effect occurred
safe recovery action
```

Public or lower-disclosure projections omit private resource names, tokens,
customer data, and hidden Source Space metadata, but they still disclose that
the result is denied, delayed, unavailable, or indeterminate. A blank response,
silent retry, or green dashboard without an evidence record is not a receipt.

## Current evidence

### Local logical contract

Commands run on 2026-08-08:

```text
npm test
  123 passed, 0 failed
  test runner duration=20344.759375 ms

npx tsx --test \
  test/realm-identity.test.ts \
  test/customer-realm-control.test.ts \
  test/customer-realm-persistence.test.ts \
  test/public-beta-stage-gate.test.ts
  14 passed, 0 failed
  test runner duration=378.822375 ms

npm run typecheck
  passed

git diff --check
  passed
```

The local suite proves useful bounded seams: disclosure-safe `not_found` for
hidden Source Spaces, audience-separated credentials and revocation, explicit
cross-Realm agent denial, authenticated customer control, stale compare-and-
swap rejection, provider-outage checkpoint recovery, credential-free recovery
objects, and explicit Stage Gate advisories. These are logical-kernel and
fixture receipts, not live hosted-SaaS isolation or provider SLOs.

### Existing live disposable cohort

The P3 provider receipt records:

```text
Cloudflare customer-owned Worker health: 20/20 HTTP 200 in a later sample
Earlier warm-up: 4/5 HTTP 200, one transient 500
GitHub timed outbound push: 3.204 s
GitHub timed outbound fetch: 2.984 s
providerFeed: unavailable
tenantIsolation: deferred
universalSupport: false
```

These are observations of disposable fixtures. The 20/20 sample is not an
uptime SLO, the transient 500 is not a diagnosed provider fault, and the GitHub
timings are not a customer-facing latency target. The disposable resources
were deleted and the live customer-owned R2 archive path separately remains
blocked by provider authorization.

### Primary provider facts

Cloudflare documents that Workers metrics expose request success/error counts,
invocation statuses, wall time, and (under the documented conditions) request
duration, while metrics delivery can lag and retention is finite. Anyam must
therefore record the observation population and source rather than treating a
dashboard graph as an authoritative ledger:

- [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/)

Cloudflare documents Queues as at-least-once delivery with retries and
redelivery; a configured dead-letter queue is the safe place for messages that
reach the retry limit. Anyam must deduplicate at the Run/effect boundary and
must not call Queue acknowledgement business completion:

- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

Cloudflare documents Durable Objects as globally unique per object ID with
private, strongly consistent storage. The provider's own observability notes
also warn that isolate-level samples are not measurements of one object in
isolation. Anyam therefore needs explicit Realm/resource identity tests and
must not infer tenant isolation from platform topology alone:

- [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
- [Durable Objects storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Durable Objects observability](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)

Cloudflare's API rate and runtime limits are provider constraints. They are
adapter inputs for backoff and visible errors, not Anyam quotas. Anyam must
remeasure healthy workloads before publishing a product tripwire:

- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)

## Qualification matrix

| Claim | Current decision | Evidence boundary |
| --- | --- | --- |
| Receipt schema and explicit feed states | qualified | TypeScript registry and Stage Gate contract |
| Local failure disclosure and budget errors | qualified | local tests with named receipt, limit, request, and recovery |
| Local Realm/Source Space and credential isolation | bounded qualified | kernel tests; no hosted provider assertion |
| Local checkpoint, restart, digest, and idempotency recovery | bounded qualified | customer Realm persistence/control tests |
| Disposable customer-owned Worker observation | bounded advisory | existing P3 cohort; no SLO or provider fault diagnosis |
| Provider feed currentness/reconciliation | unqualified | existing P3 receipt says feed unavailable |
| Shared hosted-SaaS cross-Realm isolation | unqualified | no deployed shared control-plane negative matrix |
| Customer-owned provider failure matrix | unqualified | R2 authorization and live control/resource failures remain open |
| Platform-wide availability, latency, quotas, cost, or capacity | explicitly not claimed | no common population or receipt |

## Follow-up frontier

This research decision graduates three precise investigations:

1. Qualify live provider-feed reconciliation and per-surface reliability with
   an owner-authorized provider account, a disposable deployment, a named
   observation window, and an explicit cleanup/recovery receipt.
2. Qualify shared Hosted SaaS cross-Realm isolation across storage, tokens,
   caches, queues, search, events, exports, logs, and error/timing disclosure.
3. Qualify customer-owned provider failure and recovery for the actual control
   plane and resource adapters, including authorization loss and cleanup.

These investigations must not be merged into a single uptime number. Each
provider, Hosting Mode, surface, and failure domain gets its own receipt and
claim boundary.

## Final receipt

```text
protocol=anyam.post-p3-provider-reliability-tenant-isolation/v1
status=bounded-measurement-contract-qualified
localKernel=123-tests-passed; targeted=14-tests-passed
providerFeed=unavailable; no invoice or usage claim invented
liveReliability=observation-only; no SLO or quota claimed
tenantIsolation=local-logical-seams-passed; live-shared-hosted-unqualified
customerResourceFailures=live-matrix-unqualified
recovery=checkpoint-digest-idempotency contract qualified; provider-specific gaps visible
universalSupport=false
```

No product code changed for this ticket. The receipt records what Anyam can
claim now and the exact evidence required before a broader claim.
