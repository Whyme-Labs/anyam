# Customer-owned provider failure and recovery preflight

Date: 2026-08-10  
Issue: [Qualify customer-owned provider failure and recovery matrix](https://github.com/wms2537/anyam/issues/129)  
Map: [Plan Anyam beyond bounded P3 public beta](https://github.com/wms2537/anyam/issues/118)  
Protocol: `anyam.p3-23-customer-provider-failure-recovery-preflight/v1`  
Status: preflight blocked; no live failure/recovery qualification claimed

## Question

Can an explicitly owner-authorized customer-operated Realm exercise its real
control plane and customer-owned D1, R2, Queue, Workflow, and Worker adapters
through outage, authorization loss, timeout, duplicate/redelivery, partial
mutation, restart/redeploy, restore, and cleanup journeys while retaining one
authoritative Anyam state transition?

## Decision

Not yet. The current deployed Worker is the customer-operated identity and
recovery foundation, not the provider-operation control plane required by this
ticket. Running a disposable resource cohort now would test bindings and
provider commands, not the Anyam operation/recovery contract.

The ticket remains open until the smallest provider-operation qualification
surface exists and can be deployed with owner-authorized synthetic resources.
No customer resource was inspected or mutated by this preflight.

## Current repository evidence

### Worker routes are intentionally foundation-only

`apps/realm-worker/src/index.ts` exposes Realm identity, owner authentication,
delegation, credential exchange, revocation, and recovery routes. It keeps
Project, Git, Landing, and Promotion authority outside this Worker.

The checked-in README says the package does not yet transfer Git objects,
perform Landing, or mutate a Target. Its health response proves configured
customer-owned bindings only; it does not prove durable Project or provider
operations.

### Provider bindings are not yet operation adapters

The current `wrangler.example.jsonc` binds:

```text
SQLite Durable Object   Realm identity coordinator
D1                     metadata/read-model binding
R2                     export/recovery object binding
Queue                  producer binding
Workflow               orchestration boundary
```

The Durable Object is the intended authority. D1, R2, Queue, and Workflow are
transport/read-model/object-store boundaries. That is the correct architecture
but it is not a live failure matrix.

`AnyamRealmWorkflow.run()` currently returns:

```text
workflowAuthority=not-enabled; credentialFree=true
```

No deployed route currently performs a bounded Run/Workflow operation, Queue
consumer acknowledgement, provider-backed Project mutation, partial-effect
reconciliation, or customer-visible recovery checkpoint.

### Existing qualification evidence is bounded

The earlier customer Realm persistence receipt qualifies a disposable
customer-owned Worker binding set, Durable Object persistence, stale CAS,
provider-outage checkpoint shape, credential-free R2 recovery objects, and
idempotent local delivery. It explicitly records that D1 is a read model, R2 is
an object store, Queue and Workflow are transport-only, and that production
auth/Git/Artifacts/Promotion and provider availability remain unqualified.

The current repository test suite covers local adapter failure modes and
recovery contracts, but a green local test cannot prove customer-provider
behavior, deployed Worker restart behavior, or exact cleanup of a live cohort.

## Required live qualification

The future receipt must bind the exact Anyam release/source digest, customer
account and resources, installation/Realm identity, policy/authorization epoch,
provider adapter versions, operation/idempotency keys, checkpoints, digests,
failure injection, recovery action, and cleanup authority.

### Healthy control path

The deployed Worker must create or inspect a disposable Project operation,
persist authoritative state in the coordinator, write the permitted D1/R2/
Queue/Workflow projections, read them back, and prove the expected digest and
lineage. Provider acknowledgement alone is not success.

### Failure matrix

Exercise one named failure at a time:

```text
provider outage or HTTP failure
provider authorization revoke and restore
request timeout and coordinator restart/redeploy
Queue duplicate/redelivery and stale lease
Workflow duplicate callback or stalled instance
partial D1/R2/provider mutation
stale compare-and-swap or authorization epoch
credential revocation during an in-flight operation
credential-free export, restore, and owner activation
exact resource and object cleanup
```

For every failure, the receipt must state:

```text
authoritative Anyam state
provider observation and operation ID
visible status: pending, degraded, indeterminate, succeeded, or blocked
checkpoint and idempotency key
read-back/output digest
whether retry is safe and the exact recovery action
customer-visible disclosure
cleanup result
```

An ambiguous provider result is `indeterminate`, never success. A duplicate or
redelivered message must produce one authoritative effect. A partial mutation
must be reconciled or quarantined before a retry. No guessed quota, latency,
availability, or cost number is allowed.

## Preconditions before live execution

1. A bounded provider-operation fixture exists outside the foundation Worker
   routes, with an explicit owner-only test surface.
2. The Coordinator owns state transitions and idempotency; D1/R2/Queue/
   Workflow observations cannot become authority by themselves.
3. Queue consumption and acknowledgement are implemented, not merely a
   producer binding.
4. Workflow start, completion, duplicate callback, stall, and restart state
   are observable and reconciled.
5. Failure injection is synthetic and scoped to the disposable cohort; no
   existing customer resource is used.
6. Cleanup can delete the Worker, Workflow, D1, R2, Queue, and all objects,
   with post-delete listings and digest receipts.

## Next action

Implement the smallest customer-provider operation qualification fixture, run
its local failure/recovery matrix first, then deploy one disposable
owner-authorized cohort and rerun this ticket. Keep the customer-operated
Realm authority and provider adapters separate; do not turn the qualification
Worker into a production Project API by accident.

