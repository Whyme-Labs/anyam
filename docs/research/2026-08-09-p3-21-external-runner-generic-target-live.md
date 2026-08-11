# P3-21 live external Runner and generic Target qualification receipt

Date: 2026-08-09

Issue: [#131 Run a live external Runner and generic Target qualification cohort](https://github.com/Whyme-Labs/anyam/issues/131)

Protocol: `anyam.external-runner-qualification/v1`

Status: **core live path passed; disposable resources deleted; full acceptance matrix remains bounded by the unexercised negative/recovery probes listed below**

## Decision boundary

This receipt qualifies one real customer-operated macOS/arm64 process through
Cloudflare Queue HTTP pull, a signed Runner claim, a scoped opaque attempt
credential, customer-owned R2 output, signed Result acceptance, independent R2
read-back, Queue acknowledgement, and unchanged publication to a disposable
GitHub Release Target.

It does not claim that every cancellation, revocation, redelivery, disclosure
rejection, provider outage, or network measurement path has been exercised live.
Those residuals remain explicit rather than being inferred from the successful
path or from local protocol fixtures.

## Live resources

These resources were created only for this disposable cohort:

```text
Cloudflare account: 1e0170aaabc90ecf5f466128d1f0466a
Queue name: anyam-p3-14-live-20260809-events
Queue ID: 5602bb1770784e29993189eacc0bba78
HTTP pull consumer ID: 6aaea706bd3342ad898785ecea15ee92
R2 bucket: anyam-p3-14-live-20260809-outputs
Coordinator Worker: anyam-p3-14-live-20260809-coordinator
Coordinator version: f229cc64-716b-4be9-89a1-4d99679f7c5f
GitHub Target repository: Whyme-Labs/anyam-p3-14-live-20260809-target
GitHub Target tag: anyam-p3-14-live-20260809
GitHub Target asset ID: 507559821
GitHub Target bootstrap commit: 8eb19fc97a9626ed172248cefb11008f3ac06fc2
```

The Queue token was owner-created and kept out of the repository, logs, and
receipt. The Runner credential was opaque and only its digest was reported.

## Successful live run

```text
cohort=anyam-p3-14-live-20260809
jobId=job:live-f36906f3-7068-409f-8fc2-7751142eb1af
attemptId=attempt:90a6f6d8-f4fe-4842-968e-f0a1d7e4363a
runnerId=runner:mac-d7977dca-ab7f-465d-b7fc-a4e6a063a172
queueMessageId=5cb1c9d30159b8a33587e48b4b5f66df
queueMessageIdDigest=sha256:dca13b64462bab989fe7da49a31f2e2676293056eff8d3ae55cc7c6c6b08df07
queueBodyEncoding=json-text
queueAttempts=0
queueBatchSize=10
queueAckCount=1
queueRetryCount=0
queueLeaseId=redacted
queueLeaseIdDigest=sha256:4aad5222e8cb2b5083e9e233f3eac76b501c57b26d20a2d2528d73fe76b95f33
```

The coordinator accepted the signed Result and independently read the output
back from R2:

```text
inputManifestDigest=sha256:adcfef8cef158e765451c45762dc300b5f39af04195c052c063e9feaa429f87c
sourceSnapshotDigest=sha256:c5fe7a07159a94e5756795b684dc3fe6540252f1b0e741616be282a06ec4c33c
artifactPath=artifact/anyam-live-runner.txt
artifactBytes=139
artifactDigest=sha256:3188799a3c79be04cab2d1f18519a86a611f0cff5abd0bb7ccc7d38969b9c82b
r2ReadBackDigest=sha256:3188799a3c79be04cab2d1f18519a86a611f0cff5abd0bb7ccc7d38969b9c82b
resultDigest=sha256:79d6f5e7176f089af16b0a758ddc51a0bc8f094f4c7eea54418afcbdd3383703
canonicalWrite=false
credentialFree=true
```

The GitHub Target published the exact bytes without rebuilding them:

```text
release=https://github.com/Whyme-Labs/anyam-p3-14-live-20260809-target/releases/tag/anyam-p3-14-live-20260809
providerAssetId=507559821
providerAssetName=anyam-live-runner.txt
providerAssetSize=139
providerAssetDigest=sha256:3188799a3c79be04cab2d1f18519a86a611f0cff5abd0bb7ccc7d38969b9c82b
downloadedDigest=sha256:3188799a3c79be04cab2d1f18519a86a611f0cff5abd0bb7ccc7d38969b9c82b
duplicateUpload=rejected
```

The successful run window was 15,983 ms:

```text
startedAt=2026-08-09T13:53:05.944Z
finishedAt=2026-08-09T13:53:21.927Z
visibilityTimeoutMs=30000
leaseExpiresAt=2026-08-09T13:58:04Z
```

The external host reported:

```text
platform=darwin
arch=arm64
release=25.2.0
totalMemoryBytes=17179869184
freeMemoryBeforeBytes=99352576
freeMemoryAfterBytes=1345257472
rssBeforeBytes=64159744
rssAfterBytes=82608128
processUserMicros=310631
processSystemMicros=82242
diskAvailableBeforeBytes=452142489600
diskAvailableAfterBytes=452142489600
networkBytes=not-observed
```

These values are receipts for this run, not Anyam limits or SLOs. No Anyam
budget was added from them.

## Acceptance matrix

| Acceptance item | Evidence | Decision |
| --- | --- | --- |
| Queue ID, pull lease, message ID, and acknowledgement | Live Queue pull; lease digest; `ackCount=1`; `retryCount=0` | **passed for one successful delivery** |
| Enqueue idempotency and duplicate/redelivery handling | Unique Job/Attempt IDs; no explicit duplicate/redelivery probe in this run | **not qualified** |
| Runner key proof and scoped credential | Live Ed25519 claim; opaque attempt credential; credential material not stored | **passed for claim path** |
| Lease/heartbeat/expiry, cancellation, revocation, and retry | Future lease was accepted; no live cancellation/revocation/retry probe | **not qualified** |
| Exact input digests | Input manifest and source snapshot digests recorded | **passed for declared input** |
| Unauthorized disclosure rejection | No deliberate unauthorized Project View/output disclosure in this run | **not qualified** |
| Host measurements | macOS/arm64 CPU, memory, disk, RSS, and output bytes; network explicitly not observed | **passed with network measurement gap** |
| R2 upload, read-back, and independent digest verification | Declared digest equals direct read-back digest | **passed** |
| Unchanged generic Target publication | GitHub asset digest and downloaded digest match; duplicate upload rejected | **passed** |
| Provider failure/retry behavior | Duplicate asset tripwire observed; no provider outage/retry probe | **partially qualified** |
| Cleanup inventory and deletion | Exact object inventory reached zero; Worker, Queue, R2 bucket, and GitHub Target were deleted and verified absent | **passed** |

## Failure history and fixes

Three bounded failures occurred before the successful receipt:

1. Cloudflare JSON Queue content arrived as base64 text, while the Runner
   decoder expected an object. The decoder now handles object, JSON text, and
   base64 JSON at the provider boundary.
2. The `:` in the Job ID was URL-encoded in the Worker path and therefore
   changed the signed Result envelope. The Worker now decodes the path segment
   before coordinator state and signature verification.
3. GitHub refuses a Release in an empty repository. The disposable Target was
   initialized with the recorded bootstrap commit before the successful run.

Each failure remained visible and actionable; none was converted into a
silent retry or a false qualification.

## Remaining provider-specific risks

- Cloudflare Queue delivery is at-least-once; this receipt observes one
  acknowledgement but does not qualify Anyam's duplicate/redelivery state
  machine.
- Network bytes were not observed on the external host, so no network budget or
  network-isolation claim is made.
- The live Worker exposes only the bounded qualification coordinator; it is not
  the production Runner orchestration or canonical Landing service.
- GitHub Release is one generic Target adapter. Package, model, dataset,
  firmware, and other Targets still require their own provider receipts.

## Cleanup receipt

The exact disposable resources were deleted after this receipt was captured and
the release metadata was independently verified. The two scoped R2 objects
left by failed attempts and the successful run object were all enumerated and
deleted:

```text
outputs/job:live-10c6ba26-3c8c-4834-95eb-7f7f4022b593/artifact/anyam-live-runner.txt
outputs/job:live-d621f805-c9ff-4f07-8ed6-c476e042179e/artifact/anyam-live-runner.txt
outputs/job:live-f36906f3-7068-409f-8fc2-7751142eb1af/artifact/anyam-live-runner.txt

post-delete R2 objectCount=0
Worker health HTTP=404 (error code 1042)
Queue absent from account list
R2 bucket absent after deletion
GitHub Target repository absent (GraphQL not found)
```

No canonical repository, production Target, user-owned project, or credential
was modified by the cohort.
