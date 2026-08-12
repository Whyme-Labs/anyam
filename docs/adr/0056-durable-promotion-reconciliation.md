# ADR 0056: Durable Promotion reconciliation and operator status

## Status

Accepted for the private-alpha delivery plane.

## Context

The customer-operated Promotion executor is a separate provider boundary. A
Worker or network can therefore disappear after a provider request has been
accepted, before Authority receives the result. Repeating the HTTP request
with a new idempotency key could create a second deployment, while advancing
the Anyam Target pointer from an unverified receipt could publish the wrong
Release.

Authority already persists the Promotion and Target snapshot in the Realm
Durable Object. The missing decision is how an operator resumes one ambiguous
handoff after a restart and how they can inspect the durable state without
receiving provider credentials.

## Decision

1. Every provider handoff records a `PromotionReconciliationCheckpoint` with
   the immutable execution idempotency key, execution digest, Release and
   Target identities, provider operation IDs, phase, attempt, result status,
   timestamp, and receipt.
2. The execution digest binds only immutable Project, Release, Artifact,
   Evidence, Target-configuration, expected-current-Release, and execution
   identity inputs. Mutable Authority version, state, attempt, and receipt
   fields do not change the provider identity during reconciliation.
3. `promotion.execute` accepts a new execution identity only before one is
   recorded. Once a Promotion has an execution identity, a second identity is
   rejected; the owner must use `promotion.reconcile`.
4. `promotion.reconcile` has its own Authority idempotency key but derives the
   provider execution identity from the durable Promotion checkpoint. It
   retries the same executor context after a transport loss, timeout, or
   delayed callback and updates the original execution replay with the latest
   reconciled result.
5. Provider results and checkpoints are accepted only when their protocol,
   Project, Target, Release, expected-current state, execution digest, and
   checkpoint identity match the current immutable handoff. A stale or
   superseded callback becomes `indeterminate`; it cannot advance the Target
   pointer.
6. An owner-authenticated `GET /api/promotions/{promotionId}` exposes a safe
   Promotion, Target, Release, and checkpoint projection. It contains no
   actor session, provider credential, or provider token material.
7. An owner-authenticated
   `POST /api/promotions/{promotionId}/reconcile` accepts only
   `expectedVersion` and a transport `Idempotency-Key`. The stored checkpoint
   supplies the provider identity; the operator cannot choose a replacement
   operation through this route.
8. The known-good Target pointer remains unchanged for `blocked`,
   `indeterminate`, and failed health results. It advances only after the
   validated provider result reports the exact Release healthy (or a verified
   rollback Release healthy).

The bounded local qualification is:

```sh
npm run qualification:promotion-reconciliation
```

It simulates a provider timeout, reconstructs the coordinator from its
persisted snapshot, reconciles the same execution identity, and verifies that
the Target pointer advances only after the healthy result. It is fixture
evidence, not a live provider deployment claim.

## Consequences

- Durable Object restarts do not erase the provider operation identity or
  recovery receipt.
- Operators can distinguish a provider ambiguity from a healthy promotion and
  have a concrete next action.
- A delayed callback cannot overwrite a newer or differently bound execution.
- The Authority response and status surfaces remain credential-free.
- Reconciliation is explicit and auditable; it does not silently retry a
  provider operation in the background.
- Provider polling/callback mechanics remain inside the customer-operated
  executor. Authority validates the result and owns Anyam state transitions.

## Rejected alternatives

- Minting a new execution key for every retry: can create duplicate provider
  deployments after an ambiguous timeout.
- Treating an HTTP 200 or provider operation receipt as healthy: the Target
  pointer would advance without release-bound health evidence.
- Accepting callbacks by Promotion ID alone: late results from a superseded
  execution could overwrite current state.
- Returning the full Authority Promotion record from the status route: actor
  and internal provenance fields would cross the owner read boundary.
