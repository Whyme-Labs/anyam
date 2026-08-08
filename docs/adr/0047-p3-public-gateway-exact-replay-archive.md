# ADR 0047: P3 Public Gateway exact replay archive

- Status: Accepted with a provider qualification residual
- Date: 2026-08-08
- Issue: [Qualify an archival replay-index adapter beyond the Public Gateway tombstone tripwire](https://github.com/wms2537/anyam/issues/113)
- Depends on: [ADR 0046](./0046-p3-public-gateway-ledger-retention-and-recovery-export.md)

## Context

ADR 0046 deliberately pauses before deleting exact request identities when the
Durable Object tombstone tripwire is reached. That is safe, but a long-lived
public Project needs a customer-owned path beyond the local tripwire. The
archive must not become a second source of Project or Landing authority, and an
archive outage must never be mistaken for an empty replay index.

## Decision

Add `anyam.public-gateway-replay-archive/v1` as a provider boundary. The first
Cloudflare adapter stores one immutable, digest-addressed JSON object per exact
request identity in a customer-owned R2 bucket:

```text
Durable Object ledger
        ↓ export-before-compaction
exact local tombstones
        ↓ local tripwire exceeded
R2 replay projection (one immutable object per request identity)
        ↓ restart or new request
exact lookup by Project/request identity
```

Each object retains the request ID, payload digest, contribution ID, original
status, compaction/export provenance, and a content digest. A repeat write of
the same exact identity is idempotent. A different payload digest, contribution
ID, or original status for an existing request identity is an integrity error.

The coordinator remains authoritative for request counts, accepted
contribution lineage, moderation decisions, Recovery Checkpoints, and all
Project/Change/Release transitions. The archive is an exact replay projection,
not a source of Landing authority.

When local compaction would exceed the measured tombstone limit, the
coordinator:

1. verifies the persisted ledger export;
2. writes every local/new exact tombstone through the archive adapter;
3. reads each object back and verifies its digest;
4. only then saves coordinator state with local tombstones cleared and an
   archive count/checkpoint;
5. checks the archive before accepting a request identity that is not present
   in local state.

If any archive read/write/read-back/integrity step fails, no coordinator state
is compacted or accepted. The Worker exposes the measured provider failure as
a visible 503 with a recovery action. Immutable objects already written are
safe to retry.

## Rejected alternatives

- **Drop old tombstones:** permits replay after the local window expires.
- **Use only a Bloom filter:** false positives change idempotency semantics and
  require a separately qualified false-positive/recovery contract.
- **Make R2 the authoritative ledger:** provider storage is not Anyam
  lineage, moderation, or Landing authority.
- **Use unbounded request IDs in object keys:** the adapter derives a bounded
  SHA-256 identity key while retaining the original request ID inside the
  verified object.
- **Clear local state before archive verification:** a crash would create a
  replay gap.

## Consequences

- A customer can extend exact replay defense with its own R2 account without
  Anyam-hosted storage.
- Archive lookup failure is a safe availability failure, never an acceptance
  path.
- Archive object bytes and provider latency/cost are workload measurements,
  not universal limits. Each customer must remeasure and set tripwires from
  its own receipt.
- Live R2 qualification remains separate until the executing Cloudflare
  identity has R2 bucket permission and a disposable customer bucket can be
  created, deployed, read back, and deleted with receipts.
