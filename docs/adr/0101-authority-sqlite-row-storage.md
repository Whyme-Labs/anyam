# ADR 0101: Transactional SQLite Authority storage

Status: Accepted

Issue: [#291](https://github.com/Whyme-Labs/anyam/issues/291)

## Context

The Realm Authority previously persisted one growing structured-clone JSON
snapshot after every command. That made the whole state a write unit: a small
Project mutation rewrote unrelated Runs, Evidence, Releases, mirrors, audit
history, and idempotency records. It also left the Authority exposed to the
Durable Object key/value representation tripwire.

## Decision

Keep `AuthorityPlaneCoordinator` as the domain and authorization contract, but
replace its Durable Object persistence adapter with `AuthoritySQLiteStore`.
The store uses SQLite-backed Durable Object storage with:

- one metadata row for Realm, protocol, and Authority version;
- normalized collection/entity rows for Projects, Source Spaces, Project
  Revisions, Workspaces, Changes, Change Revisions, Runs, Evidence, Artifacts,
  Releases, Targets, Promotions, mirrors, and canonical pointers;
- dedicated append-only audit-event rows;
- dedicated immutable idempotency rows;
- a schema migration ledger.

Each accepted command hydrates the current snapshot for the existing domain
coordinator, then commits only changed entity rows plus one new audit and
idempotency row in one synchronous SQLite transaction. The metadata version is
checked against the expected previous version before any row is changed.
Legacy JSON snapshots are imported once, transactionally, then deleted. Signed
Authority recovery replaces the normalized rows in one transaction and retains
the same version, audit, and idempotency contents.

The growth qualification uses the current Cloudflare SQLite-backed Durable
Object 2 MiB key/value combined-size tripwire as a measured comparison point
([Cloudflare Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/));
the test proves mutations continue after the serialized legacy snapshot is
larger than that point. It records p50/p95/p99 transaction timings and row/
database-size receipts without treating local Node SQLite measurements as
provider SLOs.

## Consequences

- Small mutations no longer rewrite unrelated Authority collections.
- Audit and idempotency history cannot be silently deleted or rewritten by a
  normal commit.
- The existing command result and recovery contracts remain stable.
- SQL schema migrations are explicit and can be extended without changing the
  domain command model.
- Local growth receipts qualify the storage shape; production capacity and
  latency still require a customer-account remeasurement.

## Receipt

- Round-trip, rollback, legacy migration, and post-tripwire growth tests pass.
- The full repository gate must retain the row-transaction, audit immutability,
  and version-CAS tests.
