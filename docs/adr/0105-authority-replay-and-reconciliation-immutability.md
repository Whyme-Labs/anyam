# ADR 0105: No-op Authority replay and immutable reconciliation records

Status: Accepted

Issue: [#304](https://github.com/Whyme-Labs/anyam/issues/304)

## Context

Anyam commands, Runner callbacks, and provider operations are delivered at
least once. A same-fingerprint retry must therefore return the original result
without creating a new Authority version or rewriting durable history.

The SQLite Authority store uses a strict version transition and append-only
idempotency rows. The hosted Realm previously persisted every coordinator
return, including no-op replays, as if it were a new version. Promotion
reconciliation also replaced the original `promotion.execute` idempotency
result with the later reconciliation result. Those two behaviors made normal
retries fail or violate the SQLite immutability contract.

## Decision

`AuthoritySQLiteStore.commit(previous, next)` accepts exactly two shapes:

- `next.version === previous.version`: the snapshots must be structurally
  equivalent under stable JSON comparison, and the method returns without a
  SQLite transaction;
- `next.version === previous.version + 1`: the store performs the existing
  transactional row diff, version CAS, append-only audit insert, and immutable
  idempotency insert;

all other transitions fail closed.

The hosted Realm applies the same no-op check before persistence. A mismatch at
an unchanged version is an explicit storage error, not a silent discard.

Promotion reconciliation stores its result under its own
`promotion.reconcile:<key>` idempotency record. The original
`promotion.execute:<execution>` record remains immutable and continues to hold
the original attempt result. Current Promotion and Target state are read from
their authoritative entity rows.

## Consequences

- Generic Authority, REST, MCP, Runner, Promotion, and reconciliation retries
  are safe across coordinator reconstruction.
- A provider reconciliation cannot leave a changed provider paired with a
  rejected Authority transaction because of an idempotency-row rewrite.
- Audit and idempotency records remain append-only; recovery can distinguish
  the original execution from its later reconciliation.
- A future persistence adapter must preserve the same no-op and strict
  one-version transition semantics.

## Receipt

- SQLite tests cover a generic command replay, Promotion execution followed by
  successful reconciliation, reconciliation replay after restoration, and
  immutable original execution records.
- The full repository gate must retain these tests and the existing SQLite
  version-CAS/rollback coverage.
