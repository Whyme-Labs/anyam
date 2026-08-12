# ADR 0054: Authority Promotion execution handoff

- Status: Accepted
- Issue: [#177](https://github.com/Whyme-Labs/anyam/issues/177)
- Scope: customer-operated Authority Plane

## Context

`promotion.request` records an owner-authorized request against an exact
Project, Release, and Target. It must not itself own provider credentials or
pretend that an HTTP request is the provider deployment authority. The Worker
Target delivery plane is already qualified separately, but the Authority needs
one narrow boundary for invoking that plane and recording its result.

## Decision

Authority exposes an owner-authenticated REST execution route:

```text
POST /api/promotions/{promotionId}/execute
Idempotency-Key: <execution identity>
{"expectedVersion": <optional Authority version>}
```

The route accepts only the Promotion path identity, an execution idempotency
key, and an optional expected Authority version. It never accepts a Project,
Release, Target, provider adapter, provider receipt, or credential from the
caller. MCP mutation, source transfer, and broad web-console execution remain
separate surfaces.

The Realm Durable Object builds a detached execution context from the
authoritative snapshot. The context binds the exact Project, Release, Target,
Promotion, immutable Artifact/Evidence lineage, expected current Target
Release, Realm session actor, and a digest over those inputs. The provider
executor is reached only through the internal `ANYAM_PROMOTION_EXECUTOR`
service binding; a missing binding is an actionable blocked result.

The executor response is untrusted input at the handoff boundary. Authority
accepts it only when it returns the execution protocol and context digest,
the configured Target adapter identity, exact Project/Release/Target/Promotion
lineage, append-only Target history, and state-consistent health/rollback
results. Credential-shaped fields and material are rejected. The qualified
provider adapter remains responsible for release-bound preview, apply,
health, and rollback receipts; Authority only records the validated result.

After validation, Authority persists provider operation IDs, attempt and
execution idempotency identity, reconciliation checkpoint, safe provider
receipts, Promotion state, and the Anyam-owned Target pointer. A thrown or
invalid provider result becomes an explicit `indeterminate`/`degraded` state;
the known-good Target pointer and history are preserved. Replaying the same
execution idempotency key returns the recorded result without invoking the
provider again.

The public synchronous Authority command surface rejects `promotion.execute`.
Only the owner edge and internal Durable Object service-binding route can
initiate this handoff. Responses remain credential-free and declare
`canonicalWrite=false`; provider deployment credentials never cross the edge
or enter the Authority snapshot.

## Consequences

- Authority now has a durable, auditable handoff contract without making the
  REST request or caller the provider owner.
- Provider-specific execution remains replaceable behind one service binding
  and the existing Target adapter boundary.
- Missing provider wiring, invalid receipts, stale state, and ambiguous
  outcomes are visible and retryable rather than silently accepted.
- The executor service binding itself, durable provider callback/reconciliation
  worker, and operator-facing execution status remain follow-up work; this ADR
  does not claim that service is deployed merely because the handoff contract
  is implemented.
