# ADR 0049: P3 Public Gateway replay-archive retention and deletion

- Status: Accepted; owner-authorized terminal-denial deletion implemented
- Date: 2026-08-11
- Issue: [Decide replay archive retention and deletion policy after replay defense expires](https://github.com/wms2537/anyam/issues/141)
- Map: [Plan Anyam customer-owned replay archival beyond the local tripwire](https://github.com/wms2537/anyam/issues/138)
- Depends on: [ADR 0046](./0046-p3-public-gateway-ledger-retention-and-recovery-export.md), [ADR 0047](./0047-p3-public-gateway-exact-replay-archive.md)

## Context

ADR 0047 made the customer-owned replay archive an exact, immutable replay
projection. That prevents replay gaps after the local Durable Object tombstone
tripwire, but it does not by itself define when an archive object may be
removed. Treating provider lifecycle rules as Anyam retention would be a
landmine: a provider could expire an object without proving that the
coordinator's replay, lineage, audit, or recovery state remains safe.

The policy must also distinguish terminal denials from retryable provider
failures. A retryable object can still be needed to make a repeated request
idempotent while the upstream provider recovers. Older objects written before
the expiry fields existed must not be guessed at or silently deleted.

## Decision

Replay archive retention has two separate, measured boundaries:

```text
local detailed-record age
    ≠ exact replay-defense window
    ≠ lineage/audit/recovery retention
```

The policy records `retryableReplayWindowMs` and
`terminalDenialReplayWindowMs` as measured millisecond limits. The replay
defense clock starts when the exact tombstone is materialized during
compaction, not when the request first arrived. This prevents a long local
retention period from consuming the provider protection window before the
exact object exists.

Automatic deletion is permitted only when every condition holds:

1. the object is a terminal denial (`originalStatus=denied` and
   `retryable=false`);
2. the tombstone has a valid `replayDefenseUntil` and the boundary has
   expired;
3. the current coordinator has a persisted, digest-verified latest export
   matching the supplied `exportId`;
4. the owner-authorized maintenance request supplies non-empty authorization
   and legal-hold receipts; and
5. the legal/recovery hold is explicitly `clear`.

The deletion operation is a separate owner-only maintenance capability exposed
at:

```text
POST /admin/ledger/replay-archive/delete-expired
```

Each delete is digest-checked. A missing object is recorded as
`already-absent`, making retries idempotent. A provider or integrity failure
stops the operation and leaves the remaining objects for a receipt-bound
retry; it never becomes a successful best-effort cleanup.

The operation never deletes:

- accepted or pending project/change lineage;
- moderation, owner, audit, or recovery events;
- retryable replay objects (they remain protected from automatic deletion);
- legacy objects without a verified expiry boundary; or
- any object while a legal or recovery hold is active.

The coordinator records the deletion receipt, counts, export digest, and
recovery checkpoint in its authoritative ledger. R2 remains a provider
projection, not the source of Anyam authority.

## Receipt requirements

The deletion receipt names:

```text
export ID and digest
requested / deleted / already-absent
protected retryable / unexpired / legacy counts
legal-hold result
owner authorization receipt
lineage and audit preservation
recovery checkpoint
```

The policy deliberately does not claim a universal duration, provider quota,
cost, latency, or automatic legal-retention interpretation. A customer must
remeasure the two replay windows and provide its own governance/hold receipt.

## Rejected alternatives

- **Delete all archived tombstones after one age:** retryable and legacy
  objects do not have the same safety boundary.
- **Start the replay window at request arrival:** local retention time could
  consume the protection window before the archive is materialized.
- **Delete without a current export:** cleanup could remove the only durable
  recovery proof for the coordinator state being changed.
- **Treat a missing object as a deletion failure:** provider retries would be
  non-idempotent; `already-absent` is the explicit safe result.
- **Let moderators or agents delete:** retention changes are destructive
  maintenance and require owner authority plus a separate hold decision.
- **Infer legacy expiry from timestamps:** an absent measured policy boundary
  is protected, not guessed.

## Consequences

- Customer-owned R2 archives can be bounded without weakening exact replay
  defense during the configured window.
- Accepted/pending lineage and audit/recovery history remain outside the
  deletion scope.
- Retryable and legacy objects may accumulate; that is a visible policy
  consequence requiring a future owner decision or measured migration, not a
  silent deletion path.
- The current adapter now has owner-only list/delete maintenance operations,
  but concurrent same-key creation remains the separate residual documented by
  ADR 0047's provider qualification.
