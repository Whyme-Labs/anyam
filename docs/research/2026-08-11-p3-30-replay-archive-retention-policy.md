# P3-30 replay archive retention and deletion policy

Date: 2026-08-11
Issue: [#141 — Decide replay archive retention and deletion policy after replay defense expires](https://github.com/Whyme-Labs/anyam/issues/141)
Map: [#138 — Plan Anyam customer-owned replay archival beyond the local tripwire](https://github.com/Whyme-Labs/anyam/issues/138)
ADR: [0049 — P3 Public Gateway replay-archive retention and deletion](../adr/0049-p3-public-gateway-replay-archive-retention-and-deletion.md)
Protocol: `anyam.public-gateway-replay-archive/v1`
Status: implementation complete locally; live provider deletion remains a separately qualified operation

## Decision receipt

The owner decision is:

> Separate the replay-defense window from lineage/audit retention. Automatic
> deletion is allowed only for terminal-denial replay objects after the
> customer-configured replay window expires and a verified coordinator export
> exists. Accepted/pending lineage, audit, recovery, and legal-hold evidence
> are protected.

The implementation makes this decision explicit rather than inferring a
provider lifecycle rule:

```text
terminal denial + retryable=false
        + valid replayDefenseUntil
        + replayDefenseUntil <= now
        + latest digest-verified export
        + owner authorization
        + legalHold=clear
        → eligible for digest-checked deletion
```

Retryable replay objects remain protected from automatic deletion. Legacy
objects without a measured expiry boundary remain protected. A missing object
is an idempotent `already-absent` result; provider or integrity failure stops
the operation and leaves the remaining objects for the same export-bound retry.

## Implementation surface

- `PublicGatewayLedgerRetentionPolicy` now carries measured
  `retryableReplayWindowMs` and `terminalDenialReplayWindowMs` limits.
- Compaction writes `retryable` and a fixed `replayDefenseUntil` onto every new
  tombstone. The clock begins at tombstone materialization, not request arrival.
- `PublicGatewayStore` has separate owner-maintenance list/delete operations.
- The Cloudflare R2 adapter paginates the replay prefix, verifies every object,
  classifies legacy objects without deleting them, and deletes only when the
  expected content digest still matches.
- The Worker exposes
  `POST /admin/ledger/replay-archive/delete-expired` behind the existing
  owner-qualified admin boundary.
- The coordinator records deletion counts, protected-object counts, export
  digest, owner/hold receipts, and a Recovery Checkpoint in its audit ledger.

## Local receipt

```text
npm run typecheck                         PASS
npm test                                  PASS (137 tests)
test/public-gateway.test.ts               owner deletion, retryable protection,
                                          legacy protection, owner auth
                                          and digest-bound archive behavior
                                          covered
```

The test uses a measured fixture policy (`retentionPolicy()` in
`test/public-gateway.test.ts`). Those values are qualification fixtures, not
production retention recommendations. Production values require a customer
workload measurement receipt.

## What this receipt does not claim

- No universal replay duration, R2 quota, cost, latency, or legal-retention
  guarantee.
- No automatic deletion of retryable or legacy objects.
- No deletion of accepted/pending lineage, audit, recovery, or legal-hold
  evidence.
- No live R2 deletion qualification for a production customer bucket in this
  ticket; the existing disposable R2 receipt remains the provider boundary.
- No resolution of the concurrent same-key create residual documented by
  [P3-29](./2026-08-11-p3-29-replay-archive-provider-boundary.md).

## Recovery

If deletion is blocked, retain the latest export and use the visible receipt to
correct one boundary at a time:

1. restore or rebind the owner-only list/delete maintenance operations;
2. create a fresh verified export if the latest export is stale or missing;
3. clear the legal/recovery hold through customer governance;
4. remeasure and update the replay-window policy if a healthy workload would
   hit it; or
5. retain retryable/legacy objects and schedule an explicit migration decision
   rather than guessing an expiry.
