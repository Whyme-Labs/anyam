# ADR 0092: Receipt-backed production operations and the state-first control room

Status: Accepted

Issue: [#259](https://github.com/Whyme-Labs/anyam/issues/259)

## Context

The operator contract already exposed installation, provider, release,
migration, policy, export, and pending-operation observations. It did not
provide one state-first surface for the delivery chain, and it could not
distinguish “not measured yet” from “all production operations are qualified.”

The audit requires sustained-load, queue-recovery, Durable Object contention,
backup/restore, key rotation, authentication throttling, and incident-alerting
evidence before beta. A test fixture or a provider HTTP success is not a
production operations receipt.

## Decision

Anyam has two read-only surfaces:

1. `GET /api/operator/status` returns the structured operator status.
2. `GET /owner/control-room` renders the authenticated state-first control
   room with the chain:

   ```text
   Change → Evidence → Landing → Release → Target → Deployment → Health
   ```

The control room is owner-authenticated, `no-store`, credential-free, and
does not mutate source, provider resources, credentials, or promotion state.

Operational evidence is recorded in a customer-owned JSON ledger using the
`anyam.production-operations/v1` protocol. Each receipt names:

- one required drill kind and immutable receipt ID;
- start and finish timestamps;
- measured observations and evidence references;
- recovery action and receipt text;
- explicit credential-free and provider-fact boundaries.

Readiness is `ready` only when the latest receipt for every required drill is
`verified`. Missing or indeterminate receipts keep the status indeterminate;
failed receipts block it. The ledger records observations but does not invent
limits, SLOs, costs, or provider guarantees.

The customer Worker exposes the credential-free ledger snapshot through
`ANYAM_OPERATIONS_LEDGER`. A missing snapshot is an explicit readiness gap,
not a green default.

## Consequences

- Operators see the important delivery states without reading internal
  protocol objects.
- Production readiness cannot be inferred from unit tests or a provider
  fixture.
- Customer-run operational drills remain under customer control and can be
  exported with the rest of the Realm evidence.
- The current surface does not claim that live production receipts exist; the
  customer must still run and link each drill.

## Rejected alternatives

- **Treat absent receipts as healthy:** would convert an unmeasured boundary
  into a landmine.
- **Put provider credentials in the control room:** violates the customer
  execution boundary and increases blast radius.
- **Build a mutable dashboard-only cache:** would create another authority;
  the control room reads the operator status and ledger snapshots directly.

