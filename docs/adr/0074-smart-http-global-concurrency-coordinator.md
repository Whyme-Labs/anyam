# ADR 0074: Durable Smart HTTP concurrency leases

## Status

Accepted on 2026-08-21.

## Context

The stream-counted Smart HTTP gateway kept concurrency in a Worker-isolate
counter. That correctly held a slot through body close, but separate Worker
isolates could each admit the configured limit.

## Decision

1. A configured durable Smart HTTP budget coordinator owns cross-isolate lease
   admission for each operation class.
2. The public Gateway binds `PublicGitBudgetCoordinatorDO`; missing binding
   fails public Git closed rather than silently reverting to a local counter.
3. Each lease carries the operation, configured limit, measured duration TTL,
   and budget receipt. The Durable Object expires abandoned leases before
   admission and serializes acquire/release.
4. The shared Smart HTTP transport releases the lease exactly once when the
   request/response lifecycle closes, cancels, or errors.
5. Private gateways may retain the isolate-local tracker only when their
   deployment explicitly accepts that provider residual; it is never presented
   as global enforcement.

## Non-claims

The Durable Object lease is Anyam's coordination authority, not a provider
quota or billing limit. Lease TTL and concurrency values remain workload
measurements carried in receipts.
