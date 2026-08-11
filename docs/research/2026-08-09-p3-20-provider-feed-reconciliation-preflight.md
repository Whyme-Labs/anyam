# P3-20 provider-feed reconciliation and per-surface reliability preflight

Date: 2026-08-09
Issue: [Qualify live provider-feed reconciliation and per-surface reliability](https://github.com/Whyme-Labs/anyam/issues/127)
Map: [Plan Anyam beyond bounded P3 public beta](https://github.com/Whyme-Labs/anyam/issues/118)
Protocol: `anyam.provider-feed-reconciliation-preflight/v1`
Status: **primary-source preflight complete; live provider cohort remains unqualified**

## Question

Can Anyam reconcile provider usage/health observations with its own
authority-bearing operations, measure each user-visible surface separately,
and recover from provider failure without turning telemetry or an
acknowledgement into an authoritative state transition?

## Decision

The measurement contract from [#120](https://github.com/Whyme-Labs/anyam/issues/120)
is implementable with the current Cloudflare primitives, but the provider
facts below do not constitute a live Anyam receipt. A live qualification still
requires an owner-authorized disposable cohort, an exact observation window,
an Anyam Release/policy binding, and cleanup authority.

Anyam must keep three facts separate:

```text
provider accepted or reported an operation
Anyam recorded an authoritative transition
the customer-visible operation completed
```

Provider metrics, Queue acknowledgements, Workflow state, logs, and sampled
traces are evidence inputs. The owning Coordinator remains authoritative and
must verify checkpoint, idempotency, expected state, and digest/read-back
before advancing an operation.

## Current provider facts

### Workers metrics and logs

Cloudflare Workers metrics aggregate request data for an individual Worker;
requests are split into success/error counts and invocation statuses. Request
duration is a separate metric and is documented as available only under the
documented Smart Placement condition. Metrics delivery can lag near the most
recent window, and the metrics view retains up to three months in maximum
one-week increments. Wall time, CPU time, execution duration, and memory are
different measurements; memory percentiles are sampled at the isolate level.

Workers metrics therefore support provider observations, not a complete
Anyam request ledger. Anyam must bind an observation to the Worker version,
route/surface, population, exclusions, source, and observed-at time. A missing
or delayed feed is `delayed` or `unavailable`, not zero.

Sources:

- [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Workers logs](https://developers.cloudflare.com/workers/observability/logs/)
- [Tail Workers](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)

### Durable Objects metrics

Durable Objects expose namespace-level and request-level analytics through
Cloudflare's GraphQL datasets. The dashboard can filter by a Durable Object
ID or name, but metrics are still subject to normal analytics ingestion and
sampling behavior. Memory is measured for the whole isolate, which may host
multiple objects, not for one object in isolation.

The qualification must therefore test Realm and resource identity directly;
it cannot infer tenant isolation or per-object memory from namespace topology
or a filtered chart.

Sources:

- [Durable Objects metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- [Filter Durable Objects metrics by object ID or name](https://developers.cloudflare.com/changelog/post/2026-06-12-durable-objects-metrics-filter-by-id-name/)

### Queues delivery and pull observations

Cloudflare Queues provides at-least-once delivery. Duplicate delivery is an
expected provider behavior, so a unique message ID must be stored alongside
the Anyam job, attempt, and enqueue idempotency key. A pull message includes
an ID, timestamp, attempt count, and lease ID. Pull consumers explicitly
acknowledge or retry lease IDs; an unacknowledged message is eligible for
redelivery after its visibility window. A dead-letter queue is the safe
destination after a configured retry limit; without one, messages that reach
the retry limit are deleted.

Anyam must acknowledge only after a signed Result has passed input, output,
credential, and current-Attempt validation. An acknowledgement alone never
means that the Run succeeded. The live cohort must capture message ID,
enqueue idempotency key, lease, attempt count, ack/retry result, redelivery,
and final Anyam state.

Sources:

- [Queues pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Queues dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

### R2 output and read-back

Cloudflare R2 documents strong consistency for direct bucket/API reads,
writes, deletes, and object listing. Concurrent writes to the same key use
last-writer-wins behavior. Custom-domain cache behavior is a different
freshness surface.

The Runner adapter must use attempt-scoped, content-addressed keys and direct
API read-back. It must independently verify bytes and digest before accepting
an Artifact or Evidence reference. A cached HTTP response is not proof of the
uploaded bytes.

Source: [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)

## Required live measurement

One owner-authorized disposable cohort must capture:

```text
exact Anyam Release, policy, authorization epoch, and Hosting Mode
provider account and exact resource identifiers
correlation and idempotency keys
Anyam operation and provider operation identity
observation source, method, population, exclusions, and observed-at time
request/error class and provider status
started-at, completed-at, and duration
provider quantity/usage feed state and variance
Anyam-attributed quantity and cost, if available
checkpoint, digest, read-back, and recovery proof
cleanup inventory and post-cleanup absence
```

Measure each surface independently rather than averaging the product:

```text
public Project View read
authenticated command
Git clone/fetch/push
Change publish
Run dispatch and completion
Evidence read-back
Release creation
Target promotion and health check
mirror reconciliation
Project export and restore
```

The sample must be healthy-workload evidence for the exact cohort. No Anyam
limit, SLO, quota, cost, or availability number is created until its receipt
names the population, method, account/plan, provider feed state, and
remeasurement trigger.

## Failure and recovery matrix

The live cohort must exercise, at minimum:

```text
provider timeout or HTTP failure
provider authorization loss and restore
duplicate Queue delivery and redelivery
out-of-order or delayed provider observation
Workflow stall or duplicate callback
partial provider mutation
stale compare-and-swap
credential revocation during an operation
coordinator restart/redeploy
export restore
exact cleanup and post-cleanup verification
```

Each failure must leave a visible `pending`, `degraded`, `indeterminate`,
`blocked`, or `quarantined` state as appropriate. Recovery must prove one
authoritative effect, exact lineage, digest/read-back, and a safe next action.
Late acknowledgements, provider success pages, or dashboard green states are
not sufficient.

## Current boundary and owner inputs

No live provider-feed qualification can be claimed from the existing local
fixtures or the deleted Realm-auth cohort. The next run needs:

1. An owner-authorized disposable provider account/resource and Worker/Realm
   Release to observe.
2. A read-only provider analytics/observability credential with only the
   permissions needed to read the selected feed; its exact permission label
   must be confirmed at provisioning time rather than guessed.
3. A named observation window and synthetic healthy workload.
4. Explicit failure-injection and recovery authority.
5. Exact cleanup permission for every disposable resource and provider object.

The existing Queue token requested for #131 is sufficient for that Runner
cohort's Queue pull boundary only; it does not, by itself, qualify provider
usage/currentness or per-surface reliability for #127.

## Receipt

```text
protocol=anyam.provider-feed-reconciliation-preflight/v1
status=primary-source-preflight-complete
measurementContract=#120-qualified
workersMetrics=currentness=provider-feed-with-lag-and-retention
durableObjectsMetrics=namespace-and-filtered-object-observations; isolate-scope-caveat
queues=at-least-once; message-id-and-idempotency-required
r2=direct-read-back-and-digest-required; cache-not-authority
liveProviderFeed=unqualified
perSurfaceReliability=unqualified
failureRecovery=local-contract-qualified; live-provider-matrix-unqualified
anyamLimits=none-added-without-healthy-workload-receipt
universalSupport=false
```

This preflight narrows the remaining work but does not close the live
qualification. The owner-authorized cohort and its exact cleanup receipt are
still required.
