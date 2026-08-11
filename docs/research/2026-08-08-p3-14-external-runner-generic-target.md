# P3-14 external Runner and generic Target qualification receipt

Date: 2026-08-08

Issue: [#124 Qualify a live external Runner and generic Target](https://github.com/Whyme-Labs/anyam/issues/124)

Protocol: `anyam.external-runner-generic-target-qualification/v1`

Status: **protocol fixture passed; live external Runner lane not qualified; historical live GitHub Release Target receipt retained**

## Question

Can an independently operated Runner enroll, pull one scoped immutable Job,
execute it without canonical-source or secret-value authority, return signed
logs/Artifacts/Evidence, recover from lease expiry or provider outage, and
publish a typed non-web Artifact through a real generic Target?

The decision boundary is deliberately split:

```text
Anyam protocol and trust boundary       qualified by local fixture
Cloudflare Queues pull transport        not qualified in this receipt
Independently operated host             not qualified in this receipt
Generic Target provider                qualified by historical GitHub receipt
Anyam production orchestration         not qualified
```

The local fixture is not a live Runner. A passing test here must not be
described as macOS execution, network enforcement, secret brokering, host
isolation, Queue delivery, or provider reliability.

## Receipts captured in this run

### Local protocol fixture

Command, run window, and output are recorded here so the test result is
reproducible:

```text
command=npx tsx --test test/runner.test.ts test/library-release.test.ts
start=2026-08-08T09:44:53Z
end=2026-08-08T09:44:58Z
exit=0
tests=7
pass=7
fail=0
cancelled=0
skipped=0
todo=0
test_duration_ms=3292.553041
process_real_s=4.80
process_user_s=1.78
process_sys_s=0.79
log=/tmp/anyam-20260808T0932Z-runner-target.log
```

The seven tests cover:

- an enrolled macOS/arm64 VM profile claiming an immutable non-web Action;
- typed cli.archive output and generic Target lineage;
- rejection of an ineligible Runner profile;
- input-manifest mismatch rejection;
- output-root and path-traversal rejection;
- cancellation with unknown cleanup becoming quarantined/indeterminate;
- provider unavailability and retry through a fresh Attempt; and
- lease expiry, credential invalidation, and retry.

The fixture also asserts that the opaque job credential is not serialized into
the Job, that output references remain bound to the Run and Attempt, and that
the generic Target advances only after the detached verified Release is
published through ReleasePublicationCoordinator.

This is a protocol receipt, not a production capacity receipt. The measured
test duration is useful for local regression comparison only; it is not a
Runner SLO or a Cloudflare Queue latency claim.

### Repository baseline

The full local gate was already run in this working session:

```text
command=/usr/bin/time -p npm run check
exit=0
tests=123
pass=123
fail=0
cancelled=0
skipped=0
todo=0
test_duration_ms=20753.747083
process_real_s=36.39
process_user_s=26.16
process_sys_s=6.07
log=/tmp/anyam-120-check.log
```

This baseline establishes that the receipt was captured against a green
repository, not an isolated test that bypasses the normal typecheck and test
gate.

## Historical live generic Target receipt

The disposable P3 cohort qualified a non-web GitHub Release asset Target on
2026-08-03. The complete provider receipt is
[2026-08-03-p3-12-live-provider-path-qualification.md](2026-08-03-p3-12-live-provider-path-qualification.md).

The observed artifact was a synthetic 530-byte .tgz uploaded to a private
GitHub Release and downloaded through the authenticated GitHub CLI:

```text
sourceSha256=e8cab22369486282020f6b0829953d23ad1ff87dad35623273cba1f33291e77a
downloadSha256=e8cab22369486282020f6b0829953d23ad1ff87dad35623273cba1f33291e77a
shaMatch=true
anonymousPrivateAssetFetch=404
duplicateUploadExit=1
duplicateUploadMessage=asset under the same name already exists
```

The disposable repositories and Release were deleted after the receipt was
captured. Therefore this is a **historical live provider receipt**, not a
currently reachable Target. It qualifies provider upload/read behavior and the
duplicate-name tripwire. It does not qualify the Anyam coordinator's durable
Release pointer, rollback, or recovery state machine.

GitHub's current REST documentation independently records the provider
contract: an upload uses the Release-specific upload_url, returns 201 on
success, returns 422 when an uploaded asset has the same filename, and exposes
an asset digest field for read-back verification. See
[Upload a release asset](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28)
and [Get a release asset](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#download-a-release-asset).

## Provider facts that constrain the production adapter

These are current provider facts from primary documentation, not Anyam limits:

### Cloudflare Queues pull consumers

Cloudflare documents an HTTP pull consumer for infrastructure outside Workers.
The consumer explicitly pulls and acknowledges messages, and must use a
Bearer API token with both Queues read and write permission because
acknowledgement mutates queue state. The pull guide shows separate pull and ack
endpoints and allows multiple concurrent pull consumers.

Sources: [Pull consumers](https://developers.cloudflare.com/queues/configuration/pull-consumers/),
[How Queues Works](https://developers.cloudflare.com/queues/reference/how-queues-works/).

Queues delivery is **at least once**. Cloudflare explicitly recommends a unique
message ID used as a database primary key or idempotency key when duplicate
processing is unsafe. The Anyam adapter must therefore persist a Queue message
ID alongside jobId, attemptId, and the Anyam enqueue idempotency key. A Queue
ack is not a signed Runner Result and must never advance a Run by itself.

Source: [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).

Cloudflare's pull documentation also says that a visibility timeout can expire
while a message is being processed and that a late acknowledgement can still be
accepted. This makes the Anyam lease/Attempt state authoritative: a late Queue
ack may remove redelivery pressure, but only a valid signed Result for the
current Attempt can produce succeeded or failed.

### R2 output storage

Cloudflare R2 documents strong global read-after-write, metadata, deletion, and
object-listing consistency for direct bucket/API access. It also documents a
last-writer-wins result when two clients write the same key. Cache-backed custom
domain reads have different freshness behavior.

Source: [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/).

The production Runner adapter must use attempt-scoped, content-addressed output
keys and direct Worker/S3 API reads for verification. It must not treat an R2
HTTP cache response as proof of the bytes that a Runner uploaded. Anyam still
recomputes or independently checks the declared digest before accepting the
Artifact/Evidence reference.

### GitHub Release assets as one generic non-web Target

GitHub Release assets are a useful adapter fixture because the output is a
binary/archive rather than a deployed web resource. The provider exposes a
release-specific upload URL, asset object identity, byte size, and digest. A
same-name upload is explicitly rejected rather than replaced. Anyam should use
the provider object ID and provider digest as untrusted receipt fields, then
validate them against the detached Release/Artifact digest before advancing its
own Target pointer.

This is a provider adapter, not a reason to make Release GitHub-specific. The
same Anyam path must support a package, model, dataset, firmware, or CLI Target.

## What remains unqualified

The following claims are intentionally **not** made by this receipt:

| Claim | Current evidence | Decision |
| --- | --- | --- |
| An independently operated process can pull a live Anyam Job | In-memory coordinator only | **not qualified** |
| Cloudflare Queue pull and ack work with the production Anyam schema | Provider documentation only; no disposable Queue run in this receipt | **not qualified** |
| A customer host proves key possession over a live transport | Generated test Ed25519 key in local process | **not qualified** |
| macOS/arm64 execution is isolated and cleaned after a hostile Job | Platform profile fixture only | **not qualified** |
| Network allow-list enforcement works | Declared registry.example destination only | **not qualified** |
| Secret Use injects capability without exposing values | Brokered alias in fixture only | **not qualified** |
| R2 output upload, read-back, and digest verification work in Anyam | Provider documentation only | **not qualified** |
| Queue duplicate/redelivery recovery is implemented | Local idempotency/Attempt tests only | **not qualified** |
| GitHub Release publication is currently reachable | Historical disposable cohort; resources deleted | **historical receipt only** |
| Anyam Target pointer is durable across Worker restart | In-memory ReleasePublicationCoordinator fixture | **not qualified** |
| Runner and Target provider budgets or SLOs are known | No live timing/bytes/cost sample | **not qualified** |

No new provider number is promoted into an Anyam limit. The provider examples
for batch size, visibility timeout, or Queue throughput are not Anyam budgets;
they must not become configuration defaults without a measurement receipt from
the actual adapter and representative workloads.

## Required live qualification journey

The next live run should be a disposable, operator-approved cohort. It should
be one end-to-end journey with explicit evidence at every boundary:

```text
1. Provision one temporary Queue, R2 bucket/prefix, and Target adapter.
2. Enroll one customer-operated Runner public key and capability profile.
3. Enqueue one immutable Job with a unique Queue message ID.
4. Runner pulls the offer and proves key possession with a challenge signature.
5. Anyam issues one attempt-scoped opaque credential; its digest is recorded.
6. Runner executes a small non-web Action in its own host/workspace.
7. Runner writes logs, a typed cli.archive Artifact, and Evidence to scoped
   locations; Anyam reads back and verifies their digests.
8. Runner signs a Result naming the exact Job, Attempt, inputs, outputs, and
   disclosure projection.
9. Anyam acknowledges the Queue message only after the Result is accepted.
10. Anyam seals a Release and publishes the same Artifact through the generic
    Target adapter without rebuilding it.
11. Repeat with a duplicate/redelivered Queue message, expired lease, provider
    outage, cancellation with unknown cleanup, and late signed Result.
12. Record the exact bytes, elapsed times, retry counts, provider statuses,
    output digests, and cleanup inventory; then delete the disposable cohort.
```

The live run must include a source-disclosure check: the Runner receives only
the authorized Project View/Source Space snapshots, and a deliberately
unauthorized snapshot or output disclosure is rejected. It must include a
revocation check: cancelling or quarantining the Runner makes the current
credential unusable, while a retry receives a fresh Attempt and credential.

The live run must also measure, rather than guess, host CPU/memory/disk/network
usage and output bytes. Those measurements become receipts for future tripwires;
until then, a budget is a landmine.

## Decision

```text
protocolFixture=passed (7/7; 2026-08-08)
sourceDisclosure=local input/output projection checks passed; live host not qualified
revocation=local credential/lease/quarantine checks passed; live transport not qualified
reliability=local retry/expiry/replay checks passed; Queue redelivery not qualified
genericTarget=historical live GitHub Release asset upload/read/duplicate tripwire passed
externalRunner=not qualified
cloudflareQueuePull=provider documentation only; not qualified
r2OutputPath=provider documentation only; not qualified
anyamProductionOrchestration=not qualified
budgetReceipt=absent; no Anyam limit added
universalSupport=false
```

This receipt closes the research question only at the protocol boundary. It
does not close the live-provider qualification. The next implementation step is
the disposable Queue + customer Runner + R2 output + GitHub Release cohort,
with no canonical repository write authority and no production credentials.
