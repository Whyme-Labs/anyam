# P3-26 live customer-owned replay archive qualification

Date: 2026-08-10
Issue: [Qualify live customer-owned replay archival beyond the Public Gateway tombstone tripwire](https://github.com/wms2537/anyam/issues/139)
Map: [Plan Anyam customer-owned replay archival beyond the local tripwire](https://github.com/wms2537/anyam/issues/138)
Protocol: `anyam.public-gateway-replay-archive/v1`
Status: passed for the bounded disposable Cloudflare adapter; workload and retention sizing remain open

## Question

Can a customer-owned Cloudflare R2 replay projection move exact Public Gateway
request identities beyond the local Durable Object tombstone tripwire, survive
the Worker redeploy boundary, reject tampering, fail closed when the provider is
unavailable, and be removed without touching unrelated customer resources?

## Scope and ownership

The run used only disposable resources in the authenticated customer account:

```text
account: 1e0170aaabc90ecf5f466128d1f0466a
owner:   swmengappdev@gmail.com
region:  APAC location hint
```

The bucket was created by the owner with:

```text
wrangler r2 bucket create anyam-p3-26-replay-archive-20260810 --location apac
```

No existing project, public Source Space, production Worker, customer secret,
canonical repository, or non-disposable bucket was used. The temporary Worker
and bucket names were unique to this qualification:

```text
primary Worker: anyam-p3-26-live-20260810
R2 bucket:      anyam-p3-26-replay-archive-20260810
project:        project:anyam-p3-26-live-replay-archive
public Space:   source:public-p3-26-replay-archive
snapshot:       snapshot:p3-26-public-fixture
```

The owner-only `ADMIN_TOKEN` and the temporary cleanup Worker credential were
generated in-process, never printed, and never committed. Canonical writes
were not enabled.

## Deployment receipt

The live config was:

```text
apps/public-gateway-worker/wrangler.p3-26-live-20260810.jsonc
```

It used the corrected account ID above, `global_fetch_strictly_public`, the
Cloudflare Rate Limit namespace `90000026` at the measured fixture setting
`1 request / 10 seconds`, the `PublicGatewayCoordinatorDO` SQLite Durable
Object, and the R2 binding:

```text
PUBLIC_GATEWAY_REPLAY_ARCHIVE → anyam-p3-26-replay-archive-20260810
```

The Worker reached a healthy state with the live project identity and was
redeployed after compaction. The recovery health response reported:

```text
status=closed
projectId=project:anyam-p3-26-live-replay-archive
recoveryCheckpoint=checkpoint:public-gateway:ledger-archived:4
publicProjection=true
landingAuthority=false
```

The Durable Object remained the authority for request lineage, moderation
state, recovery checkpoints, and all state transitions. R2 was only the exact
replay projection.

## Qualification sequence

### 1. Terminal-denial population

The gateway remained closed and received two distinct contribution envelopes.
Both were terminal denials and neither materialized:

```text
request=req:p3-26-terminal-denial-1
contribution=contrib:p3-26-terminal-denial-1
http=200
status=denied
materialized=false

request=req:p3-26-terminal-denial-2
contribution=contrib:p3-26-terminal-denial-2
http=200
status=denied
materialized=false
```

The controlled population before export was two detailed request records and
three audit events after the export event was recorded. No healthy or pending
lineage was eligible for deletion.

### 2. Export and archive compaction

The owner exported the ledger before compaction:

```text
exportId=export:p3-26-replay-archive-20260810
exportHTTP=200
sourceGeneration=2
sourceStateDigest=sha256:304744b36fc098d994a2f35400a1340111b01e0f635d8e0d566e454f48a504cd
exportDigest=sha256:4f5d0c9c5493cc6fab01f27a3b182b8f610b8b868d03781c385621ddb6769443
```

The measured qualification policy deliberately set the local exact replay
tripwire to one tombstone, then supplied two terminal denials:

```text
requestTombstoneLimit.value=1
requestTombstoneLimit.unit=exact-replay-tombstones
method=controlled-qualification-two-terminal-denials-before-archive
```

Compaction returned HTTP 200 and archived both exact tombstones before saving
the new coordinator state:

```text
before.requestRecords=2
before.requestTombstones=0
before.auditEvents=3
after.requestRecords=0
after.requestTombstones=0
after.auditEvents=2
archived=2
recoveryCheckpoint=checkpoint:public-gateway:ledger-archived:4
canonicalProjectMutation=false
```

The archive receipt named the provider as a projection rather than authority:

```text
replayArchive=anyam.public-gateway-replay-archive/v1
export=sha256:4f5d0c9c5493cc6fab01f27a3b182b8f610b8b868d03781c385621ddb6769443
archived=2
exact=true
providerAuthority=false
```

### 3. Direct provider object measurement

A direct Wrangler R2 read of one archived object returned:

```text
request=req:p3-26-terminal-denial-1
bytes=967
objectDigest=sha256:297cc0b20e7c74dbc9940bf19781f3815dd59253f2fb7b47475c1ceccd936e4f
```

This is the serialized JSON object representation for this fixture. It is not
an R2 billing, quota, latency, capacity, or universal archive-budget claim.
The observed archive population was two objects. We do not propose a provider
tripwire from this single object-size receipt; a representative workload
distribution is still required by map issue #138.

### 4. Redeploy and exact replay lookup

The Worker was redeployed after compaction. The Durable Object recovered the
archived-count/checkpoint state. Reusing the same request identity and exact
payload returned:

```text
http=200
status=denied
idempotent=true
compacted=true
materialized=false
```

The same request identity with a changed envelope returned:

```text
http=200
status=denied
idempotent=false
replay=true
compacted=true
materialized=false
```

The final state after both replay checks still showed:

```text
requestRecords=[]
requestTombstones=[]
archivedTombstoneCount=2
accepted=0
denied=4
```

The changed-payload path never materialized a new record.

### 5. Tamper / mismatched-object rejection

The disposable R2 object was overwritten through Wrangler with a changed
`tombstone.payloadDigest` while retaining the original outer object digest.
The original object was then restored and read back successfully.

With the tampered object present, the same request lookup returned:

```text
http=503
code=provider-unavailable
receipt=replayArchive=lookup-failed; materialized=false
```

The Worker deliberately wraps provider-integrity failure as a fail-closed
provider-unavailable boundary. No new request identity was accepted. The
restored object returned to its original digest and `bytes=967` receipt before
the outage check.

### 6. Provider outage / absent bucket

The exact disposable archive objects were removed and the named R2 bucket was
deleted. While the Worker was still deployed with the R2 binding, a new request
identity was submitted:

```text
request=req:p3-26-archive-outage-1
http=503
code=provider-unavailable
materialized=false
recoveryAction=restore the customer-owned replay archive or retry after its provider recovers
```

This was a real binding-level lookup failure against the deleted customer-owned
bucket, not a local memory simulation. The request did not enter the
authoritative ledger.

## Cleanup receipt

Cleanup was exact and owner-authorized:

1. The two live-project objects were removed through Wrangler.
2. A temporary owner-protected cleanup Worker enumerated the bucket through the
   Workers R2 API. It found two stale objects from the earlier disposable
   project namespace and deleted exactly those two keys:

   ```text
   anyam/public-gateway/replay-index/v1/2f21cf336eea2a37cbebe73d1633d5547af31afe5d176b515e7c8565153415be.json
   anyam/public-gateway/replay-index/v1/c0bde0f6fe3ba929eba2d8779d377fcd1d8aa15d3a35585d5db01223df6daf6e.json
   ```

3. `r2 bucket info` then reported `object_count=0` and `bucket_size=0 B`.
4. The exact R2 bucket deletion succeeded.
5. The primary Worker and temporary cleanup Worker were deleted with Wrangler.
6. A post-cleanup request to the primary Worker URL returned HTTP 404.
7. A post-cleanup bucket-info request returned Cloudflare error `10006`:
   `The specified bucket does not exist.`

The intermediate `r2 bucket info` response reported zero objects before the
Workers API enumeration found the two stale objects. This is a provider
observation, not an Anyam invariant; exact cleanup must use authoritative
object enumeration rather than relying on that summary alone.

No unrelated account resource was changed. The local user-provided
`output.log` remains untracked and untouched.

## Qualification matrix

| Behavior | Result | Receipt |
|---|---|---|
| Exact tombstone archival beyond local tripwire | passed | two terminal denials archived before state save |
| R2 write/read-back and content digest | passed | one direct object read: 967 bytes, digest recorded above |
| Idempotent exact retry | passed | same request/payload returned `idempotent=true` |
| Changed-payload replay rejection | passed | same request/different payload returned `replay=true`, `idempotent=false` |
| Worker redeploy/restart lookup | passed | archived count/checkpoint recovered after redeploy |
| Tamper/mismatched-object rejection | passed | HTTP 503, `materialized=false`, object restored |
| Provider archive unavailability | passed | deleted bucket produced HTTP 503, no ledger acceptance |
| Exact cleanup | passed | bucket and both Workers absent; post-delete receipts recorded |

## Remaining map decisions

This closes the bounded implementation ticket, not the whole high-volume
archival design. Map issue #138 remains open for:

- representative workload and object-size distribution before sizing a real
  archive tripwire;
- retention/deletion policy after the replay-defense obligation expires; and
- the decision to keep the first production adapter R2-specific or qualify a
  portable external object-store adapter alongside it.

Any future provider-specific cost, latency, quota, retention, availability, or
SLO statement needs a new receipt. The current evidence supports only the
qualified disposable Cloudflare path and its fail-closed contract.
