# P3-29 first qualified replay archive provider boundary

Date: 2026-08-11
Issue: [#142 — Decide first qualified replay archive provider boundary](https://github.com/Whyme-Labs/anyam/issues/142)
Map: [#138 — Plan Anyam customer-owned replay archival beyond the local tripwire](https://github.com/Whyme-Labs/anyam/issues/138)
Protocol: `anyam.public-gateway-replay-archive/v1`
Status: decision recommendation; R2 is the only qualified provider

## Executive decision

Anyam should **qualify only the customer-owned Cloudflare R2 adapter at this
stage**. It should define and implement a provider-neutral exact replay
archive boundary now, but it should not claim that every S3-compatible service
implements that boundary or qualify a second provider until there is a
customer or portability requirement that justifies the work.

The first provider boundary is deliberately small:

```text
Anyam coordinator
    ↓
ExactReplayArchive provider
    ├── conditional create/read for runtime replay checks
    └── owner-only list/delete for retention and cleanup
```

The provider stores an immutable, digest-addressed object. It is never the
authority for Project lineage, moderation, Landing, Release, or Promotion.
The coordinator remains authoritative and must fail closed when the provider
cannot prove the answer to an exact replay lookup.

This is a portability seam, not a second qualification receipt. R2 is the
only provider for which Anyam currently has a customer-owned live receipt.

## Evidence already available

The existing evidence is sufficient for a bounded R2 decision, but not for a
universal object-store claim:

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| [ADR 0047](../adr/0047-p3-public-gateway-exact-replay-archive.md) | The replay projection, object shape, export-before-compaction order, digest verification, and fail-closed behavior | A portable implementation or provider-wide support |
| [P3-26 live R2 qualification](2026-08-10-p3-26-replay-archive-live-qualification.md) | Customer-owned R2 write/read-back, redeploy lookup, idempotent exact retry, tamper rejection, outage behavior, and exact cleanup on disposable resources | Concurrent same-key writer safety, retention policy, cost, latency, quota, SLO, or another provider |
| [P3-28 workload measurement](2026-08-10-p3-28-replay-archive-workload-measurement.md) | A 24-object contract-shaped sample with 1,003–1,620 measured serialized bytes and per-object digests/read-back/idempotency receipts | Production traffic distribution, volume tripwire, retention duration, or provider limit |
| [ADR 0015](../adr/0015-cloudflare-first-architecture-and-provider-boundaries.md) | Provider adapters, authoritative Anyam state, and portable export are separate boundaries | That a provider adapter is interchangeable without a matching qualification |

The live R2 receipt is sequential. The current implementation performs a
`get` followed by an unconditional `put`; it therefore has not yet qualified
two concurrent writers racing for the same key. That distinction is a
landmine: R2 documents that simultaneous writes to one key use “last writer to
complete” semantics, so a read-then-write sequence is not an immutable create
under a race. [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)

Before expanding the R2 claim, the adapter should be changed to use a
provider-atomic conditional create and the race should be added to the
qualification matrix. The research decision below does not silently promote
the existing sequential receipt to a concurrent guarantee.

## Smallest honest portable interface

The portable contract should describe semantics, not R2 bindings, S3 headers,
ETags, bucket names, or provider tokens. The kernel needs two runtime
operations and a separate maintenance capability.

### Runtime contract

```ts
type ExactReplayArchive = {
  putIfAbsent(input: {
    key: string;
    body: Uint8Array;
    digest: string;       // Anyam content digest of body
    identity: {
      projectId: string;
      requestId: string;
    };
    operationId: string;
    idempotencyKey: string;
  }): Promise<{
    status: "created" | "already-present" | "conflict";
    digest: string;
    bytes: number;
    providerReceipt: string;
  }>;

  get(input: {
    key: string;
    identity: {
      projectId: string;
      requestId: string;
    };
    expectedDigest?: string;
    operationId: string;
  }): Promise<{
    status: "found" | "not-found";
    body?: Uint8Array;
    digest?: string;
    bytes?: number;
    providerReceipt: string;
  }>;
};
```

The exact TypeScript shape can be refined with the existing Anyam receipt
types. The semantic requirements are the important part:

1. `putIfAbsent` must be an atomic conditional create. It must never replace
   an existing object. A concurrent loser may return `already-present`, after
   which the adapter reads and verifies the existing body.
2. `already-present` is idempotent only when the existing body verifies to the
   same Anyam digest and exact identity. A different digest, request identity,
   contribution ID, payload digest, original status, or invalid envelope is a
   `conflict`/integrity failure, never a successful overwrite.
3. `get` must distinguish a healthy `not-found` from authorization failure,
   timeout, missing bucket, 5xx, or an unreadable response. The latter are
   provider failures and must not be converted into “new request.”
4. The Anyam digest is calculated over the canonical serialized envelope. A
   provider ETag, checksum, version ID, generation, or object metadata is a
   provider receipt and may assist verification; it is not the Anyam identity
   or authority.
5. The adapter must validate protocol, shape, request identity, tombstone
   identity, byte count, and content digest before returning `found` or
   `already-present`.

The current `PublicGatewayReplayArchiveBucket` (`put`/`get`) is an internal R2
binding shim, not yet the portable semantic interface. It is too weak to
express atomic create or a typed conditional conflict. Keep provider-specific
bindings behind an adapter and expose only the semantic result to the
coordinator.

### Maintenance contract is separate

Retention and disposable qualification cleanup must not be available through
the normal replay lookup object. They require an owner-authorized maintenance
capability:

```ts
type ExactReplayArchiveMaintenance = {
  list(input: {
    prefix: string;
    cursor?: string;
    operationId: string;
  }): Promise<{
    keys: readonly { key: string; digest?: string; bytes?: number }[];
    truncated: boolean;
    nextCursor?: string;
    providerReceipt: string;
  }>;

  deleteIfMatch(input: {
    key: string;
    expectedDigest: string;
    operationId: string;
  }): Promise<{
    status: "deleted" | "already-absent" | "conflict";
    providerReceipt: string;
  }>;
};
```

`list` and `deleteIfMatch` are needed for the retention decision and exact
cleanup receipt, but not for accepting a request. Deletion must be conditional
on the expected digest (or an equivalent provider generation) so a stale
cleanup cannot delete a newly restored object. If the provider cannot provide
that precondition, deletion is a blocked maintenance operation, not a best-
effort success.

The list contract must expose pagination explicitly. A cleanup receipt that
only reports the first page is not proof that the prefix is empty. Cloudflare
R2 documents `truncated` and `cursor` for continued listing; the adapter must
consume all pages and record the final cursor/remaining-key result.
[R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

## Required Anyam receipts

Provider acknowledgements are inputs to the Anyam receipt; they do not replace
the coordinator transition. Every operation should retain a credential-free,
structured receipt with these fields (or the equivalent versioned schema):

### Write / compaction receipt

```text
archive protocol
provider identity and adapter version
project/request identity
opaque object key
operation ID and idempotency key
source export digest / coordinator checkpoint
body digest and measured bytes
conditional-create result
provider operation/request ID when available
read-back result and read-back digest
idempotent=true|false
coordinator state saved=true|false
recovery action
```

The coordinator may clear local tombstones only after every object has a
verified body digest and the export/checkpoint is persisted. A partial or
unknown write leaves local state intact and names the same export operation
for retry.

### Lookup receipt

```text
project/request identity
opaque object key
found=true|false
healthy-not-found=true|false
body digest and measured bytes when found
identity/envelope verification result
provider operation/request ID when available
materialized=true|false
recovery action on provider failure
```

`not-found` is a valid result only when the provider was healthy and the exact
key was checked. An unavailable, unauthorized, expired, or malformed provider
response is not a not-found result. It must fail closed before accepting a
request identity that could have been archived.

### Integrity/conflict receipt

```text
existing digest
requested digest
identity fields compared
conditional precondition result
provider response/status
quarantined=true|false
materialized=false
recovery action
```

No integrity conflict may be repaired by overwriting the object in place.
Quarantine and owner-approved restore are separate operations.

### Cleanup / retention receipt

```text
maintenance policy ID and owner authorization
prefix / exact key set
enumeration pages and final cursor
expected digests
requested/deleted/already-absent/conflict counts
remaining keys after final listing
provider operation IDs
archive/export lineage preserved=true|false
recovery action
```

This receipt does not select a retention duration. Ticket #141 owns that
policy decision. It only defines the evidence needed to prove exact cleanup
when deletion is authorized.

## Provider comparison

### Cloudflare R2 (qualified now, bounded)

Cloudflare documents that the Workers API supports conditional operations on
`put` and that a failed condition returns `null`; the API also exposes object
checksums and custom metadata. [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

R2 documents strong read-after-write, delete, metadata, and list consistency
for direct Worker bindings and the S3 API. It also explicitly documents that
two writers to one key use last-writer-to-complete semantics. [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
The adapter therefore needs conditional create even though read-back is
strongly consistent.

R2's S3 compatibility matrix is explicitly subject to feature differences and
ongoing implementation work. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
Anyam should use the direct customer-owned Worker binding for the first
qualification and treat the S3 endpoint as a separate adapter surface, not
assume feature parity from the label “S3-compatible.”

The P3-26 receipt establishes the bounded customer-owned path and exact
cleanup. It does not yet establish concurrent conditional-create behavior;
that is the first implementation/qualification follow-up.

### AWS S3 (candidate for later, not qualified)

AWS documents `If-None-Match: *` conditional writes for `PutObject`, and says
that concurrent conditional writes to one key allow the first operation to
finish while later writes fail with `412 Precondition Failed` (with documented
conflict cases around concurrent deletes). [Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)

Those semantics are a good reference for a second adapter, but the AWS
documentation is not a receipt that Anyam has tested AWS credentials,
authorization, body-digest verification, outage behavior, cleanup, or
Project-specific disclosure. No AWS support claim should be made until the
same bounded qualification matrix passes.

### Other S3-compatible services

“S3-compatible” is not a qualification. Providers can differ in conditional
operations, ETag meaning, checksum behavior, list pagination, versioning,
delete semantics, error classification, lifecycle/object-lock controls, and
credential scope. Anyam must not infer those behaviors from a provider's
protocol label.

If a customer later needs self-hosted object storage, qualify a named provider
and version (for example, a specific MinIO release) through the same adapter
contract. Do not add a generic `s3` provider enum that silently accepts unknown
implementations.

## Qualification plan

### R2 follow-up before expanding the claim

1. Implement conditional `putIfAbsent` using the R2 binding's documented
   conditional operation.
2. Run two concurrent writes for the same key with identical bodies; prove one
   create and one verified idempotent result.
3. Run two concurrent writes for the same key with different bodies; prove one
   create and one integrity conflict, with no overwrite.
4. Repeat after Worker redeploy and after an injected provider outage.
5. Exercise paginated list plus digest-checked deletion in the maintenance
   path.
6. Record provider receipts without turning any observed latency, size, cost,
   quota, or object count into an Anyam tripwire.

### Second provider gate

Qualify a second provider only when at least one of these is true:

- a customer needs a non-Cloudflare account or a self-hosted storage target;
- a portability/recovery gate requires restoring the same archive into an
  independently operated provider;
- R2 qualification exposes a semantic limitation that a second provider can
  test or mitigate;
- an implementation team can run the complete bounded matrix without
  weakening the first provider's contract.

The second-provider matrix must cover conditional create, exact body digest,
read-back, healthy not-found versus outage, authorization/revocation,
concurrent same-key writes, redeploy/restart, tamper or corruption handling,
pagination, digest-checked cleanup, export/restore, and credential-free
receipts. Until that receipt exists, the portable interface is a design
boundary only.

## Decision and residuals

**Decision:** qualify R2 only now; strengthen the R2 adapter to conditional
create; expose a provider-neutral semantic interface; defer AWS S3 or another
named provider until a concrete portability/customer need and a full receipt.

**Residuals:**

- Current R2 live evidence is sequential; concurrent same-key safety remains
  an implementation and qualification follow-up.
- Ticket #141 must decide when deletion is authorized and what lineage/export/
  legal-hold evidence remains after replay defense expires.
- No provider cost, latency, quota, capacity, availability, retention,
  compliance, or SLO claim is selected here.
- R2 S3 compatibility and any future external provider require independent
  adapter qualification.
- The coordinator remains authoritative; archive objects never authorize
  Landing, Change, Release, or Promotion.

The smallest safe next step is therefore not “add another provider.” It is to
make the already-qualified R2 path honest under concurrency, record that
receipt, then let the retention decision and customer demand determine whether
the second provider work is worth its operational surface.
