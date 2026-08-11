# P3-17 Public Gateway ledger retention and recovery qualification

Date: 2026-08-08
Issue: [Qualify bounded Public Gateway ledger retention and recovery export](https://github.com/Whyme-Labs/anyam/issues/110)
Protocol: `anyam.public-gateway-ledger/v1`
Status: passed with an exact replay-index residual

## Question

Can the customer-owned Public Gateway export its durable request/audit ledger,
compact only eligible detailed history, preserve accepted lineage and exact
request-ID replay defense, and recover after redeployment without silently
dropping evidence?

## Implementation receipt

The boundary is implemented in:

- `src/cloudflare/public-gateway.ts` — ledger protocol, retention policy
  validation, durable export digest, stale-export checks, compaction classes,
  exact replay tombstones, restart behavior, and visible budget failures;
- `apps/public-gateway-worker/src/index.ts` — customer-owned Durable Object
  export storage and authenticated `/admin/ledger/export` and
  `/admin/ledger/compact` routes;
- `apps/public-gateway-worker/README.md` — operator workflow and retention
  invariants;
- `test/public-gateway.test.ts` — export/restart/replay, stale-export, and
  measured-budget fixtures.

No Project, Source Space, Change, Release, or canonical repository mutation is
performed by export or compaction.

## Retention contract

The operator supplies a receipt-backed policy containing five boundaries:

```text
requestRecordLimit       detailed records after compaction
requestTombstoneLimit    exact replay identities retained
auditEventLimit          detailed audit events retained
retryableRetentionMs     age before retryable denial compaction
terminalDenialRetentionMs age before terminal denial compaction
```

Accepted and pending records are protected. Denied records become exact
tombstones only after a persisted export and the measured age boundary. The
tombstone retains the request ID and payload digest, so the same request/payload
is an idempotent terminal denial after compaction and the same request ID with a
different payload is a replay denial. The exact replay index is retained; its
tripwire fails compaction rather than deleting identity history.

## Local static receipts

The full root gate and Worker gate passed after implementation:

```text
npm run check — 121 tests passed, 0 failed
npm run typecheck --workspace=@anyam/public-gateway-worker — passed
npm run build --workspace=@anyam/public-gateway-worker — Wrangler dry-run passed
git diff --check — clean
```

The deterministic fixtures prove:

```text
export persisted before compaction=true
export digest verified=true
stale export compaction=false
accepted lineage after compaction=preserved
same payload after compaction=idempotent terminal denial
changed payload after compaction=replay denial
restart coordinator state=recovered
budget failure fields=budget, limit, asked, receipt, recovery action
```

## Disposable customer-owned Worker fixture

```text
Cloudflare account: 1e0170aaabc90ecf5f466128d1f0466a
Worker: anyam-p3-17-ledger-20260808
First deployed version: 46b48ed9-2bcb-4407-8d61-0df079685690
Recovery redeploy version: 88bf780a-cb88-4716-8cc1-e0225e1e0f4e
Project: project:p3-17-ledger-20260808
Public Source Space: source:p3-17-ledger-public
Upstream Git dependency: none used; example.invalid route was never called
```

The Worker, its Durable Object, bindings, secret, and local receipt directory
were deleted/trashed after qualification. No hosted Anyam dependency, private
Source Space, production credential, or canonical Project repository was used.

## Growth receipt

The customer-owned fixture opened Public Intake with a measured logical
tripwire of three requests and then generated three healthy quarantined
acceptances plus four over-limit, abuse-shaped denials. The pre-export state
contained seven detailed request records and nine audit events (the export
event is included in the exported state):

```text
healthy accepted=3
abuse-shaped terminal denials=4
pre-export detailed request records=7
pre-export audit events=9
pre-export exported state JSON=11833 bytes
receipt=receipt:p3-17-ledger-growth-20260808
measurement=compact UTF-8 JSON serialization of the exported state; not a
         claim about provider SQLite page or billing bytes
```

The edge binding remained an outer advisory control. No edge result was used as
the logical ledger or as a retention decision.

## Export and compaction receipt

```text
exportId=ledger-export:p3-17-live
exportDigest=sha256:7e48b2de0658a9cfffe601f1c04a4d1f6f2047fabd81a667f5d616a8aed8cd46
sourceGeneration=8
exportWrapperJSON=12438 bytes
compactionHTTP=200
beforeDetailedRecords=7
afterDetailedRecords=3
compactedRecords=4
beforeAuditEvents=9
afterAuditEvents=8
compactedSubmitAuditEvents=2
afterExactReplayTombstones=4
acceptedContributionIds=healthy-1, healthy-2, healthy-3
recoveryCheckpoint=checkpoint:public-gateway:ledger-compacted:10
receipt=receipt:p3-17-ledger-compaction-20260808
```

The post-compaction core state serialized to 8893 bytes (the full state
response, including response metadata, was 9859 bytes). The byte figures are
measurement receipts for this fixture's JSON representation, not a universal
Durable Object storage or cost limit.

## Replay and redeploy receipt

After compaction, the same request ID and same envelope returned an idempotent
terminal denial:

```text
request=request:denied-4
http=200
idempotent=true
compacted=true
materialized=false
```

The same request ID with a changed payload returned a replay denial:

```text
request=request:denied-4
http=200
idempotent=false
replay=true
compacted=true
materialized=false
```

The Worker was then redeployed to version
`88bf780a-cb88-4716-8cc1-e0225e1e0f4e`. The persisted Durable Object state
still reported:

```text
status=open
requests=8
accepted=3
denied=5
detailedRecords=3
exactReplayTombstones=4
preservedContributionIds=healthy-1, healthy-2, healthy-3
recoveryCheckpoint=checkpoint:public-gateway:ledger-compacted:10
```

This proves persistence across the disposable Worker redeploy. The local
fixture additionally reconstructs a new coordinator over the same store and
proves the same replay behavior without process-local memory.

## Budget and residual behavior

The local fixture set `requestRecordLimit=1` while two accepted records were
protected. Compaction failed before saving and named:

```text
budget=public-gateway-request-records
limit=1 detailed-request-records
asked=2
receipt=receipt:ledger-retention:request-records
fix=retain the exported ledger and remeasure the detailed-record tripwire;
    accepted or pending lineage is never deleted
```

The exact replay tombstone index is intentionally retained rather than deleted
when old detailed denials are compacted. Its measured limit is a tripwire: if a
customer reaches it, the gateway must pause or remeasure/archive through an
explicit reviewed policy. The qualification does not claim an unbounded public
Gateway or a universal provider storage/cost limit.

## Exit decision

The bounded ledger route is qualified: export is persisted and digest-verified,
stale exports fail closed, accepted lineage and moderation/control events are
preserved, detailed denial/audit state compacts into exact replay tombstones,
same-payload idempotency and changed-payload replay remain explicit after
compaction, and redeployment recovers the Durable Object state.

The remaining residual is the exact replay-index tripwire and provider storage
measurement. A future high-volume design may add a separately qualified
archive/replay-index adapter, but it must not silently delete exact identity
history or convert the JSON fixture bytes above into a universal capacity
claim.
