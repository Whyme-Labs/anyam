# Bounded customer-provider operation fixture

Date: 2026-08-10
Issue: [Implement bounded customer-provider operation fixture for failure and recovery qualification](https://github.com/wms2537/anyam/issues/136)
Parent qualification: [Qualify customer-owned provider failure and recovery matrix](https://github.com/wms2537/anyam/issues/129)
Map: [Plan Anyam beyond bounded P3 public beta](https://github.com/wms2537/anyam/issues/118)
Protocol: `anyam.p3-24-customer-provider-operation-fixture/v1`
Status: local fixture implemented and worker bundle qualified; live cohort remains unclaimed

## Decision

The smallest provider-operation surface now exists. It is an owner-only
qualification fixture, not a general Project, Git, Landing, or Production API.
The Realm Durable Object remains authoritative. D1, R2, Queue, Workflow, and
Worker bindings are observations and provider effects behind adapter contracts.

The fixture deliberately accepts a payload digest rather than a payload. It
does not store or return provider credentials, bearer tokens, secret values, or
canonical-write authority.

## Implemented boundary

### Authoritative operation state

`src/cloudflare/customer-provider-operation.ts` defines:

```text
Operation
Checkpoint
Idempotency key
Provider operation ID
Provider observation
Read-back/output digest
Recovery bundle
Cleanup receipt
```

`CustomerProviderDurableObjectOperationStore` persists records under the
Realm Durable Object storage prefix and uses a storage transaction with an
expected checkpoint digest. A stale writer cannot overwrite the newer state.

### Customer provider adapters

`apps/realm-worker/src/customer-provider-adapters.ts` implements the bounded
adapter set:

```text
D1       disposable qualification row and read-back
R2       disposable object and byte digest read-back
Queue    structured JSON message and deferred coordinator callback
Workflow instance creation and coordinator callback
Worker   owner-configured disposable target request/read-back
```

Synthetic outage, authorization loss, timeout, duplicate delivery, and partial
mutation failures are claimed once in a disposable D1 injection table. A
retrying operation keeps its original operation and idempotency identity.

Queue messages are acknowledged only after the internal coordinator callback
accepts the matching provider operation and checkpoint predecessor. Workflow
callbacks use the same compare-and-set boundary. Late duplicate callbacks are
ignored without overwriting the current record.

### Owner-only worker routes

`apps/realm-worker/src/index.ts` exposes only bounded owner-authenticated
qualification routes through the existing passkey owner adapter:

```text
/api/owner/qualification/provider-operation
/api/owner/qualification/provider-operation/resume
/api/owner/qualification/provider-operation/callback
/api/owner/qualification/provider-operation/cleanup
/api/owner/qualification/provider-recovery/export
/api/owner/qualification/provider-recovery/restore
```

The internal callback route is reachable only through the Durable Object stub
from the Queue/Workflow handler. It verifies Realm and installation scope,
authorization epoch, operation identity, and checkpoint predecessor before
calling the same coordinator callback method.

## Local receipt

Commands run from the repository root:

```text
npm run typecheck
npm run typecheck --workspace=@anyam/realm-worker
npx tsx --test test/customer-provider-operation.test.ts
git diff --check
npm run build --workspace=@anyam/realm-worker
```

Observed results:

```text
TypeScript kernel check: passed
Realm Worker TypeScript check: passed
Customer-provider operation tests: 8 passed, 0 failed
Diff check: passed
Wrangler dry-run bundle: passed
```

The test receipt covers healthy read-back, provider outage recovery,
authorization loss and restore, partial mutation and cleanup, idempotent
duplicate identity, stale callback rejection, credential-free recovery
restore/tamper rejection, and owner authorization denial.

The `8 passed` value is a test-run receipt, not a product capacity claim.

## What remains unqualified

This implementation does not yet prove a live customer-owned cohort. The
following are still required before #136 or #129 can close:

```text
Disposable owner-authorized deployment
Worker target binding and target Worker behavior
Live D1/R2/Queue/Workflow operations
Queue consumer delivery and acknowledgement receipt
Workflow completion and callback receipt
Restart/redeploy and credential-free restore journey
Exact resource/object cleanup and post-cleanup listing
```

No live provider availability, latency, quota, cost, or SLO claim is made.
No existing customer resource was inspected or mutated.

## Next action

Run one explicitly owner-authorized disposable cohort using the routes above,
capture the full healthy and named failure/recovery receipts, then append the
live evidence to #129 and update the Wayfinder map. Keep #136 open until the
deployed acceptance is complete.
