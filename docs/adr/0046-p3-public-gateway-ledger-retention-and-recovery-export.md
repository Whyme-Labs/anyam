# ADR 0046: P3 Public Gateway ledger retention and recovery export

- Status: Accepted with an exact replay-index tripwire
- Date: 2026-08-08
- Issue: [Qualify bounded Public Gateway ledger retention and recovery export](https://github.com/wms2537/anyam/issues/110)
- Depends on: [ADR 0044](./0044-p3-live-public-gateway-and-abuse-boundary.md), [ADR 0045](./0045-p3-provider-specific-public-gateway-abuse-controls.md)

## Context

The Public Gateway Durable Object ledger correctly preserved every request
record and audit event for the P3 receipt. That is safe for a fixture but an
unbounded storage landmine for a long-lived public Project. Compaction must not
turn a storage limit into silent loss of replay defense, accepted contribution
lineage, moderation decisions, or Recovery Checkpoints.

## Decision

The gateway adds a versioned `anyam.public-gateway-ledger/v1` export and
retention boundary:

```text
authoritative Durable Object state
        ↓
persisted, digest-verified ledger export
        ↓
compaction of eligible detailed records and submit-audit tail
        ↓
exact request-ID/payload-digest tombstones
        ↓
restart/recovery and explicit replay behavior
```

### Retention classes

- **Accepted lineage:** accepted request records and contribution IDs are
  never compacted by this operation.
- **Pending review:** pending records remain detailed until an explicit owner
  decision resolves them.
- **Retryable window:** retryable provider/request failures remain detailed for
  the measured retryable-age boundary, then become terminal exact tombstones.
- **Terminal denial:** denied records remain detailed for the measured
  terminal-denial-age boundary, then become exact tombstones.
- **Audit:** moderation and recovery transition events remain detailed; the
  oldest submit-event tail may be compacted only after export and within the
  measured audit-event limit. A compaction count remains in the state.
- **Exact replay index:** tombstones retain request ID, payload digest,
  contribution ID, original status, export digest, timestamps, and a safe
  receipt. They are not silently deleted. Their measured tripwire pauses
  further compaction/intake rather than weakening replay defense.

### Export-before-compaction

- An owner-authenticated export operation writes the full ledger bundle to a
  customer-owned durable export store before changing the coordinator state.
- The bundle contains the full pre-compaction state, source generation, source
  state digest, policy identity, and a content digest.
- Compaction requires the persisted export ID, verifies the export digest, and
  compares the exported source state with the current state. A stale or
  missing export fails closed and compacts nothing.
- Export and compaction are attributable audit events and produce visible
  Recovery Checkpoints.

### Budget behavior

Every retention boundary is a measured `PublicIntakeMeasuredLimit` with value,
unit, measurement time, method, and receipt. If a boundary would be exceeded,
the error names:

```text
budget
limit
asked
receipt
recovery action
```

The system never deletes accepted or pending lineage merely to satisfy a
configured limit.

## Consequences

- A customer can export, verify, compact, redeploy, and recover the gateway
  without Anyam-hosted storage.
- Detailed denial/audit state can be bounded while exact request replay
  defense remains explicit and durable.
- Request counters and accepted lineage remain monotonic; compaction is not a
  source, Change, Release, or Project mutation.
- A high-volume public gateway may eventually hit the exact replay-index
  tripwire. That is an intentional visible pause requiring a new measured
  policy, export/archive design, or a customer-approved replay horizon; it is
  preferable to silent acceptance of an old request identity.
- The current Worker stores exports in Durable Object storage. A future
  customer can put the same store boundary behind R2 or another durable
  provider, but provider acknowledgements do not replace the Anyam digest and
  export checkpoint.

## Rejected alternatives

- **Delete old request records:** permits old request IDs to be replayed as new
  work and destroys attribution.
- **Keep only a last-N list:** an unmeasured N is a landmine and loses exact
  replay defense when the window rolls.
- **Compact before exporting:** a crash between compaction and export creates an
  unrecoverable gap.
- **Provider/Durable Object storage retention as the product contract:** provider
  retention and page behavior do not prove Anyam lineage or recovery.
- **Bloom filter as the first exact replay boundary:** false positives alter
  idempotency semantics and require their own measured error receipt; the v1
  boundary uses exact tombstones and pauses before overflow.
